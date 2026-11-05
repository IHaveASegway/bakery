//! `Schedule`, one per sandbox and bakery day, named `schedule:<sandbox>:<YYYY-MM-DD>`
//! (docs/domain.md, "Schedule reservation"). It hosts the domain's `Schedule` aggregate: the
//! state is the fold of its own `events` from `ScheduleState::new(date)`, the date read from the
//! object's name. Every command writes its events, their outbox rows, its key, the ids of the
//! events it consumed and its hold timers in one transaction, then relays.
//!
//! Born on first touch through the Sandbox's registry, like every child: the router (a hold, a
//! read of the day, a capacity change) and the seed register the name first, then hand the
//! birth here.
//!
//! Paths (the Worker builds them; nothing outside reaches them):
//!
//! - `POST /_open {birth}` → 200 `ScheduleResponse`: the day, created with its default
//!   capacities if it was not yet.
//! - `POST /_seed {birth, cmds}` → 201 `ScheduleResponse`; 200 when already seeded. The seed's
//!   commands (`refresh_caps`, `set_capacity`, `hold`, `confirm`) decided in order and written in
//!   one transaction; one the rules refuse is logged by its rule and skipped.
//! - `POST /_command {key, body_hash, birth?, cmd, cause?}` → 200 [`Answer`]; 200 with
//!   `Idempotent-Replayed: true` for a key seen with the same body; 422 `{error: "key-reused"}`
//!   for one seen with another; 422 `{error: "schedule", rule, next_free?, item?, free?}` for a
//!   rule the command breaks, which writes nothing. With `birth` the day is created if needed.
//!   `cmd` is one of `{cmd: "hold", ref, kind, start, zone, lines, expires_at}`, `{cmd: "confirm",
//!   ref}`, `{cmd: "release", ref, reason}`, `{cmd: "fulfil", ref}`, `{cmd: "set_capacity",
//!   target, capacity}`, `{cmd: "refresh_caps", menu_version, caps}`.
//! - `GET /_state` → 200 `ScheduleResponse`.
//! - `POST /_event` with an envelope, from the consumer → 200 `{outcome}`: `OrderPaid` is
//!   `Confirm`, `OrderExpired` and `OrderCancelled` are `Release {expired | cancelled}`,
//!   `OrderClosed` is `Fulfil`, each for the order the stream names; for the catering event the
//!   stream names, `CateringDepositPaid` is `Confirm`, `CateringDepositLapsed` is `Release
//!   {deposit_lapsed}`, `CateringCancelled` is `Release {cancelled}` and `CateringClosed` is
//!   `Fulfil` (`CateringBalancePaid` is `ignored`: the closure in the same step fulfils); `MenuPublished` is
//!   `RefreshCaps` with the caps of the Catalog's published menu. The event's id goes into
//!   `seen` with what it changed, so a redelivery is `duplicate`.
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs). The clock moves every hold
//!   timer's wall time, since each is set in business time.
//!
//! Timers: `hold:<ref>` for each held place, at its `expires_at` in business time (the Order's
//! `held_until`), converted to wall time with the sandbox's offset; the alarm decides
//! `Release {hold_expired}` for each one due. `outbox` and `backstop` as every child.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use bakery_app::Clock;
use bakery_contracts::{
    BakeLineView, BakeListView, CateringView, ItemCapView, ScheduleResponse, SlotView, ZoneView,
};
use bakery_domain::catalog::MenuView;
use bakery_domain::order::{LineInput, OrderKind};
use bakery_domain::outbox::{CommandCheck, Stamp, StreamHead, check_command, envelopes};
use bakery_domain::schedule::{
    HoldKind, HoldRequest, HoldStatus, ItemCap, ItemQty, ReleaseReason, Schedule as Aggregate,
    ScheduleCommand, ScheduleError, ScheduleEvent, ScheduleState, Target, normalize_lines,
};
use bakery_domain::{
    BakeryDate, BusinessTime, DecideContext, DomainEvent, Envelope, Ulid, WallTime, execute,
    replay_from,
};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::catalog;
use super::child::{self, Birth, ClockUpdate};
use super::sql::{self, exec, gone, json, refuse, replayed, rows, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::{SystemClock, business_at, wall_at};
use crate::random;

pub const BINDING: &str = "SCHEDULE";
pub const CLASS: &str = "Schedule";
/// A held place's timer: its purpose, and `hold:<ref>` its id.
const HOLD: &str = "hold";

pub fn name(sandbox: Ulid, date: BakeryDate) -> String {
    format!("schedule:{sandbox}:{date}")
}

/// The day a Schedule's name ends with.
pub fn date_of(name: &str) -> Option<BakeryDate> {
    let mut parts = name.split(':');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("schedule"), Some(_), Some(date), None) => date.parse().ok(),
        _ => None,
    }
}

