//! The OpenAPI 3.1 document, built from the route table ([`crate::routes`]) and the schemas
//! (`crate::schemas`), never written by hand. The `openapi` binary writes it to
//! `apps/web/public/docs/api/openapi.json`, which the storefront serves at `/docs/api/`; a test
//! and CI's `--check` fail when the committed copy is stale (docs/architecture.md, "The API
//! token": every console action has an API equivalent).
//!
//! It is a `serde_json::Value`, so every object's keys come out sorted and a parse and a
//! re-render give the same bytes. The schemas' `$defs` become components, with each `$ref`
//! pointed at `#/components/schemas/<Name>`; every error is the `Problem` contract, its status's
//! problem slugs named in the response's description and listed in `x-problems` (each type is
//! `https://bakery.ihaveasegway.com/problems/<slug>`, as `info.description` says).

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::routes::{self, Answer, RouteSpec, Session};

/// The OpenAPI version the document is written to.
pub const OPENAPI: &str = "3.1.0";

/// The API's origins: the launch hostname, then `wrangler dev`'s.
pub const SERVERS: &[(&str, &str)] = &[
    (
        "https://api.bakery.ihaveasegway.com",
        "The API, from the launch (PR 11) on",
    ),
    (
        "http://127.0.0.1:8788",
        "The API on `wrangler dev`, as workers/api/README.md runs it",
    ),
];

/// The kitchen socket's frames, protocol v1, as workers/api/README.md's "The kitchen socket"
/// table writes them: `(direction, t, shape, when)`.
pub const SOCKET_FRAMES: &[(&str, &str, &str, &str)] = &[
    (
        "server-to-client",
        "snapshot",
        "{t: \"snapshot\", v: 1, board: {cards, bake_lists}, seq}",
        "on open; `seq` counts the events that changed the board; `bake_lists` is one entry per bakery day from business today on, `[{date, version, lines: [{item, qty, start, catering?}], reserved}]`, `catering: true` on a catering event's line, whose `qty` is its headcount",
    ),
    (
        "server-to-client",
        "evt",
        "{t: \"evt\", v: 1, env, bake_list?}",
        "each event that changed the board, the envelope whole, the note with it; and the Sandbox's `ClockAdvanced`. A `BakeListChanged`, `SlotReserved` or `SlotReleased` frame also carries `bake_list`, that day as the board holds it after the event, `{date, version, lines: [{item, qty, start, catering?}], reserved}` (since 2026-11-06; `catering` since 2026-11-08): set the day from it, do not adjust a count",
    ),
    (
        "server-to-client",
        "presence",
        "{t: \"presence\", v: 1, sockets}",
        "a socket opened or closed",
    ),
    (
        "server-to-client",
        "bye",
        "{t: \"bye\", v: 1, reason: \"wiped\" | \"limit\"}",
        "before the server closes: 1001 at the wipe; 1008, 1009 or 1003 at a limit",
    ),
    (
        "client-to-server",
        "cmd",
        "{t: \"cmd\", v: 1, id: <ULID>, order: <ULID>, action: \"start_production\" | \"mark_ready\" | \"mark_picked_up\"}",
        "a staff action, sent to the Order with `id` as the idempotency key",
    ),
    (
        "server-to-client",
        "ack",
        "{t: \"ack\", v: 1, id}",
        "the command was applied; a repeated `id` gets the first answer",
    ),
    (
        "server-to-client",
        "nack",
        "{t: \"nack\", v: 1, id, rule}",
        "the command was refused, naming the rule; a guest gets `guest-scope`",
    ),
    (
        "client-to-server",
        "ping",
        "{t: \"ping\", v: 1}",
        "answered `{t: \"pong\", v: 1}` by the platform's auto-response, which does not wake the object",
    ),
    (
        "server-to-client",
        "pong",
        "{t: \"pong\", v: 1}",
        "the answer to a `ping`",
    ),
];

/// Where the committed document lives, from the repository root.
pub const DOCUMENT_PATH: &str = "apps/web/public/docs/api/openapi.json";

