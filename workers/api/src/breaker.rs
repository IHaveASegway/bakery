//! The 15-minute cron breaker's adapter (ADR 0010 decision 2.4; docs/cost.md, "Guardrails";
//! kill switch L0). `bakery_app::breaker` builds each GraphQL request, reads each answer, prices
//! the window and decides; this file adds the base URL, the token and the network, `Control`
//! keeps the state and raises the flag, and the 15-minute cron calls [`run`] after the sweep and
//! the status refresh. Nothing it sends or reads is logged: a line carries a meter's or a
//! dataset's name, a reason code, a status and dollars, never the token, an id, a URL with an id
//! in it or a body.
//!
//! Configuration, read from `Env`:
//!
//! - `BREAKER_API_TOKEN`, a secret: a Cloudflare API token with Account Analytics Read and Zone
//!   WAF Edit on this zone, sent as `Authorization: Bearer`.
//! - `ANALYTICS_ACCOUNT_ID`, the status refresh's secret: the GraphQL account tag.
//! - `BREAKER_ZONE_ID` and `BREAKER_RULE_ID`, secrets only because this repository's logs are
//!   public: the zone, and the pre-built, disabled WAF custom rule that blocks the API hostname.
//!   Letters and digits only, or the run is skipped.
//! - `BREAKER_CEILING_USD` and `BREAKER_BURST_FACTOR`, public vars in wrangler.jsonc ("100" and
//!   "4"), with `SANDBOX_CAP`: the lines. Zero either to force a trip.
//! - `BREAKER_API_BASE`, a local override (default `https://api.cloudflare.com/client/v4`),
//!   honored only for loopback hosts; anything else logs `breaker_base_refused` and uses the
//!   default.
//!
//! With a secret missing or ill-shaped the run logs `breaker_unconfigured` naming the first one
//! and stops, and the status keeps saying `unconfigured`. Each request has 5 s; the four reads go
//! one after another, so one dataset's failure never hides another's.

use bakery_app::Clock;
use bakery_app::analytics::{self as ae, Point};
use bakery_app::auth::is_local_override;
use bakery_app::breaker::{
    self as br, Dataset, Lines, Meter, ReadError, Reads, Window, read_sum, rule_patch_body,
    usd_text,
};
use bakery_contracts::BreakerState;
use serde_json::Value;
use worker::web_sys;
use worker::{AbortSignal, Env, Fetch, Headers, Method, Request, RequestInit, console_log};

use crate::analytics::ACCOUNT_ID;
use crate::clock::SystemClock;
use crate::config::{caps_from_env, read};
use crate::metrics;
use crate::objects::control::{self, BreakerAnswer, BreakerRuleEnabled, BreakerRun};

pub const TOKEN: &str = "BREAKER_API_TOKEN";
pub const ZONE_ID: &str = "BREAKER_ZONE_ID";
pub const RULE_ID: &str = "BREAKER_RULE_ID";
pub const API_BASE_VAR: &str = "BREAKER_API_BASE";
pub const CEILING_VAR: &str = "BREAKER_CEILING_USD";
pub const FACTOR_VAR: &str = "BREAKER_BURST_FACTOR";

/// The WAF custom rules' phase, whose entry point ruleset holds the kill rule.
const PHASE: &str = "http_request_firewall_custom";

/// Why the run did not start. Carries a name, never a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unconfigured {
    /// The variable is unset or empty.
    Missing(&'static str),
    /// Present but not letters and digits (an id) or not a number (a line's var).
    Shape(&'static str),
}

impl Unconfigured {
    fn log(self) {
        match self {
            Unconfigured::Missing(var) => {
                console_log!("{{\"event\":\"breaker_unconfigured\",\"var\":\"{var}\"}}");
            }
            Unconfigured::Shape(var) => console_log!(
                "{{\"event\":\"breaker_unconfigured\",\"var\":\"{var}\",\"reason\":\"shape\"}}"
            ),
        }
    }
}

/// Why a request gave no answer: a reason code, and the status when there was one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failed {
    pub reason: &'static str,
    pub status: Option<u16>,
}

impl Failed {
    fn because(reason: &'static str) -> Failed {
        Failed {
            reason,
            status: None,
        }
    }

