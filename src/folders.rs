//! The folders seraph may look in on this computer: the page browses only
//! inside them (folder names, never files) and starts sessions only there.
//! Set with `seraph folders add <path>`; with none set, it's your home folder.

use crate::config;
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// The folders as saved, before any default.
pub fn saved() -> Vec<String> {
    match config::saved_value("folders") {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

/// The allowed folders that exist, as real paths. Your home folder if none are set.
pub fn roots() -> Vec<PathBuf> {
    let set = saved();
    let wanted: Vec<PathBuf> = if set.is_empty() { vec![config::expand("~")] } else { set.iter().map(|f| config::expand(f)).collect() };
    wanted.into_iter().filter_map(|p| fs::canonicalize(p).ok()).filter(|p| p.is_dir()).collect()
}

/// Whether `path` (a real path) is one of the allowed folders or inside one.
pub fn allowed(path: &Path) -> bool {
    roots().iter().any(|root| path.starts_with(root))
}

/// The message for a folder outside the allowed ones.
pub fn not_allowed(path: &Path) -> anyhow::Error {
    anyhow::anyhow!(
        "{} isn't in a folder seraph may use on {}. On that computer, run: seraph folders add <folder>",
        path.display(),
        config::machine()
    )
}

pub fn cmd_folders(args: &[String]) -> Result<i32> {
    let mut folders = saved();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] | ["list"] => {
            if folders.is_empty() {
                println!("No folders set, so seraph uses your home folder: {}", config::expand("~").display());
                println!("Narrow it with: seraph folders add <folder>");
            } else {
                for f in &folders {
                    let missing = if config::expand(f).is_dir() { "" } else { "  (missing)" };
                    println!("{f}{missing}");
                }
            }
        }
        ["add", path] => {
            let Ok(real) = fs::canonicalize(config::expand(path)) else { bail!("No such folder: {path}") };
            if !real.is_dir() {
                bail!("Not a folder: {}", real.display());
            }
            let shown = real.to_string_lossy().replacen(&config::user_home(), "~", 1);
            if folders.iter().any(|f| fs::canonicalize(config::expand(f)).ok().as_deref() == Some(real.as_path())) {
                println!("Already allowed: {shown}");
            } else {
                folders.push(shown.clone());
                config::save(&[("folders", Some(json!(folders)))])?;
                println!("seraph may now use {shown} (and the folders inside it).");
            }
        }
        ["remove", path] => {
            let real = fs::canonicalize(config::expand(path)).unwrap_or_else(|_| config::expand(path));
            let before = folders.len();
            folders.retain(|f| f != path && fs::canonicalize(config::expand(f)).unwrap_or_else(|_| config::expand(f)) != real);
            if folders.len() == before {
                bail!("{path} isn't in the list. See: seraph folders");
            }
            config::save(&[("folders", Some(json!(folders)))])?;
            println!("Removed. {}", if folders.is_empty() { "None left, so seraph uses your home folder again." } else { "" });
        }
        _ => bail!("Usage: seraph folders [list] | add <folder> | remove <folder>"),
    }
    Ok(0)
}
