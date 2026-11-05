//! The router: the route table, then the checks every command passes, then the route, then
//! the response headers and one log line, for every request (docs/security.md, "Origin
//! checks" and "Privacy and data inventory").

mod auth;
mod catering;
mod demo;
mod guard;
mod headers;
mod kitchen;
mod menu;
mod oauth;
mod orders;
mod outbound;
mod payments;
mod problem;
mod routes;
mod sandboxes;
mod schedule;
mod traffic;
mod webhook;

use std::cell::RefCell;

use bakery_app::Clock;
use bakery_app::auth::Keyring;
use bakery_app::log::RequestLine;
use bakery_app::{BuildInfo, health};
use bakery_contracts::{HealthResponse, HealthStatus};
use bakery_domain::{Ulid, WallTime};
use worker::{Env, Request, Response, Result, console_log};

use crate::clock::SystemClock;
use crate::config::Config;
use crate::objects::control;

use auth::Auth;
use problem::Failure;
use routes::{Limit, Matched, Params, Route, RouteId, Scope};

pub use headers::ALLOWED_ORIGIN_VAR;
pub use menu::cache_key as menu_cache_key;

/// Everything a route reads about its request, decided once.
pub struct Cx {
    pub env: Env,
    pub cfg: Config,
    pub now: WallTime,
    pub auth: Auth,
    /// The request's `Idempotency-Key`, on a POST.
    pub key: Option<Ulid>,
    note: RefCell<Note>,
}

/// What the log line says beyond the request itself.
#[derive(Default)]
struct Note {
    reason: Option<&'static str>,
    sandbox: Option<String>,
}

impl Cx {
    pub fn keyring(&self) -> std::result::Result<Keyring, Failure> {
        Ok(self.cfg.keyring()?)
    }

    /// The reason code for this request's log line: a constant, never a request value.
    pub fn reason(&self, reason: &'static str) {
        self.note.borrow_mut().reason = Some(reason);
    }

    /// The sandbox this request ends up naming, for the log line.
    pub fn sandbox(&self, id: Option<Ulid>) {
        self.note.borrow_mut().sandbox = id.map(|i| i.to_string());
    }

    pub fn claims(&self) -> Option<&bakery_app::auth::SessionClaims> {
        self.auth.claims()
    }
}

pub async fn handle(req: Request, env: Env) -> Result<Response> {
    let clock = SystemClock::new();
    let started = clock.now_wall();
    let method = req.method().to_string();
    let path = req.path();
    let origin = req.headers().get("Origin")?;
    let ip = req.headers().get("CF-Connecting-IP")?;
    let (country, continent) = req
        .cf()
        .map_or((None, None), |cf| (cf.country(), cf.continent()));
    let cfg = Config::from_env(&env);
    let allowed_origin = cfg.allowed_origin.clone();

    let matched = routes::match_route(&method, &path);
    // Stripe's webhook gets no CORS headers whatever Origin it carries.
    let cors_origin = if routes::is_server_to_server_path(&path) {
        None
    } else {
        origin.clone()
    };
    let mut preflight = false;
    let mut ip_hash = None;
    let mut note = Note::default();

    let outcome: std::result::Result<Response, Failure> = match matched {
        Matched::NotFound => Err(problem::not_found()),
        Matched::MethodNotAllowed(allow) => {
            let mut res =
                Failure::plain(405, "Method Not Allowed", "method").into_response(&path)?;
            res.headers_mut().set("Allow", &allow)?;
            Ok(res)
        }
        Matched::Preflight => {
            preflight = true;
            Ok(Response::empty()?.with_status(204))
        }
        Matched::Route(route, params) => {
            // Health touches no object, so it has no IP hash; everything else asks for the
            // day's salt, which the isolate caches for 30 s.
            if route.id != RouteId::Health {
                ip_hash = outbound::ip_hash_for(&env, ip.as_deref(), started).await;
            }
            let mut req = req;
            let (result, n) =
                run(route, params, &mut req, env, cfg, started, ip_hash.clone()).await;
            note = n;
            result
        }
    };

    let (mut res, reason) = match outcome {
        Ok(res) => (res, note.reason),
        Err(f) => {
            let reason = f.reason;
            (f.into_response(&path)?, Some(reason))
        }
    };
    headers::apply(
        &mut res,
        cors_origin.as_deref(),
        allowed_origin.as_deref(),
        preflight,
    )?;

    if let Ok(mut line) = RequestLine::new(
        &path,
        &method,
        res.status_code(),
        u64::try_from(clock.now_wall().unix_ms() - started.unix_ms()).unwrap_or(0),
    ) {
        line.ip_hash = ip_hash;
        line.country = country;
        line.continent = continent;
        line.sandbox = note.sandbox;
        line.reason = reason;
        console_log!("{}", line.to_json());
    }
    Ok(res)
}

