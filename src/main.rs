//! The `seraph` command.

mod config;
mod daemon;
mod embedded;
mod hook;
mod link;
mod push;
mod service;
mod setup;
mod supa;
mod transcript;
mod users;
mod util;
mod wrapper;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::process::Command;
use supa::{quote, select_rows};
use util::which;

const USAGE: &str = "\
csc: control Claude Code sessions from a web page, through Supabase.

Get going
  seraph setup                connect to Supabase (local Docker or your own project)
  seraph start                run the controller in the background
  seraph open                 open the web page
  seraph user add <email>     let that account sign in to the page

Every day
  seraph claude [args...]     use instead of `claude`; takes all of Claude's flags
  seraph sessions             recent sessions
  seraph resume [name|id]     pick up an earlier session where it left off
  !seraph link                inside a running Claude: show it on the page (read-only)

Look after it
  seraph status               is everything running?
  seraph doctor               check each part and say how to fix what isn't
  seraph stop | restart       stop or restart the controller
  seraph logs [-f]            controller logs
  seraph service install      start the controller when you log in (uninstall to undo)
  seraph tailscale            reach the page from your other devices
  seraph user list | remove   who can sign in to the page
  seraph user code <email>    print a sign-in code, instead of emailing one
  seraph db push              install or update the database tables
  seraph uninstall [--purge]  remove seraph from this machine
  seraph --version            which build this is

Update: ./install.sh in the repo, or rerun the install line on other devices.
";

/// A subcommand's arguments: `--flag value`, `--flag`, and positionals.
struct Args {
    rest: Vec<String>,
}

impl Args {
    fn new(args: &[String]) -> Self {
        Args { rest: args.to_vec() }
    }

    /// Remove and return `--name value` (or `--name=value`).
    fn value(&mut self, names: &[&str]) -> Result<Option<String>> {
        for i in 0..self.rest.len() {
            let arg = self.rest[i].clone();
            for name in names {
                if arg == *name {
                    if i + 1 >= self.rest.len() {
                        bail!("{name} needs a value");
                    }
                    let v = self.rest.remove(i + 1);
                    self.rest.remove(i);
                    return Ok(Some(v));
                }
                if let Some(v) = arg.strip_prefix(&format!("{name}=")) {
                    self.rest.remove(i);
                    return Ok(Some(v.to_string()));
                }
            }
        }
        Ok(None)
    }

    fn flag(&mut self, names: &[&str]) -> bool {
        match self.rest.iter().position(|a| names.contains(&a.as_str())) {
            Some(i) => {
                self.rest.remove(i);
                true
            }
            None => false,
        }
    }

    fn number<T: std::str::FromStr>(&mut self, names: &[&str]) -> Result<Option<T>> {
        self.value(names)?
            .map(|v| v.parse::<T>().map_err(|_| anyhow!("{} needs a number", names[0])))
            .transpose()
    }

    /// What's left, which must be only positionals.
    fn positionals(self) -> Result<Vec<String>> {
        if let Some(unknown) = self.rest.iter().find(|a| a.starts_with('-')) {
            bail!("Unknown option {unknown}. See `seraph --help`.");
        }
        Ok(self.rest)
    }
}

// ---- version / uninstall ----------------------------------------------------

/// "0.2.0 (built 2026-10-19 14:02)": the build time tells devices' copies apart.
pub const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (built ", env!("SERAPH_BUILT"), ")");

fn cmd_uninstall(purge: bool) -> Result<i32> {
    if service::service_installed() {
        service::cmd_service("uninstall")?;
    }
    if service::daemon_pid().is_some() {
        service::cmd_stop()?;
    }
    let sql = embedded::project_dir()?.join("supabase").join("uninstall.sql");
    if purge {
        let _ = std::fs::remove_dir_all(config::home());
        println!("Deleted {} (settings, logs, uploaded images)", config::home().display());
    } else {
        println!("Kept {} (settings, logs, uploaded images); add --purge to delete it.", config::home().display());
    }
    let exe = config::exe();
    std::fs::remove_file(&exe)?;
    println!("Removed {}", exe.display());
    println!(
        "\nLeft alone: the data in Supabase. To remove the tables, run uninstall.sql in the SQL editor{}.",
        if purge { String::new() } else { format!(" (it's at {})", sql.display()) }
    );
    Ok(0)
}

