//! `seraph daemon`: starts sessions for the web page and serves the page.

use crate::config;
use crate::push;
use crate::supa::{api, finish_command, insert, log, now, quote, select_rows, update};
use crate::util::{detach, process_alive};
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// The folders inside `dir`, by name, skipping hidden ones. Links are
/// followed, like a person browsing would.
fn subfolders(dir: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut found: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .map_err(|e| anyhow!("{}: {}", e.kind(), dir.display()))?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (!name.starts_with('.') && e.path().is_dir()).then(|| (name, e.path()))
        })
        .collect();
    found.sort_by_key(|(name, _)| name.to_lowercase());
    Ok(found)
}

/// Whether a folder has any folders inside, so the page knows if it opens.
fn has_subfolders(dir: &Path) -> bool {
    fs::read_dir(dir).map(|rd| rd.flatten().any(|e| !e.file_name().to_string_lossy().starts_with('.') && e.path().is_dir())).unwrap_or(false)
}

/// For the page's folder tree, one level at a time and only inside the
/// folders seraph may use (see folders.rs): folder names, never files.
/// With no `path`, the allowed folders themselves: the tree's top level.
fn list_dirs(path: Option<&str>) -> Result<Value> {
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        let roots: Vec<Value> = crate::folders::roots()
            .iter()
            .map(|r| json!({ "path": r, "name": r.to_string_lossy().replacen(&config::user_home(), "~", 1), "children": has_subfolders(r) }))
            .collect();
        return Ok(json!({ "roots": roots }));
    };
    let asked = canonical_or_plain(&config::expand(path));
    // A folder from an old session may be gone: show the nearest one that's left.
    let mut path = asked.clone();
    while !path.is_dir() {
        match path.parent() {
            Some(p) => path = p.to_path_buf(),
            None => break,
        }
    }
    if !crate::folders::allowed(&path) {
        return Err(crate::folders::not_allowed(&asked));
    }
    let dirs: Vec<Value> = subfolders(&path)?.iter().map(|(name, p)| json!({ "name": name, "children": has_subfolders(p) })).collect();
    // Up stops at the top of the allowed folders.
    let parent = path.parent().filter(|p| crate::folders::allowed(p)).unwrap_or(&path).to_path_buf();
    let mut result = json!({ "path": path, "parent": parent, "dirs": dirs });
    if asked != path {
        result["missing"] = json!(asked);
    }
    Ok(result)
}

/// The real path, or the path tidied up if it doesn't exist.
fn canonical_or_plain(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| {
        let mut out = PathBuf::new();
        for c in p.components() {
            match c {
                Component::ParentDir => {
                    out.pop();
                }
                Component::CurDir => {}
                other => out.push(other),
            }
        }
        out
    })
}