const SCHEMA: &[&str] = &[
    child::META,
    // The consumed events' ids (docs/architecture.md, "Idempotent consumers").
    "CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at TEXT NOT NULL)",
];

/// A Schedule command as the Worker sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    Hold(HoldRequest),
    Confirm {
        #[serde(rename = "ref")]
        reference: Ulid,
    },
    Release {
        #[serde(rename = "ref")]
        reference: Ulid,
        reason: ReleaseReason,
    },
    Fulfil {
        #[serde(rename = "ref")]
        reference: Ulid,
    },
    SetCapacity {
        target: Target,
        capacity: u16,
    },
    RefreshCaps {
        menu_version: u32,
        caps: Vec<ItemCap>,
    },
}

impl Cmd {
    pub fn domain(&self) -> ScheduleCommand {
        match self {
            Cmd::Hold(r) => ScheduleCommand::Hold(Box::new(r.clone())),
            Cmd::Confirm { reference } => ScheduleCommand::Confirm {
                reference: *reference,
            },
            Cmd::Release { reference, reason } => ScheduleCommand::Release {
                reference: *reference,
                reason: *reason,
            },
            Cmd::Fulfil { reference } => ScheduleCommand::Fulfil {
                reference: *reference,
            },
            Cmd::SetCapacity { target, capacity } => ScheduleCommand::SetCapacity {
                target: target.clone(),
                capacity: *capacity,
            },
            Cmd::RefreshCaps { menu_version, caps } => ScheduleCommand::RefreshCaps {
                menu_version: *menu_version,
                caps: caps.clone(),
            },
        }
    }

