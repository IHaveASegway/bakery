//! The API's types, written once (docs/architecture.md, "The published language").
//!
//! Each type derives `serde` for the wire and `schemars::JsonSchema` for the web app: the
//! `export-schemas` binary writes one JSON Schema per type into `schemas/`, the web build turns
//! those into TypeScript, and a test fails when the committed schemas are stale.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// `GET /v1/health`: the Worker answers, and which build it is. Touches no object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HealthResponse {
    pub status: HealthStatus,
    /// The commit the bundle was built from; `dev` on a laptop.
    pub commit: String,
    /// The API's version.
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
}

/// `GET /v1/status`: today's admission state, from the `Control` object.
///
/// The field order is fixed and is the wire order: the day and the sandbox count and cap
/// (PR 2), then the guest and demo-account counts and caps (PR 3), then the flag. Readers go
/// by name, so PR 2's smoke check still passes; a new field is added before `flag`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StatusResponse {
    /// Today's UTC date, `YYYY-MM-DD`: the key of the daily ledger.
    pub day: String,
    /// Sandboxes admitted today, guests' included.
    pub sandboxes_today: u32,
    /// The most sandboxes admitted in one UTC day.
    pub sandbox_cap: u32,
    /// Guest sandboxes admitted today.
    pub guests_today: u32,
    /// The guests' share of the day's sandboxes.
    pub guest_cap: u32,
    /// Demo accounts created today.
    pub demo_accounts_today: u32,
    /// The most demo accounts created in one UTC day.
    pub demo_account_cap: u32,
    /// The demo's flag.
    pub flag: Flag,
}

/// The demo's mode, set in `Control` (kill switch L1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Flag {
    /// Everything works.
    Live,
    /// Reads work; commands get 503.
    ReadOnly,
    /// Only the storefront's static pages work.
    Off,
}

impl Flag {
    /// The text stored in `Control`'s `flags` table, the same as on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Flag::Live => "live",
            Flag::ReadOnly => "read-only",
            Flag::Off => "off",
        }
    }

    pub fn parse(text: &str) -> Option<Flag> {
        match text {
            "live" => Some(Flag::Live),
            "read-only" => Some(Flag::ReadOnly),
            "off" => Some(Flag::Off),
            _ => None,
        }
    }
}

/// An error body, `application/problem+json` (RFC 9457).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Problem {
    /// A URI reference naming the problem type; `about:blank` when the status says it all.
    #[serde(rename = "type")]
    pub problem_type: String,
    /// A short summary that does not change between occurrences.
    pub title: String,
    /// The HTTP status code.
    pub status: u16,
    /// What went wrong this time, for a person to read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The request path this occurrence concerns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

/// Where the problem types' pages live, on the storefront; the pages arrive with the API docs
/// in PR 10.
pub const PROBLEM_BASE: &str = "https://bakery.ihaveasegway.com/problems/";

impl Problem {
    /// A problem with its own type, `https://bakery.ihaveasegway.com/problems/<slug>`. The slug
    /// is a constant in the router (`origin`, `session`, `sandbox-cap` and the rest), and the
    /// title is the same for every occurrence.
    pub fn typed(slug: &str, status: u16, title: &str, detail: impl Into<String>) -> Problem {
        Problem {
            problem_type: format!("{PROBLEM_BASE}{slug}"),
            title: title.to_owned(),
            status,
            detail: Some(detail.into()),
            instance: None,
        }
    }

    /// A problem whose type is `about:blank`, so its title is the status's reason phrase.
    pub fn status(status: u16, title: &str) -> Problem {
        Problem {
            problem_type: "about:blank".to_owned(),
            title: title.to_owned(),
            status,
            detail: None,
            instance: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Problem {
        self.detail = Some(detail.into());
        self
    }

    pub fn with_instance(mut self, instance: impl Into<String>) -> Problem {
        self.instance = Some(instance.into());
        self
    }
}

/// How a session signed in. A guest has no account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Guest,
    Google,
    Github,
    Demo,
}

/// `GET /v1/session`, and the answer to a demo sign-in: what the cookie says, read without an
/// object call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionResponse {
    pub kind: SessionKind,
    /// The account id, 64 hex characters; `null` for a guest.
    pub account: Option<String>,
    /// The current sandbox's ULID, if any.
    pub sandbox: Option<String>,
    /// When the cookie stops being accepted, a wall time such as `2026-11-05T12:00:00.000Z`.
    pub expires_at: String,
}

