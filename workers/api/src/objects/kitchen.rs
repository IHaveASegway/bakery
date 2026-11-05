//! `Kitchen`, one per sandbox, named `kitchen:<sandbox>`: the kitchen board, a projection of
//! order events, and the sockets that watch it (docs/architecture.md, "Durable Object topology";
//! "The rules, restated for Rust", rule 2: the Hibernation API only).
//!
//! The board is the domain's `Board`, stored whole in one `board` row. Its own `seen` set and
//! its per-order `seq` heads are inside that row, so applying an event and recording its id are
//! one write: a redelivery changes nothing (ADR 0004, decision 3).
//!
//! Everything the Kitchen needs after it hibernates is in SQLite or on the socket: the board, the
//! last 64 command ids and the heartbeat in tables, and each socket's session kind and id in its
//! attachment, so a guest's command is refused after a wake as before it. Only the per-socket
//! frame counts live in memory; they start again at a wake, which only an idle board takes.
//!
//! Paths:
//!
//! - `POST /_seed {birth, fault}` → 201; 200 when already seeded. An empty board.
//! - `POST /_event` with an envelope → 200 `{change}` (`upserted`, `removed`, `duplicate`,
//!   `stale`, `not-for-board`); 503 `{error: "fault"}` while the `kitchen` fault is on; 409
//!   `{error: "unknown-order"}` for a later event whose `OrderPlaced` has not arrived (the
//!   consumer retries); 422 `{error: "envelope"}` for one that cannot be read. An event that
//!   changed the board goes to every open socket as an `evt` frame.
//! - `POST /_fault {on}` → 200 `{kitchen}`: the Sandbox's switch, copied here.
//! - `GET /_board` → 200 `{cards, applied}`: the snapshot a joining socket is sent, and how many
//!   events changed the board.
//! - `GET /_ws?kind=staff|guest` with `Upgrade: websocket` → 101: the socket, accepted on the
//!   Hibernation API. The router checked the session, the `Origin` and the sandbox first.
//! - `POST /_heartbeat` → 204: the console is open with no socket (it sends one every 30 s).
//! - `GET /_presence` → 200 `{sockets, last_heartbeat}`: what the Simulator asks each minute.
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs). The wipe says `bye` to every
//!   socket and closes it with 1001 first.
//!
//! The socket, protocol v1, JSON text frames. Server to client: `{t: "snapshot", v: 1, board:
//! {cards}, seq}` on open, `seq` being the count of events that changed the board; `{t: "evt",
//! v: 1, env}` for each event that changed it; `{t: "presence", v: 1, sockets}` when a socket
//! opens or closes; `{t: "bye", v: 1, reason: "wiped" | "limit"}` before the server closes;
//! `{t: "ack", v: 1, id}` or `{t: "nack", v: 1, id, rule}` for a command. Client to server:
//! `{t: "cmd", v: 1, id: <ULID>, order: <ULID>, action: "start_production" | "mark_ready" |
//! "mark_picked_up"}`, forwarded to the Order's `/_command` with `id` as the idempotency key.
//! `{"t":"ping","v":1}` is answered `{"t":"pong","v":1}` by the platform's auto-response, which
//! does not wake the object.
//!
//! Limits (docs/security.md, "Denial of service against the kitchen socket"): 4 open sockets a
//! sandbox (a fifth is accepted outside hibernation, gets `bye` `limit` and close 1008); frames of
//! at most 4 KB (close 1009); 10 frames a second a socket (close 1008); text frames only (close
//! 1003).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use bakery_app::Clock;
use bakery_domain::kitchen::{Board, BoardChange, BoardError, Card, Ignored};
use bakery_domain::{Envelope, Ulid, WallTime};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair, console_log, durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::order::{self, Action, Command};
use super::sql::{self, exec, first, gone, json, refuse, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::SystemClock;
use crate::random;

pub const BINDING: &str = "KITCHEN";
pub const CLASS: &str = "Kitchen";

pub fn name(sandbox: Ulid) -> String {
    format!("kitchen:{sandbox}")
}

/// The socket protocol's version, in every frame.
pub const PROTOCOL: u8 = 1;
/// Open sockets a sandbox may hold (docs/security.md, the kitchen socket's limits).
pub const MAX_SOCKETS: usize = 4;
/// The largest frame a client may send: 4 KB.
pub const MAX_FRAME_BYTES: usize = 4_096;
/// Frames a socket may send in one wall-clock second before it is closed with 1008.
pub const FRAMES_PER_SECOND: u32 = 10;
/// Command ids kept with their answers, so a repeated id is answered as the first time.
pub const KEEP_COMMANDS: i64 = 64;
/// `WebSocket.OPEN` (WHATWG WebSockets, "readyState").
const OPEN: u16 = 1;

const PING: &str = r#"{"t":"ping","v":1}"#;
const PONG: &str = r#"{"t":"pong","v":1}"#;

const SCHEMA: &[&str] = &[
    child::META,
    "CREATE TABLE IF NOT EXISTS board (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       body TEXT NOT NULL,
       applied INTEGER NOT NULL DEFAULT 0,
       fault INTEGER NOT NULL DEFAULT 0,
       heartbeat TEXT)",
    // The last 64 socket commands: the frame id, a digest of what it asked, and the answer.
    "CREATE TABLE IF NOT EXISTS commands (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       id TEXT NOT NULL UNIQUE,
       body_hash TEXT NOT NULL,
       answer TEXT NOT NULL)",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedKitchen {
    pub birth: Birth,
    #[serde(default)]
    pub fault: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FaultSwitch {
    pub on: bool,
}