    /// The place the command names, if it names one.
    fn reference(&self) -> Option<Ulid> {
        match self {
            Cmd::Hold(r) => Some(r.reference),
            Cmd::Confirm { reference }
            | Cmd::Release { reference, .. }
            | Cmd::Fulfil { reference } => Some(*reference),
            Cmd::SetCapacity { .. } | Cmd::RefreshCaps { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandIn {
    pub key: String,
    #[serde(default)]
    pub body_hash: String,
    /// Creates the day on its first write.
    #[serde(default)]
    pub birth: Option<Birth>,
    pub cmd: Cmd,
    #[serde(default)]
    pub cause: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Open {
    pub birth: Birth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedSchedule {
    pub birth: Birth,
    pub cmds: Vec<Cmd>,
}

/// One place as a command's answer shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoldView {
    #[serde(rename = "ref")]
    pub reference: Ulid,
    pub kind: HoldKind,
    pub start: BusinessTime,
    pub expires_at: BusinessTime,
    pub status: HoldStatus,
}

/// `/_command`'s answer, stored as the key's result: the event types it appended, the place it
/// named as it then stood, and the day.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    pub events: Vec<String>,
    #[serde(default)]
    pub hold: Option<HoldView>,
    pub schedule: ScheduleResponse,
}

/// A refusal's body: the rule, and what the problem document names with it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Refusal {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub rule: Option<String>,
    #[serde(default)]
    pub next_free: Option<String>,
    #[serde(default)]
    pub item: Option<String>,
    #[serde(default)]
    pub free: Option<u32>,
}

impl Refusal {
    fn of(e: &ScheduleError) -> Refusal {
        let (next_free, item, free) = match e {
            ScheduleError::SlotFull { next_free } => (next_free.map(|t| t.to_string()), None, None),
            ScheduleError::ItemCapExceeded { item, free } => {
                (None, Some(item.clone()), Some(*free))
            }
            _ => (None, None, None),
        };
        Refusal {
            error: "schedule".into(),
            rule: Some(e.rule().to_owned()),
            next_free,
            item,
            free,
        }
    }
}

/// The day as the API shows it (`ScheduleResponse`): the domain's counts, saturated to the
/// contract's `u16`, and `free` as capacity minus taken, never below 0.
pub fn response_of(state: &ScheduleState) -> ScheduleResponse {
    let sat = |n: u32| u16::try_from(n).unwrap_or(u16::MAX);
    let date = state.date();
    let windows: Vec<String> = date.window_starts().iter().map(|t| t.to_string()).collect();
    let mut items: BTreeSet<String> = state.item_caps().map(|(i, _)| i.to_owned()).collect();
    items.extend(
        state
            .holds()
            .filter(|h| h.status.counts())
            .flat_map(|h| h.lines.iter().map(|l| l.item.clone())),
    );
    ScheduleResponse {
        date: date.to_string(),
        open: state.is_open(),
        slots: state
            .slots()
            .into_iter()
            .map(|s| SlotView {
                start: s.start.to_string(),
                capacity: s.capacity,
                taken: sat(s.taken),
                free: s.capacity.saturating_sub(sat(s.taken)),
            })
            .collect(),
        zones: state
            .zones()
            .into_iter()
            .map(|z| ZoneView {
                zone: z.zone,
                capacity: z.capacity,
                taken: sat(z.taken),
                free: z.capacity.saturating_sub(sat(z.taken)),
                windows: windows.clone(),
            })
            .collect(),
        items: items
            .into_iter()
            .map(|item| ItemCapView {
                daily_cap: state.item_cap(&item),
                used: state.item_used(&item),
                item,
            })
            .collect(),
        catering: CateringView {
            capacity: state.catering_capacity(),
            taken: sat(state.catering_taken()),
        },
        bake_list: BakeListView {
            version: state.plan().version,
            lines: state
                .plan()
                .lines
                .iter()
                .map(|l| BakeLineView {
                    item: l.item.clone(),
                    qty: l.qty,
                    start: l.start.to_string(),
                })
                .collect(),
        },
        menu_version: state.menu_version(),
    }
}

fn hold_view(state: &ScheduleState, reference: Option<Ulid>) -> Option<HoldView> {
    let h = state.hold(reference?)?;
    Some(HoldView {
        reference: h.reference,
        kind: h.kind,
        start: h.start,
        expires_at: h.expires_at,
        status: h.status,
    })
}

/// The hold an order asks for at placement: its slot's day, the kind its order kind takes, its
/// start and zone, and its lines summed per item through the menu (a variant the menu does not
/// list is left out; the Order refuses it). Keyed by the order id.
pub fn hold_for_order(
    order: Ulid,
    kind: OrderKind,
    slot: BusinessTime,
    zone: Option<String>,
    lines: &[LineInput],
    menu: &MenuView,
    expires_at: BusinessTime,
) -> HoldRequest {
    let items = lines.iter().filter_map(|l| {
        menu.variant(&l.variant).map(|(item, _)| ItemQty {
            item: item.slug.clone(),
            qty: u32::from(l.qty),
        })
    });
    HoldRequest {
        reference: order,
        kind: HoldKind::for_order(kind),
        start: slot,
        zone,
        lines: normalize_lines(items),
        expires_at,
    }
}

/// What a hold at placement came to.
#[derive(Debug, Clone)]
pub enum HoldAnswer {
    /// Held now, or held already under this key: the place as it now stands.
    Held(HoldView),
    /// A capacity rule refused it.
    Refused(Refusal),
    /// The key was used with another body.
    KeyReused,
    /// The sandbox is gone.
    Gone,
}

/// Holds the place for an order before its `/_place`: `hold:<key>` is the command's key, and
/// the client's body its hash, so a retry finds the first hold, even after the clock moved.
pub async fn hold(
    env: &Env,
    birth: &Birth,
    key: &str,
    body_hash: &str,
    request: HoldRequest,
    cause: Option<String>,
) -> Result<HoldAnswer> {
    let mut res = sql::call(
        env,
        BINDING,
        &birth.name,
        Method::Post,
        "/_command",
        Some(&CommandIn {
            key: format!("hold:{key}"),
            body_hash: body_hash.to_owned(),
            birth: Some(birth.clone()),
            cmd: Cmd::Hold(request.clone()),
            cause,
        }),
    )
    .await?;
    let status = res.status_code();
    let text = res.text().await?;
    match status {
        200 => {
            let answer: Answer = serde_json::from_str(&text)?;
            Ok(HoldAnswer::Held(answer.hold.unwrap_or(HoldView {
                reference: request.reference,
                kind: request.kind,
                start: request.start,
                expires_at: request.expires_at,
                status: HoldStatus::Held,
            })))
        }
        410 => Ok(HoldAnswer::Gone),
        422 => {
            let refusal: Refusal = serde_json::from_str(&text).unwrap_or_default();
            if refusal.error == "key-reused" {
                Ok(HoldAnswer::KeyReused)
            } else {
                Ok(HoldAnswer::Refused(refusal))
            }
        }
        other => Err(Error::RustError(format!("schedule hold answered {other}"))),
    }
}

/// Gives back a place whose order was refused after its hold: `Release {cancelled}` under
/// `release:<key>`. Best effort: a release that does not land leaves the hold to its own timer.
pub async fn release(env: &Env, schedule: &str, key: &str, reference: Ulid) {
    let res = sql::call(
        env,
        BINDING,
        schedule,
        Method::Post,
        "/_command",
        Some(&CommandIn {
            key: format!("release:{key}"),
            body_hash: String::new(),
            birth: None,
            cmd: Cmd::Release {
                reference,
                reason: ReleaseReason::Cancelled,
            },
            cause: None,
        }),
    )
    .await;
    let status = res.map_or(0, |r| r.status_code());
    if status != 200 {
        console_log!("{{\"event\":\"hold_release_error\",\"status\":{status}}}");
    }
}

/// The caps a published menu gives every day: each listed item's `daily_cap`.
pub fn caps_of(menu: &MenuView) -> Vec<ItemCap> {
    menu.categories
        .iter()
        .flat_map(|c| &c.items)
        .map(|i| ItemCap {
            item: i.slug.clone(),
            daily_cap: i.daily_cap,
        })
        .collect()
}

#[durable_object]
pub struct Schedule {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Schedule {
    fn new(state: State, env: Env) -> Self {
        Schedule {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_open") => {
                let body: Open = sql::body(&mut req).await?;
                self.open(body.birth, now).await
            }
            (Method::Post, "/_seed") => {
                let body: SeedSchedule = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_command") => {
                let body: CommandIn = sql::body(&mut req).await?;
                self.command(body, now).await
            }
            (Method::Post, "/_wipe") => json(&child::wipe(&self.state).await?, 200),
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Get, "/_state") => {
                        let (state, _) = self.load(&meta)?;
                        json(&response_of(&state), 200)
                    }
                    (Method::Post, "/_event") => {
                        let text = req.text().await?;
                        self.event(&meta, &text, now).await
                    }
                    (Method::Post, "/_clock") => {
                        let body: ClockUpdate = sql::body(&mut req).await?;
                        child::clock(&sql, &body)?;
                        stream::arm(&self.state.storage(), now).await?;
                        json(&serde_json::json!({ "clock_v": body.clock_v }), 200)
                    }
                    _ => refuse(404, "not-found"),
                }
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
        for timer in stream::due(&storage.sql(), now)? {
            match timer.purpose.as_str() {
                HOLD => self.expire_hold(&meta, &timer.id, now)?,
                OUTBOX => stream::outbox_timer(&storage, &self.env, now, CLASS).await?,
                BACKSTOP => {
                    console_log!("{{\"event\":\"backstop\",\"object\":\"{CLASS}\"}}");
                    child::wipe(&self.state).await?;
                    return Response::empty();
                }
                _ => stream::delete_timer(&storage.sql(), &timer.id)?,
            }
        }
        stream::rearm(&storage, now, CLASS).await?;
        Response::empty()
    }
}

/// What a decided command writes.
struct Write {
    birth: Birth,
    first_write: bool,
    last_seq: u64,
    events: Vec<ScheduleEvent>,
    state: ScheduleState,
    at: BusinessTime,
    cause: Option<String>,
    /// The command's key, body hash and stored answer.
    key: Option<(String, String, String)>,
    /// A consumed event's id.
    seen: Option<String>,
}

impl Schedule {
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

    fn date(name: &str) -> Result<BakeryDate> {
        date_of(name).ok_or_else(|| Error::RustError("a schedule name with no date".into()))
    }

    fn birth_of(meta: &child::Meta) -> Result<Birth> {
        Ok(Birth {
            sandbox: meta.sandbox_id()?,
            name: meta.name.clone(),
            clock_offset_s: meta.clock_offset_s,
            clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
        })
    }

    /// The day's state, folded from its stream, and the stream's last `seq`.
    fn load(&self, meta: &child::Meta) -> Result<(ScheduleState, u64)> {
        let date = Self::date(&meta.name)?;
        if !sql::has_table(&self.sql(), "events")? {
            return Ok((ScheduleState::new(date), 0));
        }
        let envelopes = stream::events(&self.sql(), meta.sandbox_id()?, &meta.name)?;
        let decoded: Vec<ScheduleEvent> = envelopes
            .iter()
            .map(ScheduleEvent::from_envelope)
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| Error::RustError(e.to_string()))?;
        let last = envelopes.last().map_or(0, |e| e.seq);
        Ok((
            replay_from::<Aggregate>(ScheduleState::new(date), &decoded),
            last,
        ))
    }

    /// The day as it stands, created with its defaults if it was not yet.
    async fn open(&self, birth: Birth, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if let Some(meta) = child::meta(&sql)? {
            let (state, _) = self.load(&meta)?;
            return json(&response_of(&state), 200);
        }
        let date = Self::date(&birth.name)?;
        self.ensure_schema()?;
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)
        })?;
        stream::arm(&self.state.storage(), now).await?;
        json(&response_of(&ScheduleState::new(date)), 200)
    }

    /// The seed's commands for this day, decided one by one against the state so far and
    /// written together.
    async fn seed(&self, s: SeedSchedule, now: WallTime) -> Result<Response> {
        if let Some(meta) = child::meta(&self.sql())? {
            let (state, _) = self.load(&meta)?;
            return json(&response_of(&state), 200);
        }
        let date = Self::date(&s.birth.name)?;
        let ctx = DecideContext {
            now: business_at(now, s.birth.clock_offset_s),
            id: random::ulid(now)?,
        };
        let mut state = ScheduleState::new(date);
        let mut events = Vec::new();
        for cmd in &s.cmds {
            match execute::<Aggregate>(state.clone(), &cmd.domain(), &ctx) {
                Ok((next, mut more)) => {
                    state = next;
                    events.append(&mut more);
                }
                Err(e) => console_log!(
                    "{{\"event\":\"seed_schedule_refused\",\"object\":\"{CLASS}\",\"rule\":\"{}\"}}",
                    e.rule()
                ),
            }
        }
        self.ensure_schema()?;
        let answer = response_of(&state);
        self.write(
            Write {
                birth: s.birth,
                first_write: true,
                last_seq: 0,
                events,
                state,
                at: ctx.now,
                cause: None,
                key: None,
                seen: None,
            },
            now,
        )
        .await?;
        json(&answer, 201)
    }

    async fn command(&self, c: CommandIn, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let meta = child::meta(&sql)?;
        let (birth, first_write) = match (&meta, &c.birth) {
            (Some(m), Some(b)) if m.name != b.name || m.sandbox != b.sandbox.to_string() => {
                return refuse(409, "identity");
            }
            (Some(m), _) => (Self::birth_of(m)?, false),
            (None, Some(b)) => (b.clone(), true),
            (None, None) => return gone(),
        };
        if !first_write {
            let seen = stream::seen(&sql, &c.key)?;
            match check_command(seen.as_ref(), &c.body_hash) {
                Ok(CommandCheck::Replay(result)) => return replayed(result),
                Ok(CommandCheck::Fresh) => {}
                Err(_) => return refuse(422, "key-reused"),
            }
        }
        let (state, last_seq) = match &meta {
            Some(m) => self.load(m)?,
            None => (ScheduleState::new(Self::date(&birth.name)?), 0),
        };
        let id: Ulid = c
            .key
            .rsplit(':')
            .next()
            .and_then(|k| k.parse().ok())
            .map_or_else(|| random::ulid(now), Ok)?;
        let ctx = DecideContext {
            now: business_at(now, birth.clock_offset_s),
            id,
        };
        let (state, events) = match execute::<Aggregate>(state, &c.cmd.domain(), &ctx) {
            Ok(done) => done,
            Err(e) => return json(&Refusal::of(&e), 422),
        };
        let answer = Answer {
            events: events.iter().map(|e| e.name().to_owned()).collect(),
            hold: hold_view(&state, c.cmd.reference()),
            schedule: response_of(&state),
        };
        let stored = serde_json::to_string(&answer)?;
        if first_write {
            self.ensure_schema()?;
        }
        self.write(
            Write {
                birth,
                first_write,
                last_seq,
                events,
                state,
                at: ctx.now,
                cause: Some(c.cause.clone().unwrap_or_else(|| c.key.clone())),
                key: Some((c.key.clone(), c.body_hash.clone(), stored.clone())),
                seen: None,
            },
            now,
        )
        .await?;
        let mut out = Response::ok(stored)?;
        out.headers_mut().set("Content-Type", "application/json")?;
        Ok(out)
    }

    /// One delivery from the consumer.
    async fn event(&self, meta: &child::Meta, text: &str, now: WallTime) -> Result<Response> {
        let Ok(envelope) = serde_json::from_str::<Envelope>(text) else {
            return refuse(422, "envelope");
        };
        if envelope.sandbox.to_string() != meta.sandbox {
            return refuse(422, "envelope");
        }
        let sql = self.sql();
        #[derive(Deserialize)]
        struct IdRow {
            #[allow(dead_code)]
            id: String,
        }
        let seen: Vec<IdRow> = rows(
            &sql,
            "SELECT id FROM seen WHERE id = ?",
            vec![envelope.id.to_string().into()],
        )?;
        if !seen.is_empty() {
            return json(&serde_json::json!({ "outcome": "duplicate" }), 200);
        }
        let order = || place_of(&envelope, "order");
        let catering = || place_of(&envelope, "catering");
        let cmd = match envelope.event_type.as_str() {
            "OrderPaid" => order().map(|reference| ScheduleCommand::Confirm { reference }),
            "OrderExpired" => order().map(|reference| ScheduleCommand::Release {
                reference,
                reason: ReleaseReason::Expired,
            }),
            "OrderCancelled" => order().map(|reference| ScheduleCommand::Release {
                reference,
                reason: ReleaseReason::Cancelled,
            }),
            "OrderClosed" => order().map(|reference| ScheduleCommand::Fulfil { reference }),
            "CateringDepositPaid" => {
                catering().map(|reference| ScheduleCommand::Confirm { reference })
            }
            "CateringDepositLapsed" => catering().map(|reference| ScheduleCommand::Release {
                reference,
                reason: ReleaseReason::DepositLapsed,
            }),
            "CateringCancelled" => catering().map(|reference| ScheduleCommand::Release {
                reference,
                reason: ReleaseReason::Cancelled,
            }),
            "CateringClosed" => catering().map(|reference| ScheduleCommand::Fulfil { reference }),
            "MenuPublished" => {
                let menu = self.menu(meta.sandbox_id()?).await?;
                Some(ScheduleCommand::RefreshCaps {
                    menu_version: menu.version,
                    caps: caps_of(&menu),
                })
            }
            _ => return json(&serde_json::json!({ "outcome": "ignored" }), 200),
        };
        let Some(cmd) = cmd else {
            return refuse(422, "envelope");
        };
        let (state, last_seq) = self.load(meta)?;
        let ctx = DecideContext {
            now: meta.business(now),
            id: envelope.id,
        };
        let (state, events) = match execute::<Aggregate>(state, &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => {
                // An order this day never held, for one: a retry cannot change that.
                console_log!(
                    "{{\"event\":\"schedule_event_refused\",\"id\":\"{}\",\"type\":{:?},\"rule\":\"{}\"}}",
                    envelope.id,
                    envelope.event_type,
                    e.rule()
                );
                return json(
                    &serde_json::json!({ "outcome": "refused", "rule": e.rule() }),
                    200,
                );
            }
        };
        if events.is_empty() {
            return json(&serde_json::json!({ "outcome": "unchanged" }), 200);
        }
        self.write(
            Write {
                birth: Self::birth_of(meta)?,
                first_write: false,
                last_seq,
                events,
                state,
                at: ctx.now,
                cause: Some(envelope.id.to_string()),
                key: None,
                seen: Some(envelope.id.to_string()),
            },
            now,
        )
        .await?;
        json(&serde_json::json!({ "outcome": "applied" }), 200)
    }

    async fn menu(&self, sandbox: Ulid) -> Result<MenuView> {
        let mut res = sql::call_empty(
            &self.env,
            catalog::BINDING,
            &catalog::name(sandbox),
            Method::Get,
            "/_menu",
        )
        .await?;
        if res.status_code() != 200 {
            return Err(Error::RustError(format!(
                "catalog menu answered {}",
                res.status_code()
            )));
        }
        Ok(serde_json::from_str(&res.text().await?)?)
    }

    /// A hold timer fired: `Release {hold_expired}` when the hold is still unpaid and its
    /// business time has come. A timer whose wall time ran ahead of its business time (a
    /// stale offset) is set again from the business time; one for a place that is no longer
    /// held goes.
    fn expire_hold(&self, meta: &child::Meta, timer: &str, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let Some(reference) = timer
            .strip_prefix("hold:")
            .and_then(|r| r.parse::<Ulid>().ok())
        else {
            return stream::delete_timer(&sql, timer);
        };
        let (state, last_seq) = self.load(meta)?;
        let ctx = DecideContext {
            now: meta.business(now),
            id: random::ulid(now)?,
        };
        let cmd = ScheduleCommand::Release {
            reference,
            reason: ReleaseReason::HoldExpired,
        };
        let (state, events) = match execute::<Aggregate>(state, &cmd, &ctx) {
            Ok(done) => done,
            Err(_) => return stream::delete_timer(&sql, timer),
        };
        if events.is_empty() {
            return sync_timers(&sql, &state, meta.clock_offset_s, true);
        }
        console_log!("{{\"event\":\"hold_expired\",\"object\":\"{CLASS}\"}}");
        self.commit(
            Write {
                birth: Self::birth_of(meta)?,
                first_write: false,
                last_seq,
                events,
                state,
                at: ctx.now,
                cause: Some(timer.to_owned()),
                key: None,
                seen: None,
            },
            now,
        )?;
        stream::relay_after(&self.state, &self.env, now, CLASS)
    }

    /// The transaction, then the relay and the alarm. The alarm's own path commits and relays
    /// without arming, so its run's re-arm is the one the guard counts.
    async fn write(&self, w: Write, now: WallTime) -> Result<()> {
        let any = !w.events.is_empty();
        self.commit(w, now)?;
        if any {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await
        } else {
            stream::arm(&self.state.storage(), now).await
        }
    }

    /// One transaction: `meta` on the first write, the events and their outbox rows, the
    /// command's key with its answer, the consumed event's id, and the hold timers brought in
    /// line with the holds still waiting for payment.
    fn commit(&self, w: Write, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let head = StreamHead {
            sandbox: w.birth.sandbox,
            stream: w.birth.name.clone(),
            last_seq: w.last_seq,
        };
        let stamp = Stamp {
            at: w.at,
            recorded_at: now,
            cause: w.cause.clone(),
        };
        let mut ids = Vec::new();
        for _ in &w.events {
            ids.push(random::ulid(now)?);
        }
        let mut ids = ids.into_iter();
        let built = envelopes(&head, &stamp, &w.events, || {
            ids.next().unwrap_or(Ulid::from_parts(0, 0))
        })
        .map_err(|e| Error::RustError(e.to_string()))?;
        let offset = w.birth.clock_offset_s;
        transaction_sync(&self.state.storage(), move || {
            if w.first_write {
                child::born(&sql, &w.birth, now)?;
            }
            stream::append(&sql, &built)?;
            if let Some((key, hash, answer)) = &w.key {
                stream::remember(&sql, key, hash, answer, now)?;
            }
            if let Some(id) = &w.seen {
                exec(
                    &sql,
                    "INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)",
                    vec![id.as_str().into(), now.to_string().into()],
                )?;
            }
            // A first write knows no clock but its birth's; a later one the meta row's, which
            // `/_clock` keeps current.
            let offset = match child::meta(&sql)? {
                Some(m) => m.clock_offset_s,
                None => offset,
            };
            sync_timers(&sql, &w.state, offset, false)
        })
    }
}

