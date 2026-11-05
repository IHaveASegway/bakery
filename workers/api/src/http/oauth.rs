//! Google and GitHub sign-in (docs/security.md, "Google, with the openid scope alone" and
//! "GitHub, with the numeric user id alone"). bakery-app builds every URL and body and parses
//! every reply; this module draws the randomness, makes the requests and sets the cookies.
//!
//! A callback that fails anywhere sends the visitor to `/signin/?error=<slug>` with nothing
//! else in the URL, clears `__Host-oauth`, and logs the step's reason code alone.

use std::cell::{Cell, RefCell};

use bakery_app::auth::{
    AccountKind, Client, Discovery, Expected, JwkSet, Keyring, OAUTH_COOKIE, OAuthError,
    OAuthTransaction, Provider, SessionClaims, accepted_issuers, account_id, clear_oauth_cookie,
    cookie_value, github_authorize_url, github_token_request, google_authorize_url,
    google_token_request, hex, issue_transaction, oauth_cookie, parse_github_token,
    parse_github_user, parse_google_tokens, verify_google_id_token, verify_transaction,
};
use bakery_app::names::account_object_name;
use bakery_domain::WallTime;
use worker::{Method, Request, Response, Url};

use super::Cx;
use super::auth::set_session;
use super::outbound::{self, Reply};
use super::problem::{self, Failure};
use crate::config::Config;
use crate::objects::account::{self, Current, SignIn};
use crate::objects::sql::call;
use crate::random;

type Answer = Result<Response, Failure>;

/// How long a discovery document or key set is kept without a `max-age` (pr3 spec).
const DEFAULT_CACHE_S: i64 = 3_600;
/// An unknown `kid` refetches the key set at most this often (IdTokenError::may_be_stale_keys).
const REFETCH_GAP_MS: i64 = 60_000;
const USER_AGENT: &str = "bakery-api";

struct Cached<T> {
    url: String,
    value: T,
    until_ms: i64,
}

thread_local! {
    static DISCOVERY: RefCell<Option<Cached<Discovery>>> = const { RefCell::new(None) };
    static JWKS: RefCell<Option<Cached<JwkSet>>> = const { RefCell::new(None) };
    static JWKS_FETCHED_MS: Cell<i64> = const { Cell::new(i64::MIN) };
}

fn until(now: WallTime, reply: &Reply) -> i64 {
    now.unix_ms() + reply.max_age_s.unwrap_or(DEFAULT_CACHE_S).max(0) * 1_000
}

/// The issuer's discovery document, from the isolate's cache while it is fresh.
async fn discovery(cfg: &Config, now: WallTime) -> Option<Discovery> {
    let url = Discovery::url(&cfg.google_issuer);
    let hit = DISCOVERY.with_borrow(|c| {
        c.as_ref()
            .filter(|c| c.url == url && now.unix_ms() < c.until_ms)
            .map(|c| c.value.clone())
    });
    if hit.is_some() {
        return hit;
    }
    let reply = outbound::send(Method::Get, &url, &[], None).await.ok()?;
    if !reply.ok() {
        return None;
    }
    let value = Discovery::parse(&reply.body, &cfg.google_issuer).ok()?;
    DISCOVERY.with_borrow_mut(|c| {
        *c = Some(Cached {
            url,
            value: value.clone(),
            until_ms: until(now, &reply),
        })
    });
    Some(value)
}

/// The key set, cached like the discovery document; `refetch` skips the cache.
async fn jwks(d: &Discovery, now: WallTime, refetch: bool) -> Option<JwkSet> {
    if !refetch {
        let hit = JWKS.with_borrow(|c| {
            c.as_ref()
                .filter(|c| c.url == d.jwks_uri && now.unix_ms() < c.until_ms)
                .map(|c| c.value.clone())
        });
        if hit.is_some() {
            return hit;
        }
    }
    JWKS_FETCHED_MS.set(now.unix_ms());
    let reply = outbound::send(Method::Get, &d.jwks_uri, &[], None)
        .await
        .ok()?;
    if !reply.ok() {
        return None;
    }
    let value = JwkSet::parse(&reply.body).ok()?;
    JWKS.with_borrow_mut(|c| {
        *c = Some(Cached {
            url: d.jwks_uri.clone(),
            value: value.clone(),
            until_ms: until(now, &reply),
        })
    });
    Some(value)
}

fn redirect_uri(cx: &Cx, provider: Provider) -> Result<String, Failure> {
    Ok(format!(
        "{}/v1/auth/{}/callback",
        cx.cfg.api_origin()?,
        provider.as_str()
    ))
}

