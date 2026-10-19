//! `seraph link`: show a session seraph didn't start on the web page, read-only.
//!
//! Run inside Claude as `!seraph link`. There's no terminal to type into, so the
//! session is followed through its transcript only.

use crate::config;
use crate::supa::{insert, now, update};
use crate::transcript::follow_transcript;
use crate::util::{detach, process_alive};
use anyhow::{bail, Result};
use serde_json::json;
use std::fs;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn find_transcript(claude_session_id: &str) -> Option<String> {
    let projects = config::expand("~/.claude/projects");
    fs::read_dir(projects).ok()?.flatten().find_map(|folder| {
        let path = folder.path().join(format!("{claude_session_id}.jsonl"));
        path.exists().then(|| path.to_string_lossy().into_owned())
    })
}

pub fn cmd_link() -> Result<i32> {
    let (Ok(claude_id), Ok(claude_pid)) = (std::env::var("CLAUDE_CODE_SESSION_ID"), std::env::var("CLAUDE_PID")) else {
        bail!("seraph link: run this inside Claude Code, as `!seraph link`");
    };
    if std::env::var_os("SERAPH_SESSION").is_some() {
        bail!("seraph link: this session was started with `seraph claude` and is already on the web page");
    }
    fs::create_dir_all(config::links_dir())?;
    let link_file = config::links_dir().join(&claude_id);
    if link_file.exists() {
        println!("Already linked as {}", fs::read_to_string(&link_file)?.trim());
        return Ok(0);
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    insert(
        "sessions",
        &json!({
            "id": session_id,
            "cwd": std::env::current_dir()?.to_string_lossy(),
            "hostname": config::machine(),
            "pid": claude_pid.parse::<i64>()?,
            "mode": "linked",
            "claude_session_id": claude_id,
            "transcript_path": find_transcript(&claude_id),
            "status": "working", // it's running this command
        }),
        "return=minimal",
    )?;
    fs::write(&link_file, &session_id)?;
    // Follow the transcript in the background until Claude exits.
    detach(
        Command::new(config::exe())
            .args(["_follow", &session_id, &claude_pid, &claude_id])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .spawn()?;
    println!("Linked: this session is now on the web page, read-only (id {session_id}).");
    println!("To control it from the web, exit Claude and run: seraph resume {}", &claude_id[..claude_id.len().min(8)]);
    Ok(0)
}

pub fn cmd_follow(args: &[String]) -> Result<i32> {
    let [session_id, claude_pid, claude_id] = args else { bail!("usage: seraph _follow <session> <pid> <claude id>") };
    let done = Arc::new(AtomicBool::new(false));
    {
        let (done, session_id) = (done.clone(), session_id.clone());
        thread::spawn(move || follow_transcript(&session_id, &done, true));
    }
    let link_file = config::links_dir().join(claude_id);
    let pid: i32 = claude_pid.parse()?;
    while link_file.exists() && process_alive(pid) {
        thread::sleep(Duration::from_secs(2));
    }
    thread::sleep(Duration::from_secs(2)); // let the last lines go out
    done.store(true, Ordering::Relaxed);
    let _ = fs::remove_file(&link_file);
    update(
        "sessions",
        &format!("id=eq.{session_id}"),
        &json!({ "status": "ended", "ended_at": now(), "updated_at": now() }),
    )?;
    Ok(0)
}

pub fn cmd_unlink() -> Result<i32> {
    let claude_id = std::env::var("CLAUDE_CODE_SESSION_ID").unwrap_or_else(|_| "none".into());
    let link_file = config::links_dir().join(claude_id);
    if !link_file.exists() {
        bail!("seraph unlink: this session isn't linked");
    }
    fs::remove_file(link_file)?; // the follower sees this and ends the session
    println!("Unlinked.");
    Ok(0)
}
