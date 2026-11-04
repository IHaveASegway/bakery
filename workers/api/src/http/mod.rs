//! The router: CORS, response headers and problem+json around every route.

mod headers;

use bakery_app::{BuildInfo, health};
use bakery_contracts::{HealthResponse, HealthStatus, Problem};
use worker::{Env, Request, Response, Result, RouteContext, Router, console_error};

use crate::objects::control;

pub use headers::{ALLOWED_ORIGIN_VAR, BodyKind};

/// Every route and the methods it answers, for `Allow` on a 405.
const ROUTES: &[(&str, &str)] = &[
    ("/v1/health", "GET, OPTIONS"),
    ("/v1/status", "GET, OPTIONS"),
];

pub async fn handle(req: Request, env: Env) -> Result<Response> {
    let origin = req.headers().get("Origin")?;
    let path = req.path();
    let allowed_origin = env.var(ALLOWED_ORIGIN_VAR).map(|v| v.to_string()).ok();

    let router = Router::new()
        .get("/v1/health", get_health)
        .get_async("/v1/status", get_status)
        .options("/v1/health", preflight)
        .options("/v1/status", preflight);

    let (res, preflight) = match router.run(req, env).await {
        Ok(res) => routed(res, &path),
        Err(e) => {
            console_error!(
                "{{\"event\":\"route_error\",\"path\":{path:?},\"error\":{:?}}}",
                e.to_string()
            );
            (
                problem(Problem::status(500, "Internal Server Error").with_instance(&path)),
                false,
            )
        }
    };
    let mut res = res?;
    headers::apply(
        &mut res,
        origin.as_deref(),
        allowed_origin.as_deref(),
        preflight,
    )?;
    Ok(res)
}

/// Turns the router's plain-text 404 and 405 into problem+json, and marks preflights.
fn routed(res: Response, path: &str) -> (Result<Response>, bool) {
    let is_problem = headers::body_kind(&res) == Some(BodyKind::Problem);
    match res.status_code() {
        204 => (Ok(res), true),
        404 if !is_problem => (
            problem(Problem::status(404, "Not Found").with_instance(path)),
            false,
        ),
        405 if !is_problem => {
            let allow = ROUTES
                .iter()
                .find(|(p, _)| *p == path)
                .map_or("OPTIONS", |(_, m)| m);
            let res = problem(Problem::status(405, "Method Not Allowed").with_instance(path))
                .and_then(|r| {
                    r.headers().set("Allow", allow)?;
                    Ok(r)
                });
            (res, false)
        }
        _ => (Ok(res), false),
    }
}

fn problem(p: Problem) -> Result<Response> {
    let status = p.status;
    let mut res = Response::from_json(&p)?.with_status(status);
    res.headers_mut()
        .set("Content-Type", BodyKind::Problem.content_type())?;
    Ok(res)
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
fn get_health(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let h = health(&build_info(&ctx.env));
    Response::from_json(&HealthResponse {
        status: match h.status {
            bakery_app::HealthStatus::Ok => HealthStatus::Ok,
        },
        commit: h.commit,
        version: h.version,
    })
}

/// One call to `Control`.
async fn get_status(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    Response::from_json(&control::status(&ctx.env).await?)
}

fn preflight(_req: Request, _ctx: RouteContext<()>) -> Result<Response> {
    Ok(Response::empty()?.with_status(204))
}
