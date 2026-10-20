//! `seraph claude`: run Claude inside a pseudo-terminal seraph owns.
//!
//! You use Claude in your terminal as usual; the wrapper copies the screen to
//! the web page, copies the transcript into Supabase, and types in whatever the
//! page sends.

use crate::config;
use crate::supa::{api, broadcast, finish_command, log, now, select_rows, update};
use crate::transcript::follow_transcript;
use crate::util::{age_secs, shell_quote, stdin_is_tty};
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::ffi::CString;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg_attr(target_os = "linux", link(name = "util"))]
extern "C" {}

// Hook events copied to Supabase for every wrapped session.
const HOOK_EVENTS: [&str; 15] = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure",
    "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "CwdChanged",
];

/// Names the web page can send in a `keys` command.
fn key_bytes(name: &str) -> Option<&'static str> {
    Some(match name {
        "Enter" => "\r",
        "Escape" => "\x1b",
        "Tab" => "\t",
        "ShiftTab" => "\x1b[Z",
        "Up" => "\x1b[A",
        "Down" => "\x1b[B",
        "Right" => "\x1b[C",
        "Left" => "\x1b[D",
        "Backspace" => "\x7f",
        "CtrlC" => "\x03",
        "CtrlD" => "\x04",
        "CtrlO" => "\x0f",
        "CtrlR" => "\x12",
        "CtrlT" => "\x14",
        "CtrlL" => "\x0c",
        _ => return None,
    })
}

/// Images sent from the page are saved under the uploads folder, then named in the message.
fn image_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        _ => ".png",
    }
}

/// Seconds after which a queued command is dropped rather than run late.
fn stale_after(kind: &str) -> Option<f64> {
    matches!(kind, "keys" | "interrupt" | "replay").then_some(30.0)
}

const BROADCAST_CHUNK: usize = 24 * 1024; // base64 grows this by a third; stays under the payload cap
const SCROLLBACK_BYTES: usize = 512 * 1024; // replayed to a page that joins mid-session

/// Your own status line, if you have one: the first found in this folder's
/// .claude/settings.local.json, .claude/settings.json, then ~/.claude's.
fn user_status_line() -> Option<Value> {
    let home = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude");
    let project = std::env::current_dir().ok()?.join(".claude");
    [project.join("settings.local.json"), project.join("settings.json"), home.join("settings.local.json"), home.join("settings.json")]
        .iter()
        .filter_map(|p| serde_json::from_str::<Value>(&std::fs::read_to_string(p).ok()?).ok())
        .find_map(|v| v.get("statusLine").filter(|s| s["command"].is_string()).cloned())
}

/// Seraph's hooks, and its status line (which runs yours too, see status.rs).
fn hook_settings() -> String {
    let exe = shell_quote(&config::exe().to_string_lossy());
    let hook = json!({ "type": "command", "command": format!("{exe} _hook"), "async": true });
    let hooks: serde_json::Map<String, Value> =
        HOOK_EVENTS.iter().map(|e| (e.to_string(), json!([{ "hooks": [hook] }]))).collect();
    let mut status_line = json!({ "type": "command", "command": format!("{exe} _status") });
    if let Some(yours) = user_status_line() {
        std::env::set_var(crate::status::USER_COMMAND_ENV, yours["command"].as_str().unwrap_or_default());
        if let Some(padding) = yours.get("padding") {
            status_line["padding"] = padding.clone();
        }
    }
    json!({ "hooks": hooks, "statusLine": status_line }).to_string()
}

#[derive(Default)]
struct Output {
    pending: Vec<u8>,
    scrollback: Vec<u8>,
}

struct Wrapper {
    session_id: String,
    headless: bool,
    name: Option<String>,
    master: RawFd,
    child: libc::pid_t,
    cols: AtomicU16,
    rows: AtomicU16,
    write_lock: Mutex<()>,
    out: Mutex<Output>,
    seq: Mutex<u64>, // held while sending, so chunk numbers stay in order
    done: AtomicBool,
    started: Instant,
    last_output: Mutex<Instant>,
}

