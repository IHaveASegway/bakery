//! Prints one seed's output as JSON, so CI can run it twice and compare the bytes.
//!
//! Usage: `cargo run -p bakery-seed -- <seed>`, the seed a decimal `u64`.

use std::process::ExitCode;

use bakery_seed::{Generator, Seed};

fn main() -> ExitCode {
    let arg = std::env::args().nth(1);
    match arg.as_deref().map(str::parse::<u64>) {
        Some(Ok(seed)) => {
            print!("{}", Generator::new(Seed(seed)).generate().to_json());
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: bakery-seed <seed, a decimal u64>");
            ExitCode::from(2)
        }
    }
}