/// The committed document's path on this machine.
pub fn document_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(DOCUMENT_PATH)
}

/// The document as pretty JSON with a trailing newline: the bytes the binary writes.
pub fn render() -> String {
    let mut text = serde_json::to_string_pretty(&document()).expect("the document serializes");
    text.push('\n');
    text
}

/// The whole document.
pub fn document() -> Value {
    let mut paths: BTreeMap<&str, Map<String, Value>> = BTreeMap::new();
    for route in routes::ROUTES {
        let item = paths.entry(route.path).or_default();
        let method = route.method.to_ascii_lowercase();
        assert!(
            item.insert(method, operation(route)).is_none(),
            "{} {} twice",
            route.method,
            route.path
        );
    }
    let mut tags: Vec<&str> = Vec::new();
    for route in routes::ROUTES {
        let t = tag(route.path);
        if !tags.contains(&t) {
            tags.push(t);
        }
    }
    json!({
        "openapi": OPENAPI,
        "info": {
            "title": "Proof of Concept Bakery API",
            "version": "1",
            "summary": "The API the bakery's console calls, and a visitor's own client can too.",
            "description": "Every console action has a call here. Every bakery is a private sandbox of synthetic data, wiped at the next 10:00 UTC. From a browser, the `__Host-session` cookie carries the session; from anywhere else, the sandbox's API token goes in `Authorization: Bearer` (signed-in sandboxes only; issue it in the console or with `POST /v1/sandboxes/{id}/token`). A request with a token and no cookie needs no `Origin`. Every `POST` carries an `Idempotency-Key`, a ULID; the same key again gets the first answer with `Idempotent-Replayed: true`. Every error is `application/problem+json` (RFC 9457), its `type` `https://bakery.ihaveasegway.com/problems/<slug>`. Money is integer US cents; business times carry the bakery's Mountain offset, wall times are UTC with `Z`. Generated from crates/contracts: the route table and the schemas.",
            "license": { "name": "MIT", "identifier": "MIT" }
        },
        "servers": SERVERS.iter().map(|(url, description)| json!({
            "url": url,
            "description": description,
        })).collect::<Vec<_>>(),
        "tags": tags.iter().map(|t| json!({ "name": t })).collect::<Vec<_>>(),
        "paths": paths,
        "components": {
            "schemas": schema_components(),
            "parameters": {
                "IdempotencyKey": {
                    "name": "Idempotency-Key",
                    "in": "header",
                    "required": true,
                    "description": "A ULID, new for each intent and the same for its retries. The command's result is stored with it: the same key again answers the first result with `Idempotent-Replayed: true`, and the same key with a different body is 422 `idempotency-key`.",
                    "schema": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
                    "example": "01JC8Z6K3W9QF2N4T7XRB5M0HD"
                },
                "IdempotencyKeyOptional": {
                    "name": "Idempotency-Key",
                    "in": "header",
                    "required": false,
                    "description": "Optional on a `PATCH`, which is idempotent by its body; a malformed one is still refused with 400 `idempotency-key`.",
                    "schema": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" }
                }
            },
            "headers": {
                "IdempotentReplayed": {
                    "description": "`true` when this is the stored answer to a key already seen.",
                    "schema": { "type": "string", "enum": ["true"] }
                },
                "Location": {
                    "description": "Where the created resource, or the redirect's target, is.",
                    "schema": { "type": "string" }
                },
                "RetryAfter": {
                    "description": "Seconds to wait before asking again.",
                    "schema": { "type": "integer", "minimum": 0 }
                }
            },
            "securitySchemes": {
                "sessionCookie": {
                    "type": "apiKey",
                    "in": "cookie",
                    "name": "__Host-session",
                    "description": "The session cookie: HttpOnly, Secure, SameSite=Strict, host-only on the API, 24 h. A request carrying it must send the storefront's exact `Origin` on every POST, PATCH and DELETE and on the socket's upgrade."
                },
                "bearerToken": {
                    "type": "http",
                    "scheme": "bearer",
                    "bearerFormat": "bakery API token",
                    "description": "The sandbox's API token, signed like the session cookie, 24 h, dying with the sandbox and with every rotation. In `Authorization: Bearer` only: a token in a query string, or a token and a cookie together, is 400 `token`. Rate-limited per token."
                },
                "stripeSignature": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "Stripe-Signature",
                    "description": "Stripe's signature over the raw body, with the endpoint secret. Only Stripe calls the webhook."
                }
            }
        }
    })
}