/// Whose a sandbox is: a guest's, behind Turnstile, or a signed-in account's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SandboxKind {
    Guest,
    Account,
}

/// A sandbox's lifecycle (docs/domain.md, "Sandbox").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SandboxState {
    Seeding,
    Live,
    /// Every command gets 410 from here on.
    Wiping,
    Wiped,
}

/// The sandbox's fault switches. `inbox` makes the broken-subscriber demo's Inbox fail (PR 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Faults {
    pub inbox: bool,
}

/// The faults a visitor may set. PR 3 ships one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FaultName {
    Inbox,
}

/// `POST /v1/sandboxes` (201 or 200) and `GET /v1/sandboxes/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SandboxResponse {
    /// The sandbox's ULID.
    pub id: String,
    pub kind: SandboxKind,
    pub state: SandboxState,
    /// A wall time.
    pub born: String,
    /// The first 10:00 UTC after `born`, a wall time.
    pub wipe_at: String,
    /// The seed the sandbox was generated from. A JSON number: JavaScript reads it exactly only
    /// below 2^53, so the router mints seeds in that range.
    pub seed: u64,
    /// Business time minus wall time, in seconds (docs/architecture.md, "Time travel").
    pub clock_offset_s: i64,
    /// Bumped by every clock advance.
    pub clock_v: u32,
    /// Bumped by every API token rotation.
    pub token_v: u32,
    pub faults: Faults,
    /// Registered child objects; none in PR 3.
    pub children: u32,
}

/// `POST /v1/auth/demo`. The password never reaches an object, a log or this type's `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DemoSignupRequest {
    /// 12 to 128 characters, no composition rules.
    pub password: String,
    pub turnstile_token: String,
}

impl std::fmt::Debug for DemoSignupRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DemoSignupRequest { .. }")
    }
}

/// `201` from `POST /v1/auth/demo`: the generated username, shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DemoSignupResponse {
    /// `baker-` and four characters, such as `baker-7f3k`.
    pub username: String,
}

/// `POST /v1/auth/demo/signin`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DemoSigninRequest {
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for DemoSigninRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DemoSigninRequest { .. }")
    }
}

/// `POST /v1/sandboxes`. A guest needs `turnstile_token`; an account that already has a live
/// sandbox gets it back unless `replace` is true.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateSandboxRequest {
    #[serde(default)]
    pub turnstile_token: Option<String>,
    #[serde(default)]
    pub replace: bool,
}

/// `POST /v1/sandboxes/{id}/faults`, signed-in sessions only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FaultRequest {
    pub fault: FaultName,
    pub on: bool,
}

/// The answer to a fault change: every switch as it now stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FaultsResponse {
    pub faults: Faults,
}

/// `DELETE /v1/sandboxes/{id}`, "Wipe now": the sandbox is gone when this answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WipedResponse {
    pub id: String,
    /// Always `wiped`.
    pub state: SandboxState,
}

impl WipedResponse {
    pub fn new(id: impl Into<String>) -> WipedResponse {
        WipedResponse {
            id: id.into(),
            state: SandboxState::Wiped,
        }
    }
}

