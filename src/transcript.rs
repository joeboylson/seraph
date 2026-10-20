//! Copy Claude's transcript (the session's JSONL file) into the `messages` table.

use crate::supa::{api, log, now, select_rows, update};
use anyhow::Result;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

// The transcript also holds bookkeeping (API request records, attachments,
// snapshots) that the page doesn't show and that makes up most of its size.
const TRANSCRIPT_TYPES: [&str; 3] = ["user", "assistant", "system"];

fn kind(entry: &Value) -> &str {
    entry["type"].as_str().unwrap_or("")
}

/// Lines the page shows. A message sent while Claude is busy is saved as an
/// attachment (a "queued_command"), not a user line, so keep those too, or it
/// never shows in the chat.
fn shown(entry: &Value) -> bool {
    TRANSCRIPT_TYPES.contains(&kind(entry)) || (kind(entry) == "attachment" && entry["attachment"]["type"] == "queued_command")
}

/// Best guess at the session's status from one transcript line.
fn transcript_status(entry: &Value) -> Option<&'static str> {
    if kind(entry) == "system" && entry["subtype"] == "turn_duration" {
        return Some("idle");
    }
    if kind(entry) == "assistant" {
        return Some(if entry["message"]["stop_reason"] == "end_turn" { "idle" } else { "working" });
    }
    if was_interrupted(entry) {
        return Some("idle");
    }
    if kind(entry) == "user" && entry["isMeta"] != true {
        return Some("working");
    }
    None
}

/// Claude writes this user line when Esc stops a turn.
fn was_interrupted(entry: &Value) -> bool {
    if kind(entry) != "user" {
        return false;
    }
    let content = &entry["message"]["content"];
    let text = content.as_str().map(str::to_string).unwrap_or_else(|| content.to_string());
    text.contains("[Request interrupted by user")
}

/// True if the newest conversation line in `batch` ends Claude's turn.
fn turn_ended(batch: &[Value]) -> bool {
    for row in batch.iter().rev() {
        let entry = &row["data"];
        if kind(entry) == "system" && entry["subtype"] == "turn_duration" {
            return true;
        }
        if kind(entry) == "user" || kind(entry) == "assistant" {
            return was_interrupted(entry);
        }
    }
    false
}

struct Follower {
    session_id: String,
    infer_status: bool,
    path: Option<String>,
    offset: u64,
    partial: Vec<u8>,
    last_lookup: Option<Instant>,
}

impl Follower {
    fn step(&mut self) -> Result<()> {
        // The path changes on /clear and resume; checking it now and then is enough.
        if self.last_lookup.is_none_or(|t| t.elapsed().as_secs() > 3) {
            self.last_lookup = Some(Instant::now());
            let rows = select_rows("sessions", &format!("id=eq.{}&select=transcript_path", self.session_id))?;
            let new_path = rows.first().and_then(|r| r["transcript_path"].as_str()).map(str::to_string);
            if new_path != self.path {
                self.path = new_path;
                self.offset = 0;
                self.partial.clear();
            }
        }
        let Some(path) = &self.path else { return Ok(()) };
        let Ok(mut f) = File::open(path) else { return Ok(()) };
        f.seek(SeekFrom::Start(self.offset))?;
        let mut data = Vec::new();
        f.read_to_end(&mut data)?;

        let mut all = self.partial.clone();
        all.extend_from_slice(&data);
        let mut lines: Vec<&[u8]> = all.split(|&b| b == b'\n').collect();
        let rest = lines.pop().unwrap_or_default().to_vec();
        let mut batch = Vec::new();
        for line in lines {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let entry: Value = serde_json::from_slice(line)?;
            if !shown(&entry) {
                continue;
            }
            let uuid = entry["uuid"]
                .as_str()
                .or_else(|| entry["messageId"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| sha1_smol::Sha1::from(line).digest().to_string());
            batch.push(json!({
                "session_id": self.session_id,
                "uuid": uuid,
                "type": entry["type"].as_str().unwrap_or("unknown"),
                "ts": entry["timestamp"],
                "data": entry,
            }));
        }
        if self.offset == 0 && batch.len() > crate::daemon::KEEP {
            // A transcript seen for the first time (e.g. a resumed session):
            // only its end is wanted, since older lines would just be purged.
            batch.drain(..batch.len() - crate::daemon::KEEP);
        }
        for chunk in batch.chunks(50) {
            api(
                "POST",
                "/rest/v1/messages?on_conflict=session_id,uuid",
                Some(&Value::Array(chunk.to_vec())),
                Some("resolution=ignore-duplicates,return=minimal"),
            )?;
        }
        if self.infer_status && !batch.is_empty() {
            if let Some(status) = batch.iter().filter_map(|r| transcript_status(&r["data"])).next_back() {
                update(
                    "sessions",
                    &format!("id=eq.{}&status=neq.ended", self.session_id),
                    &json!({ "status": status, "updated_at": now() }),
                )?;
            }
        } else if !batch.is_empty() && turn_ended(&batch) {
            // Esc doesn't fire the Stop hook, so nothing else would say Claude stopped working.
            update(
                "sessions",
                &format!("id=eq.{}&status=in.(working,waiting)", self.session_id),
                &json!({ "status": "idle", "updated_at": now() }),
            )?;
        }
        // Only move on once the lines are saved; a failed upload is retried.
        self.offset += data.len() as u64;
        self.partial = rest;
        Ok(())
    }
}

/// Copy new lines of the session's transcript into `messages` until `done` is set.
pub fn follow_transcript(session_id: &str, done: &AtomicBool, infer_status: bool) {
    let mut follower = Follower {
        session_id: session_id.to_string(),
        infer_status,
        path: None,
        offset: 0,
        partial: Vec::new(),
        last_lookup: None,
    };
    while !done.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_secs(1));
        if let Err(e) = follower.step() {
            log(format!("transcript: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_queued_messages_but_not_other_attachments() {
        assert!(shown(&json!({ "type": "user" })));
        assert!(shown(&json!({ "type": "attachment", "attachment": { "type": "queued_command", "prompt": "hi" } })));
        assert!(!shown(&json!({ "type": "attachment", "attachment": { "type": "file" } })));
        assert!(!shown(&json!({ "type": "queue-operation" })));
    }
}
