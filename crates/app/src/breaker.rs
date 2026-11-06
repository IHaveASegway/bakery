//! The 15-minute cron breaker as data: the meters it reads, the GraphQL Analytics API's requests
//! and the reader of their answers, the dated prices and per-sandbox meter, the lines a window
//! is held to and the verdict (ADR 0010 decision 2.4; docs/cost.md, "Guardrails").
//!
//! Pure: nothing here sends a request, reads a clock or writes a row. The Worker's `breaker.rs`
//! sends the four requests with the breaker's token, `Control` keeps the state and calls
//! [`decide`], and the cron hands `Control` the window's reads by command.
//!
//! The breaker reads the last complete 15-minute slot before the run ([`window_before`]), one
//! GraphQL request per dataset, so one dataset's failure never hides another's. Every count is
//! priced at the Workers Paid overage rates, as if past the included amounts, which is
//! deliberately conservative, in micro-dollars so the arithmetic is exact. A window over a
//! meter's line, or priced over the dollar line, sets `read-only`; one priced over the burst
//! factor times the dollar line, or still over a line after a trip, sets `off`. A state never
//! goes down by itself: a person resets it.

use bakery_contracts::{BreakerState, Flag};
use bakery_domain::WallTime;
use serde_json::{Map, Value, json};

/// The Cloudflare API's base; `BREAKER_API_BASE` replaces it on this machine only.
pub const API_BASE: &str = "https://api.cloudflare.com/client/v4";
/// How long one request may take before the run gives up on it.
pub const TIMEOUT_MS: u32 = 5_000;
/// One window: the cron's interval.
pub const WINDOW_MS: i64 = 15 * 60 * 1_000;
/// Windows in a day, for a meter's 15-minute share of its daily budget.
pub const WINDOWS_PER_DAY: u64 = 96;
/// Windows in a 30-day month: the ceiling spent at one dollar line a window lasts a month.
pub const WINDOWS_PER_MONTH: u64 = 2_880;
/// `BREAKER_CEILING_USD` when unset: the account's ceiling, $100 a month (ADR 0010).
pub const DEFAULT_CEILING_MICROS: u64 = 100_000_000;
/// `BREAKER_BURST_FACTOR` when unset: the "4×" of docs/cost.md, "Guardrails".
pub const DEFAULT_BURST_FACTOR: u32 = 4;
/// Groups one request may return: the filter selects one slot, so a handful is expected.
pub const GROUP_LIMIT: u32 = 1_000;

/// A metered quantity the breaker reads. Values are held in thousandths of the unit (requests,
/// rows, operations, GB-s), so the GB-s and a half DO request stay exact integers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Meter {
    WorkerRequests,
    DoRequests,
    RowsWritten,
    DoGbS,
    QueueOperations,
}

impl Meter {
    pub const ALL: [Meter; 5] = [
        Meter::WorkerRequests,
        Meter::DoRequests,
        Meter::RowsWritten,
        Meter::DoGbS,
        Meter::QueueOperations,
    ];

    /// The name in the log lines, `Control`'s `meters` column and the status's `unread`.
    pub fn name(self) -> &'static str {
        match self {
            Meter::WorkerRequests => "worker_requests",
            Meter::DoRequests => "do_requests",
            Meter::RowsWritten => "rows_written",
            Meter::DoGbS => "do_gb_s",
            Meter::QueueOperations => "queue_operations",
        }
    }

    pub fn parse(name: &str) -> Option<Meter> {
        Meter::ALL.into_iter().find(|m| m.name() == name)
    }

    fn index(self) -> usize {
        self as usize
    }

    /// The dataset that answers for this meter.
    pub fn dataset(self) -> Dataset {
        match self {
            Meter::WorkerRequests => Dataset::Workers,
            Meter::DoRequests => Dataset::DoInvocations,
            Meter::RowsWritten | Meter::DoGbS => Dataset::DoPeriodic,
            Meter::QueueOperations => Dataset::Queues,
        }
    }

    /// The overage price in micro-dollars per million units ([`PRICES_AS_OF`]).
    pub fn micros_per_million(self) -> u64 {
        PRICES[self.index()]
    }

    /// One sandbox's use of this meter, in thousandths ([`PER_SANDBOX_AS_OF`]).
    pub fn per_sandbox_milli(self) -> u64 {
        PER_SANDBOX_MILLI[self.index()]
    }
}

/// The date and source of [`PRICES`]: docs/cost.md's price sheet, the Workers Paid overage
/// rates from Cloudflare's Workers, Durable Objects and Queues pricing pages.
pub const PRICES_AS_OF: &str = "2026-11-04, docs/cost.md \"Price sheet\" \
    (https://developers.cloudflare.com/workers/platform/pricing/, \
    https://developers.cloudflare.com/durable-objects/platform/pricing/, \
    https://developers.cloudflare.com/queues/platform/pricing/)";