/// Every exported schema as `(file name, pretty JSON with a trailing newline)`, in a fixed
/// order. The binary writes these bytes and the test compares them.
pub fn schemas() -> Vec<(&'static str, String)> {
    fn render<T: JsonSchema>() -> String {
        let schema = schemars::schema_for!(T);
        let mut text = serde_json::to_string_pretty(&schema).expect("a schema serializes");
        text.push('\n');
        text
    }
    vec![
        ("HealthResponse.schema.json", render::<HealthResponse>()),
        ("StatusResponse.schema.json", render::<StatusResponse>()),
        ("Problem.schema.json", render::<Problem>()),
        ("SessionResponse.schema.json", render::<SessionResponse>()),
        ("SandboxResponse.schema.json", render::<SandboxResponse>()),
        (
            "DemoSignupRequest.schema.json",
            render::<DemoSignupRequest>(),
        ),
        (
            "DemoSignupResponse.schema.json",
            render::<DemoSignupResponse>(),
        ),
        (
            "DemoSigninRequest.schema.json",
            render::<DemoSigninRequest>(),
        ),
        (
            "CreateSandboxRequest.schema.json",
            render::<CreateSandboxRequest>(),
        ),
        ("FaultRequest.schema.json", render::<FaultRequest>()),
        ("FaultsResponse.schema.json", render::<FaultsResponse>()),
        ("WipedResponse.schema.json", render::<WipedResponse>()),
    ]
}