fn query(req: &Request, name: &str) -> Option<String> {
    req.url()
        .ok()?
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// A redirect built by hand: `Response.redirect()` returns immutable headers, and these
/// responses still need their cookies.
fn redirect(location: &str, status: u16) -> Answer {
    let url = Url::parse(location).map_err(|_| problem::internal())?;
    let mut res = Response::empty()?.with_status(status);
    res.headers_mut().set("Location", url.as_str())?;
    Ok(res)
}

/// The failure redirect: the slug alone in the URL, the step's reason alone in the log.
fn fail(cx: &Cx, slug: &'static str, reason: &'static str) -> Answer {
    cx.reason(reason);
    let origin = cx.cfg.origin()?;
    let mut res = redirect(&format!("{origin}/signin/?error={slug}"), 303)?;
    res.headers_mut()
        .append("Set-Cookie", &clear_oauth_cookie())?;
    Ok(res)
}

/// Both start routes: a fresh transaction in `__Host-oauth`, and a 302 to the provider.
async fn start(cx: &Cx, req: &Request, provider: Provider) -> Answer {
    let keyring = cx.keyring()?;
    cx.cfg.origin()?;
    let ret = query(req, "return");
    let tx = OAuthTransaction::new_from_random(
        provider,
        &random::bytes::<96>()?,
        ret.as_deref(),
        cx.now,
    );
    let target = match provider {
        Provider::Google => {
            let (client_id, _) = cx.cfg.google()?;
            let Some(d) = discovery(&cx.cfg, cx.now).await else {
                return fail(cx, "oauth", "discovery");
            };
            google_authorize_url(
                &d.authorization_endpoint,
                client_id,
                &redirect_uri(cx, provider)?,
                &tx,
            )
        }
        Provider::Github => {
            let (client_id, _) = cx.cfg.github()?;
            github_authorize_url(
                &cx.cfg.github_authorize_url,
                client_id,
                &redirect_uri(cx, provider)?,
                &tx,
            )
        }
    };
    let mut res = redirect(&target, 302)?;
    res.headers_mut().append(
        "Set-Cookie",
        &oauth_cookie(&issue_transaction(&tx, &keyring)),
    )?;
    Ok(res)
}

pub async fn google_start(cx: &Cx, req: &Request) -> Answer {
    start(cx, req, Provider::Google).await
}

pub async fn github_start(cx: &Cx, req: &Request) -> Answer {
    start(cx, req, Provider::Github).await
}

/// The transaction from `__Host-oauth`, checked against the callback's `state`. Every way
/// it can fail is the same `state` failure for the visitor.
fn transaction(
    keyring: &Keyring,
    req: &Request,
    provider: Provider,
    now: WallTime,
) -> Option<OAuthTransaction> {
    let header = req.headers().get("Cookie").ok().flatten()?;
    let token = cookie_value(&header, OAUTH_COOKIE)?;
    let state = query(req, "state")?;
    verify_transaction(token, keyring, provider, &state, now).ok()
}

pub async fn google_callback(cx: &Cx, req: &Request) -> Answer {
    let (client_id, client_secret) = cx.cfg.google()?;
    let account_key = cx.cfg.account_key()?;
    cx.cfg.origin()?;
    let keyring = cx.keyring()?;
    let Some(tx) = transaction(&keyring, req, Provider::Google, cx.now) else {
        return fail(cx, OAuthError::State.slug(), "state");
    };
    let Some(code) = query(req, "code") else {
        return fail(cx, "oauth", "no-code");
    };
    let Some(d) = discovery(&cx.cfg, cx.now).await else {
        return fail(cx, "oauth", "discovery");
    };
    let redirect_uri = redirect_uri(cx, Provider::Google)?;
    let client = Client {
        client_id,
        client_secret,
        redirect_uri: &redirect_uri,
    };
    let body = google_token_request(&client, &code, &tx.verifier);
    let Ok(reply) = outbound::send(
        Method::Post,
        &d.token_endpoint,
        &[("Accept", "application/json")],
        Some(&body),
    )
    .await
    else {
        return fail(cx, "exchange", "exchange-unreachable");
    };
    if !reply.ok() {
        return fail(cx, "exchange", "exchange");
    }
    let tokens = match parse_google_tokens(&reply.body) {
        Ok(t) => t,
        Err(e) => return fail(cx, e.slug(), e.slug()),
    };
    let expected = Expected {
        issuers: accepted_issuers(&cx.cfg.google_issuer),
        client_id: client_id.to_owned(),
        nonce: tx.nonce.clone().unwrap_or_default(),
    };
    let Some(keys) = jwks(&d, cx.now, false).await else {
        return fail(cx, "token", "keys");
    };
    let identity = match verify_google_id_token(&tokens.id_token, &keys, &expected, cx.now) {
        Ok(identity) => identity,
        Err(e)
            if e.may_be_stale_keys()
                && cx.now.unix_ms() - JWKS_FETCHED_MS.get() >= REFETCH_GAP_MS =>
        {
            let Some(keys) = jwks(&d, cx.now, true).await else {
                return fail(cx, "token", "keys");
            };
            match verify_google_id_token(&tokens.id_token, &keys, &expected, cx.now) {
                Ok(identity) => identity,
                Err(e) => return fail(cx, "token", e.reason()),
            }
        }
        Err(e) => return fail(cx, "token", e.reason()),
    };
    // `sub` becomes the account id here and is dropped with `identity`: never stored or logged.
    let id = account_id(account_key, AccountKind::Google, &identity.sub);
    drop(identity);
    signed_in(cx, AccountKind::Google, id, &tx.ret).await
}

pub async fn github_callback(cx: &Cx, req: &Request) -> Answer {
    let (client_id, client_secret) = cx.cfg.github()?;
    let account_key = cx.cfg.account_key()?;
    cx.cfg.origin()?;
    let keyring = cx.keyring()?;
    let Some(tx) = transaction(&keyring, req, Provider::Github, cx.now) else {
        return fail(cx, OAuthError::State.slug(), "state");
    };
    let Some(code) = query(req, "code") else {
        return fail(cx, "oauth", "no-code");
    };
    let redirect_uri = redirect_uri(cx, Provider::Github)?;
    let client = Client {
        client_id,
        client_secret,
        redirect_uri: &redirect_uri,
    };
    let body = github_token_request(&client, &code, &tx.verifier);
    // GitHub answers a bad code with 200 and an `error` object, which the parser refuses.
    let Ok(reply) = outbound::send(
        Method::Post,
        &cx.cfg.github_token_url,
        &[("Accept", "application/json"), ("User-Agent", USER_AGENT)],
        Some(&body),
    )
    .await
    else {
        return fail(cx, "exchange", "exchange-unreachable");
    };
    let token = match parse_github_token(&reply.body) {
        Ok(t) if reply.ok() => t,
        _ => return fail(cx, "exchange", "exchange"),
    };
    let authorization = token.authorization();
    // The token is used for this one request and dropped.
    drop(token);
    let user = outbound::send(
        Method::Get,
        &cx.cfg.github_user_url,
        &[
            ("Authorization", &authorization),
            ("User-Agent", USER_AGENT),
            ("Accept", "application/vnd.github+json"),
        ],
        None,
    )
    .await;
    drop(authorization);
    let user = match user {
        Ok(reply) if reply.ok() => parse_github_user(&reply.body),
        _ => Err(OAuthError::Provider),
    };
    let user = match user {
        Ok(u) => u,
        Err(e) => return fail(cx, e.slug(), e.slug()),
    };
    let id = account_id(account_key, AccountKind::Github, &user.subject());
    signed_in(cx, AccountKind::Github, id, &tx.ret).await
}

/// The `Account` learns of the sign-in, the session cookie is set, `__Host-oauth` cleared,
/// and the visitor goes back to the storefront path the transaction carried.
async fn signed_in(cx: &Cx, kind: AccountKind, id: String, ret: &str) -> Answer {
    let keyring = cx.keyring()?;
    let origin = cx.cfg.origin()?;
    let sid = random::bytes::<16>()?;
    let res = call(
        &cx.env,
        account::BINDING,
        &account_object_name(&id),
        Method::Post,
        "/_signin",
        Some(&SignIn {
            account_id: id.clone(),
            kind,
            sid: hex(&sid),
        }),
    )
    .await;
    let current: Current = match res {
        Ok(mut r) if r.status_code() == 200 => r.json().await?,
        _ => return fail(cx, "oauth", "account"),
    };
    cx.sandbox(current.current_sandbox);
    let claims = SessionClaims::account(kind, id, current.current_sandbox, &sid, cx.now);
    // `ret` passed bakery_app's return_path, so it is a path on the storefront.
    let mut res = redirect(&format!("{origin}{ret}"), 303)?;
    set_session(&mut res, &claims, &keyring)?;
    res.headers_mut()
        .append("Set-Cookie", &clear_oauth_cookie())?;
    Ok(res)
}