/// Micro-dollars per million, in [`Meter::ALL`]'s order: Worker requests $0.30, DO requests
/// $0.15, rows written $1.00, DO duration $12.50 per million GB-s, Queue operations $0.40.
pub const PRICES: [u64; 5] = [300_000, 150_000, 1_000_000, 12_500_000, 400_000];

/// The date and source of [`PER_SANDBOX_MILLI`]: docs/cost.md, "The per-sandbox meter".
pub const PER_SANDBOX_AS_OF: &str = "2026-11-04, docs/cost.md \"The per-sandbox meter\"";

/// One sandbox's session and its share of the wipe, in thousandths, in [`Meter::ALL`]'s order:
/// 150 Worker requests, 155 DO requests, 5,000 rows written (the wipe's included), 2.78 GB-s
/// and 150 Queue operations.
pub const PER_SANDBOX_MILLI: [u64; 5] = [150_000, 155_000, 5_000_000, 2_780, 150_000];

/// One GraphQL Analytics dataset, one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dataset {
    Workers,
    DoInvocations,
    DoPeriodic,
    Queues,
}

impl Dataset {
    /// The four requests, in the order the run sends them.
    pub const ALL: [Dataset; 4] = [
        Dataset::Workers,
        Dataset::DoInvocations,
        Dataset::DoPeriodic,
        Dataset::Queues,
    ];

    /// The dataset's node under `viewer.accounts`, also its name in the log lines.
    pub fn name(self) -> &'static str {
        match self {
            Dataset::Workers => "workersInvocationsAdaptive",
            Dataset::DoInvocations => "durableObjectsInvocationsAdaptiveGroups",
            Dataset::DoPeriodic => "durableObjectsPeriodicGroups",
            Dataset::Queues => "queueMessageOperationsAdaptiveGroups",
        }
    }

    /// The `sum` fields read, each with its meter and how many thousandths one unit is.
    pub fn fields(self) -> &'static [(&'static str, Meter)] {
        match self {
            Dataset::Workers => &[("requests", Meter::WorkerRequests)],
            Dataset::DoInvocations => &[("requests", Meter::DoRequests)],
            // `rowsWritten` and `duration` (GB-s) are the names a third-party introspection
            // dump gives (read 2026-11-06); Cloudflare's own page documents only `cpuTime` here.
            Dataset::DoPeriodic => &[
                ("rowsWritten", Meter::RowsWritten),
                ("duration", Meter::DoGbS),
            ],
            Dataset::Queues => &[("billableOperations", Meter::QueueOperations)],
        }
    }

    pub fn meters(self) -> impl Iterator<Item = Meter> {
        self.fields().iter().map(|(_, m)| *m)
    }
}

/// The slot a run reads: RFC 3339 UTC times to the second, `start` included, `end` not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub start: String,
    pub end: String,
}

/// The latest time RFC 3339 can write, 9999-12-31T23:59:59.999Z.
const MAX_MS: i64 = 253_402_300_799_999;

fn rfc3339_seconds(unix_ms: i64) -> String {
    let text = WallTime::from_unix_ms(unix_ms.clamp(0, MAX_MS))
        .map(|t| t.to_string())
        .unwrap_or_default();
    // `YYYY-MM-DDTHH:MM:SS.mmmZ` to `YYYY-MM-DDTHH:MM:SSZ`; the slot starts on a whole second.
    match text.split_once('.') {
        Some((seconds, _)) => format!("{seconds}Z"),
        None => text,
    }
}

/// The last complete 15-minute slot before `now_ms`: from floor(now, 15 min) − 15 min to
/// floor(now, 15 min). Not the current slot: the analytics lag a few minutes behind.
pub fn window_before(now_ms: i64) -> Window {
    let end = now_ms.clamp(WINDOW_MS, MAX_MS).div_euclid(WINDOW_MS) * WINDOW_MS;
    Window {
        start: rfc3339_seconds(end - WINDOW_MS),
        end: rfc3339_seconds(end),
    }
}

/// The query text for one dataset: the variables declared `string`, as Cloudflare's Workers
/// metrics tutorial does, and the window as `datetime_geq` and `datetime_lt`.
pub fn graphql_query(dataset: Dataset) -> String {
    let fields: Vec<&str> = dataset.fields().iter().map(|(f, _)| *f).collect();
    format!(
        "query Breaker($accountTag: string, $start: string, $end: string) {{ viewer {{ \
         accounts(filter: {{accountTag: $accountTag}}) {{ {node}(limit: {GROUP_LIMIT}, \
         filter: {{datetime_geq: $start, datetime_lt: $end}}) {{ sum {{ {fields} }} }} }} }} }}",
        node = dataset.name(),
        fields = fields.join(" "),
    )
}

/// The JSON body of `POST {base}/graphql` for one dataset over `window`. It holds the account
/// tag, so a caller never logs it.
pub fn graphql_body(dataset: Dataset, account: &str, window: &Window) -> String {
    json!({
        "query": graphql_query(dataset),
        "variables": {
            "accountTag": account,
            "start": window.start,
            "end": window.end,
        },
    })
    .to_string()
}

