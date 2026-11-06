//! Analytics Engine as data: the eight data points the Worker and its objects write, the kept
//! queries the status page's counters come from, the SQL API's request and the reader of its
//! answers (docs/operations.md, "Observability"; docs/cost.md, Analytics Engine).
//!
//! Pure: nothing here writes a point, sends a request or reads a clock. The Worker's
//! `metrics.rs` writes [`Point`]s to the `METRICS` binding and its `analytics.rs` sends
//! [`SqlRequest`]s with the bearer token; the 15-minute cron turns the answers into
//! [`StatusCounters`] with [`counters`] and `Control` keeps them as a snapshot.
//!
//! A point holds the event's name (its one blob and its index) and counts or milliseconds (its
//! doubles), and nothing about a visitor, a sandbox, an account or an IP: Analytics Engine adds
//! no more than its own timestamp and sample interval.
//!
//! The SQL API: `POST {base}/accounts/{account}/analytics_engine/sql` with the query as the
//! body and `Authorization: Bearer <token>`, answering `FORMAT JSON`'s `{meta, data, rows}`
//! ([SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) and
//! [FORMAT clause](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/#format-clause),
//! as of 2026-11-06). Counts are `SUM(_sample_interval)`, so they stay counts if a point is
//! sampled.

use std::collections::BTreeMap;

use bakery_contracts::{CountersState, LastWipe, StatusCounters};
use bakery_domain::WallTime;
use serde::Deserialize;
use serde_json::{Map, Value};

/// The dataset the `METRICS` binding writes to (workers/api/wrangler.jsonc).
pub const DATASET: &str = "bakery_events";
/// The Cloudflare API's base; `ANALYTICS_API_BASE` replaces it on this machine only.
pub const API_BASE: &str = "https://api.cloudflare.com/client/v4";
/// How long one query may take before the refresh gives up on it.
pub const TIMEOUT_MS: u32 = 5_000;
/// A snapshot younger than this is `live`: the cron runs every 15 minutes, plus 5 of slack.
pub const LIVE_FOR_MS: i64 = 20 * 60 * 1_000;

/// The events a point is written for, one point each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// `Control` admitted a sandbox.
    SandboxCreated,
    /// An `Order` committed `OrderPlaced`.
    OrderPlaced,
    /// `Billing` committed `PaymentSucceeded`.
    PaymentSucceeded,
    /// `Billing` committed `PaymentFailed`.
    PaymentFailed,
    /// `Billing` committed `RefundIssued`.
    RefundIssued,
    /// `Control`'s nightly wipe ended.
    Wipe,
    /// The dead-letter writer kept a message.
    Dlq,
    /// The 15-minute cron breaker raised its state (PR 17). Not a counted event.
    Breaker,
}

impl Event {
    pub const ALL: [Event; 8] = [
        Event::SandboxCreated,
        Event::OrderPlaced,
        Event::PaymentSucceeded,
        Event::PaymentFailed,
        Event::RefundIssued,
        Event::Wipe,
        Event::Dlq,
        Event::Breaker,
    ];

    /// The name in the point's blob and index, and in the kept queries.
    pub fn name(self) -> &'static str {
        match self {
            Event::SandboxCreated => "sandbox_created",
            Event::OrderPlaced => "order_placed",
            Event::PaymentSucceeded => "payment_succeeded",
            Event::PaymentFailed => "payment_failed",
            Event::RefundIssued => "refund_issued",
            Event::Wipe => "wipe",
            Event::Dlq => "dlq",
            Event::Breaker => "breaker",
        }
    }
}

/// One data point: `blobs: [name]`, `indexes: [name]`, `doubles` as built.
#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    pub event: Event,
    pub doubles: Vec<f64>,
}

impl Point {
    /// A point that counts one event: `double1` is 1.
    pub fn one(event: Event) -> Point {
        Point {
            event,
            doubles: vec![1.0],
        }
    }

