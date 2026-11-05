//! What every object shares: `transactionSync`, small SQL readers, the internal-call helper
//! and the answers objects give each other.

use std::cell::Cell;

use serde::Serialize;
use serde::de::DeserializeOwned;
use worker::js_sys::{Function, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue, closure::Closure};
use worker::{
    Env, Error, Headers, Method, Request, RequestInit, Response, Result, SqlStorage,
    SqlStorageValue, Storage,
};

/// Runs `body` inside `storage.transactionSync()`, which workers-rs 0.8.7 does not bind:
/// `Storage::transaction` is the asynchronous key-value transaction. An error from `body` throws
/// inside the callback, so the runtime rolls every write back.
pub fn transaction_sync<T: 'static>(
    storage: &Storage,
    body: impl FnOnce() -> Result<T> + 'static,
) -> Result<T> {
    let raw: &JsValue = storage.as_raw().as_ref();
    let method: Function = Reflect::get(raw, &JsValue::from_str("transactionSync"))?
        .dyn_into()
        .map_err(|_| Error::RustError("storage.transactionSync is not a function".into()))?;
    let out = std::rc::Rc::new(Cell::new(None));
    let slot = out.clone();
    let callback = Closure::once(move || -> std::result::Result<JsValue, JsValue> {
        match body() {
            Ok(value) => {
                slot.set(Some(value));
                Ok(JsValue::UNDEFINED)
            }
            Err(e) => Err(JsValue::from_str(&e.to_string())),
        }
    });
    method.call1(raw, callback.as_ref().unchecked_ref())?;
    out.take()
        .ok_or_else(|| Error::RustError("transaction returned no value".into()))
}

/// Every row of a query, deserialized.
pub fn rows<T: DeserializeOwned>(
    sql: &SqlStorage,
    query: &str,
    params: Vec<SqlStorageValue>,
) -> Result<Vec<T>> {
    sql.exec(query, Some(params))?.to_array()
}

/// The first row, if any.
pub fn first<T: DeserializeOwned>(
    sql: &SqlStorage,
    query: &str,
    params: Vec<SqlStorageValue>,
) -> Result<Option<T>> {
    Ok(rows(sql, query, params)?.into_iter().next())
}

pub fn exec(sql: &SqlStorage, query: &str, params: Vec<SqlStorageValue>) -> Result<usize> {
    Ok(sql.exec(query, Some(params))?.rows_written())
}

#[derive(serde::Deserialize)]
struct NameRow {
    name: String,
}

/// Whether the object has a `meta` table, read from `sqlite_master` so that a read on an
/// uninitialized object writes nothing: no table is created outside a create path, and an
/// object that was never created, or was wiped, stays empty.
pub fn has_table(sql: &SqlStorage, table: &str) -> Result<bool> {
    let found: Vec<NameRow> = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        vec![table.into()],
    )?;
    Ok(!found.is_empty())
}

#[derive(serde::Deserialize)]
struct CountRow {
    n: i64,
}

/// Rows in every table this object created: the count a wipe reports as deleted. The
/// platform's own tables (`_cf_*`, `sqlite_*`) are not the object's data.
pub fn user_rows(sql: &SqlStorage) -> Result<u64> {
    let tables: Vec<NameRow> = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
        vec![],
    )?;
    let mut total = 0u64;
    for t in tables {
        // The name came from sqlite_master and is quoted, so it cannot break the statement.
        let quoted = t.name.replace('"', "\"\"");
        let count: Option<CountRow> = first(
            sql,
            &format!("SELECT count(*) AS n FROM \"{quoted}\""),
            vec![],
        )?;
        total += count.map_or(0, |c| u64::try_from(c.n).unwrap_or(0));
    }
    Ok(total)
}

/// A JSON answer with a status.
pub fn json<T: Serialize>(value: &T, status: u16) -> Result<Response> {
    Ok(Response::from_json(value)?.with_status(status))
}

/// The answer to any path on an object that has no `meta` row: it was never created, or it was
/// wiped. The router turns it into 410 `wiped` or 404, whichever its route says.
pub fn gone() -> Result<Response> {
    json(&serde_json::json!({ "error": "gone" }), 410)
}

/// The stored answer to a command whose key was seen with the same body, marked so the router
/// can say `Idempotent-Replayed: true`.
pub fn replayed(result: &str) -> Result<Response> {
    let mut res = Response::ok(result)?;
    res.headers_mut().set("Content-Type", "application/json")?;
    res.headers_mut().set("Idempotent-Replayed", "true")?;
    Ok(res)
}

/// A refusal with a code the router maps to a problem.
pub fn refuse(status: u16, error: &str) -> Result<Response> {
    json(&serde_json::json!({ "error": error }), status)
}

/// Calls the object `name` behind `binding` at an internal path. The host is never resolved:
/// a stub's fetch goes to the object, by name, and only the Worker can build these requests.
pub async fn call<B: Serialize>(
    env: &Env,
    binding: &str,
    name: &str,
    method: Method,
    path: &str,
    body: Option<&B>,
) -> Result<Response> {
    let stub = env.durable_object(binding)?.get_by_name(name)?;
    let mut init = RequestInit::new();
    init.with_method(method);
    if let Some(body) = body {
        let headers = Headers::new();
        headers.set("Content-Type", "application/json")?;
        init.with_headers(headers);
        init.with_body(Some(JsValue::from_str(&serde_json::to_string(body)?)));
    }
    let req = Request::new_with_init(&format!("https://object.internal{path}"), &init)?;
    stub.fetch_with_request(req).await
}

/// `call` with no body.
pub async fn call_empty(
    env: &Env,
    binding: &str,
    name: &str,
    method: Method,
    path: &str,
) -> Result<Response> {
    call::<()>(env, binding, name, method, path, None).await
}

/// A request body as JSON: only the Worker calls these paths, so a bad body is a defect, not a
/// visitor's mistake. Read as text and parsed by serde_json, as every answer is written, rather
/// than by `Request::json`, which goes through serde-wasm-bindgen: one deserializer a type, not
/// two, which kept 136,666 B out of the bundle (measured 2026-11-05).
pub async fn body<T: DeserializeOwned>(req: &mut Request) -> Result<T> {
    Ok(serde_json::from_str(&req.text().await?)?)
}
