//! `Kitchen`, one per sandbox, named `kitchen:<sandbox>`: the kitchen board, a projection of
//! order events (docs/architecture.md, "Durable Object topology"). This is the half the Queue
//! needs: the board rebuilt from `/_event` deliveries and the `kitchen` fault. The sockets on the
//! Hibernation API, protocol v1 and the presence the Simulator reads arrive beside it (W2).
//!
//! The board is the domain's `Board`, stored whole in one `board` row. Its own `seen` set and
//! its per-order `seq` heads are inside that row, so applying an event and recording its id are
//! one write: a redelivery changes nothing (ADR 0004, decision 3).
//!
//! Paths:
//!
//! - `POST /_seed {birth, fault}` → 201; 200 when already seeded. An empty board.
//! - `POST /_event` with an envelope → 200 `{change}` (`upserted`, `removed`, `duplicate`,
//!   `stale`, `not-for-board`); 503 `{error: "fault"}` while the `kitchen` fault is on; 409
//!   `{error: "unknown-order"}` for a later event whose `OrderPlaced` has not arrived (the
//!   consumer retries); 422 `{error: "envelope"}` for one that cannot be read.
//! - `POST /_fault {on}` → 200 `{kitchen}`: the Sandbox's switch, copied here.
//! - `GET /_board` → 200 `{cards, applied}`: the snapshot a joining socket is sent, and how many
//!   events changed the board.
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs).

use std::cell::Cell;

use bakery_app::Clock;
use bakery_domain::kitchen::{Board, BoardChange, BoardError, Card, Ignored};
use bakery_domain::{Envelope, Ulid, WallTime};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::sql::{self, exec, first, gone, json, refuse, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::SystemClock;

pub const BINDING: &str = "KITCHEN";
pub const CLASS: &str = "Kitchen";

pub fn name(sandbox: Ulid) -> String {
    format!("kitchen:{sandbox}")
}

const SCHEMA: &[&str] = &[
    child::META,
    "CREATE TABLE IF NOT EXISTS board (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       body TEXT NOT NULL,
       applied INTEGER NOT NULL DEFAULT 0,
       fault INTEGER NOT NULL DEFAULT 0)",
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

#[derive(Deserialize)]
struct BoardRow {
    body: String,
    applied: i64,
    fault: i64,
}

#[durable_object]
pub struct Kitchen {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Kitchen {
    fn new(state: State, env: Env) -> Self {
        Kitchen {
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
                let body: SeedKitchen = sql::body(&mut req).await?;
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
                        self.event(&meta, &text)
                    }
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
}

impl Kitchen {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn row(&self) -> Result<BoardRow> {
        first(
            &self.sql(),
            "SELECT body, applied, fault FROM board",
            vec![],
        )?
        .ok_or_else(|| Error::RustError("board row missing".into()))
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
        json(&serde_json::json!({ "change": label }), 200)
    }
}