impl Wrapper {
    // -- setup

    fn register(&self) -> Result<()> {
        // The daemon may have created the row already; fill in the rest.
        api(
            "POST",
            "/rest/v1/sessions?on_conflict=id",
            Some(&json!({
                "id": self.session_id,
                "name": self.name,
                "cwd": std::env::current_dir()?.to_string_lossy(),
                "hostname": config::machine(),
                "pid": std::process::id(),
                "mode": if self.headless { "headless" } else { "wrapped" },
                "cols": self.cols.load(Ordering::Relaxed),
                "rows": self.rows.load(Ordering::Relaxed),
            })),
            Some("resolution=merge-duplicates,return=minimal"),
        )?;
        Ok(())
    }

    fn set_size(&self, cols: u16, rows: u16) {
        self.cols.store(cols, Ordering::Relaxed);
        self.rows.store(rows, Ordering::Relaxed);
        let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
        // SAFETY: TIOCSWINSZ reads a winsize from the pointer; the master fd is ours.
        unsafe {
            libc::ioctl(self.master, libc::TIOCSWINSZ, &ws);
            libc::kill(self.child, libc::SIGWINCH);
        }
    }

    // -- terminal output

    fn on_output(&self, data: &[u8]) {
        *self.last_output.lock().unwrap() = Instant::now();
        let mut out = self.out.lock().unwrap();
        out.pending.extend_from_slice(data);
        out.scrollback.extend_from_slice(data);
        if out.scrollback.len() > SCROLLBACK_BYTES {
            let extra = out.scrollback.len() - SCROLLBACK_BYTES;
            out.scrollback.drain(..extra);
        }
    }

    fn topic(&self) -> String {
        format!("term:{}", self.session_id)
    }

    fn out_message(&self, seq: u64, chunk: &[u8]) -> Value {
        json!({ "topic": self.topic(), "event": "out", "private": true, "payload": { "seq": seq, "data": B64.encode(chunk) } })
    }

