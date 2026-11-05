//! `Inbox`, one per sandbox, named `inbox:<sandbox>` (docs/domain.md, "Ubiquitous language":
//! Message, Inbox; docs/architecture.md, "A campaign send"). Every message the bakery "sends"
//! lands here: the system holds no address (Q22), so a message is a row, and its opens and clicks
//! are simulated by this object's alarms from the seed (`inbox::engagement`).
//!
//! The domain's `Inbox` decides: which messages an event makes, and the opens and clicks. The
//! object keeps its messages in the `messages` table, one row each, and the rest of the domain's
//! state (the order and catering facts its templates need, the event ids seen) in one `inbox`
//! row, so a delivery reads and writes the facts and the new rows, never every message.
//!
//! Paths (the Worker builds them):
//!
//! - `POST /_seed {birth, seed, messages}` → 201; 200 when already seeded: the seed's 240
//!   receipts, with an engagement timer for each open or click still ahead of birth.
//! - `POST /_event` with an envelope, from the consumer → 200 `{outcome, messages}`: each new
//!   message with its `MessageDelivered` appended to the Inbox's own log and outbox in the
//!   transaction that records the consumed id (ADR 0004, decision 8), and its engagement
//!   timers; `duplicate` for an id seen; `ignored` for an event that makes none. 503
//!   `{error: "unknown-ref"}` for a message about an order or a catering event whose first event
//!   has not arrived (the consumer retries); 503 `{error: "fault"}` while the `inbox` fault is
//!   on, as a broken subscriber would; 422 `{error: "envelope"}` for one that cannot be read.
//! - `POST /_learn {envelopes}` → 200: the seeded catering events' own events (which no outbox
//!   relays), read for their facts only: they make no message, since the seed's messages are
//!   its history.
//! - `POST /_fault {on}` → 200: the Sandbox's switch, copied here.
//! - `GET /_messages?kind=&to=&limit=` → 200 `InboxResponse`, newest first, `total` the count
//!   the filters match; `GET /_message/<id>` → 200 `MessageResponse`, 404 for none.
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs). The wipe deletes everything.
//!
//! Timers: `open:<message>` and `click:<message>`, purpose `engage`, in business time: the alarm
//! records each as `RecordOpen` or `RecordClick` at its own business time, idempotently, and
//! relays `MessageOpened` and `MessageClicked` (Crm's campaign stats). `outbox` and `backstop`
//! as every child.
//!
//! Log lines carry ids, kinds and counts; never a subject or a body.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_contracts::{InboxResponse, MessageResponse};
use bakery_domain::calendar::plus_elapsed_minutes;
use bakery_domain::inbox::{
    Inbox as Domain, InboxChange, InboxCommand, InboxError, InboxEvent, Message, MessageKind,
    engagement,
};
use bakery_domain::outbox::{Stamp, StreamHead, envelopes};
use bakery_domain::{BusinessTime, Envelope, Ulid, WallTime};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::sql::{self, exec, first, gone, json, refuse, rows, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::{SystemClock, wall_at};
use crate::random;

pub const BINDING: &str = "INBOX";
pub const CLASS: &str = "Inbox";
/// An engagement timer's purpose; its id is `open:<message>` or `click:<message>`.
const ENGAGE: &str = "engage";
/// Engagement timers recorded per alarm run; what is left re-arms for now.
const ENGAGE_BATCH: usize = 200;
/// A page of the inbox: the default and the largest.
const PAGE_DEFAULT: usize = 50;
const PAGE_MAX: usize = 500;

pub fn name(sandbox: Ulid) -> String {
    format!("inbox:{sandbox}")
}

const SCHEMA: &[&str] = &[
    child::META,
    // The domain's state but its messages: the facts and the ids seen, the sandbox's seed (for
    // the engagement draw) and the fault switch.
    "CREATE TABLE IF NOT EXISTS inbox (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       seed INTEGER NOT NULL,
       body TEXT NOT NULL,
       fault INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS messages (
       id TEXT PRIMARY KEY,
       recipient TEXT NOT NULL,
       kind TEXT NOT NULL,
       delivered_ms INTEGER NOT NULL,
       body TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS messages_by_time ON messages (delivered_ms DESC, id DESC)",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedInbox {
    pub birth: Birth,
    /// The sandbox's seed: the engagement draw's.
    pub seed: u64,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnIn {
    pub envelopes: Vec<Envelope>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FaultSwitch {
    pub on: bool,
}

/// The domain's state with its messages left out: what the `inbox` row holds.
fn without_messages(inbox: &Domain) -> Result<String> {
    let mut v = serde_json::to_value(inbox)?;
    if let Some(m) = v.get_mut("messages") {
        *m = serde_json::Value::Object(serde_json::Map::new());
    }
    Ok(serde_json::to_string(&v)?)
}

/// The engagement timers a message needs at `now`: its open and its click, each when the seed
/// draws one and it has not been recorded.
pub fn engagement_timers(seed: u64, m: &Message) -> Vec<(String, BusinessTime)> {
    let e = engagement(seed, m.id);
    let at = |minutes: Option<u32>| {
        minutes.and_then(|n| plus_elapsed_minutes(m.delivered_at, i64::from(n)).ok())
    };
    let mut out = Vec::new();
    if let (None, Some(t)) = (m.opened_at, at(e.opens_after)) {
        out.push((format!("open:{}", m.id), t));
    }
    if let (None, Some(t)) = (m.clicked_at, at(e.clicks_after)) {
        out.push((format!("click:{}", m.id), t));
    }
    out
}

fn kind_text(kind: MessageKind) -> &'static str {
    kind.as_str()
}

/// A message as the API shows it.
pub fn message_response(m: &Message) -> Result<MessageResponse> {
    Ok(MessageResponse {
        message: m.id.to_string(),
        to: m.to.to_string(),
        kind: serde_json::from_value(serde_json::to_value(m.kind)?)?,
        reference: m.reference.to_string(),
        subject: m.subject.clone(),
        body: m.body.clone(),
        delivered_at: m.delivered_at.to_string(),
        opened_at: m.opened_at.map(|t| t.to_string()),
        clicked_at: m.clicked_at.map(|t| t.to_string()),
    })
}

/// The inbox's filters, read from a query string: `kind`, `to`, `limit`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Filters {
    pub kind: Option<MessageKind>,
    pub to: Option<Ulid>,
    pub limit: usize,
}

/// `None` for a filter that names no kind or no ULID: the router's 400.
pub fn filters_of(query: Option<&str>) -> Option<Filters> {
    let mut f = Filters {
        limit: PAGE_DEFAULT,
        ..Filters::default()
    };
    for kv in query.unwrap_or("").split('&').filter(|kv| !kv.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        match k {
            "kind" if !v.is_empty() => {
                f.kind = Some(serde_json::from_value(serde_json::Value::from(v)).ok()?);
            }
            "to" if !v.is_empty() => f.to = Some(v.parse().ok()?),
            "limit" => {
                f.limit = v.parse::<usize>().ok()?.clamp(1, PAGE_MAX);
            }
            _ => {}
        }
    }
    Some(f)
}

#[derive(Deserialize)]
struct InboxRow {
    seed: i64,
    body: String,
    fault: i64,
}

#[derive(Deserialize)]
struct MessageRow {
    body: String,
}

#[durable_object]
pub struct Inbox {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Inbox {
    fn new(state: State, env: Env) -> Self {
        Inbox {
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
                let body: SeedInbox = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_wipe") => json(&child::wipe(&self.state).await?, 200),
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Post, "/_event") => {
                        let text = req.text().await?;
                        self.event(&meta, &text, now).await
                    }
                    (Method::Post, "/_learn") => {
                        let body: LearnIn = sql::body(&mut req).await?;
                        self.learn(body.envelopes)
                    }
                    (Method::Post, "/_fault") => {
                        let body: FaultSwitch = sql::body(&mut req).await?;
                        exec(
                            &sql,
                            "UPDATE inbox SET fault = ?",
                            vec![i64::from(body.on).into()],
                        )?;
                        json(&serde_json::json!({ "inbox": body.on }), 200)
                    }
                    (Method::Get, "/_messages") => {
                        let query = req.url()?.query().map(str::to_owned);
                        match filters_of(query.as_deref()) {
                            Some(f) => json(&self.list(&f)?, 200),
                            None => refuse(400, "filter"),
                        }
                    }
                    (Method::Get, p) if p.starts_with("/_message/") => {
                        let id: Option<Ulid> = p["/_message/".len()..].parse().ok();
                        match id.map(|i| self.message(i)).transpose()?.flatten() {
                            Some(m) => json(&message_response(&m)?, 200),
                            None => refuse(404, "unknown-message"),
                        }
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
        let due = stream::due(&storage.sql(), now)?;
        let mut engage = Vec::new();
        for timer in due {
            match timer.purpose.as_str() {
                ENGAGE => engage.push(timer),
                OUTBOX => stream::outbox_timer(&storage, &self.env, now, CLASS).await?,
                BACKSTOP => {
                    console_log!("{{\"event\":\"backstop\",\"object\":\"{CLASS}\"}}");
                    child::wipe(&self.state).await?;
                    return Response::empty();
                }
                _ => stream::delete_timer(&storage.sql(), &timer.id)?,
            }
        }
        if !engage.is_empty() {
            engage.truncate(ENGAGE_BATCH);
            self.engage(&meta, &engage, now)?;
        }
        stream::rearm(&storage, now, CLASS).await?;
        Response::empty()
    }
}

impl Inbox {
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

    fn row(&self) -> Result<(Domain, u64, bool)> {
        let row: Option<InboxRow> =
            first(&self.sql(), "SELECT seed, body, fault FROM inbox", vec![])?;
        let row = row.ok_or_else(|| Error::RustError("inbox has no state row".into()))?;
        Ok((
            serde_json::from_str(&row.body)?,
            u64::try_from(row.seed).unwrap_or(0),
            row.fault != 0,
        ))
    }

    fn message(&self, id: Ulid) -> Result<Option<Message>> {
        let row: Option<MessageRow> = first(
            &self.sql(),
            "SELECT body FROM messages WHERE id = ?",
            vec![id.to_string().into()],
        )?;
        row.map(|r| Ok(serde_json::from_str(&r.body)?)).transpose()
    }

    fn list(&self, f: &Filters) -> Result<InboxResponse> {
        let mut clauses = Vec::new();
        let mut params: Vec<worker::SqlStorageValue> = Vec::new();
        if let Some(k) = f.kind {
            clauses.push("kind = ?");
            params.push(kind_text(k).into());
        }
        if let Some(to) = f.to {
            clauses.push("recipient = ?");
            params.push(to.to_string().into());
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        #[derive(Deserialize)]
        struct N {
            n: i64,
        }
        let total: Option<N> = first(
            &self.sql(),
            &format!("SELECT count(*) AS n FROM messages{filter}"),
            params.clone(),
        )?;
        let mut page = params;
        page.push(i64::try_from(f.limit).unwrap_or(50).into());
        let found: Vec<MessageRow> = rows(
            &self.sql(),
            &format!(
                "SELECT body FROM messages{filter} ORDER BY delivered_ms DESC, id DESC LIMIT ?"
            ),
            page,
        )?;
        let messages = found
            .iter()
            .map(|r| {
                let m: Message = serde_json::from_str(&r.body)?;
                message_response(&m)
            })
            .collect::<Result<_>>()?;
        Ok(InboxResponse {
            messages,
            total: u32::try_from(total.map_or(0, |t| t.n)).unwrap_or(u32::MAX),
        })
    }

    async fn seed(&self, s: SeedInbox, now: WallTime) -> Result<Response> {
        if child::meta(&self.sql())?.is_some() {
            return json(&serde_json::json!({ "seeded": true }), 200);
        }
        self.ensure_schema()?;
        let body = without_messages(&Domain::default())?;
        let seed = i64::try_from(s.seed).map_err(|_| Error::RustError("seed".into()))?;
        let sql = self.sql();
        let birth = s.birth;
        let messages = s.messages;
        let offset = birth.clock_offset_s;
        let n = messages.len();
        let timers: usize = messages
            .iter()
            .map(|m| engagement_timers(s.seed, m).len())
            .sum();
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)?;
            exec(
                &sql,
                "INSERT INTO inbox (id, seed, body, fault) VALUES (1, ?, ?, 0)",
                vec![seed.into(), body.into()],
            )?;
            for m in &messages {
                insert_message(&sql, m)?;
                arm_engagement(&sql, u64::try_from(seed).unwrap_or(0), m, offset)?;
            }
            Ok(())
        })?;
        stream::arm(&self.state.storage(), now).await?;
        console_log!(
            "{{\"event\":\"inbox_seeded\",\"object\":\"{CLASS}\",\"messages\":{n},\"timers\":{timers}}}"
        );
        json(&serde_json::json!({ "seeded": true }), 201)
    }

    /// The seeded catering events' events, for their facts: the messages they would make are
    /// the seed's history and are not written.
    fn learn(&self, list: Vec<Envelope>) -> Result<Response> {
        let (mut inbox, _, _) = self.row()?;
        let mut learned = 0u32;
        for e in &list {
            if inbox.apply(e).is_ok() {
                learned += 1;
            }
        }
        let body = without_messages(&inbox)?;
        exec(&self.sql(), "UPDATE inbox SET body = ?", vec![body.into()])?;
        json(&serde_json::json!({ "learned": learned }), 200)
    }

    async fn event(&self, meta: &child::Meta, text: &str, now: WallTime) -> Result<Response> {
        let (mut inbox, seed, fault) = self.row()?;
        if fault {
            return refuse(503, "fault");
        }
        let Ok(envelope) = serde_json::from_str::<Envelope>(text) else {
            return refuse(422, "envelope");
        };
        if envelope.sandbox.to_string() != meta.sandbox {
            return refuse(422, "envelope");
        }
        let change = match inbox.apply(&envelope) {
            Ok(c) => c,
            Err(InboxError::UnknownRef(_)) => return refuse(503, "unknown-ref"),
            Err(e) => {
                let rule = match e {
                    InboxError::BadStream(_) => "bad-stream",
                    InboxError::Codec(_) => "codec",
                    _ => "other",
                };
                console_log!(
                    "{{\"event\":\"inbox_event_refused\",\"id\":\"{}\",\"type\":{:?},\"rule\":\"{rule}\"}}",
                    envelope.id,
                    envelope.event_type
                );
                return json(
                    &serde_json::json!({ "outcome": "refused", "rule": rule }),
                    200,
                );
            }
        };
        let (messages, events) = match change {
            InboxChange::Duplicate => {
                return json(&serde_json::json!({ "outcome": "duplicate" }), 200);
            }
            InboxChange::NotForInbox => (Vec::new(), Vec::new()),
            InboxChange::Applied { messages, events } => (messages, events),
        };
        // The domain's state here holds no messages, so it calls every one new: a message
        // already in the table (the same campaign carried twice) keeps its row and its event.
        let sql = self.sql();
        let mut fresh = Vec::new();
        let mut fresh_events = Vec::new();
        for (m, e) in messages.into_iter().zip(events) {
            if self.message(m.id)?.is_none() {
                fresh.push(m);
                fresh_events.push(e);
            }
        }
        let built = self.envelopes_of(meta, envelope.at, &envelope, &fresh_events, now)?;
        let body = without_messages(&inbox)?;
        let offset = meta.clock_offset_s;
        let n = fresh.len();
        let kinds: Vec<&'static str> = fresh.iter().map(|m| kind_text(m.kind)).collect();
        let any = !built.is_empty();
        transaction_sync(&self.state.storage(), move || {
            exec(&sql, "UPDATE inbox SET body = ?", vec![body.into()])?;
            for m in &fresh {
                insert_message(&sql, m)?;
                arm_engagement(&sql, seed, m, offset)?;
            }
            stream::append(&sql, &built)?;
            Ok(())
        })?;
        if any {
            console_log!(
                "{{\"event\":\"messages_delivered\",\"object\":\"{CLASS}\",\"cause\":\"{}\",\"messages\":{n},\"kinds\":{:?}}}",
                envelope.id,
                kinds.first().copied().unwrap_or("")
            );
            stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        } else {
            stream::arm(&self.state.storage(), now).await?;
        }
        json(
            &serde_json::json!({ "outcome": if n > 0 { "applied" } else { "ignored" }, "messages": n }),
            200,
        )
    }

    fn envelopes_of(
        &self,
        meta: &child::Meta,
        at: BusinessTime,
        cause: &Envelope,
        events: &[InboxEvent],
        now: WallTime,
    ) -> Result<Vec<Envelope>> {
        if events.is_empty() {
            return Ok(Vec::new());
        }
        let sandbox = meta.sandbox_id()?;
        let head = stream::head(&self.sql(), sandbox, &meta.name)?;
        let head = StreamHead {
            sandbox,
            stream: meta.name.clone(),
            last_seq: head.last_seq,
        };
        let stamp = Stamp {
            at,
            recorded_at: now,
            cause: Some(cause.id.to_string()),
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

    /// Due engagement timers, recorded in one transaction at each timer's own business time,
    /// the rows deleted with them: a second run finds no row, and a row whose message was
    /// recorded already records nothing.
    fn engage(&self, meta: &child::Meta, due: &[stream::Timer], now: WallTime) -> Result<()> {
        let sql = self.sql();
        let sandbox = meta.sandbox_id()?;
        let mut last = stream::head(&sql, sandbox, &meta.name)?.last_seq;
        let mut updated: Vec<Message> = Vec::new();
        let mut built: Vec<Envelope> = Vec::new();
        let mut opens = 0u32;
        let mut clicks = 0u32;
        for t in due {
            let (kind, id) = t.id.split_once(':').unwrap_or(("", ""));
            let Ok(id) = id.parse::<Ulid>() else { continue };
            let held = updated.iter().position(|m| m.id == id);
            let message = match held {
                Some(i) => Some(updated[i].clone()),
                None => self.message(id)?,
            };
            let Some(message) = message else { continue };
            let at: BusinessTime = t
                .due_business
                .as_deref()
                .and_then(|d| d.parse().ok())
                .unwrap_or_else(|| meta.business(now));
            let mut one = Domain::default();
            one.seed([message]);
            let cmd = match kind {
                "click" => InboxCommand::RecordClick { message: id },
                _ => InboxCommand::RecordOpen { message: id },
            };
            let events = one
                .handle(cmd, at)
                .map_err(|e| Error::RustError(e.to_string()))?;
            for e in &events {
                match e {
                    InboxEvent::MessageOpened { .. } => opens += 1,
                    InboxEvent::MessageClicked { .. } => clicks += 1,
                    InboxEvent::MessageDelivered { .. } => {}
                }
            }
            let head = StreamHead {
                sandbox,
                stream: meta.name.clone(),
                last_seq: last,
            };
            let stamp = Stamp {
                at,
                recorded_at: now,
                cause: Some(format!("timer:{}", t.id)),
            };
            let mut ids = Vec::new();
            for _ in &events {
                ids.push(random::ulid(now)?);
            }
            let mut ids = ids.into_iter();
            let more = envelopes(&head, &stamp, &events, || {
                ids.next().unwrap_or(Ulid::from_parts(0, 0))
            })
            .map_err(|e| Error::RustError(e.to_string()))?;
            last = more.last().map_or(last, |e| e.seq);
            built.extend(more);
            let after = one
                .message(id)
                .cloned()
                .ok_or_else(|| Error::RustError("an engaged message is missing".into()))?;
            match held {
                Some(i) => updated[i] = after,
                None => updated.push(after),
            }
        }
        let ids: Vec<String> = due.iter().map(|t| t.id.clone()).collect();
        let any = !built.is_empty();
        transaction_sync(&self.state.storage(), move || {
            for m in &updated {
                exec(
                    &sql,
                    "UPDATE messages SET body = ? WHERE id = ?",
                    vec![serde_json::to_string(m)?.into(), m.id.to_string().into()],
                )?;
            }
            for id in &ids {
                stream::delete_timer(&sql, id)?;
            }
            stream::append(&sql, &built)?;
            Ok(())
        })?;
        if any {
            console_log!(
                "{{\"event\":\"engagement\",\"object\":\"{CLASS}\",\"opened\":{opens},\"clicked\":{clicks}}}"
            );
            stream::relay_after(&self.state, &self.env, now, CLASS)?;
        }
        Ok(())
    }
}

fn insert_message(sql: &SqlStorage, m: &Message) -> Result<()> {
    exec(
        sql,
        "INSERT OR IGNORE INTO messages (id, recipient, kind, delivered_ms, body)
         VALUES (?, ?, ?, ?, ?)",
        vec![
            m.id.to_string().into(),
            m.to.to_string().into(),
            kind_text(m.kind).into(),
            m.delivered_at.unix_ms().into(),
            serde_json::to_string(m)?.into(),
        ],
    )?;
    Ok(())
}

/// A message's engagement timers, in the caller's transaction, each at its business time.
fn arm_engagement(sql: &SqlStorage, seed: u64, m: &Message, offset_s: i64) -> Result<()> {
    for (id, at) in engagement_timers(seed, m) {
        stream::set_timer(
            sql,
            &id,
            ENGAGE,
            wall_at(at, offset_s),
            Some(&at.to_string()),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(n: u128) -> Message {
        Message {
            id: Ulid::from_parts(1_793_000_000_000, n),
            to: Ulid::from_parts(1_793_000_000_000, 1),
            kind: MessageKind::Campaign,
            reference: Ulid::from_parts(1_793_000_000_000, 2),
            subject: "s".into(),
            body: "b".into(),
            delivered_at: "2026-11-07T09:00:00-07:00".parse().unwrap(),
            opened_at: None,
            clicked_at: None,
        }
    }

    #[test]
    fn engagement_timers_follow_the_seed_and_skip_what_is_recorded() {
        let mut any_open = 0;
        let mut any_click = 0;
        for n in 0..400 {
            let m = message(n);
            let timers = engagement_timers(42, &m);
            assert_eq!(timers, engagement_timers(42, &m), "the same every time");
            let e = engagement(42, m.id);
            assert_eq!(
                timers.len(),
                usize::from(e.opens_after.is_some()) + usize::from(e.clicks_after.is_some())
            );
            for (id, at) in &timers {
                assert!(*at > m.delivered_at, "{id}");
            }
            any_open += usize::from(e.opens_after.is_some());
            any_click += usize::from(e.clicks_after.is_some());
            let mut opened = m.clone();
            opened.opened_at = Some(m.delivered_at);
            opened.clicked_at = Some(m.delivered_at);
            assert!(engagement_timers(42, &opened).is_empty());
        }
        assert!((140..=220).contains(&any_open), "{any_open}");
        assert!(any_click > 20, "{any_click}");
    }

    #[test]
    fn the_filters_read_kind_to_and_limit() {
        let f = filters_of(Some("kind=receipt&to=01JC8Z6K3W9QF2N4T7XRB5M0HD&limit=10")).unwrap();
        assert_eq!(f.kind, Some(MessageKind::Receipt));
        assert_eq!(f.to, Some("01JC8Z6K3W9QF2N4T7XRB5M0HD".parse().unwrap()));
        assert_eq!(f.limit, 10);
        assert_eq!(filters_of(None).unwrap().limit, PAGE_DEFAULT);
        assert_eq!(filters_of(Some("limit=100000")).unwrap().limit, PAGE_MAX);
        assert_eq!(
            filters_of(Some("kind=on_its_way")).unwrap().kind,
            Some(MessageKind::OnItsWay)
        );
        assert!(filters_of(Some("kind=letter")).is_none());
        assert!(filters_of(Some("to=nobody")).is_none());
    }

    #[test]
    fn the_state_row_holds_no_message() {
        let mut d = Domain::default();
        d.seed([message(1)]);
        let text = without_messages(&d).unwrap();
        let back: Domain = serde_json::from_str(&text).unwrap();
        assert!(back.messages().is_empty());
        assert!(!text.contains("\"subject\""));
    }
}