/// `GET /_board`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardView {
    pub cards: Vec<Card>,
    pub applied: u64,
}

/// `GET /_presence`: open sockets, and the wall time of the console's last heartbeat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Presence {
    pub sockets: usize,
    pub last_heartbeat: Option<WallTime>,
}

/// Who holds a socket, as the router's session check found it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    /// A signed-in visitor: may send commands.
    Staff,
    /// A guest: sees the board; every command is refused with `guest-scope`.
    Guest,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::Staff => "staff",
            SessionKind::Guest => "guest",
        }
    }

    fn parse(text: &str) -> Option<SessionKind> {
        match text {
            "staff" => Some(SessionKind::Staff),
            "guest" => Some(SessionKind::Guest),
            _ => None,
        }
    }
}

/// A socket's attachment, which survives hibernation: its session kind and its own id, the key
/// of its frame count. Stored as JSON text, so no second deserializer is built for it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Tag {
    kind: SessionKind,
    id: String,
}

#[derive(Deserialize)]
struct BoardRow {
    body: String,
    applied: i64,
    fault: i64,
    heartbeat: Option<String>,
}

// ---------- frames (pure, tested natively) ----------

/// Why the server closes a socket, with the close code and the `bye` reason it sends first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closing {
    /// The sandbox was wiped: 1001, going away.
    Wiped,
    /// A fifth socket: 1008, policy.
    TooMany,
    /// More than 10 frames in a second: 1008.
    TooFast,
    /// A frame over 4 KB: 1009, too big.
    TooBig,
    /// A binary frame: 1003, unsupported data.
    Binary,
}

impl Closing {
    pub fn code(self) -> u16 {
        match self {
            Closing::Wiped => 1001,
            Closing::TooMany | Closing::TooFast => 1008,
            Closing::TooBig => 1009,
            Closing::Binary => 1003,
        }
    }