    fn send_output_loop(&self) {
        while !self.done.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(50));
            let mut seq = self.seq.lock().unwrap();
            self.send_pending(&mut seq);
        }
    }

    fn send_pending(&self, seq: &mut u64) {
        let data = std::mem::take(&mut self.out.lock().unwrap().pending);
        if data.is_empty() {
            return;
        }
        let mut next = *seq;
        let messages: Vec<Value> = data
            .chunks(BROADCAST_CHUNK)
            .map(|c| {
                next += 1;
                self.out_message(next, c)
            })
            .collect();
        match broadcast(&messages) {
            Ok(()) => *seq = next,
            Err(e) => {
                // A dropped chunk would leave the web copy of the screen wrong,
                // so put it back and send it with the next batch.
                log(format!("broadcast: {e}"));
                let mut out = self.out.lock().unwrap();
                let mut restored = data;
                restored.extend_from_slice(&out.pending);
                out.pending = restored;
                drop(out);
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    /// Send the recent screen history so a page that just opened can catch up.
    fn replay(&self) -> Result<()> {
        let mut seq = self.seq.lock().unwrap();
        let data = {
            let mut out = self.out.lock().unwrap();
            out.pending.clear();
            out.scrollback.clone()
        };
        *seq += 1;
        let mut messages = vec![json!({
            "topic": self.topic(), "event": "reset", "private": true,
            "payload": { "seq": *seq, "cols": self.cols.load(Ordering::Relaxed), "rows": self.rows.load(Ordering::Relaxed) },
        })];
        for chunk in data.chunks(BROADCAST_CHUNK) {
            *seq += 1;
            messages.push(self.out_message(*seq, chunk));
        }
        for batch in messages.chunks(8) {
            broadcast(batch)?;
        }
        Ok(())
    }

    // -- input from the web page

    fn type_in(&self, text: &str) -> Result<()> {
        let _guard = self.write_lock.lock().unwrap();
        write_all(self.master, text.as_bytes())
    }

    /// Write images sent from the page to disk; return text naming them for Claude.
    fn save_images(&self, cmd_id: i64, images: &[Value]) -> Result<String> {
        if images.is_empty() {
            return Ok(String::new());
        }
        let folder = config::uploads_dir().join(&self.session_id);
        std::fs::create_dir_all(&folder)?;
        let mut paths = Vec::new();
        for (i, image) in images.iter().enumerate() {
            let path = folder.join(format!("{cmd_id}-{i}{}", image_ext(image["type"].as_str().unwrap_or(""))));
            std::fs::write(&path, B64.decode(image["data"].as_str().unwrap_or(""))?)?;
            paths.push(format!("(Attached image: {})", path.display()));
        }
        Ok(format!("\n\n{}", paths.join("\n")))
    }

    /// True once Claude has started and drawn its prompt.
    fn session_ready(&self) -> Result<bool> {
        if self.last_output.lock().unwrap().elapsed() < Duration::from_millis(500) {
            return Ok(false);
        }
        // If the SessionStart hook's update got lost, a quiet screen after
        // 20 seconds is good enough.
        if self.started.elapsed() > Duration::from_secs(20) {
            return Ok(true);
        }
        let rows = select_rows("sessions", &format!("id=eq.{}&select=status", self.session_id))?;
        Ok(rows.first().is_some_and(|r| r["status"] != "starting"))
    }

    fn run_command(&self, cmd: &Value) -> Result<()> {
        let id = cmd["id"].as_i64().unwrap_or(0);
        let payload = &cmd["payload"];
        match cmd["kind"].as_str().unwrap_or("") {
            "prompt" => {
                let images = payload["images"].as_array().cloned().unwrap_or_default();
                let original = payload["text"].as_str().unwrap_or("");
                let text = format!("{original}{}", self.save_images(id, &images)?);
                if !images.is_empty() {
                    // The images are on disk now; don't keep copies in the database.
                    let kept: Vec<Value> = images.iter().map(|i| json!({ "name": i["name"], "type": i["type"] })).collect();
                    update("commands", &format!("id=eq.{id}"), &json!({ "payload": { "text": original, "images": kept } }))?;
                }
                if text.starts_with('/') && !text.contains('\n') {
                    // Type slash commands like a person would: pasted text isn't
                    // always treated as a command, and may go to Claude as a message.
                    self.type_in(&text)?;
                    thread::sleep(Duration::from_millis(500));
                } else {
                    // Bracketed paste keeps newlines inside one message.
                    self.type_in(&format!("\x1b[200~{text}\x1b[201~"))?;
                    thread::sleep(Duration::from_millis(150));
                }
                self.type_in("\r")?;
            }
            "keys" => {
                if let Some(data) = payload["data"].as_str() {
                    self.type_in(data)?;
                }
                for key in payload["keys"].as_array().into_iter().flatten() {
                    let key = key.as_str().unwrap_or("");
                    self.type_in(key_bytes(key).unwrap_or(key))?;
                    thread::sleep(Duration::from_millis(50));
                }
            }
            "interrupt" => self.type_in("\x1b")?,
            "resize" => {
                if !self.headless {
                    bail!("this session's size follows its own terminal");
                }
                let num = |k: &str| payload[k].as_u64().or_else(|| payload[k].as_str()?.parse().ok());
                let (Some(cols), Some(rows)) = (num("cols"), num("rows")) else { bail!("resize needs cols and rows") };
                self.set_size(cols as u16, rows as u16);
                update("sessions", &format!("id=eq.{}", self.session_id), &json!({ "cols": cols, "rows": rows }))?;
            }
            "replay" => self.replay()?,
            // SAFETY: signalling our own child.
            "kill" => unsafe {
                libc::kill(self.child, libc::SIGHUP);
            },
            other => bail!("unknown command: {other}"),
        }
        Ok(())
    }

    fn command_loop(&self) {
        // Any error here (Supabase slow or down) is logged and retried; if it
        // escaped, the page could never send this session anything again.
        while !self.done.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(400));
            if let Err(e) = self.run_pending_commands() {
                log(format!("commands: {e}"));
            }
        }
    }

    fn run_pending_commands(&self) -> Result<()> {
        let cmds = select_rows(
            "commands",
            &format!("session_id=eq.{}&status=eq.pending&order=id&select=id,kind,payload,created_at", self.session_id),
        )?;
        let mut holding = false;
        for cmd in &cmds {
            let id = cmd["id"].as_i64().unwrap_or(0);
            let kind = cmd["kind"].as_str().unwrap_or("");
            // A key press meant for what was on screen then could do
            // something else now (e.g. a "1" typed into the prompt), so drop
            // stale ones. Messages still go through whenever they arrive.
            if let Some(limit) = stale_after(kind) {
                if age_secs(cmd["created_at"].as_str().unwrap_or("")) > limit {
                    finish_command(id, None, Some("expired: arrived too late to be safe to press".into()))?;
                    continue;
                }
            }
            // Text typed before Claude is ready would land in a startup dialog
            // or be dropped, so hold prompts (in order) until it is. Keys and
            // screen requests still go through, so the page can see and answer
            // whatever Claude is showing.
            if kind == "prompt" && (holding || !self.session_ready()?) {
                holding = true;
                continue;
            }
            match self.run_command(cmd) {
                Ok(()) => {
                    // Kind and size only: what was typed stays private. Keystrokes,
                    // resizes and screen copies come many a second; they'd drown the rest.
                    if !matches!(kind, "keys" | "resize" | "replay") {
                        let size = cmd["payload"]["text"].as_str().map(|t| format!(" ({} chars)", t.chars().count())).unwrap_or_default();
                        log(format!("session {}: command {id} {kind}{size}", self.session_id));
                    }
                    finish_command(id, None, None)?
                }
                Err(e) => {
                    log(format!("session {}: command {id} {kind} failed: {e}", self.session_id));
                    finish_command(id, None, Some(e.to_string()))?;
                }
            }
        }
        Ok(())
    }

    /// Keep trying to register; the session still works locally meanwhile.
    fn register_when_possible(&self) {
        let mut delay = 2;
        while !self.done.load(Ordering::Relaxed) {
            match self.register() {
                Ok(()) => return,
                Err(e) => {
                    log(format!("register: {e}"));
                    thread::sleep(Duration::from_secs(delay));
                    delay = (delay * 2).min(30);
                }
            }
        }
    }

    fn on_resize(&self) {
        let Some((cols, rows)) = terminal_size(1) else { return };
        self.set_size(cols, rows);
        if let Err(e) = update("sessions", &format!("id=eq.{}", self.session_id), &json!({ "cols": cols, "rows": rows })) {
            log(format!("size: {e}"));
        }
    }
}

