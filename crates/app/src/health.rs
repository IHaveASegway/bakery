//! The health use case: what `GET /v1/health` answers. It touches no object and no port.

/// What the build knows about itself, filled in by the Worker from its vars and Cargo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildInfo {
    /// The commit the bundle was built from, `dev` on a laptop.
    pub commit: String,
    /// The API crate's version.
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Ok,
}

impl HealthStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            HealthStatus::Ok => "ok",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub status: HealthStatus,
    pub commit: String,
    pub version: String,
}

/// The Worker is up if it can answer; nothing deeper is checked, so health never costs a
/// Durable Object request.
pub fn health(build: &BuildInfo) -> Health {
    Health {
        status: HealthStatus::Ok,
        commit: build.commit.clone(),
        version: build.version.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_build() {
        let build = BuildInfo {
            commit: "dev".into(),
            version: "0.1.0".into(),
        };
        let h = health(&build);
        assert_eq!(h.status.as_str(), "ok");
        assert_eq!(h.commit, "dev");
        assert_eq!(h.version, "0.1.0");
    }
}
