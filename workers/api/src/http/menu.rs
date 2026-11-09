//! The menu: the published `MenuView` from the sandbox's `Catalog`, cached in the Cache API
//! under a key of sandbox and version, and the staff edits (docs/architecture.md, "Data
//! ownership"; docs/domain.md, "MenuItem availability").
//!
//! A read asks the Catalog's cheap `/_version` first. The `ETag` is `"v<version>"`, so a
//! browser holding the current one gets 304 with no body; otherwise the body comes from the
//! cache entry for that version, or from the Catalog on a miss. A stale entry is unreachable
//! once the version moves, because no key names it; the consumer deletes it on `MenuPublished`
//! as housekeeping. `Bakery-Cache: hit|miss` says which happened.

use bakery_contracts::{MenuItemPatch, SandboxState, TaxRateRequest};
use bakery_domain::Ulid;
use worker::{Cache, Method, Request, Response};

use super::headers::REVALIDATE;
use super::problem::{self, Failure, Refused};
use super::sandboxes::{not_revoked, own_sandbox, state};
use super::{Cx, body_hash};
use crate::objects::catalog::{self, Patch, Publish, SetTaxRate, Version};
use crate::objects::sql::{call, call_empty};
use crate::random;

type Answer = Result<Response, Failure>;

/// A cache entry lives at most a day: no sandbox outlives the next 10:00 UTC (Q25 · Q-ttl).
const CACHE_MAX_AGE_S: u32 = 86_400;

/// `<API_ORIGIN>/_cache/menu/<sandbox>/v<version>`: a URL on the API's own host that no route
/// answers, so only the Cache API ever holds it.
pub fn cache_key(api_origin: &str, sandbox: Ulid, version: u32) -> String {
    format!(
        "{}/_cache/menu/{sandbox}/v{version}",
        api_origin.trim_end_matches('/')
    )
}

/// Whether an `If-None-Match` value names `etag`: a list, `*`, or a weak form all count.
pub fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    if_none_match
        .split(',')
        .map(|t| t.trim().trim_start_matches("W/"))
        .any(|t| t == "*" || t == etag)
}

fn etag(version: u32) -> String {
    format!("\"v{version}\"")
}

/// The Catalog answered 410: the sandbox is still seeding, or wiped.
async fn catalog_gone(cx: &Cx, id: Ulid) -> Failure {
    match state(cx, id).await {
        Ok(Some(s)) if s.state == SandboxState::Seeding => problem::seeding(),
        Ok(_) => problem::wiped(),
        Err(f) => f,
    }
}

/// `GET /v1/sandboxes/{id}/menu`.
pub async fn get(cx: &Cx, req: &Request, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let name = catalog::name(id);
    let mut res = call_empty(&cx.env, catalog::BINDING, &name, Method::Get, "/_version").await?;
    let version = match res.status_code() {
        200 => res.json::<Version>().await?.version,
        410 => return Err(catalog_gone(cx, id).await),
        _ => return Err(problem::internal()),
    };
    let tag = etag(version);
    if req
        .headers()
        .get("If-None-Match")?
        .is_some_and(|v| etag_matches(&v, &tag))
    {
        cx.reason("not-modified");
        let mut out = Response::empty()?.with_status(304);
        out.headers_mut().set("ETag", &tag)?;
        out.headers_mut().set("Cache-Control", REVALIDATE)?;
        return Ok(out);
    }
    let origin = cx.cfg.api_origin()?;
    let cache = Cache::default();
    let key = cache_key(origin, id, version);
    let (body, tag, hit) = match cache.get(key.as_str(), false).await? {
        Some(mut cached) => (cached.text().await?, tag, true),
        None => {
            let mut res =
                call_empty(&cx.env, catalog::BINDING, &name, Method::Get, "/_menu").await?;
            match res.status_code() {
                200 => {}
                410 => return Err(catalog_gone(cx, id).await),
                _ => return Err(problem::internal()),
            }
            let text = res.text().await?;
            // A publish between the two reads: key and tag by the version the body is.
            let fresh = serde_json::from_str::<Version>(&text)
                .map(|v| v.version)
                .unwrap_or(version);
            let mut entry = Response::ok(text.clone())?;
            entry
                .headers_mut()
                .set("Cache-Control", &format!("max-age={CACHE_MAX_AGE_S}"))?;
            entry
                .headers_mut()
                .set("Content-Type", "application/json")?;
            cache
                .put(cache_key(origin, id, fresh).as_str(), entry)
                .await?;
            (text, etag(fresh), false)
        }
    };
    cx.reason(if hit { "cache-hit" } else { "cache-miss" });
    let mut out = Response::ok(body)?;
    let headers = out.headers_mut();
    headers.set("Content-Type", "application/json")?;
    headers.set("ETag", &tag)?;
    headers.set("Cache-Control", REVALIDATE)?;
    headers.set("Bakery-Cache", if hit { "hit" } else { "miss" })?;
    Ok(out)
}

/// An edit or a publish, as the Catalog answered it.
async fn edited(mut res: Response) -> Answer {
    match res.status_code() {
        200 => {
            let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
            let mut out = Response::ok(res.text().await?)?;
            out.headers_mut().set("Content-Type", "application/json")?;
            if replayed {
                out.headers_mut().set("Idempotent-Replayed", "true")?;
            }
            Ok(out)
        }
        404 => Err(problem::not_found().because("unknown-item")),
        410 => Err(problem::wiped()),
        422 => {
            let refused: Refused = res.json().await?;
            if refused.error == "key-reused" {
                return Err(problem::idempotency_reused());
            }
            Err(problem::menu(refused.rule.as_deref().unwrap_or("")))
        }
        _ => Err(problem::internal()),
    }
}