    /// The `bye` frame's reason, which tells the console whether to reconnect: never after
    /// either.
    pub fn bye(self) -> &'static str {
        match self {
            Closing::Wiped => "wiped",
            _ => "limit",
        }
    }

    /// The close frame's reason text and the log's code.
    pub fn code_name(self) -> &'static str {
        match self {
            Closing::Wiped => "wiped",
            Closing::TooMany => "too-many-sockets",
            Closing::TooFast => "too-many-frames",
            Closing::TooBig => "frame-too-big",
            Closing::Binary => "text-only",
        }
    }
}

pub fn snapshot_frame(cards: &[Card], applied: u64) -> Result<String> {
    Ok(serde_json::json!({
        "t": "snapshot",
        "v": PROTOCOL,
        "board": { "cards": cards },
        "seq": applied,
    })
    .to_string())
}

pub fn evt_frame(envelope: &Envelope) -> Result<String> {
    Ok(serde_json::json!({ "t": "evt", "v": PROTOCOL, "env": envelope }).to_string())
}

pub fn presence_frame(sockets: usize) -> String {
    serde_json::json!({ "t": "presence", "v": PROTOCOL, "sockets": sockets }).to_string()
}

pub fn bye_frame(reason: &str) -> String {
    serde_json::json!({ "t": "bye", "v": PROTOCOL, "reason": reason }).to_string()
}

/// The answer to a command: `ack`, or `nack` with the rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

impl Answer {
    fn ack() -> Answer {
        Answer {
            ok: true,
            rule: None,
        }
    }

    fn nack(rule: &str) -> Answer {
        Answer {
            ok: false,
            rule: Some(rule.to_owned()),
        }
    }

    pub fn frame(&self, id: &str) -> String {
        match &self.rule {
            None => serde_json::json!({ "t": "ack", "v": PROTOCOL, "id": id }).to_string(),
            Some(rule) => serde_json::json!({ "t": "nack", "v": PROTOCOL, "id": id, "rule": rule })
                .to_string(),
        }
    }
}

/// A client frame, read loosely so a bad one can still be answered by its id.
#[derive(Debug, Default, Deserialize)]
struct Incoming {
    #[serde(default)]
    t: Option<String>,
    #[serde(default)]
    v: Option<u64>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    order: Option<String>,
    #[serde(default)]
    action: Option<String>,
}

/// A command that passed every check that needs no storage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cmd {
    pub id: Ulid,
    pub order: Ulid,
    pub action: Action,
}

impl Cmd {
    /// What the id asked for, so the same id with another order or action is refused.
    fn body_hash(&self) -> String {
        crate::http::body_hash(&format!("{}:{:?}", self.order, self.action))
    }
}

/// Reads a client's text frame: the command, or the id to answer (empty when it has none) and
/// the rule it broke. A guest is refused before the command is read any further.
pub fn read_frame(
    text: &str,
    kind: SessionKind,
) -> std::result::Result<Cmd, (String, &'static str)> {
    let frame: Incoming = serde_json::from_str(text).map_err(|_| (String::new(), "frame"))?;
    let raw_id = frame.id.clone().unwrap_or_default();
    if frame.v != Some(u64::from(PROTOCOL)) {
        return Err((raw_id, "version"));
    }
    if frame.t.as_deref() != Some("cmd") {
        return Err((raw_id, "frame"));
    }
    let id: Ulid = raw_id.parse().map_err(|_| (raw_id.clone(), "id"))?;
    if kind == SessionKind::Guest {
        return Err((raw_id, "guest-scope"));
    }
    let action = match frame.action.as_deref() {
        Some("start_production") => Action::StartProduction,
        Some("mark_ready") => Action::MarkReady,
        Some("mark_picked_up") => Action::MarkPickedUp,
        _ => return Err((raw_id, "action")),
    };
    let order: Ulid = frame
        .order
        .as_deref()
        .and_then(|o| o.parse().ok())
        .ok_or((raw_id.clone(), "unknown-order"))?;
    Ok(Cmd { id, order, action })
}