/// A route's operation object.
fn operation(route: &RouteSpec) -> Value {
    let mut op = Map::new();
    op.insert("operationId".into(), json!(route.id));
    op.insert("summary".into(), json!(route.summary));
    op.insert("description".into(), json!(describe(route)));
    op.insert("tags".into(), json!([tag(route.path)]));
    op.insert("x-session".into(), json!(route.session.as_str()));
    op.insert("x-pr".into(), json!(route.pr));

    let mut parameters: Vec<Value> = routes::path_params(route.path)
        .into_iter()
        .map(|name| {
            json!({
                "name": name,
                "in": "path",
                "required": true,
                "description": param_description(name),
                "schema": { "type": "string" }
            })
        })
        .collect();
    for q in route.query {
        parameters.push(json!({
            "name": q.name,
            "in": "query",
            "required": false,
            "description": q.note,
            "schema": { "type": q.ty }
        }));
    }
    if route.idempotent {
        parameters.push(json!({ "$ref": "#/components/parameters/IdempotencyKey" }));
    } else if route.method == "PATCH" {
        parameters.push(json!({ "$ref": "#/components/parameters/IdempotencyKeyOptional" }));
    }
    if !parameters.is_empty() {
        op.insert("parameters".into(), Value::Array(parameters));
    }

    if let Some(request) = route.request {
        op.insert(
            "requestBody".into(),
            json!({
                "required": true,
                "content": { "application/json": { "schema": schema_ref(request) } }
            }),
        );
    }

    let mut by_status: BTreeMap<u16, Vec<Answer>> = BTreeMap::new();
    for answer in routes::answers(route) {
        by_status.entry(answer.status).or_default().push(answer);
    }
    let responses: Map<String, Value> = by_status
        .into_iter()
        .map(|(status, answers)| (status.to_string(), response(route, status, &answers)))
        .collect();
    op.insert("responses".into(), Value::Object(responses));
    op.insert("security".into(), security(route));

    if route.session == Session::Cookie {
        op.insert("x-websocket".into(), websocket());
    }
    Value::Object(op)
}

