//! `Recorder`, one per sandbox, named `recorder:<sandbox>`: the flight recorder, a small ring of
//! what the Queue's consumer did with each of the sandbox's events, and the sockets that watch it
//! (docs/architecture.md, "The flight recorder"; ADR 0015).
//!
//! The consumer feeds it after the fact and best effort: at the end of each batch it sends every
//! sandbox's Recorder one `/_record` with that sandbox's hops, after the messages are acked, and a
//! failure is one `trace_drop` log line and nothing else. Nothing in a command's path calls it. A
//! hop is identifiers, type names, sequence numbers and times (`bakery_contracts::TraceHop`):
//! never an event's `data`. It is its own object, not the Kitchen's job: observability gets its
//! own single writer, and no object becomes the hub for everything.
//!
//! Storage is bounded: one `batches` row per `/_record`, the hops as JSON, the oldest trimmed in
//! the same transaction once more than [`KEEP_BATCHES`] are kept; and a `retries` row for each
//! event whose last hop was not delivered everywhere, which is how the Recorder counts attempts:
//! `worker` 0.8.7 does not expose the Queue's attempt count (docs/architecture.md, "Dead
//! letters"), so an event's next hop is attempt `n + 1`, and a hop that still fails on the
//! fourth attempt, the Queue's last after 3 retries (wrangler.jsonc), is `dead_lettered`. The
//! count is as lossy as the recorder: a hop never recorded is not counted.
//!
//! Paths:
//!
//! - `POST /_seed {birth}` → 201; 200 when already seeded. An empty ring.
//! - `POST /_record {hops}` → 200 `{recorded, cursor}`: one batch row, its attempts counted, the
//!   ring trimmed, and a `hops` frame to every open socket.
//! - `GET /_trace?after=<cursor>` → 200 `TraceResponse`: the hops of the batches after the
//!   cursor, at most [`PAGE_BATCHES`] of them, oldest first.
//! - `GET /_ws` with `Upgrade: websocket` → 101: the socket, accepted on the Hibernation API. The
//!   router checked the session, the `Origin` and the sandbox first.
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs). The wipe says `bye` to every
//!   socket and closes it with 1001 first.
//!
//! The socket, protocol v1, JSON text frames (`bakery_contracts::TraceFrame`). Server to client:
//! `{t: "snapshot", v: 1, hops, cursor}` on open, the hops of the last [`PAGE_BATCHES`] batches;
//! `{t: "hops", v: 1, hops, cursor}` for each batch recorded after it; `{t: "bye", v: 1, reason:
//! "wiped" | "limit"}` before the server closes. Client to server: `{"t":"ping","v":1}` only,
//! answered `{"t":"pong","v":1}` by the platform's auto-response, which does not wake the object;
//! any other text frame is read for the limits and ignored. The limits are the kitchen socket's
//! (kitchen.rs): 4 open sockets a sandbox, frames of at most 4 KB, 10 frames a second, text only.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use bakery_app::Clock;
use bakery_app::routing::Subscriber;
use bakery_contracts::{
    TraceByeReason, TraceDelivery, TraceFrame, TraceHop, TraceOutcome, TraceResponse,
};
use bakery_domain::{Envelope, Ulid, WallTime};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair, console_log, durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::kitchen::{self, Closing, MAX_FRAME_BYTES, MAX_SOCKETS};
use super::sql::{self, exec, first, gone, json, refuse, rows, transaction_sync};
use super::stream::{self, BACKSTOP};
use crate::clock::SystemClock;
use crate::random;

pub const BINDING: &str = "RECORDER";
pub const CLASS: &str = "Recorder";

pub fn name(sandbox: Ulid) -> String {
    format!("recorder:{sandbox}")
}