/// One socket's frame count in the current second; `false` once it passes the limit.
fn within_rate(count: &mut (i64, u32), second: i64) -> bool {
    if count.0 != second {
        *count = (second, 0);
    }
    count.1 += 1;
    count.1 <= FRAMES_PER_SECOND
}

// ---------- the object ----------

#[durable_object]
pub struct Kitchen {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
    /// This instance's mark, in the log beside `kitchen_wake`: a new mark after an idle spell
    /// with sockets open shows the object left memory and came back.
    instance: String,
    /// Frames each socket sent in the current second, by its id. Lost at a wake, which only an
    /// idle board takes, so nothing it counts is lost.
    frames: RefCell<HashMap<String, (i64, u32)>>,
}

impl DurableObject for Kitchen {
    fn new(state: State, env: Env) -> Self {
        let instance = random::bytes::<4>()
            .map(|b| bakery_app::auth::hex(&b))
            .unwrap_or_default();
        let open = state.get_websockets().len();
        if open > 0 {
            // Hibernation: the object was evicted with sockets still open, and a frame or a
            // request brought it back.
            console_log!(
                "{{\"event\":\"kitchen_wake\",\"instance\":\"{instance}\",\"sockets\":{open}}}"
            );
        }
        Kitchen {
            state,
            env,
            schema_ready: Cell::new(false),
            instance,
            frames: RefCell::new(HashMap::new()),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_seed") => {
                let body: SeedKitchen = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_wipe") => {
                self.close_all(Closing::Wiped);
                json(&child::wipe(&self.state).await?, 200)
            }
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Post, "/_event") => {
                        let text = req.text().await?;
                        self.event(&meta, &text)
                    }
                    (Method::Get, "/_ws") => self.upgrade(&req),
                    (Method::Post, "/_heartbeat") => {
                        exec(
                            &sql,
                            "UPDATE board SET heartbeat = ?",
                            vec![now.to_string().into()],
                        )?;
                        Ok(Response::empty()?.with_status(204))
                    }
                    (Method::Get, "/_presence") => json(&self.presence()?, 200),
                    (Method::Post, "/_fault") => {
                        let body: FaultSwitch = sql::body(&mut req).await?;
                        exec(
                            &sql,
                            "UPDATE board SET fault = ?",
                            vec![i64::from(body.on).into()],
                        )?;
                        json(&serde_json::json!({ "kitchen": body.on }), 200)
                    }
                    (Method::Get, "/_board") => {
                        let row = self.row()?;
                        let board: Board = serde_json::from_str(&row.body)?;
                        json(
                            &BoardView {
                                cards: board.snapshot(),
                                applied: u64::try_from(row.applied).unwrap_or(0),
                            },
                            200,
                        )
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
        if child::meta(&storage.sql())?.is_none() {
            storage.delete_all().await?;
            return Response::empty();
        }
        for timer in stream::due(&storage.sql(), now)? {
            match timer.purpose.as_str() {
                BACKSTOP => {
                    console_log!("{{\"event\":\"backstop\",\"object\":\"{CLASS}\"}}");
                    self.close_all(Closing::Wiped);
                    child::wipe(&self.state).await?;
                    return Response::empty();
                }
                // The Kitchen emits no events yet; an outbox timer has nothing to send.
                OUTBOX => stream::outbox_timer(&storage, &self.env, now, CLASS).await?,
                _ => stream::delete_timer(&storage.sql(), &timer.id)?,
            }
        }
        stream::arm(&storage, now).await?;
        Response::empty()
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let Some(tag) = tag_of(&ws) else {
            // A socket with no attachment was not accepted here; it has no session.
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
            !within_rate(frames.entry(tag.id.clone()).or_insert((second, 0)), second)
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
            return Ok(());
        }
        let (id, answer) = match read_frame(&text, tag.kind) {
            Ok(cmd) => {
                let answer = self.command(&cmd).await?;
                (cmd.id.to_string(), answer)
            }
            Err((id, rule)) => (id, Answer::nack(rule)),
        };
        console_log!(
            "{{\"event\":\"kitchen_cmd\",\"instance\":\"{}\",\"id\":{:?},\"outcome\":\"{}\",\"rule\":{:?}}}",
            self.instance,
            safe_id(&id),
            if answer.ok { "ack" } else { "nack" },
            answer.rule.as_deref().unwrap_or("")
        );
        let _ = ws.send_with_str(answer.frame(safe_id(&id)));
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
        // Answer the client's close; a socket already closing ignores it.
        let _ = ws.close(Some(1000), Some("closed"));
        let open = self.open_sockets();
        console_log!(
            "{{\"event\":\"kitchen_socket_closed\",\"instance\":\"{}\",\"code\":{code},\"sockets\":{}}}",
            self.instance,
            open.len()
        );
        broadcast(&open, &presence_frame(open.len()));
        Ok(())
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        if let Some(tag) = tag_of(&ws) {
            self.frames.borrow_mut().remove(&tag.id);
        }
        let open = self.open_sockets();
        console_log!(
            "{{\"event\":\"kitchen_socket_error\",\"instance\":\"{}\",\"sockets\":{}}}",
            self.instance,
            open.len()
        );
        broadcast(&open, &presence_frame(open.len()));
        Ok(())
    }
}

