//! The one source of randomness: `crypto.getRandomValues` on the global scope. bakery-app takes
//! random bytes as arguments and draws none itself, so everything the Worker and its objects
//! mint (sandbox and guest ids, seeds, session ids, OAuth state, salts) starts here.
//!
//! The call goes through `Reflect`, as `transaction_sync` does, because workers-rs 0.8.7 binds
//! no `crypto` for a Worker; `web-sys` would add a dependency for one method.

use bakery_domain::{Ulid, WallTime};
use worker::js_sys::{Function, Reflect, Uint8Array, global};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Error, Result};

/// `getRandomValues` fills at most 65,536 bytes a call (Web Crypto, "getRandomValues"); every
/// caller here asks for far less.
pub fn bytes<const N: usize>() -> Result<[u8; N]> {
    let crypto = Reflect::get(&global(), &JsValue::from_str("crypto"))?;
    let method: Function = Reflect::get(&crypto, &JsValue::from_str("getRandomValues"))?
        .dyn_into()
        .map_err(|_| Error::RustError("crypto.getRandomValues is not a function".into()))?;
    let array = Uint8Array::new_with_length(N as u32);
    method.call1(&crypto, &array)?;
    let mut out = [0u8; N];
    array.copy_to(&mut out);
    // A runtime that returned without filling would hand back zeros: refuse rather than mint
    // predictable ids. Thirty-two zero bytes by chance is 2^-256.
    if N >= 16 && out.iter().all(|&b| b == 0) {
        return Err(Error::RustError(
            "crypto.getRandomValues returned zeros".into(),
        ));
    }
    Ok(out)
}

/// A ULID for `now`: 48 bits of milliseconds and 80 random bits (docs/domain.md, "Identifiers").
pub fn ulid(now: WallTime) -> Result<Ulid> {
    let random = bytes::<16>()?;
    let ms = u64::try_from(now.unix_ms()).unwrap_or(0);
    Ok(Ulid::from_parts(ms, u128::from_be_bytes(random)))
}

/// A sandbox seed below 2^53: the console reads it as a JSON number, which JavaScript holds
/// exactly only up to there (crates/contracts, `SandboxResponse::seed`).
pub fn seed() -> Result<u64> {
    Ok(u64::from_be_bytes(bytes::<8>()?) >> 11)
}