/// One status's response object.
fn response(route: &RouteSpec, status: u16, answers: &[Answer]) -> Value {
    let description = answers
        .iter()
        .map(|a| match a.problem {
            Some(slug) => format!("`{slug}`: {}", a.note),
            None => a.note.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("; ");
    let mut out = Map::new();
    out.insert("description".into(), json!(description));
    let mut headers = Map::new();
    if status >= 400 {
        out.insert(
            "content".into(),
            json!({ "application/problem+json": { "schema": schema_ref("Problem") } }),
        );
        let problems: Vec<Value> =
            answers
                .iter()
                .filter_map(|a| a.problem)
                .fold(Vec::new(), |mut slugs, slug| {
                    if !slugs.contains(&json!(slug)) {
                        slugs.push(json!(slug));
                    }
                    slugs
                });
        if !problems.is_empty() {
            out.insert("x-problems".into(), Value::Array(problems));
        }
    } else if (200..300).contains(&status)
        && status != 204
        && let Some(name) = route.response
    {
        out.insert(
            "content".into(),
            json!({ "application/json": { "schema": schema_ref(name) } }),
        );
    }
    if (200..300).contains(&status) && route.idempotent {
        headers.insert(
            "Idempotent-Replayed".into(),
            json!({ "$ref": "#/components/headers/IdempotentReplayed" }),
        );
    }
    if matches!(status, 201 | 302 | 303) {
        headers.insert(
            "Location".into(),
            json!({ "$ref": "#/components/headers/Location" }),
        );
    }
    if answers.iter().any(|a| a.note.contains("Retry-After")) {
        headers.insert(
            "Retry-After".into(),
            json!({ "$ref": "#/components/headers/RetryAfter" }),
        );
    }
    if !headers.is_empty() {
        out.insert("headers".into(), Value::Object(headers));
    }
    Value::Object(out)
}

/// `$ref` to a component, or an array of them for `Name[]`.
fn schema_ref(name: &str) -> Value {
    let (name, array) = routes::type_name(name);
    let one = json!({ "$ref": format!("#/components/schemas/{name}") });
    if array {
        json!({ "type": "array", "items": one })
    } else {
        one
    }
}

fn security(route: &RouteSpec) -> Value {
    let cookie = json!({ "sessionCookie": [] });
    match route.session {
        Session::Public if route.method == "POST" => json!([{}, cookie]),
        Session::Public => json!([]),
        Session::Stripe => json!([{ "stripeSignature": [] }]),
        Session::Any | Session::Cookie => json!([cookie]),
        Session::Sandbox | Session::SignedIn if route.bearer => {
            json!([cookie, { "bearerToken": [] }])
        }
        Session::Sandbox | Session::SignedIn => json!([cookie]),
    }
}

fn describe(route: &RouteSpec) -> String {
    let who = match route.session {
        Session::Public if route.method == "POST" => {
            "Anyone; a session, if present, is read but not required."
        }
        Session::Public => "Anyone.",
        Session::Any => "Any session, a guest's included.",
        Session::Sandbox => "A session of sandbox `{id}`, a guest's included.",
        Session::SignedIn => {
            "A signed-in session of sandbox `{id}`; a guest gets 403 `guest-scope`."
        }
        Session::Cookie => {
            "A session of sandbox `{id}`, by the cookie only, with the storefront's exact `Origin`."
        }
        Session::Stripe => "Stripe only: its signature is the check.",
    };
    let token = match (route.session, route.bearer) {
        (Session::Sandbox | Session::SignedIn, true) => {
            " The sandbox's API token may stand in for the cookie."
        }
        (Session::Sandbox | Session::SignedIn, false) => {
            " The cookie only: an API token never mints its successor."
        }
        _ => "",
    };
    let key = if route.idempotent {
        " Carries an `Idempotency-Key`."
    } else {
        ""
    };
    format!("{who}{token}{key}")
}

fn param_description(name: &str) -> &'static str {
    match name {
        "id" => "The sandbox's ULID, from the session or the token.",
        "oid" => "An order's ULID.",
        "cid" => "A catering event's, a customer's or a campaign's ULID, as the path says.",
        "mid" => "A message's ULID.",
        "date" => "A bakery day, `YYYY-MM-DD`.",
        "segment" => "A segment's slug, such as `lapsed-60-days`.",
        "slug" => "A menu item's slug, such as `croissant`.",
        "eventId" => "The dead-lettered event's ULID.",
        _ => "A path segment.",
    }
}

/// The tag a path is grouped under in the docs page.
fn tag(path: &str) -> &'static str {
    let rest = path.trim_start_matches("/v1/");
    let area = match rest.strip_prefix("sandboxes/{id}/") {
        Some(sub) => sub.split('/').next().unwrap_or(""),
        None => rest.split('/').next().unwrap_or(""),
    };
    match area {
        "health" | "status" => "service",
        "auth" | "session" => "sign-in",
        "sandboxes" | "faults" | "clock" | "dead-letters" => "sandbox",
        "menu" => "menu",
        "orders" => "orders",
        "kitchen" | "heartbeat" => "kitchen",
        "traffic" => "traffic",
        "billing" | "stripe" => "payments",
        "schedule" => "schedule",
        "catering" => "catering",
        "customers" | "segments" | "campaigns" | "inbox" | "leads" | "activity" | "rebuild" => {
            "crm"
        }
        "dispatch" => "dispatch",
        "token" => "token",
        other => panic!("no tag for {other} ({path})"),
    }
}

