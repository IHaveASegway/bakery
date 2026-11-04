//! Writes one JSON Schema per contract type into `crates/contracts/schemas/`. The output is
//! committed; a test fails when it is stale.

fn main() -> std::io::Result<()> {
    let dir = bakery_contracts::schema_dir();
    std::fs::create_dir_all(&dir)?;
    for (name, text) in bakery_contracts::schemas() {
        std::fs::write(dir.join(name), text)?;
        println!("wrote {name}");
    }
    Ok(())
}
