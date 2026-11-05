//! Prints one seed's output as JSON, so CI can run it twice and compare the bytes.
//!
//! Usage: `cargo run -p bakery-seed -- <seed> <YYYY-MM-DD>`, the seed a decimal `u64` and the
//! date the sandbox's birth business date.

use std::process::ExitCode;

use bakery_seed::{BirthDate, Generator, Seed};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let seed = args.next().and_then(|a| a.parse::<u64>().ok());
    let born = args.next().and_then(|a| BirthDate::parse(&a).ok());
    match (seed, born, args.next()) {
        (Some(seed), Some(born), None) => {
            print!("{}", Generator::new(Seed(seed), born).generate().to_json());
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: bakery-seed <seed, a decimal u64> <birth date, YYYY-MM-DD>");
            ExitCode::from(2)
        }
    }
}
