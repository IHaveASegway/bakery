//! `Simulator`, one per sandbox, named `simulator:<sandbox>`: simulated traffic, the load the
//! visitor starts and stops from the console (docs/architecture.md, "Simulated traffic";
//! docs/domain.md, "Simulator"; Q40 · Q-traffic). Born on the first "Start traffic", registered
//! with the Sandbox like any other child, so the wipe finds it.
//!
//! It holds the rate, the running flag and the minute ledger. Its one alarm is its `Tick`, a
//! wall-time minute apart while it runs: each tick asks the Kitchen whether the console is still
//! there, spends one of the minutes `Control` granted, and places up to `rate` orders as the
//! seed's other personas through the same path a visitor's order takes (the Sandbox maps the
//! key `sim:<ulid>` to an order ULID and registers it, the Catalog gives the menu, the Order
//! decides), each with `cause: sim:<ulid>`. The orders are drawn from the seed crate's ChaCha,
//! keyed by the sandbox's seed and on the minute's own stream, so a tick that runs again draws
//! the same orders with the same keys and the Orders answer them as replays.
//!
//! Guardrails (docs/cost.md, "Guardrails"): signed-in sandboxes only (the router's scope); at
//! most [`SIMULATOR_MAX_RATE`] orders a wall-time minute, counted across runs, the next refused
//! and logged `sim_rate`; at most `TRAFFIC_MINUTES_CAP` minutes a sandbox a UTC day (30),
//! reserved in `Control` at the start, the start refused and logged `sim_cap` when none is
//! left, and the unused minutes settled at the stop; no socket and no heartbeat for 90 s stops
//! it with `console_closed`; the wipe stops it with `wipe`.
//!
//! Paths:
//!
//! - `POST /_start {key, birth, seed, born, persona, rate}` → 200 `TrafficResponse`: the minutes
//!   reserved, `TrafficStarted {rate, minutes_left}`, the first tick armed for now. A replayed
//!   key answers the first result. 422 `{error: "traffic", rule: "rate"}`; 409 `{error:
//!   "running"}`; 503 `{error: "traffic-cap"}` when today's minutes are spent.
//! - `POST /_stop {key}` → 200 `TrafficResponse`: `TrafficStopped {reason: stop, minutes,
//!   orders}`. Stopping a stopped Simulator changes nothing and answers the same.
//! - `GET /_traffic` → 200 `TrafficResponse`.
//! - `POST /_wipe`: `TrafficStopped {reason: wipe}` sent and the minutes settled while it
//!   runs, then the child protocol's wipe. `POST /_clock`: the child protocol (child.rs); its
//!   timers are all wall time.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_contracts::TrafficResponse;
use bakery_domain::catalog::{ItemStatus, MenuView};
use bakery_domain::order::{DEFAULT_TAX_BP, LineInput, OrderKind};
use bakery_domain::{BusinessTime, Envelope, Ulid, WallTime};
use bakery_seed::{BirthDate, Generator, Seed};
use rand_core::Rng;
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::catalog;
use super::child::{self, Birth, ClockUpdate};
use super::control::{self, ReserveTraffic, SettleTraffic};
use super::kitchen::{self, Presence};
use super::order::{self, Place};
use super::sandbox::{self, OrderSlot, RegisterOrder};
use super::sql::{self, exec, first, gone, json, refuse, replayed, rows, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::{SystemClock, business, business_at};
use crate::config::traffic_minutes_cap;

pub const BINDING: &str = "SIMULATOR";
pub const CLASS: &str = "Simulator";

pub fn name(sandbox: Ulid) -> String {
    format!("simulator:{sandbox}")
}

/// Orders the Simulator may place in one wall-time minute (docs/domain.md, "Simulator": at most
/// 6). Fixed, not a var: the cost.md arithmetic assumes it.
pub const SIMULATOR_MAX_RATE: u8 = 6;
/// A tick finds the console closed when it has seen no socket and no heartbeat for this long
/// (docs/architecture.md, "Simulated traffic": 90 s; the console beats every 30 s).
pub const CONSOLE_WINDOW_MS: i64 = 90_000;
/// One wall-time minute between ticks.
pub const TICK_MS: i64 = 60_000;
/// A simulated order's slot: about four hours after the minute it is drawn in, rounded up to a
/// quarter hour, so most of the menu's lead times are met.
const SLOT_AHEAD_MINUTES: i64 = 240;
/// One simulated order in this many is a delivery.
const DELIVERY_ONE_IN: u32 = 4;
const TICK: &str = "tick";

const SCHEMA: &[&str] = &[
    child::META,
    "CREATE TABLE IF NOT EXISTS sim (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       seed INTEGER NOT NULL,
       running INTEGER NOT NULL DEFAULT 0,
       rate INTEGER NOT NULL DEFAULT 0,
       run TEXT,
       run_day TEXT,
       granted INTEGER NOT NULL DEFAULT 0,
       used INTEGER NOT NULL DEFAULT 0,
       orders INTEGER NOT NULL DEFAULT 0,
       started_at TEXT)",
    // The seed's personas other than the visitor's own: the simulated customers.
    "CREATE TABLE IF NOT EXISTS personas (n INTEGER PRIMARY KEY, id TEXT NOT NULL)",
    // What this sandbox spent each UTC day, for the console.
    "CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, minutes INTEGER NOT NULL, orders INTEGER NOT NULL)",
    // The minute ledger: each wall-time minute a run ticked in, the orders drawn and placed in
    // it, and whether the tick finished. A tick that died resumes its own minute.
    "CREATE TABLE IF NOT EXISTS minutes (
       run TEXT NOT NULL,
       minute INTEGER NOT NULL,
       drawn INTEGER NOT NULL DEFAULT 0,
       placed INTEGER NOT NULL DEFAULT 0,
       done INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (run, minute))",
];