/// A frame id goes into the log and back to the client only when it is a ULID; anything else
/// a client sent is dropped.
fn safe_id(id: &str) -> &str {
    if id.parse::<Ulid>().is_ok() { id } else { "" }
}

fn tag_of(ws: &WebSocket) -> Option<Tag> {
    let text: String = ws.deserialize_attachment().ok().flatten()?;
    serde_json::from_str(&text).ok()
}

fn is_open(ws: &WebSocket) -> bool {
    let raw: &worker::web_sys::WebSocket = ws.as_ref();
    raw.ready_state() == OPEN
}

fn broadcast(sockets: &[WebSocket], frame: &str) {
    for ws in sockets {
        // A socket that went away between the read and the send is closed by the platform.
        let _ = ws.send_with_str(frame);
    }
}

/// `bye`, then the close frame.
fn close(ws: &WebSocket, why: Closing) {
    let _ = ws.send_with_str(bye_frame(why.bye()));
    let _ = ws.close(Some(why.code()), Some(why.code_name()));
}

impl Kitchen {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn row(&self) -> Result<BoardRow> {
        first(
            &self.sql(),
            "SELECT body, applied, fault, heartbeat FROM board",
            vec![],
        )?
        .ok_or_else(|| Error::RustError("board row missing".into()))
    }

    fn open_sockets(&self) -> Vec<WebSocket> {
        self.state
            .get_websockets()
            .into_iter()
            .filter(is_open)
            .collect()
    }

    fn presence(&self) -> Result<Presence> {
        let row = self.row()?;
        Ok(Presence {
            sockets: self.open_sockets().len(),
            last_heartbeat: row.heartbeat.and_then(|h| h.parse().ok()),
        })
    }

    /// Every socket gets `bye` and its close: the wipe and the backstop.
    fn close_all(&self, why: Closing) {
        let sockets = self.state.get_websockets();
        for ws in &sockets {
            close(ws, why);
        }
        if !sockets.is_empty() {
            console_log!(
                "{{\"event\":\"kitchen_sockets_closed\",\"reason\":\"{}\",\"sockets\":{}}}",
                why.code_name(),
                sockets.len()
            );
        }
    }

    fn refuse_socket(&self, ws: &WebSocket, tag: &Tag, why: Closing) {
        self.frames.borrow_mut().remove(&tag.id);
        console_log!(
            "{{\"event\":\"kitchen_socket_refused\",\"instance\":\"{}\",\"reason\":\"{}\"}}",
            self.instance,
            why.code_name()
        );
        close(ws, why);
    }