/// The checks in order, then the route. Each check is free or nearly: no object is asked for
/// anything but the salt until the route itself runs.
async fn run(
    route: &'static Route,
    params: Params,
    req: &mut Request,
    env: Env,
    cfg: Config,
    now: WallTime,
    ip_hash: Option<String>,
) -> (std::result::Result<Response, Failure>, Note) {
    let mut cx = Cx {
        env,
        cfg,
        now,
        auth: Auth::None,
        key: None,
        note: RefCell::new(Note::default()),
    };
    let result = checked(route, params, req, &mut cx, ip_hash).await;
    (result, cx.note.into_inner())
}

async fn checked(
    route: &'static Route,
    params: Params,
    req: &mut Request,
    cx: &mut Cx,
    ip_hash: Option<String>,
) -> std::result::Result<Response, Failure> {
    // Stripe's webhook: its signature on the raw body is the only check, before anything else
    // reads the request (docs/security.md, "Payments safety").
    if routes::is_server_to_server(route.id) {
        return webhook::receive(cx, req).await;
    }
    let headers = req.headers();
    // The socket's upgrade is a GET, but it carries the cookie and ignores CORS: the exact
    // Origin is the defence against cross-site hijacking (docs/security.md, the threats table).
    if guard::is_command(route.method) || route.id == RouteId::KitchenSocket {
        let allowed = cx.cfg.origin()?;
        let origin = headers.get("Origin").ok().flatten();
        let site = headers.get("Sec-Fetch-Site").ok().flatten();
        guard::check_origin(origin.as_deref(), site.as_deref(), allowed)
            .map_err(|reason| problem::origin().because(reason))?;
    }
    if route.method == "POST" {
        let key = headers.get("Idempotency-Key").ok().flatten();
        cx.key = Some(guard::idempotency_key(key.as_deref()).ok_or_else(problem::idempotency_key)?);
    } else if route.method == "PATCH" {
        // Optional on a PATCH, which is idempotent by its body; a malformed one is still refused.
        if let Some(key) = headers.get("Idempotency-Key").ok().flatten() {
            cx.key = Some(guard::idempotency_key(Some(&key)).ok_or_else(problem::idempotency_key)?);
        }
    }

    // The session: required by its scope, read when present otherwise. Without a signing key
    // a route that needs a session cannot answer; one that does not ignores the cookie.
    let reads_session = !matches!(
        route.id,
        RouteId::Health
            | RouteId::Status
            | RouteId::GoogleStart
            | RouteId::GoogleCallback
            | RouteId::GithubStart
            | RouteId::GithubCallback
    );
    if reads_session {
        match cx.cfg.keyring() {
            Ok(keyring) => cx.auth = Auth::read(req, &keyring, cx.now),
            Err(e) if route.scope != Scope::Public => return Err(e.into()),
            Err(_) => {}
        }
    }
    match (route.scope, &cx.auth) {
        (Scope::Public, _) => {}
        (_, Auth::None) => return Err(problem::session().because("no-session")),
        (_, Auth::Invalid(reason)) => return Err(problem::session().because(reason)),
        (Scope::SignedIn, Auth::Session(c)) if c.is_guest() => return Err(problem::guest_scope()),
        (_, Auth::Session(_)) => {}
    }
    cx.sandbox(cx.claims().and_then(|c| c.sbx));

    let limit_key = match route.limit {
        Limit::None => None,
        Limit::SandboxCreate => Some(("SANDBOX_CREATE_LIMIT", ip_key(ip_hash.as_deref()))),
        Limit::Command => Some((
            "COMMAND_LIMIT",
            cx.claims()
                .map(|c| format!("sid:{}", c.sid))
                .unwrap_or_else(|| ip_key(ip_hash.as_deref())),
        )),
        Limit::Upgrade => Some((
            "UPGRADE_LIMIT",
            cx.claims()
                .map(|c| format!("sid:{}", c.sid))
                .unwrap_or_else(|| ip_key(ip_hash.as_deref())),
        )),
    };
    if let Some((binding, key)) = limit_key
        && !outbound::within_limit(&cx.env, binding, key).await
    {
        return Err(problem::rate_limit());
    }

    let cx = &*cx;
    let id = params.id;
    let sub = params.sub.as_deref();
    match route.id {
        RouteId::Health => get_health(cx),
        RouteId::Status => get_status(cx).await,
        RouteId::GoogleStart => oauth::google_start(cx, req).await,
        RouteId::GoogleCallback => oauth::google_callback(cx, req).await,
        RouteId::GithubStart => oauth::github_start(cx, req).await,
        RouteId::GithubCallback => oauth::github_callback(cx, req).await,
        RouteId::DemoSignup => demo::signup(cx, req).await,
        RouteId::DemoSignin => demo::signin(cx, req).await,
        RouteId::Signout => demo::signout(cx).await,
        RouteId::Session => demo::session(cx),
        RouteId::CreateSandbox => sandboxes::create(cx, req).await,
        RouteId::GetSandbox => sandboxes::get(cx, id.as_deref()).await,
        RouteId::WipeSandbox => sandboxes::wipe(cx, id.as_deref()).await,
        RouteId::SetFault => sandboxes::set_fault(cx, req, id.as_deref()).await,
        RouteId::GetMenu => menu::get(cx, req, id.as_deref()).await,
        RouteId::PatchMenuItem => menu::patch_item(cx, req, id.as_deref(), sub).await,
        RouteId::PublishMenu => menu::publish(cx, id.as_deref()).await,
        RouteId::PlaceOrder => orders::place(cx, req, id.as_deref()).await,
        RouteId::GetOrder => orders::get(cx, id.as_deref(), sub).await,
        RouteId::CancelOrder => orders::cancel(cx, id.as_deref(), sub).await,
        RouteId::ListDeadLetters => sandboxes::dead_letters(cx, id.as_deref()).await,
        RouteId::Redrive => sandboxes::redrive(cx, id.as_deref(), sub).await,
        RouteId::AdvanceClock => sandboxes::advance_clock(cx, req, id.as_deref()).await,
        RouteId::KitchenSocket => kitchen::socket(cx, req, id.as_deref()).await,
        RouteId::Heartbeat => kitchen::heartbeat(cx, id.as_deref()).await,
        RouteId::GetTraffic => traffic::get(cx, id.as_deref()).await,
        RouteId::StartTraffic => traffic::start(cx, req, id.as_deref()).await,
        RouteId::StopTraffic => traffic::stop(cx, id.as_deref()).await,
        RouteId::Pay => payments::pay(cx, id.as_deref(), sub).await,
        RouteId::Refund => payments::refund(cx, req, id.as_deref(), sub).await,
        RouteId::Ledger => payments::ledger(cx, id.as_deref()).await,
        RouteId::GetSchedule => schedule::get(cx, id.as_deref(), sub).await,
        RouteId::SetCapacity => schedule::set_capacity(cx, req, id.as_deref(), sub).await,
        RouteId::CreateCatering => catering::create(cx, req, id.as_deref()).await,
        RouteId::ListCatering => catering::list(cx, id.as_deref()).await,
        RouteId::GetCatering => catering::get(cx, id.as_deref(), sub).await,
        RouteId::AcceptQuote => catering::accept(cx, id.as_deref(), sub).await,
        RouteId::CateringDeposit => catering::deposit(cx, id.as_deref(), sub).await,
        RouteId::PayBalance => catering::pay_balance(cx, id.as_deref(), sub).await,
        RouteId::CancelCatering => catering::cancel(cx, req, id.as_deref(), sub).await,
        RouteId::SendQuote => catering::quote(cx, req, id.as_deref(), sub).await,
        RouteId::DeclineCatering => catering::decline(cx, req, id.as_deref(), sub).await,
        RouteId::StartCateringProduction => {
            catering::staff_step(
                cx,
                id.as_deref(),
                sub,
                crate::objects::catering::Cmd::StartProduction,
            )
            .await
        }
        RouteId::MarkCateringDelivered => {
            catering::staff_step(
                cx,
                id.as_deref(),
                sub,
                crate::objects::catering::Cmd::MarkDelivered,
            )
            .await
        }
        RouteId::StaffCancelCatering => catering::staff_cancel(cx, req, id.as_deref(), sub).await,
        // Answered before the checks above.
        RouteId::StripeWebhook => Err(problem::internal()),
    }
}