/// The socket protocol's version, in every frame.
pub const PROTOCOL: u8 = 1;
/// Batches the ring keeps; an older one is deleted as a newer one is written.
pub const KEEP_BATCHES: i64 = 200;
/// Batches one `/_trace` answer or one snapshot carries at most.
pub const PAGE_BATCHES: i64 = 50;
/// The Queue's last attempt at a message: the first, then `max_retries` 3 (wrangler.jsonc).
pub const LAST_ATTEMPT: u32 = 4;

const SCHEMA: &[&str] = &[
    child::META,
    // One row per batch the consumer sent, its hops as JSON, newest the highest `seq`. No
    // AUTOINCREMENT: the trim never deletes the newest row, so a new `seq` is always past every
    // earlier one, and SQLite's sequence table would be one more row written per batch.
    "CREATE TABLE IF NOT EXISTS batches (
       seq INTEGER PRIMARY KEY,
       hops TEXT NOT NULL,
       recorded_at TEXT NOT NULL)",
    // The events whose last recorded hop was not delivered everywhere: their attempt so far.
    "CREATE TABLE IF NOT EXISTS retries (
       id TEXT PRIMARY KEY,
       attempt INTEGER NOT NULL)",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedRecorder {
    pub birth: Birth,
}

/// `POST /_record`: one batch's hops for this sandbox, from the consumer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordIn {
    pub hops: Vec<TraceHop>,
}

/// A socket's attachment, which survives hibernation: its own id, the key of its frame count.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Tag {
    id: String,
}

#[derive(Deserialize)]
struct BatchRow {
    seq: i64,
    hops: String,
}

#[derive(Deserialize)]
struct AttemptRow {
    attempt: i64,
}

#[derive(Deserialize)]
struct SeqRow {
    seq: Option<i64>,
}

// ---------- hops, attempts and pages (pure, tested natively) ----------

/// `delivered_at - recorded_at` in milliseconds, 0 when the clocks disagree.
pub fn lag_ms(recorded_at: WallTime, delivered_at: WallTime) -> u64 {
    u64::try_from(delivered_at.unix_ms() - recorded_at.unix_ms()).unwrap_or(0)
}

/// The hop the consumer records for one attempt at `envelope`: `routes` are the subscriber
/// classes `routing::deliver_to` named, in order; the first `delivered` of them answered, and
/// when `failed` the one after them did not, so it and every later one wait for the retry. The
/// envelope's `data` is not read: a hop carries none of it. The attempt is the Recorder's to
/// count, so it is 1 here.
pub fn hop(
    envelope: &Envelope,
    routes: &[Subscriber],
    delivered: usize,
    failed: bool,
    delivered_at: WallTime,
) -> TraceHop {
    let deliveries = routes
        .iter()
        .enumerate()
        .map(|(i, to)| TraceDelivery {
            to: to.class().to_owned(),
            outcome: if failed && i >= delivered {
                TraceOutcome::Retried
            } else {
                TraceOutcome::Delivered
            },
        })
        .collect();
    TraceHop {
        id: envelope.id.to_string(),
        event_type: envelope.event_type.clone(),
        stream: envelope.stream.clone(),
        seq: envelope.seq,
        cause: envelope.cause.clone(),
        at: envelope.at.to_string(),
        recorded_at: envelope.recorded_at.to_string(),
        delivered_at: delivered_at.to_string(),
        lag_ms: lag_ms(envelope.recorded_at, delivered_at),
        attempt: 1,
        deliveries,
    }
}

/// What the `retries` table must learn from one hop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Track {
    /// Not delivered everywhere: keep the attempt for the next hop.
    Remember(u32),
    /// Delivered at last, or dead-lettered: the event's count is done.
    Forget,
    /// A first attempt that was delivered: nothing to keep or delete.
    Nothing,
}

