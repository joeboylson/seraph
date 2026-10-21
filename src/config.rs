//! Settings, read from ~/.seraph/config.json with environment overrides.
//!
//!     supabase_url          what seraph and the hooks talk to
//!     supabase_key          the project's publishable (anon) key, given to the page
//!     supabase_secret_key   the project's secret (service role) key, used by seraph
//!                           and the hooks; never sent to the page
//!     page_url              where the page is hosted (e.g. on Vercel)
//!     web_port              where `seraph daemon` serves the install line (8787)
//!     claude_bin            the Claude Code command (claude)
//!     machine               this computer's name on the page (its hostname);
//!                           each computer sharing a project needs its own
//!     push_contact          who push services can reach about seraph's pushes
//!                           (mailto: or https:), default the first member's email
//!     folders               the folders seraph may browse and start sessions in
//!                           (`seraph folders`); your home folder if none
//!
//! Each can be overridden with SERAPH_<NAME> in the environment, e.g.
//! SERAPH_SUPABASE_URL. SERAPH_HOME moves the whole ~/.seraph folder.

use anyhow::{bail, Result};
use serde_json::{Map, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const KEYS: [&str; 9] = [
    "folders",
    "supabase_url",
    "supabase_key",
    "supabase_secret_key",
    "page_url",
    "web_port",
    "claude_bin",
    "push_contact",
    "machine",
];

#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub supabase_url: Option<String>,
    pub supabase_key: Option<String>,
    pub supabase_secret_key: Option<String>,
    pub page_url: Option<String>,
    pub web_port: u16,
    pub claude_bin: String,
    pub push_contact: Option<String>,
    pub machine: Option<String>,
}

/// A fully set-up configuration: what `require()` hands back.
#[derive(Clone, Debug)]
pub struct Ready {
    pub url: String,
    pub secret: String,
    pub web_port: u16,
    pub claude_bin: String,
}

pub fn home() -> PathBuf {
    match std::env::var("SERAPH_HOME") {
        Ok(h) if !h.is_empty() => expand(&h),
        _ => expand("~/.seraph"),
    }
}

/// Whether this is the usual setup in ~/.seraph (SERAPH_HOME unset, or set to it).
pub fn is_default_home() -> bool {
    let default = expand("~/.seraph");
    let here = home();
    here == default || (fs::canonicalize(&here).ok().is_some_and(|h| fs::canonicalize(&default).ok() == Some(h)))
}

/// Before the rename, settings lived in ~/.csc. Move them over once, so
/// nothing needs setting up again.
pub fn move_old_home() {
    if std::env::var_os("SERAPH_HOME").is_some() {
        return;
    }
    let (old, new) = (expand("~/.csc"), expand("~/.seraph"));
    if old.is_dir() && !new.exists() {
        let _ = fs::rename(&old, &new);
    }
}

pub fn expand(path: &str) -> PathBuf {
    if path == "~" {
        return PathBuf::from(user_home());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Path::new(&user_home()).join(rest);
    }
    PathBuf::from(path)
}

pub fn user_home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

pub fn config_path() -> PathBuf {
    home().join("config.json")
}
pub fn log_path() -> PathBuf {
    home().join("seraph.log")
}
pub fn daemon_log_path() -> PathBuf {
    home().join("daemon.log")
}
pub fn pid_path() -> PathBuf {
    home().join("daemon.pid")
}
pub fn links_dir() -> PathBuf {
    home().join("links")
}
pub fn uploads_dir() -> PathBuf {
    home().join("uploads")
}

/// This binary, for starting the controller, sessions and hooks.
pub fn exe() -> PathBuf {
    std::env::current_exe().and_then(fs::canonicalize).unwrap_or_else(|_| PathBuf::from("seraph"))
}

fn saved() -> Map<String, Value> {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// One saved setting as stored, for ones that aren't plain text (e.g. `folders`).
pub fn saved_value(key: &str) -> Option<Value> {
    saved().get(key).cloned()
}

/// The saved settings with environment overrides applied.
pub fn load() -> Settings {
    let saved = saved();
    let get = |key: &str| -> Option<String> {
        if let Ok(v) = std::env::var(format!("SERAPH_{}", key.to_uppercase())) {
            if !v.is_empty() {
                return Some(v);
            }
        }
        match saved.get(key) {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        }
    };
    Settings {
        supabase_url: get("supabase_url"),
        supabase_key: get("supabase_key"),
        supabase_secret_key: get("supabase_secret_key"),
        page_url: get("page_url"),
        web_port: get("web_port").and_then(|p| p.parse().ok()).unwrap_or(8787),
        claude_bin: get("claude_bin").unwrap_or_else(|| "claude".into()),
        push_contact: get("push_contact"),
        machine: get("machine"),
    }
}

/// Merge `changes` into the saved settings (not the environment). `None`
/// values are skipped, so they don't erase what's there.
pub fn save(changes: &[(&str, Option<Value>)]) -> Result<()> {
    fs::create_dir_all(home())?;
    let mut saved = saved();
    for (k, v) in changes {
        debug_assert!(KEYS.contains(k));
        if let Some(v) = v {
            saved.insert((*k).to_string(), v.clone());
        }
    }
    write_saved(&saved)
}

fn write_saved(saved: &Map<String, Value>) -> Result<()> {
    let path = config_path();
    fs::write(&path, serde_json::to_string_pretty(saved)? + "\n")?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// Headers for a Supabase request. A legacy JWT key also goes in
/// Authorization; the newer sb_… keys must not.
pub fn auth_headers(key: &str) -> Vec<(&'static str, String)> {
    let mut h = vec![("apikey", key.to_string())];
    if key.starts_with("eyJ") {
        h.push(("Authorization", format!("Bearer {key}")));
    }
    h
}

/// This computer's name: how the page tells several computers apart.
pub fn machine() -> String {
    load().machine.unwrap_or_else(hostname)
}

pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most buf.len() bytes, NUL-terminated.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
    let end = buf.iter().position(|&b| b == 0).unwrap_or(0);
    if ok {
        String::from_utf8_lossy(&buf[..end]).into_owned()
    } else {
        "unknown".into()
    }
}

/// The settings, or an error telling the person to run `seraph setup`.
pub fn require() -> Result<Ready> {
    let s = load();
    let (Some(url), Some(_key)) = (s.supabase_url, s.supabase_key) else {
        bail!("seraph isn't connected to Supabase yet. Run `seraph setup`.");
    };
    let Some(secret) = s.supabase_secret_key else {
        bail!("seraph needs the project's secret key now. Run `seraph setup` again.");
    };
    Ok(Ready {
        url,
        secret,
        web_port: s.web_port,
        claude_bin: s.claude_bin,
    })
}
