//! Supabase REST calls and logging, shared by every part of seraph.

use crate::config;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::OnceLock;
use std::time::Duration;

/// Why a Supabase call failed, so `main` can say "couldn't reach Supabase"
/// instead of printing a chain of errors.
#[derive(Debug)]
pub struct Unreachable(pub String);

impl std::fmt::Display for Unreachable {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for Unreachable {}

fn settings() -> Result<&'static config::Ready> {
    static READY: OnceLock<config::Ready> = OnceLock::new();
    if let Some(r) = READY.get() {
        return Ok(r);
    }
    let r = config::require()?;
    Ok(READY.get_or_init(|| r))
}

pub fn agent(timeout: u64) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(timeout)).build()
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Percent-encode a value for a PostgREST query string.
pub fn quote(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20")
}

/// One call with the secret key. Non-2xx answers are errors, like urllib's.
pub fn api(method: &str, path: &str, body: Option<&Value>, prefer: Option<&str>) -> Result<Value> {
    let s = settings()?;
    let mut req = agent(15)
        .request(method, &format!("{}{}", s.url.trim_end_matches('/'), path))
        .set("Content-Type", "application/json");
    for (k, v) in config::auth_headers(&s.secret) {
        req = req.set(k, &v);
    }
    if let Some(p) = prefer {
        req = req.set("Prefer", p);
    }
    let res = match body {
        Some(b) => req.send_string(&b.to_string()),
        None => req.call(),
    };
    let res = res.map_err(|e| match e {
        ureq::Error::Status(code, r) => {
            let text = r.into_string().unwrap_or_default();
            anyhow::Error::new(Unreachable(format!("HTTP {code}: {}", text.chars().take(300).collect::<String>())))
        }
        ureq::Error::Transport(t) => anyhow::Error::new(Unreachable(t.to_string())),
    })?;
    let text = res.into_string().context("reading Supabase's answer")?;
    Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text)? })
}

pub fn select_rows(table: &str, query: &str) -> Result<Vec<Value>> {
    Ok(api("GET", &format!("/rest/v1/{table}?{query}"), None, None)?
        .as_array()
        .cloned()
        .unwrap_or_default())
}

pub fn insert(table: &str, rows: &Value, prefer: &str) -> Result<Value> {
    api("POST", &format!("/rest/v1/{table}"), Some(rows), Some(prefer))
}

pub fn update(table: &str, query: &str, patch: &Value) -> Result<()> {
    api("PATCH", &format!("/rest/v1/{table}?{query}"), Some(patch), Some("return=minimal"))?;
    Ok(())
}

pub fn broadcast(messages: &[Value]) -> Result<()> {
    api("POST", "/realtime/v1/api/broadcast", Some(&json!({ "messages": messages })), None)?;
    Ok(())
}

pub fn finish_command(cmd_id: i64, result: Option<Value>, error: Option<String>) -> Result<()> {
    update(
        "commands",
        &format!("id=eq.{cmd_id}"),
        &json!({
            "status": if error.is_some() { "failed" } else { "done" },
            "result": result,
            "error": error,
            "done_at": now(),
        }),
    )
}

pub fn log(msg: impl AsRef<str>) {
    let _ = fs::create_dir_all(config::home());
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(config::log_path()) {
        let _ = writeln!(
            f,
            "{} [{}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            std::process::id(),
            msg.as_ref()
        );
    }
}

/// (status, parsed body) for one request with any key, never failing on an
/// HTTP error. Status 0 means it couldn't connect at all.
pub fn probe(url: &str, key: &str, path: &str, method: &str, body: Option<&Value>) -> (u16, Value) {
    let mut req = agent(15)
        .request(method, &format!("{}{}", url.trim_end_matches('/'), path))
        .set("Content-Type", "application/json");
    for (k, v) in config::auth_headers(key) {
        req = req.set(k, &v);
    }
    let res = match body {
        Some(b) => req.send_string(&b.to_string()),
        None => req.call(),
    };
    let (status, text) = match res {
        Ok(r) => (r.status(), r.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, r)) => (code, r.into_string().unwrap_or_default()),
        Err(ureq::Error::Transport(t)) => return (0, Value::String(t.to_string())),
    };
    let parsed = serde_json::from_str(&text).unwrap_or(if text.is_empty() { Value::Null } else { Value::String(text) });
    (status, parsed)
}
