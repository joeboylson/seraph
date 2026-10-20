//! Ships this computer's seraph logs to Supabase's `logs` table, so what
//! happened on any computer can be read from one place when debugging.
//!
//! Every process writes its own log lines to files in ~/.seraph as before;
//! the controller uploads whatever is new about once a minute. Logs written
//! while the controller is off go up once it's back. Only the secret key can
//! read the table, and lines go after a week.

use crate::config;
use crate::supa::{api, insert};
use anyhow::Result;
use serde_json::{json, Map, Value};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};

/// The log files seraph writes in its folder.
const FILES: [&str; 3] = ["seraph.log", "daemon.log", "hooks.log"];
/// Lines per upload, and the most sent in one go (the rest go next time).
const BATCH: usize = 500;
const MAX_LINES_PER_RUN: usize = 5000;
/// A log file this big starts over (once everything in it is uploaded).
const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 4000;
const KEEP_DAYS: i64 = 7;

fn offsets_path() -> std::path::PathBuf {
    config::home().join("logs-shipped.json")
}

/// "2026-10-20 13:08:12 [4242] message" → (time, pid, message). Lines in
/// another shape (e.g. a panic in daemon.log) keep the whole line.
fn parse(line: &str) -> (Option<String>, Option<i64>, String) {
    let time = line.get(..19).and_then(|t| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").ok());
    let Some(time) = time.and_then(|t| t.and_local_timezone(chrono::Local).single()) else {
        return (None, None, line.to_string());
    };
    let rest = line[19..].trim_start();
    let (pid, msg) = match rest.strip_prefix('[').and_then(|r| r.split_once("] ")) {
        Some((pid, msg)) if pid.chars().all(|c| c.is_ascii_digit()) => (pid.parse().ok(), msg),
        _ => (None, rest),
    };
    (Some(time.to_rfc3339()), pid, msg.to_string())
}

/// Upload what's new in each log file since the last run.
pub fn ship(machine: &str) -> Result<()> {
    let mut offsets: Map<String, Value> = fs::read_to_string(offsets_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let mut budget = MAX_LINES_PER_RUN;
    for name in FILES {
        let path = config::home().join(name);
        let Ok(len) = fs::metadata(&path).map(|m| m.len()) else { continue };
        let mut offset = offsets.get(name).and_then(Value::as_u64).unwrap_or(0);
        if len < offset {
            offset = 0; // started over
        }
        if len > offset && budget > 0 {
            let mut data = Vec::new();
            let mut f = File::open(&path)?;
            f.seek(SeekFrom::Start(offset))?;
            f.read_to_end(&mut data)?;
            // Only whole lines; a line being written now goes next time.
            let end = data.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
            let mut lines: Vec<&[u8]> = data[..end].split(|&b| b == b'\n').collect();
            lines.pop(); // after the last newline
            let mut sent = 0;
            for chunk in lines.chunks(BATCH) {
                if budget == 0 {
                    break;
                }
                let chunk = &chunk[..chunk.len().min(budget)];
                let rows: Vec<Value> = chunk
                    .iter()
                    .map(|l| String::from_utf8_lossy(l).chars().take(MAX_LINE_CHARS).collect::<String>())
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| {
                        let (ts, pid, message) = parse(&l);
                        json!({ "machine": machine, "source": name, "ts": ts, "pid": pid, "line": message })
                    })
                    .collect();
                if !rows.is_empty() {
                    insert("logs", &Value::Array(rows), "return=minimal")?;
                }
                sent += chunk.iter().map(|l| l.len() + 1).sum::<usize>();
                budget -= chunk.len();
                // Saved after each upload, so a failure resumes where it stopped.
                offsets.insert(name.into(), json!(offset + sent as u64));
                fs::write(offsets_path(), Value::Object(offsets.clone()).to_string())?;
            }
            offset += sent as u64;
        }
        if offset >= len && len > ROTATE_BYTES {
            let _ = fs::rename(&path, config::home().join(format!("{name}.1")));
            offsets.insert(name.into(), json!(0));
            fs::write(offsets_path(), Value::Object(offsets.clone()).to_string())?;
        }
    }
    Ok(())
}

/// Delete this computer's log lines older than a week.
pub fn prune(machine: &str) -> Result<()> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(KEEP_DAYS)).format("%Y-%m-%dT%H:%M:%SZ");
    let machine = crate::supa::quote(machine);
    api("DELETE", &format!("/rest/v1/logs?machine=eq.{machine}&created_at=lt.{cutoff}"), None, Some("return=minimal"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_time_pid_and_message() {
        let (ts, pid, msg) = parse("2026-10-20 13:08:12 [4242] daemon: started");
        assert!(ts.unwrap().starts_with("2026-10-20T13:08:12"));
        assert_eq!(pid, Some(4242));
        assert_eq!(msg, "daemon: started");
    }

    #[test]
    fn keeps_other_lines_whole() {
        assert_eq!(parse("thread 'main' panicked at src/x.rs"), (None, None, "thread 'main' panicked at src/x.rs".into()));
    }
}
