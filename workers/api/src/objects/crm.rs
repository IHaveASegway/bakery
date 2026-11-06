//! `Crm`, one per sandbox, named `crm:<sandbox>` (docs/domain.md, "Campaign"; docs/architecture.md,
//! "A campaign send" and its rebuild paragraph). It holds three things:
//!
//! - **The projection**, the domain's `CrmProjection`, kept whole as one serialized row (its
//!   `to_json()`): the customer list, the timelines, the activity log, the lead pipeline and the
//!   campaign stats.
//! - **Its log**, the `log` table: every envelope it consumed that changed the projection, in the
//!   order it applied them, with the order note and the catering brief removed
//!   (`crm::log_entry`). Only `Applied` envelopes are logged, so folding the log again gives the
//!   projection byte for byte: the rebuild's source.
//! - **The campaigns**, the domain's `Campaigns` aggregate, the fold of Crm's own `events`
//!   (`crm:<sandbox>`), with one `send` timer per scheduled campaign.
//!
//! Paths (the Worker builds them):
//!
//! - `POST /_seed {birth, directory, profiles, envelopes}` → 201; 200 when already seeded. The
//!   seed's roster and the history envelopes, folded and logged in one transaction.
//! - `POST /_event` with an envelope, from the consumer → 200 `{outcome}` (`applied`,
//!   `duplicate`, `stale`, `ignored`); 503 `{error: "unknown-ref"}` for a later event whose first
//!   has not arrived, so the delivery retries; 422 `{error: "envelope"}` for one that cannot be
//!   read. While a rebuild runs the envelope is decided against the projection as it stood
//!   (`shadow`) and appended to the log without touching the partial projection, which the replay
//!   reaches in its turn.
//! - `POST /_ingest {envelopes}` → 200 `{applied}`: several deliveries in one transaction, from
//!   the Sandbox at seeding (the seeded catering events' own events, which no outbox relays).
//! - `POST /_command {key, body_hash, cmd}` → 200 `CampaignResponse`; 200 with
//!   `Idempotent-Replayed: true` for a key seen with the same body; 422 `{error: "key-reused"}`
//!   for one seen with another; 404 `{error: "unknown-campaign"}`; 422 `{error: "campaign", rule:
//!   "schedule-too-soon", earliest}`; 409 `{error: "campaign", rule}` for any other refusal.
//!   `cmd` is [`Cmd`]. A refused command writes nothing.
//! - `GET /_customers`, `GET /_customer/<id>`, `GET /_timeline/<id>`, `GET /_segments`,
//!   `GET /_segment/<slug>`, `GET /_campaigns`, `GET /_campaign/<id>`, `GET /_leads`,
//!   `GET /_activity?limit=` → the contracts' responses, from the projection as it stands
//!   (partial while a rebuild runs, said by `Projection-State: rebuilding`); 404 for an unknown
//!   customer, segment or campaign.
//! - `POST /_rebuild {key}` → 202 `RebuildResponse`; 409 `{error: "rebuild"}` while one runs;
//!   the same key again is a replay. `GET /_rebuild` → 200 `RebuildResponse`.
//! - `GET /_projection` → the projection's JSON text, byte for byte as stored: the debug read the
//!   rebuild is checked against (internal, like `/_state` on the other objects).
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs).
//!
//! Timers: `send:<campaign>` (business time: the campaign's `send_at`) runs `SendCampaign` with
//! `Audience::of` the projection at that moment under the key `timer:send:<campaign>`; a send
//! that is not yet due (a stale wall time) is set again from its business time, and a second
//! firing finds the campaign sent and sends nothing. Sends wait while a rebuild runs, and go on
//! the first alarm after it. `rebuild` replays `REBUILD_BATCH` log entries per run, one
//! transaction each, and ends with `ProjectionRebuildFinished {events, ms}`, the milliseconds
//! read from the wall clock through the clock adapter. `outbox` and `backstop` as every child.
//!
//! Log lines carry reason codes, ids and counts; never a note, a brief or a message body.

use std::cell::Cell;
use std::collections::BTreeMap;

use bakery_app::Clock;
use bakery_contracts::{
    ActivityEntry, ActivityResponse, CampaignListResponse, CampaignResponse, CustomerListResponse,
    CustomerResponse, LeadPipelineResponse, LeadStageView, RebuildResponse, SegmentListResponse,
    SegmentResponse, TimelineEntry, TimelineResponse,
};
use bakery_domain::crm::{
    Audience, BodyTemplate, Campaign, CampaignCommand, CampaignError, CampaignState, CampaignTable,
    Campaigns, CrmError, CrmEvent, CrmProjection, CustomerRow, Directory, Outcome, REBUILD_BATCH,
    Rebuild, RebuildState, SEGMENT_SAMPLE, Segment, SubjectTemplate, log_entry, segment_members,
};
use bakery_domain::outbox::{CommandCheck, Stamp, StreamHead, check_command, envelopes};
use bakery_domain::{
    Aggregate, BusinessTime, DecideContext, DomainEvent, Envelope, Ulid, WallTime, execute, replay,
};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::sql::{
    self, exec, first, gone, has_table, json, refuse, replayed, rows, transaction_sync,
};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::{SystemClock, wall_at};
use crate::random;

pub const BINDING: &str = "CRM";
pub const CLASS: &str = "Crm";
/// A campaign's send timer's purpose; its id is `send:<campaign>`.
const SEND: &str = "send";
/// The rebuild's timer, id and purpose.
const REBUILD: &str = "rebuild";
/// The pause between rebuild runs, so a progress bar polling every second sees the cursor climb.
const REBUILD_GAP_MS: i64 = 300;
/// The activity feed's default and largest page.
const ACTIVITY_DEFAULT: usize = 50;
const ACTIVITY_MAX: usize = 500;

pub fn name(sandbox: Ulid) -> String {
    format!("crm:{sandbox}")
}

const SCHEMA: &[&str] = &[
    child::META,
    // The one state row: the seed's roster, each persona's preferences and place (reference data
    // a rebuild keeps), the projection, the projection as it stood while a rebuild runs, and the
    // rebuild's progress.
    "CREATE TABLE IF NOT EXISTS crm (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       directory TEXT NOT NULL,
       profiles TEXT NOT NULL,
       projection TEXT NOT NULL,
       shadow TEXT,
       rebuild TEXT NOT NULL,
       started_ms INTEGER,
       ms INTEGER)",
    // Every envelope that changed the projection, in the order it did: the rebuild's source.
    "CREATE TABLE IF NOT EXISTS log (
       pos INTEGER PRIMARY KEY,
       id TEXT NOT NULL UNIQUE,
       envelope TEXT NOT NULL)",
];