/// `POST /_start`: what the router read from the session, the Sandbox and the request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Start {
    pub key: String,
    pub birth: Birth,
    pub seed: u64,
    /// The sandbox's birth, wall time: with the seed, it regenerates the personas.
    pub born: WallTime,
    /// The visitor's own persona, which the Simulator never orders as.
    pub persona: Ulid,
    pub rate: u8,
}

/// `POST /_stop`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stop {
    pub key: String,
}

/// Why a run ended (docs/domain.md, the event catalog's `TrafficStopped`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Stop,
    ConsoleClosed,
    MinutesSpent,
    Wipe,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StopReason::Stop => "stop",
            StopReason::ConsoleClosed => "console_closed",
            StopReason::MinutesSpent => "minutes_spent",
            StopReason::Wipe => "wipe",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct SimRow {
    seed: i64,
    running: i64,
    rate: i64,
    run: Option<String>,
    run_day: Option<String>,
    granted: i64,
    used: i64,
    orders: i64,
    started_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinuteRow {
    minute: i64,
    drawn: i64,
    placed: i64,
}

// ---------- the rules, pure and tested natively ----------

/// Whether a rate is one the console may ask for: 1 to 6 orders a minute.
pub fn rate_allowed(rate: u8) -> bool {
    (1..=SIMULATOR_MAX_RATE).contains(&rate)
}

/// Whether one more order fits the minute: the seventh is refused.
pub fn may_place(placed_this_minute: u32) -> bool {
    placed_this_minute < u32::from(SIMULATOR_MAX_RATE)
}

/// Whether the console was seen in the last 90 s: an open socket, a heartbeat, or the start
/// itself, which came from the console.
pub fn console_open(
    sockets: usize,
    last_heartbeat: Option<WallTime>,
    started: Option<WallTime>,
    now: WallTime,
) -> bool {
    if sockets > 0 {
        return true;
    }
    let seen = last_heartbeat.max(started);
    seen.is_some_and(|at| now.unix_ms() - at.unix_ms() <= CONSOLE_WINDOW_MS)
}

/// One simulated order, as drawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Drawn {
    pub key: String,
    pub customer: Ulid,
    pub kind: OrderKind,
    pub zone: Option<String>,
    pub slot: BusinessTime,
    pub lines: Vec<LineInput>,
}

/// The PRNG for one minute: the seed crate's ChaCha for the sandbox's seed, on the minute's own
/// stream, so no minute shares draws with the seed's generator (stream 0) or another minute.
fn minute_rng(seed: u64, minute: i64) -> impl Rng {
    let mut rng = Seed(seed).rng();
    rng.set_stream(u64::try_from(minute).unwrap_or(0));
    rng
}

/// A uniform draw below `n`, `n` at least 1.
fn below(rng: &mut impl Rng, n: usize) -> usize {
    (rng.next_u64() % (n.max(1) as u64)) as usize
}

/// The quarter hour at or after `t`, in business time.
fn quarter_after(t: BusinessTime) -> BusinessTime {
    let quarter = 15 * 60_000;
    let ms = t.unix_ms();
    let up = ms.div_euclid(quarter) * quarter
        + if ms.rem_euclid(quarter) == 0 {
            0
        } else {
            quarter
        };
    t.plus_minutes((up - ms) / 60_000).unwrap_or(t)
}