fn write_all(fd: RawFd, mut data: &[u8]) -> Result<()> {
    while !data.is_empty() {
        // SAFETY: writing from a valid slice to an open descriptor.
        let n = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
        if n < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err.into());
        }
        data = &data[n as usize..];
    }
    Ok(())
}

fn read_fd(fd: RawFd, buf: &mut [u8]) -> std::io::Result<usize> {
    loop {
        // SAFETY: reading into a valid buffer from an open descriptor.
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n >= 0 {
            return Ok(n as usize);
        }
        let err = std::io::Error::last_os_error();
        if err.kind() != std::io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

fn terminal_size(fd: RawFd) -> Option<(u16, u16)> {
    let mut ws = libc::winsize { ws_row: 0, ws_col: 0, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: TIOCGWINSZ fills the winsize we pass.
    let ok = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) } == 0;
    (ok && ws.ws_col > 0).then_some((ws.ws_col, ws.ws_row))
}

/// Start Claude on a new pseudo-terminal. Returns (master fd, child pid).
fn spawn(claude_bin: &str, claude_args: &[String], session_id: &str, cols: u16, rows: u16) -> Result<(RawFd, libc::pid_t)> {
    // The hooks read the secret key from seraph's config file. It isn't put
    // in the environment, where every command Claude runs would see it.
    std::env::set_var("SERAPH_SESSION", session_id);
    let mut argv = vec![claude_bin.to_string(), "--settings".into(), hook_settings()];
    argv.extend_from_slice(claude_args);
    // Built before forking: the child must only exec.
    let c_args: Vec<CString> = argv.iter().map(|a| CString::new(a.as_str())).collect::<Result<_, _>>()?;
    let mut c_ptrs: Vec<*const libc::c_char> = c_args.iter().map(|a| a.as_ptr()).collect();
    c_ptrs.push(std::ptr::null());

    let mut master: libc::c_int = -1;
    let mut ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: forkpty with a valid winsize; the child only calls exec/_exit.
    let pid = unsafe { libc::forkpty(&mut master, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) };
    if pid < 0 {
        return Err(anyhow!("couldn't start a terminal: {}", std::io::Error::last_os_error()));
    }
    if pid == 0 {
        // SAFETY: in the child, exec Claude or exit.
        unsafe {
            libc::execvp(c_ptrs[0], c_ptrs.as_ptr());
            libc::_exit(127);
        }
    }
    Ok((master, pid))
}

/// Raw mode for the person's terminal, so every key goes straight to Claude.
struct RawTerminal(libc::termios);

impl RawTerminal {
    fn enable() -> Result<Self> {
        // SAFETY: plain termios calls on stdin.
        unsafe {
            let mut old: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut old) != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut raw = old;
            libc::cfmakeraw(&mut raw);
            libc::tcsetattr(0, libc::TCSANOW, &raw);
            Ok(RawTerminal(old))
        }
    }
}

