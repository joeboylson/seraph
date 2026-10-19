//! Run the controller (`seraph daemon`) in the background, and optionally at login.

use crate::config;
use crate::util::{detach, process_alive, tail, wait_for};
use anyhow::{bail, Result};
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const LABEL: &str = "dev.seraph.daemon";

fn plist_path() -> PathBuf {
    config::expand(&format!("~/Library/LaunchAgents/{LABEL}.plist"))
}
fn systemd_path() -> PathBuf {
    config::expand("~/.config/systemd/user/seraph.service")
}

/// The running controller's pid, or None.
pub fn daemon_pid() -> Option<i32> {
    let pid: i32 = fs::read_to_string(config::pid_path()).ok()?.trim().parse().ok()?;
    process_alive(pid).then_some(pid)
}

pub fn service_installed() -> bool {
    plist_path().exists() || systemd_path().exists()
}

pub fn page_url() -> String {
    format!("http://127.0.0.1:{}", config::load().web_port)
}

fn macos() -> bool {
    cfg!(target_os = "macos")
}

// ---- start / stop -----------------------------------------------------------

pub fn cmd_start() -> Result<i32> {
    config::require()?;
    if let Some(pid) = daemon_pid() {
        println!("Already running (pid {pid}). Page: {}", page_url());
        return Ok(0);
    }
    if service_installed() {
        service_start();
    } else {
        fs::create_dir_all(config::home())?;
        let log = OpenOptions::new().create(true).append(true).open(config::daemon_log_path())?;
        detach(
            Command::new(config::exe())
                .arg("daemon")
                .stdin(Stdio::null())
                .stdout(log.try_clone()?)
                .stderr(log),
        )
        .spawn()?;
    }
    if !wait_for(|| daemon_pid().is_some(), 30) {
        println!("The controller didn't start. Last lines of {}:", config::daemon_log_path().display());
        println!("{}", tail(&config::daemon_log_path(), 10));
        return Ok(1);
    }
    println!("Started (pid {}). Page: {}", daemon_pid().unwrap_or(0), page_url());
    Ok(0)
}

pub fn cmd_stop() -> Result<i32> {
    if service_installed() {
        service_stop();
    }
    let pid = daemon_pid();
    if let Some(pid) = pid {
        // SAFETY: asking our own controller to exit.
        unsafe { libc::kill(pid, libc::SIGTERM) };
        // Wait for the process, not the pid file: it removes the file before
        // it has let go of the page's port.
        wait_for(|| !process_alive(pid), 10);
    }
    if daemon_pid().is_some() || pid.is_some_and(process_alive) {
        println!("The controller didn't stop; try again or kill it.");
        return Ok(1);
    }
    println!("Stopped. Running Claude sessions keep going; they just can't be started from the page.");
    Ok(0)
}

pub fn cmd_restart() -> Result<i32> {
    cmd_stop()?;
    cmd_start()
}

pub fn cmd_logs(follow: bool, lines: usize) -> Result<i32> {
    let (log, daemon_log) = (config::log_path(), config::daemon_log_path());
    if follow {
        let err = crate::wrapper::exec("tail", vec!["-f".into(), log.display().to_string(), daemon_log.display().to_string()]);
        bail!("couldn't run tail: {err}");
    }
    for p in [&daemon_log, &log] {
        if p.exists() {
            println!("==> {}", p.display());
            println!("{}", tail(p, lines));
        }
    }
    if !daemon_log.exists() && !log.exists() {
        println!("No logs yet.");
    }
    Ok(0)
}

// ---- start at login ---------------------------------------------------------

fn path_env() -> String {
    // launchd starts with a bare PATH; keep the person's so `claude` is found.
    std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
}

fn plist() -> String {
    let exe = config::exe().display().to_string();
    let home = config::home().display().to_string();
    let log = config::daemon_log_path().display().to_string();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string><string>daemon</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>{path}</string><key>SERAPH_HOME</key><string>{home}</string></dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash, but not after `seraph stop` (which exits cleanly). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
        path = path_env()
    )
}

fn systemd_unit() -> String {
    format!(
        "[Unit]\nDescription=seraph controller for Claude Code sessions\n\n[Service]\nExecStart={} daemon\nEnvironment=PATH={}\nEnvironment=SERAPH_HOME={}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n",
        config::exe().display(),
        path_env(),
        config::home().display()
    )
}

fn run_quiet(program: &str, args: &[&str]) {
    let _ = Command::new(program).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions.
    unsafe { libc::getuid() }
}

fn service_start() {
    if macos() {
        run_quiet("launchctl", &["bootstrap", &format!("gui/{}", uid()), &plist_path().to_string_lossy()]);
        run_quiet("launchctl", &["kickstart", &format!("gui/{}/{LABEL}", uid())]);
    } else {
        run_quiet("systemctl", &["--user", "start", "seraph"]);
    }
}

fn service_stop() {
    if macos() {
        run_quiet("launchctl", &["bootout", &format!("gui/{}/{LABEL}", uid())]);
    } else {
        run_quiet("systemctl", &["--user", "stop", "seraph"]);
    }
}

pub fn cmd_service(action: &str) -> Result<i32> {
    match action {
        "status" => {
            println!("Start at login: {}", if service_installed() { "on" } else { "off" });
            match daemon_pid() {
                Some(pid) => println!("Controller: running (pid {pid})"),
                None => println!("Controller: not running"),
            }
            Ok(0)
        }
        "install" => {
            config::require()?;
            if daemon_pid().is_some() {
                cmd_stop()?;
            }
            if macos() {
                fs::create_dir_all(plist_path().parent().unwrap())?;
                fs::write(plist_path(), plist())?;
            } else if cfg!(target_os = "linux") {
                fs::create_dir_all(systemd_path().parent().unwrap())?;
                fs::write(systemd_path(), systemd_unit())?;
                run_quiet("systemctl", &["--user", "daemon-reload"]);
                run_quiet("systemctl", &["--user", "enable", "seraph"]);
            } else {
                bail!("Start at login is supported on macOS and Linux.");
            }
            service_start();
            let ok = wait_for(|| daemon_pid().is_some(), 30);
            println!(
                "The controller now starts when you log in. {}: {}",
                if ok { "Running" } else { "Not running yet; see `seraph logs`" },
                page_url()
            );
            Ok(if ok { 0 } else { 1 })
        }
        "uninstall" => {
            if !service_installed() {
                println!("Start at login is already off.");
                return Ok(0);
            }
            service_stop();
            if cfg!(target_os = "linux") {
                run_quiet("systemctl", &["--user", "disable", "seraph"]);
            }
            for p in [plist_path(), systemd_path()] {
                let _ = fs::remove_file(p);
            }
            println!("Start at login is off, and the controller is stopped. `seraph start` runs it until you log out.");
            Ok(0)
        }
        other => bail!("Unknown action {other}: use install, uninstall or status."),
    }
}
