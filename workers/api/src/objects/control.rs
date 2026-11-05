//! `Control`, one per account, named `control`: the demo's flags and the daily ledger
//! (docs/architecture.md, "Durable Object topology"). SQLite-backed; its alarm prunes the ledger
//! at 00:00 UTC. Nothing here is billed per sandbox, so the router asks it only after the free
//! checks.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_contracts::{Flag, StatusResponse};
use bakery_domain::WallTime;
use serde::{Deserialize, Serialize};
use worker::js_sys::{Function, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue, closure::Closure};
use worker::{
    DurableObject, Env, Error, Method, Request, RequestInit, Response, Result, SqlStorage, State,
    Storage, console_log, durable_object,
};

use crate::clock::{SystemClock, alarm_time};

/// The object's one name; a client never names an object.
pub const NAME: &str = "control";
const BINDING: &str = "CONTROL";
/// The daily cap on new sandboxes, unless the `SANDBOX_CAP` var says otherwise.
const DEFAULT_SANDBOX_CAP: u32 = 300;
/// Ledger rows older than this many days are pruned.
const LEDGER_DAYS: i64 = 35;
const SANDBOXES: &str = "sandboxes";

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS flags (
       demo TEXT PRIMARY KEY,
       mode TEXT NOT NULL CHECK (mode IN ('live','read-only','off')),
       changed_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS ledger (
       day TEXT NOT NULL,
       meter TEXT NOT NULL,
       value INTEGER NOT NULL,
       PRIMARY KEY (day, meter))",
];

/// `/admit`'s answer: the day's count after this request, and whether this one got in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Admission {
    pub day: String,
    pub sandboxes_today: u32,
    pub sandbox_cap: u32,
    pub admitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pruned {
    pub before: String,
    pub deleted: u32,
}

#[durable_object]
pub struct Control {
    state: State,
    env: Env,
    /// Set once this instance has created its tables and checked its alarm.
    ready: Cell<bool>,
}

impl DurableObject for Control {
    fn new(state: State, env: Env) -> Self {
        Control {
            state,
            env,
            ready: Cell::new(false),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        self.ensure_ready().await?;
        let now = SystemClock::new().now_wall();
        match (req.method(), req.path().as_str()) {
            (Method::Get, "/status") => Response::from_json(&self.status(now)?),
            (Method::Post, "/admit") => Response::from_json(&self.admit(now)?),
            (Method::Post, "/prune") => Response::from_json(&self.prune(now)?),
            _ => Response::error("Not Found", 404),
        }
    }

    async fn alarm(&self) -> Result<Response> {
        self.ensure_ready().await?;
        let now = SystemClock::new().now_wall();
        let pruned = self.prune(now)?;
        // The next midnight is always later than now, so this alarm cannot loop.
        self.arm(now.next_utc_midnight()).await?;
        console_log!(
            "{{\"event\":\"control_alarm\",\"pruned\":{},\"before\":{:?}}}",
            pruned.deleted,
            pruned.before
        );
        Response::empty()
    }
}

impl Control {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    /// Creates the tables and the flag row on first use, and arms the prune alarm on first start.
    async fn ensure_ready(&self) -> Result<()> {
        if self.ready.get() {
            return Ok(());
        }
        let sql = self.sql();
        for statement in SCHEMA {
            sql.exec(statement, None)?;
        }
        let now = SystemClock::new().now_wall();
        sql.exec(
            "INSERT OR IGNORE INTO flags (demo, mode, changed_at) VALUES ('bakery', 'live', ?)",
            vec![now.to_string().into()],
        )?;
        if self.state.storage().get_alarm().await?.is_none() {
            self.arm(now.next_utc_midnight()).await?;
        }
        self.ready.set(true);
        Ok(())
    }

    async fn arm(&self, at: WallTime) -> Result<()> {
        self.state.storage().set_alarm(alarm_time(at)).await
    }

    fn cap(&self) -> u32 {
        sandbox_cap(&self.env)
    }

    fn status(&self, now: WallTime) -> Result<StatusResponse> {
        let sql = self.sql();
        let day = now.utc_day();
        Ok(StatusResponse {
            sandboxes_today: read_meter(&sql, &day, SANDBOXES)?,
            sandbox_cap: self.cap(),
            flag: read_flag(&sql)?,
            day,
        })
    }