impl Drop for RawTerminal {
    fn drop(&mut self) {
        // SAFETY: restoring the settings we saved.
        unsafe {
            libc::tcsetattr(0, libc::TCSADRAIN, &self.0);
        }
    }
}

fn run(w: Arc<Wrapper>) -> Result<i32> {
    for job in [Wrapper::send_output_loop as fn(&Wrapper), Wrapper::command_loop] {
        let w = w.clone();
        thread::spawn(move || job(&w));
    }
    {
        let w = w.clone();
        thread::spawn(move || follow_transcript(&w.session_id, &w.done, false));
    }

    let _raw = if w.headless {
        None
    } else {
        let w2 = w.clone();
        let mut signals = signal_hook::iterator::Signals::new([libc::SIGWINCH])?;
        thread::spawn(move || {
            for _ in signals.forever() {
                w2.on_resize();
            }
        });
        Some(RawTerminal::enable()?)
    };

    let mut buf = vec![0u8; 65536];
    loop {
        let mut fds = vec![libc::pollfd { fd: w.master, events: libc::POLLIN, revents: 0 }];
        if !w.headless {
            fds.push(libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 });
        }
        // SAFETY: polling descriptors we own.
        let n = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) };
        if n < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            match read_fd(w.master, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    w.on_output(&buf[..n]);
                    if !w.headless {
                        let _ = write_all(1, &buf[..n]);
                    }
                }
            }
        }
        if !w.headless && fds[1].revents & libc::POLLIN != 0 {
            if let Ok(n) = read_fd(0, &mut buf) {
                if n > 0 {
                    let _guard = w.write_lock.lock().unwrap();
                    let _ = write_all(w.master, &buf[..n]);
                }
            }
        }
    }
    drop(_raw);

    let mut status = 0;
    // SAFETY: reaping our own child.
    unsafe { libc::waitpid(w.child, &mut status, 0) };
    log(format!("session {}: Claude exited ({})", w.session_id, if libc::WIFEXITED(status) { format!("code {}", libc::WEXITSTATUS(status)) } else { format!("signal {}", libc::WTERMSIG(status)) }));
    thread::sleep(Duration::from_millis(200)); // let the last output go out
    w.done.store(true, Ordering::Relaxed);
    if let Err(e) = update(
        "sessions",
        &format!("id=eq.{}", w.session_id),
        &json!({ "status": "ended", "ended_at": now(), "updated_at": now() }),
    ) {
        log(format!("end: {e}"));
    }
    Ok(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) })
}

