//! `seraph setup`, `seraph db push` and `seraph doctor`: connect to Supabase and check everything works.

use crate::config;
use crate::embedded;
use crate::service;
use crate::supa::{probe, quote};
use crate::util::{age_secs, ask, stdin_is_tty, which};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::process::Command;
use std::time::Duration;

// Services `supabase start` can skip. seraph needs the database, the REST API,
// Realtime, the gateway, Auth (which also reports the keys) and Mailpit,
// where sign-in codes land. Fewer containers start faster and use less memory.
const LOCAL_EXCLUDE: &str = "storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";

const TABLES: [&str; 8] = ["sessions", "events", "commands", "messages", "controllers", "members", "push_subscriptions", "csc_secrets"];

const LOCAL_PROJECT: &str = "claude-supabase-controller"; // project_id in supabase/config.toml

/// Checks the publishable key against a table, not the API root: hosted
/// projects only show the root to the secret key. A 404 (tables not
/// installed yet) still means the key was accepted.
const KEY_CHECK: &str = "/rest/v1/sessions?select=id&limit=0";

fn key_accepted(status: u16) -> bool {
    status == 200 || status == 404
}

const LOCAL_ONLY_FIX: &str = "Restart the stack so seraph can keep it on this machine: `supabase stop`, then `seraph setup --local`.";

/// Names of seraph's tables that the database doesn't have yet. Needs the secret key.
fn schema_missing(url: &str, key: &str) -> Result<Vec<String>> {
    let mut missing = Vec::new();
    for table in TABLES {
        let (status, _) = probe(url, key, &format!("/rest/v1/{table}?select=*&limit=0"), "GET", None);
        if status == 404 {
            missing.push(table.to_string());
        } else if status >= 400 || status == 0 {
            bail!("Supabase answered {status} for {table}");
        }
    }
    Ok(missing)
}

// ---- local Supabase ---------------------------------------------------------

/// API URL, publishable key and secret key of this project's local Supabase,
/// or None if it isn't running.
fn local_status() -> Result<Option<(String, String, String)>> {
    if which("supabase").is_none() {
        bail!("The Supabase CLI isn't installed. See https://supabase.com/docs/guides/local-development/cli/getting-started");
    }
    let out = Command::new("supabase").args(["status", "-o", "env"]).current_dir(embedded::project_dir()?).output()?;
    if !out.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let env = |name: &str| {
        text.lines()
            .filter_map(|l| l.split_once('='))
            .find(|(k, _)| k.trim() == name)
            .map(|(_, v)| v.trim().trim_matches('"').to_string())
    };
    let key = env("PUBLISHABLE_KEY").or_else(|| env("ANON_KEY"));
    let secret = env("SECRET_KEY").or_else(|| env("SERVICE_ROLE_KEY"));
    Ok(match (env("API_URL"), key, secret) {
        (Some(u), Some(k), Some(s)) => Some((u, k, s)),
        _ => None,
    })
}