/// What the projection does not hold of a persona and the customer screens show: its
/// preferences and its place label, from the seed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonaProfile {
    pub preferences: Vec<String>,
    pub place: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedCrm {
    pub birth: Birth,
    pub directory: Directory,
    pub profiles: BTreeMap<Ulid, PersonaProfile>,
    /// The history's `OrderClosed` envelopes, oldest id first.
    pub envelopes: Vec<Envelope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestIn {
    pub envelopes: Vec<Envelope>,
}

/// A campaign command as the router sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    Draft {
        campaign: Ulid,
        subject: SubjectTemplate,
        body: BodyTemplate,
        segment: Segment,
    },
    Edit {
        campaign: Ulid,
        subject: SubjectTemplate,
        body: BodyTemplate,
        segment: Segment,
    },
    Schedule {
        campaign: Ulid,
        send_at: BusinessTime,
    },
    Cancel {
        campaign: Ulid,
    },
}

impl Cmd {
    pub fn domain(self) -> CampaignCommand {
        match self {
            Cmd::Draft {
                campaign,
                subject,
                body,
                segment,
            } => CampaignCommand::DraftCampaign {
                campaign,
                subject,
                body,
                segment,
            },
            Cmd::Edit {
                campaign,
                subject,
                body,
                segment,
            } => CampaignCommand::EditCampaign {
                campaign,
                subject,
                body,
                segment,
            },
            Cmd::Schedule { campaign, send_at } => {
                CampaignCommand::ScheduleCampaign { campaign, send_at }
            }
            Cmd::Cancel { campaign } => CampaignCommand::CancelCampaign { campaign },
        }
    }

    fn campaign(self) -> Ulid {
        match self {
            Cmd::Draft { campaign, .. }
            | Cmd::Edit { campaign, .. }
            | Cmd::Schedule { campaign, .. }
            | Cmd::Cancel { campaign } => campaign,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandIn {
    pub key: String,
    #[serde(default)]
    pub body_hash: String,
    pub cmd: Cmd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebuildIn {
    pub key: String,
}

/// An object refusal's body, as the router reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub rule: Option<String>,
    /// `schedule-too-soon`'s earliest allowed `send_at`, a business time on a whole minute.
    #[serde(default)]
    pub earliest: Option<String>,
}

/// The refusal a campaign error is, with its status.
pub fn refusal_of(e: &CampaignError) -> (u16, Refusal) {
    match e {
        CampaignError::UnknownCampaign(_) => (
            404,
            Refusal {
                error: "unknown-campaign".into(),
                ..Refusal::default()
            },
        ),
        CampaignError::ScheduleTooSoon { earliest } => (
            422,
            Refusal {
                error: "campaign".into(),
                rule: Some(e.rule().into()),
                earliest: Some(whole_minute_after(*earliest).to_string()),
            },
        ),
        _ => (
            409,
            Refusal {
                error: "campaign".into(),
                rule: Some(e.rule().into()),
                earliest: None,
            },
        ),
    }
}

/// `at`, or the next whole minute after it: the earliest time a minute-grained picker can ask
/// for and still be allowed.
pub fn whole_minute_after(at: BusinessTime) -> BusinessTime {
    let ms = at.unix_ms();
    let rem = ms.rem_euclid(60_000);
    if rem == 0 {
        return at;
    }
    bakery_domain::calendar::local(ms - rem + 60_000).unwrap_or(at)
}

/// Domain values to wire values through their shared serde names.
fn via_json<T: Serialize, U: serde::de::DeserializeOwned>(value: T) -> Result<U> {
    Ok(serde_json::from_value(serde_json::to_value(value)?)?)
}

/// The campaign as the API shows it: the aggregate's record and the projection's stats.
pub fn campaign_response(c: &Campaign, projection: &CrmProjection) -> Result<CampaignResponse> {
    let stats = projection.campaign_stats(c.campaign);
    let n = |len: usize| u32::try_from(len).unwrap_or(u32::MAX);
    Ok(CampaignResponse {
        campaign: c.campaign.to_string(),
        state: via_json(c.state)?,
        subject: via_json(c.subject)?,
        body: via_json(c.body)?,
        segment: via_json(c.segment)?,
        send_at: c.send_at.map(|t| t.to_string()),
        recipients: n(c.recipients.len()),
        delivered: n(stats.map_or(0, |s| s.delivered.len())),
        opened: n(stats.map_or(0, |s| s.opened.len())),
        clicked: n(stats.map_or(0, |s| s.clicked.len())),
    })
}

pub fn customer_response(
    row: &CustomerRow,
    profiles: &BTreeMap<Ulid, PersonaProfile>,
) -> CustomerResponse {
    let profile = profiles.get(&row.customer);
    CustomerResponse {
        customer: row.customer.to_string(),
        display_name: row.display_name.clone(),
        preferences: profile.map(|p| p.preferences.clone()).unwrap_or_default(),
        home_zone: row.home_zone.clone(),
        place: profile.map(|p| p.place.clone()).unwrap_or_default(),
        marketing: row.marketing,
        loyalty_points: row.loyalty_balance.max(0),
        orders: row.orders,
        last_order_at: row.last_order_at.map(|t| t.to_string()),
        catering: row.catering,
    }
}

pub fn segment_response(
    projection: &CrmProjection,
    segment: Segment,
    now: BusinessTime,
) -> Result<SegmentResponse> {
    let members = segment_members(projection, segment, now);
    Ok(SegmentResponse {
        segment: via_json(segment)?,
        members: u32::try_from(members.len()).unwrap_or(u32::MAX),
        sample: members
            .iter()
            .take(SEGMENT_SAMPLE)
            .map(Ulid::to_string)
            .collect(),
    })
}

/// What a send timer comes to, decided on the campaign table and the projection at `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendStep {
    /// The events to commit: `CampaignSent` with the frozen recipients.
    Sent(Vec<CrmEvent>),
    /// Not scheduled any more (sent, cancelled, back to draft): the timer goes, nothing is sent.
    Nothing,
    /// Before `send_at` by business time: the timer is set again from it.
    NotDue(BusinessTime),
    /// A rule the send broke, logged by its slug; the timer goes.
    Refused(&'static str),
}

/// The send timer's decision: `SendCampaign` with the audience the projection gives at `now`.
/// A second firing finds the campaign sent and sends nothing (the aggregate's rule).
pub fn send_step(
    table: &CampaignTable,
    projection: &CrmProjection,
    campaign: Ulid,
    ctx: &DecideContext,
) -> SendStep {
    let Some(c) = table.get(campaign) else {
        return SendStep::Nothing;
    };
    let audience = Audience::of(projection, c.segment, ctx.now);
    match Campaigns::decide(
        table,
        &CampaignCommand::SendCampaign { campaign, audience },
        ctx,
    ) {
        Ok(events) if events.is_empty() => SendStep::Nothing,
        Ok(events) => SendStep::Sent(events),
        Err(CampaignError::NotDue { send_at }) => SendStep::NotDue(send_at),
        Err(e) => SendStep::Refused(e.rule()),
    }
}

/// The rows of `log`, as read back.
#[derive(Deserialize)]
struct LogRow {
    envelope: String,
}

#[derive(Deserialize)]
struct StateRow {
    directory: String,
    profiles: String,
    projection: String,
    shadow: Option<String>,
    rebuild: String,
    started_ms: Option<i64>,
    ms: Option<i64>,
}

/// The state row, parsed.
struct Held {
    directory: Directory,
    profiles: BTreeMap<Ulid, PersonaProfile>,
    projection: CrmProjection,
    /// The projection as it stood when a rebuild started, kept current by deliveries while it
    /// runs: what decides whether a delivery is applied, and what the replay must reproduce.
    shadow: Option<CrmProjection>,
    rebuild: Rebuild,
    started_ms: Option<i64>,
    ms: Option<i64>,
}

impl Held {
    fn rebuilding(&self) -> bool {
        self.rebuild.is_running()
    }

    /// The projection a delivery is decided against: the shadow while a rebuild runs.
    fn live(&mut self) -> &mut CrmProjection {
        match &mut self.shadow {
            Some(s) if self.rebuild.is_running() => s,
            _ => &mut self.projection,
        }
    }
}

/// What one delivery came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ingested {
    Applied,
    Duplicate,
    Stale,
    Ignored,
    /// The order or the inquiry it names has not arrived: retry.
    UnknownRef,
    /// A rule a retry cannot fix (a customer outside the roster, a stream Crm does not read):
    /// logged and acknowledged.
    Refused(&'static str),
}

impl Ingested {
    fn label(self) -> &'static str {
        match self {
            Ingested::Applied => "applied",
            Ingested::Duplicate => "duplicate",
            Ingested::Stale => "stale",
            Ingested::Ignored => "ignored",
            Ingested::UnknownRef => "unknown-ref",
            Ingested::Refused(_) => "refused",
        }
    }
}

fn crm_rule(e: &CrmError) -> &'static str {
    match e {
        CrmError::UnknownRef(_) => "unknown-ref",
        CrmError::UnknownCustomer(_) => "unknown-customer",
        CrmError::BadStream(_) => "bad-stream",
        CrmError::Codec(_) => "codec",
    }
}

/// One envelope applied to `held`: to the projection, or while a rebuild runs to the shadow,
/// with the log entry to append when it changed it.
fn ingest_one(held: &mut Held, envelope: &Envelope) -> (Ingested, Option<Envelope>) {
    let entry = log_entry(envelope);
    let outcome = match held.live().apply(&entry) {
        Ok(Outcome::Applied) => Ingested::Applied,
        Ok(Outcome::Duplicate) => Ingested::Duplicate,
        Ok(Outcome::Stale) => Ingested::Stale,
        Ok(Outcome::NotForCrm) => Ingested::Ignored,
        Err(CrmError::UnknownRef(_)) => Ingested::UnknownRef,
        Err(e) => Ingested::Refused(crm_rule(&e)),
    };
    if outcome != Ingested::Applied {
        return (outcome, None);
    }
    if held.rebuilding() {
        held.rebuild.extend(1);
    }
    (outcome, Some(entry))
}

#[durable_object]
pub struct Crm {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Crm {
    fn new(state: State, env: Env) -> Self {
        Crm {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_seed") => {
                let body: SeedCrm = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_wipe") => json(&child::wipe(&self.state).await?, 200),
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                let query = req.url()?.query().map(str::to_owned);
                self.route(&meta, method, path, query.as_deref(), &mut req, now)
                    .await
            }
        }
    }