/// What the page may pass on to Claude's command line. Each value must match,
/// so nothing it sends can be read as another flag.
fn start_fields() -> &'static [(&'static str, Regex)] {
    static FIELDS: OnceLock<Vec<(&str, Regex)>> = OnceLock::new();
    FIELDS.get_or_init(|| {
        [
            ("name", r"^[^-\x00-\x1f][^\x00-\x1f]{0,99}$"),
            ("model", r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$"),
            ("permission_mode", r"^(default|acceptEdits|plan|auto|bypassPermissions|dontAsk)$"),
            ("resume", r"^[0-9a-fA-F-]{8,64}$"),
            ("size", r"^\d{2,3}x\d{2,3}$"),
        ]
        .into_iter()
        .map(|(f, p)| (f, Regex::new(p).expect("valid pattern")))
        .collect()
    })
}

/// Check what the page sent against `start_fields`.
fn check_fields(payload: &Value) -> Result<()> {
    for (field, pattern) in start_fields() {
        match &payload[*field] {
            Value::Null => {}
            Value::String(s) if pattern.is_match(s) => {}
            _ => bail!("invalid {field}"),
        }
    }
    Ok(())
}

/// Run `seraph claude` for session `session_id` in `cwd`, in the background,
/// with the options in `payload` (already checked).
fn spawn_wrapper(session_id: &str, cwd: &Path, payload: &Value) -> Result<()> {
    let size = payload["size"].as_str().unwrap_or("120x40");
    let mut argv = vec!["claude".to_string(), "--seraph-headless".into(), "--seraph-id".into(), session_id.to_string(), "--seraph-size".into(), size.into()];
    for (field, flag) in [("name", "--name"), ("permission_mode", "--permission-mode"), ("model", "--model"), ("resume", "--resume")] {
        if let Some(v) = payload[field].as_str() {
            argv.push(flag.into());
            argv.push(v.into());
        }
    }
    let log_file = OpenOptions::new().create(true).append(true).open(config::log_path())?;
    let mut child = detach(
        Command::new(config::exe())
            .args(&argv)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(log_file.try_clone()?)
            .stderr(log_file),
    )
    .spawn()?;
    // Collect it when it exits, or it stays a zombie that looks alive
    // (which a restart waits on) until the controller itself stops.
    thread::spawn(move || child.wait());
    Ok(())
}

fn start_session(payload: &Value) -> Result<Value> {
    check_fields(payload)?;
    let cwd_raw = payload["cwd"].as_str().ok_or_else(|| anyhow!("missing cwd"))?;
    let expanded = config::expand(cwd_raw);
    // Only in the folders seraph may use; a new folder's nearest existing parent counts.
    let mut existing = canonical_or_plain(&expanded);
    while !existing.exists() {
        match existing.parent() {
            Some(p) => existing = p.to_path_buf(),
            None => break,
        }
    }
    if !crate::folders::allowed(&fs::canonicalize(&existing).unwrap_or(existing)) {
        return Err(crate::folders::not_allowed(&expanded));
    }
    if payload["create"] == true {
        fs::create_dir_all(&expanded)?;
    }
    let cwd = canonical_or_plain(&expanded);
    if !cwd.is_dir() {
        bail!("not a folder: {}", cwd.display());
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    // Create the row now so the page can open the session straight away;
    // the wrapper fills in the rest once it starts.
    insert(
        "sessions",
        &json!({ "id": session_id, "name": payload["name"], "cwd": cwd, "hostname": config::machine(), "mode": "headless" }),
        "return=minimal",
    )?;
    spawn_wrapper(&session_id, &cwd, payload)?;
    if let Some(prompt) = payload["prompt"].as_str() {
        // Waits in the queue until the new session is ready for it.
        insert(
            "commands",
            &json!({ "session_id": session_id, "kind": "prompt", "payload": { "text": prompt } }),
            "return=minimal",
        )?;
    }
    Ok(json!({ "session_id": session_id, "cwd": cwd }))
}

/// Restart a session started from the page: end its Claude, wait for it to
/// exit, then start Claude again in the same session, resuming the same
/// conversation. The session keeps its id, so the page stays on it.
fn restart_session(payload: &Value) -> Result<Value> {
    let id = payload["session_id"].as_str().unwrap_or_default().to_string();
    if !Regex::new(r"^[0-9a-f-]{36}$").expect("valid pattern").is_match(&id) {
        bail!("invalid session_id");
    }
    let rows = select_rows("sessions", &format!("id=eq.{id}&select=cwd,name,model,permission_mode,claude_session_id,mode,status,hostname,pid,cols,rows"))?;
    let row = rows.first().ok_or_else(|| anyhow!("no such session"))?.clone();
    if row["mode"] != "headless" {
        bail!("Only sessions started from the page can be restarted here. This one belongs to a terminal; restart it there.");
    }
    if row["hostname"].as_str() != Some(config::machine().as_str()) {
        bail!("This session runs on another computer.");
    }
    let cwd = PathBuf::from(row["cwd"].as_str().unwrap_or_default());
    if !cwd.is_dir() {
        bail!("its folder is gone: {}", cwd.display());
    }
    let size = match (row["cols"].as_u64(), row["rows"].as_u64()) {
        (Some(c), Some(r)) => Value::from(format!("{c}x{r}")),
        _ => Value::Null,
    };
    // Claude saves a conversation only once something is said, and
    // `--resume` quits if there's none: with no messages yet, start fresh.
    let said = !select_rows("messages", &format!("session_id=eq.{id}&select=id&limit=1"))?.is_empty();
    let options = json!({
        "name": row["name"],
        "model": row["model"],
        "permission_mode": row["permission_mode"],
        "resume": if said { row["claude_session_id"].clone() } else { Value::Null },
        "size": size,
    });
    check_fields(&options)?;
    // Waiting can take a while; answer the page now and finish in the background.
    thread::spawn(move || {
        if let Err(e) = finish_restart(&id, &row, &cwd, &options) {
            log(format!("restart {id}: {e}"));
        }
    });
    Ok(json!({ "session_id": payload["session_id"] }))
}

fn finish_restart(id: &str, row: &Value, cwd: &Path, options: &Value) -> Result<()> {
    log(format!("restart {id}: ending Claude (status {}), then resuming {}", row["status"], options["resume"].as_str().unwrap_or("fresh")));
    if row["status"] != "ended" {
        insert("commands", &json!({ "session_id": id, "kind": "kill" }), "return=minimal")?;
        let pid = row["pid"].as_i64().map(|p| p as i32);
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            thread::sleep(Duration::from_millis(500));
            let ended = select_rows("sessions", &format!("id=eq.{id}&select=status"))?.first().is_some_and(|r| r["status"] == "ended");
            if ended && !pid.is_some_and(process_alive) {
                break;
            }
            if Instant::now() > deadline {
                bail!("Claude didn't exit within 30 seconds");
            }
        }
    }
    update("sessions", &format!("id=eq.{id}"), &json!({ "status": "starting", "ended_at": null, "paused_at": null, "updated_at": now() }))?;
    spawn_wrapper(id, cwd, options)?;
    log(format!("restart {id}: started again"));
    Ok(())
}

/// Mark a request as ours. Only one controller's update finds it still pending.
pub fn claim(cmd_id: i64) -> Result<bool> {
    let rows = api(
        "PATCH",
        &format!("/rest/v1/commands?id=eq.{cmd_id}&status=eq.pending"),
        Some(&json!({ "status": "running" })),
        Some("return=representation"),
    )?;
    Ok(rows.as_array().is_some_and(|r| !r.is_empty()))
}

fn handle(cmd: &Value) -> Result<Value> {
    let payload = &cmd["payload"];
    match cmd["kind"].as_str().unwrap_or("") {
        "list_dirs" => list_dirs(payload["path"].as_str()),
        "start_session" => start_session(payload),
        "restart_session" => restart_session(payload),
        other => bail!("unknown command: {other}"),
    }
}

/// An error message for the page: the OS reason without codes, e.g.
/// "No such file or directory: /some/path".
fn readable(e: &anyhow::Error) -> String {
    if let Some(io) = e.downcast_ref::<std::io::Error>() {
        let text = io.to_string();
        return text.split(" (os error").next().unwrap_or(&text).to_string();
    }
    e.to_string()
}

// ---- installing on other devices -------------------------------------------

const LOOPBACK: [&str; 4] = ["127.0.0.1", "localhost", "::1", "[::1]"];

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

/// This computer's platform as `uname` names it, e.g. "darwin-arm64".
fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" if os == "darwin" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// The script behind `curl -fsSL <page>/install | sh`: fetches this
/// computer's own binary, for devices of the same kind. Keys never travel;
/// each device runs `seraph setup` once.
fn install_script(origin: &str) -> String {
    format!(
        r#"#!/bin/sh
# Installs or updates seraph from {origin}
set -e
want="{platform}"
have="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
if [ "$have" != "$want" ]; then
  echo "This computer is $have, but {origin} runs $want, so its copy won't run here." >&2
  echo "Build it from the repo instead: ./install.sh" >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin"
tmp="$HOME/.local/bin/.seraph.download"
curl -fsSL "{origin}/download/seraph" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$HOME/.local/bin/seraph"
seraph="$HOME/.local/bin/seraph"
echo "Installed $("$seraph" --version) in $HOME/.local/bin"
if "$seraph" status 2>/dev/null | grep -q "Controller: running"; then
  "$seraph" restart
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo 'Add this to your shell profile: export PATH="$HOME/.local/bin:$PATH"' ;;
esac
if [ ! -f "${{SERAPH_HOME:-$HOME/.seraph}}/config.json" ]; then
  echo "Next: seraph setup (with the same project URL and keys as your other computers), then seraph start"
fi
"#,
        platform = platform()
    )
}

fn serve(request: tiny_http::Request) {
    let url_path = request.url().split('?').next().unwrap_or("/").to_string();
    let host = request.headers().iter().find(|h| h.field.equiv("Host")).map(|h| h.value.to_string()).unwrap_or_default();
    if url_path == "/install" {
        // Reached through Tailscale's HTTPS, or plainly on this machine.
        let local = LOOPBACK.contains(&host.rsplit_once(':').map_or(host.as_str(), |(h, _)| h));
        let origin = format!("{}://{host}", if local { "http" } else { "https" });
        let res = tiny_http::Response::from_string(install_script(&origin)).with_header(header("Content-Type", "text/x-shellscript"));
        let _ = request.respond(res);
        return;
    }
    if url_path == "/download/seraph" {
        match fs::File::open(config::exe()) {
            Ok(f) => {
                let _ = request.respond(tiny_http::Response::from_file(f).with_header(header("Content-Type", "application/octet-stream")));
            }
            Err(e) => {
                let _ = request.respond(tiny_http::Response::from_string(e.to_string()).with_status_code(500));
            }
        }
        return;
    }
    // The page itself is hosted elsewhere (e.g. Vercel); point there.
    let page = config::load().page_url.unwrap_or_else(|| "not set: run `seraph setup --page-url <address>`".into());
    let _ = request.respond(tiny_http::Response::from_string(format!("This is seraph's controller on {}. The page is at {page}\n", config::machine())));
}

// ---- upkeep -----------------------------------------------------------------

/// How often a controller checks in. A device seen within ACTIVE_SECS
/// (and not stopped) counts as active.
const HEARTBEAT_SECS: u64 = 600;
pub const ACTIVE_SECS: f64 = 3600.0;

fn heartbeat(controller_id: &str) -> Result<()> {
    api(
        "POST",
        "/rest/v1/controllers?on_conflict=id",
        Some(&json!({ "id": controller_id, "hostname": controller_id, "home": config::user_home(), "last_seen": now(), "stopped_at": null, "version": crate::VERSION })),
        Some("resolution=merge-duplicates,return=minimal"),
    )?;
    Ok(())
}

/// Mark sessions ended when the process behind them is gone, e.g. after a crash.
fn end_dead_sessions(hostname: &str) -> Result<()> {
    let rows = select_rows("sessions", &format!("hostname=eq.{}&status=neq.ended&select=id,pid", quote(hostname)))?;
    for row in rows {
        let Some(pid) = row["pid"].as_i64() else { continue };
        if !process_alive(pid as i32) {
            log(format!("daemon: session {} ended (its process {pid} is gone)", row["id"].as_str().unwrap_or("")));
            update("sessions", &format!("id=eq.{}", row["id"].as_str().unwrap_or("")), &json!({ "status": "ended", "ended_at": now(), "updated_at": now() }))?;
        }
    }
    Ok(())
}

/// Delete images attached to sessions that have since been deleted.
fn remove_orphan_uploads(_: &str) -> Result<()> {
    let Ok(entries) = fs::read_dir(config::uploads_dir()) else { return Ok(()) };
    let id = Regex::new(r"^[0-9a-f-]{36}$")?;
    let folders: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|f| id.is_match(f)).collect();
    if folders.is_empty() {
        return Ok(());
    }
    let alive: Vec<String> = select_rows("sessions", &format!("id=in.({})&select=id", folders.join(",")))?
        .iter()
        .filter_map(|r| r["id"].as_str().map(str::to_string))
        .collect();
    for folder in folders.iter().filter(|f| !alive.contains(f)) {
        let _ = fs::remove_dir_all(config::uploads_dir().join(folder));
    }
    Ok(())
}