// ---- open / tailscale -------------------------------------------------------

fn cmd_open() -> Result<i32> {
    let url = service::page_url();
    if service::daemon_pid().is_none() {
        println!("The controller isn't running; starting it…");
        if service::cmd_start()? != 0 {
            return Ok(1);
        }
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    if which(opener).is_some() {
        let _ = Command::new(opener).arg(&url).status();
    }
    println!("{url}");
    Ok(0)
}

/// Serve the page (and a local Supabase) on this machine's Tailscale address.
fn cmd_tailscale(web_port: u16, api_port: u16, off: bool) -> Result<i32> {
    if which("tailscale").is_none() {
        bail!("Tailscale isn't installed.");
    }
    let s = config::require()?;
    let serve = |port: u16, target: &str| -> Result<()> {
        let args = ["serve".to_string(), "--bg".into(), format!("--https={port}"), if off { "off".into() } else { target.to_string() }];
        let out = Command::new("tailscale").args(&args).output()?;
        if !out.status.success() {
            bail!("`tailscale {}` failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(())
    };
    let status: Value = serde_json::from_slice(&Command::new("tailscale").args(["status", "--json"]).output()?.stdout)?;
    let host = status["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.').to_string();

    serve(web_port, &format!("http://127.0.0.1:{}", s.web_port))?;
    if setup::is_local(&s.url) {
        let port = url::Url::parse(&s.url)?.port_or_known_default().unwrap_or(80);
        serve(api_port, &format!("http://127.0.0.1:{port}"))?;
        // The page runs on other devices, so it needs Supabase's Tailscale address too.
        if off {
            config::remove(&["browser_supabase_url"])?;
        } else {
            config::save(&[("browser_supabase_url", Some(json!(format!("https://{host}:{api_port}"))))])?;
        }
    }
    if off {
        println!("Stopped serving on Tailscale.");
    } else {
        println!("On your tailnet: https://{host}:{web_port}");
    }
    Ok(0)
}

// ---- sessions / resume ------------------------------------------------------

fn recent_sessions(limit: usize) -> Result<Vec<Value>> {
    let rows = select_rows(
        "sessions",
        &format!(
            "order=updated_at.desc&limit=200&hostname=eq.{}&select=id,name,cwd,status,mode,claude_session_id,updated_at",
            quote(&config::machine())
        ),
    )?;
    // One entry per Claude conversation: a resumed session repeats the id.
    let mut seen = std::collections::HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|r| seen.insert(r["claude_session_id"].as_str().or(r["id"].as_str()).unwrap_or("").to_string()))
        .take(limit)
        .collect())
}

fn label(row: &Value) -> String {
    let cwd = row["cwd"].as_str().unwrap_or("");
    let short = cwd.replacen(&config::user_home(), "~", 1);
    let name = row["name"].as_str().map(str::to_string).unwrap_or_else(|| cwd.rsplit('/').next().unwrap_or(cwd).to_string());
    format!("{name}  ({short})")
}

fn cmd_sessions(limit: usize) -> Result<i32> {
    let rows = recent_sessions(limit)?;
    if rows.is_empty() {
        println!("No sessions yet. Start one with `seraph claude`, or from the page.");
        return Ok(0);
    }
    for (i, row) in rows.iter().enumerate() {
        let when: String = row["updated_at"].as_str().unwrap_or("").chars().take(16).collect::<String>().replace('T', " ");
        let id: String = row["id"].as_str().unwrap_or("").chars().take(8).collect();
        println!("{:>3}. {:<8} {when}  {}  {id}", i + 1, row["status"].as_str().unwrap_or(""), label(row));
    }
    Ok(0)
}

fn cmd_resume(query: Option<String>, claude_args: Vec<String>) -> Result<i32> {
    let mut rows: Vec<Value> = recent_sessions(50)?.into_iter().filter(|r| r["claude_session_id"].is_string()).collect();
    if let Some(q) = query.map(|q| q.to_lowercase()) {
        rows.retain(|r| {
            let s = |k: &str| r[k].as_str().unwrap_or("").to_lowercase();
            s("id").starts_with(&q) || s("claude_session_id").starts_with(&q) || s("name").contains(&q) || s("cwd").contains(&q)
        });
    }
    if rows.is_empty() {
        bail!("No matching session. See `seraph sessions`.");
    }
    if rows.len() > 1 {
        if !util::stdin_is_tty() {
            bail!("More than one session matches; be more specific.");
        }
        for (i, row) in rows.iter().take(15).enumerate() {
            println!("{:>3}. {:<8} {}", i + 1, row["status"].as_str().unwrap_or(""), label(row));
        }
        let choice: usize = util::ask("Resume which?", Some("1")).unwrap_or_default().parse().map_err(|_| anyhow!("Pick a number."))?;
        let picked = rows.get(choice.wrapping_sub(1)).cloned().ok_or_else(|| anyhow!("No session {choice}."))?;
        rows = vec![picked];
    }
    let row = &rows[0];
    if row["status"] != "ended" && row["mode"] != "linked" {
        println!("Note: that session looks like it's still running ({}); resuming opens a second copy.", row["status"].as_str().unwrap_or(""));
    }
    let cwd = row["cwd"].as_str().unwrap_or("");
    if !std::path::Path::new(cwd).is_dir() {
        bail!("Its folder is gone: {cwd}");
    }
    std::env::set_current_dir(cwd)?;
    println!("Resuming {}", label(row));
    let mut args = vec!["--resume".to_string(), row["claude_session_id"].as_str().unwrap_or("").to_string()];
    args.extend(claude_args);
    wrapper::cmd_claude(&args)
}

fn cmd_status() -> Result<i32> {
    let s = config::load();
    println!("Supabase:   {}", s.supabase_url.clone().unwrap_or_else(|| "not set up (run `seraph setup`)".into()));
    match service::daemon_pid() {
        Some(pid) => println!("Controller: running, pid {pid}"),
        None => println!("Controller: stopped (run `seraph start`)"),
    }
    println!("Page:       {}", service::page_url());
    println!("At login:   {}", if service::service_installed() { "on" } else { "off" });
    if push::key_path().exists() {
        if let Ok(key) = push::public_key() {
            println!("Push key:   {key}");
        }
    }
    if s.supabase_url.is_some() && s.supabase_secret_key.is_some() {
        match select_rows("sessions", "status=neq.ended&select=id") {
            Ok(running) => println!("Sessions:   {} running", running.len()),
            Err(e) => println!("Sessions:   couldn't ask Supabase ({e}); try `seraph doctor`"),
        }
        let me = config::machine();
        for c in setup::online_computers().unwrap_or_default() {
            let (name, version) = (c["id"].as_str().unwrap_or("?"), c["version"].as_str().unwrap_or("unknown version"));
            let note = if name == me { "this computer" } else if version == VERSION { "same build" } else { "different build: update it" };
            println!("Computer:   {name}  {version}  ({note})");
        }
    }
    Ok(0)
}

// ---- dispatch ---------------------------------------------------------------

fn dispatch(argv: &[String]) -> Result<i32> {
    let Some(command) = argv.first().map(String::as_str) else {
        println!("{USAGE}");
        return Ok(0);
    };
    let rest = &argv[1..];
    let mut args = Args::new(rest);
    match command {
        "-V" | "--version" | "version" => {
            println!("seraph {VERSION}");
            Ok(0)
        }
        "-h" | "--help" | "help" => {
            println!("{USAGE}");
            Ok(0)
        }
        // These pass their arguments straight through.
        "claude" => wrapper::cmd_claude(rest),
        "_follow" => link::cmd_follow(rest),
        "_hook" => Ok(hook::cmd_hook(rest)),
        "setup" => {
            let parsed = setup::SetupArgs {
                local: args.flag(&["--local"]),
                url: args.value(&["--url"])?,
                key: args.value(&["--key"])?,
                secret_key: args.value(&["--secret-key"])?,
                db_url: args.value(&["--db-url"])?,
                browser_url: args.value(&["--browser-url"])?,
                web_port: args.number(&["--web-port"])?,
                claude_bin: args.value(&["--claude-bin"])?,
            };
            args.positionals()?;
            setup::cmd_setup(parsed)
        }
        "db" => {
            let db_url = args.value(&["--db-url"])?;
            match args.positionals()?.as_slice() {
                [a] if a == "push" => setup::cmd_db_push(db_url.as_deref()),
                _ => bail!("Usage: seraph db push [--db-url URL]"),
            }
        }
        "doctor" => setup::cmd_doctor(),
        "status" => cmd_status(),
        "start" => service::cmd_start(),
        "stop" => service::cmd_stop(),
        "restart" => service::cmd_restart(),
        "daemon" => daemon::cmd_daemon(),
        "logs" => {
            let follow = args.flag(&["-f", "--follow"]);
            let lines = args.number(&["-n", "--lines"])?.unwrap_or(40);
            args.positionals()?;
            service::cmd_logs(follow, lines)
        }
        "service" => match args.positionals()?.as_slice() {
            [action] => service::cmd_service(action),
            _ => bail!("Usage: seraph service install | uninstall | status"),
        },
        "tailscale" => {
            let web_port = args.number(&["--web-port"])?.unwrap_or(8446);
            let api_port = args.number(&["--api-port"])?.unwrap_or(8447);
            let off = args.flag(&["--off"]);
            args.positionals()?;
            cmd_tailscale(web_port, api_port, off)
        }
        "user" => match args.positionals()?.as_slice() {
            [action] => users::cmd_user(action, None),
            [action, email] => users::cmd_user(action, Some(email)),
            _ => bail!("Usage: seraph user add | remove | list | code [email]"),
        },
        "sessions" => {
            let limit = args.number(&["-n", "--limit"])?.unwrap_or(20);
            args.positionals()?;
            cmd_sessions(limit)
        }
        "resume" => {
            // Anything after the query goes to Claude untouched.
            let (query, claude_args) = match rest.first() {
                Some(q) if !q.starts_with('-') => (Some(q.clone()), rest[1..].to_vec()),
                _ => (None, rest.to_vec()),
            };
            cmd_resume(query, claude_args)
        }
        "link" => link::cmd_link(),
        "unlink" => link::cmd_unlink(),
        "open" => cmd_open(),
        "uninstall" => {
            let purge = args.flag(&["--purge"]);
            args.positionals()?;
            cmd_uninstall(purge)
        }
        other => {
            eprintln!("csc: unknown command `{other}`.\n\n{USAGE}");
            Ok(2)
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    config::move_old_home();
    // Short commands stop quietly when their output is cut off (`seraph status | head`).
    // The long-running ones keep ignoring it: a closed browser connection or
    // terminal must not kill the controller or a session.
    if !matches!(argv.first().map(String::as_str), Some("daemon" | "claude" | "resume" | "_hook" | "_follow")) {
        // SAFETY: restoring the default action for one signal before any threads start.
        unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    }
    let code = match dispatch(&argv) {
        Ok(code) => code,
        Err(e) => {
            if let Some(reach) = e.downcast_ref::<supa::Unreachable>() {
                // One clear line when Supabase is slow or down.
                eprintln!("csc: couldn't reach Supabase ({reach}). `seraph doctor` checks the connection.");
            } else {
                eprintln!("{e}");
            }
            1
        }
    };
    std::process::exit(code);
}