    async fn alarm(&self) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let storage = self.state.storage();
        let Some(meta) = child::meta(&storage.sql())? else {
            storage.delete_all().await?;
            return Response::empty();
        };
        // Sends wait for the alarm after a rebuild ends, so a send never reads a partial
        // projection.
        let rebuilding_at_start = self.held()?.rebuilding();
        let mut deferred = Vec::new();
        for timer in stream::due(&storage.sql(), now)? {
            match timer.purpose.as_str() {
                SEND if rebuilding_at_start => deferred.push(timer),
                SEND => self.fire_send(&meta, &timer, now)?,
                REBUILD => self.rebuild_step(&meta, now)?,
                OUTBOX => stream::outbox_timer(&storage, &self.env, now, CLASS).await?,
                BACKSTOP => {
                    console_log!("{{\"event\":\"backstop\",\"object\":\"{CLASS}\"}}");
                    child::wipe(&self.state).await?;
                    return Response::empty();
                }
                _ => stream::delete_timer(&storage.sql(), &timer.id)?,
            }
        }
        if !deferred.is_empty() {
            // A deferred send is due again when the rebuild's next step is, so the re-arm sets
            // the alarm for that step and not for now, which would spin one alarm run after
            // another (each counted by the loop guard) until the rebuild ends. Its business
            // time is kept. When the step that ended the rebuild ran in this loop there is no
            // rebuild timer left, and the sends stay due for the next alarm.
            let sql = storage.sql();
            if let Some(step) = stream::timers(&sql)?
                .iter()
                .find(|t| t.id == REBUILD)
                .and_then(stream::Timer::due_wall)
            {
                for timer in &deferred {
                    stream::set_timer(
                        &sql,
                        &timer.id,
                        &timer.purpose,
                        step,
                        timer.due_business.as_deref(),
                    )?;
                }
            }
            console_log!(
                "{{\"event\":\"sends_deferred\",\"object\":\"{CLASS}\",\"sends\":{}}}",
                deferred.len()
            );
        }
        stream::rearm(&storage, now, CLASS).await?;
        Response::empty()
    }
}

