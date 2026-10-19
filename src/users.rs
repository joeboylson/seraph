//! `seraph user`: who can sign in to the page.
//!
//! An account can sign in only if it exists (sign-ups are off) and is on the
//! `members` list, which the database rules check.

use crate::supa::{api, insert, quote, select_rows};
use anyhow::{bail, Result};
use serde_json::{json, Value};

fn all_users() -> Result<Vec<Value>> {
    Ok(api("GET", "/auth/v1/admin/users?per_page=1000", None, None)?["users"].as_array().cloned().unwrap_or_default())
}

fn find(email: &str) -> Result<Option<Value>> {
    let email = email.trim().to_lowercase();
    Ok(all_users()?.into_iter().find(|u| u["email"].as_str().unwrap_or("").to_lowercase() == email))
}

pub fn cmd_user(action: &str, email: Option<&str>) -> Result<i32> {
    let need_email = || -> Result<String> {
        match email {
            Some(e) if !e.trim().is_empty() => Ok(e.trim().to_string()),
            _ => bail!("Usage: seraph user {action} <email>"),
        }
    };
    match action {
        "add" => {
            let email = need_email()?;
            let user = match find(&email)? {
                Some(u) => u,
                None => api("POST", "/auth/v1/admin/users", Some(&json!({ "email": email, "email_confirm": true })), None)?,
            };
            insert("members", &json!({ "user_id": user["id"] }), "resolution=ignore-duplicates,return=minimal")?;
            println!("{email} can sign in. The page emails that address a sign-in link or code.");
        }
        "remove" => {
            let email = need_email()?;
            let Some(user) = find(&email)? else { bail!("No account for {email}.") };
            // Deleting the account also takes it off the members list and signs it out.
            api("DELETE", &format!("/auth/v1/admin/users/{}", quote(user["id"].as_str().unwrap_or(""))), None, None)?;
            println!("Removed {email}.");
        }
        "list" => {
            let members: Vec<Value> = select_rows("members", "select=user_id")?.into_iter().map(|m| m["user_id"].clone()).collect();
            let users = all_users()?;
            if users.is_empty() {
                println!("No accounts yet. Add yours with `seraph user add <email>`.");
            }
            for u in users {
                let note = if members.contains(&u["id"]) { "" } else { "  (not a member, can't use the page)" };
                let last: String = u["last_sign_in_at"].as_str().unwrap_or("never").chars().take(16).collect();
                println!("{}  last signed in {last}{note}", u["email"].as_str().unwrap_or("?"));
            }
        }
        "code" => {
            // A sign-in code made here instead of emailed, for when email isn't set up.
            let email = need_email()?;
            if find(&email)?.is_none() {
                bail!("No account for {email}. Add it with `seraph user add {email}`.");
            }
            let link = api("POST", "/auth/v1/admin/generate_link", Some(&json!({ "type": "magiclink", "email": email })), None)?;
            println!("{}", link["email_otp"].as_str().unwrap_or(""));
        }
        other => bail!("Unknown action {other}: use add, remove, list or code."),
    }
    Ok(0)
}