pub fn cmd_claude(args: &[String]) -> Result<i32> {
    // Without seraph set up, behave like plain `claude` so an alias still works.
    let settings = match config::require() {
        Ok(s) => s,
        Err(_) => {
            eprintln!("csc: not set up (run `seraph setup`); starting plain Claude.");
            let claude = config::load().claude_bin;
            let err = exec(&claude, args.iter().filter(|a| !a.starts_with("--seraph-")).cloned().collect());
            bail!("couldn't start {claude}: {err}");
        }
    };
    let (mut headless, mut session_id, mut name) = (false, uuid::Uuid::new_v4().to_string(), None);
    // This computer's controller is what lets the page start, resume and
    // restart sessions here, so make sure it's running.
    if !args.iter().any(|a| a == "--seraph-headless") && crate::service::daemon_pid().is_none() {
        let started = crate::util::detach(std::process::Command::new(config::exe()).arg("start").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())).spawn();
        if started.is_ok() {
            eprintln!("seraph: started this computer's controller, so the page can manage its sessions.");
        }
    }
    let (mut cols, mut rows) = (120u16, 40u16);
    let mut claude_args = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--seraph-headless" => headless = true,
            "--seraph-id" => session_id = it.next().cloned().ok_or_else(|| anyhow!("--seraph-id needs a value"))?,
            "--seraph-size" => {
                let size = it.next().ok_or_else(|| anyhow!("--seraph-size needs a value"))?;
                let (c, r) = size.split_once('x').ok_or_else(|| anyhow!("--seraph-size is COLSxROWS"))?;
                (cols, rows) = (c.parse()?, r.parse()?);
            }
            "-n" | "--name" => {
                let value = it.next().cloned().unwrap_or_default();
                claude_args.push(arg.clone());
                claude_args.push(value.clone());
                name = Some(value);
            }
            _ => claude_args.push(arg.clone()),
        }
    }
    if !headless {
        if !stdin_is_tty() {
            bail!("seraph claude: needs a terminal (the daemon uses --seraph-headless)");
        }
        if let Some((c, r)) = terminal_size(1).or_else(|| terminal_size(0)) {
            (cols, rows) = (c, r);
        }
    }

    // Supabase being down shouldn't stop you using Claude. Register now if
    // we can; otherwise say so and keep trying in the background.
    // The terminal comes next; register first so the page sees the session at once.
    let mut w = Wrapper {
        session_id: session_id.clone(),
        headless,
        name,
        master: -1,
        child: 0,
        cols: AtomicU16::new(cols),
        rows: AtomicU16::new(rows),
        write_lock: Mutex::new(()),
        out: Mutex::new(Output::default()),
        seq: Mutex::new(0),
        done: AtomicBool::new(false),
        started: Instant::now(),
        last_output: Mutex::new(Instant::now()),
    };
    let registered = w.register();
    log(format!(
        "session {session_id}: starting Claude ({}) in {}",
        if headless { "from the page" } else { "in a terminal" },
        std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default()
    ));
    let (master, child) = spawn(&settings.claude_bin, &claude_args, &session_id, cols, rows)?;
    w.master = master;
    w.child = child;
    let w = Arc::new(w);
    if let Err(e) = registered {
        log(format!("register: {e}"));
        if !headless {
            eprintln!("csc: can't reach Supabase ({e}); starting Claude anyway. It will show on the page once Supabase is back.");
        }
        let w = w.clone();
        thread::spawn(move || w.register_when_possible());
    }
    run(w)
}

/// Replace this process with `program` (only returns on failure).
pub fn exec(program: &str, args: Vec<String>) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    std::process::Command::new(program).args(args).exec()
}