fn websocket() -> Value {
    json!({
        "protocol": "v1",
        "description": "Frames are JSON text, each with `\"v\": 1`. Limits: 4 open sockets a sandbox (a fifth is told `bye` `limit` and closed with 1008), frames of at most 4 KB (1009), 10 frames a second a socket (1008), text frames only (1003). The storefront sends no ping and reconnects instead.",
        "frames": SOCKET_FRAMES.iter().map(|(direction, t, shape, when)| json!({
            "direction": direction,
            "t": t,
            "shape": shape,
            "when": when,
        })).collect::<Vec<_>>(),
    })
}

/// Every rendered schema and every type their `$defs` hold, as components. A type that is both
/// rendered and some schema's def must be the same schema both ways, but for the rendered one's
/// `title`.
pub fn schema_components() -> BTreeMap<String, Value> {
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    let mut rendered: Vec<String> = Vec::new();
    for (file, text) in crate::schemas() {
        let name = file.trim_end_matches(".schema.json").to_owned();
        let mut schema: Value = serde_json::from_str(&text).expect("a rendered schema parses");
        let object = schema.as_object_mut().expect("a schema is an object");
        object.remove("$schema");
        let defs = object.remove("$defs");
        retarget(&mut schema);
        merge(&mut out, &name, schema, true);
        rendered.push(name);
        if let Some(Value::Object(defs)) = defs {
            for (def, mut value) in defs {
                retarget(&mut value);
                merge(&mut out, &def, value, false);
            }
        }
    }
    out
}

fn merge(out: &mut BTreeMap<String, Value>, name: &str, value: Value, is_rendered: bool) {
    let untitled = |v: &Value| {
        let mut v = v.clone();
        if let Some(o) = v.as_object_mut() {
            o.remove("title");
        }
        v
    };
    match out.get(name) {
        None => {
            out.insert(name.to_owned(), value);
        }
        Some(existing) => {
            assert!(
                untitled(existing) == untitled(&value),
                "{name} has two different schemas among the contracts"
            );
            if is_rendered {
                out.insert(name.to_owned(), value);
            }
        }
    }
}

