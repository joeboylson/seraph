//! seraph's published releases: which is newest, and the oh-my-zsh-style
//! question when you start seraph in a terminal and a newer one is out.

use crate::config;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

/// "0.2.7" or "v0.2.7 (built …)" to [0, 2, 7].
pub fn version_parts(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split_whitespace().next().unwrap_or("").split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

/// Whether release `tag` is newer than this build.
pub fn is_newer(tag: &str) -> bool {
    version_parts(tag) > version_parts(env!("CARGO_PKG_VERSION"))
}

/// The newest published release's tag, e.g. "v0.2.8".
pub fn latest(timeout_secs: u64) -> Result<String> {
    let body: Value = crate::supa::agent(timeout_secs)
        .get("https://api.github.com/repos/joeboylson/seraph/releases/latest")
        .set("User-Agent", "seraph")
        .set("Accept", "application/vnd.github+json")
        .call()?
        .into_json()?;
    body["tag_name"].as_str().map(str::to_string).ok_or_else(|| anyhow!("no tag_name in GitHub's answer"))
}

// ---- asking in the terminal -------------------------------------------------

/// Look for a new release at most this often; "not now" waits this long too.
const DAY_SECS: u64 = 24 * 3600;
/// After a failed look (e.g. offline), try again after this long.
const RETRY_SECS: u64 = 3600;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn state_path() -> std::path::PathBuf {
    config::home().join("update-check.json")
}

fn load_state() -> Value {
    std::fs::read_to_string(state_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}))
}

fn save_state(state: &Value) {
    let _ = std::fs::create_dir_all(config::home());
    let _ = std::fs::write(state_path(), state.to_string());
}

/// How starting seraph in a terminal treats a new release: ask (the
/// default), auto (update without asking), or off. `seraph update --mode`.
pub fn mode() -> String {
    match config::saved_value("update_mode") {
        Some(Value::String(m)) if ["ask", "auto", "off"].contains(&m.as_str()) => m,
        _ => "ask".into(),
    }
}

/// The newest release, looked up at most once a day (cached in ~/.seraph).
/// None if there's nothing to say, or GitHub can't be reached quickly.
fn newest_known() -> Option<String> {
    let mut state = load_state();
    let checked = state["checked_at"].as_u64().unwrap_or(0);
    if now().saturating_sub(checked) < DAY_SECS {
        return state["latest"].as_str().map(str::to_string);
    }
    match latest(3) {
        Ok(tag) => {
            state["checked_at"] = json!(now());
            state["latest"] = json!(tag);
            save_state(&state);
            Some(tag)
        }
        Err(_) => {
            // Offline or slow: don't hold up starting, and look again in an hour.
            state["checked_at"] = json!(now() - DAY_SECS + RETRY_SECS);
            save_state(&state);
            None
        }
    }
}

/// Before `seraph claude` or `seraph resume` in a terminal: if a newer
/// release is out, ask whether to update (or just do it, in auto mode).
/// Updating carries on into `seraph <args>` with the new version.
pub fn offer_update(args: &[String]) {
    let tty = || unsafe { libc::isatty(0) == 1 && libc::isatty(1) == 1 };
    let mode = mode();
    if mode == "off" || !tty() || config::require().is_err() {
        return;
    }
    let mut state = load_state();
    if state["snoozed_until"].as_u64().is_some_and(|t| t > now()) {
        return;
    }
    let Some(tag) = newest_known().filter(|t| is_newer(t)) else { return };
    let have = env!("CARGO_PKG_VERSION");
    if mode == "ask" {
        print!("seraph {} is out (you have {have}). Update now? [Y/n] ", tag.trim_start_matches('v'));
        let _ = std::io::stdout().flush();
        let mut answer = String::new();
        // No answer at all (input closed) is never a yes.
        if std::io::stdin().lock().read_line(&mut answer).unwrap_or(0) == 0 {
            println!();
            return;
        }
        if answer.trim().to_lowercase().starts_with('n') {
            state["snoozed_until"] = json!(now() + DAY_SECS);
            save_state(&state);
            println!("Not now. seraph will ask again tomorrow (or run `seraph update`).");
            return;
        }
    } else {
        println!("Updating seraph to {tag}…");
    }
    match crate::service::cmd_update() {
        Ok(0) => {
            // Don't ask again straight away, even if the copy started next
            // somehow isn't newer (e.g. this one was run from the repo).
            state["snoozed_until"] = json!(now() + DAY_SECS);
            save_state(&state);
            // Carry on with the new copy.
            let err = crate::wrapper::exec(&config::exe().to_string_lossy(), args.to_vec());
            eprintln!("seraph: updated, but couldn't restart into it ({err}); carrying on with {have}.");
        }
        _ => eprintln!("seraph: the update didn't finish; carrying on with {have}."),
    }
}

/// `seraph update --mode ask|auto|off`.
pub fn set_mode(mode: &str) -> Result<i32> {
    if !["ask", "auto", "off"].contains(&mode) {
        anyhow::bail!("Usage: seraph update --mode ask|auto|off");
    }
    config::save(&[("update_mode", Some(json!(mode)))])?;
    println!(
        "{}",
        match mode {
            "ask" => "seraph will ask before updating when you start it in a terminal.",
            "auto" => "seraph will update itself when you start it in a terminal and a new release is out.",
            _ => "seraph won't look for updates when you start it. `seraph update` still works.",
        }
    );
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number() {
        assert!(version_parts("v0.2.10") > version_parts("0.2.9 (built 2026-10-21 03:14 UTC)"));
        assert!(version_parts("v0.3.0") > version_parts("0.2.7"));
        assert_eq!(version_parts("v0.2.7"), version_parts("0.2.7 (built x)"));
        assert!(version_parts("v0.2.6") < version_parts("0.2.7"));
    }
}