/// Draws the `j`-th order of `minute`: the draws before it are made and dropped, so the same
/// minute and index always give the same order. `None` when the menu has nothing that fits.
pub fn draw(
    seed: u64,
    minute: i64,
    j: u32,
    at: BusinessTime,
    menu: &MenuView,
    personas: &[Ulid],
) -> Option<Drawn> {
    let mut rng = minute_rng(seed, minute);
    let mut last = None;
    for _ in 0..=j {
        last = Some(draw_one(&mut rng, minute, at, menu, personas));
    }
    last.flatten()
}

fn draw_one(
    rng: &mut impl Rng,
    minute: i64,
    at: BusinessTime,
    menu: &MenuView,
    personas: &[Ulid],
) -> Option<Drawn> {
    let random = (u128::from(rng.next_u64()) << 64) | u128::from(rng.next_u64());
    let ms = u64::try_from(minute.saturating_mul(TICK_MS)).unwrap_or(0);
    let key = format!("sim:{}", Ulid::from_parts(ms, random));
    let customer = *personas.get(below(rng, personas.len()))?;
    let delivery = rng.next_u32().is_multiple_of(DELIVERY_ONE_IN);
    let kind = if delivery {
        OrderKind::Delivery
    } else {
        OrderKind::Pickup
    };
    let zone =
        delivery.then(|| bakery_seed::ZONES[below(rng, bakery_seed::ZONES.len())].to_owned());
    let slot = quarter_after(at.plus_minutes(SLOT_AHEAD_MINUTES).ok()?);
    let ahead = u32::try_from(SLOT_AHEAD_MINUTES - 15).unwrap_or(0);
    let fits: Vec<(&str, u16)> = menu
        .categories
        .iter()
        .flat_map(|c| &c.items)
        .filter(|i| {
            i.status == ItemStatus::Available
                && i.baked_on(slot)
                && i.in_season_on(slot)
                && !(delivery && i.pickup_only)
        })
        .flat_map(|i| {
            // Under the bulk rule's threshold, so no line needs the longer lead.
            let most = i.bulk_lead.map_or(3, |b| b.over_qty.clamp(1, 3));
            let most = u16::try_from(most).unwrap_or(1);
            i.variants
                .iter()
                .filter(move |v| v.lead_minutes <= ahead)
                .map(move |v| (v.slug.as_str(), most))
        })
        .collect();
    let count = 1 + below(rng, 3);
    let mut lines: Vec<LineInput> = Vec::new();
    for _ in 0..count {
        if fits.is_empty() {
            break;
        }
        let (variant, most) = fits[below(rng, fits.len())];
        let qty = 1 + u16::try_from(below(rng, usize::from(most))).unwrap_or(0);
        if lines.iter().any(|l| l.variant == variant) {
            continue;
        }
        lines.push(LineInput {
            variant: variant.to_owned(),
            qty,
        });
    }
    if lines.is_empty() {
        return None;
    }
    Some(Drawn {
        key,
        customer,
        kind,
        zone,
        slot,
        lines,
    })
}

// ---------- the object ----------

#[durable_object]
pub struct Simulator {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Simulator {
    fn new(state: State, env: Env) -> Self {
        Simulator {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_start") => {
                let body: Start = sql::body(&mut req).await?;
                self.start(body, now).await
            }
            (Method::Post, "/_wipe") => {
                if let Some(meta) = child::meta(&self.sql())?
                    && self.sim()?.is_some_and(|s| s.running != 0)
                {
                    self.stop(&meta, StopReason::Wipe, now).await?;
                    // The object is about to be emptied: send the event now, not later.
                    stream::relay(&self.state.storage(), &self.env, CLASS).await?;
                }
                json(&child::wipe(&self.state).await?, 200)
            }
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Get, "/_traffic") => json(&self.view(now)?, 200),
                    (Method::Post, "/_stop") => {
                        let _: Stop = sql::body(&mut req).await?;
                        if self.sim()?.is_some_and(|s| s.running != 0) {
                            self.stop(&meta, StopReason::Stop, now).await?;
                        }
                        json(&self.view(now)?, 200)
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
                TICK => self.tick(&meta, now).await?,
                OUTBOX => stream::outbox_timer(&storage, &self.env, now, CLASS).await?,
                BACKSTOP => {
                    console_log!("{{\"event\":\"backstop\",\"object\":\"{CLASS}\"}}");
                    child::wipe(&self.state).await?;
                    return Response::empty();
                }
                _ => stream::delete_timer(&storage.sql(), &timer.id)?,
            }
        }
        stream::arm(&storage, now).await?;
        Response::empty()
    }
}

