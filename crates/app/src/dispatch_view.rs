//! The dispatch screen's wire shapes from the Dispatch aggregate (ADR 0012, decision 5), and
//! the browser's plan into the aggregate's command. Pure: the Worker's `Dispatch` object calls
//! these with its folded state and the matrix it loaded.

use bakery_contracts as wire;
use bakery_domain::Ulid;
use bakery_domain::dispatch::{
    DispatchState, Plan, PlanChoice, PlanSource, StopStatus, SubmittedRoute, TravelMatrix, compare,
    place_label,
};

/// `GET /v1/sandboxes/{id}/dispatch/{date}`: the day as the screen reads it.
pub fn dispatch_response(state: &DispatchState, matrix: &TravelMatrix) -> wire::DispatchResponse {
    let published = state.published();
    let view = |plan: Option<&Plan>| plan.map(|p| plan_view(p, state, matrix));
    wire::DispatchResponse {
        date: state.date().to_string(),
        vans: state.vans(),
        capacity: state.capacity(),
        stops: state
            .stops()
            .map(|s| wire::StopView {
                order: s.order.to_string(),
                customer: s.customer.to_string(),
                place: s.place,
                place_label: matrix
                    .label(s.place)
                    .map_or_else(|| place_label(s.place), str::to_owned),
                window: s.window.to_string(),
                zone: s.zone.clone(),
                units: s.units,
                status: stop_status(s.status),
                stop: published.and_then(|p| p.stop_number(s.order)),
                van: published.and_then(|p| {
                    p.routes
                        .iter()
                        .find(|r| r.stops.contains(&s.order))
                        .map(|r| r.van)
                }),
            })
            .collect(),
        proposed: view(state.proposed()),
        submitted: view(state.submitted()),
        published: view(published),
        plan_v: state.plan_v(),
        comparison: compare(state).map(|c| wire::ComparisonView {
            server_minutes: c.server_minutes,
            browser_minutes: c.browser_minutes,
            gap_percent: c.gap_tenths_percent.map(|t| t as f64 / 10.0),
        }),
    }
}

fn plan_view(plan: &Plan, state: &DispatchState, matrix: &TravelMatrix) -> wire::PlanView {
    let summary = plan.summary(state, matrix);
    let ids = |v: &[Ulid]| v.iter().map(Ulid::to_string).collect();
    wire::PlanView {
        source: match summary.source {
            PlanSource::Server => wire::PlanSource::Server,
            PlanSource::Browser => wire::PlanSource::Browser,
        },
        plan_v: summary.plan_v,
        vans: summary
            .vans
            .iter()
            .map(|v| wire::VanPlanView {
                van: v.van,
                stops: ids(&v.stops),
                units: v.units,
                minutes: v.minutes,
            })
            .collect(),
        minutes: summary.minutes,
        last_back: summary.last_back.to_string(),
        unassigned: ids(&summary.unassigned),
    }
}

fn stop_status(status: StopStatus) -> wire::StopStatus {
    match status {
        StopStatus::Provisional => wire::StopStatus::Provisional,
        StopStatus::Confirmed => wire::StopStatus::Confirmed,
        StopStatus::Removed => wire::StopStatus::Removed,
        StopStatus::Completed => wire::StopStatus::Completed,
    }
}

/// A stop in the browser's plan that is not a ULID: a 422 before the aggregate is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotAnOrder(pub String);

/// The browser's plan as the aggregate's `SubmitPlan` routes.
pub fn submitted_routes(request: &wire::PlanRequest) -> Result<Vec<SubmittedRoute>, NotAnOrder> {
    request
        .vans
        .iter()
        .map(|r| {
            Ok(SubmittedRoute {
                van: r.van,
                stops: r
                    .stops
                    .iter()
                    .map(|s| s.parse().map_err(|_| NotAnOrder(s.clone())))
                    .collect::<Result<_, _>>()?,
                start: r.start,
                end: r.end,
            })
        })
        .collect()
}

