//! `Catalog`, one per sandbox, named `catalog:<sandbox>` (docs/domain.md, "MenuItem
//! availability"). It hosts the domain's `Catalog` aggregate: the state is stored whole in one
//! `state` row beside the stream, and every command writes the new state, its events, their
//! outbox rows and its key in one transaction.
//!
//! Paths (the Worker builds them; nothing outside reaches them):
//!
//! - `POST /_seed {birth, categories, items, variants}` → 201 `{version}`; 200 when already seeded.
//! - `GET /_version` → `{version}`: the cheap read the menu route keys its cache by.
//! - `GET /_menu` → the published `MenuView`.
//! - `GET /_drafts` → `MenuDraftsResponse`: the draft copy of every pending item, in slug order.
//! - `POST /_patch {key, body_hash, item, price_cents?, status?}` → 200 `{version, pending}`;
//!   404 `{error: "unknown-item"}`; 422 `{error: "menu", rule}`; 422 `{error: "key-reused"}`;
//!   a replay answers the first result with `Idempotent-Replayed: true`.
//! - `POST /_publish {key}` → the same answers; `rule: "nothing-to-publish"` with no drafts.
//! - `POST /_tax-rate {key, body_hash, tax_bp}` → the same answers; `rule: "tax-rate-range"`
//!   outside 0 to 3,000 bp. The rate is published at once with a version of its own.
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs).
//!
//! Its alarm serves the `outbox` timer and the 36 h backstop.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_contracts::{
    MenuDraft, MenuDraftsResponse, MenuEditResponse, MenuItemState, MenuItemStatus, MenuVariant,
};
use bakery_domain::catalog::{
    Catalog as CatalogAggregate, CatalogCommand, CatalogError, CatalogEvent, CatalogState,
    Category, Item, ItemStatus, Variant,
};
use bakery_domain::outbox::{CommandCheck, Stamp, check_command, envelopes};
use bakery_domain::{Cents, DecideContext, Ulid, WallTime, execute};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::sql::{self, exec, first, gone, json, refuse, replayed, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::SystemClock;
use crate::random;

pub const BINDING: &str = "CATALOG";
pub const CLASS: &str = "Catalog";

pub fn name(sandbox: Ulid) -> String {
    format!("catalog:{sandbox}")
}

const SCHEMA: &[&str] = &[
    child::META,
    "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedCatalog {
    pub birth: Birth,
    pub categories: Vec<Category>,
    pub items: Vec<Item>,
    pub variants: Vec<Variant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Patch {
    pub key: String,
    pub body_hash: String,
    pub item: String,
    #[serde(default)]
    pub price_cents: Option<i64>,
    #[serde(default)]
    pub status: Option<MenuItemStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Publish {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetTaxRate {
    pub key: String,
    pub body_hash: String,
    pub tax_bp: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Version {
    pub version: u32,
}

#[derive(Deserialize)]
struct StateRow {
    body: String,
}

#[durable_object]
pub struct Catalog {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Catalog {
    fn new(state: State, env: Env) -> Self {
        Catalog {
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
                let body: SeedCatalog = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_wipe") => json(&child::wipe(&self.state).await?, 200),
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Get, "/_version") => json(
                        &Version {
                            version: self.load()?.version(),
                        },
                        200,
                    ),
                    (Method::Get, "/_menu") => json(&self.load()?.menu_view(), 200),
                    (Method::Get, "/_drafts") => json(&drafts(&self.load()?), 200),
                    (Method::Post, "/_patch") => {
                        let body: Patch = sql::body(&mut req).await?;
                        self.patch(&meta, body, now).await
                    }
                    (Method::Post, "/_publish") => {
                        let body: Publish = sql::body(&mut req).await?;
                        let hash = String::new();
                        self.command(&meta, &body.key, &hash, &[CatalogCommand::PublishMenu], now)
                            .await
                    }
                    (Method::Post, "/_tax-rate") => {
                        let body: SetTaxRate = sql::body(&mut req).await?;
                        let cmd = CatalogCommand::SetTaxRate {
                            tax_bp: body.tax_bp,
                        };
                        self.command(&meta, &body.key, &body.body_hash, &[cmd], now)
                            .await
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

impl Catalog {
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

    fn load(&self) -> Result<CatalogState> {
        let row: Option<StateRow> = first(&self.sql(), "SELECT body FROM state", vec![])?;
        let row = row.ok_or_else(|| Error::RustError("catalog state missing".into()))?;
        Ok(serde_json::from_str(&row.body)?)
    }

    /// The seed's menu, published as version 1, with no events: the version the sandbox is born
    /// with is not a change anyone made (`SandboxSeeded` records the seeding).
    async fn seed(&self, body: SeedCatalog, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if child::meta(&sql)?.is_some() {
            return json(
                &Version {
                    version: self.load()?.version(),
                },
                200,
            );
        }
        let state = CatalogAggregate::seeded(body.categories, body.items, body.variants)
            .map_err(|e| Error::RustError(format!("seed menu: {}", e.rule())))?;
        let version = state.version();
        let text = serde_json::to_string(&state)?;
        self.ensure_schema()?;
        let birth = body.birth;
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)?;
            exec(
                &sql,
                "INSERT INTO state (id, body) VALUES (1, ?)",
                vec![text.into()],
            )?;
            Ok(())
        })?;
        stream::arm(&self.state.storage(), now).await?;
        json(&Version { version }, 201)
    }

    async fn patch(&self, meta: &child::Meta, p: Patch, now: WallTime) -> Result<Response> {
        let state = self.load()?;
        let Some((_, variants)) = state.draft_item(&p.item) else {
            return refuse(404, "unknown-item");
        };
        let mut commands = Vec::new();
        if let Some(price) = p.price_cents {
            commands.extend(variants.iter().map(|v| CatalogCommand::SetPrice {
                variant: v.slug.clone(),
                price: Cents(price),
            }));
        }
        match p.status {
            Some(MenuItemStatus::Paused) => commands.push(CatalogCommand::Pause {
                item: p.item.clone(),
            }),
            Some(MenuItemStatus::Available) => commands.push(CatalogCommand::Resume {
                item: p.item.clone(),
            }),
            None => {}
        }
        self.command(meta, &p.key, &p.body_hash, &commands, now)
            .await
    }

    /// Every command in turn against the state the last one left, then one transaction for the
    /// new state, every event, their outbox rows and the key. A rule broken anywhere writes
    /// nothing.
    async fn command(
        &self,
        meta: &child::Meta,
        key: &str,
        body_hash: &str,
        commands: &[CatalogCommand],
        now: WallTime,
    ) -> Result<Response> {
        let sql = self.sql();
        let seen = stream::seen(&sql, key)?;
        match check_command(seen.as_ref(), body_hash) {
            Ok(CommandCheck::Replay(result)) => return replayed(result),
            Ok(CommandCheck::Fresh) => {}
            Err(_) => return refuse(422, "key-reused"),
        }
        let id: Ulid = key
            .parse()
            .map_err(|_| Error::RustError("key is not a ULID".into()))?;
        let ctx = DecideContext {
            now: meta.business(now),
            id,
        };
        let mut state = self.load()?;
        let mut events: Vec<CatalogEvent> = Vec::new();
        for cmd in commands {
            match execute::<CatalogAggregate>(state, cmd, &ctx) {
                Ok((next, mut emitted)) => {
                    state = next;
                    events.append(&mut emitted);
                }
                Err(e) => return rejection(&e),
            }
        }
        let answer = serde_json::to_string(&MenuEditResponse {
            version: state.version(),
            pending: state.pending().map(str::to_owned).collect(),
        })?;
        let sandbox = meta.sandbox_id()?;
        let head = stream::head(&sql, sandbox, &meta.name)?;
        let stamp = Stamp {
            at: ctx.now,
            recorded_at: now,
            cause: Some(key.to_owned()),
        };
        let mut ids = Vec::with_capacity(events.len());
        for _ in &events {
            ids.push(random::ulid(now)?);
        }
        let mut ids = ids.into_iter();
        let built = envelopes(&head, &stamp, &events, || {
            ids.next().unwrap_or(Ulid::from_parts(0, 0))
        })
        .map_err(|e| Error::RustError(e.to_string()))?;
        let text = serde_json::to_string(&state)?;
        let (key, hash, stored) = (key.to_owned(), body_hash.to_owned(), answer.clone());
        let any = !built.is_empty();
        transaction_sync(&self.state.storage(), move || {
            exec(&sql, "UPDATE state SET body = ?", vec![text.into()])?;
            stream::append(&sql, &built)?;
            stream::remember(&sql, &key, &hash, &stored, now)?;
            Ok(())
        })?;
        if any {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        }
        let mut res = Response::ok(answer)?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }
}

/// The draft copy of every pending item, as the contract writes it.
fn drafts(state: &CatalogState) -> MenuDraftsResponse {
    MenuDraftsResponse {
        version: state.version(),
        pending: state
            .drafts()
            .into_iter()
            .map(|(item, variants)| MenuDraft {
                slug: item.slug.clone(),
                name: item.name.clone(),
                status: match item.status {
                    ItemStatus::Draft => MenuItemState::Draft,
                    ItemStatus::Available => MenuItemState::Available,
                    ItemStatus::Paused => MenuItemState::Paused,
                    ItemStatus::Retired => MenuItemState::Retired,
                },
                variants: variants
                    .into_iter()
                    .map(|v| MenuVariant {
                        slug: v.slug.clone(),
                        label: v.label.clone(),
                        price_cents: v.price_cents.0,
                        lead_minutes: v.lead_minutes,
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn rejection(e: &CatalogError) -> Result<Response> {
    if let CatalogError::UnknownItem(_) = e {
        return refuse(404, "unknown-item");
    }
    json(
        &serde_json::json!({ "error": "menu", "rule": e.rule() }),
        422,
    )
}