impl Crm {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn ensure_schema(&self) -> Result<()> {
        if !self.schema_ready.get() {
            stream::create_schema(&self.sql(), SCHEMA)?;
            self.schema_ready.set(true);
        }
        Ok(())
    }

    fn held(&self) -> Result<Held> {
        let row: Option<StateRow> = first(
            &self.sql(),
            "SELECT directory, profiles, projection, shadow, rebuild, started_ms, ms FROM crm",
            vec![],
        )?;
        let row = row.ok_or_else(|| Error::RustError("crm has no state row".into()))?;
        Ok(Held {
            directory: serde_json::from_str(&row.directory)?,
            profiles: serde_json::from_str(&row.profiles)?,
            projection: serde_json::from_str(&row.projection)?,
            shadow: row
                .shadow
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?,
            rebuild: serde_json::from_str(&row.rebuild)?,
            started_ms: row.started_ms,
            ms: row.ms,
        })
    }

    /// The projection's stored text, byte for byte.
    fn projection_text(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct P {
            projection: String,
        }
        let row: Option<P> = first(&self.sql(), "SELECT projection FROM crm", vec![])?;
        Ok(row.map(|r| r.projection).unwrap_or_default())
    }

    fn log_len(&self) -> Result<u32> {
        #[derive(Deserialize)]
        struct N {
            n: i64,
        }
        let n: Option<N> = first(&self.sql(), "SELECT count(*) AS n FROM log", vec![])?;
        Ok(u32::try_from(n.map_or(0, |r| r.n)).unwrap_or(u32::MAX))
    }