    /// Counts one more sandbox for today if the cap allows it: the read, the check and the write
    /// are one SQL transaction, so two requests can never both take the last place.
    fn admit(&self, now: WallTime) -> Result<Admission> {
        let sql = self.sql();
        let day = now.utc_day();
        let cap = self.cap();
        let tx_day = day.clone();
        let (sandboxes_today, admitted) = transaction_sync(&self.state.storage(), move || {
            let current = read_meter(&sql, &tx_day, SANDBOXES)?;
            if current >= cap {
                return Ok((current, false));
            }
            sql.exec(
                "INSERT INTO ledger (day, meter, value) VALUES (?, ?, 1)
                 ON CONFLICT (day, meter) DO UPDATE SET value = value + 1",
                vec![tx_day.as_str().into(), SANDBOXES.into()],
            )?;
            Ok((current + 1, true))
        })?;
        Ok(Admission {
            day,
            sandboxes_today,
            sandbox_cap: cap,
            admitted,
        })
    }

    fn prune(&self, now: WallTime) -> Result<Pruned> {
        let before = now
            .plus_days(-LEDGER_DAYS)
            .map_err(|e| Error::RustError(e.to_string()))?
            .utc_day();
        let cursor = self.sql().exec(
            "DELETE FROM ledger WHERE day < ?",
            vec![before.as_str().into()],
        )?;
        let deleted = u32::try_from(cursor.rows_written()).unwrap_or(u32::MAX);
        Ok(Pruned { before, deleted })
    }
}

#[derive(Deserialize)]
struct ValueRow {
    value: i64,
}

#[derive(Deserialize)]
struct ModeRow {
    mode: String,
}

/// A missing row counts as 0.
fn read_meter(sql: &SqlStorage, day: &str, meter: &str) -> Result<u32> {
    let rows: Vec<ValueRow> = sql
        .exec(
            "SELECT value FROM ledger WHERE day = ? AND meter = ?",
            vec![day.into(), meter.into()],
        )?
        .to_array()?;
    let value = rows.first().map_or(0, |r| r.value);
    Ok(u32::try_from(value).unwrap_or(u32::MAX))
}

/// A missing or unreadable flag reads as `off`: fail closed.
fn read_flag(sql: &SqlStorage) -> Result<Flag> {
    let rows: Vec<ModeRow> = sql
        .exec("SELECT mode FROM flags WHERE demo = 'bakery'", None)?
        .to_array()?;
    Ok(rows
        .first()
        .and_then(|r| Flag::parse(&r.mode))
        .unwrap_or(Flag::Off))
}

pub fn sandbox_cap(env: &Env) -> u32 {
    env.var("SANDBOX_CAP")
        .ok()
        .and_then(|v| v.to_string().parse().ok())
        .unwrap_or(DEFAULT_SANDBOX_CAP)
}

/// Runs `body` inside `storage.transactionSync()`, which workers-rs 0.8.7 does not bind:
/// `Storage::transaction` is the asynchronous key-value transaction. An error from `body` throws
/// inside the callback, so the runtime rolls every write back.
fn transaction_sync<T: 'static>(
    storage: &Storage,
    body: impl FnOnce() -> Result<T> + 'static,
) -> Result<T> {
    let raw: &JsValue = storage.as_raw().as_ref();
    let method: Function = Reflect::get(raw, &JsValue::from_str("transactionSync"))?
        .dyn_into()
        .map_err(|_| Error::RustError("storage.transactionSync is not a function".into()))?;
    let out = std::rc::Rc::new(Cell::new(None));
    let slot = out.clone();
    let callback = Closure::once(move || -> std::result::Result<JsValue, JsValue> {
        match body() {
            Ok(value) => {
                slot.set(Some(value));
                Ok(JsValue::UNDEFINED)
            }
            Err(e) => Err(JsValue::from_str(&e.to_string())),
        }
    });
    method.call1(raw, callback.as_ref().unchecked_ref())?;
    out.take()
        .ok_or_else(|| Error::RustError("transaction returned no value".into()))
}

/// The router's handle on the one `Control` object.
async fn call(env: &Env, method: Method, path: &str) -> Result<Response> {
    let stub = env.durable_object(BINDING)?.get_by_name(NAME)?;
    let mut init = RequestInit::new();
    init.with_method(method);
    // The host is never resolved: a stub's fetch goes to the object, by name.
    let req = Request::new_with_init(&format!("https://{NAME}.internal{path}"), &init)?;
    let res = stub.fetch_with_request(req).await?;
    if res.status_code() != 200 {
        return Err(Error::RustError(format!(
            "control {path} answered {}",
            res.status_code()
        )));
    }
    Ok(res)
}

pub async fn status(env: &Env) -> Result<StatusResponse> {
    call(env, Method::Get, "/status").await?.json().await
}

pub async fn prune(env: &Env) -> Result<Pruned> {
    call(env, Method::Post, "/prune").await?.json().await
}
