//! The route table: every route's method, path, scope, limit and bearer rule in one list, so
//! the 405's `Allow`, the Origin exemptions and the scopes cannot drift apart. Plain data, tested
//! natively, and held to the contract table in crates/contracts in both directions.

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
    /// `UPGRADE_LIMIT`, per session: the kitchen socket's upgrades.
    Upgrade,
}

/// Whether the sandbox's API token in `Authorization: Bearer` may stand in for the cookie
/// (docs/security.md, "The API token"): on the sandbox's own routes, never on the account-level
/// ones, the socket, the webhook, or the two that mint a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bearer {
    Yes,
    No,
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
    KitchenSocket,
    Heartbeat,
    GetTraffic,
    StartTraffic,
    StopTraffic,
    Pay,
    Refund,
    Ledger,
    StripeWebhook,
    GetSchedule,
    SetCapacity,
    CreateCatering,
    ListCatering,
    GetCatering,
    AcceptQuote,
    CateringDeposit,
    PayBalance,
    CancelCatering,
    SendQuote,
    DeclineCatering,
    StartCateringProduction,
    MarkCateringDelivered,
    StaffCancelCatering,
    ListCustomers,
    GetCustomer,
    GetTimeline,
    SetConsent,
    ListSegments,
    GetSegment,
    ListCampaigns,
    CreateCampaign,
    GetCampaign,
    EditCampaign,
    ScheduleCampaign,
    CancelCampaign,
    ListInbox,
    GetMessage,
    GetLeads,
    GetActivity,
    StartRebuild,
    GetRebuild,
    GetDispatch,
    ProposeDispatch,
    SubmitPlan,
    PublishDispatch,
    CompleteStop,
    IssueToken,
    RotateToken,
    GetToken,
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
    pub bearer: Bearer,
}

const fn route(
    id: RouteId,
    method: &'static str,
    pattern: &'static str,
    scope: Scope,
    limit: Limit,
    bearer: Bearer,
) -> Route {
    Route {
        id,
        method,
        pattern,
        scope,
        limit,
        bearer,
    }
}