    fn campaigns(&self, meta: &child::Meta) -> Result<(CampaignTable, u64)> {
        if !has_table(&self.sql(), "events")? {
            return Ok((CampaignTable::default(), 0));
        }
        let envelopes = stream::events(&self.sql(), meta.sandbox_id()?, &meta.name)?;
        let decoded: Vec<CrmEvent> = envelopes
            .iter()
            .map(CrmEvent::from_envelope)
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| Error::RustError(e.to_string()))?;
        Ok((
            replay::<Campaigns>(&decoded),
            envelopes.last().map_or(0, |e| e.seq),
        ))
    }

    async fn route(
        &self,
        meta: &child::Meta,
        method: Method,
        path: &str,
        query: Option<&str>,
        req: &mut Request,
        now: WallTime,
    ) -> Result<Response> {
        let id_after = |prefix: &str| -> Option<Ulid> { path.strip_prefix(prefix)?.parse().ok() };
        match (method, path) {
            (Method::Post, "/_event") => {
                let text = req.text().await?;
                let Ok(envelope) = serde_json::from_str::<Envelope>(&text) else {
                    return refuse(422, "envelope");
                };
                if envelope.sandbox.to_string() != meta.sandbox {
                    return refuse(422, "envelope");
                }
                self.event(envelope)
            }
            (Method::Post, "/_ingest") => {
                let body: IngestIn = sql::body(req).await?;
                self.ingest(body.envelopes)
            }
            (Method::Post, "/_command") => {
                let body: CommandIn = sql::body(req).await?;
                self.command(meta, body, now).await
            }
            (Method::Post, "/_rebuild") => {
                let body: RebuildIn = sql::body(req).await?;
                self.start_rebuild(body, now).await
            }
            (Method::Get, "/_rebuild") => json(&self.rebuild_response(&self.held()?)?, 200),
            (Method::Get, "/_projection") => {
                let mut res = Response::ok(self.projection_text()?)?;
                res.headers_mut().set("Content-Type", "application/json")?;
                Ok(res)
            }
            (Method::Post, "/_clock") => {
                let body: ClockUpdate = sql::body(req).await?;
                child::clock(&self.sql(), &body)?;
                stream::arm(&self.state.storage(), now).await?;
                json(&serde_json::json!({ "clock_v": body.clock_v }), 200)
            }
            (Method::Get, p) => {
                let held = self.held()?;
                let today = meta.business(now);
                let answer = match p {
                    "/_customers" => Some(serde_json::to_value(CustomerListResponse {
                        customers: held
                            .projection
                            .customers()
                            .map(|r| customer_response(r, &held.profiles))
                            .collect(),
                    })?),
                    "/_segments" => Some(serde_json::to_value(SegmentListResponse {
                        segments: Segment::ALL
                            .into_iter()
                            .map(|s| segment_response(&held.projection, s, today))
                            .collect::<Result<_>>()?,
                    })?),
                    "/_campaigns" => {
                        let (table, _) = self.campaigns(meta)?;
                        Some(serde_json::to_value(CampaignListResponse {
                            campaigns: table
                                .iter()
                                .map(|c| campaign_response(c, &held.projection))
                                .collect::<Result<_>>()?,
                        })?)
                    }
                    "/_leads" => Some(serde_json::to_value(LeadPipelineResponse {
                        stages: held
                            .projection
                            .pipeline()
                            .into_iter()
                            .map(|(stage, ids)| {
                                Ok(LeadStageView {
                                    stage: via_json(stage)?,
                                    count: u32::try_from(ids.len()).unwrap_or(u32::MAX),
                                    events: ids.iter().map(Ulid::to_string).collect(),
                                })
                            })
                            .collect::<Result<_>>()?,
                    })?),
                    "/_activity" => {
                        let limit = limit_of(query, ACTIVITY_DEFAULT, ACTIVITY_MAX);
                        Some(serde_json::to_value(ActivityResponse {
                            entries: held
                                .projection
                                .activity()
                                .iter()
                                .rev()
                                .take(limit)
                                .map(|e| ActivityEntry {
                                    at: e.at.to_string(),
                                    event_type: e.event_type.clone(),
                                    summary: e.summary.clone(),
                                })
                                .collect(),
                        })?)
                    }
                    p if p.starts_with("/_customer/") => id_after("/_customer/")
                        .and_then(|c| held.projection.customer(c))
                        .map(|r| serde_json::to_value(customer_response(r, &held.profiles)))
                        .transpose()?,
                    p if p.starts_with("/_timeline/") => id_after("/_timeline/")
                        .filter(|c| held.projection.customer(*c).is_some())
                        .map(|c| {
                            serde_json::to_value(TimelineResponse {
                                customer: c.to_string(),
                                entries: held
                                    .projection
                                    .timeline(c)
                                    .iter()
                                    .map(|e| TimelineEntry {
                                        at: e.at.to_string(),
                                        event_type: e.event_type.clone(),
                                        reference: e.reference.to_string(),
                                        label: e.label.clone(),
                                    })
                                    .collect(),
                            })
                        })
                        .transpose()?,
                    p if p.starts_with("/_segment/") => {
                        match Segment::parse(&p["/_segment/".len()..]) {
                            Some(s) => Some(serde_json::to_value(segment_response(
                                &held.projection,
                                s,
                                today,
                            )?)?),
                            None => None,
                        }
                    }
                    p if p.starts_with("/_campaign/") => match id_after("/_campaign/") {
                        Some(cid) => {
                            let (table, _) = self.campaigns(meta)?;
                            table
                                .get(cid)
                                .map(|c| {
                                    campaign_response(c, &held.projection)
                                        .and_then(|r| Ok(serde_json::to_value(r)?))
                                })
                                .transpose()?
                        }
                        None => None,
                    },
                    _ => return refuse(404, "not-found"),
                };
                match answer {
                    Some(v) => {
                        let mut res = json(&v, 200)?;
                        if held.rebuilding() {
                            res.headers_mut().set("Projection-State", "rebuilding")?;
                        }
                        Ok(res)
                    }
                    None => refuse(404, "unknown"),
                }
            }
            _ => refuse(404, "not-found"),
        }
    }

    /// The seed's roster and history, folded and logged in one transaction.
    async fn seed(&self, s: SeedCrm, now: WallTime) -> Result<Response> {
        if child::meta(&self.sql())?.is_some() {
            return json(&serde_json::json!({ "seeded": true }), 200);
        }
        self.ensure_schema()?;
        let mut held = Held {
            projection: CrmProjection::new(&s.directory),
            directory: s.directory,
            profiles: s.profiles,
            shadow: None,
            rebuild: Rebuild::default(),
            started_ms: None,
            ms: None,
        };
        let mut entries = Vec::new();
        let mut refused = 0u32;
        for e in &s.envelopes {
            match ingest_one(&mut held, e) {
                (_, Some(entry)) => entries.push(entry),
                (Ingested::Duplicate | Ingested::Stale | Ingested::Ignored, None) => {}
                (_, None) => refused += 1,
            }
        }
        let sql = self.sql();
        let birth = s.birth;
        let n = entries.len();
        let row = (
            serde_json::to_string(&held.directory)?,
            serde_json::to_string(&held.profiles)?,
            held.projection.to_json(),
            serde_json::to_string(&held.rebuild)?,
        );
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)?;
            exec(
                &sql,
                "INSERT INTO crm (id, directory, profiles, projection, rebuild) VALUES (1, ?, ?, ?, ?)",
                vec![row.0.into(), row.1.into(), row.2.into(), row.3.into()],
            )?;
            append_log(&sql, &entries)?;
            Ok(())
        })?;
        stream::arm(&self.state.storage(), now).await?;
        console_log!(
            "{{\"event\":\"crm_seeded\",\"object\":\"{CLASS}\",\"logged\":{n},\"refused\":{refused}}}"
        );
        json(&serde_json::json!({ "seeded": true, "logged": n }), 201)
    }

    /// Writes the state row's changing parts and the new log entries, in the caller's
    /// transaction.
    fn save(sql: &SqlStorage, held: &Held, entries: &[Envelope]) -> Result<()> {
        exec(
            sql,
            "UPDATE crm SET projection = ?, shadow = ?, rebuild = ?, started_ms = ?, ms = ?",
            vec![
                held.projection.to_json().into(),
                match &held.shadow {
                    Some(s) => s.to_json().into(),
                    None => worker::SqlStorageValue::Null,
                },
                serde_json::to_string(&held.rebuild)?.into(),
                held.started_ms
                    .map_or(worker::SqlStorageValue::Null, Into::into),
                held.ms.map_or(worker::SqlStorageValue::Null, Into::into),
            ],
        )?;
        append_log(sql, entries)
    }

    /// One delivery from the consumer.
    fn event(&self, envelope: Envelope) -> Result<Response> {
        let mut held = self.held()?;
        let (outcome, entry) = ingest_one(&mut held, &envelope);
        match outcome {
            Ingested::UnknownRef => return refuse(503, "unknown-ref"),
            Ingested::Refused(rule) => console_log!(
                "{{\"event\":\"crm_event_refused\",\"id\":\"{}\",\"type\":{:?},\"rule\":\"{rule}\"}}",
                envelope.id,
                envelope.event_type
            ),
            _ => {}
        }
        if let Some(entry) = entry {
            let sql = self.sql();
            transaction_sync(&self.state.storage(), move || {
                Self::save(&sql, &held, std::slice::from_ref(&entry))
            })?;
        }
        json(&serde_json::json!({ "outcome": outcome.label() }), 200)
    }

    /// Several deliveries in one transaction, in order. A refused one is counted and skipped.
    fn ingest(&self, list: Vec<Envelope>) -> Result<Response> {
        let mut held = self.held()?;
        let mut entries = Vec::new();
        let mut skipped = 0u32;
        for e in &list {
            match ingest_one(&mut held, e) {
                (_, Some(entry)) => entries.push(entry),
                (Ingested::Duplicate | Ingested::Stale | Ingested::Ignored, None) => {}
                (_, None) => skipped += 1,
            }
        }
        let n = entries.len();
        if n > 0 {
            let sql = self.sql();
            transaction_sync(&self.state.storage(), move || {
                Self::save(&sql, &held, &entries)
            })?;
        }
        if skipped > 0 {
            console_log!(
                "{{\"event\":\"crm_ingest_skipped\",\"object\":\"{CLASS}\",\"skipped\":{skipped}}}"
            );
        }
        json(&serde_json::json!({ "applied": n }), 200)
    }

    async fn command(&self, meta: &child::Meta, c: CommandIn, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let seen = stream::seen(&sql, &c.key)?;
        match check_command(seen.as_ref(), &c.body_hash) {
            Ok(CommandCheck::Replay(result)) => return replayed(result),
            Ok(CommandCheck::Fresh) => {}
            Err(_) => return refuse(422, "key-reused"),
        }
        let id: Ulid = c
            .key
            .rsplit(':')
            .next()
            .and_then(|k| k.parse().ok())
            .map_or_else(|| random::ulid(now), Ok)?;
        let ctx = DecideContext {
            now: meta.business(now),
            id,
        };
        let (table, last) = self.campaigns(meta)?;
        let (table, events) = match execute::<Campaigns>(table, &c.cmd.domain(), &ctx) {
            Ok(done) => done,
            Err(e) => {
                let (status, body) = refusal_of(&e);
                return json(&body, status);
            }
        };
        let held = self.held()?;
        let campaign = table
            .get(c.cmd.campaign())
            .ok_or_else(|| Error::RustError("a decided campaign is missing".into()))?;
        let answer = serde_json::to_string(&campaign_response(campaign, &held.projection)?)?;
        let built = self.envelopes_of(meta, last, ctx.now, Some(c.key.clone()), &events, now)?;
        let any = !built.is_empty();
        let stored = answer.clone();
        let (key, hash) = (c.key, c.body_hash);
        let offset = meta.clock_offset_s;
        transaction_sync(&self.state.storage(), move || {
            stream::append(&sql, &built)?;
            stream::remember(&sql, &key, &hash, &stored, now)?;
            sync_timers(&sql, &table, offset, false)
        })?;
        if any {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        } else {
            stream::arm(&self.state.storage(), now).await?;
        }
        let mut res = Response::ok(answer)?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }

    /// Crm's own events as envelopes on its stream, after `last`.
    fn envelopes_of(
        &self,
        meta: &child::Meta,
        last: u64,
        at: BusinessTime,
        cause: Option<String>,
        events: &[CrmEvent],
        now: WallTime,
    ) -> Result<Vec<Envelope>> {
        let head = StreamHead {
            sandbox: meta.sandbox_id()?,
            stream: meta.name.clone(),
            last_seq: last,
        };
        let stamp = Stamp {
            at,
            recorded_at: now,
            cause,
        };
        let mut ids = Vec::new();
        for _ in events {
            ids.push(random::ulid(now)?);
        }
        let mut ids = ids.into_iter();
        envelopes(&head, &stamp, events, || {
            ids.next().unwrap_or(Ulid::from_parts(0, 0))
        })
        .map_err(|e| Error::RustError(e.to_string()))
    }

    /// A send timer is due: `SendCampaign` with the audience the projection gives now, under the
    /// timer's key, the timer deleted in the same transaction.
    fn fire_send(&self, meta: &child::Meta, timer: &stream::Timer, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let Some(campaign) = timer
            .id
            .strip_prefix("send:")
            .and_then(|c| c.parse::<Ulid>().ok())
        else {
            return stream::delete_timer(&sql, &timer.id);
        };
        let key = format!("timer:send:{campaign}");
        let (table, last) = self.campaigns(meta)?;
        if stream::seen(&sql, &key)?.is_some() {
            // The send was committed by an earlier run: whatever row is left goes.
            return sync_timers(&sql, &table, meta.clock_offset_s, false);
        }
        let held = self.held()?;
        let ctx = DecideContext {
            now: meta.business(now),
            id: random::ulid(now)?,
        };
        match send_step(&table, &held.projection, campaign, &ctx) {
            SendStep::Nothing => {
                console_log!(
                    "{{\"event\":\"campaign_send_skipped\",\"campaign\":\"{campaign}\",\"reason\":\"not-scheduled\"}}"
                );
                stream::delete_timer(&sql, &timer.id)
            }
            SendStep::NotDue(_) => sync_timers(&sql, &table, meta.clock_offset_s, true),
            SendStep::Refused(rule) => {
                console_log!(
                    "{{\"event\":\"campaign_send_refused\",\"campaign\":\"{campaign}\",\"rule\":\"{rule}\"}}"
                );
                stream::delete_timer(&sql, &timer.id)
            }
            SendStep::Sent(events) => {
                let recipients = match events.first() {
                    Some(CrmEvent::CampaignSent { recipients, .. }) => recipients.len(),
                    _ => 0,
                };
                let next = bakery_domain::replay_from::<Campaigns>(table, &events);
                let built =
                    self.envelopes_of(meta, last, ctx.now, Some(key.clone()), &events, now)?;
                let offset = meta.clock_offset_s;
                transaction_sync(&self.state.storage(), move || {
                    stream::append(&sql, &built)?;
                    stream::remember(&sql, &key, "", "{}", now)?;
                    sync_timers(&sql, &next, offset, false)
                })?;
                console_log!(
                    "{{\"event\":\"campaign_sent\",\"object\":\"{CLASS}\",\"campaign\":\"{campaign}\",\"recipients\":{recipients}}}"
                );
                stream::relay_after(&self.state, &self.env, now, CLASS)
            }
        }
    }

    fn rebuild_response(&self, held: &Held) -> Result<RebuildResponse> {
        let r = &held.rebuild;
        let (applied, total) = match r.state {
            RebuildState::Idle => (0, self.log_len()?),
            _ => (r.position, r.total),
        };
        Ok(RebuildResponse {
            state: via_json(r.state)?,
            applied,
            total,
            ms: match r.state {
                RebuildState::Finished => held.ms.and_then(|m| u32::try_from(m).ok()),
                _ => None,
            },
        })
    }

    /// "Rebuild projections": the projection truncated to the roster, the cursor at the log's
    /// start, the old projection kept as the shadow, and the first step armed.
    async fn start_rebuild(&self, body: RebuildIn, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if let Some(seen) = stream::seen(&sql, &body.key)? {
            let mut res = replayed(&seen.result)?.with_status(202);
            res.headers_mut().set("Content-Type", "application/json")?;
            return Ok(res);
        }
        let mut held = self.held()?;
        if held.rebuilding() {
            return refuse(409, "rebuild");
        }
        let total = self.log_len()?;
        let (rebuild, fresh) = Rebuild::start(&held.directory, total);
        held.shadow = Some(std::mem::replace(&mut held.projection, fresh));
        held.rebuild = rebuild;
        held.started_ms = Some(now.unix_ms());
        held.ms = None;
        let answer = serde_json::to_string(&self.rebuild_response(&held)?)?;
        let stored = answer.clone();
        let key = body.key;
        transaction_sync(&self.state.storage(), move || {
            Self::save(&sql, &held, &[])?;
            stream::remember(&sql, &key, "", &stored, now)?;
            stream::set_timer(&sql, REBUILD, REBUILD, now, None)
        })?;
        console_log!("{{\"event\":\"rebuild_started\",\"object\":\"{CLASS}\",\"total\":{total}}}");
        stream::arm(&self.state.storage(), now).await?;
        let mut res = Response::ok(answer)?.with_status(202);
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }

    /// One rebuild run: the next `REBUILD_BATCH` log entries replayed in one transaction, then
    /// the next run, or at the end `ProjectionRebuildFinished` and the shadow dropped.
    fn rebuild_step(&self, meta: &child::Meta, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let mut held = self.held()?;
        if !held.rebuilding() {
            return stream::delete_timer(&sql, REBUILD);
        }
        let found: Vec<LogRow> = rows(
            &sql,
            "SELECT envelope FROM log ORDER BY pos LIMIT ? OFFSET ?",
            vec![
                i64::try_from(REBUILD_BATCH).unwrap_or(200).into(),
                i64::from(held.rebuild.position).into(),
            ],
        )?;
        let batch: Vec<Envelope> = found
            .iter()
            .map(|r| serde_json::from_str(&r.envelope))
            .collect::<std::result::Result<_, _>>()?;
        // The log may have grown since the rebuild started; the deliveries extended the total
        // as they were appended, so the count stays the log's length.
        held.rebuild.total = held.rebuild.total.max(self.log_len()?);
        let done = match held.rebuild.step(&mut held.projection, &batch) {
            Ok(done) => done,
            Err(e) => {
                // Cannot happen for a log of applied envelopes; the projection as it stood is
                // put back rather than left partial.
                console_log!(
                    "{{\"event\":\"rebuild_error\",\"object\":\"{CLASS}\",\"rule\":\"{}\",\"position\":{}}}",
                    crm_rule(&e),
                    held.rebuild.position
                );
                if let Some(shadow) = held.shadow.take() {
                    held.projection = shadow;
                }
                held.rebuild = Rebuild::default();
                transaction_sync(&self.state.storage(), move || {
                    Self::save(&sql, &held, &[])?;
                    stream::delete_timer(&sql, REBUILD)
                })?;
                return Ok(());
            }
        };
        if !done {
            let position = held.rebuild.position;
            let total = held.rebuild.total;
            transaction_sync(&self.state.storage(), move || {
                Self::save(&sql, &held, &[])?;
                stream::set_timer(
                    &sql,
                    REBUILD,
                    REBUILD,
                    stream::after(now, REBUILD_GAP_MS)?,
                    None,
                )
            })?;
            console_log!(
                "{{\"event\":\"rebuild_step\",\"object\":\"{CLASS}\",\"applied\":{position},\"total\":{total}}}"
            );
            return Ok(());
        }
        let ms = held.started_ms.map_or(0, |s| (now.unix_ms() - s).max(0));
        let ms32 = u32::try_from(ms).unwrap_or(u32::MAX);
        let event = held.rebuild.finish(ms32);
        let identical = held
            .shadow
            .as_ref()
            .is_some_and(|s| s.to_json() == held.projection.to_json());
        held.shadow = None;
        held.ms = Some(ms);
        let events = held.rebuild.position;
        let (_, last) = self.campaigns(meta)?;
        let built = self.envelopes_of(meta, last, meta.business(now), None, &[event], now)?;
        transaction_sync(&self.state.storage(), move || {
            Self::save(&sql, &held, &[])?;
            stream::append(&sql, &built)?;
            stream::delete_timer(&sql, REBUILD)
        })?;
        console_log!(
            "{{\"event\":\"rebuild_finished\",\"object\":\"{CLASS}\",\"events\":{events},\"ms\":{ms32},\"identical\":{identical}}}"
        );
        stream::relay_after(&self.state, &self.env, now, CLASS)
    }
}