/// The place an Order or CateringEvent stream names: `order:<sandbox>:<ulid>` or
/// `catering:<sandbox>:<ulid>`, as `class` asks, in the envelope's own sandbox.
fn place_of(envelope: &Envelope, class: &str) -> Option<Ulid> {
    let mut parts = envelope.stream.split(':');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(c), Some(sandbox), Some(id), None)
            if c == class && sandbox == envelope.sandbox.to_string() =>
        {
            id.parse().ok()
        }
        _ => None,
    }
}

/// The `hold:<ref>` timers as the held places need them: one per hold waiting for payment, at
/// its `expires_at`, the rest deleted. A timer whose business time is unchanged is left alone
/// (no row written) unless `recompute` asks for its wall time again.
fn sync_timers(
    sql: &SqlStorage,
    state: &ScheduleState,
    offset_s: i64,
    recompute: bool,
) -> Result<()> {
    let have: BTreeMap<String, Option<String>> = stream::timers(sql)?
        .into_iter()
        .filter(|t| t.purpose == HOLD)
        .map(|t| (t.id, t.due_business))
        .collect();
    let want: BTreeMap<String, BusinessTime> = state
        .held_expiries()
        .into_iter()
        .map(|(r, at)| (format!("{HOLD}:{r}"), at))
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
        stream::set_timer(sql, id, HOLD, wall_at(*at, offset_s), Some(&due))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_schedule_name_carries_its_day() {
        let sandbox = Ulid::from_parts(1, 1);
        let date = BakeryDate::new(2026, 11, 7).unwrap();
        let n = name(sandbox, date);
        assert_eq!(n, format!("schedule:{sandbox}:2026-11-07"));
        assert_eq!(date_of(&n), Some(date));
        assert_eq!(date_of("schedule:x"), None);
        assert_eq!(date_of(&format!("order:{sandbox}:2026-11-07")), None);
        assert_eq!(date_of(&format!("{n}:extra")), None);
    }

    #[test]
    fn commands_read_and_write_as_the_worker_sends_them() {
        let r = Ulid::from_parts(1, 2);
        let release: Cmd = serde_json::from_value(serde_json::json!({
            "cmd": "release", "ref": r.to_string(), "reason": "hold_expired"
        }))
        .unwrap();
        assert_eq!(
            release,
            Cmd::Release {
                reference: r,
                reason: ReleaseReason::HoldExpired
            }
        );
        let cap: Cmd = serde_json::from_value(serde_json::json!({
            "cmd": "set_capacity", "target": "slot:10:00", "capacity": 1
        }))
        .unwrap();
        assert_eq!(
            cap,
            Cmd::SetCapacity {
                target: Target::Slot(600),
                capacity: 1
            }
        );
        let at: BusinessTime = "2026-11-07T10:00:00-07:00".parse().unwrap();
        let hold = Cmd::Hold(HoldRequest {
            reference: r,
            kind: HoldKind::Slot,
            start: at,
            zone: None,
            lines: vec![ItemQty {
                item: "fern-loaf".into(),
                qty: 2,
            }],
            expires_at: at,
        });
        let text = serde_json::to_string(&hold).unwrap();
        assert!(text.contains("\"cmd\":\"hold\"") && text.contains("\"ref\""));
        assert_eq!(serde_json::from_str::<Cmd>(&text).unwrap(), hold);
    }

    #[test]
    fn a_day_shows_its_counts_saturated_and_its_free_places() {
        let date = BakeryDate::new(2026, 11, 7).unwrap();
        let state = ScheduleState::new(date);
        let r = response_of(&state);
        assert_eq!(r.date, "2026-11-07");
        assert!(r.open);
        assert_eq!(r.slots.len(), 32);
        assert_eq!(r.slots[0].start, "2026-11-07T07:00:00-07:00");
        assert!(r.slots.iter().all(|s| s.free == s.capacity && s.taken == 0));
        assert_eq!(r.zones.len(), 3);
        assert_eq!(r.zones[0].windows.len(), 3);
        assert_eq!(r.bake_list.version, 0);
        assert!(r.items.is_empty());
    }

    #[test]
    fn a_hold_sums_its_lines_per_item_through_the_menu() {
        let menu: MenuView = serde_json::from_value(serde_json::json!({
            "version": 1,
            "categories": [{ "slug": "breads", "name": "Breads", "items": [{
                "slug": "fern-loaf", "name": "Fern loaf", "allergens": [], "daily_cap": 30,
                "days_baked": ["tue","wed","thu","fri","sat","sun"], "season": null,
                "bulk_lead": null, "pickup_only": false, "status": "available",
                "variants": [
                    { "slug": "fern-loaf/whole", "label": "Whole", "price_cents": 900, "lead_minutes": 120 },
                    { "slug": "fern-loaf/half", "label": "Half", "price_cents": 500, "lead_minutes": 120 }
                ]
            }]}]
        }))
        .unwrap();
        let at: BusinessTime = "2026-11-07T10:00:00-07:00".parse().unwrap();
        let lines = [
            LineInput {
                variant: "fern-loaf/whole".into(),
                qty: 2,
            },
            LineInput {
                variant: "fern-loaf/half".into(),
                qty: 1,
            },
            LineInput {
                variant: "no-such/thing".into(),
                qty: 4,
            },
        ];
        let h = hold_for_order(
            Ulid::from_parts(1, 3),
            OrderKind::Pickup,
            at,
            None,
            &lines,
            &menu,
            at,
        );
        assert_eq!(h.kind, HoldKind::Slot);
        assert_eq!(
            h.lines,
            vec![ItemQty {
                item: "fern-loaf".into(),
                qty: 3
            }]
        );
        assert_eq!(caps_of(&menu)[0].daily_cap, 30);
    }

    #[test]
    fn an_order_stream_names_its_order_only_in_its_own_sandbox() {
        let sandbox = Ulid::from_parts(1, 1);
        let order = Ulid::from_parts(1, 2);
        let mut e: Envelope = serde_json::from_value(serde_json::json!({
            "v": 1, "id": Ulid::from_parts(1, 9).to_string(), "sandbox": sandbox.to_string(),
            "stream": format!("order:{sandbox}:{order}"), "seq": 2, "type": "OrderPaid",
            "at": "2026-11-07T09:00:00-07:00", "recorded_at": "2026-11-07T16:00:00.000Z",
            "data": {}, "cause": null
        }))
        .unwrap();
        assert_eq!(place_of(&e, "order"), Some(order));
        assert_eq!(place_of(&e, "catering"), None);
        e.stream = format!("catering:{sandbox}:{order}");
        assert_eq!(place_of(&e, "catering"), Some(order));
        e.stream = format!("order:{order}:{order}");
        assert_eq!(place_of(&e, "order"), None);
        e.stream = format!("catalog:{sandbox}");
        assert_eq!(place_of(&e, "order"), None);
    }
}