/// Where the committed schemas live.
pub fn schema_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("schemas")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn committed_schemas_are_current() {
        for (name, expected) in schemas() {
            let path = schema_dir().join(name);
            let committed = std::fs::read_to_string(&path).unwrap_or_default();
            assert!(
                committed == expected,
                "{} is stale: run `cargo run -p bakery-contracts --bin export-schemas`",
                path.display()
            );
        }
    }

    #[test]
    fn wire_shapes() {
        let health = HealthResponse {
            status: HealthStatus::Ok,
            commit: "dev".into(),
            version: "0.1.0".into(),
        };
        assert_eq!(
            serde_json::to_value(&health).unwrap(),
            json!({ "status": "ok", "commit": "dev", "version": "0.1.0" })
        );

        let status = StatusResponse {
            day: "2026-11-04".into(),
            sandboxes_today: 0,
            sandbox_cap: 300,
            guests_today: 0,
            guest_cap: 100,
            demo_accounts_today: 0,
            demo_account_cap: 100,
            flag: Flag::ReadOnly,
        };
        assert_eq!(
            serde_json::to_string(&status).unwrap(),
            r#"{"day":"2026-11-04","sandboxes_today":0,"sandbox_cap":300,"guests_today":0,"guest_cap":100,"demo_accounts_today":0,"demo_account_cap":100,"flag":"read-only"}"#
        );

        let problem = Problem::status(404, "Not Found").with_instance("/v1/nope");
        assert_eq!(
            serde_json::to_value(&problem).unwrap(),
            json!({ "type": "about:blank", "title": "Not Found", "status": 404, "instance": "/v1/nope" })
        );
    }

    #[test]
    fn typed_problems() {
        let problem = Problem::typed(
            "sandbox-cap",
            503,
            "Sandbox cap reached",
            "Try after 00:00 UTC.",
        )
        .with_instance("/v1/sandboxes");
        assert_eq!(
            serde_json::to_value(&problem).unwrap(),
            json!({
                "type": "https://bakery.ihaveasegway.com/problems/sandbox-cap",
                "title": "Sandbox cap reached",
                "status": 503,
                "detail": "Try after 00:00 UTC.",
                "instance": "/v1/sandboxes",
            })
        );
        assert_eq!(
            Problem::status(404, "Not Found").problem_type,
            "about:blank"
        );
    }

    #[test]
    fn session_shapes() {
        let session = SessionResponse {
            kind: SessionKind::Demo,
            account: Some("ab".repeat(32)),
            sandbox: None,
            expires_at: "2026-11-06T12:00:00.000Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&session).unwrap(),
            json!({ "kind": "demo", "account": "ab".repeat(32), "sandbox": null,
                    "expires_at": "2026-11-06T12:00:00.000Z" })
        );
        for (kind, text) in [
            (SessionKind::Guest, "guest"),
            (SessionKind::Google, "google"),
            (SessionKind::Github, "github"),
            (SessionKind::Demo, "demo"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(text));
        }
    }

    #[test]
    fn sandbox_shapes() {
        let sandbox = SandboxResponse {
            id: "01JC8Z6K3W9QF2N4T7XRB5M0HD".into(),
            kind: SandboxKind::Guest,
            state: SandboxState::Live,
            born: "2026-11-05T09:55:00.000Z".into(),
            wipe_at: "2026-11-05T10:00:00.000Z".into(),
            seed: 42,
            clock_offset_s: 0,
            clock_v: 0,
            token_v: 0,
            faults: Faults::default(),
            children: 0,
        };
        assert_eq!(
            serde_json::to_string(&sandbox).unwrap(),
            r#"{"id":"01JC8Z6K3W9QF2N4T7XRB5M0HD","kind":"guest","state":"live","born":"2026-11-05T09:55:00.000Z","wipe_at":"2026-11-05T10:00:00.000Z","seed":42,"clock_offset_s":0,"clock_v":0,"token_v":0,"faults":{"inbox":false},"children":0}"#
        );
        for (state, text) in [
            (SandboxState::Seeding, "seeding"),
            (SandboxState::Live, "live"),
            (SandboxState::Wiping, "wiping"),
            (SandboxState::Wiped, "wiped"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(text));
        }
        assert_eq!(
            serde_json::to_value(SandboxKind::Account).unwrap(),
            json!("account")
        );
        assert_eq!(
            serde_json::to_value(WipedResponse::new("01JC8Z6K3W9QF2N4T7XRB5M0HD")).unwrap(),
            json!({ "id": "01JC8Z6K3W9QF2N4T7XRB5M0HD", "state": "wiped" })
        );
        assert_eq!(
            serde_json::to_value(FaultsResponse {
                faults: Faults { inbox: true }
            })
            .unwrap(),
            json!({ "faults": { "inbox": true } })
        );
    }

    #[test]
    fn request_shapes() {
        let create: CreateSandboxRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(
            create,
            CreateSandboxRequest {
                turnstile_token: None,
                replace: false
            }
        );
        let create: CreateSandboxRequest =
            serde_json::from_str(r#"{"turnstile_token":"t","replace":true}"#).unwrap();
        assert_eq!(create.turnstile_token.as_deref(), Some("t"));
        assert!(create.replace);
        assert!(serde_json::from_str::<CreateSandboxRequest>(r#"{"sandbox":"x"}"#).is_err());

        let fault: FaultRequest = serde_json::from_str(r#"{"fault":"inbox","on":true}"#).unwrap();
        assert_eq!(
            fault,
            FaultRequest {
                fault: FaultName::Inbox,
                on: true
            }
        );
        assert!(serde_json::from_str::<FaultRequest>(r#"{"fault":"kitchen","on":true}"#).is_err());

        let signup: DemoSignupRequest = serde_json::from_str(
            r#"{"password":"canary-password-do-not-log","turnstile_token":"t"}"#,
        )
        .unwrap();
        assert_eq!(signup.password, "canary-password-do-not-log");
        assert!(!format!("{signup:?}").contains("canary"));
        assert!(
            serde_json::from_str::<DemoSignupRequest>(
                r#"{"password":"p","turnstile_token":"t","email":"x"}"#
            )
            .is_err()
        );

        let signin: DemoSigninRequest = serde_json::from_str(
            r#"{"username":"baker-7f3k","password":"canary-password-do-not-log"}"#,
        )
        .unwrap();
        assert_eq!(signin.username, "baker-7f3k");
        assert!(!format!("{signin:?}").contains("canary"));
        assert!(!format!("{signin:?}").contains("baker"));

        assert_eq!(
            serde_json::to_value(DemoSignupResponse {
                username: "baker-7f3k".into()
            })
            .unwrap(),
            json!({ "username": "baker-7f3k" })
        );
    }

    #[test]
    fn flags_round_trip_through_storage_text() {
        for flag in [Flag::Live, Flag::ReadOnly, Flag::Off] {
            assert_eq!(Flag::parse(flag.as_str()), Some(flag));
            assert_eq!(serde_json::to_value(flag).unwrap(), json!(flag.as_str()));
        }
        assert_eq!(Flag::parse("Live"), None);
    }
}
