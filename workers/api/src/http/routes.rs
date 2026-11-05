//! The route table: every route's method, path, scope and limit in one list, so the 405's
//! `Allow`, the Origin exemptions and the scopes cannot drift apart. Plain data, tested natively.

/// Who may call a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Anyone. A session, if present, is read but not required.
    Public,
    /// Any valid session, a guest's included.
    Session,
    /// A signed-in session: a guest gets 403 `guest-scope` with the rule named.
    SignedIn,
}

/// Which rate-limit binding a route spends, before any object is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    None,
    /// `SANDBOX_CREATE_LIMIT`, per IP hash.
    SandboxCreate,
    /// `COMMAND_LIMIT`, per session, or per IP hash without one.
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteId {
    Health,
    Status,
    GoogleStart,
    GoogleCallback,
    GithubStart,
    GithubCallback,
    DemoSignup,
    DemoSignin,
    Signout,
    Session,
    CreateSandbox,
    GetSandbox,
    WipeSandbox,
    SetFault,
}

#[derive(Debug)]
pub struct Route {
    pub id: RouteId,
    pub method: &'static str,
    /// Literal segments, and `{id}` for one non-empty segment.
    pub pattern: &'static str,
    pub scope: Scope,
    pub limit: Limit,
}

const fn route(
    id: RouteId,
    method: &'static str,
    pattern: &'static str,
    scope: Scope,
    limit: Limit,
) -> Route {
    Route {
        id,
        method,
        pattern,
        scope,
        limit,
    }
}

/// docs/security.md and the PR 3 route table. The OAuth callbacks are GETs, so the Origin
/// check never applies to them: it guards POST, PATCH and DELETE only, with no exemption.
pub const ROUTES: &[Route] = &[
    route(
        RouteId::Health,
        "GET",
        "/v1/health",
        Scope::Public,
        Limit::None,
    ),
    route(
        RouteId::Status,
        "GET",
        "/v1/status",
        Scope::Public,
        Limit::None,
    ),
    route(
        RouteId::GoogleStart,
        "GET",
        "/v1/auth/google/start",
        Scope::Public,
        Limit::None,
    ),
    route(
        RouteId::GoogleCallback,
        "GET",
        "/v1/auth/google/callback",
        Scope::Public,
        Limit::None,
    ),
    route(
        RouteId::GithubStart,
        "GET",
        "/v1/auth/github/start",
        Scope::Public,
        Limit::None,
    ),
    route(
        RouteId::GithubCallback,
        "GET",
        "/v1/auth/github/callback",
        Scope::Public,
        Limit::None,
    ),
    route(
        RouteId::DemoSignup,
        "POST",
        "/v1/auth/demo",
        Scope::Public,
        Limit::Command,
    ),
    route(
        RouteId::DemoSignin,
        "POST",
        "/v1/auth/demo/signin",
        Scope::Public,
        Limit::Command,
    ),
    route(
        RouteId::Signout,
        "POST",
        "/v1/auth/signout",
        Scope::Session,
        Limit::Command,
    ),
    route(
        RouteId::Session,
        "GET",
        "/v1/session",
        Scope::Session,
        Limit::None,
    ),
    route(
        RouteId::CreateSandbox,
        "POST",
        "/v1/sandboxes",
        Scope::Public,
        Limit::SandboxCreate,
    ),
    route(
        RouteId::GetSandbox,
        "GET",
        "/v1/sandboxes/{id}",
        Scope::Session,
        Limit::None,
    ),
    route(
        RouteId::WipeSandbox,
        "DELETE",
        "/v1/sandboxes/{id}",
        Scope::Session,
        Limit::Command,
    ),
    route(
        RouteId::SetFault,
        "POST",
        "/v1/sandboxes/{id}/faults",
        Scope::SignedIn,
        Limit::Command,
    ),
];

