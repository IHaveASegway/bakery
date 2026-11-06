//! Writes the OpenAPI document to `apps/web/public/docs/api/openapi.json`. With `--check` it
//! writes nothing and fails when the committed copy is not what the route table and the
//! schemas give today: CI runs it that way, as `cargo test` checks the schemas.

use std::process::ExitCode;

fn main() -> ExitCode {
    let path = bakery_contracts::openapi::document_path();
    let text = bakery_contracts::openapi::render();
    let check = std::env::args().skip(1).any(|a| a == "--check");
    if check {
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        if committed == text {
            println!(
                "{} is current ({} bytes)",
                bakery_contracts::openapi::DOCUMENT_PATH,
                text.len()
            );
            return ExitCode::SUCCESS;
        }
        eprintln!(
            "{} is stale: run `cargo run -p bakery-contracts --bin openapi` and commit it",
            bakery_contracts::openapi::DOCUMENT_PATH
        );
        return ExitCode::FAILURE;
    }
    if let Some(dir) = path.parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        eprintln!("cannot create {}: {e}", dir.display());
        return ExitCode::FAILURE;
    }
    match std::fs::write(&path, &text) {
        Ok(()) => {
            println!(
                "wrote {} ({} bytes)",
                bakery_contracts::openapi::DOCUMENT_PATH,
                text.len()
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("cannot write {}: {e}", path.display());
            ExitCode::FAILURE
        }
    }
}