/// Why an answer gave no reads. A code for the log line, never the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// The API answered something other than 200.
    Status(u16),
    /// The body is not JSON.
    Body,
    /// The body carries GraphQL `errors`: a field the schema lacks, a bad token, a limit.
    GraphQl,
    /// The JSON lacks a node or a field, or holds something that is not a count.
    Shape(&'static str),
}

impl ReadError {
    pub fn code(&self) -> &'static str {
        match self {
            ReadError::Status(_) => "status",
            ReadError::Body => "body",
            ReadError::GraphQl => "graphql",
            ReadError::Shape(_) => "shape",
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            ReadError::Status(s) => Some(*s),
            _ => None,
        }
    }
}

/// One window's reads, in thousandths of each meter's unit; `None` is unread.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reads {
    milli: [Option<u64>; 5],
}

impl Reads {
    pub fn get(&self, meter: Meter) -> Option<u64> {
        self.milli[meter.index()]
    }

    pub fn set(&mut self, meter: Meter, milli: u64) {
        self.milli[meter.index()] = Some(milli);
    }

    /// Takes every meter `other` read.
    pub fn merge(&mut self, other: &Reads) {
        for m in Meter::ALL {
            if let Some(v) = other.get(m) {
                self.set(m, v);
            }
        }
    }

    /// Meters with a read.
    pub fn read_count(&self) -> usize {
        self.milli.iter().filter(|v| v.is_some()).count()
    }

    /// Meters without one, in [`Meter::ALL`]'s order.
    pub fn unread(&self) -> Vec<Meter> {
        Meter::ALL
            .into_iter()
            .filter(|m| self.get(*m).is_none())
            .collect()
    }

    /// `{name: value|null}` for `Control`'s `POST /breaker`, each value in its whole unit: an
    /// integer when it is one (`1875`), a decimal otherwise (`34.75`).
    pub fn to_wire(&self) -> Map<String, Value> {
        Meter::ALL
            .into_iter()
            .map(|m| {
                (
                    m.name().to_owned(),
                    self.get(m).map_or(Value::Null, unit_value),
                )
            })
            .collect()
    }

    /// The reads from [`Reads::to_wire`]'s map. `null`, an unknown name and a value that is not
    /// a count leave the meter unread.
    pub fn from_wire(map: &Map<String, Value>) -> Reads {
        let mut reads = Reads::default();
        for (name, value) in map.iter().filter(|(_, v)| !v.is_null()) {
            if let (Some(m), Ok(Some(v))) = (Meter::parse(name), milli(Some(value))) {
                reads.set(m, v);
            }
        }
        reads
    }
}

fn unit_value(milli: u64) -> Value {
    if milli.is_multiple_of(1_000) {
        Value::from(milli / 1_000)
    } else {
        Value::from(milli as f64 / 1_000.0)
    }
}

/// A count in its unit as thousandths: a number or a number in a string, `null` as 0 (a sum
/// over nothing). `None` for a missing field; `Err` for anything that is not a count.
fn milli(value: Option<&Value>) -> Result<Option<u64>, ()> {
    let n = match value {
        None => return Ok(None),
        Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().ok_or(())?,
        Some(Value::String(s)) => s.trim().parse::<f64>().map_err(|_| ())?,
        Some(_) => return Err(()),
    };
    if !n.is_finite() || n < 0.0 {
        return Err(());
    }
    // An f64 cast saturates at u64::MAX, which is far past any line.
    Ok(Some((n * 1_000.0).round() as u64))
}

/// The status and body of one dataset's request as its meters' reads: 200 and `data` with no
/// `errors`, the `sum` fields added over every group of every account returned (several groups
/// may come back), and no groups read as 0, a quiet account.
pub fn read_sum(status: u16, body: &str, dataset: Dataset) -> Result<Reads, ReadError> {
    if status != 200 {
        return Err(ReadError::Status(status));
    }
    let answer: Value = serde_json::from_str(body).map_err(|_| ReadError::Body)?;
    let errors = answer.get("errors");
    let has_errors = match errors {
        None | Some(Value::Null) => false,
        Some(Value::Array(a)) => !a.is_empty(),
        Some(_) => true,
    };
    if has_errors {
        return Err(ReadError::GraphQl);
    }
    let accounts = answer
        .get("data")
        .and_then(|d| d.get("viewer"))
        .and_then(|v| v.get("accounts"))
        .and_then(Value::as_array)
        .ok_or(ReadError::Shape("accounts"))?;
    // No account at all means the token cannot see this one: not a quiet account.
    if accounts.is_empty() {
        return Err(ReadError::Shape("accounts"));
    }
    let mut totals = [0u64; 2];
    for account in accounts {
        let groups = account
            .get(dataset.name())
            .and_then(Value::as_array)
            .ok_or(ReadError::Shape("groups"))?;
        for group in groups {
            let sum = group.get("sum").ok_or(ReadError::Shape("sum"))?;
            for (i, (field, _)) in dataset.fields().iter().enumerate() {
                let v = milli(sum.get(*field))
                    .map_err(|()| ReadError::Shape("field"))?
                    .ok_or(ReadError::Shape("field"))?;
                totals[i] = totals[i].saturating_add(v);
            }
        }
    }
    let mut reads = Reads::default();
    for (i, (_, meter)) in dataset.fields().iter().enumerate() {
        reads.set(*meter, totals[i]);
    }
    Ok(reads)
}