    /// The wipe's point: `double1` sandboxes, `double2` objects, `double3` milliseconds.
    pub fn wipe(sandboxes: u32, objects: u32, ms: u64) -> Point {
        Point {
            event: Event::Wipe,
            doubles: vec![f64::from(sandboxes), f64::from(objects), ms as f64],
        }
    }

    /// The breaker's point: `double1` the level it rose to (1 `read-only`, 2 `off`), `double2`
    /// the window's price in dollars.
    pub fn breaker(level: u8, usd_micros: u64) -> Point {
        Point {
            event: Event::Breaker,
            doubles: vec![f64::from(level), usd_micros as f64 / 1_000_000.0],
        }
    }

    /// `blob1`: the event's name, and nothing else.
    pub fn blobs(&self) -> [&'static str; 1] {
        [self.event.name()]
    }

    /// `index1`, the sampling key: the event's name.
    pub fn indexes(&self) -> [&'static str; 1] {
        [self.event.name()]
    }
}

/// One kept query: a name for the log line and the SQL, as a person would paste it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeptQuery {
    pub name: &'static str,
    pub sql: &'static str,
}

/// The six counted events over the last 24 hours, one row per event that has points:
/// sandboxes (read against the cap of 300), orders, payments, payment failures, refunds and
/// dead letters.
pub const COUNTS_24H: KeptQuery = KeptQuery {
    name: "counts_24h",
    sql: "SELECT index1 AS event, SUM(_sample_interval) AS n FROM bakery_events \
          WHERE index1 IN ('sandbox_created', 'order_placed', 'payment_succeeded', \
          'payment_failed', 'refund_issued', 'dlq') \
          AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY index1 FORMAT JSON",
};

/// The last wipe: when, how many sandboxes and objects, how long.
pub const LAST_WIPE: KeptQuery = KeptQuery {
    name: "last_wipe",
    sql: "SELECT timestamp AS at, double1 AS sandboxes, double2 AS objects, double3 AS ms \
          FROM bakery_events WHERE index1 = 'wipe' ORDER BY timestamp DESC LIMIT 1 FORMAT JSON",
};

/// Every kept query, in the order [`counters`] reads their answers: a refresh is two queries,
/// so 96 refreshes a day are 192 queries.
pub const KEPT: [KeptQuery; 2] = [COUNTS_24H, LAST_WIPE];

/// The events [`COUNTS_24H`] counts, in its `IN` list's order.
pub const COUNTED: [Event; 6] = [
    Event::SandboxCreated,
    Event::OrderPlaced,
    Event::PaymentSucceeded,
    Event::PaymentFailed,
    Event::RefundIssued,
    Event::Dlq,
];

/// Why a refresh could not use an answer. A code for the log line, never the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// The API answered something other than 200.
    Status(u16),
    /// The body is not `FORMAT JSON`'s object.
    Body,
    /// A row lacks a column or holds something that is not a count.
    Shape(&'static str),
    /// Fewer or more answers than kept queries.
    Answers,
}

impl ReadError {
    pub fn code(&self) -> &'static str {
        match self {
            ReadError::Status(_) => "status",
            ReadError::Body => "body",
            ReadError::Shape(_) => "shape",
            ReadError::Answers => "answers",
        }
    }

    /// The HTTP status, when the API gave one other than 200.
    pub fn status(&self) -> Option<u16> {
        match self {
            ReadError::Status(s) => Some(*s),
            _ => None,
        }
    }
}

/// An account id fit for the URL's path: letters and digits only (the dashboard's is 32 hex
/// characters), so it cannot change the path.
pub fn is_account_id(account: &str) -> bool {
    !account.is_empty() && account.len() <= 64 && account.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// One call to the SQL API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlRequest {
    /// `/accounts/{account}/analytics_engine/sql`.
    pub path: String,
    /// The query text, the whole body.
    pub body: &'static str,
}

impl SqlRequest {
    /// The full URL under `base`, with or without its trailing slash.
    pub fn url(&self, base: &str) -> String {
        format!("{}{}", base.trim_end_matches('/'), self.path)
    }

