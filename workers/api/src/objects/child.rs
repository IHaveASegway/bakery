//! What every sandbox child shares: its `meta` row, the paths the Sandbox calls on it
//! (`/_wipe`, `/_clock`), its 36 h backstop and its business clock (docs/architecture.md,
//! "Object naming": children are born only through the Sandbox; "Time travel").
//!
//! The child protocol, for every class the Sandbox's dispatch table names:
//!
//! - `POST /_wipe {cause}` → 200 `{rows_deleted}`: alarm deleted, then `delete_all`. Idempotent:
//!   an empty object answers `{rows_deleted: 0}`.
//! - `POST /_clock {clock_offset_s, clock_v, event?}` → 200 `{clock_v}`: every timer that moves
//!   with business time gets its wall time recomputed, and the alarm is re-armed for the
//!   earliest; re-arming the time already armed writes nothing. `event` is the `ClockAdvanced`
//!   envelope, which only the Kitchen reads.
//!   An older `clock_v` than the one held changes nothing. 410 when the child has no `meta`.
//! - Every other path on a child with no `meta` row answers 410, except its create path.

use bakery_app::wipe::backstop_at;
use bakery_domain::{BusinessTime, Ulid, WallTime};
use serde::{Deserialize, Serialize};
use worker::{Error, Result, SqlStorage, State};

use super::sql::{exec, first, has_table, user_rows};
use super::stream::{self, BACKSTOP};
use crate::clock::{business_at, wall_at};

pub const META: &str = "CREATE TABLE IF NOT EXISTS meta (
   sandbox TEXT NOT NULL,
   name TEXT NOT NULL,
   born TEXT NOT NULL,
   clock_offset_s INTEGER NOT NULL DEFAULT 0,
   clock_v INTEGER NOT NULL DEFAULT 0)";

/// What the Sandbox hands every child it creates: the child's identity and the business clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Birth {
    pub sandbox: Ulid,
    /// The child's own object name, such as `order:<sandbox>:<ulid>`.
    pub name: String,
    pub clock_offset_s: i64,
    pub clock_v: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Meta {
    pub sandbox: String,
    pub name: String,
    #[allow(dead_code)]
    pub born: String,
    pub clock_offset_s: i64,
    pub clock_v: i64,
}

impl Meta {
    pub fn sandbox_id(&self) -> Result<Ulid> {
        self.sandbox
            .parse()
            .map_err(|_| Error::RustError("meta sandbox".into()))
    }

    /// Business time at the wall time `now`.
    pub fn business(&self, now: WallTime) -> BusinessTime {
        business_at(now, self.clock_offset_s)
    }
}

pub fn meta(sql: &SqlStorage) -> Result<Option<Meta>> {
    if !has_table(sql, "meta")? {
        return Ok(None);
    }
    first(
        sql,
        "SELECT sandbox, name, born, clock_offset_s, clock_v FROM meta",
        vec![],
    )
}

/// The `meta` row and the backstop timer, inside the caller's transaction: the child's first
/// write. The tables must exist already.
pub fn born(sql: &SqlStorage, birth: &Birth, now: WallTime) -> Result<()> {
    exec(
        sql,
        "INSERT INTO meta (sandbox, name, born, clock_offset_s, clock_v) VALUES (?, ?, ?, ?, ?)",
        vec![
            birth.sandbox.to_string().into(),
            birth.name.as_str().into(),
            now.to_string().into(),
            birth.clock_offset_s.into(),
            i64::from(birth.clock_v).into(),
        ],
    )?;
    let backstop = backstop_at(now).map_err(|e| Error::RustError(e.to_string()))?;
    stream::set_timer(sql, BACKSTOP, BACKSTOP, backstop, None)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WipeReport {
    pub rows_deleted: u64,
}

/// `/_wipe`: the rows counted, the alarm deleted, then `delete_all`.
pub async fn wipe(state: &State) -> Result<WipeReport> {
    let storage = state.storage();
    let rows_deleted = if has_table(&storage.sql(), "meta")? {
        user_rows(&storage.sql())?
    } else {
        0
    };
    storage.delete_alarm().await?;
    storage.delete_all().await?;
    Ok(WipeReport { rows_deleted })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClockUpdate {
    pub clock_offset_s: i64,
    pub clock_v: u32,
    /// The `ClockAdvanced` envelope, sent to the Kitchen only, which shows it on the console's
    /// feed; every other child ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<bakery_domain::Envelope>,
}

/// `/_clock`: the new offset, and every business-time timer's wall time recomputed from it.
/// The caller re-arms the alarm. An update older than the one held changes nothing, so the
/// Sandbox's retries are safe.
pub fn clock(sql: &SqlStorage, update: &ClockUpdate) -> Result<bool> {
    let Some(meta) = meta(sql)? else {
        return Ok(false);
    };
    if i64::from(update.clock_v) <= meta.clock_v {
        return Ok(true);
    }
    exec(
        sql,
        "UPDATE meta SET clock_offset_s = ?, clock_v = ?",
        vec![
            update.clock_offset_s.into(),
            i64::from(update.clock_v).into(),
        ],
    )?;
    for t in stream::timers(sql)? {
        let Some(due) = t.due_business.as_deref() else {
            continue;
        };
        let Ok(at) = due.parse::<BusinessTime>() else {
            continue;
        };
        let wall = wall_at(at, update.clock_offset_s);
        stream::set_timer(sql, &t.id, &t.purpose, wall, Some(due))?;
    }
    Ok(true)
}