/// The window's price in micro-dollars, unread meters as 0, rounded up so that any priced
/// usage at all is at least one micro-dollar.
pub fn price_micros(reads: &Reads) -> u64 {
    let numerator: u128 = Meter::ALL
        .into_iter()
        .map(|m| u128::from(reads.get(m).unwrap_or(0)) * u128::from(m.micros_per_million()))
        .sum();
    // thousandths × micro-dollars per million units ÷ (1,000 × 1,000,000).
    let micros = numerator.div_ceil(1_000_000_000);
    u64::try_from(micros).unwrap_or(u64::MAX)
}

/// Micro-dollars as dollars with four decimals, rounded half up: 34,722 is `"0.0347"`.
pub fn usd_text(micros: u64) -> String {
    let ten_thousandths = micros / 100 + u64::from(micros % 100 >= 50);
    format!(
        "{}.{:04}",
        ten_thousandths / 10_000,
        ten_thousandths % 10_000
    )
}

/// Dollars as text (`"100"`, `"0.5"`, up to six decimals) as micro-dollars; `None` for
/// anything else, a sign or an exponent included.
pub fn parse_usd(text: &str) -> Option<u64> {
    let t = text.trim();
    let (whole, frac) = match t.split_once('.') {
        Some((w, f)) if !f.is_empty() => (w, f),
        Some(_) => return None,
        None => (t, ""),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(frac) || frac.len() > 6 || whole.len() > 9 {
        return None;
    }
    let whole: u64 = whole.parse().ok()?;
    let frac: u64 = format!("{frac:0<6}").parse().ok()?;
    Some(whole * 1_000_000 + frac)
}

/// What a window is held to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lines {
    /// Each meter's line in thousandths: factor × (cap × per-sandbox meter) ÷ 96.
    meters: [u64; 5],
    /// The dollar line: the ceiling ÷ 2,880 windows, the rate that spends it in a month.
    pub dollar_micros: u64,
    /// The `off` line: the factor × the ceiling ÷ 2,880.
    pub off_micros: u64,
}

impl Lines {
    /// `cap` is `Control`'s `SANDBOX_CAP`, `ceiling_micros` the account's monthly ceiling and
    /// `factor` the burst factor. A ceiling or factor of 0 makes a line 0, so any usage trips.
    pub fn new(cap: u32, ceiling_micros: u64, factor: u32) -> Lines {
        let share = |m: Meter| {
            let n = u128::from(factor) * u128::from(cap) * u128::from(m.per_sandbox_milli());
            u64::try_from(n / u128::from(WINDOWS_PER_DAY)).unwrap_or(u64::MAX)
        };
        let off = u128::from(factor) * u128::from(ceiling_micros) / u128::from(WINDOWS_PER_MONTH);
        Lines {
            meters: Meter::ALL.map(share),
            dollar_micros: ceiling_micros / WINDOWS_PER_MONTH,
            off_micros: u64::try_from(off).unwrap_or(u64::MAX),
        }
    }

    /// A meter's line, in thousandths.
    pub fn meter(&self, meter: Meter) -> u64 {
        self.meters[meter.index()]
    }
}

/// One run's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// The state after this run: never below `previous`, and never `unconfigured`.
    pub state: BreakerState,
    pub previous: BreakerState,
    /// The window's price, unread meters as 0.
    pub usd_micros: u64,
    /// The read meters over their lines.
    pub over: Vec<Meter>,
    /// The meters with no read, counted as 0.
    pub unread: Vec<Meter>,
}

impl Verdict {
    /// The run raised the state to `read-only` or `off`.
    pub fn tripped(&self) -> bool {
        self.state > self.previous.max(BreakerState::Armed)
    }
}

/// The breaker's rule. `off` when the window is priced over the `off` line, or when the state
/// is already tripped and the window is still over any line (read-only did not stop it: an
/// internal loop or a flood); else `read-only` when any read meter is over its line or the
/// price over the dollar line; else `armed`. The result is never below `previous`: a state
/// goes `armed` → `read-only` → `off` only, and a person resets it.
pub fn decide(previous: BreakerState, reads: &Reads, lines: &Lines) -> Verdict {
    let usd_micros = price_micros(reads);
    let over: Vec<Meter> = Meter::ALL
        .into_iter()
        .filter(|m| reads.get(*m).is_some_and(|v| v > lines.meter(*m)))
        .collect();
    let over_any = !over.is_empty() || usd_micros > lines.dollar_micros;
    let tripped = previous >= BreakerState::ReadOnly;
    let wanted = if usd_micros > lines.off_micros || (tripped && over_any) {
        BreakerState::Off
    } else if over_any {
        BreakerState::ReadOnly
    } else {
        BreakerState::Armed
    };
    Verdict {
        state: wanted.max(previous).max(BreakerState::Armed),
        previous,
        usd_micros,
        over,
        unread: reads.unread(),
    }
}