/// Points every `#/$defs/<Name>` at `#/components/schemas/<Name>`.
fn retarget(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if key == "$ref"
                    && let Value::String(target) = v
                    && let Some(name) = target.strip_prefix("#/$defs/")
                {
                    *target = format!("#/components/schemas/{name}");
                } else {
                    retarget(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(retarget),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const README: &str = include_str!("../../../workers/api/README.md");

    fn refs<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
        match value {
            Value::Object(map) => {
                for (key, v) in map {
                    if key == "$ref" {
                        out.push(v.as_str().expect("a $ref is a string"));
                    } else {
                        refs(v, out);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|v| refs(v, out)),
            _ => {}
        }
    }

    /// The OpenAPI 3.1 schema's basic shape, by hand: the required members, every operation
    /// with a response and every response with a description, every `$ref` resolving, every
    /// path template's parameter declared, every security requirement a declared scheme.
    #[test]
    fn the_document_has_openapi_3_1_shape() {
        let doc = document();
        assert_eq!(doc["openapi"], "3.1.0");
        assert!(doc["info"]["title"].is_string());
        assert!(doc["info"]["version"].is_string());
        assert_eq!(doc["info"]["license"]["identifier"], "MIT");
        let servers: Vec<&str> = doc["servers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["url"].as_str().unwrap())
            .collect();
        assert_eq!(
            servers,
            [
                "https://api.bakery.ihaveasegway.com",
                "http://127.0.0.1:8788"
            ]
        );

        let paths = doc["paths"].as_object().expect("paths");
        assert!(!paths.is_empty());
        let schemes = doc["components"]["securitySchemes"].as_object().unwrap();
        let tags: BTreeSet<&str> = doc["tags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        let mut operation_ids = BTreeSet::new();
        for (path, item) in paths {
            assert!(path.starts_with('/'), "{path}");
            let item = item.as_object().unwrap();
            assert!(!item.is_empty(), "{path}");
            for (method, op) in item {
                assert!(
                    [
                        "get", "put", "post", "delete", "options", "head", "patch", "trace"
                    ]
                    .contains(&method.as_str()),
                    "{path}: {method}"
                );
                let id = op["operationId"].as_str().unwrap();
                assert!(operation_ids.insert(id), "{id} twice");
                for t in op["tags"].as_array().unwrap() {
                    assert!(tags.contains(t.as_str().unwrap()), "{id}");
                }
                let responses = op["responses"].as_object().expect("responses");
                assert!(!responses.is_empty(), "{id}: no response");
                for (status, response) in responses {
                    assert!(
                        status.len() == 3 && status.bytes().all(|b| b.is_ascii_digit()),
                        "{id}: {status}"
                    );
                    assert!(
                        response["description"]
                            .as_str()
                            .is_some_and(|d| !d.is_empty()),
                        "{id} {status}: a response needs a description"
                    );
                    if status.starts_with('4') || status.starts_with('5') {
                        assert_eq!(
                            response["content"]["application/problem+json"]["schema"]["$ref"],
                            "#/components/schemas/Problem",
                            "{id} {status}"
                        );
                    }
                }
                let declared: BTreeSet<&str> = op["parameters"]
                    .as_array()
                    .map(|ps| {
                        ps.iter()
                            .filter(|p| p["in"] == "path")
                            .map(|p| {
                                assert_eq!(p["required"], true, "{id}");
                                p["name"].as_str().unwrap()
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let templated: BTreeSet<&str> = routes::path_params(path).into_iter().collect();
                assert_eq!(declared, templated, "{id}: path parameters");
                for requirement in op["security"].as_array().expect("security") {
                    for name in requirement.as_object().unwrap().keys() {
                        assert!(schemes.contains_key(name), "{id}: {name}");
                    }
                }
            }
        }

        let mut all = Vec::new();
        refs(&doc, &mut all);
        assert!(all.len() > 200, "{} refs", all.len());
        for target in all {
            let pointer = target
                .strip_prefix('#')
                .unwrap_or_else(|| panic!("{target}: an external $ref"));
            assert!(doc.pointer(pointer).is_some(), "{target} does not resolve");
        }
        for name in doc["components"]["schemas"].as_object().unwrap().keys() {
            assert!(
                name.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
                "{name}"
            );
        }
        let text = render();
        assert!(!text.contains("#/$defs/"), "a $ref left pointing at $defs");
        assert!(!text.contains("\"$schema\""), "a schema kept its $schema");
    }

    #[test]
    fn every_route_appears_once() {
        let doc = document();
        let mut count = 0;
        for route in routes::ROUTES {
            let op = &doc["paths"][route.path][route.method.to_ascii_lowercase()];
            assert_eq!(
                op["operationId"], route.id,
                "{} {}",
                route.method, route.path
            );
            count += 1;
        }
        let operations: usize = doc["paths"]
            .as_object()
            .unwrap()
            .values()
            .map(|item| item.as_object().unwrap().len())
            .sum();
        assert_eq!(operations, count);
        assert_eq!(count, routes::ROUTES.len());
    }

    #[test]
    fn idempotency_security_and_problems_are_where_they_belong() {
        let doc = document();
        let place = &doc["paths"]["/v1/sandboxes/{id}/orders"]["post"];
        let params = place["parameters"].as_array().unwrap();
        assert!(params.contains(&json!({ "$ref": "#/components/parameters/IdempotencyKey" })));
        assert_eq!(
            place["responses"]["200"]["headers"]["Idempotent-Replayed"]["$ref"],
            "#/components/headers/IdempotentReplayed"
        );
        assert_eq!(
            place["requestBody"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/OrderRequest"
        );
        assert_eq!(
            place["security"],
            json!([{ "sessionCookie": [] }, { "bearerToken": [] }])
        );
        let conflict = place["responses"]["409"]["description"].as_str().unwrap();
        for slug in ["`slot-full`", "`item-cap`", "`lead-time`", "`hold-lost`"] {
            assert!(conflict.contains(slug), "{conflict}");
        }
        assert_eq!(
            place["responses"]["409"]["x-problems"],
            json!(["slot-full", "item-cap", "lead-time", "hold-lost"])
        );

        let hook = &doc["paths"]["/v1/stripe/webhook"]["post"];
        assert_eq!(hook["security"], json!([{ "stripeSignature": [] }]));
        assert!(hook.get("parameters").is_none());

        let socket = &doc["paths"]["/v1/sandboxes/{id}/kitchen/ws"]["get"];
        assert_eq!(socket["security"], json!([{ "sessionCookie": [] }]));
        assert_eq!(socket["x-websocket"]["protocol"], "v1");
        assert!(socket["responses"]["101"].is_object());

        let rotate = &doc["paths"]["/v1/sandboxes/{id}/token/rotate"]["post"];
        assert_eq!(rotate["security"], json!([{ "sessionCookie": [] }]));
        assert_eq!(
            rotate["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/TokenResponse"
        );
        let get = &doc["paths"]["/v1/sandboxes/{id}/token"]["get"];
        assert!(
            get["responses"]["403"]["description"]
                .as_str()
                .unwrap()
                .contains("`guest-scope`")
        );
        assert!(get["responses"]["404"].is_object());

        let letters = &doc["paths"]["/v1/sandboxes/{id}/dead-letters"]["get"];
        assert_eq!(
            letters["responses"]["200"]["content"]["application/json"]["schema"],
            json!({ "type": "array", "items": { "$ref": "#/components/schemas/DeadLetter" } })
        );
        let health = &doc["paths"]["/v1/health"]["get"];
        assert_eq!(health["security"], json!([]));
        let capacity = &doc["paths"]["/v1/sandboxes/{id}/schedule/{date}/capacity"]["patch"];
        assert!(
            capacity["parameters"]
                .as_array()
                .unwrap()
                .contains(&json!({ "$ref": "#/components/parameters/IdempotencyKeyOptional" }))
        );
    }

    #[test]
    fn components_come_from_the_rendered_schemas() {
        let components = schema_components();
        for (file, _) in crate::schemas() {
            let name = file.trim_end_matches(".schema.json");
            assert_eq!(components[name]["title"], name, "{name} keeps its title");
        }
        // A type that is only ever a def is a component too.
        assert!(components.contains_key("OrderKind"));
        assert!(components.contains_key("StopView"));
        assert_eq!(
            components["Problem"]["required"],
            json!(["type", "title", "status"])
        );
    }

    #[test]
    fn the_socket_frames_are_the_readmes() {
        let section = README
            .split("\n## The kitchen socket\n")
            .nth(1)
            .and_then(|rest| rest.split("\n## ").next())
            .expect("the README's socket section");
        let mut in_readme = BTreeSet::new();
        for piece in section.split("t: \"").skip(1) {
            in_readme.insert(piece.split('"').next().unwrap().to_owned());
        }
        for piece in section.split("{\"t\":\"").skip(1) {
            in_readme.insert(piece.split('"').next().unwrap().to_owned());
        }
        let ours: BTreeSet<String> = SOCKET_FRAMES.iter().map(|f| f.1.to_owned()).collect();
        assert!(in_readme.len() >= 8, "{in_readme:?}");
        assert_eq!(ours, in_readme);
    }

    #[test]
    fn a_round_trip_gives_the_same_bytes() {
        let text = render();
        let parsed: Value = serde_json::from_str(&text).unwrap();
        let mut again = serde_json::to_string_pretty(&parsed).unwrap();
        again.push('\n');
        assert!(
            again == text,
            "a parse and a re-render changed the document"
        );
        assert!(render() == text, "two renders differ");
    }

    #[test]
    fn the_committed_document_is_current() {
        let path = document_path();
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == render(),
            "{} is stale: run `cargo run -p bakery-contracts --bin openapi`",
            path.display()
        );
    }
}