impl Simulator {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn sim(&self) -> Result<Option<SimRow>> {
        if !sql::has_table(&self.sql(), "sim")? {
            return Ok(None);
        }
        first(
            &self.sql(),
            "SELECT seed, running, rate, run, run_day, granted, used, orders, started_at FROM sim",
            vec![],
        )
    }

    fn today(&self, now: WallTime) -> Result<(u16, u16)> {
        #[derive(Deserialize)]
        struct Day {
            minutes: i64,
            orders: i64,
        }
        let day: Option<Day> = first(
            &self.sql(),
            "SELECT minutes, orders FROM days WHERE day = ?",
            vec![now.utc_day().into()],
        )?;
        Ok(day.map_or((0, 0), |d| {
            (
                u16::try_from(d.minutes).unwrap_or(u16::MAX),
                u16::try_from(d.orders).unwrap_or(u16::MAX),
            )
        }))
    }

    /// `TrafficResponse`: the run's rate and state, and today's minutes and orders.
    fn view(&self, now: WallTime) -> Result<TrafficResponse> {
        let sim = self.sim()?;
        let (minutes_used, orders) = self.today(now)?;
        Ok(TrafficResponse {
            running: sim.as_ref().is_some_and(|s| s.running != 0),
            rate: sim
                .as_ref()
                .map_or(0, |s| u8::try_from(s.rate).unwrap_or(0)),
            minutes_used,
            minutes_left: traffic_minutes_cap(&self.env).saturating_sub(minutes_used),
            orders,
        })
    }

    fn personas(&self) -> Result<Vec<Ulid>> {
        #[derive(Deserialize)]
        struct P {
            id: String,
        }
        let found: Vec<P> = rows(&self.sql(), "SELECT id FROM personas ORDER BY n", vec![])?;
        Ok(found
            .into_iter()
            .filter_map(|p| p.id.parse().ok())
            .collect())
    }

