//! The Stripe adapter: `bakery_app::ports::PaymentGateway` over `fetch` (ADR 0007, decisions 2, 3
//! and 8; docs/security.md, "Payments safety"). `bakery_app::stripe` builds every request and
//! reads every answer; this file adds the base URL, the headers and the network, and nothing it
//! reads is logged: a log line carries a reason code and ids, never a key, a body, a client
//! secret or a signature.
//!
//! Configuration, read from `Env`:
//!
//! - `STRIPE_SECRET_KEY`, a secret: a sandbox's restricted (`rk_test_`) or secret (`sk_test_`)
//!   key. The guard runs on every use and its verdict is kept for the isolate: any other key
//!   makes every payment path answer 503 `stripe-key`, and the isolate logs
//!   `stripe_key_refused` once. No call to Stripe is made with it.
//! - `STRIPE_WEBHOOK_SECRET`, a secret: the endpoint's `whsec_` signing secret.
//! - `STRIPE_PUBLISHABLE_KEY`, a var: the `pk_test_` key the payment answer hands the browser,
//!   when set. A key in any other shape is never handed out.
//! - `STRIPE_API_BASE`, a local override (default `https://api.stripe.com`), honored only for
//!   loopback hosts, as the provider overrides are (config.rs); `scripts/fake-stripe.mjs` serves
//!   it on `http://127.0.0.1:8791`.
//! - `STRIPE_API_VERSION`, optional: sent as `Stripe-Version` when set, else the account's
//!   default version applies (spike S3 reads it from the dashboard and pins it).

use std::cell::Cell;

use bakery_app::ports::{
    CancelRequest, ConfirmRequest, IntentCreated, IntentRequest, IntentSnapshot, PaymentGateway,
    PortError, RefundCreated, RefundIntentRequest,
};
use bakery_app::stripe::{
    self as wire, API_BASE, KeyKind, Metadata, PaymentIntent, StripeRequest, is_sandbox_secret_key,
    is_webhook_secret,
};
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, console_log};

use crate::config::{ConfigError, provider_url, read};

pub const SECRET_KEY: &str = "STRIPE_SECRET_KEY";
pub const WEBHOOK_SECRET: &str = "STRIPE_WEBHOOK_SECRET";
pub const PUBLISHABLE_KEY: &str = "STRIPE_PUBLISHABLE_KEY";
pub const API_BASE_VAR: &str = "STRIPE_API_BASE";
pub const API_VERSION_VAR: &str = "STRIPE_API_VERSION";

thread_local! {
    /// The guard's verdict on this isolate's `STRIPE_SECRET_KEY`, once it has run.
    static KEY_OK: Cell<Option<bool>> = const { Cell::new(None) };
}

/// Why a payment path cannot reach Stripe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    /// A secret is missing or misshapen: 503 `config`, naming it.
    Config(ConfigError),
    /// `STRIPE_SECRET_KEY` is not a sandbox key: 503 `stripe-key`.
    Key,
}

impl Unavailable {
    /// The refusal an object answers with, codes only.
    pub fn code(self) -> &'static str {
        match self {
            Unavailable::Config(_) => "config",
            Unavailable::Key => "stripe-key",
        }
    }
}

/// The key guard (ADR 0007, decision 2). Pure, so it is tested natively; [`key_guard`] keeps
/// its verdict for the isolate and logs a refusal once.
pub fn check_key(key: Option<&str>) -> Result<(), Unavailable> {
    match key {
        None => Err(Unavailable::Config(ConfigError::Missing(SECRET_KEY))),
        Some(k) if is_sandbox_secret_key(k) => Ok(()),
        Some(_) => Err(Unavailable::Key),
    }
}

/// [`check_key`] on this isolate's key, its verdict cached; `stripe_key_refused` is logged the
/// first time it refuses, and never with the key.
pub fn key_guard(env: &Env) -> Result<String, Unavailable> {
    let key = read(env, SECRET_KEY);
    let verdict = check_key(key.as_deref());
    match verdict {
        Ok(()) => {
            KEY_OK.set(Some(true));
            Ok(key.unwrap_or_default())
        }
        Err(Unavailable::Key) => {
            if KEY_OK.replace(Some(false)) != Some(false) {
                let kind = match KeyKind::classify(key.as_deref().unwrap_or("")) {
                    KeyKind::Live => "other-mode",
                    KeyKind::Test => "not-a-secret-key",
                    KeyKind::Other => "unrecognized",
                };
                console_log!("{{\"event\":\"stripe_key_refused\",\"kind\":\"{kind}\"}}");
            }
            Err(Unavailable::Key)
        }
        Err(e) => Err(e),
    }
}

/// `STRIPE_WEBHOOK_SECRET`, if it is an endpoint secret.
pub fn webhook_secret(env: &Env) -> Result<String, ConfigError> {
    let secret = read(env, WEBHOOK_SECRET).ok_or(ConfigError::Missing(WEBHOOK_SECRET))?;
    if is_webhook_secret(&secret) {
        Ok(secret)
    } else {
        Err(ConfigError::Shape(WEBHOOK_SECRET))
    }
}

/// `STRIPE_PUBLISHABLE_KEY`, only when it is a sandbox publishable key.
pub fn publishable_key(env: &Env) -> Option<String> {
    read(env, PUBLISHABLE_KEY)
        .filter(|k| k.starts_with("pk_") && KeyKind::classify(k) == KeyKind::Test)
}

