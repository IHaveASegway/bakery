//! Prints one seed's output as JSON, so CI can run it twice and compare the bytes.
//!
//! Usage: `cargo run -p bakery-seed -- <seed> <YYYY-MM-DD> [<born>]`, the seed a decimal `u64`
//! and the date the sandbox's birth business date. With `<born>`, a sandbox's `born` wall time
//! (`YYYY-MM-DDTHH:MM:SS.mmmZ`, as the API answers it), the output is the seed as that sandbox
//! holds it (`Generated::born_at`), which the smoke scripts compare a live sandbox with.

use std::process::ExitCode;

use bakery_domain::WallTime;
use bakery_domain::calendar::local;
use bakery_seed::{BirthDate, Generator, Seed};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let seed = args.next().and_then(|a| a.parse::<u64>().ok());
    let born = args.next().and_then(|a| BirthDate::parse(&a).ok());
    let at = args.next().map(|a| {
        a.parse::<WallTime>()
            .ok()
            .and_then(|w| local(w.unix_ms()).ok())
    });
    match (seed, born, at, args.next()) {
        (Some(seed), Some(born), at, None) if at.is_none_or(|a| a.is_some()) => {
            let g = Generator::new(Seed(seed), born).generate();
            let g = match at.flatten() {
                Some(now) => g.born_at(now),
                None => g,
            };
            print!("{}", g.to_json());
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!(
                "usage: bakery-seed <seed, a decimal u64> <birth date, YYYY-MM-DD> [<born, YYYY-MM-DDTHH:MM:SS.mmmZ>]"
            );
            ExitCode::from(2)
        }
    }
}