    /// The first start: the tables, `meta` with the backstop, and the seed's other personas,
    /// regenerated from the seed once and kept.
    fn create(&self, s: &Start, now: WallTime) -> Result<()> {
        if !self.schema_ready.get() {
            stream::create_schema(&self.sql(), SCHEMA)?;
            self.schema_ready.set(true);
        }
        let birth_date = business(s.born).to_string();
        let date = BirthDate::parse(&birth_date[..10])
            .map_err(|e| Error::RustError(format!("birth date: {e}")))?;
        let personas: Vec<String> = Generator::new(Seed(s.seed), date)
            .generate()
            .customers
            .into_iter()
            .map(|c| c.id)
            .filter(|id| *id != s.persona)
            .map(|id| id.to_string())
            .collect();
        let sql = self.sql();
        let birth = s.birth.clone();
        let seed = i64::try_from(s.seed).map_err(|_| Error::RustError("seed over 2^63".into()))?;
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)?;
            exec(
                &sql,
                "INSERT INTO sim (id, seed) VALUES (1, ?)",
                vec![seed.into()],
            )?;
            for (n, id) in personas.into_iter().enumerate() {
                exec(
                    &sql,
                    "INSERT INTO personas (n, id) VALUES (?, ?)",
                    vec![i64::try_from(n).unwrap_or(0).into(), id.into()],
                )?;
            }
            Ok(())
        })
    }

    /// `StartTraffic`: the minutes reserved in `Control`, then the run, its event and its first
    /// tick in one transaction.
    async fn start(&self, s: Start, now: WallTime) -> Result<Response> {
        if !rate_allowed(s.rate) {
            return json(
                &serde_json::json!({ "error": "traffic", "rule": "rate" }),
                422,
            );
        }
        let meta = match child::meta(&self.sql())? {
            Some(m) => m,
            None => {
                self.create(&s, now)?;
                child::meta(&self.sql())?
                    .ok_or_else(|| Error::RustError("meta not written".into()))?
            }
        };
        let sql = self.sql();
        if let Some(seen) = stream::seen(&sql, &s.key)? {
            return replayed(&seen.result);
        }
        if self.sim()?.is_some_and(|r| r.running != 0) {
            return refuse(409, "running");
        }
        let sandbox = meta.sandbox_id()?;
        let grant = control::reserve_traffic(
            &self.env,
            &ReserveTraffic {
                key: s.key.clone(),
                sandbox,
                minutes: traffic_minutes_cap(&self.env),
            },
        )
        .await?;
        if grant.granted == 0 {
            console_log!(
                "{{\"event\":\"sim_cap\",\"sandbox\":\"{sandbox}\",\"used\":{},\"cap\":{}}}",
                grant.used,
                grant.cap
            );
            return refuse(503, "traffic-cap");
        }
        let event = self.envelope(
            &meta,
            now,
            "TrafficStarted",
            serde_json::json!({ "rate": s.rate, "minutes_left": grant.granted }),
            &s.key,
        )?;
        let (key, rate, day) = (s.key.clone(), i64::from(s.rate), now.utc_day());
        let granted = i64::from(grant.granted);
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "UPDATE sim SET running = 1, rate = ?, run = ?, run_day = ?, granted = ?, used = 0,
                   orders = 0, started_at = ?",
                vec![
                    rate.into(),
                    key.as_str().into(),
                    day.into(),
                    granted.into(),
                    now.to_string().into(),
                ],
            )?;
            stream::append(&sql, std::slice::from_ref(&event))?;
            stream::set_timer(&sql, TICK, TICK, now, None)?;
            Ok(())
        })?;
        let answer = serde_json::to_string(&self.view(now)?)?;
        stream::remember(&self.sql(), &s.key, "", &answer, now)?;
        console_log!(
            "{{\"event\":\"sim_started\",\"sandbox\":\"{sandbox}\",\"rate\":{},\"granted\":{}}}",
            s.rate,
            grant.granted
        );
        stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        Ok(Response::ok(answer)?.with_headers({
            let h = worker::Headers::new();
            h.set("Content-Type", "application/json")?;
            h
        }))
    }

    /// `StopTraffic`: the run ends with its event, the tick is dropped, and `Control` gets back
    /// the minutes the run did not use.
    async fn stop(&self, meta: &child::Meta, reason: StopReason, now: WallTime) -> Result<()> {
        let Some(run) = self.sim()?.filter(|s| s.running != 0) else {
            return Ok(());
        };
        let key = run.run.clone().unwrap_or_default();
        let event = self.envelope(
            meta,
            now,
            "TrafficStopped",
            serde_json::json!({
                "reason": reason.as_str(),
                "minutes": run.used,
                "orders": run.orders,
            }),
            &key,
        )?;
        let sql = self.sql();
        transaction_sync(&self.state.storage(), move || {
            exec(&sql, "UPDATE sim SET running = 0", vec![])?;
            stream::append(&sql, std::slice::from_ref(&event))?;
            stream::delete_timer(&sql, TICK)?;
            Ok(())
        })?;
        let sandbox = meta.sandbox_id()?;
        let unused = u16::try_from((run.granted - run.used).max(0)).unwrap_or(0);
        if let Err(e) = control::settle_traffic(
            &self.env,
            &SettleTraffic {
                key: key.clone(),
                sandbox,
                day: run.run_day.clone().unwrap_or_else(|| now.utc_day()),
                unused,
            },
        )
        .await
        {
            // The ledger keeps the whole reservation: the day's cap errs low, never high.
            console_log!(
                "{{\"event\":\"settle_error\",\"sandbox\":\"{sandbox}\",\"error\":{:?}}}",
                e.to_string()
            );
        }
        console_log!(
            "{{\"event\":\"sim_stopped\",\"sandbox\":\"{sandbox}\",\"reason\":\"{}\",\"minutes\":{},\"orders\":{}}}",
            reason.as_str(),
            run.used,
            run.orders
        );
        if reason != StopReason::Wipe {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        }
        Ok(())
    }

    /// The Simulator's own event, on its stream `simulator:<sandbox>`.
    fn envelope(
        &self,
        meta: &child::Meta,
        now: WallTime,
        event_type: &str,
        data: serde_json::Value,
        cause: &str,
    ) -> Result<Envelope> {
        let sandbox = meta.sandbox_id()?;
        Ok(Envelope {
            v: bakery_domain::ENVELOPE_VERSION,
            id: crate::random::ulid(now)?,
            sandbox,
            stream: meta.name.clone(),
            seq: stream::head(&self.sql(), sandbox, &meta.name)?.last_seq + 1,
            event_type: event_type.into(),
            at: meta.business(now),
            recorded_at: now,
            data,
            cause: Some(cause.to_owned()),
        })
    }

    /// One `Tick`: the console check, one minute spent, up to `rate` orders, the next tick.
    async fn tick(&self, meta: &child::Meta, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let Some(run) = self.sim()?.filter(|s| s.running != 0) else {
            stream::delete_timer(&sql, TICK)?;
            return Ok(());
        };
        let sandbox = meta.sandbox_id()?;
        let presence = self.presence(sandbox).await;
        let started = run.started_at.as_deref().and_then(|t| t.parse().ok());
        let open = presence
            .as_ref()
            .is_some_and(|p| console_open(p.sockets, p.last_heartbeat, started, now));
        if !open {
            return self.stop(meta, StopReason::ConsoleClosed, now).await;
        }
        let run_key = run.run.clone().unwrap_or_default();
        let unfinished: Option<MinuteRow> = first(
            &sql,
            "SELECT minute, drawn, placed FROM minutes WHERE run = ? AND done = 0",
            vec![run_key.as_str().into()],
        )?;
        let minute = match unfinished {
            Some(m) => m,
            None => {
                if run.used >= run.granted {
                    return self.stop(meta, StopReason::MinutesSpent, now).await;
                }
                let minute = now.unix_ms().div_euclid(TICK_MS);
                let (key, day) = (run_key.clone(), now.utc_day());
                let sql = self.sql();
                transaction_sync(&self.state.storage(), move || {
                    exec(
                        &sql,
                        "INSERT OR IGNORE INTO minutes (run, minute) VALUES (?, ?)",
                        vec![key.into(), minute.into()],
                    )?;
                    exec(&sql, "UPDATE sim SET used = used + 1", vec![])?;
                    exec(
                        &sql,
                        "INSERT INTO days (day, minutes, orders) VALUES (?, 1, 0)
                         ON CONFLICT (day) DO UPDATE SET minutes = minutes + 1",
                        vec![day.into()],
                    )?;
                    Ok(())
                })?;
                MinuteRow {
                    minute,
                    drawn: 0,
                    placed: 0,
                }
            }
        };
        self.place_orders(meta, &run, &run_key, &minute, now)
            .await?;
        exec(
            &sql,
            "UPDATE minutes SET done = 1 WHERE run = ? AND minute = ?",
            vec![run_key.as_str().into(), minute.minute.into()],
        )?;
        if stream::may_rearm(&sql, now, CLASS)? {
            stream::set_timer(&sql, TICK, TICK, stream::after(now, TICK_MS)?, None)?;
            Ok(())
        } else {
            self.stop(meta, StopReason::MinutesSpent, now).await
        }
    }

    async fn presence(&self, sandbox: Ulid) -> Option<Presence> {
        let mut res = sql::call_empty(
            &self.env,
            kitchen::BINDING,
            &kitchen::name(sandbox),
            Method::Get,
            "/_presence",
        )
        .await
        .ok()?;
        if res.status_code() != 200 {
            return None;
        }
        serde_json::from_str(&res.text().await.ok()?).ok()
    }

    /// The minute's orders, from where a tick that died left off. Each is counted as it is
    /// placed, so a rerun redraws only the one in flight, which its Order answers as a replay.
    async fn place_orders(
        &self,
        meta: &child::Meta,
        run: &SimRow,
        run_key: &str,
        minute: &MinuteRow,
        now: WallTime,
    ) -> Result<()> {
        let sql = self.sql();
        let sandbox = meta.sandbox_id()?;
        let seed = u64::try_from(run.seed).unwrap_or(0);
        let rate = i64::from(u8::try_from(run.rate).unwrap_or(0));
        // Every run's orders in this wall-time minute count against the six.
        #[derive(Deserialize)]
        struct Sum {
            drawn: Option<i64>,
            placed: Option<i64>,
        }
        let others: Option<Sum> = first(
            &sql,
            "SELECT sum(drawn) AS drawn, sum(placed) AS placed FROM minutes WHERE minute = ? AND run <> ?",
            vec![minute.minute.into(), run_key.into()],
        )?;
        let (other_drawn, other_placed) =
            others.map_or((0, 0), |s| (s.drawn.unwrap_or(0), s.placed.unwrap_or(0)));
        let mut drawn = minute.drawn;
        let mut placed = minute.placed;
        if drawn >= rate {
            return Ok(());
        }
        let menu = self.menu(sandbox).await?;
        let personas = self.personas()?;
        let at = business_at(
            WallTime::from_unix_ms(minute.minute * TICK_MS)
                .map_err(|e| Error::RustError(e.to_string()))?,
            meta.clock_offset_s,
        );
        while drawn < rate {
            let in_minute = u32::try_from(other_placed + placed).unwrap_or(u32::MAX);
            if !may_place(in_minute) {
                console_log!(
                    "{{\"event\":\"sim_rate\",\"sandbox\":\"{sandbox}\",\"minute\":{},\"placed\":{in_minute}}}",
                    minute.minute
                );
                break;
            }
            let j = u32::try_from(other_drawn + drawn).unwrap_or(u32::MAX);
            drawn += 1;
            let outcome = match draw(seed, minute.minute, j, at, &menu, &personas) {
                Some(d) => self.place(meta, &d, &menu, now).await?,
                None => Placed::Refused("nothing-fits".into()),
            };
            let counted = matches!(outcome, Placed::New | Placed::Replayed);
            if counted {
                placed += 1;
            }
            let (key, day, m) = (run_key.to_owned(), now.utc_day(), minute.minute);
            let sql = self.sql();
            let add = i64::from(counted);
            transaction_sync(&self.state.storage(), move || {
                exec(
                    &sql,
                    "UPDATE minutes SET drawn = drawn + 1, placed = placed + ? WHERE run = ? AND minute = ?",
                    vec![add.into(), key.into(), m.into()],
                )?;
                exec(&sql, "UPDATE sim SET orders = orders + ?", vec![add.into()])?;
                exec(
                    &sql,
                    "INSERT INTO days (day, minutes, orders) VALUES (?, 0, ?)
                     ON CONFLICT (day) DO UPDATE SET orders = orders + excluded.orders",
                    vec![day.into(), add.into()],
                )?;
                Ok(())
            })?;
            match outcome {
                Placed::Refused(rule) => console_log!(
                    "{{\"event\":\"sim_refused\",\"sandbox\":\"{sandbox}\",\"rule\":{rule:?}}}"
                ),
                Placed::Stop => break,
                Placed::New | Placed::Replayed => {}
            }
        }
        console_log!(
            "{{\"event\":\"sim_tick\",\"sandbox\":\"{sandbox}\",\"minute\":{},\"drawn\":{drawn},\"placed\":{placed}}}",
            minute.minute
        );
        Ok(())
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

    /// One simulated order through the visitor's path: the Sandbox registers the key's order,
    /// the Order decides with the menu just read.
    async fn place(
        &self,
        meta: &child::Meta,
        d: &Drawn,
        menu: &MenuView,
        _now: WallTime,
    ) -> Result<Placed> {
        let sandbox = meta.sandbox_id()?;
        let mut res = sql::call(
            &self.env,
            sandbox::BINDING,
            &bakery_app::names::sandbox_object_name(sandbox),
            Method::Post,
            "/_register-order",
            Some(&RegisterOrder { key: d.key.clone() }),
        )
        .await?;
        let slot: OrderSlot = match res.status_code() {
            200 => serde_json::from_str(&res.text().await?)?,
            // Wiped, or being wiped: nothing more this minute.
            _ => return Ok(Placed::Stop),
        };
        let name = order::name(sandbox, slot.order);
        let body_hash = crate::http::body_hash(&serde_json::to_string(d)?);
        let mut res = sql::call(
            &self.env,
            order::BINDING,
            &name,
            Method::Post,
            "/_place",
            Some(&Place {
                key: d.key.clone(),
                body_hash,
                birth: Birth {
                    sandbox,
                    name: name.clone(),
                    clock_offset_s: slot.clock_offset_s,
                    clock_v: slot.clock_v,
                },
                order: slot.order,
                customer: d.customer,
                kind: d.kind,
                slot: d.slot,
                zone: d.zone.clone(),
                lines: d.lines.clone(),
                note: None,
                menu: menu.clone(),
                tax_bp: DEFAULT_TAX_BP,
                cause: Some(d.key.clone()),
            }),
        )
        .await?;
        Ok(match res.status_code() {
            201 => Placed::New,
            200 => Placed::Replayed,
            422 => {
                #[derive(Default, Deserialize)]
                struct Refused {
                    #[serde(default)]
                    error: String,
                    #[serde(default)]
                    rule: Option<String>,
                }
                let r: Refused = serde_json::from_str(&res.text().await?).unwrap_or_default();
                Placed::Refused(r.rule.unwrap_or(r.error))
            }
            _ => Placed::Stop,
        })
    }
}