/// Create the stack's Docker network so its ports listen on 127.0.0.1 only.
///
/// `supabase start` makes this network itself, and a network Docker creates
/// without options publishes ports on every interface, whatever Docker's own
/// default is. Creating it first, with the option, keeps the stack (and its
/// well-known keys) off the local network.
fn local_only_network() -> Result<()> {
    let network = format!("supabase_network_{LOCAL_PROJECT}");
    let out = Command::new("docker")
        .args(["network", "inspect", &network, "--format", r#"{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}"#])
        .output()?;
    if out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "127.0.0.1" {
        return Ok(());
    }
    if out.status.success() {
        // Left over from an earlier `supabase start`; the stack is stopped, so it's unused.
        Command::new("docker").args(["network", "rm", &network]).output()?;
    }
    let created = Command::new("docker")
        .args(["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", &network])
        .output()?;
    if !created.status.success() {
        bail!("couldn't create the Docker network: {}", String::from_utf8_lossy(&created.stderr).trim());
    }
    Ok(())
}

fn start_local() -> Result<(String, String, String)> {
    if let Some(found) = local_status()? {
        return Ok(found);
    }
    local_only_network()?;
    println!("Starting local Supabase (Docker). The first time downloads images and takes a few minutes…");
    let ok = Command::new("supabase").args(["start", "-x", LOCAL_EXCLUDE]).current_dir(embedded::project_dir()?).status()?.success();
    if !ok {
        bail!("`supabase start` failed; see the message above.");
    }
    local_status()?.ok_or_else(|| anyhow!("Local Supabase started, but `supabase status` didn't report its address."))
}

/// Ports of the local stack that Docker publishes on every network
/// interface, not just this machine. The local stack uses well-known keys
/// and the password `postgres`, so anyone on the same network could read
/// everything and sign in with the codes in Mailpit.
fn exposed_ports() -> Vec<String> {
    if which("docker").is_none() {
        return Vec::new();
    }
    let Ok(out) = Command::new("docker").args(["ps", "--filter", &format!("name=_{LOCAL_PROJECT}"), "--format", "{{.Ports}}"]).output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let ports: BTreeSet<String> = text
        .lines()
        .flat_map(|l| l.split(", "))
        .filter(|m| m.starts_with("0.0.0.0:") || m.starts_with("[::]:"))
        .filter_map(|m| m.split("->").next()?.rsplit(':').next().map(str::to_string))
        .collect();
    ports.into_iter().collect()
}

// ---- schema -----------------------------------------------------------------

fn push_local() -> Result<()> {
    println!("Applying the schema to local Supabase…");
    let ok = Command::new("supabase").args(["migration", "up", "--local"]).current_dir(embedded::project_dir()?).status()?.success();
    if !ok {
        bail!("`supabase migration up --local` failed. Check `supabase status`, then run `seraph db push` again.");
    }
    Ok(())
}

/// Apply the migrations to a hosted project, with the Supabase CLI if there is one, else psql.
fn push_remote(db_url: &str) -> Result<()> {
    if which("supabase").is_some() {
        println!("Applying the schema with `supabase db push`…");
        let ok = Command::new("supabase").args(["db", "push", "--db-url", db_url, "--yes"]).current_dir(embedded::project_dir()?).status()?.success();
        if ok {
            return Ok(());
        }
        bail!("`supabase db push` failed; see the message above.");
    }
    if which("psql").is_none() {
        bail!("Applying the schema needs the Supabase CLI or psql. Install either, then run `seraph db push --db-url …`.");
    }
    let mut files: Vec<_> = std::fs::read_dir(embedded::project_dir()?.join("supabase").join("migrations"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "sql"))
        .collect();
    files.sort();
    for file in files {
        let name = file.file_name().unwrap_or_default().to_string_lossy().into_owned();
        println!("  {name}");
        let ok = Command::new("psql").args([db_url, "-v", "ON_ERROR_STOP=1", "-q", "-f"]).arg(&file).status()?.success();
        if !ok {
            bail!(
                "{name} failed. If it says something already exists, the schema is partly applied; \
                 the Supabase CLI handles that better (`supabase db push --db-url …`)."
            );
        }
    }
    Ok(())
}

pub fn is_local(url: &str) -> bool {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    matches!(host.as_str(), "127.0.0.1" | "localhost" | "0.0.0.0" | "::1" | "[::1]")
}

pub fn cmd_db_push(db_url: Option<&str>) -> Result<i32> {
    let s = config::require()?;
    if let Some(db_url) = db_url {
        push_remote(db_url)?;
    } else if is_local(&s.url) {
        push_local()?;
    } else {
        bail!(
            "For a hosted project, pass its database connection string:\n  \
             seraph db push --db-url 'postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres'\n\
             Find it in the Supabase dashboard under Connect."
        );
    }
    let missing = schema_missing(&s.url, &s.secret)?;
    if !missing.is_empty() {
        bail!(
            "The schema still isn't visible to the API (missing: {}). It can take a few seconds to reload; run `seraph doctor`.",
            missing.join(", ")
        );
    }
    println!("Schema is in place.");
    Ok(0)
}

// ---- seraph setup --------------------------------------------------------------

#[derive(Default)]
pub struct SetupArgs {
    pub local: bool,
    pub url: Option<String>,
    pub key: Option<String>,
    pub secret_key: Option<String>,
    pub db_url: Option<String>,
    pub page_url: Option<String>,
    pub web_port: Option<u16>,
    pub claude_bin: Option<String>,
}

pub fn cmd_setup(args: SetupArgs) -> Result<i32> {
    let current = config::load();
    // Just a new page address: the Supabase settings stay as they are.
    let only_page = !args.local && args.url.is_none() && args.key.is_none() && args.secret_key.is_none();
    if let (true, Some(page)) = (only_page, &args.page_url) {
        config::save(&[("page_url", Some(Value::from(page.trim_end_matches('/'))))])?;
        println!("Saved: the page is at {}", page.trim_end_matches('/'));
        return Ok(0);
    }
    let (mut url, mut key, mut secret, mut db_url) = (args.url, args.key, args.secret_key, args.db_url);

    if args.local {
        let (u, k, s) = start_local()?;
        (url, key, secret) = (Some(u), Some(k), Some(s));
    } else if url.is_none() || key.is_none() || secret.is_none() {
        if !stdin_is_tty() {
            bail!("Pass --local, or --url, --key and --secret-key for a hosted project.");
        }
        println!(
            "Where should seraph keep its data?\n  \
             1. A local Supabase in Docker (needs the Supabase CLI and Docker)\n  \
             2. A Supabase project you already have (hosted or self-hosted)"
        );
        if ask("Choose 1 or 2", Some("1")).as_deref() == Some("1") {
            let (u, k, s) = start_local()?;
            (url, key, secret) = (Some(u), Some(k), Some(s));
        } else {
            println!("\nFind these in the Supabase dashboard: Project Settings → API (or the Connect button).");
            url = ask("Project URL (https://….supabase.co)", current.supabase_url.as_deref());
            key = ask("Publishable key (sb_publishable_…, or the anon key)", current.supabase_key.as_deref());
            println!("The secret key stays on this computer in seraph's config file. The page never sees it.");
            secret = ask("Secret key (sb_secret_…, or the service_role key)", current.supabase_secret_key.as_deref());
            if db_url.is_none() {
                db_url = ask("Database connection string, to install the tables (leave empty to skip)", None);
            }
        }
    }
    let (Some(url), Some(key), Some(secret)) = (url, key, secret) else {
        bail!("Setup needs the project URL, the publishable key and the secret key.");
    };

    let (status, body) = probe(&url, &key, KEY_CHECK, "GET", None);
    if status == 401 || status == 403 {
        bail!("Supabase rejected the key ({status}). Use the project's publishable or anon key.");
    }
    if !key_accepted(status) {
        bail!("Couldn't reach Supabase at {url} ({status}): {body}");
    }
    // Only the secret key can list users, so this tells it apart from the publishable one.
    let (status, _) = probe(&url, &secret, "/auth/v1/admin/users?per_page=1", "GET", None);
    if status != 200 {
        bail!("Supabase rejected the secret key ({status}). Use the project's secret or service_role key.");
    }

    config::save(&[
        ("supabase_url", Some(json!(url))),
        ("supabase_key", Some(json!(key))),
        ("supabase_secret_key", Some(json!(secret))),
        ("page_url", args.page_url.map(|u| Value::from(u.trim_end_matches('/')))),
        ("web_port", args.web_port.map(Value::from)),
        ("claude_bin", args.claude_bin.map(Value::from)),
    ])?;
    println!("Saved to {}", config::config_path().display());

    if is_local(&url) {
        // Always: it also applies migrations added since the last setup.
        push_local()?;
    } else if !schema_missing(&url, &secret)?.is_empty() {
        if let Some(db_url) = db_url {
            push_remote(&db_url)?;
        } else {
            println!(
                "\nThe tables aren't installed yet. Run:\n  \
                 seraph db push --db-url 'postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres'"
            );
            return Ok(1);
        }
        for _ in 0..10 {
            // PostgREST reloads its schema cache shortly after.
            if schema_missing(&url, &secret)?.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    println!(
        "\nConnected. Next:\n  \
         seraph user add <your email>   let yourself sign in to the page\n  \
         seraph start                   run the controller in the background\n  \
         seraph open                    open the web page\n  \
         seraph claude                  use instead of `claude` in a terminal"
    );
    Ok(0)
}

/// Computers whose controller is running and checked in within the hour.
pub fn online_computers() -> Result<Vec<Value>> {
    let rows = crate::supa::select_rows("controllers", "select=id,version,last_seen,stopped_at&order=id")?;
    Ok(rows
        .into_iter()
        .filter(|c| c["stopped_at"].is_null() && c["last_seen"].as_str().is_some_and(|t| age_secs(t) < crate::daemon::ACTIVE_SECS))
        .collect())
}

// ---- seraph doctor -------------------------------------------------------------

struct Checks(Vec<(bool, String, String)>);

impl Checks {
    fn add(&mut self, ok: bool, what: impl Into<String>, fix: impl Into<String>) -> bool {
        self.0.push((ok, what.into(), fix.into()));
        ok
    }
}

/// (ok, what, how to fix) for each part seraph needs.
fn checks() -> Checks {
    let mut c = Checks(Vec::new());
    let s = config::load();

    let claude = which(&s.claude_bin);
    c.add(
        claude.is_some(),
        format!("Claude Code: {}", claude.map(|p| p.display().to_string()).unwrap_or_else(|| "not found".into())),
        "Install Claude Code, or point seraph at it: seraph setup --claude-bin /path/to/claude",
    );
    let on_path = which("seraph");
    c.add(
        on_path.is_some(),
        format!("seraph on PATH: {}", on_path.map(|p| p.display().to_string()).unwrap_or_else(|| "no".into())),
        "Run ./install.sh in the repo, or the install line from the page's computer.",
    );

    let (Some(url), Some(key)) = (s.supabase_url.clone(), s.supabase_key.clone()) else {
        c.add(false, format!("Settings in {}", config::config_path().display()), "Run `seraph setup`.");
        return c;
    };
    c.add(true, format!("Settings in {}", config::config_path().display()), "");
    let Some(secret) = s.supabase_secret_key.clone() else {
        c.add(false, "No secret key saved", "Run `seraph setup` again; seraph needs the secret key now.");
        return c;
    };
    c.add(true, "Secret key saved", "");
    let (status, _) = probe(&url, &key, KEY_CHECK, "GET", None);
    if !c.add(
        key_accepted(status),
        format!("Supabase API at {url} ({status})"),
        "Is Supabase running? For local: `supabase start` in the repo. Check the URL and key with `seraph setup`.",
    ) {
        return c;
    }
    match schema_missing(&url, &secret) {
        Ok(missing) => c.add(
            missing.is_empty(),
            if missing.is_empty() { "Tables installed".into() } else { format!("Missing tables: {}", missing.join(", ")) },
            "Run `seraph db push`.",
        ),
        Err(e) => c.add(false, e.to_string(), "Run `seraph db push`."),
    };
    let ping = json!({ "messages": [{ "topic": "csc:doctor", "event": "ping", "payload": {}, "private": true }] });
    let (status, _) = probe(&url, &secret, "/realtime/v1/api/broadcast", "POST", Some(&ping));
    c.add(status != 0 && status < 300, format!("Realtime broadcast ({status})"), "Realtime must be enabled for the project.");
    match &s.page_url {
        Some(page) => {
            let ok = crate::supa::agent(15).get(page).call().is_ok();
            c.add(ok, format!("Page at {page}"), "Is it deployed? See docs/remote-access.md.");
        }
        None => {
            c.add(false, "No page address saved", "Run `seraph setup --page-url <where the page is hosted>`.");
        }
    }
    if is_local(&url) {
        let exposed = exposed_ports();
        c.add(
            exposed.is_empty(),
            if exposed.is_empty() {
                "Local Supabase only reachable from this machine".into()
            } else {
                format!("Local Supabase is open to your network on ports {}", exposed.join(", "))
            },
            LOCAL_ONLY_FIX,
        );
    }

    let pid = service::daemon_pid();
    c.add(
        pid.is_some(),
        pid.map(|p| format!("Controller running (pid {p})")).unwrap_or_else(|| "Controller not running".into()),
        "Run `seraph start`.",
    );
    if pid.is_some() {
        let (status, rows) = probe(&url, &secret, &format!("/rest/v1/controllers?id=eq.{}&select=last_seen", quote(&config::machine())), "GET", None);
        // It checks in every 10 minutes.
        let fresh = status == 200 && rows[0]["last_seen"].as_str().is_some_and(|t| age_secs(t) < 900.0);
        c.add(fresh, "Controller checking in", format!("See {}; Supabase may be slow or unreachable.", config::log_path().display()));
    }
    if let Ok(computers) = online_computers() {
        let stale: Vec<String> = computers
            .iter()
            .filter(|c| c["version"].as_str() != Some(crate::VERSION))
            .map(|c| c["id"].as_str().unwrap_or("?").to_string())
            .collect();
        if computers.len() > 1 || !stale.is_empty() {
            c.add(
                stale.is_empty(),
                if stale.is_empty() { "Every computer runs this build".into() } else { format!("Different build on: {}", stale.join(", ")) },
                "Update them: rerun the install line on each (curl -fsSL <page address>/install | sh).",
            );
        }
    }
    c
}

pub fn cmd_doctor() -> Result<i32> {
    let results = checks().0;
    for (ok, what, fix) in &results {
        println!("  {} {what}", if *ok { "✓" } else { "✗" });
        if !ok && !fix.is_empty() {
            println!("      {fix}");
        }
    }
    let failed = results.iter().filter(|r| !r.0).count();
    if failed == 0 {
        println!("\nAll good.");
    } else {
        println!("\n{failed} thing{} to fix.", if failed > 1 { "s" } else { "" });
    }
    Ok(if failed == 0 { 0 } else { 1 })
}