impl Route {
    /// Whether an API token may stand in for the cookie here.
    pub fn takes_bearer(&self) -> bool {
        self.bearer == Bearer::Yes
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
        Bearer::No,
    ),
    route(
        RouteId::Status,
        "GET",
        "/v1/status",
        Scope::Public,
        Limit::None,
        Bearer::No,
    ),
    route(
        RouteId::GoogleStart,
        "GET",
        "/v1/auth/google/start",
        Scope::Public,
        Limit::None,
        Bearer::No,
    ),
    route(
        RouteId::GoogleCallback,
        "GET",
        "/v1/auth/google/callback",
        Scope::Public,
        Limit::None,
        Bearer::No,
    ),
    route(
        RouteId::GithubStart,
        "GET",
        "/v1/auth/github/start",
        Scope::Public,
        Limit::None,
        Bearer::No,
    ),
    route(
        RouteId::GithubCallback,
        "GET",
        "/v1/auth/github/callback",
        Scope::Public,
        Limit::None,
        Bearer::No,
    ),
    route(
        RouteId::DemoSignup,
        "POST",
        "/v1/auth/demo",
        Scope::Public,
        Limit::Command,
        Bearer::No,
    ),
    route(
        RouteId::DemoSignin,
        "POST",
        "/v1/auth/demo/signin",
        Scope::Public,
        Limit::Command,
        Bearer::No,
    ),
    route(
        RouteId::Signout,
        "POST",
        "/v1/auth/signout",
        Scope::Session,
        Limit::Command,
        Bearer::No,
    ),
    route(
        RouteId::Session,
        "GET",
        "/v1/session",
        Scope::Session,
        Limit::None,
        Bearer::No,
    ),
    route(
        RouteId::CreateSandbox,
        "POST",
        "/v1/sandboxes",
        Scope::Public,
        Limit::SandboxCreate,
        Bearer::No,
    ),
    route(
        RouteId::GetSandbox,
        "GET",
        "/v1/sandboxes/{id}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::WipeSandbox,
        "DELETE",
        "/v1/sandboxes/{id}",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::SetFault,
        "POST",
        "/v1/sandboxes/{id}/faults",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    // PR 4: the menu, orders, dead letters and the minimal clock.
    route(
        RouteId::GetMenu,
        "GET",
        "/v1/sandboxes/{id}/menu",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::PatchMenuItem,
        "PATCH",
        "/v1/sandboxes/{id}/menu/items/{sub}",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::PublishMenu,
        "POST",
        "/v1/sandboxes/{id}/menu/publish",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::PlaceOrder,
        "POST",
        "/v1/sandboxes/{id}/orders",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::GetOrder,
        "GET",
        "/v1/sandboxes/{id}/orders/{sub}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::CancelOrder,
        "POST",
        "/v1/sandboxes/{id}/orders/{sub}/cancel",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::ListDeadLetters,
        "GET",
        "/v1/sandboxes/{id}/dead-letters",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::Redrive,
        "POST",
        "/v1/sandboxes/{id}/dead-letters/{sub}/redrive",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::AdvanceClock,
        "POST",
        "/v1/sandboxes/{id}/clock",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    // PR 4: the kitchen board's socket, the console's heartbeat and simulated traffic. The
    // upgrade is a GET that carries the cookie, so it takes the Origin check too (router).
    route(
        RouteId::KitchenSocket,
        "GET",
        "/v1/sandboxes/{id}/kitchen/ws",
        Scope::Session,
        Limit::Upgrade,
        Bearer::No,
    ),
    route(
        RouteId::Heartbeat,
        "POST",
        "/v1/sandboxes/{id}/heartbeat",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::GetTraffic,
        "GET",
        "/v1/sandboxes/{id}/traffic",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::StartTraffic,
        "POST",
        "/v1/sandboxes/{id}/traffic",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::StopTraffic,
        "DELETE",
        "/v1/sandboxes/{id}/traffic",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    // PR 5: payments and refunds through Stripe's sandbox. The webhook is Stripe's, not a
    // browser's: no CORS, no Origin, no session and no Idempotency-Key (router), its signature
    // the only gate, so it spends no limit either.
    route(
        RouteId::Pay,
        "POST",
        "/v1/sandboxes/{id}/orders/{sub}/payment",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::Refund,
        "POST",
        "/v1/sandboxes/{id}/orders/{sub}/refund",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::Ledger,
        "GET",
        "/v1/sandboxes/{id}/billing/ledger",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::StripeWebhook,
        "POST",
        "/v1/stripe/webhook",
        Scope::Public,
        Limit::None,
        Bearer::No,
    ),
    // PR 6: a bakery day's schedule, which any session reads (the checkout's slot picker), and
    // the staff's capacity editor.
    route(
        RouteId::GetSchedule,
        "GET",
        "/v1/sandboxes/{id}/schedule/{sub}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::SetCapacity,
        "PATCH",
        "/v1/sandboxes/{id}/schedule/{sub}/capacity",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    // PR 7: catering. The inquiry, the reads and the customer's steps are any session's (guests
    // browse, order and pay); the staff's steps are a signed-in session's.
    route(
        RouteId::CreateCatering,
        "POST",
        "/v1/sandboxes/{id}/catering",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::ListCatering,
        "GET",
        "/v1/sandboxes/{id}/catering",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::GetCatering,
        "GET",
        "/v1/sandboxes/{id}/catering/{sub}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::AcceptQuote,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/accept",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::CateringDeposit,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/deposit",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::PayBalance,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/pay-balance",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::CancelCatering,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/cancel",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::SendQuote,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/quote",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::DeclineCatering,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/decline",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::StartCateringProduction,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/start-production",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::MarkCateringDelivered,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/delivered",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::StaffCancelCatering,
        "POST",
        "/v1/sandboxes/{id}/catering/{sub}/staff-cancel",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    // PR 8: CRM, campaigns and the inbox. Every read is any session's (a guest reads
    // everything); a consent change is the session's, the route allowing a guest its own persona
    // only; the campaigns' writes and the rebuild are a signed-in session's.
    route(
        RouteId::ListCustomers,
        "GET",
        "/v1/sandboxes/{id}/customers",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::GetCustomer,
        "GET",
        "/v1/sandboxes/{id}/customers/{sub}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::GetTimeline,
        "GET",
        "/v1/sandboxes/{id}/customers/{sub}/timeline",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::SetConsent,
        "POST",
        "/v1/sandboxes/{id}/customers/{sub}/consent",
        Scope::Session,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::ListSegments,
        "GET",
        "/v1/sandboxes/{id}/segments",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::GetSegment,
        "GET",
        "/v1/sandboxes/{id}/segments/{sub}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::ListCampaigns,
        "GET",
        "/v1/sandboxes/{id}/campaigns",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::CreateCampaign,
        "POST",
        "/v1/sandboxes/{id}/campaigns",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::GetCampaign,
        "GET",
        "/v1/sandboxes/{id}/campaigns/{sub}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::EditCampaign,
        "PATCH",
        "/v1/sandboxes/{id}/campaigns/{sub}",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::ScheduleCampaign,
        "POST",
        "/v1/sandboxes/{id}/campaigns/{sub}/schedule",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::CancelCampaign,
        "POST",
        "/v1/sandboxes/{id}/campaigns/{sub}/cancel",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::ListInbox,
        "GET",
        "/v1/sandboxes/{id}/inbox",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::GetMessage,
        "GET",
        "/v1/sandboxes/{id}/inbox/{sub}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::GetLeads,
        "GET",
        "/v1/sandboxes/{id}/leads",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::GetActivity,
        "GET",
        "/v1/sandboxes/{id}/activity",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::StartRebuild,
        "POST",
        "/v1/sandboxes/{id}/rebuild",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::GetRebuild,
        "GET",
        "/v1/sandboxes/{id}/rebuild",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    // PR 10: the sandbox's API token (docs/security.md, "The API token"). Issuing and rotating
    // take the cookie, never a token, so a token never mints its successor; reading its
    // version and times takes either.
    route(
        RouteId::IssueToken,
        "POST",
        "/v1/sandboxes/{id}/token",
        Scope::SignedIn,
        Limit::Command,
        Bearer::No,
    ),
    route(
        RouteId::RotateToken,
        "POST",
        "/v1/sandboxes/{id}/token/rotate",
        Scope::SignedIn,
        Limit::Command,
        Bearer::No,
    ),
    route(
        RouteId::GetToken,
        "GET",
        "/v1/sandboxes/{id}/token",
        Scope::SignedIn,
        Limit::None,
        Bearer::Yes,
    ),
    // PR 9: a day's dispatch, which any session reads (the console's screen shows it to a guest
    // read-only), and the staff's four commands.
    route(
        RouteId::GetDispatch,
        "GET",
        "/v1/sandboxes/{id}/dispatch/{sub}",
        Scope::Session,
        Limit::None,
        Bearer::Yes,
    ),
    route(
        RouteId::ProposeDispatch,
        "POST",
        "/v1/sandboxes/{id}/dispatch/{sub}/propose",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::SubmitPlan,
        "POST",
        "/v1/sandboxes/{id}/dispatch/{sub}/plan",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::PublishDispatch,
        "POST",
        "/v1/sandboxes/{id}/dispatch/{sub}/publish",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
    route(
        RouteId::CompleteStop,
        "POST",
        "/v1/sandboxes/{id}/dispatch/{sub}/complete",
        Scope::SignedIn,
        Limit::Command,
        Bearer::Yes,
    ),
];

/// Routes a browser never calls: no CORS headers, no preflight, no Origin check, no session
/// and no `Idempotency-Key` (docs/security.md, "Payments safety").
pub const SERVER_TO_SERVER: &[RouteId] = &[RouteId::StripeWebhook];

pub fn is_server_to_server(id: RouteId) -> bool {
    SERVER_TO_SERVER.contains(&id)
}

/// Whether every route on `path` is server to server, whatever the method asked: such a path
/// gets no CORS headers even on its 405.
pub fn is_server_to_server_path(path: &str) -> bool {
    let mut on_path = ROUTES
        .iter()
        .filter(|r| matches(r.pattern, path).is_some())
        .peekable();
    on_path.peek().is_some() && on_path.all(|r| is_server_to_server(r.id))
}

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
        if on_path.iter().all(|(r, _)| is_server_to_server(r.id)) {
            return Matched::MethodNotAllowed(allow(path));
        }
        return Matched::Preflight;
    }
    match on_path.into_iter().find(|(r, _)| r.method == method) {
        Some((r, id)) => Matched::Route(r, id),
        None => Matched::MethodNotAllowed(allow(path)),
    }
}

/// The methods a path answers, in the table's order, then `OPTIONS`.
pub fn allow(path: &str) -> String {
    let on_path: Vec<&Route> = ROUTES
        .iter()
        .filter(|r| matches(r.pattern, path).is_some())
        .collect();
    let mut methods: Vec<&str> = on_path.iter().map(|r| r.method).collect();
    methods.dedup();
    if !on_path.iter().all(|r| is_server_to_server(r.id)) {
        methods.push("OPTIONS");
    }
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
        assert_eq!(
            allow("/v1/sandboxes/01JC8Z6K3W9QF2N4T7XRB5M0HD/traffic"),
            "GET, POST, DELETE, OPTIONS"
        );
        assert_eq!(
            match_route(
                "POST",
                "/v1/sandboxes/01JC8Z6K3W9QF2N4T7XRB5M0HD/kitchen/ws"
            ),
            Matched::MethodNotAllowed("GET, OPTIONS".into())
        );
    }

    #[test]
    fn payment_routes_and_the_webhook() {
        let s = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
        let o = "01JC8Z5R0T2B6Y8C4V1N3K7QXE";
        let some = |v: &str| Some(v.to_owned());
        assert_eq!(
            sub_of(match_route(
                "POST",
                &format!("/v1/sandboxes/{s}/orders/{o}/payment")
            )),
            Some((RouteId::Pay, some(s), some(o)))
        );
        assert_eq!(
            sub_of(match_route(
                "POST",
                &format!("/v1/sandboxes/{s}/orders/{o}/refund")
            )),
            Some((RouteId::Refund, some(s), some(o)))
        );
        assert_eq!(
            id_of(match_route(
                "GET",
                &format!("/v1/sandboxes/{s}/billing/ledger")
            )),
            Some((RouteId::Ledger, some(s)))
        );
        assert_eq!(
            id_of(match_route("POST", "/v1/stripe/webhook")),
            Some((RouteId::StripeWebhook, None))
        );
        assert!(is_server_to_server_path("/v1/stripe/webhook"));
        assert!(!is_server_to_server_path("/v1/health"));
        assert!(!is_server_to_server_path("/v1/nope"));
        // No preflight for Stripe's route, and no OPTIONS in its Allow.
        assert_eq!(
            match_route("OPTIONS", "/v1/stripe/webhook"),
            Matched::MethodNotAllowed("POST".into())
        );
        assert_eq!(
            match_route("GET", "/v1/stripe/webhook"),
            Matched::MethodNotAllowed("POST".into())
        );
        assert_eq!(
            match_route("OPTIONS", &format!("/v1/sandboxes/{s}/orders/{o}/payment")),
            Matched::Preflight
        );
    }

    #[test]
    fn schedule_routes() {
        let s = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
        let some = |v: &str| Some(v.to_owned());
        assert_eq!(
            sub_of(match_route(
                "GET",
                &format!("/v1/sandboxes/{s}/schedule/2026-11-07")
            )),
            Some((RouteId::GetSchedule, some(s), some("2026-11-07")))
        );
        assert_eq!(
            sub_of(match_route(
                "PATCH",
                &format!("/v1/sandboxes/{s}/schedule/2026-11-07/capacity")
            )),
            Some((RouteId::SetCapacity, some(s), some("2026-11-07")))
        );
        assert_eq!(
            match_route("POST", &format!("/v1/sandboxes/{s}/schedule/2026-11-07")),
            Matched::MethodNotAllowed("GET, OPTIONS".into())
        );
        let scope = |id| ROUTES.iter().find(|r| r.id == id).unwrap().scope;
        assert_eq!(
            scope(RouteId::GetSchedule),
            Scope::Session,
            "guests read it"
        );
        assert_eq!(
            scope(RouteId::SetCapacity),
            Scope::SignedIn,
            "a console write"
        );
    }

    #[test]
    fn catering_routes() {
        let s = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
        let c = "01JC8Z5R0T2B6Y8C4V1N3K7QXE";
        let some = |v: &str| Some(v.to_owned());
        assert_eq!(
            id_of(match_route("POST", &format!("/v1/sandboxes/{s}/catering"))),
            Some((RouteId::CreateCatering, some(s)))
        );
        assert_eq!(
            id_of(match_route("GET", &format!("/v1/sandboxes/{s}/catering"))),
            Some((RouteId::ListCatering, some(s)))
        );
        assert_eq!(
            sub_of(match_route(
                "GET",
                &format!("/v1/sandboxes/{s}/catering/{c}")
            )),
            Some((RouteId::GetCatering, some(s), some(c)))
        );
        let scope = |id| ROUTES.iter().find(|r| r.id == id).unwrap().scope;
        for (step, id, want) in [
            ("accept", RouteId::AcceptQuote, Scope::Session),
            ("deposit", RouteId::CateringDeposit, Scope::Session),
            ("pay-balance", RouteId::PayBalance, Scope::Session),
            ("cancel", RouteId::CancelCatering, Scope::Session),
            ("quote", RouteId::SendQuote, Scope::SignedIn),
            ("decline", RouteId::DeclineCatering, Scope::SignedIn),
            (
                "start-production",
                RouteId::StartCateringProduction,
                Scope::SignedIn,
            ),
            ("delivered", RouteId::MarkCateringDelivered, Scope::SignedIn),
            (
                "staff-cancel",
                RouteId::StaffCancelCatering,
                Scope::SignedIn,
            ),
        ] {
            assert_eq!(
                sub_of(match_route(
                    "POST",
                    &format!("/v1/sandboxes/{s}/catering/{c}/{step}")
                )),
                Some((id, some(s), some(c))),
                "{step}"
            );
            assert_eq!(scope(id), want, "{step}");
        }
        assert_eq!(
            allow(&format!("/v1/sandboxes/{s}/catering")),
            "POST, GET, OPTIONS"
        );
        assert_eq!(
            match_route("GET", &format!("/v1/sandboxes/{s}/catering/{c}/accept")),
            Matched::MethodNotAllowed("POST, OPTIONS".into())
        );
    }

    #[test]
    fn crm_routes() {
        let s = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
        let c = "01JC8Z5R0T2B6Y8C4V1N3K7QXE";
        let some = |v: &str| Some(v.to_owned());
        let scope = |id| ROUTES.iter().find(|r| r.id == id).unwrap().scope;
        for (method, path, id, sub, want) in [
            (
                "GET",
                "customers".to_owned(),
                RouteId::ListCustomers,
                None,
                Scope::Session,
            ),
            (
                "GET",
                format!("customers/{c}"),
                RouteId::GetCustomer,
                some(c),
                Scope::Session,
            ),
            (
                "GET",
                format!("customers/{c}/timeline"),
                RouteId::GetTimeline,
                some(c),
                Scope::Session,
            ),
            (
                "POST",
                format!("customers/{c}/consent"),
                RouteId::SetConsent,
                some(c),
                Scope::Session,
            ),
            (
                "GET",
                "segments".to_owned(),
                RouteId::ListSegments,
                None,
                Scope::Session,
            ),
            (
                "GET",
                "segments/cake-last-30-days".to_owned(),
                RouteId::GetSegment,
                some("cake-last-30-days"),
                Scope::Session,
            ),
            (
                "GET",
                "campaigns".to_owned(),
                RouteId::ListCampaigns,
                None,
                Scope::Session,
            ),
            (
                "POST",
                "campaigns".to_owned(),
                RouteId::CreateCampaign,
                None,
                Scope::SignedIn,
            ),
            (
                "GET",
                format!("campaigns/{c}"),
                RouteId::GetCampaign,
                some(c),
                Scope::Session,
            ),
            (
                "PATCH",
                format!("campaigns/{c}"),
                RouteId::EditCampaign,
                some(c),
                Scope::SignedIn,
            ),
            (
                "POST",
                format!("campaigns/{c}/schedule"),
                RouteId::ScheduleCampaign,
                some(c),
                Scope::SignedIn,
            ),
            (
                "POST",
                format!("campaigns/{c}/cancel"),
                RouteId::CancelCampaign,
                some(c),
                Scope::SignedIn,
            ),
            (
                "GET",
                "inbox".to_owned(),
                RouteId::ListInbox,
                None,
                Scope::Session,
            ),
            (
                "GET",
                format!("inbox/{c}"),
                RouteId::GetMessage,
                some(c),
                Scope::Session,
            ),
            (
                "GET",
                "leads".to_owned(),
                RouteId::GetLeads,
                None,
                Scope::Session,
            ),
            (
                "GET",
                "activity".to_owned(),
                RouteId::GetActivity,
                None,
                Scope::Session,
            ),
            (
                "POST",
                "rebuild".to_owned(),
                RouteId::StartRebuild,
                None,
                Scope::SignedIn,
            ),
            (
                "GET",
                "rebuild".to_owned(),
                RouteId::GetRebuild,
                None,
                Scope::Session,
            ),
        ] {
            assert_eq!(
                sub_of(match_route(method, &format!("/v1/sandboxes/{s}/{path}"))),
                Some((id, some(s), sub)),
                "{method} {path}"
            );
            assert_eq!(scope(id), want, "{method} {path}");
        }
        assert_eq!(
            allow(&format!("/v1/sandboxes/{s}/campaigns/{c}")),
            "GET, PATCH, OPTIONS"
        );
        assert_eq!(
            allow(&format!("/v1/sandboxes/{s}/rebuild")),
            "POST, GET, OPTIONS"
        );
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
            RouteId::StartTraffic,
            RouteId::StopTraffic,
        ] {
            assert_eq!(scope(id), Scope::SignedIn, "{id:?}: a console write");
        }
        for id in [
            RouteId::GetMenu,
            RouteId::PlaceOrder,
            RouteId::GetOrder,
            RouteId::CancelOrder,
            RouteId::ListDeadLetters,
            RouteId::KitchenSocket,
            RouteId::Heartbeat,
            RouteId::GetTraffic,
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
        // Every command a browser sends spends a limit, and so does the upgrade. Stripe's
        // webhook is gated by its signature instead.
        for r in ROUTES
            .iter()
            .filter(|r| r.method != "GET" && !is_server_to_server(r.id))
        {
            assert_ne!(r.limit, Limit::None, "{:?}", r.id);
        }
        assert_eq!(
            scope(RouteId::Refund),
            Scope::SignedIn,
            "a refund is staff's"
        );
        assert_eq!(scope(RouteId::Pay), Scope::Session, "guests pay");
        assert_eq!(scope(RouteId::Ledger), Scope::Session);
        assert_eq!(scope(RouteId::StripeWebhook), Scope::Public);
        let socket = ROUTES
            .iter()
            .find(|r| r.id == RouteId::KitchenSocket)
            .unwrap();
        assert_eq!(socket.limit, Limit::Upgrade);
    }

    // ---------- the route table in crates/contracts, both ways ----------

    use bakery_contracts::routes::{ROUTES as CONTRACT, RouteSpec, Session};

    const README: &str = include_str!("../../README.md");

    /// The pull request the README's routes table covers, from its lead line
    /// "Through PR <n> it answers:". Rows of later pull requests may be in the contract table
    /// before this Worker serves them; rows up to this one must be served.
    fn readme_pr() -> u8 {
        README
            .lines()
            .find_map(|l| {
                l.strip_prefix("Through PR ")
                    .and_then(|rest| rest.strip_suffix(" it answers:"))
            })
            .and_then(|n| n.trim().parse().ok())
            .expect("the README says which pull request its routes table covers")
    }

    /// `PlaceOrder` to `place-order`, the contract table's id.
    fn kebab(id: RouteId) -> String {
        let mut out = String::new();
        for (i, c) in format!("{id:?}").chars().enumerate() {
            if c.is_ascii_uppercase() {
                if i > 0 {
                    out.push('-');
                }
                out.push(c.to_ascii_lowercase());
            } else {
                out.push(c);
            }
        }
        out
    }

    /// A path with every `{segment}` written `{}`: the Worker's `{sub}` is the table's `{oid}`.
    fn shape(path: &str) -> String {
        path.split('/')
            .map(|s| if s.starts_with('{') { "{}" } else { s })
            .collect::<Vec<_>>()
            .join("/")
    }

    /// The contract's session rules a Worker scope routes by.
    fn scope_allows(scope: Scope, session: Session) -> bool {
        match scope {
            Scope::Public => matches!(session, Session::Public | Session::Stripe),
            Scope::Session => matches!(session, Session::Any | Session::Sandbox | Session::Cookie),
            Scope::SignedIn => session == Session::SignedIn,
        }
    }

    fn agrees(route: &Route, spec: &RouteSpec) {
        let id = spec.id;
        assert_eq!(route.method, spec.method, "{id}: method");
        assert_eq!(shape(route.pattern), shape(spec.path), "{id}: pattern");
        assert!(
            scope_allows(route.scope, spec.session),
            "{id}: the Worker's {:?} against the table's {:?}",
            route.scope,
            spec.session
        );
        assert_eq!(route.takes_bearer(), spec.bearer, "{id}: bearer");
    }

    #[test]
    fn every_route_served_is_in_the_contract_table() {
        for route in ROUTES {
            let id = kebab(route.id);
            let spec = CONTRACT
                .iter()
                .find(|s| s.id == id)
                .unwrap_or_else(|| panic!("the Worker serves {id}, which crates/contracts lacks"));
            agrees(route, spec);
        }
    }

    #[test]
    fn every_contract_route_through_the_readme_pr_is_served() {
        let covered = readme_pr();
        let mut served = 0;
        for spec in CONTRACT.iter().filter(|s| s.pr <= covered) {
            let route = ROUTES
                .iter()
                .find(|r| kebab(r.id) == spec.id)
                .unwrap_or_else(|| {
                    panic!(
                        "{} is PR {}, the README covers PR {covered}, and the Worker does not serve it",
                        spec.id, spec.pr
                    )
                });
            agrees(route, spec);
            served += 1;
        }
        assert!(served >= 64, "{served} routes through PR {covered}");
    }

    #[test]
    fn token_routes_and_the_bearer_rule() {
        let s = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
        let some = |v: &str| Some(v.to_owned());
        assert_eq!(
            id_of(match_route("POST", &format!("/v1/sandboxes/{s}/token"))),
            Some((RouteId::IssueToken, some(s)))
        );
        assert_eq!(
            id_of(match_route(
                "POST",
                &format!("/v1/sandboxes/{s}/token/rotate")
            )),
            Some((RouteId::RotateToken, some(s)))
        );
        assert_eq!(
            id_of(match_route("GET", &format!("/v1/sandboxes/{s}/token"))),
            Some((RouteId::GetToken, some(s)))
        );
        assert_eq!(
            allow(&format!("/v1/sandboxes/{s}/token")),
            "POST, GET, OPTIONS"
        );
        for r in ROUTES {
            let sandbox_route = r.pattern.starts_with("/v1/sandboxes/{id}");
            let minted_or_socket = matches!(
                r.id,
                RouteId::IssueToken | RouteId::RotateToken | RouteId::KitchenSocket
            );
            assert_eq!(
                r.takes_bearer(),
                sandbox_route && !minted_or_socket,
                "{:?}: a token acts in its own sandbox, never on the socket or to mint its successor",
                r.id
            );
            if minted_or_socket || r.id == RouteId::GetToken {
                assert_eq!(
                    r.scope,
                    if r.id == RouteId::KitchenSocket {
                        Scope::Session
                    } else {
                        Scope::SignedIn
                    },
                    "{:?}",
                    r.id
                );
            }
        }
    }
}