enum Placed {
    New,
    Replayed,
    Refused(String),
    Stop,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> WallTime {
        s.parse().unwrap()
    }

    #[test]
    fn rates_one_to_six() {
        assert!(!rate_allowed(0));
        for r in 1..=6 {
            assert!(rate_allowed(r));
        }
        assert!(!rate_allowed(7));
    }

    #[test]
    fn the_seventh_order_in_a_minute_is_refused() {
        for n in 0..6 {
            assert!(may_place(n));
        }
        assert!(!may_place(6));
        assert!(!may_place(7));
    }

    #[test]
    fn the_console_is_open_for_90_seconds_after_it_was_seen() {
        let now = t("2026-11-07T16:00:00.000Z");
        let at = |s: &str| Some(t(s));
        assert!(console_open(1, None, None, now), "a socket is enough");
        assert!(console_open(0, at("2026-11-07T15:58:30.000Z"), None, now));
        assert!(!console_open(0, at("2026-11-07T15:58:29.999Z"), None, now));
        assert!(
            console_open(0, None, at("2026-11-07T15:59:00.000Z"), now),
            "the start counts"
        );
        assert!(!console_open(0, None, None, now));
        assert!(console_open(
            0,
            at("2026-11-07T15:50:00.000Z"),
            at("2026-11-07T15:59:00.000Z"),
            now
        ));
    }