/// The adapter, built per request from `Env` after the guard has passed.
pub struct Stripe {
    base: String,
    secret: String,
    version: Option<String>,
}

impl Stripe {
    pub fn from_env(env: &Env) -> Result<Stripe, Unavailable> {
        let secret = key_guard(env)?;
        Ok(Stripe {
            base: provider_url(env, API_BASE_VAR, API_BASE),
            secret,
            version: read(env, API_VERSION_VAR),
        })
    }

    /// One call: the status and the body text. The guard runs again before the request is
    /// built, so no call ever leaves with a key that is not a sandbox key.
    async fn send(&self, r: &StripeRequest) -> Result<(u16, String), PortError> {
        if check_key(Some(&self.secret)).is_err() {
            return Err(PortError::Rejected("stripe-key".into()));
        }
        let unreachable = |_| PortError::Unavailable("unreachable".into());
        let headers = Headers::new();
        for (k, v) in r.headers(&self.secret, self.version.as_deref()) {
            headers.set(k, &v).map_err(unreachable)?;
        }
        let mut init = RequestInit::new();
        init.with_headers(headers);
        match &r.body {
            Some(body) => {
                init.with_method(Method::Post);
                init.with_body(Some(body.as_str().into()));
            }
            None => {
                init.with_method(Method::Get);
            }
        }
        let req = Request::new_with_init(&r.url(&self.base), &init).map_err(unreachable)?;
        let mut res = Fetch::Request(req).send().await.map_err(unreachable)?;
        let status = res.status_code();
        let text = res.text().await.map_err(unreachable)?;
        Ok((status, text))
    }

    /// An intent's `metadata`, read from Stripe: how a refund's webhook finds its sandbox, since
    /// a refund's own metadata is whatever its creator gave it, not the intent's.
    pub async fn intent_metadata(&self, intent: &str) -> Result<Metadata, PortError> {
        let (status, body) = self.send(&wire::retrieve_intent(intent)?).await?;
        let pi: PaymentIntent = wire::parse(status, &body)?;
        if pi.livemode {
            return Err(PortError::Rejected("livemode".into()));
        }
        Ok(pi.metadata)
    }
}

impl PaymentGateway for Stripe {
    async fn create_intent(&self, request: IntentRequest) -> Result<IntentCreated, PortError> {
        let (status, body) = self.send(&wire::create_intent(&request)).await?;
        wire::read_intent_created(status, &body)
    }

    async fn confirm_intent(&self, request: ConfirmRequest) -> Result<IntentSnapshot, PortError> {
        let (status, body) = self.send(&wire::confirm_intent(&request)?).await?;
        wire::read_intent(status, &body, &request.intent)
    }

    async fn cancel_intent(&self, request: CancelRequest) -> Result<IntentSnapshot, PortError> {
        let (status, body) = self.send(&wire::cancel_intent(&request)?).await?;
        wire::read_intent(status, &body, &request.intent)
    }

    async fn refund(&self, request: RefundIntentRequest) -> Result<RefundCreated, PortError> {
        let (status, body) = self.send(&wire::create_refund(&request)?).await?;
        wire::read_refund(status, &body)
    }

    async fn retrieve_intent(&self, intent: &str) -> Result<IntentSnapshot, PortError> {
        let (status, body) = self.send(&wire::retrieve_intent(intent)?).await?;
        wire::read_intent(status, &body, intent)
    }
}

/// A port error as a reason code for a log line or an object's refusal: the code Stripe gave,
/// never its message.
pub fn reason(e: &PortError) -> String {
    match e {
        PortError::Unavailable(r) | PortError::Rejected(r) => r.clone(),
        PortError::Conflict { .. } => "conflict".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key in the mode the bakery never uses, built from parts so that no such prefix is
    /// written out anywhere in the tree.
    fn other_mode(role: &str) -> String {
        format!("{role}_{}_fake000000000000000000000000", "live")
    }

    #[test]
    fn the_guard_takes_sandbox_secret_and_restricted_keys_only() {
        assert_eq!(
            check_key(Some("rk_test_fake000000000000000000000000")),
            Ok(())
        );
        assert_eq!(
            check_key(Some("sk_test_fake000000000000000000000000")),
            Ok(())
        );
        for refused in [
            other_mode("sk"),
            other_mode("rk"),
            "pk_test_fake000000000000000000000000".to_owned(),
            "whsec_fake0000000000000000000000000000".to_owned(),
            "sk_test_".to_owned(),
            "not a key".to_owned(),
        ] {
            assert_eq!(
                check_key(Some(&refused)),
                Err(Unavailable::Key),
                "{refused}"
            );
        }
        assert_eq!(
            check_key(None),
            Err(Unavailable::Config(ConfigError::Missing(SECRET_KEY)))
        );
        assert_eq!(Unavailable::Key.code(), "stripe-key");
    }

    #[test]
    fn reasons_are_codes() {
        assert_eq!(
            reason(&PortError::Rejected("amount_too_large".into())),
            "amount_too_large"
        );
        assert_eq!(
            reason(&PortError::Unavailable("unreachable".into())),
            "unreachable"
        );
    }
}