/// The publish request's choice as the aggregate's.
pub fn plan_choice(request: &wire::PublishRequest) -> PlanChoice {
    match request.plan {
        wire::PlanChoice::Proposed => PlanChoice::Proposed,
        wire::PlanChoice::Submitted => PlanChoice::Submitted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::dispatch::{AddStop, Dispatch, DispatchCommand};
    use bakery_domain::{BakeryDate, DecideContext, execute};
    use serde_json::json;
    use std::sync::Arc;

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_793_000_000_000, n)
    }

    fn run(state: DispatchState, cmd: DispatchCommand, id: u128) -> DispatchState {
        let ctx = DecideContext {
            now: "2026-11-07T08:00:00-07:00".parse().unwrap(),
            id: ulid(9_000 + id),
        };
        execute::<Dispatch>(state, &cmd, &ctx).unwrap().0
    }

    #[test]
    fn the_day_reads_as_the_screen_shows_it() {
        let date: BakeryDate = "2026-11-07".parse().unwrap();
        let matrix = Arc::new(TravelMatrix::synthetic(42, 64));
        let mut s = DispatchState::new(date);
        for (order, place) in [(1, 16), (2, 40), (3, 5)] {
            s = run(
                s,
                DispatchCommand::AddStop(AddStop {
                    order: ulid(order),
                    customer: ulid(100 + order),
                    place,
                    window: date.at_local(11 * 60),
                    zone: "z2".into(),
                    units: 4,
                }),
                0,
            );
        }
        for order in [1, 2] {
            s = run(s, DispatchCommand::ConfirmStop { order: ulid(order) }, 0);
        }
        s = run(
            s,
            DispatchCommand::Propose {
                vans: 2,
                capacity: 250,
                matrix: matrix.clone(),
            },
            1,
        );
        let request: wire::PlanRequest = serde_json::from_value(json!({
            "vans": [{ "van": 2, "stops": [ulid(2).to_string()] },
                     { "van": 1, "stops": [ulid(1).to_string()], "start": 0, "end": 0 }]
        }))
        .unwrap();
        let routes = submitted_routes(&request).unwrap();
        s = run(
            s,
            DispatchCommand::SubmitPlan {
                routes,
                matrix: matrix.clone(),
            },
            2,
        );
        let publish = wire::PublishRequest {
            plan: wire::PlanChoice::Submitted,
        };
        s = run(
            s,
            DispatchCommand::Publish {
                plan: plan_choice(&publish),
                departed: false,
                matrix: matrix.clone(),
            },
            3,
        );
        let r = dispatch_response(&s, &matrix);
        assert_eq!(
            (r.date.as_str(), r.vans, r.capacity, r.plan_v),
            ("2026-11-07", 2, 250, 1)
        );
        assert_eq!(r.stops.len(), 3);
        let first = &r.stops[0];
        assert_eq!(
            (first.place_label.as_str(), first.stop, first.van),
            ("p17", Some(1), Some(1))
        );
        assert_eq!(r.stops[2].status, wire::StopStatus::Provisional);
        assert_eq!((r.stops[2].stop, r.stops[2].van), (None, None));
        let published = r.published.as_ref().unwrap();
        assert_eq!(published.source, wire::PlanSource::Browser);
        assert_eq!(published.vans.len(), 2);
        // Back last: each van drives to its one stop, waits for the 11:00 window to open,
        // spends 3 minutes at the door and drives back; the longest day ends last.
        assert!(published.vans.iter().all(|v| v.stops.len() == 1));
        let place = |o: &str| r.stops.iter().find(|s| s.order == o).unwrap().place;
        let longest = published
            .vans
            .iter()
            .map(|v| {
                let p = place(&v.stops[0]);
                let out = matrix.minutes(0, p).unwrap();
                out.max(120) + 3 + matrix.minutes(p, 0).unwrap()
            })
            .max()
            .unwrap();
        assert_eq!(
            published.last_back,
            date.at_local(9 * 60 + longest as u16).to_string()
        );
        let c = r.comparison.unwrap();
        assert_eq!(c.browser_minutes, published.minutes);
        assert!(c.gap_percent.is_some());
        // The response is the contract's, field for field.
        let text = serde_json::to_value(&r).unwrap();
        let back: wire::DispatchResponse = serde_json::from_value(text).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn a_stop_that_is_not_a_ulid_is_refused_before_the_aggregate() {
        let request = wire::PlanRequest {
            vans: vec![wire::PlanRouteRequest {
                van: 1,
                stops: vec!["p17".into()],
                start: None,
                end: None,
            }],
        };
        assert_eq!(submitted_routes(&request), Err(NotAnOrder("p17".into())));
    }

    #[test]
    fn the_matrix_fixture_and_the_wire_shape_are_one() {
        let matrix = TravelMatrix::synthetic(42, 64);
        let text = matrix.to_json();
        let wire: wire::MatrixResponse = serde_json::from_str(&text).unwrap();
        assert_eq!(wire.places.len(), 64);
        assert_eq!(wire.places[63].label, "p64");
        let mut again = serde_json::to_string(&wire).unwrap();
        again.push('\n');
        assert_eq!(again, text);
        assert_eq!(TravelMatrix::from_json(&again).unwrap(), matrix);
    }
}
