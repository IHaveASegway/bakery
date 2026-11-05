//! `Account`, one per signed-in person, named `account:<64 hex>` (docs/architecture.md,
//! "Object naming"). It holds the HMAC'd id and nothing a provider sent: no `sub`, GitHub id,
//! email or name ever reaches it. A demo account also holds its username and the argon2id PHC
//! string; the password itself never reaches the object, which keeps its handlers short.
//!
//! An `Account` with no `meta` row answers 410 to everything but its create paths, so a
//! guessed name summons nothing. Its one timer deletes it 30 days after the last sign-in.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_app::admission::admit_account_sandbox;
use bakery_app::auth::{AccountKind, LOCKOUT_WINDOW_MS, Lockout, SESSION_TTL_S};
use bakery_app::wipe::account_idle_delete_at;
use bakery_domain::{Ulid, WallTime};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::sql::{self, exec, first, gone, has_table, json, refuse, rows, transaction_sync};
use crate::clock::{SystemClock, alarm_time};
use crate::config::caps_from_env;

pub const BINDING: &str = "ACCOUNT";
const IDLE_DELETE: &str = "idle_delete";

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS meta (
       account_id TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('google','github','demo')),
       created_day TEXT NOT NULL,
       last_signin TEXT NOT NULL,
       current_sandbox TEXT,
       sandbox_wipe_at TEXT)",
    "CREATE TABLE IF NOT EXISTS demo (username TEXT NOT NULL, phc TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS failures (at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS revoked (sid TEXT PRIMARY KEY, at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sandboxes_created (day TEXT PRIMARY KEY, count INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS timers (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, due_wall TEXT NOT NULL)",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDemo {
    pub account_id: String,
    pub username: String,
    pub phc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignIn {
    pub account_id: String,
    pub kind: AccountKind,
    pub sid: String,
}

/// The account's sandbox, if it was born after the last wipe: one whose wipe time has passed
/// is not offered.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Current {
    pub current_sandbox: Option<Ulid>,
    pub sandbox_wipe_at: Option<WallTime>,
    /// Sandboxes this account created on the UTC day asked about.
    #[serde(default)]
    pub created_today: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemoHash {
    pub phc: String,
}

/// The answer to a locked account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Locked {
    pub error: String,
    pub retry_after: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sid {
    pub sid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetSandbox {
    pub sandbox_id: Ulid,
    pub wipe_at: WallTime,
    pub day: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClearSandbox {
    pub sandbox_id: Ulid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revoked {
    pub revoked: bool,
}

#[derive(Deserialize)]
struct MetaRow {
    account_id: String,
    kind: String,
    current_sandbox: Option<String>,
    sandbox_wipe_at: Option<String>,
}

#[derive(Deserialize)]
struct PhcRow {
    phc: String,
}

#[derive(Deserialize)]
struct AtRow {
    at: String,
}

#[derive(Deserialize)]
struct CountRow {
    count: i64,
}

#[durable_object]
pub struct Account {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Account {
    fn new(state: State, env: Env) -> Self {
        Account {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_create-demo") => {
                let body: CreateDemo = sql::body(&mut req).await?;
                self.create_demo(body, now).await
            }
            (Method::Post, "/_signin") => {
                let body: SignIn = sql::body(&mut req).await?;
                self.sign_in(body, now).await
            }
            (method, path) => {
                // Every other path needs the account to exist.
                let Some(meta) = self.meta()? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Get, "/_demo-hash") => self.demo_hash(&meta, now),
                    (Method::Post, "/_failed") => self.failed(now),
                    (Method::Post, "/_revoke") => {
                        let body: Sid = sql::body(&mut req).await?;
                        self.revoke(&body.sid, now)
                    }
                    (Method::Get, "/_current") => {
                        let day = query_value(&req, "day")?.unwrap_or_else(|| now.utc_day());
                        json(&self.current(&meta, &day, now)?, 200)
                    }
                    (Method::Post, "/_set-sandbox") => {
                        let body: SetSandbox = sql::body(&mut req).await?;
                        self.set_sandbox(body, now)
                    }
                    (Method::Post, "/_clear-sandbox") => {
                        let body: ClearSandbox = sql::body(&mut req).await?;
                        exec(
                            &self.sql(),
                            "UPDATE meta SET current_sandbox = NULL, sandbox_wipe_at = NULL
                             WHERE current_sandbox = ?",
                            vec![body.sandbox_id.to_string().into()],
                        )?;
                        json(&serde_json::json!({ "ok": true }), 200)
                    }
                    (Method::Get, p) if p.starts_with("/_revoked/") => {
                        let sid = &p["/_revoked/".len()..];
                        let found: Option<AtRow> = first(
                            &self.sql(),
                            "SELECT at FROM revoked WHERE sid = ?",
                            vec![sid.into()],
                        )?;
                        json(
                            &Revoked {
                                revoked: found.is_some(),
                            },
                            200,
                        )
                    }
                    _ => refuse(404, "not-found"),
                }
            }
        }
    }

    /// The idle timer: 30 days after the last sign-in the account deletes itself. A sign-in
    /// since moved the timer, so a stale alarm finds a later due time and re-arms for it.
    async fn alarm(&self) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        if !has_table(&self.sql(), "timers")? {
            self.state.storage().delete_all().await?;
            return Response::empty();
        }
        let due: Option<AtRow> = first(
            &self.sql(),
            "SELECT due_wall AS at FROM timers WHERE id = ?",
            vec![IDLE_DELETE.into()],
        )?;
        match due.and_then(|d| d.at.parse::<WallTime>().ok()) {
            Some(at) if at > now => self.state.storage().set_alarm(alarm_time(at)).await?,
            _ => {
                console_log!("{{\"event\":\"account_idle_deleted\"}}");
                self.state.storage().delete_all().await?;
            }
        }
        Response::empty()
    }
}

impl Account {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn ensure_schema(&self) -> Result<()> {
        if self.schema_ready.get() {
            return Ok(());
        }
        for statement in SCHEMA {
            self.sql().exec(statement, None)?;
        }
        self.schema_ready.set(true);
        Ok(())
    }

    fn meta(&self) -> Result<Option<MetaRow>> {
        if !has_table(&self.sql(), "meta")? {
            return Ok(None);
        }
        first(
            &self.sql(),
            "SELECT account_id, kind, current_sandbox, sandbox_wipe_at FROM meta",
            vec![],
        )
    }

    /// Moves the idle timer to 30 days after `last_signin` and arms the alarm for it.
    async fn arm_idle(&self, last_signin: WallTime) -> Result<()> {
        let at =
            account_idle_delete_at(last_signin).map_err(|e| Error::RustError(e.to_string()))?;
        exec(
            &self.sql(),
            "INSERT INTO timers (id, purpose, due_wall) VALUES (?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET due_wall = excluded.due_wall",
            vec![
                IDLE_DELETE.into(),
                IDLE_DELETE.into(),
                at.to_string().into(),
            ],
        )?;
        self.state.storage().set_alarm(alarm_time(at)).await
    }

    /// Refuses over an existing account, so a clash of generated usernames never overwrites
    /// one: the Worker draws another name.
    async fn create_demo(&self, body: CreateDemo, now: WallTime) -> Result<Response> {
        if self.meta()?.is_some() {
            return refuse(409, "exists");
        }
        self.ensure_schema()?;
        let sql = self.sql();
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "INSERT INTO meta (account_id, kind, created_day, last_signin) VALUES (?, 'demo', ?, ?)",
                vec![
                    body.account_id.into(),
                    now.utc_day().into(),
                    now.to_string().into(),
                ],
            )?;
            exec(
                &sql,
                "INSERT INTO demo (username, phc) VALUES (?, ?)",
                vec![body.username.into(), body.phc.into()],
            )?;
            Ok(())
        })?;
        self.arm_idle(now).await?;
        json(&serde_json::json!({ "ok": true }), 201)
    }

    /// A sign-in: creates `meta` for a first Google or GitHub sign-in, refuses another
    /// account's id, clears the demo failures, moves the idle timer, and answers the current
    /// sandbox if it is still before its wipe.
    async fn sign_in(&self, body: SignIn, now: WallTime) -> Result<Response> {
        let meta = match self.meta()? {
            Some(meta) => meta,
            None if body.kind == AccountKind::Demo => return gone(),
            None => {
                self.ensure_schema()?;
                exec(
                    &self.sql(),
                    "INSERT INTO meta (account_id, kind, created_day, last_signin) VALUES (?, ?, ?, ?)",
                    vec![
                        body.account_id.as_str().into(),
                        body.kind.as_str().into(),
                        now.utc_day().into(),
                        now.to_string().into(),
                    ],
                )?;
                self.meta()?
                    .ok_or_else(|| Error::RustError("meta not written".into()))?
            }
        };
        if meta.account_id != body.account_id || meta.kind != body.kind.as_str() {
            return refuse(409, "identity");
        }
        self.ensure_schema()?;
        let sql = self.sql();
        exec(
            &sql,
            "UPDATE meta SET last_signin = ?",
            vec![now.to_string().into()],
        )?;
        exec(&sql, "DELETE FROM failures", vec![])?;
        self.arm_idle(now).await?;
        json(&self.current(&meta, &now.utc_day(), now)?, 200)
    }

    fn current(&self, meta: &MetaRow, day: &str, now: WallTime) -> Result<Current> {
        let wipe_at = meta
            .sandbox_wipe_at
            .as_deref()
            .and_then(|t| t.parse::<WallTime>().ok());
        let live = wipe_at.is_some_and(|w| w > now);
        let created: Option<CountRow> = first(
            &self.sql(),
            "SELECT count FROM sandboxes_created WHERE day = ?",
            vec![day.into()],
        )?;
        Ok(Current {
            current_sandbox: meta
                .current_sandbox
                .as_deref()
                .filter(|_| live)
                .and_then(|s| s.parse().ok()),
            sandbox_wipe_at: wipe_at.filter(|_| live),
            created_today: u32::try_from(created.map_or(0, |c| c.count)).unwrap_or(u32::MAX),
        })
    }

    /// The PHC string, unless 10 failures in 15 minutes lock the account.
    fn demo_hash(&self, meta: &MetaRow, now: WallTime) -> Result<Response> {
        if meta.kind != AccountKind::Demo.as_str() {
            return gone();
        }
        let failures: Vec<AtRow> = rows(&self.sql(), "SELECT at FROM failures", vec![])?;
        let times: Vec<WallTime> = failures.iter().filter_map(|f| f.at.parse().ok()).collect();
        if let Some(retry_after) = Lockout::check(&times, now) {
            return json(
                &Locked {
                    error: "locked".into(),
                    retry_after,
                },
                429,
            );
        }
        let phc: Option<PhcRow> = first(&self.sql(), "SELECT phc FROM demo", vec![])?;
        match phc {
            Some(row) => json(&DemoHash { phc: row.phc }, 200),
            None => gone(),
        }
    }

    fn failed(&self, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let cutoff = WallTime::from_unix_ms(now.unix_ms() - LOCKOUT_WINDOW_MS)
            .map_err(|e| Error::RustError(e.to_string()))?;
        exec(
            &sql,
            "DELETE FROM failures WHERE at <= ?",
            vec![cutoff.to_string().into()],
        )?;
        exec(
            &sql,
            "INSERT INTO failures (at) VALUES (?)",
            vec![now.to_string().into()],
        )?;
        json(&serde_json::json!({ "ok": true }), 200)
    }

    /// A signed-out session id, kept for one cookie lifetime: after that the cookie is
    /// refused by its own expiry.
    fn revoke(&self, sid: &str, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let cutoff = WallTime::from_unix_ms(now.unix_ms() - SESSION_TTL_S * 1_000)
            .map_err(|e| Error::RustError(e.to_string()))?;
        exec(
            &sql,
            "DELETE FROM revoked WHERE at < ?",
            vec![cutoff.to_string().into()],
        )?;
        exec(
            &sql,
            "INSERT OR IGNORE INTO revoked (sid, at) VALUES (?, ?)",
            vec![sid.into(), now.to_string().into()],
        )?;
        json(&serde_json::json!({ "ok": true }), 200)
    }

    /// Counts the new sandbox against the account's daily cap and makes it current, in one
    /// transaction; 429 when the day's count has reached `ACCOUNT_SANDBOX_CAP`.
    fn set_sandbox(&self, body: SetSandbox, _now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let caps = caps_from_env(&self.env);
        let admitted = transaction_sync(&self.state.storage(), move || {
            let created: Option<CountRow> = first(
                &sql,
                "SELECT count FROM sandboxes_created WHERE day = ?",
                vec![body.day.as_str().into()],
            )?;
            let created = u32::try_from(created.map_or(0, |c| c.count)).unwrap_or(u32::MAX);
            if admit_account_sandbox(created, caps).is_err() {
                return Ok(false);
            }
            exec(
                &sql,
                "DELETE FROM sandboxes_created WHERE day <> ?",
                vec![body.day.as_str().into()],
            )?;
            exec(
                &sql,
                "INSERT INTO sandboxes_created (day, count) VALUES (?, 1)
                 ON CONFLICT (day) DO UPDATE SET count = count + 1",
                vec![body.day.as_str().into()],
            )?;
            exec(
                &sql,
                "UPDATE meta SET current_sandbox = ?, sandbox_wipe_at = ?",
                vec![
                    body.sandbox_id.to_string().into(),
                    body.wipe_at.to_string().into(),
                ],
            )?;
            Ok(true)
        })?;
        if admitted {
            json(&serde_json::json!({ "ok": true }), 200)
        } else {
            refuse(429, "account-sandbox-cap")
        }
    }
}

/// One query parameter, from a URL only the Worker builds.
fn query_value(req: &Request, name: &str) -> Result<Option<String>> {
    Ok(req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned()))
}