/// The level in the `breaker` point: 1 for `read-only`, 2 for `off`, 0 otherwise.
pub fn level(state: BreakerState) -> u8 {
    match state {
        BreakerState::ReadOnly => 1,
        BreakerState::Off => 2,
        BreakerState::Unconfigured | BreakerState::Armed => 0,
    }
}

/// The flag a trip to `state` raises `current` to, or `None` when it is already as high:
/// `read-only` raises `live` only, `off` raises anything. A trip never lowers the flag.
pub fn raised_flag(current: Flag, state: BreakerState) -> Option<Flag> {
    match (state, current) {
        (BreakerState::ReadOnly, Flag::Live) => Some(Flag::ReadOnly),
        (BreakerState::Off, Flag::Live | Flag::ReadOnly) => Some(Flag::Off),
        _ => None,
    }
}

/// The body of the rule's PATCH: its `action`, `expression` and `description` as the entry
/// point ruleset holds them (the Rulesets API keeps only the fields sent), and
/// `enabled: true`. A field the rule lacks is not sent.
pub fn rule_patch_body(rule: &Value) -> Value {
    let mut body = Map::new();
    for field in ["action", "expression", "description"] {
        if let Some(v) = rule.get(field).filter(|v| !v.is_null()) {
            body.insert(field.to_owned(), v.clone());
        }
    }
    body.insert("enabled".to_owned(), Value::Bool(true));
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines() -> Lines {
        Lines::new(300, DEFAULT_CEILING_MICROS, DEFAULT_BURST_FACTOR)
    }

    fn reads(values: &[(Meter, u64)]) -> Reads {
        let mut r = Reads::default();
        for (m, units) in values {
            r.set(*m, units * 1_000);
        }
        r
    }

    fn all_read(values: &[(Meter, u64)]) -> Reads {
        let mut r = reads(&Meter::ALL.map(|m| (m, 0)));
        r.merge(&reads(values));
        r
    }

    #[test]
    fn the_meters_and_datasets_have_their_names() {
        let names: Vec<&str> = Meter::ALL.iter().map(|m| m.name()).collect();
        assert_eq!(
            names,
            [
                "worker_requests",
                "do_requests",
                "rows_written",
                "do_gb_s",
                "queue_operations"
            ]
        );
        for m in Meter::ALL {
            assert_eq!(Meter::parse(m.name()), Some(m));
            assert!(m.dataset().meters().any(|x| x == m), "{m:?}");
        }
        assert_eq!(Meter::parse("cpu_ms"), None);
        let datasets: Vec<&str> = Dataset::ALL.iter().map(|d| d.name()).collect();
        assert_eq!(
            datasets,
            [
                "workersInvocationsAdaptive",
                "durableObjectsInvocationsAdaptiveGroups",
                "durableObjectsPeriodicGroups",
                "queueMessageOperationsAdaptiveGroups"
            ]
        );
        assert_eq!(
            Dataset::DoPeriodic.meters().collect::<Vec<_>>(),
            [Meter::RowsWritten, Meter::DoGbS]
        );
    }

    #[test]
    fn the_lines_at_cap_300_and_factor_4_are_the_designs() {
        let l = lines();
        assert_eq!(l.meter(Meter::WorkerRequests), 1_875_000);
        assert_eq!(l.meter(Meter::DoRequests), 1_937_500);
        assert_eq!(l.meter(Meter::RowsWritten), 62_500_000);
        assert_eq!(l.meter(Meter::DoGbS), 34_750);
        assert_eq!(l.meter(Meter::QueueOperations), 1_875_000);
        assert_eq!(l.dollar_micros, 34_722);
        assert_eq!(usd_text(l.dollar_micros), "0.0347");
        assert_eq!(l.off_micros, 138_888);
        assert_eq!(usd_text(l.off_micros), "0.1389");
    }

    #[test]
    fn prices_are_exact_micro_dollars() {
        assert_eq!(price_micros(&Reads::default()), 0);
        assert_eq!(
            price_micros(&reads(&[(Meter::WorkerRequests, 1_000_000)])),
            300_000
        );
        assert_eq!(
            price_micros(&reads(&[
                (Meter::DoRequests, 1_000_000),
                (Meter::RowsWritten, 1_000_000),
                (Meter::QueueOperations, 1_000_000)
            ])),
            1_550_000
        );
        let mut gb_s = Reads::default();
        gb_s.set(Meter::DoGbS, 34_750);
        // 34.75 GB-s × $12.50 per million is 434.375 micro-dollars, rounded up.
        assert_eq!(price_micros(&gb_s), 435);
        // One request is 0.3 micro-dollars: any usage prices at least one.
        assert_eq!(price_micros(&reads(&[(Meter::WorkerRequests, 1)])), 1);
        assert_eq!(usd_text(0), "0.0000");
        assert_eq!(usd_text(12_349), "0.0123");
        assert_eq!(usd_text(12_350), "0.0124");
        assert_eq!(usd_text(4_320_000), "4.3200");
        assert_eq!(usd_text(1_000_000_000), "1000.0000");
    }

    #[test]
    fn dollars_parse_as_micro_dollars() {
        assert_eq!(parse_usd("100"), Some(100_000_000));
        assert_eq!(parse_usd(" 0 "), Some(0));
        assert_eq!(parse_usd("0.5"), Some(500_000));
        assert_eq!(parse_usd("12.5"), Some(12_500_000));
        assert_eq!(parse_usd("0.000001"), Some(1));
        for bad in [
            "",
            ".5",
            "-1",
            "1e3",
            "1.0000001",
            "ten",
            "1.",
            "1,000",
            "+1",
        ] {
            assert_eq!(parse_usd(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_window_is_the_slot_before_the_run() {
        // 2026-11-06T17:08:42.500Z.
        let now = 1_793_984_400_000 + 8 * 60_000 + 42_500;
        assert_eq!(rfc3339_seconds(1_793_984_400_000), "2026-11-06T17:00:00Z");
        assert_eq!(
            window_before(now),
            Window {
                start: "2026-11-06T16:45:00Z".into(),
                end: "2026-11-06T17:00:00Z".into(),
            }
        );
        // A run on the boundary reads the slot that just ended.
        assert_eq!(window_before(1_793_984_400_000), window_before(now));
        assert_eq!(
            window_before(1_793_984_400_000 - 1).end,
            "2026-11-06T16:45:00Z"
        );
    }

    #[test]
    fn each_request_declares_its_variables_as_strings_and_reads_its_sums() {
        let w = window_before(1_793_984_400_000);
        assert_eq!(
            graphql_query(Dataset::Workers),
            "query Breaker($accountTag: string, $start: string, $end: string) { viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } } } } }"
        );
        assert!(
            graphql_query(Dataset::DoPeriodic)
                .contains("durableObjectsPeriodicGroups(limit: 1000, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { rowsWritten duration } }")
        );
        for d in Dataset::ALL {
            let body: Value = serde_json::from_str(&graphql_body(d, "acct0fake", &w)).unwrap();
            let q = body["query"].as_str().unwrap();
            assert!(q.contains(d.name()), "{d:?}");
            assert!(!q.contains("  "), "{d:?}: one space between words");
            for (field, _) in d.fields() {
                assert!(q.contains(field), "{d:?} {field}");
            }
            assert_eq!(
                body["variables"],
                json!({"accountTag": "acct0fake", "start": "2026-11-06T16:45:00Z", "end": "2026-11-06T17:00:00Z"})
            );
        }
    }

    fn answer(dataset: Dataset, groups: Value) -> String {
        let mut account = Map::new();
        account.insert(dataset.name().to_owned(), groups);
        json!({"data": {"viewer": {"accounts": [account]}}, "errors": null}).to_string()
    }

    #[test]
    fn sums_add_over_groups_and_an_empty_answer_reads_zero() {
        let r = read_sum(
            200,
            &answer(
                Dataset::Workers,
                json!([{"sum": {"requests": 1200}}, {"sum": {"requests": "34"}}]),
            ),
            Dataset::Workers,
        )
        .unwrap();
        assert_eq!(r.get(Meter::WorkerRequests), Some(1_234_000));
        assert_eq!(r.read_count(), 1);
        let p = read_sum(
            200,
            &answer(
                Dataset::DoPeriodic,
                json!([{"sum": {"rowsWritten": 10, "duration": 1.25}}, {"sum": {"rowsWritten": 5, "duration": 0.005}}]),
            ),
            Dataset::DoPeriodic,
        )
        .unwrap();
        assert_eq!(p.get(Meter::RowsWritten), Some(15_000));
        assert_eq!(p.get(Meter::DoGbS), Some(1_255));
        let empty = read_sum(200, &answer(Dataset::Queues, json!([])), Dataset::Queues).unwrap();
        assert_eq!(empty.get(Meter::QueueOperations), Some(0));
        assert_eq!(empty.unread().len(), 4);
        let null = read_sum(
            200,
            &answer(
                Dataset::Queues,
                json!([{"sum": {"billableOperations": null}}]),
            ),
            Dataset::Queues,
        )
        .unwrap();
        assert_eq!(null.get(Meter::QueueOperations), Some(0));
    }

    #[test]
    fn a_graphql_error_or_a_strange_answer_is_a_code() {
        let errors = r#"{"data":null,"errors":[{"message":"unknown field","path":["viewer"]}]}"#;
        assert_eq!(
            read_sum(200, errors, Dataset::DoPeriodic),
            Err(ReadError::GraphQl)
        );
        assert_eq!(ReadError::GraphQl.code(), "graphql");
        let partial = json!({"data": {"viewer": {"accounts": []}}, "errors": [{"message": "x"}]});
        assert_eq!(
            read_sum(200, &partial.to_string(), Dataset::Workers),
            Err(ReadError::GraphQl)
        );
        assert_eq!(
            read_sum(401, "{}", Dataset::Workers),
            Err(ReadError::Status(401))
        );
        assert_eq!(ReadError::Status(401).status(), Some(401));
        assert_eq!(
            read_sum(200, "not json", Dataset::Workers),
            Err(ReadError::Body)
        );
        for (bad, code) in [
            (json!({"data": null}), "accounts"),
            (json!({"data": {"viewer": {"accounts": []}}}), "accounts"),
            (json!({"data": {"viewer": {"accounts": [{}]}}}), "groups"),
            (
                json!({"data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{}]}]}}}),
                "sum",
            ),
            (
                json!({"data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{"sum": {}}]}]}}}),
                "field",
            ),
            (
                json!({"data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{"sum": {"requests": -1}}]}]}}}),
                "field",
            ),
            (
                json!({"data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{"sum": {"requests": "many"}}]}]}}}),
                "field",
            ),
        ] {
            assert_eq!(
                read_sum(200, &bad.to_string(), Dataset::Workers),
                Err(ReadError::Shape(code)),
                "{bad}"
            );
        }
    }

    #[test]
    fn reads_cross_the_wire_in_whole_units() {
        let mut r = reads(&[(Meter::WorkerRequests, 1_875), (Meter::RowsWritten, 0)]);
        r.set(Meter::DoGbS, 34_750);
        let wire = r.to_wire();
        assert_eq!(
            Value::Object(wire.clone()),
            json!({"worker_requests": 1875, "do_requests": null, "rows_written": 0, "do_gb_s": 34.75, "queue_operations": null})
        );
        assert_eq!(Reads::from_wire(&wire), r);
        let mut odd = wire;
        odd.insert("cpu_ms".into(), json!(5));
        odd.insert("do_requests".into(), json!("lots"));
        assert_eq!(Reads::from_wire(&odd), r);
    }

    #[test]
    fn a_quiet_window_stays_armed() {
        let v = decide(
            BreakerState::Unconfigured,
            &all_read(&[(Meter::WorkerRequests, 120), (Meter::DoRequests, 400)]),
            &lines(),
        );
        assert_eq!(v.state, BreakerState::Armed);
        assert!(!v.tripped());
        assert!(v.over.is_empty() && v.unread.is_empty());
        assert_eq!(v.usd_micros, 96);
    }

    #[test]
    fn a_meter_over_its_line_under_the_off_line_trips_read_only() {
        // 100,000 rows: over the 62,500 line, $0.10, between the dollar and the off line.
        let v = decide(
            BreakerState::Armed,
            &all_read(&[(Meter::RowsWritten, 100_000)]),
            &lines(),
        );
        assert_eq!(v.state, BreakerState::ReadOnly);
        assert!(v.tripped());
        assert_eq!(v.over, [Meter::RowsWritten]);
        assert_eq!(usd_text(v.usd_micros), "0.1000");
        // A meter just over its line, priced under the dollar line, trips it too.
        let v = decide(
            BreakerState::Armed,
            &all_read(&[(Meter::WorkerRequests, 1_876)]),
            &lines(),
        );
        assert_eq!(
            (v.state, v.over.clone()),
            (BreakerState::ReadOnly, vec![Meter::WorkerRequests])
        );
        // At the line exactly is not over it.
        let v = decide(
            BreakerState::Armed,
            &all_read(&[(Meter::WorkerRequests, 1_875)]),
            &lines(),
        );
        assert_eq!(v.state, BreakerState::Armed);
    }

    #[test]
    fn a_loop_window_trips() {
        // Scenario D's alarm loop, 4.32M rows: far over the row line, and priced at $4.32, over
        // the off line ($0.1389) too, so the one window goes straight past read-only to off.
        let v = decide(
            BreakerState::Armed,
            &all_read(&[(Meter::RowsWritten, 4_320_000)]),
            &lines(),
        );
        assert_eq!(v.over, [Meter::RowsWritten]);
        assert_eq!(usd_text(v.usd_micros), "4.3200");
        assert_eq!(v.state, BreakerState::Off);
        assert!(v.tripped());
    }

    #[test]
    fn a_flood_past_four_times_the_dollar_line_trips_off() {
        // 500,000 Worker requests: $0.15, over $0.1389.
        let v = decide(
            BreakerState::Armed,
            &all_read(&[(Meter::WorkerRequests, 500_000)]),
            &lines(),
        );
        assert_eq!(v.state, BreakerState::Off);
        assert_eq!(usd_text(v.usd_micros), "0.1500");
        // At the off line exactly it is read-only (over the dollar line and the meter's).
        let mut at = all_read(&[]);
        at.set(Meter::WorkerRequests, 462_960_000);
        assert_eq!(price_micros(&at), 138_888);
        assert_eq!(
            decide(BreakerState::Armed, &at, &lines()).state,
            BreakerState::ReadOnly
        );
    }

    #[test]
    fn a_second_over_line_window_after_read_only_trips_off() {
        let over = all_read(&[(Meter::QueueOperations, 2_000)]);
        let v = decide(BreakerState::ReadOnly, &over, &lines());
        assert_eq!(v.state, BreakerState::Off);
        assert!(v.tripped());
        let quiet = all_read(&[(Meter::QueueOperations, 10)]);
        let v = decide(BreakerState::ReadOnly, &quiet, &lines());
        assert_eq!(v.state, BreakerState::ReadOnly);
        assert!(!v.tripped());
    }

    #[test]
    fn unread_meters_count_zero_and_are_listed() {
        let mut r = Reads::default();
        r.set(Meter::WorkerRequests, 100_000);
        let v = decide(BreakerState::Armed, &r, &lines());
        assert_eq!(v.state, BreakerState::Armed);
        assert_eq!(
            v.unread,
            [
                Meter::DoRequests,
                Meter::RowsWritten,
                Meter::DoGbS,
                Meter::QueueOperations
            ]
        );
        assert_eq!(v.usd_micros, 30);
        let v = decide(BreakerState::Armed, &Reads::default(), &lines());
        assert_eq!(
            (v.state, v.unread.len(), v.usd_micros),
            (BreakerState::Armed, 5, 0)
        );
    }

    #[test]
    fn a_tripped_state_never_relaxes() {
        let quiet = all_read(&[]);
        for previous in [BreakerState::ReadOnly, BreakerState::Off] {
            let v = decide(previous, &quiet, &lines());
            assert_eq!(v.state, previous);
            assert!(!v.tripped());
        }
        let over = all_read(&[(Meter::RowsWritten, 100_000)]);
        assert_eq!(
            decide(BreakerState::Off, &over, &lines()).state,
            BreakerState::Off
        );
        assert!(!decide(BreakerState::Off, &over, &lines()).tripped());
    }

    #[test]
    fn a_zero_ceiling_or_factor_trips_on_any_usage() {
        let one = all_read(&[(Meter::WorkerRequests, 1)]);
        let zero_ceiling = Lines::new(300, 0, DEFAULT_BURST_FACTOR);
        assert_eq!(
            (zero_ceiling.dollar_micros, zero_ceiling.off_micros),
            (0, 0)
        );
        assert_eq!(
            decide(BreakerState::Armed, &one, &zero_ceiling).state,
            BreakerState::Off
        );
        let zero_factor = Lines::new(300, DEFAULT_CEILING_MICROS, 0);
        assert_eq!(zero_factor.meter(Meter::WorkerRequests), 0);
        assert_eq!(
            decide(BreakerState::Armed, &one, &zero_factor).state,
            BreakerState::Off
        );
        // No usage at all trips nothing, even at zero.
        assert_eq!(
            decide(BreakerState::Armed, &all_read(&[]), &zero_ceiling).state,
            BreakerState::Armed
        );
    }

    #[test]
    fn a_trip_raises_the_flag_and_never_lowers_it() {
        use BreakerState::{Armed, Off, ReadOnly, Unconfigured};
        assert_eq!(raised_flag(Flag::Live, ReadOnly), Some(Flag::ReadOnly));
        assert_eq!(raised_flag(Flag::ReadOnly, ReadOnly), None);
        assert_eq!(raised_flag(Flag::Off, ReadOnly), None);
        assert_eq!(raised_flag(Flag::Live, Off), Some(Flag::Off));
        assert_eq!(raised_flag(Flag::ReadOnly, Off), Some(Flag::Off));
        assert_eq!(raised_flag(Flag::Off, Off), None);
        for flag in [Flag::Live, Flag::ReadOnly, Flag::Off] {
            assert_eq!(raised_flag(flag, Armed), None);
            assert_eq!(raised_flag(flag, Unconfigured), None);
        }
    }

    #[test]
    fn the_level_and_the_rule_patch() {
        assert_eq!(
            [
                BreakerState::Armed,
                BreakerState::ReadOnly,
                BreakerState::Off
            ]
            .map(level),
            [0, 1, 2]
        );
        let rule = json!({
            "id": "rule0fake",
            "version": "3",
            "action": "block",
            "expression": "(http.host eq \"api.bakery.ihaveasegway.com\")",
            "description": "Kill switch L3",
            "enabled": false,
            "last_updated": "2026-11-06T16:00:00Z"
        });
        assert_eq!(
            rule_patch_body(&rule),
            json!({
                "action": "block",
                "expression": "(http.host eq \"api.bakery.ihaveasegway.com\")",
                "description": "Kill switch L3",
                "enabled": true
            })
        );
        assert_eq!(
            rule_patch_body(&json!({"action": "block", "description": null})),
            json!({"action": "block", "enabled": true})
        );
    }
}
