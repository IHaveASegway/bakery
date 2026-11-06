//! The `METRICS` binding: one Analytics Engine data point per event (docs/operations.md,
//! "Observability"). `bakery_app::analytics` says what a point holds; this file writes it.
//!
//! Fire and forget: a write is synchronous and returns nothing the caller waits on, and a
//! missing binding or a refused write is logged with a reason code and never fails the request,
//! the alarm or the batch that wrote it. A point holds the event's name and numbers only.

use std::cell::Cell;

use bakery_app::analytics::Point;
use worker::{AnalyticsEngineDataPointBuilder, Env, console_log};

pub const BINDING: &str = "METRICS";

thread_local! {
    /// Set once this isolate has logged a missing binding, so the log says it once.
    static UNBOUND_LOGGED: Cell<bool> = const { Cell::new(false) };
}

/// Writes `point` to the dataset, or logs why it could not.
pub fn write(env: &Env, point: &Point) {
    let event = point.event.name();
    let dataset = match env.analytics_engine(BINDING) {
        Ok(d) => d,
        Err(_) => {
            if !UNBOUND_LOGGED.replace(true) {
                console_log!("{{\"event\":\"metrics_unbound\",\"point\":\"{event}\"}}");
            }
            return;
        }
    };
    let built = AnalyticsEngineDataPointBuilder::new()
        .indexes(point.indexes())
        .blobs(point.blobs())
        .doubles(point.doubles.iter().copied())
        .build();
    if dataset.write_data_point(&built).is_err() {
        console_log!("{{\"event\":\"metrics_error\",\"point\":\"{event}\",\"reason\":\"write\"}}");
    }
}
