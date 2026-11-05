//! `Customer`, one per sandbox and persona, named `customer:<sandbox>:<ULID>` (docs/domain.md,
//! "Ubiquitous language": Customer, Loyalty; docs/architecture.md, "Durable Object topology"). It
//! hosts the domain's `Customer` aggregate: one persona's consent flag and loyalty balance, the
//! fold of its own `events`.
//!
//! It is created on first touch, never at seeding: the router (a consent change) or the consumer
//! (`OrderPaid`, `OrderRefunded`) registers it with the Sandbox first, which answers its birth
//! and the persona's synthetic profile, consent and opening points from the seed
//! (`/_register-customer`). The object decides `Register` from that, then the command, in the
//! same transaction.
//!
//! Paths (the Worker builds them):
//!
//! - `POST /_command {key, body_hash, birth?, register?, cmd}` → 200 `CustomerOut`; 200 with
//!   `Idempotent-Replayed: true` for a key seen with the same body; 422 `{error: "key-reused"}`
//!   for one seen with another; 422 `{error: "customer", rule}` for a refused command. `cmd` is
//!   [`Cmd`]: `set_consent {marketing}`. On an object with no `meta`, `birth` and `register` are
//!   required (410 without them).
//! - `POST /_event {envelope, birth?, register?}` from the consumer → 200 `{outcome}`:
//!   `OrderPaid` is `EarnPoints`, `OrderRefunded` is `ReversePoints`, each under the key
//!   `evt:<event id>`, so a redelivery is `duplicate`; anything else is `ignored`. 410 on an
//!   object with no `meta` and no `birth`: the consumer registers it and sends again.
//! - `GET /_state` → 200 `CustomerOut`.
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs).
//!
//! Timers: `outbox` and `backstop`, as every child. Log lines carry ids and rule codes only.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_domain::customer::{
    Customer as Aggregate, CustomerCommand, CustomerError, CustomerEvent as Event, CustomerState,
    Profile,
};
use bakery_domain::outbox::{CommandCheck, Stamp, StreamHead, check_command, envelopes};
use bakery_domain::{
    Cents, DecideContext, DomainEvent, Envelope, Ulid, WallTime, execute, replay_from,
};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::sql::{self, gone, has_table, json, refuse, replayed, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::{SystemClock, business_at};
use crate::random;

pub const BINDING: &str = "CUSTOMER";
pub const CLASS: &str = "Customer";

pub fn name(sandbox: Ulid, customer: Ulid) -> String {
    format!("customer:{sandbox}:{customer}")
}

const SCHEMA: &[&str] = &[child::META];

/// The persona as the seed made it, which the Sandbox hands a Customer at its first touch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterIn {
    pub profile: Profile,
    pub marketing: bool,
    pub opening_points: u32,
}

/// A customer command as the router sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    SetConsent { marketing: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandIn {
    pub key: String,
    #[serde(default)]
    pub body_hash: String,
    #[serde(default)]
    pub birth: Option<Birth>,
    #[serde(default)]
    pub register: Option<RegisterIn>,
    pub cmd: Cmd,
}

/// One delivery from the consumer, with the birth the Sandbox gave when the object was unborn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventIn {
    pub envelope: Envelope,
    #[serde(default)]
    pub birth: Option<Birth>,
    #[serde(default)]
    pub register: Option<RegisterIn>,
}

/// What the object answers: the consent and the balance as its own fold holds them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomerOut {
    pub customer: Ulid,
    pub marketing: bool,
    pub balance: i64,
}