/// The rate-limit key for a request with no session: its IP hash, never the address.
fn ip_key(ip_hash: Option<&str>) -> String {
    format!("ip:{}", ip_hash.unwrap_or("unknown"))
}

fn build_info(env: &Env) -> BuildInfo {
    let commit = env
        .var("BUILD_COMMIT")
        .map(|v| v.to_string())
        .ok()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "dev".to_owned());
    BuildInfo {
        commit,
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// No object is touched: health costs one Worker request and nothing else.
fn get_health(cx: &Cx) -> std::result::Result<Response, Failure> {
    let h = health(&build_info(&cx.env));
    Ok(Response::from_json(&HealthResponse {
        status: match h.status {
            bakery_app::HealthStatus::Ok => HealthStatus::Ok,
        },
        commit: h.commit,
        version: h.version,
    })?)
}

/// One call to `Control`.
async fn get_status(cx: &Cx) -> std::result::Result<Response, Failure> {
    let status = control::status(&cx.env).await?;
    Ok(Response::from_json(&status)?)
}

/// The digest `commands_seen` compares a repeated key's body by: SHA-256 of the body text, hex.
pub fn body_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    bakery_app::auth::hex(&Sha256::digest(text.as_bytes()))
}

/// A JSON body for the visitor, with a status.
pub fn json<T: serde::Serialize>(value: &T, status: u16) -> std::result::Result<Response, Failure> {
    Ok(Response::from_json(value)?.with_status(status))
}