/// `PATCH /v1/sandboxes/{id}/menu/items/{slug}`, signed-in sessions only: a price for every
/// variant of the item (a draft until publish), or a pause or a resume (published at once).
pub async fn patch_item(
    cx: &Cx,
    req: &mut Request,
    id: Option<&str>,
    slug: Option<&str>,
) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let slug = slug.ok_or_else(problem::not_found)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: MenuItemPatch = serde_json::from_str(&text).map_err(|_| problem::body())?;
    if body.price_cents.is_none() && body.status.is_none() {
        return Err(problem::menu("empty-patch"));
    }
    // A PATCH is idempotent by its body, so without a key each one is its own command.
    let key = match cx.key {
        Some(k) => k,
        None => random::ulid(cx.now)?,
    };
    let res = call(
        &cx.env,
        catalog::BINDING,
        &catalog::name(id),
        Method::Post,
        "/_patch",
        Some(&Patch {
            key: key.to_string(),
            body_hash: body_hash(&format!("{slug}\n{text}")),
            item: slug.to_owned(),
            price_cents: body.price_cents,
            status: body.status,
        }),
    )
    .await?;
    edited(res).await
}

/// `POST /v1/sandboxes/{id}/menu/publish`, signed-in sessions only: `MenuPublished`, the
/// version plus one, so the next read misses once.
pub async fn publish(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let res = call(
        &cx.env,
        catalog::BINDING,
        &catalog::name(id),
        Method::Post,
        "/_publish",
        Some(&Publish {
            key: key.to_string(),
        }),
    )
    .await?;
    edited(res).await
}

/// `PATCH /v1/sandboxes/{id}/menu/tax-rate`, signed-in sessions only: `SetTaxRate`, published
/// at once as `MenuPublished` with the new rate, so the next read misses once and an order placed
/// after it pays that rate. Out of 0 to 3,000 bp is 422 `menu` with the rule `tax-rate-range`.
pub async fn set_tax_rate(cx: &Cx, req: &mut Request, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: TaxRateRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    // A PATCH is idempotent by its body, so without a key each one is its own command.
    let key = match cx.key {
        Some(k) => k,
        None => random::ulid(cx.now)?,
    };
    let res = call(
        &cx.env,
        catalog::BINDING,
        &catalog::name(id),
        Method::Post,
        "/_tax-rate",
        Some(&SetTaxRate {
            key: key.to_string(),
            body_hash: body_hash(&format!("tax-rate\n{text}")),
            tax_bp: body.tax_bp,
        }),
    )
    .await?;
    edited(res).await
}

/// `GET /v1/sandboxes/{id}/menu/drafts`, signed-in sessions only: the Catalog's draft copy of
/// every item waiting for a publish, so the console's editor shows them after a reload. It is
/// never cached (`no-store`, the default): it moves with every edit, and only staff read it.
pub async fn drafts(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let mut res = call_empty(
        &cx.env,
        catalog::BINDING,
        &catalog::name(id),
        Method::Get,
        "/_drafts",
    )
    .await?;
    match res.status_code() {
        200 => {
            let mut out = Response::ok(res.text().await?)?;
            out.headers_mut().set("Content-Type", "application/json")?;
            Ok(out)
        }
        410 => Err(problem::wiped()),
        _ => Err(problem::internal()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_contracts::MenuResponse;
    use bakery_domain::catalog::{Catalog, Category, Item, Variant};

    #[test]
    fn the_cache_key_names_the_sandbox_and_the_version() {
        let s: Ulid = "01JC8Z6K3W9QF2N4T7XRB5M0HD".parse().unwrap();
        assert_eq!(
            cache_key("https://api.bakery.ihaveasegway.com/", s, 3),
            "https://api.bakery.ihaveasegway.com/_cache/menu/01JC8Z6K3W9QF2N4T7XRB5M0HD/v3"
        );
        assert_ne!(
            cache_key("http://127.0.0.1:8788", s, 3),
            cache_key("http://127.0.0.1:8788", s, 4)
        );
    }

    #[test]
    fn if_none_match_reads_lists_weak_tags_and_star() {
        assert!(etag_matches("\"v3\"", "\"v3\""));
        assert!(etag_matches("W/\"v3\"", "\"v3\""));
        assert!(etag_matches("\"v1\", \"v3\"", "\"v3\""));
        assert!(etag_matches("*", "\"v3\""));
        assert!(!etag_matches("\"v2\"", "\"v3\""));
        assert!(!etag_matches("v3", "\"v3\""));
    }

    /// The menu the Catalog serves is the contract the storefront reads, field for field.
    #[test]
    fn the_domain_menu_is_the_contract_menu() {
        let g = bakery_seed::Generator::new(
            bakery_seed::Seed(42),
            bakery_seed::BirthDate::parse("2026-11-07").unwrap(),
        )
        .generate();
        let categories: Vec<Category> =
            serde_json::from_value(serde_json::to_value(&g.categories).unwrap()).unwrap();
        let items: Vec<Item> = g
            .items
            .iter()
            .map(|i| {
                let mut v = serde_json::to_value(i).unwrap();
                v["status"] = "available".into();
                serde_json::from_value(v).unwrap()
            })
            .collect();
        let variants: Vec<Variant> =
            serde_json::from_value(serde_json::to_value(&g.variants).unwrap()).unwrap();
        let view = Catalog::seeded(categories, items, variants)
            .unwrap()
            .menu_view();
        let wire = serde_json::to_value(&view).unwrap();
        let read: MenuResponse = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&read).unwrap(), wire);
        assert_eq!(read.version, 1);
        assert_eq!(view.etag(), etag(read.version));
    }
}
