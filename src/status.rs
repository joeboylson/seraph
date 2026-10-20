//! `seraph _status`: Claude Code's status line command in `seraph claude`
//! sessions. Claude passes it the context used and the plan's 5-hour and
//! weekly limits; this saves them on the session row so the page can show
//! them. Your own status line, if you have one, still runs and shows as
//! before.
//!
//! Claude runs the status line often, so it only uploads when the numbers
//! change, and a background copy does the upload so Claude never waits.

use crate::config;
use crate::util::detach;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

/// Your own status line command, passed along by `seraph claude`.
pub const USER_COMMAND_ENV: &str = "SERAPH_USER_STATUSLINE";

/// The parts of Claude's status line input the page shows, rounded so small
/// changes don't each cause an upload.
fn usage(input: &Value) -> Value {
    let pct = |v: &Value| v.as_f64().map(|p| p.round() as i64);
    let window = |w: &Value| {
        pct(&w["used_percentage"]).map(|p| json!({ "used_percentage": p, "resets_at": w["resets_at"] }))
    };
    json!({
        "context_percentage": pct(&input["context_window"]["used_percentage"]),
        "five_hour": window(&input["rate_limits"]["five_hour"]),
        "seven_day": window(&input["rate_limits"]["seven_day"]),
    })
}

fn upload(session: &str, usage: &Value) -> anyhow::Result<()> {
    crate::supa::update("sessions", &format!("id=eq.{session}"), &json!({ "usage": usage }))
}

/// Run your own status line with the same input and print what it prints.
fn run_user_command(raw: &str) {
    let Ok(command) = std::env::var(USER_COMMAND_ENV) else { return };
    let child = Command::new("sh").args(["-c", &command]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
    let Ok(mut child) = child else { return };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(raw.as_bytes());
    }
    if let Ok(out) = child.wait_with_output() {
        let _ = std::io::stdout().write_all(&out.stdout);
    }
}

pub fn cmd_status(args: &[String]) -> i32 {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let Ok(session) = std::env::var("SERAPH_SESSION") else {
        run_user_command(&raw);
        return 0;
    };
    if args.iter().any(|a| a == "--send") {
        if let Ok(usage) = serde_json::from_str::<Value>(&raw) {
            if let Err(e) = upload(&session, &usage) {
                crate::supa::log(format!("status: {e}"));
            }
        }
        return 0;
    }

    if let Ok(input) = serde_json::from_str::<Value>(&raw) {
        let usage = usage(&input).to_string();
        let last = config::home().join("status").join(&session);
        if std::fs::read_to_string(&last).ok().as_deref() != Some(usage.as_str()) {
            let _ = std::fs::create_dir_all(last.parent().unwrap());
            let _ = std::fs::write(&last, &usage);
            let child = detach(
                Command::new(config::exe()).args(["_status", "--send"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()),
            )
            .spawn();
            if let Ok(mut child) = child {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(usage.as_bytes());
                }
            }
        }
    }
    run_user_command(&raw);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_context_and_limits_rounded() {
        let input = json!({
            "context_window": { "used_percentage": 41.6 },
            "rate_limits": {
                "five_hour": { "used_percentage": 12.2, "resets_at": 1792450000 },
                "seven_day": { "used_percentage": 63.5, "resets_at": 1792900000 }
            }
        });
        assert_eq!(
            usage(&input),
            json!({
                "context_percentage": 42,
                "five_hour": { "used_percentage": 12, "resets_at": 1792450000 },
                "seven_day": { "used_percentage": 64, "resets_at": 1792900000 }
            })
        );
    }

    #[test]
    fn missing_limits_are_null() {
        let usage = usage(&json!({ "context_window": { "used_percentage": null } }));
        assert_eq!(usage, json!({ "context_percentage": null, "five_hour": null, "seven_day": null }));
    }
}