/// How many transcript lines and hook events each session keeps.
pub const KEEP: usize = 50;

/// Drop everything the page no longer needs (see the csc_purge migration).
fn purge(_: &str) -> Result<()> {
    api("POST", "/rest/v1/rpc/csc_purge", Some(&json!({ "keep": KEEP })), None)?;
    Ok(())
}

fn every(last: &mut Option<Instant>, secs: u64) -> bool {
    if last.is_none_or(|t| t.elapsed().as_secs() >= secs) {
        *last = Some(Instant::now());
        return true;
    }
    false
}

/// A named upkeep job, run with the controller's name.
type Step = (&'static str, fn(&str) -> Result<()>);

fn run_steps(controller_id: &str, steps: &[Step]) {
    // Each step on its own, so one slow call doesn't skip the others.
    for (name, step) in steps {
        if let Err(e) = step(controller_id) {
            log(format!("daemon {name}: {e}"));
        }
    }
}

/// The page waits 30 seconds for an answer; a request older than this is stale.
const REQUEST_EXPIRES_SECS: f64 = 120.0;

fn run_requests(controller_id: &str) -> Result<()> {
    let cmds = select_rows(
        "commands",
        &format!("session_id=is.null&status=eq.pending&or=(target.is.null,target.eq.{})&order=id&select=id,kind,payload,created_at", quote(controller_id)),
    )?;
    for cmd in cmds {
        let id = cmd["id"].as_i64().unwrap_or(0);
        if !claim(id)? {
            continue; // another computer got it first
        }
        // Asked while this controller wasn't running: the page gave up long
        // ago, so starting or resuming a session now would come out of nowhere.
        if cmd["created_at"].as_str().is_some_and(|t| crate::util::age_secs(t) > REQUEST_EXPIRES_SECS) {
            log(format!("daemon: request {id} {} expired (asked at {})", cmd["kind"].as_str().unwrap_or(""), cmd["created_at"].as_str().unwrap_or("")));
            finish_command(id, None, Some("Expired: this computer's controller wasn't running when it was asked.".into()))?;
            continue;
        }
        let kind = cmd["kind"].as_str().unwrap_or("");
        let started = Instant::now();
        match handle(&cmd) {
            Ok(result) => {
                log(format!("daemon: request {id} {kind} done in {} ms {}", started.elapsed().as_millis(), result["session_id"].as_str().map(|s| format!("(session {s})")).unwrap_or_default()));
                finish_command(id, Some(result), None)?
            }
            Err(e) => {
                log(format!("daemon: request {id} {kind} failed: {e}"));
                finish_command(id, None, Some(readable(&e)))?;
            }
        }
    }
    Ok(())
}

pub fn cmd_daemon() -> Result<i32> {
    let s = config::require()?;
    let controller_id = config::machine();
    // Every computer signs pushes with the project's shared key.
    if let Err(e) = push::sync_key() {
        log(format!("daemon push key: {e}"));
    }

    let server = tiny_http::Server::http(("127.0.0.1", s.web_port)).map_err(|e| {
        anyhow!(
            "seraph daemon: can't use port {} ({e}). Is it already running? Try `seraph status`, or set another port with `seraph setup --web-port`.",
            s.web_port
        )
    })?;
    let server = Arc::new(server);
    for _ in 0..4 {
        let server = server.clone();
        thread::spawn(move || {
            for request in server.incoming_requests() {
                serve(request);
            }
        });
    }
    fs::create_dir_all(config::home())?;
    fs::write(config::pid_path(), std::process::id().to_string())?;

    let stop = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, stop.clone())?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, stop.clone())?;
    println!("seraph daemon: install line on http://127.0.0.1:{}/install, Supabase at {}", s.web_port, s.url);
    log(format!("daemon: started, seraph {} as {controller_id}", crate::VERSION));

    let (mut last_beat, mut last_purge, mut last_watch) = (None, None, None);
    let (mut last_ship, mut last_prune, mut last_dead_check) = (None, None, None);
    let mut watcher = push::Watcher::default();
    while !stop.load(Ordering::Relaxed) {
        if every(&mut last_watch, 3) {
            if let Err(e) = watcher.check(&controller_id) {
                log(format!("daemon push: {e}"));
            }
        }
        if every(&mut last_purge, 60) {
            run_steps(&controller_id, &[("purge", purge), ("remove_orphan_uploads", remove_orphan_uploads)]);
        }
        if every(&mut last_ship, 60) {
            run_steps(&controller_id, &[("ship_logs", crate::logship::ship)]);
        }
        if every(&mut last_prune, 3600) {
            run_steps(&controller_id, &[("prune_logs", crate::logship::prune)]);
        }
        if every(&mut last_beat, HEARTBEAT_SECS) {
            run_steps(&controller_id, &[("heartbeat", heartbeat)]);
        }
        if every(&mut last_dead_check, 10) {
            run_steps(&controller_id, &[("end_dead_sessions", end_dead_sessions)]);
        }
        if let Err(e) = run_requests(&controller_id) {
            log(format!("daemon: {e}"));
        }
        for _ in 0..10 {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    // A clean exit, so launchd/systemd don't restart it after `seraph stop`.
    log("daemon: stopping");
    // Inactive straight away, rather than an hour from now.
    if let Err(e) = update("controllers", &format!("id=eq.{}", quote(&controller_id)), &json!({ "stopped_at": now() })) {
        log(format!("daemon stopped_at: {e}"));
    }
    // Send what's left, so the last lines before a stop aren't held back.
    if let Err(e) = crate::logship::ship(&controller_id) {
        log(format!("daemon ship_logs: {e}"));
    }
    let _ = fs::remove_file(config::pid_path());
    Ok(0)
}