#[durable_object]
pub struct Customer {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Customer {
    fn new(state: State, env: Env) -> Self {
        Customer {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_command") => {
                let body: CommandIn = sql::body(&mut req).await?;
                self.command(body, now).await
            }
            (Method::Post, "/_event") => {
                let body: EventIn = sql::body(&mut req).await?;
                self.event(body, now).await
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
                        match out_of(&state) {
                            Some(o) => json(&o, 200),
                            None => refuse(404, "not-found"),
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
        if child::meta(&storage.sql())?.is_none() {
            storage.delete_all().await?;
            return Response::empty();
        }
        for timer in stream::due(&storage.sql(), now)? {
            match timer.purpose.as_str() {
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

/// The customer's id, from its object name.
fn customer_of(name: &str) -> Option<Ulid> {
    name.rsplit(':').next()?.parse().ok()
}

fn out_of(state: &CustomerState) -> Option<CustomerOut> {
    Some(CustomerOut {
        customer: state.customer()?,
        marketing: state.marketing(),
        balance: state.balance(),
    })
}

/// The command an order event is for this customer, or `None` for one it ignores.
pub fn command_of(envelope: &Envelope) -> Option<CustomerCommand> {
    let order: Ulid = envelope.stream.rsplit(':').next()?.parse().ok()?;
    let field = |n: &str| envelope.data.get(n);
    let cents = |n: &str| field(n).and_then(serde_json::Value::as_i64).map(Cents);
    match envelope.event_type.as_str() {
        "OrderPaid" => Some(CustomerCommand::EarnPoints {
            order,
            amount: cents("amount_cents")?,
        }),
        "OrderRefunded" => Some(CustomerCommand::ReversePoints {
            order,
            refund: field("refund")?.as_str()?.parse().ok()?,
            amount: cents("amount_cents")?,
            full: field("full")?.as_bool()?,
        }),
        _ => None,
    }
}

/// What a decided change writes.
struct Write {
    birth: Birth,
    first_write: bool,
    existing_last: u64,
    at: bakery_domain::BusinessTime,
    cause: Option<String>,
    events: Vec<Event>,
    key: (String, String),
    answer: String,
}

impl Customer {
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

    fn birth_of(meta: &child::Meta) -> Result<Birth> {
        Ok(Birth {
            sandbox: meta.sandbox_id()?,
            name: meta.name.clone(),
            clock_offset_s: meta.clock_offset_s,
            clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
        })
    }

    fn load(&self, meta: &child::Meta) -> Result<(CustomerState, u64)> {
        if !has_table(&self.sql(), "events")? {
            return Ok((CustomerState::default(), 0));
        }
        let envelopes = stream::events(&self.sql(), meta.sandbox_id()?, &meta.name)?;
        let decoded: Vec<Event> = envelopes
            .iter()
            .map(Event::from_envelope)
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| Error::RustError(e.to_string()))?;
        Ok((
            replay_from::<Aggregate>(CustomerState::default(), &decoded),
            envelopes.last().map_or(0, |e| e.seq),
        ))
    }

    /// Where the object stands: its birth and fold, or the birth it is about to be born with.
    /// `None` for an unborn object given no birth.
    fn standing(
        &self,
        birth: Option<&Birth>,
        register: Option<&RegisterIn>,
    ) -> Result<Option<Standing>> {
        match child::meta(&self.sql())? {
            Some(m) => {
                if let Some(b) = birth
                    && (b.name != m.name || b.sandbox.to_string() != m.sandbox)
                {
                    return Err(Error::RustError("identity".into()));
                }
                let (state, last) = self.load(&m)?;
                Ok(Some(Standing {
                    birth: Self::birth_of(&m)?,
                    first_write: false,
                    state,
                    last,
                }))
            }
            None => match (birth, register) {
                (Some(b), Some(_)) => Ok(Some(Standing {
                    birth: b.clone(),
                    first_write: true,
                    state: CustomerState::default(),
                    last: 0,
                })),
                _ => Ok(None),
            },
        }
    }

    /// `Register` from the persona, when the object is new, then `cmd`, on the same fold.
    fn decide(
        s: &Standing,
        register: Option<&RegisterIn>,
        cmd: &CustomerCommand,
        ctx: &DecideContext,
    ) -> std::result::Result<(CustomerState, Vec<Event>), CustomerError> {
        let mut state = s.state.clone();
        let mut events = Vec::new();
        if state.profile().is_none() {
            let customer = customer_of(&s.birth.name).ok_or(CustomerError::NotRegistered)?;
            let r = register.ok_or(CustomerError::NotRegistered)?;
            let (next, more) = execute::<Aggregate>(
                state,
                &CustomerCommand::Register {
                    customer,
                    profile: r.profile.clone(),
                    marketing: r.marketing,
                    opening_points: r.opening_points,
                },
                ctx,
            )?;
            state = next;
            events.extend(more);
        }
        let (state, more) = execute::<Aggregate>(state, cmd, ctx)?;
        events.extend(more);
        Ok((state, events))
    }

    async fn command(&self, c: CommandIn, now: WallTime) -> Result<Response> {
        let Some(s) = self.standing(c.birth.as_ref(), c.register.as_ref())? else {
            return gone();
        };
        if !s.first_write {
            let seen = stream::seen(&self.sql(), &c.key)?;
            match check_command(seen.as_ref(), &c.body_hash) {
                Ok(CommandCheck::Replay(result)) => return replayed(result),
                Ok(CommandCheck::Fresh) => {}
                Err(_) => return refuse(422, "key-reused"),
            }
        }
        let id: Ulid = c
            .key
            .rsplit(':')
            .next()
            .and_then(|k| k.parse().ok())
            .map_or_else(|| random::ulid(now), Ok)?;
        let ctx = DecideContext {
            now: business_at(now, s.birth.clock_offset_s),
            id,
        };
        let Cmd::SetConsent { marketing } = c.cmd;
        let cmd = CustomerCommand::SetConsent { marketing };
        let (state, events) = match Self::decide(&s, c.register.as_ref(), &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => {
                return json(
                    &serde_json::json!({ "error": "customer", "rule": e.rule() }),
                    422,
                );
            }
        };
        let out = out_of(&state).ok_or_else(|| Error::RustError("no customer".into()))?;
        let answer = serde_json::to_string(&out)?;
        if s.first_write {
            self.ensure_schema()?;
        }
        self.write(
            Write {
                birth: s.birth,
                first_write: s.first_write,
                existing_last: s.last,
                at: ctx.now,
                cause: Some(c.key.clone()),
                events,
                key: (c.key, c.body_hash),
                answer: answer.clone(),
            },
            now,
        )
        .await?;
        let mut res = Response::ok(answer)?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }

    async fn event(&self, e: EventIn, now: WallTime) -> Result<Response> {
        let Some(s) = self.standing(e.birth.as_ref(), e.register.as_ref())? else {
            return gone();
        };
        let envelope = e.envelope;
        if envelope.sandbox != s.birth.sandbox {
            return refuse(422, "envelope");
        }
        let Some(cmd) = command_of(&envelope) else {
            return json(&serde_json::json!({ "outcome": "ignored" }), 200);
        };
        let key = format!("evt:{}", envelope.id);
        if !s.first_write && stream::seen(&self.sql(), &key)?.is_some() {
            return json(&serde_json::json!({ "outcome": "duplicate" }), 200);
        }
        let ctx = DecideContext {
            now: business_at(now, s.birth.clock_offset_s),
            id: envelope.id,
        };
        let (_, events) = match Self::decide(&s, e.register.as_ref(), &cmd, &ctx) {
            Ok(done) => done,
            Err(err) => {
                // A retry cannot fix a rule the event breaks: logged by its rule and acked.
                console_log!(
                    "{{\"event\":\"customer_event_refused\",\"id\":\"{}\",\"type\":{:?},\"rule\":\"{}\"}}",
                    envelope.id,
                    envelope.event_type,
                    err.rule()
                );
                return json(
                    &serde_json::json!({ "outcome": "refused", "rule": err.rule() }),
                    200,
                );
            }
        };
        if s.first_write {
            self.ensure_schema()?;
        }
        self.write(
            Write {
                birth: s.birth,
                first_write: s.first_write,
                existing_last: s.last,
                at: ctx.now,
                cause: Some(envelope.id.to_string()),
                events,
                key: (key, String::new()),
                answer: String::from("{}"),
            },
            now,
        )
        .await?;
        json(&serde_json::json!({ "outcome": "applied" }), 200)
    }

    /// One transaction: `meta` on the first write, the events and their outbox rows, the key;
    /// then the relay.
    async fn write(&self, w: Write, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let head = StreamHead {
            sandbox: w.birth.sandbox,
            stream: w.birth.name.clone(),
            last_seq: w.existing_last,
        };
        let stamp = Stamp {
            at: w.at,
            recorded_at: now,
            cause: w.cause,
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
        let any = !built.is_empty();
        let (birth, first_write, (key, hash), answer) = (w.birth, w.first_write, w.key, w.answer);
        transaction_sync(&self.state.storage(), move || {
            if first_write {
                child::born(&sql, &birth, now)?;
            }
            stream::append(&sql, &built)?;
            stream::remember(&sql, &key, &hash, &answer, now)?;
            Ok(())
        })?;
        if any {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await
        } else {
            stream::arm(&self.state.storage(), now).await
        }
    }
}

struct Standing {
    birth: Birth,
    first_write: bool,
    state: CustomerState,
    last: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(event_type: &str, data: serde_json::Value) -> Envelope {
        serde_json::from_value(json!({
            "v": 1, "id": "01JC8Z6K3W9QF2N4T7XRB5M0HD", "sandbox": "01JC8YV2D4QK7S1M9E3PZ6W8AN",
            "stream": "order:01JC8YV2D4QK7S1M9E3PZ6W8AN:01JC8Z5R0T2B6Y8C4V1N3K7QXE", "seq": 2,
            "type": event_type, "at": "2026-11-07T12:12:10-07:00",
            "recorded_at": "2026-11-07T19:12:10.318Z", "data": data, "cause": null
        }))
        .unwrap()
    }

    #[test]
    fn a_paid_order_earns_and_a_refund_reverses_and_nothing_else_is_a_command() {
        let order: Ulid = "01JC8Z5R0T2B6Y8C4V1N3K7QXE".parse().unwrap();
        assert_eq!(
            command_of(&envelope(
                "OrderPaid",
                json!({ "payment": "01JC8Z6F1A5H3D7K9M2P4R6T8V", "amount_cents": 2_250 })
            )),
            Some(CustomerCommand::EarnPoints {
                order,
                amount: Cents(2_250)
            })
        );
        assert_eq!(
            command_of(&envelope(
                "OrderRefunded",
                json!({ "refund": "01JC8Z6F1A5H3D7K9M2P4R6T8V", "amount_cents": 500, "full": false })
            )),
            Some(CustomerCommand::ReversePoints {
                order,
                refund: "01JC8Z6F1A5H3D7K9M2P4R6T8V".parse().unwrap(),
                amount: Cents(500),
                full: false,
            })
        );
        assert_eq!(command_of(&envelope("OrderReady", json!({}))), None);
        assert_eq!(command_of(&envelope("OrderPaid", json!({}))), None);
    }

    #[test]
    fn a_customer_is_named_by_its_persona() {
        let s = Ulid::from_parts(1, 1);
        let c = Ulid::from_parts(1, 2);
        assert_eq!(customer_of(&name(s, c)), Some(c));
        let cmd: Cmd = serde_json::from_str(r#"{"cmd":"set_consent","marketing":false}"#).unwrap();
        assert_eq!(cmd, Cmd::SetConsent { marketing: false });
    }
}
