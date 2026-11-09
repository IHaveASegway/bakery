//! Writes one sandbox's busy Saturday as a dispatch problem, with the server's plan for it, as
//! JSON on stdout. `scripts/dispatch-gap.mjs` solves the same problem with VROOM and prints the
//! gap that ADR 0012's Revisit trigger is about.
//!
//! Usage: `cargo run -q --locked -p bakery-seed --example dispatch-problem -- <seed> <YYYY-MM-DD>`,
//! the seed a decimal `u64` and the sandbox's birth business date.
//!
//! The output holds ids, units, minutes and seconds only, never a place. Node 0 is the bakery and
//! node `k` is the `k`-th stop in order-id order. `minutes` is the Worker's matrix
//! (`crates/seed/data/salt-lake-city/matrix.json`) cut to those nodes, so two stops at one place
//! have equal rows. The server's plan is the savings heuristic's proposal, checked again by the
//! validator the Worker runs on a browser's plan, windows included.

use std::process::ExitCode;

use bakery_domain::calendar::WINDOW_MINUTES;
use bakery_domain::dispatch::{DEPARTURE_MINUTES, Door, SERVICE_MINUTES, SubmittedRoute};
use bakery_seed::{BirthDate, Generator, Seed, busy_saturday, seed_matrix};
use serde_json::{Value, json};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let seed = args.next().and_then(|a| a.parse::<u64>().ok());
    let born = args.next().and_then(|a| BirthDate::parse(&a).ok());
    match (seed, born, args.next()) {
        (Some(seed), Some(born), None) => {
            println!("{}", problem(seed, born));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: dispatch-problem <seed, a decimal u64> <birth date, YYYY-MM-DD>");
            ExitCode::from(2)
        }
    }
}

fn problem(seed: u64, born: BirthDate) -> Value {
    let g = Generator::new(Seed(seed), born).generate();
    let day = busy_saturday(&g);
    let matrix = seed_matrix(&g);
    let state = &day.state;
    let plan = state
        .proposed()
        .expect("the busy Saturday always has the server's proposal");

    // Order-id order, as the heuristic and the browser's problem both number the stops.
    let mut stops = state.plannable();
    stops.sort_by_key(|s| s.order);
    let depot = matrix.depot();
    let places: Vec<u8> = std::iter::once(depot)
        .chain(stops.iter().map(|s| s.place))
        .collect();
    let minutes: Vec<Vec<u32>> = places
        .iter()
        .map(|&a| {
            places
                .iter()
                .map(|&b| matrix.minutes(a, b).expect("every stop is on the matrix"))
                .collect()
        })
        .collect();
    let stop_json: Vec<Value> = stops
        .iter()
        .enumerate()
        .map(|(k, s)| {
            let door = Door::of(s);
            json!({
                "node": k + 1,
                "order": s.order.to_string(),
                "units": s.units,
                "window": s.window.to_string(),
                "open_s": door.open * 60,
                "close_s": door.close * 60,
            })
        })
        .collect();

    let submitted: Vec<SubmittedRoute> = plan
        .routes
        .iter()
        .map(|r| SubmittedRoute {
            van: r.van,
            stops: r.stops.clone(),
            start: None,
            end: None,
        })
        .collect();
    let validator = match state.validate_submission(&submitted, &matrix) {
        Ok((_, minutes)) => json!({ "ok": true, "minutes": minutes }),
        Err(e) => json!({ "ok": false, "rule": e.rule(), "error": e.to_string() }),
    };

    json!({
        "seed": seed,
        "born": born.to_string(),
        "date": day.date.to_string(),
        "vans": state.vans(),
        "capacity": state.capacity(),
        "departure_minutes": DEPARTURE_MINUTES,
        "service_seconds": SERVICE_MINUTES * 60,
        "window_minutes": WINDOW_MINUTES,
        "stops": stop_json,
        "minutes": minutes,
        "heuristic": {
            "routes": plan.routes.iter().map(|r| json!({
                "van": r.van,
                "stops": r.stops.iter().map(ToString::to_string).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "minutes": plan.minutes,
            "unassigned": plan.unassigned.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "validator": validator,
        },
    })
}
