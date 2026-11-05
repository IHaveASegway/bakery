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
    GetMenu,
    PatchMenuItem,
    PublishMenu,
    PlaceOrder,
    GetOrder,
    CancelOrder,
    ListDeadLetters,
    Redrive,
    AdvanceClock,
}

#[derive(Debug)]
pub struct Route {
    pub id: RouteId,
    pub method: &'static str,
    /// Literal segments, `{id}` for the sandbox's segment and `{sub}` for one more: an order's
    /// id, a menu item's slug or an event's id.
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
    // PR 4: the menu, orders, dead letters and the minimal clock.
    route(
        RouteId::GetMenu,
        "GET",
        "/v1/sandboxes/{id}/menu",
        Scope::Session,
        Limit::None,
    ),
    route(
        RouteId::PatchMenuItem,
        "PATCH",
        "/v1/sandboxes/{id}/menu/items/{sub}",
        Scope::SignedIn,
        Limit::Command,
    ),
    route(
        RouteId::PublishMenu,
        "POST",
        "/v1/sandboxes/{id}/menu/publish",
        Scope::SignedIn,
        Limit::Command,
    ),
    route(
        RouteId::PlaceOrder,
        "POST",
        "/v1/sandboxes/{id}/orders",
        Scope::Session,
        Limit::Command,
    ),
    route(
        RouteId::GetOrder,
        "GET",
        "/v1/sandboxes/{id}/orders/{sub}",
        Scope::Session,
        Limit::None,
    ),
    route(
        RouteId::CancelOrder,
        "POST",
        "/v1/sandboxes/{id}/orders/{sub}/cancel",
        Scope::Session,
        Limit::Command,
    ),
    route(
        RouteId::ListDeadLetters,
        "GET",
        "/v1/sandboxes/{id}/dead-letters",
        Scope::Session,
        Limit::None,
    ),
    route(
        RouteId::Redrive,
        "POST",
        "/v1/sandboxes/{id}/dead-letters/{sub}/redrive",
        Scope::SignedIn,
        Limit::Command,
    ),
    route(
        RouteId::AdvanceClock,
        "POST",
        "/v1/sandboxes/{id}/clock",
        Scope::SignedIn,
        Limit::Command,
    ),
];

/// A route's path parameters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Params {
    pub id: Option<String>,
    pub sub: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Matched {
    /// The route, and its `{id}` and `{sub}` segments if the pattern has them.
    Route(&'static Route, Params),
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

/// The parameters of a match, or `None`.
fn matches(pattern: &str, path: &str) -> Option<Params> {
    let mut params = Params::default();
    let mut p = pattern.split('/');
    let mut s = path.split('/');
    loop {
        match (p.next(), s.next()) {
            (None, None) => return Some(params),
            (Some("{id}"), Some(seg)) if !seg.is_empty() => params.id = Some(seg.to_owned()),
            (Some("{sub}"), Some(seg)) if !seg.is_empty() => params.sub = Some(seg.to_owned()),
            (Some(a), Some(b)) if a == b => {}
            _ => return None,
        }
    }
}

pub fn match_route(method: &str, path: &str) -> Matched {
    let on_path: Vec<(&'static Route, Params)> = ROUTES
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
            Matched::Route(r, p) => Some((r.id, p.id)),
            _ => None,
        }
    }

    fn sub_of(m: Matched) -> Option<(RouteId, Option<String>, Option<String>)> {
        match m {
            Matched::Route(r, p) => Some((r.id, p.id, p.sub)),
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
    fn two_parameter_routes() {
        let s = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
        let o = "01JC8Z5R0T2B6Y8C4V1N3K7QXE";
        let some = |v: &str| Some(v.to_owned());
        assert_eq!(
            sub_of(match_route("GET", &format!("/v1/sandboxes/{s}/orders/{o}"))),
            Some((RouteId::GetOrder, some(s), some(o)))
        );
        assert_eq!(
            sub_of(match_route(
                "POST",
                &format!("/v1/sandboxes/{s}/orders/{o}/cancel")
            )),
            Some((RouteId::CancelOrder, some(s), some(o)))
        );
        assert_eq!(
            sub_of(match_route(
                "PATCH",
                &format!("/v1/sandboxes/{s}/menu/items/fern-loaf")
            )),
            Some((RouteId::PatchMenuItem, some(s), some("fern-loaf")))
        );
        assert_eq!(
            sub_of(match_route(
                "POST",
                &format!("/v1/sandboxes/{s}/dead-letters/{o}/redrive")
            )),
            Some((RouteId::Redrive, some(s), some(o)))
        );
        assert_eq!(
            id_of(match_route("POST", &format!("/v1/sandboxes/{s}/orders"))),
            Some((RouteId::PlaceOrder, some(s)))
        );
        assert_eq!(
            match_route("GET", &format!("/v1/sandboxes/{s}/orders/")),
            Matched::NotFound
        );
        assert_eq!(
            match_route("GET", &format!("/v1/sandboxes/{s}/menu/publish")),
            Matched::MethodNotAllowed("POST, OPTIONS".into())
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
        for id in [
            RouteId::SetFault,
            RouteId::PatchMenuItem,
            RouteId::PublishMenu,
            RouteId::Redrive,
            RouteId::AdvanceClock,
        ] {
            assert_eq!(scope(id), Scope::SignedIn, "{id:?}: a console write");
        }
        for id in [
            RouteId::GetMenu,
            RouteId::PlaceOrder,
            RouteId::GetOrder,
            RouteId::CancelOrder,
            RouteId::ListDeadLetters,
        ] {
            assert_eq!(
                scope(id),
                Scope::Session,
                "{id:?}: guests browse, order and pay"
            );
        }
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