    fn menu() -> MenuView {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "categories": [{
                "slug": "breads", "name": "Breads",
                "items": [{
                    "slug": "fern-loaf", "name": "Fern loaf", "allergens": ["wheat"],
                    "daily_cap": 40,
                    "days_baked": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
                    "season": null, "bulk_lead": {"over_qty": 4, "lead_minutes": 1440},
                    "pickup_only": false, "status": "available",
                    "variants": [
                        {"slug": "fern-loaf/whole", "label": "Whole", "price_cents": 950, "lead_minutes": 60},
                        {"slug": "fern-loaf/slow", "label": "Slow", "price_cents": 990, "lead_minutes": 2880}
                    ]
                }, {
                    "slug": "paused-bun", "name": "Paused bun", "allergens": [],
                    "daily_cap": 10, "days_baked": ["mon"], "season": null, "bulk_lead": null,
                    "pickup_only": false, "status": "paused",
                    "variants": [{"slug": "paused-bun/one", "label": "One", "price_cents": 300, "lead_minutes": 0}]
                }]
            }]
        }))
        .unwrap()
    }

    #[test]
    fn a_minute_draws_the_same_orders_every_time_and_only_what_fits() {
        let at: BusinessTime = "2026-11-07T09:01:00-07:00".parse().unwrap();
        let personas = [Ulid::from_parts(1, 1), Ulid::from_parts(1, 2)];
        let minute = 29_000_000;
        let first: Vec<Drawn> = (0..6)
            .filter_map(|j| draw(42, minute, j, at, &menu(), &personas))
            .collect();
        let again: Vec<Drawn> = (0..6)
            .filter_map(|j| draw(42, minute, j, at, &menu(), &personas))
            .collect();
        assert_eq!(first, again);
        assert_eq!(first.len(), 6);
        let keys: std::collections::BTreeSet<_> = first.iter().map(|d| d.key.clone()).collect();
        assert_eq!(keys.len(), 6, "every order has its own key");
        for d in &first {
            assert!(d.key.starts_with("sim:"));
            assert!(personas.contains(&d.customer));
            assert_eq!(d.slot.to_string(), "2026-11-07T13:15:00-07:00");
            assert_eq!(d.zone.is_some(), d.kind == OrderKind::Delivery);
            for l in &d.lines {
                assert_eq!(
                    l.variant, "fern-loaf/whole",
                    "the slow variant and the paused item never fit"
                );
                assert!((1..=3).contains(&l.qty));
            }
        }
        let next = draw(42, minute + 1, 0, at, &menu(), &personas).unwrap();
        assert_ne!(next.key, first[0].key, "another minute, another stream");
        assert!(
            draw(42, minute, 0, at, &menu(), &[]).is_none(),
            "no personas, no order"
        );
    }

    #[test]
    fn quarter_hours() {
        let b: BusinessTime = "2026-11-07T09:01:00-07:00".parse().unwrap();
        assert_eq!(quarter_after(b).to_string(), "2026-11-07T09:15:00-07:00");
        let b: BusinessTime = "2026-11-07T09:15:00-07:00".parse().unwrap();
        assert_eq!(quarter_after(b).to_string(), "2026-11-07T09:15:00-07:00");
    }
}