    /// `Authorization: Bearer <token>` and a plain-text body. The values hold the token, so a
    /// caller never logs them.
    pub fn headers(&self, token: &str) -> [(&'static str, String); 2] {
        [
            ("Authorization", format!("Bearer {token}")),
            ("Content-Type", "text/plain".to_owned()),
        ]
    }
}

/// The request for one kept query, or `None` when the account id is not fit for a path.
pub fn sql_request(account: &str, query: &KeptQuery) -> Option<SqlRequest> {
    is_account_id(account).then(|| SqlRequest {
        path: format!("/accounts/{account}/analytics_engine/sql"),
        body: query.sql,
    })
}

/// One column of `meta`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
}

/// `FORMAT JSON`'s answer. Unknown keys (`rows_before_limit_at_least`) are ignored.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SqlAnswer {
    pub meta: Vec<Column>,
    pub data: Vec<Map<String, Value>>,
    pub rows: u64,
}

/// The status and body of one call, as an answer or the reason it is not one.
pub fn read(status: u16, body: &str) -> Result<SqlAnswer, ReadError> {
    if status != 200 {
        return Err(ReadError::Status(status));
    }
    serde_json::from_str(body).map_err(|_| ReadError::Body)
}

/// A count column: a number, or a number in a string (64-bit integers may come quoted), or
/// `null` for a sum over no rows. Rounded, and capped at `u32::MAX`.
fn count(value: Option<&Value>, column: &'static str) -> Result<u32, ReadError> {
    let n = match value {
        None => return Err(ReadError::Shape(column)),
        Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().ok_or(ReadError::Shape(column))?,
        Some(Value::String(s)) => s.trim().parse().map_err(|_| ReadError::Shape(column))?,
        Some(_) => return Err(ReadError::Shape(column)),
    };
    if !n.is_finite() || n < 0.0 {
        return Err(ReadError::Shape(column));
    }
    Ok(n.round().min(f64::from(u32::MAX)) as u32)
}

/// A grouped answer (`event`, `n`) as a map from each of [`COUNTED`]'s names to its count: a
/// name with no row is 0, and a row naming any other event is ignored.
pub fn read_counts(answer: &SqlAnswer) -> Result<BTreeMap<&'static str, u32>, ReadError> {
    let mut counts: BTreeMap<&'static str, u32> = COUNTED.iter().map(|e| (e.name(), 0)).collect();
    for row in &answer.data {
        let name = row
            .get("event")
            .and_then(Value::as_str)
            .ok_or(ReadError::Shape("event"))?;
        if let Some(total) = counts.get_mut(name) {
            *total = total.saturating_add(count(row.get("n"), "n")?);
        }
    }
    Ok(counts)
}

/// The last wipe's row, or `None` when the dataset holds no `wipe` point.
pub fn read_last_wipe(answer: &SqlAnswer) -> Result<Option<LastWipe>, ReadError> {
    let Some(row) = answer.data.first() else {
        return Ok(None);
    };
    let at = row
        .get("at")
        .and_then(Value::as_str)
        .and_then(rfc3339)
        .ok_or(ReadError::Shape("at"))?;
    Ok(Some(LastWipe {
        at,
        sandboxes: count(row.get("sandboxes"), "sandboxes")?,
        objects: count(row.get("objects"), "objects")?,
        ms: count(row.get("ms"), "ms")?,
    }))
}

/// Analytics Engine's `DateTime`, `2026-11-06 10:00:04` in UTC, as RFC 3339
/// (`2026-11-06T10:00:04Z`). An RFC 3339 UTC time is taken as it is, to the second.
pub fn rfc3339(text: &str) -> Option<String> {
    let t = text.trim();
    let b = t.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let shaped = digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && (b[10] == b' ' || b[10] == b'T')
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19);
    let rest = &t[19..];
    let utc = rest.is_empty()
        || rest == "Z"
        || (rest.starts_with('.')
            && rest.ends_with('Z')
            && rest[1..rest.len() - 1].bytes().all(|c| c.is_ascii_digit()));
    if !shaped || !utc {
        return None;
    }
    let text = format!("{}T{}Z", &t[..10], &t[11..19]);
    // A real date and time, not only the shape of one.
    format!("{}T{}.000Z", &t[..10], &t[11..19])
        .parse::<WallTime>()
        .ok()
        .map(|_| text)
}