    fn status_json(&self) -> String {
        self.status
            .map_or_else(|| "null".to_owned(), |s| s.to_string())
    }
}

impl From<ReadError> for Failed {
    fn from(e: ReadError) -> Failed {
        Failed {
            reason: e.code(),
            status: e.status(),
        }
    }
}

/// The base to use, and whether a set override was refused for pointing off this machine.
fn resolve_base(value: Option<&str>) -> (String, bool) {
    match value {
        None => (br::API_BASE.to_owned(), false),
        Some(v) if is_local_override(v) => (v.trim_end_matches('/').to_owned(), false),
        Some(_) => (br::API_BASE.to_owned(), true),
    }
}

/// The four secrets, checked in order, the first missing or ill-shaped one named.
fn check(
    token: Option<&str>,
    account: Option<&str>,
    zone: Option<&str>,
    rule: Option<&str>,
) -> Result<(), Unconfigured> {
    if token.is_none() {
        return Err(Unconfigured::Missing(TOKEN));
    }
    for (name, value) in [(ACCOUNT_ID, account), (ZONE_ID, zone), (RULE_ID, rule)] {
        match value {
            None => return Err(Unconfigured::Missing(name)),
            Some(v) if !ae::is_account_id(v) => return Err(Unconfigured::Shape(name)),
            Some(_) => {}
        }
    }
    Ok(())
}

/// The lines from `SANDBOX_CAP` and the two vars; an unset var is its default.
fn lines(cap: u32, ceiling: Option<&str>, factor: Option<&str>) -> Result<Lines, Unconfigured> {
    let ceiling = match ceiling {
        None => br::DEFAULT_CEILING_MICROS,
        Some(c) => br::parse_usd(c).ok_or(Unconfigured::Shape(CEILING_VAR))?,
    };
    let factor = match factor {
        None => br::DEFAULT_BURST_FACTOR,
        Some(f) => f
            .trim()
            .parse::<u32>()
            .map_err(|_| Unconfigured::Shape(FACTOR_VAR))?,
    };
    Ok(Lines::new(cap, ceiling, factor))
}

/// The lines this Worker's vars set: the run checks them before it reads, and `Control` decides
/// with them.
pub fn lines_from_env(env: &Env) -> Result<Lines, Unconfigured> {
    lines(
        caps_from_env(env).sandboxes,
        read(env, CEILING_VAR).as_deref(),
        read(env, FACTOR_VAR).as_deref(),
    )
}

/// The entry point ruleset's id and the kill rule as it holds it, from the GET's body, or the
/// reason code: `body` (not JSON), `shape` (no `result.id` fit for a path, or no `rules`),
/// `missing` (no rule with that id).
fn find_rule(body: &str, rule_id: &str) -> Result<(String, Value), &'static str> {
    let answer: Value = serde_json::from_str(body).map_err(|_| "body")?;
    let result = answer.get("result").ok_or("shape")?;
    let ruleset = result
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| ae::is_account_id(id))
        .ok_or("shape")?;
    let rule = result
        .get("rules")
        .and_then(Value::as_array)
        .ok_or("shape")?
        .iter()
        .find(|r| r.get("id").and_then(Value::as_str) == Some(rule_id))
        .ok_or("missing")?;
    Ok((ruleset.to_owned(), rule.clone()))
}

/// Whether the PATCH's body says it worked: `success: true`, or the reason code.
fn patched(body: &str) -> Result<(), &'static str> {
    let answer: Value = serde_json::from_str(body).map_err(|_| "body")?;
    match answer.get("success").and_then(Value::as_bool) {
        Some(true) => Ok(()),
        Some(false) => Err("refused"),
        None => Err("shape"),
    }
}

/// A JSON array of meter names, for a log line and `Control`'s request.
fn names(meters: &[Meter]) -> Vec<String> {
    meters.iter().map(|m| m.name().to_owned()).collect()
}

/// The adapter, built from `Env` when the secrets and the vars are there.
pub struct Breaker {
    base: String,
    token: String,
    account: String,
    zone: String,
    rule: String,
}