    /// The upgrade: accepted on the Hibernation API with the session kind in the attachment,
    /// then the snapshot, then everyone's presence. A fifth socket is accepted only to be told
    /// why it is closed, which a refused upgrade could not say.
    fn upgrade(&self, req: &Request) -> Result<Response> {
        let upgrade = req.headers().get("Upgrade")?.unwrap_or_default();
        if !upgrade.eq_ignore_ascii_case("websocket") {
            return refuse(426, "upgrade");
        }
        let kind = req
            .url()?
            .query_pairs()
            .find(|(k, _)| k == "kind")
            .and_then(|(_, v)| SessionKind::parse(&v))
            .ok_or_else(|| Error::RustError("an upgrade with no session kind".into()))?;
        let open = self.open_sockets();
        let pair = WebSocketPair::new()?;
        let server = pair.server;
        if open.len() >= MAX_SOCKETS {
            // Accepted outside the Hibernation API, only to be told why it is closed: a close
            // on a hibernatable socket before its 101 has gone out never reaches the client
            // (observed on wrangler dev 4.157.0, 2026-11-05).
            console_log!(
                "{{\"event\":\"kitchen_socket_refused\",\"instance\":\"{}\",\"reason\":\"{}\"}}",
                self.instance,
                Closing::TooMany.code_name()
            );
            server.accept()?;
            close(&server, Closing::TooMany);
            return Response::from_websocket(pair.client);
        }
        self.state.accept_web_socket(&server);
        let pong = worker::worker_sys::WebSocketRequestResponsePair::new(PING, PONG)
            .map_err(|_| Error::RustError("auto-response pair".into()))?;
        self.state.set_websocket_auto_response(&pong);
        let tag = Tag {
            kind,
            id: random::ulid(SystemClock::new().now_wall())?.to_string(),
        };
        server.serialize_attachment(serde_json::to_string(&tag)?)?;
        let row = self.row()?;
        let board: Board = serde_json::from_str(&row.body)?;
        server.send_with_str(snapshot_frame(
            &board.snapshot(),
            u64::try_from(row.applied).unwrap_or(0),
        )?)?;
        let mut all = open;
        all.push(server);
        console_log!(
            "{{\"event\":\"kitchen_socket_open\",\"instance\":\"{}\",\"kind\":\"{}\",\"sockets\":{}}}",
            self.instance,
            kind.as_str(),
            all.len()
        );
        broadcast(&all, &presence_frame(all.len()));
        Response::from_websocket(pair.client)
    }