/// The counters from the kept queries' answers, in [`KEPT`]'s order.
pub fn counters(answers: &[SqlAnswer]) -> Result<StatusCounters, ReadError> {
    let [counts, last_wipe] = answers else {
        return Err(ReadError::Answers);
    };
    let counts = read_counts(counts)?;
    let of = |e: Event| counts.get(e.name()).copied().unwrap_or(0);
    Ok(StatusCounters {
        orders_24h: of(Event::OrderPlaced),
        payments_24h: of(Event::PaymentSucceeded),
        payment_failures_24h: of(Event::PaymentFailed),
        refunds_24h: of(Event::RefundIssued),
        sandboxes_24h: of(Event::SandboxCreated),
        dlq_24h: of(Event::Dlq),
        last_wipe: read_last_wipe(last_wipe)?,
    })
}

/// The snapshot's state at `now`: `unavailable` without one; `stale` when a refresh failed
/// after it was taken or it is older than [`LIVE_FOR_MS`]; `live` otherwise.
pub fn counters_state(
    as_of: Option<WallTime>,
    failed_at: Option<WallTime>,
    now: WallTime,
) -> CountersState {
    let Some(as_of) = as_of else {
        return CountersState::Unavailable;
    };
    let failed_since = failed_at.is_some_and(|f| f > as_of);
    if failed_since || now.unix_ms() - as_of.unix_ms() > LIVE_FOR_MS {
        CountersState::Stale
    } else {
        CountersState::Live
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

    // The shapes below follow the SQL API's documented `FORMAT JSON` answer (the module's
    // links, 2026-11-06), with the column types ClickHouse gives these expressions. A sum of
    // `_sample_interval` is a 64-bit integer, which may come quoted, so both forms are read.
    const COUNTS: &str = r#"{"meta":[{"name":"event","type":"String"},{"name":"n","type":"UInt64"}],"data":[{"event":"sandbox_created","n":"7"},{"event":"order_placed","n":"12"},{"event":"payment_succeeded","n":10},{"event":"payment_failed","n":"2"},{"event":"refund_issued","n":1}],"rows":5,"rows_before_limit_at_least":5}"#;
    const EMPTY: &str = r#"{"meta":[{"name":"event","type":"String"},{"name":"n","type":"UInt64"}],"data":[],"rows":0}"#;
    const WIPE: &str = r#"{"meta":[{"name":"at","type":"DateTime"},{"name":"sandboxes","type":"Float64"},{"name":"objects","type":"Float64"},{"name":"ms","type":"Float64"}],"data":[{"at":"2026-11-06 10:00:04","sandboxes":7,"objects":133,"ms":4210}],"rows":1}"#;

    fn answer(text: &str) -> SqlAnswer {
        read(200, text).unwrap()
    }

    #[test]
    fn a_point_holds_the_event_name_and_numbers_only() {
        let names: Vec<&str> = Event::ALL.iter().map(|e| e.name()).collect();
        assert_eq!(
            names,
            [
                "sandbox_created",
                "order_placed",
                "payment_succeeded",
                "payment_failed",
                "refund_issued",
                "wipe",
                "dlq",
                "breaker"
            ]
        );
        let p = Point::one(Event::OrderPlaced);
        assert_eq!(p.blobs(), ["order_placed"]);
        assert_eq!(p.indexes(), ["order_placed"]);
        assert_eq!(p.doubles, [1.0]);
        let w = Point::wipe(7, 133, 4_210);
        assert_eq!(w.blobs(), ["wipe"]);
        assert_eq!(w.doubles, [7.0, 133.0, 4_210.0]);
        let b = Point::breaker(2, 150_000);
        assert_eq!(b.blobs(), ["breaker"]);
        assert_eq!(b.doubles, [2.0, 0.15]);
    }

    #[test]
    fn a_refresh_is_two_kept_queries_over_the_dataset_as_json() {
        assert_eq!(KEPT, [COUNTS_24H, LAST_WIPE]);
        for q in KEPT {
            assert!(q.sql.contains("FROM bakery_events"), "{}", q.name);
            assert!(q.sql.ends_with("FORMAT JSON"), "{}", q.name);
            assert!(!q.sql.contains("  "), "{}: one space between words", q.name);
        }
        assert_eq!(
            COUNTS_24H.sql,
            "SELECT index1 AS event, SUM(_sample_interval) AS n FROM bakery_events WHERE index1 IN ('sandbox_created', 'order_placed', 'payment_succeeded', 'payment_failed', 'refund_issued', 'dlq') AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY index1 FORMAT JSON"
        );
        for e in COUNTED {
            assert!(COUNTS_24H.sql.contains(&format!("'{}'", e.name())), "{e:?}");
        }
        assert!(!COUNTED.contains(&Event::Wipe));
        assert!(!COUNTED.contains(&Event::Breaker));
        assert!(!COUNTS_24H.sql.contains("'breaker'"));
        assert_eq!(
            LAST_WIPE.sql,
            "SELECT timestamp AS at, double1 AS sandboxes, double2 AS objects, double3 AS ms FROM bakery_events WHERE index1 = 'wipe' ORDER BY timestamp DESC LIMIT 1 FORMAT JSON"
        );
    }

    #[test]
    fn the_request_names_the_account_and_carries_the_query_and_the_token() {
        let r = sql_request(ACCOUNT, &COUNTS_24H).unwrap();
        assert_eq!(
            r.url("https://api.cloudflare.com/client/v4/"),
            format!("https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/analytics_engine/sql")
        );
        assert_eq!(r.url(API_BASE), r.url(&format!("{API_BASE}/")));
        assert_eq!(r.body, COUNTS_24H.sql);
        let [auth, ct] = r.headers("not-a-token");
        assert_eq!(auth, ("Authorization", "Bearer not-a-token".to_owned()));
        assert_eq!(ct, ("Content-Type", "text/plain".to_owned()));
        for bad in ["", "../x", "abc/def", "a b", "abc?x=1", &"a".repeat(65)] {
            assert!(sql_request(bad, &COUNTS_24H).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn counts_read_as_a_map_with_missing_names_zero_and_unknown_ones_ignored() {
        let a = answer(COUNTS);
        assert_eq!(a.rows, 5);
        assert_eq!(a.meta[1].name, "n");
        let c = read_counts(&a).unwrap();
        assert_eq!(c.len(), 6);
        assert_eq!(
            [
                c["sandbox_created"],
                c["order_placed"],
                c["payment_succeeded"],
                c["payment_failed"],
                c["refund_issued"],
                c["dlq"]
            ],
            [7, 12, 10, 2, 1, 0]
        );
        let none = read_counts(&answer(EMPTY)).unwrap();
        assert_eq!(none.len(), 6);
        assert!(none.values().all(|n| *n == 0));
        let odd = read_counts(&answer(
            r#"{"meta":[],"data":[{"event":"wipe","n":3},{"event":"something_else","n":"x"},{"event":"dlq","n":null}],"rows":3}"#,
        ))
        .unwrap();
        assert!(odd.values().all(|n| *n == 0), "{odd:?}");
        assert!(!odd.contains_key("wipe"));
        for (bad, column) in [
            (r#"{"meta":[],"data":[{"n":1}],"rows":1}"#, "event"),
            (r#"{"meta":[],"data":[{"event":"dlq"}],"rows":1}"#, "n"),
            (
                r#"{"meta":[],"data":[{"event":"dlq","n":-1}],"rows":1}"#,
                "n",
            ),
            (
                r#"{"meta":[],"data":[{"event":"dlq","n":"many"}],"rows":1}"#,
                "n",
            ),
            (
                r#"{"meta":[],"data":[{"event":"dlq","n":[1]}],"rows":1}"#,
                "n",
            ),
        ] {
            assert_eq!(
                read_counts(&answer(bad)),
                Err(ReadError::Shape(column)),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_failed_call_is_a_status_and_a_strange_body_a_code() {
        assert_eq!(
            read(401, r#"{"success":false,"errors":[{"code":10000}]}"#),
            Err(ReadError::Status(401))
        );
        assert_eq!(read(422, "cannot parse"), Err(ReadError::Status(422)));
        assert_eq!(read(200, "not json"), Err(ReadError::Body));
        assert_eq!(read(200, r#"{"data":[]}"#), Err(ReadError::Body));
        assert_eq!(ReadError::Status(503).status(), Some(503));
        assert_eq!(ReadError::Status(503).code(), "status");
        assert_eq!(ReadError::Body.status(), None);
    }

    #[test]
    fn the_last_wipe_reads_as_rfc_3339_utc() {
        assert_eq!(
            read_last_wipe(&answer(WIPE)),
            Ok(Some(LastWipe {
                at: "2026-11-06T10:00:04Z".into(),
                sandboxes: 7,
                objects: 133,
                ms: 4_210,
            }))
        );
        assert_eq!(read_last_wipe(&answer(EMPTY)), Ok(None));
        assert_eq!(
            rfc3339("2026-11-06T10:00:04.250Z").as_deref(),
            Some("2026-11-06T10:00:04Z")
        );
        assert_eq!(
            rfc3339("2026-11-06T10:00:04Z").as_deref(),
            Some("2026-11-06T10:00:04Z")
        );
        for bad in [
            "2026-11-06 10:00",
            "2026-11-06T10:00:04+02:00",
            "2026-13-06 10:00:04",
            "yesterday at ten",
        ] {
            assert_eq!(rfc3339(bad), None, "{bad}");
        }
    }

    #[test]
    fn counters_come_from_the_two_answers_in_order() {
        let answers: Vec<SqlAnswer> = [COUNTS, WIPE].iter().map(|t| answer(t)).collect();
        let c = counters(&answers).unwrap();
        assert_eq!(
            (
                c.sandboxes_24h,
                c.orders_24h,
                c.payments_24h,
                c.payment_failures_24h,
                c.refunds_24h,
                c.dlq_24h
            ),
            (7, 12, 10, 2, 1, 0)
        );
        assert_eq!(c.last_wipe.unwrap().objects, 133);
        let quiet: Vec<SqlAnswer> = [EMPTY, EMPTY].iter().map(|t| answer(t)).collect();
        let c = counters(&quiet).unwrap();
        assert_eq!((c.orders_24h, c.dlq_24h, c.last_wipe), (0, 0, None));
        assert_eq!(counters(&answers[..1]), Err(ReadError::Answers));
    }

    #[test]
    fn the_state_is_live_for_20_minutes_after_a_good_refresh() {
        let t = |m: i64| WallTime::from_unix_ms(1_794_069_000_000 + m * 60_000).unwrap();
        assert_eq!(counters_state(None, None, t(0)), CountersState::Unavailable);
        assert_eq!(
            counters_state(None, Some(t(0)), t(1)),
            CountersState::Unavailable
        );
        assert_eq!(counters_state(Some(t(0)), None, t(20)), CountersState::Live);
        assert_eq!(
            counters_state(Some(t(0)), None, t(21)),
            CountersState::Stale
        );
        // A failure after the snapshot makes it stale at once; one before it does not.
        assert_eq!(
            counters_state(Some(t(0)), Some(t(1)), t(2)),
            CountersState::Stale
        );
        assert_eq!(
            counters_state(Some(t(5)), Some(t(1)), t(6)),
            CountersState::Live
        );
        // A snapshot a little ahead of this isolate's clock is still live.
        assert_eq!(counters_state(Some(t(1)), None, t(0)), CountersState::Live);
    }
}