#[derive(Debug, PartialEq, Eq)]
pub enum Matched {
    /// The route, and the `{id}` segment if the pattern has one.
    Route(&'static Route, Option<String>),
    /// `OPTIONS` on a known path: the CORS preflight.
    Preflight,
    /// A known path, another method: 405 with this `Allow`.
    MethodNotAllowed(String),
    NotFound,
}

impl PartialEq for Route {
    fn eq(&self, other: &Route) -> bool {
        self.id == other.id
    }
}
impl Eq for Route {}

/// The `{id}` segment, or `Some(None)` for a literal match, or `None`.
fn matches(pattern: &str, path: &str) -> Option<Option<String>> {
    let mut id = None;
    let mut p = pattern.split('/');
    let mut s = path.split('/');
    loop {
        match (p.next(), s.next()) {
            (None, None) => return Some(id),
            (Some("{id}"), Some(seg)) if !seg.is_empty() => id = Some(seg.to_owned()),
            (Some(a), Some(b)) if a == b => {}
            _ => return None,
        }
    }
}

pub fn match_route(method: &str, path: &str) -> Matched {
    let on_path: Vec<(&'static Route, Option<String>)> = ROUTES
        .iter()
        .filter_map(|r| matches(r.pattern, path).map(|id| (r, id)))
        .collect();
    if on_path.is_empty() {
        return Matched::NotFound;
    }
    if method == "OPTIONS" {
        return Matched::Preflight;
    }
    match on_path.into_iter().find(|(r, _)| r.method == method) {
        Some((r, id)) => Matched::Route(r, id),
        None => Matched::MethodNotAllowed(allow(path)),
    }
}

/// The methods a path answers, in the table's order, then `OPTIONS`.
pub fn allow(path: &str) -> String {
    let mut methods: Vec<&str> = ROUTES
        .iter()
        .filter(|r| matches(r.pattern, path).is_some())
        .map(|r| r.method)
        .collect();
    methods.dedup();
    methods.push("OPTIONS");
    methods.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id_of(m: Matched) -> Option<(RouteId, Option<String>)> {
        match m {
            Matched::Route(r, id) => Some((r.id, id)),
            _ => None,
        }
    }

    #[test]
    fn literal_and_id_routes() {
        assert_eq!(
            id_of(match_route("GET", "/v1/health")),
            Some((RouteId::Health, None))
        );
        let ulid = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
        assert_eq!(
            id_of(match_route("GET", &format!("/v1/sandboxes/{ulid}"))),
            Some((RouteId::GetSandbox, Some(ulid.to_owned())))
        );
        assert_eq!(
            id_of(match_route("POST", &format!("/v1/sandboxes/{ulid}/faults"))),
            Some((RouteId::SetFault, Some(ulid.to_owned())))
        );
        assert_eq!(
            id_of(match_route("POST", "/v1/sandboxes")),
            Some((RouteId::CreateSandbox, None))
        );
    }

    #[test]
    fn unknown_paths_and_methods() {
        assert_eq!(match_route("GET", "/v1/nope"), Matched::NotFound);
        assert_eq!(match_route("GET", "/v1/sandboxes/"), Matched::NotFound);
        assert_eq!(match_route("GET", "/v1/health/"), Matched::NotFound);
        assert_eq!(match_route("OPTIONS", "/v1/nope"), Matched::NotFound);
        assert_eq!(match_route("OPTIONS", "/v1/status"), Matched::Preflight);
        assert_eq!(
            match_route("POST", "/v1/health"),
            Matched::MethodNotAllowed("GET, OPTIONS".into())
        );
        assert_eq!(
            match_route("PATCH", "/v1/sandboxes/01JC8Z6K3W9QF2N4T7XRB5M0HD"),
            Matched::MethodNotAllowed("GET, DELETE, OPTIONS".into())
        );
        assert_eq!(allow("/v1/auth/signout"), "POST, OPTIONS");
    }

    #[test]
    fn scopes_follow_the_spec() {
        let scope = |id| ROUTES.iter().find(|r| r.id == id).unwrap().scope;
        assert_eq!(scope(RouteId::SetFault), Scope::SignedIn);
        for id in [
            RouteId::Session,
            RouteId::GetSandbox,
            RouteId::WipeSandbox,
            RouteId::Signout,
        ] {
            assert_eq!(scope(id), Scope::Session, "{id:?}");
        }
        for id in [RouteId::GoogleCallback, RouteId::GithubCallback] {
            let r = ROUTES.iter().find(|r| r.id == id).unwrap();
            assert_eq!(
                r.method, "GET",
                "a callback stays outside the Origin check by being a GET"
            );
        }
        // Every command but the callbacks spends a limit.
        for r in ROUTES.iter().filter(|r| r.method != "GET") {
            assert_ne!(r.limit, Limit::None, "{:?}", r.id);
        }
    }
}