    /// A staff command from a socket: answered from the last 64 ids when it is one of them,
    /// else checked against the board and sent to its Order with the frame id as the key. An
    /// answer the Order gave is kept; a failure to reach it is not, so the same id may retry.
    async fn command(&self, cmd: &Cmd) -> Result<Answer> {
        let sql = self.sql();
        let hash = cmd.body_hash();
        #[derive(Deserialize)]
        struct Known {
            body_hash: String,
            answer: String,
        }
        let known: Option<Known> = first(
            &sql,
            "SELECT body_hash, answer FROM commands WHERE id = ?",
            vec![cmd.id.to_string().into()],
        )?;
        if let Some(k) = known {
            if k.body_hash != hash {
                return Ok(Answer::nack("key-reused"));
            }
            return Ok(serde_json::from_str(&k.answer)?);
        }
        let row = self.row()?;
        let board: Board = serde_json::from_str(&row.body)?;
        if board.card(cmd.order).is_none() {
            return Ok(Answer::nack("unknown-order"));
        }
        let meta = child::meta(&sql)?.ok_or_else(|| Error::RustError("no meta".into()))?;
        let name = order::name(meta.sandbox_id()?, cmd.order);
        let mut res = sql::call(
            &self.env,
            order::BINDING,
            &name,
            Method::Post,
            "/_command",
            Some(&Command {
                key: cmd.id.to_string(),
                action: cmd.action,
                body_hash: hash.clone(),
                cause: None,
            }),
        )
        .await?;
        let answer = match res.status_code() {
            200 => Answer::ack(),
            422 => {
                #[derive(Default, Deserialize)]
                struct Refused {
                    #[serde(default)]
                    error: String,
                    #[serde(default)]
                    rule: Option<String>,
                }
                let refused: Refused = serde_json::from_str(&res.text().await?).unwrap_or_default();
                match (refused.error.as_str(), refused.rule) {
                    ("key-reused", _) => Answer::nack("key-reused"),
                    (_, Some(rule)) => Answer::nack(&rule),
                    _ => Answer::nack("refused"),
                }
            }
            404 | 410 => Answer::nack("unknown-order"),
            _ => return Ok(Answer::nack("unavailable")),
        };
        let stored = serde_json::to_string(&answer)?;
        let id = cmd.id.to_string();
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "INSERT OR IGNORE INTO commands (id, body_hash, answer) VALUES (?, ?, ?)",
                vec![id.into(), hash.into(), stored.into()],
            )?;
            exec(
                &sql,
                "DELETE FROM commands WHERE seq <= (SELECT max(seq) FROM commands) - ?",
                vec![KEEP_COMMANDS.into()],
            )?;
            Ok(())
        })?;
        Ok(answer)
    }

    async fn seed(&self, s: SeedKitchen, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if child::meta(&sql)?.is_some() {
            return json(&serde_json::json!({ "seeded": true }), 200);
        }
        if !self.schema_ready.get() {
            stream::create_schema(&sql, SCHEMA)?;
            self.schema_ready.set(true);
        }
        let body = serde_json::to_string(&Board::default())?;
        let birth = s.birth.clone();
        let fault = i64::from(s.fault);
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)?;
            exec(
                &sql,
                "INSERT INTO board (id, body, applied, fault) VALUES (1, ?, 0, ?)",
                vec![body.into(), fault.into()],
            )?;
            Ok(())
        })?;
        stream::arm(&self.state.storage(), now).await?;
        json(&serde_json::json!({ "seeded": true }), 201)
    }

    /// One delivery. The fault answers before anything is read, as a broken subscriber would.
    /// An event that changed the board goes to every open socket once the row is written.
    fn event(&self, meta: &child::Meta, text: &str) -> Result<Response> {
        let row = self.row()?;
        if row.fault != 0 {
            return refuse(503, "fault");
        }
        let Ok(envelope) = serde_json::from_str::<Envelope>(text) else {
            return refuse(422, "envelope");
        };
        if envelope.sandbox.to_string() != meta.sandbox {
            return refuse(422, "envelope");
        }
        let mut board: Board = serde_json::from_str(&row.body)?;
        let change = match board.apply(&envelope) {
            Ok(change) => change,
            Err(BoardError::UnknownOrder(_)) => return refuse(409, "unknown-order"),
            Err(_) => return refuse(422, "envelope"),
        };
        let (label, changed) = match &change {
            BoardChange::Upserted(_) => ("upserted", true),
            BoardChange::Removed(_) => ("removed", true),
            BoardChange::BakeList(_) => ("bake-list", true),
            BoardChange::Unchanged(Ignored::Duplicate) => ("duplicate", false),
            BoardChange::Unchanged(Ignored::Stale) => ("stale", false),
            BoardChange::Unchanged(Ignored::NotForBoard) => ("not-for-board", false),
        };
        if label != "duplicate" {
            // A stale or foreign event still enters `seen`, so the board row changes.
            exec(
                &self.sql(),
                "UPDATE board SET body = ?, applied = applied + ?",
                vec![
                    serde_json::to_string(&board)?.into(),
                    i64::from(changed).into(),
                ],
            )?;
        }
        if changed {
            broadcast(&self.open_sockets(), &evt_frame(&envelope)?);
        }
        json(&serde_json::json!({ "change": label }), 200)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
    const ORDER: &str = "01JC8Z5R0T2B6Y8C4V1N3K7QXE";

    fn cmd(action: &str) -> String {
        format!(r#"{{"t":"cmd","v":1,"id":"{ID}","order":"{ORDER}","action":"{action}"}}"#)
    }

    #[test]
    fn a_staff_command_reads_its_three_actions() {
        for (name, action) in [
            ("start_production", Action::StartProduction),
            ("mark_ready", Action::MarkReady),
            ("mark_picked_up", Action::MarkPickedUp),
        ] {
            let c = read_frame(&cmd(name), SessionKind::Staff).unwrap();
            assert_eq!(c.action, action);
            assert_eq!(c.id.to_string(), ID);
            assert_eq!(c.order.to_string(), ORDER);
        }
    }

    #[test]
    fn a_guest_is_refused_with_the_rule_and_its_id() {
        assert_eq!(
            read_frame(&cmd("mark_ready"), SessionKind::Guest),
            Err((ID.to_owned(), "guest-scope"))
        );
    }

    #[test]
    fn bad_frames_are_named() {
        let staff = SessionKind::Staff;
        assert_eq!(read_frame("not json", staff), Err((String::new(), "frame")));
        assert_eq!(
            read_frame(&cmd("cancel"), staff),
            Err((ID.to_owned(), "action"))
        );
        assert_eq!(
            read_frame(&cmd("mark_ready").replace("\"v\":1", "\"v\":2"), staff),
            Err((ID.to_owned(), "version"))
        );
        assert_eq!(
            read_frame(&cmd("mark_ready").replace("\"cmd\"", "\"ping\""), staff),
            Err((ID.to_owned(), "frame"))
        );
        assert_eq!(
            read_frame(&cmd("mark_ready").replace(ID, "not-an-id"), staff),
            Err(("not-an-id".to_owned(), "id"))
        );
        assert_eq!(
            read_frame(&cmd("mark_ready").replace(ORDER, "x"), staff),
            Err((ID.to_owned(), "unknown-order"))
        );
        assert_eq!(safe_id("not-an-id"), "");
        assert_eq!(safe_id(ID), ID);
    }

    #[test]
    fn ten_frames_a_second_and_no_more() {
        let mut count = (0, 0);
        for _ in 0..FRAMES_PER_SECOND {
            assert!(within_rate(&mut count, 7));
        }
        assert!(!within_rate(&mut count, 7));
        assert!(within_rate(&mut count, 8), "a new second starts again");
    }

    #[test]
    fn frames_are_protocol_v1() {
        let ack = Answer::ack().frame(ID);
        assert_eq!(ack, format!(r#"{{"id":"{ID}","t":"ack","v":1}}"#));
        let nack: serde_json::Value =
            serde_json::from_str(&Answer::nack("guest-scope").frame(ID)).unwrap();
        assert_eq!(nack["t"], "nack");
        assert_eq!(nack["rule"], "guest-scope");
        let bye: serde_json::Value = serde_json::from_str(&bye_frame("wiped")).unwrap();
        assert_eq!(
            (bye["t"].as_str(), bye["v"].as_u64()),
            (Some("bye"), Some(1))
        );
        let presence: serde_json::Value = serde_json::from_str(&presence_frame(3)).unwrap();
        assert_eq!(presence["sockets"], 3);
        let snap: serde_json::Value =
            serde_json::from_str(&snapshot_frame(&[], 5).unwrap()).unwrap();
        assert_eq!(snap["board"]["cards"], serde_json::json!([]));
        assert_eq!(snap["seq"], 5);
        assert_eq!(Closing::Wiped.code(), 1001);
        assert_eq!(Closing::TooMany.code(), 1008);
        assert_eq!(Closing::TooFast.code(), 1008);
        assert_eq!(Closing::TooMany.bye(), "limit");
    }
}