/// The log entries, after the last `pos`, in the caller's transaction.
fn append_log(sql: &SqlStorage, entries: &[Envelope]) -> Result<()> {
    for e in entries {
        exec(
            sql,
            "INSERT OR IGNORE INTO log (id, envelope) VALUES (?, ?)",
            vec![e.id.to_string().into(), serde_json::to_string(e)?.into()],
        )?;
    }
    Ok(())
}

/// The `?limit=` of a query, bounded; the default when absent or unreadable.
pub fn limit_of(query: Option<&str>, default: usize, max: usize) -> usize {
    query
        .into_iter()
        .flat_map(|q| q.split('&'))
        .find_map(|kv| kv.strip_prefix("limit="))
        .and_then(|v| v.parse::<usize>().ok())
        .map_or(default, |n| n.clamp(1, max))
}

/// One `send:<campaign>` row per scheduled campaign, at its `send_at` in business time; the
/// rest deleted. A row whose business time is unchanged is left alone unless `recompute` asks for
/// its wall time again.
fn sync_timers(
    sql: &SqlStorage,
    table: &CampaignTable,
    offset_s: i64,
    recompute: bool,
) -> Result<()> {
    let have: BTreeMap<String, Option<String>> = stream::timers(sql)?
        .into_iter()
        .filter(|t| t.purpose == SEND)
        .map(|t| (t.id, t.due_business))
        .collect();
    let want: BTreeMap<String, BusinessTime> = table
        .iter()
        .filter(|c| c.state == CampaignState::Scheduled)
        .filter_map(|c| Some((format!("send:{}", c.campaign), c.send_at?)))
        .collect();
    for id in have.keys().filter(|id| !want.contains_key(*id)) {
        stream::delete_timer(sql, id)?;
    }
    for (id, at) in &want {
        let due = at.to_string();
        if !recompute
            && have
                .get(id)
                .is_some_and(|d| d.as_deref() == Some(due.as_str()))
        {
            continue;
        }
        stream::set_timer(sql, id, SEND, wall_at(*at, offset_s), Some(&due))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::crm::Persona;
    use std::collections::BTreeSet;

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_793_000_000_000, n)
    }

    fn at(text: &str) -> BusinessTime {
        text.parse().unwrap()
    }

    fn ctx(now: &str, n: u128) -> DecideContext {
        DecideContext {
            now: at(now),
            id: ulid(900 + n),
        }
    }

    fn directory() -> Directory {
        Directory {
            personas: (1..=3)
                .map(|i| Persona {
                    customer: ulid(i),
                    display_name: format!("Persona {i}"),
                    home_zone: "z1".into(),
                    marketing: i != 2,
                    opening_points: 10,
                })
                .collect(),
            cake_items: BTreeSet::new(),
        }
    }

    fn scheduled(send_at: &str) -> CampaignTable {
        let mut table = CampaignTable::default();
        for (cmd, now) in [
            (
                Cmd::Draft {
                    campaign: ulid(50),
                    subject: SubjectTemplate::WeekendBake,
                    body: BodyTemplate::FreshBread,
                    segment: Segment::Everyone,
                },
                "2026-11-07T09:00:00-07:00",
            ),
            (
                Cmd::Schedule {
                    campaign: ulid(50),
                    send_at: at(send_at),
                },
                "2026-11-07T09:00:00-07:00",
            ),
        ] {
            table = execute::<Campaigns>(table, &cmd.domain(), &ctx(now, 1))
                .unwrap()
                .0;
        }
        table
    }

    #[test]
    fn a_send_timer_that_fires_twice_sends_once_and_only_to_consenting_members() {
        let projection = CrmProjection::new(&directory());
        let table = scheduled("2026-11-07T09:30:00-07:00");
        // Early, by a stale wall time: set again from its business time.
        assert_eq!(
            send_step(
                &table,
                &projection,
                ulid(50),
                &ctx("2026-11-07T09:20:00-07:00", 2)
            ),
            SendStep::NotDue(at("2026-11-07T09:30:00-07:00"))
        );
        let SendStep::Sent(events) = send_step(
            &table,
            &projection,
            ulid(50),
            &ctx("2026-11-07T09:31:00-07:00", 3),
        ) else {
            panic!("the first firing sends");
        };
        let [CrmEvent::CampaignSent { recipients, .. }] = events.as_slice() else {
            panic!("one CampaignSent");
        };
        assert_eq!(
            recipients,
            &[ulid(1), ulid(3)],
            "persona 2 withdrew consent"
        );
        let after = bakery_domain::replay_from::<Campaigns>(table, &events);
        assert_eq!(
            send_step(
                &after,
                &projection,
                ulid(50),
                &ctx("2026-11-07T09:32:00-07:00", 4)
            ),
            SendStep::Nothing,
            "the second firing sends nothing"
        );
        assert_eq!(
            send_step(
                &after,
                &projection,
                ulid(51),
                &ctx("2026-11-07T09:32:00-07:00", 5)
            ),
            SendStep::Nothing,
            "a timer for no campaign sends nothing"
        );
    }

    #[test]
    fn refusals_carry_codes_and_the_earliest_whole_minute() {
        let (status, r) = refusal_of(&CampaignError::ScheduleTooSoon {
            earliest: at("2026-11-07T09:15:20-07:00"),
        });
        assert_eq!(status, 422);
        assert_eq!(r.rule.as_deref(), Some("schedule-too-soon"));
        assert_eq!(r.earliest.as_deref(), Some("2026-11-07T09:16:00-07:00"));
        let (status, r) = refusal_of(&CampaignError::OutOfOrder {
            command: "EditCampaign",
            state: CampaignState::Scheduled,
        });
        assert_eq!((status, r.rule.as_deref()), (409, Some("out-of-order")));
        assert_eq!(refusal_of(&CampaignError::UnknownCampaign(ulid(1))).0, 404);
        assert_eq!(
            whole_minute_after(at("2026-11-07T09:15:00-07:00")),
            at("2026-11-07T09:15:00-07:00")
        );
    }

    #[test]
    fn a_delivery_during_a_rebuild_is_decided_by_the_shadow_and_logged_for_the_replay() {
        let dir = directory();
        let mut held = Held {
            directory: dir.clone(),
            profiles: BTreeMap::new(),
            projection: CrmProjection::new(&dir),
            shadow: None,
            rebuild: Rebuild::default(),
            started_ms: None,
            ms: None,
        };
        let consent = |n: u128, seq: u64, marketing: bool| -> Envelope {
            serde_json::from_value(serde_json::json!({
                "v": 1, "id": ulid(100 + n).to_string(), "sandbox": ulid(7).to_string(),
                "stream": format!("customer:{}:{}", ulid(7), ulid(1)), "seq": seq,
                "type": "ConsentChanged", "at": "2026-11-07T10:00:00-07:00",
                "recorded_at": "2026-11-07T17:00:00.000Z", "data": { "marketing": marketing },
                "cause": null
            }))
            .unwrap()
        };
        let (o, entry) = ingest_one(&mut held, &consent(1, 2, false));
        assert_eq!(o, Ingested::Applied);
        let log = vec![entry.unwrap()];
        let before = held.projection.to_json();
        let (rebuild, fresh) = Rebuild::start(&dir, 1);
        held.shadow = Some(std::mem::replace(&mut held.projection, fresh));
        held.rebuild = rebuild;
        // Arrives mid-rebuild: the shadow takes it, the partial projection does not.
        let (o, entry) = ingest_one(&mut held, &consent(2, 3, true));
        assert_eq!(o, Ingested::Applied);
        assert_eq!(held.rebuild.total, 2);
        assert_eq!(
            ingest_one(&mut held, &consent(2, 3, true)).0,
            Ingested::Duplicate
        );
        assert_eq!(
            ingest_one(&mut held, &consent(3, 1, true)).0,
            Ingested::Stale
        );
        let mut log = log;
        log.push(entry.unwrap());
        assert_ne!(held.projection.to_json(), before);
        let done = held.rebuild.step(&mut held.projection, &log).unwrap();
        assert!(done);
        assert_eq!(
            held.projection.to_json(),
            held.shadow.as_ref().unwrap().to_json(),
            "the replay reproduces the projection the deliveries built"
        );
        assert!(held.projection.customer(ulid(1)).unwrap().marketing);
    }

    #[test]
    fn a_limit_is_read_and_bounded() {
        assert_eq!(limit_of(None, 50, 500), 50);
        assert_eq!(limit_of(Some("limit=30"), 50, 500), 30);
        assert_eq!(limit_of(Some("kind=receipt&limit=9999"), 50, 500), 500);
        assert_eq!(limit_of(Some("limit=0"), 50, 500), 1);
        assert_eq!(limit_of(Some("limit=x"), 50, 500), 50);
    }

    #[test]
    fn every_command_reads_as_the_router_sends_it() {
        for text in [
            r#"{"cmd":"draft","campaign":"01JC8Z6K3W9QF2N4T7XRB5M0HD","subject":"cake-week","body":"cake-orders","segment":"cake-last-30-days"}"#,
            r#"{"cmd":"edit","campaign":"01JC8Z6K3W9QF2N4T7XRB5M0HD","subject":"thank-you","body":"announcement","segment":"everyone"}"#,
            r#"{"cmd":"schedule","campaign":"01JC8Z6K3W9QF2N4T7XRB5M0HD","send_at":"2026-11-08T09:30:00-07:00"}"#,
            r#"{"cmd":"cancel","campaign":"01JC8Z6K3W9QF2N4T7XRB5M0HD"}"#,
        ] {
            let cmd: Cmd = serde_json::from_str(text).unwrap();
            assert_eq!(serde_json::to_string(&cmd).unwrap(), text);
        }
    }
}
