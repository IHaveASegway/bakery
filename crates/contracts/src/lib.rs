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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StatusResponse {
    /// Today's UTC date, `YYYY-MM-DD`: the key of the daily ledger.
    pub day: String,
    /// Sandboxes admitted today.
    pub sandboxes_today: u32,
    /// The most sandboxes admitted in one UTC day.
    pub sandbox_cap: u32,
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

impl Problem {
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
            flag: Flag::ReadOnly,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "day": "2026-11-04", "sandboxes_today": 0, "sandbox_cap": 300, "flag": "read-only" })
        );

        let problem = Problem::status(404, "Not Found").with_instance("/v1/nope");
        assert_eq!(
            serde_json::to_value(&problem).unwrap(),
            json!({ "type": "about:blank", "title": "Not Found", "status": 404, "instance": "/v1/nope" })
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
