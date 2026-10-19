//! `seraph _hook`: Claude Code's hook for every event. Sends the hook's input to
//! the Supabase `events` table.
//!
//! The hook returns right away and a background copy does the upload, so a
//! slow or down Supabase never holds up Claude.

use crate::config;
use crate::util::detach;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::process::{Command, Stdio};

fn send(raw: &str) -> Result<()> {
    // The same settings seraph uses, including SERAPH_* overrides.
    let s = config::load();
    let url = s.supabase_url.ok_or_else(|| anyhow!("no supabase_url"))?;
    let key = s.supabase_secret_key.ok_or_else(|| anyhow!("no supabase_secret_key"))?;
    let payload: Value = serde_json::from_str(raw)?;
    let row = json!({
        "session_id": payload["session_id"].as_str().unwrap_or("unknown"),
        "hook_event": payload["hook_event_name"].as_str().unwrap_or("unknown"),
        "cwd": payload["cwd"],
        "payload": payload,
        // Set by `seraph claude` so events map to the right web session.
        "csc_session": std::env::var("SERAPH_SESSION").ok(),
    });
    let mut req = crate::supa::agent(15)
        .post(&format!("{}/rest/v1/events", url.trim_end_matches('/')))
        .set("Content-Type", "application/json")
        .set("Prefer", "return=minimal");
    for (k, v) in config::auth_headers(&key) {
        req = req.set(k, &v);
    }
    req.send_string(&row.to_string())?;
    Ok(())
}

pub fn cmd_hook(args: &[String]) -> i32 {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    if args.iter().any(|a| a == "--send") {
        if let Err(e) = send(&raw) {
            let _ = std::fs::create_dir_all(config::home());
            if let Ok(mut log) = OpenOptions::new().create(true).append(true).open(config::home().join("hooks.log")) {
                let _ = writeln!(log, "{e}");
            }
        }
        return 0;
    }
    let child = detach(
        Command::new(config::exe())
            .args(["_hook", "--send"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .spawn();
    match child {
        Ok(mut child) => {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(raw.as_bytes());
            }
        }
        Err(e) => eprintln!("seraph hook: {e}"),
    }
    // Always 0: a hook failure must never block Claude.
    0
}