impl Breaker {
    pub fn from_env(env: &Env) -> Result<Breaker, Unconfigured> {
        let token = read(env, TOKEN);
        let account = read(env, ACCOUNT_ID);
        let zone = read(env, ZONE_ID);
        let rule = read(env, RULE_ID);
        check(
            token.as_deref(),
            account.as_deref(),
            zone.as_deref(),
            rule.as_deref(),
        )?;
        lines_from_env(env)?;
        let (base, refused) = resolve_base(read(env, API_BASE_VAR).as_deref());
        if refused {
            console_log!("{{\"event\":\"breaker_base_refused\",\"var\":\"{API_BASE_VAR}\"}}");
        }
        Ok(Breaker {
            base,
            token: token.unwrap_or_default(),
            account: account.unwrap_or_default(),
            zone: zone.unwrap_or_default(),
            rule: rule.unwrap_or_default(),
        })
    }

    /// One call with the bearer token and [`br::TIMEOUT_MS`] for it and its body: the status
    /// and the body's text.
    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
    ) -> Result<(u16, String), Failed> {
        let headers = Headers::new();
        headers
            .set("Authorization", &format!("Bearer {}", self.token))
            .map_err(|_| Failed::because("request"))?;
        if body.is_some() {
            headers
                .set("Content-Type", "application/json")
                .map_err(|_| Failed::because("request"))?;
        }
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(headers);
        if let Some(b) = body {
            init.with_body(Some(b.into()));
        }
        let url = format!("{}{path}", self.base);
        let req = Request::new_with_init(&url, &init).map_err(|_| Failed::because("request"))?;
        let signal = AbortSignal::from(web_sys::AbortSignal::timeout_with_u32(br::TIMEOUT_MS));
        let lost = |signal: &AbortSignal| {
            Failed::because(if signal.aborted() {
                "timeout"
            } else {
                "unreachable"
            })
        };
        let mut res = Fetch::Request(req)
            .send_with_signal(&signal)
            .await
            .map_err(|_| lost(&signal))?;
        let status = res.status_code();
        let text = res.text().await.map_err(|_| lost(&signal))?;
        Ok((status, text))
    }

    /// One dataset's request over `window`, as its meters' reads.
    async fn read(&self, dataset: Dataset, window: &Window) -> Result<Reads, Failed> {
        let body = br::graphql_body(dataset, &self.account, window);
        let (status, text) = self.send(Method::Post, "/graphql", Some(body)).await?;
        Ok(read_sum(status, &text, dataset)?)
    }

    /// Enables the kill rule: the entry point ruleset's GET, then the rule's PATCH with its own
    /// fields and `enabled: true`. The error names the step that failed.
    async fn enable_rule(&self) -> Result<(), (&'static str, Failed)> {
        let entry = format!("/zones/{}/rulesets/phases/{PHASE}/entrypoint", self.zone);
        let (status, text) = self
            .send(Method::Get, &entry, None)
            .await
            .map_err(|f| ("get", f))?;
        if status != 200 {
            return Err(("get", status_failed(status)));
        }
        let (ruleset, rule) =
            find_rule(&text, &self.rule).map_err(|r| ("get", Failed::because(r)))?;
        let path = format!(
            "/zones/{}/rulesets/{ruleset}/rules/{}",
            self.zone, self.rule
        );
        let body = rule_patch_body(&rule).to_string();
        let (status, text) = self
            .send(Method::Patch, &path, Some(body))
            .await
            .map_err(|f| ("patch", f))?;
        if status != 200 {
            return Err(("patch", status_failed(status)));
        }
        patched(&text).map_err(|r| ("patch", Failed::because(r)))
    }
}

fn status_failed(status: u16) -> Failed {
    Failed {
        reason: "status",
        status: Some(status),
    }
}

