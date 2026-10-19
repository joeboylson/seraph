//! Small helpers shared across commands.

use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

/// Where `name` is on PATH, like `shutil.which`.
pub fn which(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        let p = PathBuf::from(name);
        return is_executable(&p).then_some(p);
    }
    std::env::var_os("PATH")?
        .to_str()?
        .split(':')
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|p| is_executable(p))
}

fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// Whether a process exists (a permission error means it does, as someone else's).
pub fn process_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks the process exists.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Run a command in its own session, so it outlives this process and its terminal.
pub fn detach(cmd: &mut Command) -> &mut Command {
    // SAFETY: setsid is async-signal-safe and only affects the child.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        })
    }
}

pub fn wait_for(mut check: impl FnMut() -> bool, seconds: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// Seconds since a timestamp from Supabase.
pub fn age_secs(iso: &str) -> f64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_milliseconds() as f64 / 1000.0)
        .unwrap_or(0.0)
}

/// The last `n` lines of a file.
pub fn tail(path: &std::path::Path, n: usize) -> String {
    let text = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Ask a question on the terminal; empty answer gives the default.
pub fn ask(question: &str, default: Option<&str>) -> Option<String> {
    use std::io::Write;
    match default {
        Some(d) if !d.is_empty() => print!("{question} [{d}]: "),
        _ => print!("{question}: "),
    }
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    let answer = line.trim();
    if answer.is_empty() {
        default.map(str::to_string).filter(|d| !d.is_empty())
    } else {
        Some(answer.to_string())
    }
}

pub fn stdin_is_tty() -> bool {
    // SAFETY: isatty only inspects the descriptor.
    unsafe { libc::isatty(0) == 1 }
}

/// Quote a path for a shell command line.
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+@".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}