/// Counts the hop's attempt from the event's earlier one, if the Recorder holds it, and on the
/// Queue's last attempt turns `retried` into `dead_lettered`.
pub fn count_attempt(hop: &mut TraceHop, earlier: Option<u32>) -> Track {
    hop.attempt = earlier.map_or(1, |n| n.saturating_add(1));
    let failed = hop
        .deliveries
        .iter()
        .any(|d| d.outcome != TraceOutcome::Delivered);
    if failed && hop.attempt >= LAST_ATTEMPT {
        for d in &mut hop.deliveries {
            if d.outcome == TraceOutcome::Retried {
                d.outcome = TraceOutcome::DeadLettered;
            }
        }
        return Track::Forget;
    }
    match (failed, earlier) {
        (true, _) => Track::Remember(hop.attempt),
        (false, Some(_)) => Track::Forget,
        (false, None) => Track::Nothing,
    }
}

/// The highest `seq` a trim deletes once `newest` is written: everything at or below it, so the
/// ring keeps [`KEEP_BATCHES`] rows.
pub fn trim_through(newest: i64) -> i64 {
    newest - KEEP_BATCHES
}

/// `?after=<cursor>`: a non-negative integer; anything else reads as 0, the oldest kept.
pub fn after_of(query: Option<&str>) -> u64 {
    query
        .unwrap_or_default()
        .split('&')
        .find_map(|pair| pair.strip_prefix("after="))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// One `/_trace` answer from the batches after `after` (up to [`PAGE_BATCHES`] + 1 of them,
/// oldest first, so a full page knows there is more) and the oldest `seq` the ring still holds.
pub fn page(after: u64, batches: Vec<(u64, Vec<TraceHop>)>, oldest: Option<u64>) -> TraceResponse {
    let limit = usize::try_from(PAGE_BATCHES).unwrap_or(50);
    let more = batches.len() > limit;
    let mut cursor = after;
    let mut hops = Vec::new();
    for (seq, batch) in batches.into_iter().take(limit) {
        cursor = seq;
        hops.extend(batch);
    }
    TraceResponse {
        hops,
        cursor,
        more,
        missed: oldest.is_some_and(|o| o > after.saturating_add(1)),
    }
}

/// The `snapshot` frame: the ring's last batches, newest last.
pub fn snapshot_frame(hops: Vec<TraceHop>, cursor: u64) -> Result<String> {
    Ok(serde_json::to_string(&TraceFrame::Snapshot {
        v: PROTOCOL,
        hops,
        cursor,
    })?)
}

/// The `hops` frame: one batch, as it was recorded.
pub fn hops_frame(hops: Vec<TraceHop>, cursor: u64) -> Result<String> {
    Ok(serde_json::to_string(&TraceFrame::Hops {
        v: PROTOCOL,
        hops,
        cursor,
    })?)
}

/// The `bye` frame, as the kitchen socket's (`kitchen::bye_frame`), typed.
pub fn bye_frame(why: Closing) -> Result<String> {
    Ok(serde_json::to_string(&TraceFrame::Bye {
        v: PROTOCOL,
        reason: match why {
            Closing::Wiped => TraceByeReason::Wiped,
            _ => TraceByeReason::Limit,
        },
    })?)
}

/// `bye`, then the close frame.
fn close(ws: &WebSocket, why: Closing) {
    if let Ok(frame) = bye_frame(why) {
        let _ = ws.send_with_str(frame);
    }
    let _ = ws.close(Some(why.code()), Some(why.code_name()));
}

fn tag_of(ws: &WebSocket) -> Option<Tag> {
    let text: String = ws.deserialize_attachment().ok().flatten()?;
    serde_json::from_str(&text).ok()
}

fn read_batch(row: &BatchRow) -> (u64, Vec<TraceHop>) {
    (
        u64::try_from(row.seq).unwrap_or(0),
        serde_json::from_str(&row.hops).unwrap_or_default(),
    )
}

// ---------- the object ----------

#[durable_object]
pub struct Recorder {
    state: State,
    #[allow(dead_code)]
    env: Env,
    schema_ready: Cell<bool>,
    /// Frames each socket sent in the current second, by its id. Lost at a wake.
    frames: RefCell<HashMap<String, (i64, u32)>>,
}

impl DurableObject for Recorder {
    fn new(state: State, env: Env) -> Self {
        Recorder {
            state,
            env,
            schema_ready: Cell::new(false),
            frames: RefCell::new(HashMap::new()),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_seed") => {
                let body: SeedRecorder = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_wipe") => {
                self.close_all(Closing::Wiped);
                json(&child::wipe(&self.state).await?, 200)
            }
            (method, path) => {
                let sql = self.sql();
                if child::meta(&sql)?.is_none() {
                    return gone();
                }
                match (method, path) {
                    (Method::Post, "/_record") => {
                        let body: RecordIn = sql::body(&mut req).await?;
                        self.record(body, now)
                    }
                    (Method::Get, "/_trace") => {
                        let after = after_of(req.url()?.query());
                        json(&self.trace(after)?, 200)
                    }
                    (Method::Get, "/_ws") => self.upgrade(&req),
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
        if child::meta(&storage.sql())?.is_none() {
            storage.delete_all().await?;
            return Response::empty();
        }
        for timer in stream::due(&storage.sql(), now)? {
            if timer.purpose == BACKSTOP {
                console_log!("{{\"event\":\"backstop\",\"object\":\"{CLASS}\"}}");
                self.close_all(Closing::Wiped);
                child::wipe(&self.state).await?;
                return Response::empty();
            }
            // The Recorder emits no events and sets no other timer.
            stream::delete_timer(&storage.sql(), &timer.id)?;
        }
        stream::rearm(&storage, now, CLASS).await?;
        Response::empty()
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let Some(tag) = tag_of(&ws) else {
            close(&ws, Closing::TooMany);
            return Ok(());
        };
        let text = match message {
            WebSocketIncomingMessage::String(text) => text,
            WebSocketIncomingMessage::Binary(_) => {
                self.refuse_socket(&ws, &tag, Closing::Binary);
                return Ok(());
            }
        };
        let second = SystemClock::new().now_wall().unix_ms().div_euclid(1_000);
        let fast = {
            let mut frames = self.frames.borrow_mut();
            !kitchen::within_rate(frames.entry(tag.id.clone()).or_insert((second, 0)), second)
        };
        if fast {
            self.refuse_socket(&ws, &tag, Closing::TooFast);
            return Ok(());
        }
        if text.len() > MAX_FRAME_BYTES {
            self.refuse_socket(&ws, &tag, Closing::TooBig);
            return Ok(());
        }
        if child::meta(&self.sql())?.is_none() {
            close(&ws, Closing::Wiped);
        }
        // A read-only socket: a ping never reaches here, and anything else is ignored.
        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        if let Some(tag) = tag_of(&ws) {
            self.frames.borrow_mut().remove(&tag.id);
        }
        let _ = ws.close(Some(1000), Some("closed"));
        console_log!(
            "{{\"event\":\"recorder_socket_closed\",\"code\":{code},\"sockets\":{}}}",
            self.open_sockets().len()
        );
        Ok(())
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        if let Some(tag) = tag_of(&ws) {
            self.frames.borrow_mut().remove(&tag.id);
        }
        console_log!(
            "{{\"event\":\"recorder_socket_error\",\"sockets\":{}}}",
            self.open_sockets().len()
        );
        Ok(())
    }
}

impl Recorder {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn open_sockets(&self) -> Vec<WebSocket> {
        self.state
            .get_websockets()
            .into_iter()
            .filter(kitchen::is_open)
            .collect()
    }

    /// Every socket gets `bye` and its close: the wipe and the backstop.
    fn close_all(&self, why: Closing) {
        let sockets = self.state.get_websockets();
        for ws in &sockets {
            close(ws, why);
        }
        if !sockets.is_empty() {
            console_log!(
                "{{\"event\":\"recorder_sockets_closed\",\"reason\":\"{}\",\"sockets\":{}}}",
                why.code_name(),
                sockets.len()
            );
        }
    }

    fn refuse_socket(&self, ws: &WebSocket, tag: &Tag, why: Closing) {
        self.frames.borrow_mut().remove(&tag.id);
        console_log!(
            "{{\"event\":\"recorder_socket_refused\",\"reason\":\"{}\"}}",
            why.code_name()
        );
        close(ws, why);
    }

    async fn seed(&self, s: SeedRecorder, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if child::meta(&sql)?.is_some() {
            return json(&serde_json::json!({ "seeded": true }), 200);
        }
        if !self.schema_ready.get() {
            stream::create_schema(&sql, SCHEMA)?;
            self.schema_ready.set(true);
        }
        let birth = s.birth.clone();
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)
        })?;
        stream::arm(&self.state.storage(), now).await?;
        json(&serde_json::json!({ "seeded": true }), 201)
    }

    /// One batch: each hop's attempt counted from `retries`, the row written and the ring
    /// trimmed in one transaction, then the batch to every open socket.
    fn record(&self, body: RecordIn, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let mut hops = body.hops;
        let mut tracks = Vec::with_capacity(hops.len());
        for hop in &mut hops {
            let earlier: Option<AttemptRow> = first(
                &sql,
                "SELECT attempt FROM retries WHERE id = ?",
                vec![hop.id.as_str().into()],
            )?;
            let earlier = earlier.map(|r| u32::try_from(r.attempt).unwrap_or(u32::MAX));
            tracks.push((hop.id.clone(), count_attempt(hop, earlier)));
        }
        let text = serde_json::to_string(&hops)?;
        let n = hops.len();
        let write = sql.clone();
        let seq = transaction_sync(&self.state.storage(), move || {
            for (id, track) in &tracks {
                match track {
                    Track::Remember(attempt) => {
                        exec(
                            &write,
                            "INSERT INTO retries (id, attempt) VALUES (?, ?)
                             ON CONFLICT (id) DO UPDATE SET attempt = excluded.attempt",
                            vec![id.as_str().into(), i64::from(*attempt).into()],
                        )?;
                    }
                    Track::Forget => {
                        exec(
                            &write,
                            "DELETE FROM retries WHERE id = ?",
                            vec![id.as_str().into()],
                        )?;
                    }
                    Track::Nothing => {}
                }
            }
            exec(
                &write,
                "INSERT INTO batches (hops, recorded_at) VALUES (?, ?)",
                vec![text.into(), now.to_string().into()],
            )?;
            let newest: Option<SeqRow> =
                first(&write, "SELECT max(seq) AS seq FROM batches", vec![])?;
            let newest = newest.and_then(|r| r.seq).unwrap_or(0);
            exec(
                &write,
                "DELETE FROM batches WHERE seq <= ?",
                vec![trim_through(newest).into()],
            )?;
            Ok(newest)
        })?;
        let cursor = u64::try_from(seq).unwrap_or(0);
        let open = self.open_sockets();
        if !open.is_empty() {
            let frame = hops_frame(hops, cursor)?;
            kitchen::broadcast(&open, &frame);
        }
        json(&serde_json::json!({ "recorded": n, "cursor": cursor }), 200)
    }

    fn oldest(&self) -> Result<Option<u64>> {
        let oldest: Option<SeqRow> =
            first(&self.sql(), "SELECT min(seq) AS seq FROM batches", vec![])?;
        Ok(oldest
            .and_then(|r| r.seq)
            .and_then(|s| u64::try_from(s).ok()))
    }

    fn trace(&self, after: u64) -> Result<TraceResponse> {
        let found: Vec<BatchRow> = rows(
            &self.sql(),
            "SELECT seq, hops FROM batches WHERE seq > ? ORDER BY seq LIMIT ?",
            vec![
                i64::try_from(after).unwrap_or(i64::MAX).into(),
                (PAGE_BATCHES + 1).into(),
            ],
        )?;
        Ok(page(
            after,
            found.iter().map(read_batch).collect(),
            self.oldest()?,
        ))
    }

    /// The ring's last [`PAGE_BATCHES`] batches, newest last, and the newest one's cursor.
    fn recent(&self) -> Result<(Vec<TraceHop>, u64)> {
        let found: Vec<BatchRow> = rows(
            &self.sql(),
            "SELECT seq, hops FROM (SELECT seq, hops FROM batches ORDER BY seq DESC LIMIT ?)
             ORDER BY seq",
            vec![PAGE_BATCHES.into()],
        )?;
        let mut cursor = 0;
        let mut hops = Vec::new();
        for (seq, batch) in found.iter().map(read_batch) {
            cursor = seq;
            hops.extend(batch);
        }
        Ok((hops, cursor))
    }

    /// The upgrade, as the Kitchen's: accepted on the Hibernation API with the ping's
    /// auto-response, then the snapshot. A fifth socket is accepted only to be told why it is
    /// closed, which a refused upgrade could not say.
    fn upgrade(&self, req: &Request) -> Result<Response> {
        let upgrade = req.headers().get("Upgrade")?.unwrap_or_default();
        if !upgrade.eq_ignore_ascii_case("websocket") {
            return refuse(426, "upgrade");
        }
        let open = self.open_sockets();
        let pair = WebSocketPair::new()?;
        let server = pair.server;
        if open.len() >= MAX_SOCKETS {
            // Outside the Hibernation API, as the Kitchen does: a close on a hibernatable socket
            // before its 101 has gone out never reaches the client.
            console_log!(
                "{{\"event\":\"recorder_socket_refused\",\"reason\":\"{}\"}}",
                Closing::TooMany.code_name()
            );
            server.accept()?;
            close(&server, Closing::TooMany);
            return Response::from_websocket(pair.client);
        }
        self.state.accept_web_socket(&server);
        let pong =
            worker::worker_sys::WebSocketRequestResponsePair::new(kitchen::PING, kitchen::PONG)
                .map_err(|_| Error::RustError("auto-response pair".into()))?;
        self.state.set_websocket_auto_response(&pong);
        let tag = Tag {
            id: random::ulid(SystemClock::new().now_wall())?.to_string(),
        };
        server.serialize_attachment(serde_json::to_string(&tag)?)?;
        let (hops, cursor) = self.recent()?;
        server.send_with_str(snapshot_frame(hops, cursor)?)?;
        console_log!(
            "{{\"event\":\"recorder_socket_open\",\"sockets\":{}}}",
            open.len() + 1
        );
        Response::from_websocket(pair.client)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SANDBOX: &str = "01JC8YV2D4QK7S1M9E3PZ6W8AN";
    const ORDER: &str = "01JC8Z5R0T2B6Y8C4V1N3K7QXE";

    /// 2026-11-09T16:12:10Z and 318 ms, when the test's event was written.
    const WRITTEN_MS: i64 = 1_794_240_730_318;

    fn envelope() -> Envelope {
        Envelope {
            v: 1,
            id: "01JC8Z6K3W9QF2N4T7XRB5M0HD".parse().unwrap(),
            sandbox: SANDBOX.parse().unwrap(),
            stream: format!("order:{SANDBOX}:{ORDER}"),
            seq: 1,
            event_type: "OrderPlaced".into(),
            at: "2026-11-09T09:12:10-07:00".parse().unwrap(),
            recorded_at: WallTime::from_unix_ms(WRITTEN_MS).unwrap(),
            data: serde_json::json!({
                "note": "Two boxes, please", "customer": ORDER, "total_cents": 1870
            }),
            cause: Some("01JC8Z6F0WQ3E5R7T9Y1V3K5P7".into()),
        }
    }

    /// `ms` milliseconds after the test's event was written.
    fn after_ms(ms: i64) -> WallTime {
        WallTime::from_unix_ms(WRITTEN_MS + ms).unwrap()
    }

    #[test]
    fn a_hop_is_the_envelope_and_its_deliveries_with_no_data() {
        let e = envelope();
        let routes = [Subscriber::Kitchen, Subscriber::Crm, Subscriber::Inbox];
        let h = hop(&e, &routes, 3, false, after_ms(632));
        assert_eq!(h.id, e.id.to_string());
        assert_eq!(h.event_type, "OrderPlaced");
        assert_eq!(h.stream, e.stream);
        assert_eq!((h.seq, h.attempt, h.lag_ms), (1, 1, 632));
        assert_eq!(h.cause.as_deref(), Some("01JC8Z6F0WQ3E5R7T9Y1V3K5P7"));
        assert_eq!(h.at, "2026-11-09T09:12:10-07:00");
        assert_eq!(h.recorded_at, e.recorded_at.to_string());
        assert_eq!(h.delivered_at, after_ms(632).to_string());
        assert_eq!(
            h.deliveries
                .iter()
                .map(|d| (d.to.as_str(), d.outcome))
                .collect::<Vec<_>>(),
            [
                ("Kitchen", TraceOutcome::Delivered),
                ("Crm", TraceOutcome::Delivered),
                ("Inbox", TraceOutcome::Delivered)
            ]
        );
        // Nothing of the event's data reaches the hop, by name or by value.
        let text = serde_json::to_string(&h).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(value.get("data").is_none());
        for leak in ["Two boxes", "note", "total_cents", "1870"] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
    }

    #[test]
    fn a_failed_delivery_marks_it_and_every_later_subscriber_retried() {
        let routes = [Subscriber::Kitchen, Subscriber::Crm, Subscriber::Inbox];
        let h = hop(&envelope(), &routes, 1, true, after_ms(700));
        let outcomes: Vec<TraceOutcome> = h.deliveries.iter().map(|d| d.outcome).collect();
        assert_eq!(
            outcomes,
            [
                TraceOutcome::Delivered,
                TraceOutcome::Retried,
                TraceOutcome::Retried
            ]
        );
        // An event no class consumes is still a hop, with no deliveries.
        let none = hop(&envelope(), &[], 0, false, after_ms(700));
        assert!(none.deliveries.is_empty());
    }

    #[test]
    fn lag_is_clamped_at_zero() {
        assert_eq!(lag_ms(after_ms(0), after_ms(2_000)), 2_000);
        assert_eq!(
            lag_ms(after_ms(0), after_ms(-1_000)),
            0,
            "a delivery stamped before the write reads as no lag"
        );
    }

    #[test]
    fn attempts_count_up_and_the_fourth_failure_is_dead_lettered() {
        let routes = [Subscriber::Kitchen, Subscriber::Crm];
        let failing = || hop(&envelope(), &routes, 0, true, after_ms(700));
        let mut first = failing();
        assert_eq!(count_attempt(&mut first, None), Track::Remember(1));
        assert_eq!(first.attempt, 1);
        let mut third = failing();
        assert_eq!(count_attempt(&mut third, Some(2)), Track::Remember(3));
        assert!(
            third
                .deliveries
                .iter()
                .all(|d| d.outcome == TraceOutcome::Retried)
        );
        let mut last = failing();
        assert_eq!(count_attempt(&mut last, Some(3)), Track::Forget);
        assert_eq!(last.attempt, LAST_ATTEMPT);
        assert!(
            last.deliveries
                .iter()
                .all(|d| d.outcome == TraceOutcome::DeadLettered)
        );
        // Delivered on a retry: the count is done.
        let mut healed = hop(&envelope(), &routes, 2, false, after_ms(700));
        assert_eq!(count_attempt(&mut healed, Some(1)), Track::Forget);
        assert_eq!(healed.attempt, 2);
        // Delivered the first time: nothing to keep.
        let mut plain = hop(&envelope(), &routes, 2, false, after_ms(700));
        assert_eq!(count_attempt(&mut plain, None), Track::Nothing);
        assert_eq!(plain.attempt, 1);
    }

    #[test]
    fn the_ring_keeps_two_hundred_batches() {
        assert_eq!(trim_through(1), 1 - KEEP_BATCHES);
        assert_eq!(trim_through(200), 0, "the first 200 are all kept");
        assert_eq!(trim_through(201), 1, "the 201st drops the first");
        let kept = (1..=500_i64).filter(|s| *s > trim_through(500)).count();
        assert_eq!(kept, 200);
    }

    #[test]
    fn the_cursor_reads_after_and_pages_by_fifty() {
        assert_eq!(after_of(None), 0);
        assert_eq!(after_of(Some("after=42")), 42);
        assert_eq!(after_of(Some("x=1&after=7")), 7);
        assert_eq!(after_of(Some("after=-3")), 0);
        assert_eq!(after_of(Some("after=abc")), 0);
        let h = hop(&envelope(), &[], 0, false, after_ms(700));
        // Nothing new: the same cursor back.
        let empty = page(9, Vec::new(), Some(1));
        assert_eq!(
            (empty.hops.len(), empty.cursor, empty.more, empty.missed),
            (0, 9, false, false)
        );
        // Two batches after 3: both, newest last, the cursor the newest's.
        let two = page(
            3,
            vec![(4, vec![h.clone()]), (5, vec![h.clone(), h.clone()])],
            Some(1),
        );
        assert_eq!((two.hops.len(), two.cursor, two.more), (3, 5, false));
        // 51 batches: a page of 50 and `more`.
        let many: Vec<(u64, Vec<TraceHop>)> = (1..=51).map(|s| (s, vec![h.clone()])).collect();
        let full = page(0, many, Some(1));
        assert_eq!((full.hops.len(), full.cursor, full.more), (50, 50, true));
        // A cursor older than the ring: the gap is said.
        let late = page(2, vec![(10, vec![h.clone()])], Some(10));
        assert!(late.missed);
        assert!(!page(9, vec![(10, vec![h])], Some(10)).missed);
    }

    #[test]
    fn frames_are_protocol_v1() {
        let h = hop(&envelope(), &[Subscriber::Kitchen], 1, false, after_ms(700));
        let snap: serde_json::Value =
            serde_json::from_str(&snapshot_frame(vec![h.clone()], 4).unwrap()).unwrap();
        assert_eq!(
            (snap["t"].as_str(), snap["v"].as_u64()),
            (Some("snapshot"), Some(1))
        );
        assert_eq!(snap["cursor"], 4);
        assert_eq!(snap["hops"][0]["deliveries"][0]["to"], "Kitchen");
        assert!(snap["hops"][0].get("data").is_none());
        let batch: serde_json::Value =
            serde_json::from_str(&hops_frame(vec![h], 5).unwrap()).unwrap();
        assert_eq!(batch["t"], "hops");
        let bye: serde_json::Value =
            serde_json::from_str(&bye_frame(Closing::Wiped).unwrap()).unwrap();
        assert_eq!(
            (bye["t"].as_str(), bye["reason"].as_str()),
            (Some("bye"), Some("wiped"))
        );
        let limit: serde_json::Value =
            serde_json::from_str(&bye_frame(Closing::TooMany).unwrap()).unwrap();
        assert_eq!(limit["reason"], "limit");
        // The kitchen's bye says the same.
        let kitchen: serde_json::Value =
            serde_json::from_str(&kitchen::bye_frame(Closing::Wiped.bye())).unwrap();
        assert_eq!(kitchen, bye);
    }
}