/// The 15-minute cron's breaker: the window's four reads, `Control`'s verdict, the point on a
/// trip and the rule when `Control` wants it. Never fails the cron.
pub async fn run(env: &Env) {
    let breaker = match Breaker::from_env(env) {
        Ok(b) => b,
        Err(u) => {
            u.log();
            return;
        }
    };
    let clock = SystemClock::new();
    let now = clock.now_wall();
    let window = br::window_before(now.unix_ms());
    let mut reads = Reads::default();
    for dataset in Dataset::ALL {
        match breaker.read(dataset, &window).await {
            Ok(r) => reads.merge(&r),
            Err(f) => {
                for meter in dataset.meters() {
                    console_log!(
                        "{{\"event\":\"breaker_meter_unread\",\"meter\":\"{}\",\"dataset\":\"{}\",\"reason\":\"{}\",\"status\":{}}}",
                        meter.name(),
                        dataset.name(),
                        f.reason,
                        f.status_json()
                    );
                }
            }
        }
    }
    // The cron's own run leaves at least one of each in every slot: a 0 is late data.
    for meter in [Meter::WorkerRequests, Meter::DoRequests] {
        if reads.get(meter) == Some(0) {
            console_log!(
                "{{\"event\":\"breaker_meter_empty\",\"meter\":\"{}\"}}",
                meter.name()
            );
        }
    }
    if reads.read_count() == 0 {
        console_log!("{{\"event\":\"breaker_failed\",\"reason\":\"unread\"}}");
        return;
    }
    let usd = usd_text(br::price_micros(&reads));
    let unread = names(&reads.unread());
    let run = BreakerRun {
        at: now.to_string(),
        usd: usd.clone(),
        meters: reads.to_wire(),
        unread: unread.clone(),
    };
    let answer: BreakerAnswer = match control::breaker(env, &run).await {
        Ok(a) => a,
        Err(e) => {
            console_log!(
                "{{\"event\":\"breaker_failed\",\"reason\":\"control\",\"error\":{:?}}}",
                e.to_string()
            );
            return;
        }
    };
    let unread_json = serde_json::to_string(&unread).unwrap_or_else(|_| "[]".to_owned());
    console_log!(
        "{{\"event\":\"breaker_read\",\"verdict\":\"{}\",\"usd\":\"{usd}\",\"read\":{},\"unread\":{unread_json}}}",
        answer.state.as_str(),
        reads.read_count()
    );
    let tripped = answer.state > answer.previous.max(BreakerState::Armed);
    if tripped {
        console_log!(
            "{{\"event\":\"breaker_tripped\",\"from\":\"{}\",\"to\":\"{}\",\"usd\":\"{usd}\"}}",
            answer.previous.as_str(),
            answer.state.as_str()
        );
        let level = br::level(answer.state);
        metrics::write(env, &Point::breaker(level, br::price_micros(&reads)));
        console_log!("{{\"event\":\"breaker_point\",\"level\":{level},\"usd\":\"{usd}\"}}");
    } else if answer.state >= BreakerState::ReadOnly {
        console_log!(
            "{{\"event\":\"breaker_held\",\"state\":\"{}\"}}",
            answer.state.as_str()
        );
    }
    if answer.rule_wanted {
        match breaker.enable_rule().await {
            Ok(()) => {
                console_log!("{{\"event\":\"breaker_rule_enabled\"}}");
                let at = BreakerRuleEnabled {
                    at: clock.now_wall().to_string(),
                };
                if let Err(e) = control::breaker_rule(env, &at).await {
                    console_log!(
                        "{{\"event\":\"breaker_failed\",\"reason\":\"control\",\"error\":{:?}}}",
                        e.to_string()
                    );
                }
            }
            Err((step, f)) => console_log!(
                "{{\"event\":\"breaker_rule_failed\",\"step\":\"{step}\",\"reason\":\"{}\",\"status\":{}}}",
                f.reason,
                f.status_json()
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "killrule0fake";

    #[test]
    fn the_base_is_overridden_on_this_machine_only() {
        assert_eq!(resolve_base(None), (br::API_BASE.to_owned(), false));
        assert_eq!(
            resolve_base(Some("http://127.0.0.1:8793/")),
            ("http://127.0.0.1:8793".to_owned(), false)
        );
        assert_eq!(
            resolve_base(Some("http://localhost:8793")),
            ("http://localhost:8793".to_owned(), false)
        );
        for refused in [
            "https://api.example.com/client/v4",
            "http://127.0.0.1.example.com",
            "http://user@127.0.0.1:8793",
        ] {
            assert_eq!(
                resolve_base(Some(refused)),
                (br::API_BASE.to_owned(), true),
                "{refused}"
            );
        }
    }

    #[test]
    fn every_secret_is_needed_and_each_id_must_fit_a_path() {
        let s = Some("t");
        assert_eq!(check(s, Some(ID), Some(ID), Some(ID)), Ok(()));
        assert_eq!(
            check(None, None, None, None),
            Err(Unconfigured::Missing(TOKEN))
        );
        assert_eq!(
            check(s, None, None, None),
            Err(Unconfigured::Missing(ACCOUNT_ID))
        );
        assert_eq!(
            check(s, Some(ID), None, Some(ID)),
            Err(Unconfigured::Missing(ZONE_ID))
        );
        assert_eq!(
            check(s, Some(ID), Some(ID), None),
            Err(Unconfigured::Missing(RULE_ID))
        );
        assert_eq!(
            check(s, Some(ID), Some("../zones"), Some(ID)),
            Err(Unconfigured::Shape(ZONE_ID))
        );
        assert_eq!(
            check(s, Some(ID), Some(ID), Some("a b")),
            Err(Unconfigured::Shape(RULE_ID))
        );
    }

    #[test]
    fn the_lines_come_from_the_vars_or_their_defaults() {
        assert_eq!(lines(300, None, None), Ok(Lines::new(300, 100_000_000, 4)));
        assert_eq!(
            lines(300, Some("100"), Some("4")),
            Ok(Lines::new(300, 100_000_000, 4))
        );
        let zero = lines(300, Some("0"), Some("0")).unwrap();
        assert_eq!((zero.dollar_micros, zero.off_micros), (0, 0));
        assert_eq!(
            lines(300, Some("lots"), None),
            Err(Unconfigured::Shape(CEILING_VAR))
        );
        assert_eq!(
            lines(300, None, Some("2.5")),
            Err(Unconfigured::Shape(FACTOR_VAR))
        );
    }

    #[test]
    fn the_rule_is_found_by_its_id_in_the_entry_point_ruleset() {
        let body = serde_json::json!({
            "success": true,
            "errors": [],
            "result": {
                "id": "ruleset0fake",
                "phase": "http_request_firewall_custom",
                "rules": [
                    {"id": "other0fake", "action": "log", "expression": "true", "enabled": true},
                    {"id": ID, "action": "block", "expression": "(http.host eq \"api.bakery.ihaveasegway.com\")", "description": "Kill switch L3", "enabled": false}
                ]
            }
        })
        .to_string();
        let (ruleset, rule) = find_rule(&body, ID).unwrap();
        assert_eq!(ruleset, "ruleset0fake");
        assert_eq!(rule["action"], "block");
        assert_eq!(rule_patch_body(&rule)["enabled"], true);
        assert_eq!(find_rule(&body, "absent0fake"), Err("missing"));
        assert_eq!(find_rule("not json", ID), Err("body"));
        assert_eq!(find_rule(r#"{"success":false}"#, ID), Err("shape"));
        assert_eq!(
            find_rule(r#"{"result":{"id":"../x","rules":[]}}"#, ID),
            Err("shape")
        );
        assert_eq!(
            find_rule(r#"{"result":{"id":"ruleset0fake"}}"#, ID),
            Err("shape")
        );
    }

    #[test]
    fn a_patch_worked_only_when_it_says_so() {
        assert_eq!(patched(r#"{"success":true,"result":{}}"#), Ok(()));
        assert_eq!(patched(r#"{"success":false,"errors":[]}"#), Err("refused"));
        assert_eq!(patched(r#"{"result":{}}"#), Err("shape"));
        assert_eq!(patched("<html>"), Err("body"));
    }

    #[test]
    fn a_read_error_keeps_its_code_and_status() {
        assert_eq!(
            Failed::from(ReadError::Status(403)),
            Failed {
                reason: "status",
                status: Some(403)
            }
        );
        assert_eq!(Failed::from(ReadError::GraphQl).reason, "graphql");
        assert_eq!(Failed::from(ReadError::GraphQl).status_json(), "null");
        assert_eq!(
            names(&[Meter::RowsWritten, Meter::DoGbS]),
            ["rows_written", "do_gb_s"]
        );
    }
}
