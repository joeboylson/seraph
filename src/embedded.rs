//! The Supabase project files, built into the binary, so a device needs
//! nothing but `seraph` itself.

use crate::config;
use anyhow::Result;
use rust_embed::RustEmbed;
use std::fs;
use std::path::PathBuf;

/// What `supabase` needs to run the local stack and apply the schema.
/// Only these files: the folder also holds the CLI's own state and secrets.
#[derive(RustEmbed)]
#[folder = "supabase"]
#[include = "config.toml"]
#[include = "migrations/*.sql"]
#[include = "templates/*"]
#[include = "uninstall.sql"]
pub struct Project;

/// A folder holding `supabase/` with the files above, for the Supabase CLI to
/// run in. Rewritten each time, so it always matches this version.
pub fn project_dir() -> Result<PathBuf> {
    let dir = config::home().join("project");
    for name in Project::iter() {
        let path = dir.join("supabase").join(name.as_ref());
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = Project::get(&name).expect("listed file exists");
        if fs::read(&path).ok().as_deref() != Some(file.data.as_ref()) {
            fs::write(&path, file.data)?;
        }
    }
    Ok(dir)
}
