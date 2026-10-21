//! Web Push to members' phones when a session needs them or finishes a long
//! task, and when a plan limit runs high.
//!
//! What a notification says is encrypted for each phone (webpush.rs), so
//! Google's, Apple's or Mozilla's push service only ever carries ciphertext.
//! Phones that subscribed before keys were kept get an empty push and a
//! generic notice. Each push is signed with a VAPID key (ES256).

use crate::config;
use crate::supa::{api, log, quote, select_rows};
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::LineEnding;
use p256::SecretKey;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// Endpoints are written by the page, so only ever contact real push services.
const PUSH_HOSTS: [&str; 4] = ["fcm.googleapis.com", ".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];


pub fn key_path() -> PathBuf {
    config::home().join("vapid.pem")
}

fn b64url(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

fn write_key(pem: &str) -> Result<()> {
    fs::create_dir_all(config::home())?;
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(key_path())?;
    f.write_all(pem.as_bytes())?;
    Ok(())
}

/// The key in the same form `openssl ecparam -genkey` writes, so keys made
/// by either work.
fn new_key_pem() -> Result<String> {
    let key = SecretKey::random(&mut rand_core::OsRng);
    Ok(key.to_sec1_pem(LineEnding::LF)?.to_string())
}

/// Use the project's shared signing key, so a phone subscribed through any
/// computer hears from all of them. The first computer to need one makes it.
pub fn sync_key() -> Result<()> {
    let mut rows = select_rows("csc_secrets", "name=eq.vapid_key&select=value")?;
    if rows.is_empty() {
        if !key_path().exists() {
            write_key(&new_key_pem()?)?;
        }
        // If another computer saved one meanwhile, theirs stays and is read back below.
        api(
            "POST",
            "/rest/v1/csc_secrets",
            Some(&json!({ "name": "vapid_key", "value": fs::read_to_string(key_path())? })),
            Some("resolution=ignore-duplicates,return=minimal"),
        )?;
        rows = select_rows("csc_secrets", "name=eq.vapid_key&select=value")?;
    }
    let shared = rows.first().and_then(|r| r["value"].as_str()).ok_or_else(|| anyhow!("no shared push key"))?;
    if fs::read_to_string(key_path()).ok().as_deref() != Some(shared) {
        write_key(shared)?;
    }
    Ok(())
}

fn signing_key() -> Result<SigningKey> {
    if !key_path().exists() {
        sync_key()?;
    }
    let pem = fs::read_to_string(key_path())?;
    let secret = SecretKey::from_sec1_pem(&pem).map_err(|e| anyhow!("reading {}: {e}", key_path().display()))?;
    Ok(SigningKey::from(secret))
}

/// The VAPID public key the page subscribes with: 65 raw bytes, base64url.
pub fn public_key() -> Result<String> {
    let point = signing_key()?.verifying_key().to_encoded_point(false);
    Ok(b64url(point.as_bytes()))
}

/// Who push services can reach about these messages (Apple requires a real
/// one): the `push_contact` setting, else the first member's email.
fn contact() -> Result<String> {
    if let Some(c) = config::load().push_contact {
        return Ok(c);
    }
    let members: Vec<String> = select_rows("members", "select=user_id")?
        .iter()
        .filter_map(|m| m["user_id"].as_str().map(str::to_string))
        .collect();
    let users = api("GET", "/auth/v1/admin/users?per_page=1000", None, None)?;
    let email = users["users"].as_array().into_iter().flatten().find_map(|u| {
        let id = u["id"].as_str()?;
        members.iter().any(|m| m == id).then(|| u["email"].as_str()).flatten().map(str::to_string)
    });
    Ok(email.map(|e| format!("mailto:{e}")).unwrap_or_else(|| "mailto:seraph@example.com".into()))
}

pub fn vapid_jwt(key: &SigningKey, audience: &str, contact: &str) -> String {
    let exp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) + 12 * 3600;
    let header = b64url(json!({ "typ": "JWT", "alg": "ES256" }).to_string().as_bytes());
    let claims = b64url(json!({ "aud": audience, "exp": exp, "sub": contact }).to_string().as_bytes());
    let signing_input = format!("{header}.{claims}");
    let sig: Signature = key.sign(signing_input.as_bytes());
    format!("{signing_input}.{}", b64url(&sig.to_bytes()))
}

pub fn allowed(endpoint: &str) -> bool {
    let Ok(url) = url::Url::parse(endpoint) else { return false };
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https" && PUSH_HOSTS.iter().any(|h| host == h.trim_start_matches('.') || host.ends_with(h))
}

/// Send one push: empty, or `body` already encrypted for that phone.
/// Returns the HTTP status (0 if it couldn't connect).
pub fn send(endpoint: &str, key: &SigningKey, public: &str, contact: &str, body: Option<&[u8]>) -> u16 {
    let Ok(url) = url::Url::parse(endpoint) else { return 0 };
    let audience = format!("{}://{}", url.scheme(), url.host_str().unwrap_or("")) + &url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let mut req = crate::supa::agent(15)
        .post(endpoint)
        .set("Authorization", &format!("vapid t={}, k={public}", vapid_jwt(key, &audience, contact)))
        .set("TTL", "3600")
        .set("Urgency", "high");
    if body.is_some() {
        req = req.set("Content-Encoding", "aes128gcm").set("Content-Type", "application/octet-stream");
    }
    let res = req.send_bytes(body.unwrap_or(&[]));
    match res {
        Ok(r) => r.status(),
        Err(ureq::Error::Status(code, _)) => code,
        Err(_) => 0,
    }
}

fn host_of(endpoint: &str) -> String {
    url::Url::parse(endpoint).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

/// What a notification says. Encrypted for each phone (see webpush.rs), so
/// the push service carries it without being able to read it.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    /// Opened when it's tapped; none opens the "Needs you" overview.
    pub session_id: Option<String>,
    /// A newer notice with the same tag replaces the older one on the phone.
    pub tag: String,
}

pub fn notify_all(notice: &Notice) -> Result<()> {
    notify_all_where(notice, allowed)
}

/// `allow` decides which endpoints may be contacted (tests point it at a stand-in).
pub fn notify_all_where(notice: &Notice, allow: impl Fn(&str) -> bool) -> Result<()> {
    let subs = select_rows("push_subscriptions", "select=id,endpoint,p256dh,auth")?;
    if subs.is_empty() {
        return Ok(());
    }
    let key = signing_key()?;
    let public = public_key()?;
    let who = contact()?;
    let message = json!({ "title": notice.title, "body": notice.body, "sessionId": notice.session_id, "tag": notice.tag }).to_string();
    for sub in subs {
        let endpoint = sub["endpoint"].as_str().unwrap_or("");
        if !allow(endpoint) {
            log(format!("push: skipping endpoint that isn't a known push service: {}", host_of(endpoint)));
            continue;
        }
        // Phones that subscribed before keys were kept get the empty, generic push.
        let body = match (sub["p256dh"].as_str(), sub["auth"].as_str()) {
            (Some(p), Some(a)) => match crate::webpush::encrypt(message.as_bytes(), p, a) {
                Ok(b) => Some(b),
                Err(e) => {
                    log(format!("push: can't encrypt for {}: {e}", host_of(endpoint)));
                    None
                }
            },
            _ => None,
        };
        let status = send(endpoint, &key, &public, &who, body.as_deref());
        if status == 404 || status == 410 {
            // The phone unsubscribed or the browser dropped it.
            api("DELETE", &format!("/rest/v1/push_subscriptions?id=eq.{}", sub["id"]), None, Some("return=minimal"))?;
        } else if !(200..300).contains(&status) {
            log(format!("push: {} answered {status}", host_of(endpoint)));
        }
    }
    Ok(())
}

/// A turn at least this long counts as a long task: worth a buzz when it ends.
const LONG_TASK_SECS: u64 = 180;
/// Limits worth a warning, in percent used.
const USAGE_ALERTS: [i64; 2] = [80, 95];

fn title(row: &Value) -> String {
    row["name"].as_str().filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| {
        let cwd = row["cwd"].as_str().unwrap_or("");
        cwd.rsplit('/').find(|p| !p.is_empty()).unwrap_or(cwd).to_string()
    })
}

/// "3:10 PM" today, else "Mon 3:10 PM".
fn reset_time(epoch: i64) -> String {
    use chrono::{Local, TimeZone};
    let Some(at) = Local.timestamp_opt(epoch, 0).single() else { return String::new() };
    if at.date_naive() == Local::now().date_naive() { at.format("%-I:%M %p").to_string() } else { at.format("%a %-I:%M %p").to_string() }
}

/// What changed between two looks at one session that's worth telling a phone.
/// `worked` is how long it had been working, if it just stopped.
pub fn session_notice(row: &Value, was: &str, now: &str, worked: Option<u64>) -> Option<Notice> {
    let notify = row["notify"].as_str().unwrap_or("needs-you");
    if notify == "off" || row["paused_at"].is_string() {
        return None;
    }
    let id = row["id"].as_str()?.to_string();
    let name = title(row);
    if now == "waiting" && matches!(was, "working" | "idle" | "starting") {
        return Some(Notice { title: format!("{name} needs you"), body: "Claude is asking you something.".into(), session_id: Some(id.clone()), tag: id });
    }
    if was == "working" && now == "idle" {
        let secs = worked.unwrap_or(0);
        if notify == "all" || secs >= LONG_TASK_SECS {
            let took = if secs >= 60 { format!(" after {} min", secs / 60) } else { String::new() };
            return Some(Notice { title: format!("{name} is done"), body: format!("Claude finished{took}."), session_id: Some(id.clone()), tag: id });
        }
    }
    None
}

/// Remembers each session's status and pushes when one changes in a way
/// that matters to it (see `session_notice`), and when a plan limit runs high.
#[derive(Default)]
pub struct Watcher {
    statuses: Option<HashMap<String, String>>,
    working_since: HashMap<String, Instant>,
    last_push: HashMap<String, Instant>,
    /// Usage alerts this controller already recorded, so it doesn't ask the
    /// database again every few seconds while a limit stays high.
    alerted: std::collections::HashSet<String>,
}

impl Watcher {
    pub fn check(&mut self, machine: &str) -> Result<()> {
        self.check_with(machine, notify_all)
    }

    pub fn check_with(&mut self, machine: &str, mut notify: impl FnMut(&Notice) -> Result<()>) -> Result<()> {
        // Each computer pushes for its own sessions, so a phone isn't told twice.
        let rows = select_rows("sessions", &format!("status=neq.ended&hostname=eq.{}&select=id,status,name,cwd,notify,paused_at,usage", quote(machine)))?;
        let mut notices = Vec::new();
        let mut current = HashMap::new();
        for row in &rows {
            let (Some(id), Some(now)) = (row["id"].as_str(), row["status"].as_str()) else { continue };
            current.insert(id.to_string(), now.to_string());
            let was = self.statuses.as_ref().and_then(|b| b.get(id)).map(String::as_str);
            if now == "working" && was != Some("working") {
                self.working_since.insert(id.to_string(), Instant::now());
            }
            let worked = (now != "working").then(|| self.working_since.remove(id)).flatten().map(|t| t.elapsed().as_secs());
            if let Some(n) = was.and_then(|was| session_notice(row, was, now, worked)) {
                notices.push(n);
            }
            notices.extend(usage_notices(row, &mut self.alerted)?);
        }
        for n in notices {
            // At most one buzz per session (or alert) every 20 seconds.
            if self.last_push.get(&n.tag).is_some_and(|t| t.elapsed().as_secs() < 20) {
                continue;
            }
            self.last_push.insert(n.tag.clone(), Instant::now());
            notify(&n)?;
        }
        self.statuses = Some(current);
        Ok(())
    }
}

/// A warning when the 5-hour or weekly limit passes 80% and 95%, sent once
/// per window across all computers (the sent_alerts table remembers).
fn usage_notices(row: &Value, alerted: &mut std::collections::HashSet<String>) -> Result<Vec<Notice>> {
    let mut out = Vec::new();
    for (field, label) in [("five_hour", "5-hour"), ("seven_day", "Weekly")] {
        let window = &row["usage"][field];
        let (Some(pct), Some(resets)) = (window["used_percentage"].as_i64(), window["resets_at"].as_i64()) else { continue };
        let Some(level) = USAGE_ALERTS.iter().rev().find(|l| pct >= **l) else { continue };
        let key = format!("{field}:{resets}:{level}");
        if !alerted.insert(key.clone()) {
            continue;
        }
        let fresh = crate::supa::insert("sent_alerts", &json!([{ "key": key }]), "resolution=ignore-duplicates,return=representation")?;
        if fresh.as_array().is_some_and(|a| !a.is_empty()) {
            out.push(Notice {
                title: format!("{label} limit at {pct}%"),
                body: format!("Resets {}.", reset_time(resets)),
                session_id: None,
                tag: format!("usage-{field}"),
            });
        }
    }
    Ok(out)
}

/// Forget alerts older than two weeks; their windows are long over.
pub fn prune_alerts(_: &str) -> Result<()> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(14)).format("%Y-%m-%dT%H:%M:%SZ");
    api("DELETE", &format!("/rest/v1/sent_alerts?created_at=lt.{cutoff}"), None, Some("return=minimal"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    #[test]
    fn jwt_signature_verifies() {
        let key = SigningKey::from(SecretKey::from_sec1_pem(&new_key_pem().unwrap()).unwrap());
        let jwt = vapid_jwt(&key, "https://fcm.googleapis.com", "mailto:a@example.com");
        let (input, sig) = jwt.rsplit_once('.').unwrap();
        let sig = Signature::from_slice(&URL_SAFE_NO_PAD.decode(sig).unwrap()).unwrap();
        VerifyingKey::from(&key).verify(input.as_bytes(), &sig).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(input.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
    }

    #[test]
    fn notices_follow_each_sessions_setting() {
        let row = |notify: &str| json!({ "id": "s1", "name": "landing page", "cwd": "/x/site", "notify": notify });
        let needs = session_notice(&row("needs-you"), "working", "waiting", None).unwrap();
        assert_eq!(needs.title, "landing page needs you");
        assert_eq!(needs.session_id.as_deref(), Some("s1"));
        // A short turn ending is quiet by default; a long one, or "all", isn't.
        assert_eq!(session_notice(&row("needs-you"), "working", "idle", Some(30)), None);
        assert_eq!(session_notice(&row("needs-you"), "working", "idle", Some(600)).unwrap().title, "landing page is done");
        assert!(session_notice(&row("all"), "working", "idle", Some(5)).is_some());
        // Off is off; and a paused session doesn't buzz.
        assert_eq!(session_notice(&row("off"), "working", "waiting", None), None);
        let mut paused = row("all");
        paused["paused_at"] = json!("2026-10-21T10:00:00Z");
        assert_eq!(session_notice(&paused, "working", "idle", Some(600)), None);
        // Unnamed sessions go by their folder.
        assert_eq!(session_notice(&json!({ "id": "s2", "cwd": "/x/site" }), "idle", "waiting", None).unwrap().title, "site needs you");
    }

    #[test]
    fn only_real_push_services_are_contacted() {
        for ok in ["https://fcm.googleapis.com/fcm/send/abc", "https://web.push.apple.com/QG", "https://updates.push.services.mozilla.com/wpush/v2/x"] {
            assert!(allowed(ok), "{ok}");
        }
        for bad in ["http://fcm.googleapis.com/x", "https://evil.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.com/x", "https://127.0.0.1/x", "not a url"] {
            assert!(!allowed(bad), "{bad}");
        }
    }

    #[test]
    fn keys_made_by_openssl_load() {
        let Ok(out) = std::process::Command::new("openssl").args(["ecparam", "-name", "prime256v1", "-genkey", "-noout"]).output() else {
            return; // no openssl here; nothing to compare with
        };
        let pem = String::from_utf8(out.stdout).unwrap();
        let key = SecretKey::from_sec1_pem(&pem).unwrap();
        assert_eq!(SigningKey::from(key).verifying_key().to_encoded_point(false).len(), 65);
    }

    /// Needs the local Supabase: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn a_usage_alert_goes_out_once_across_computers() {
        let resets = chrono::Utc::now().timestamp() + 3600;
        let usage = json!({ "context_percentage": 10, "five_hour": { "used_percentage": 83, "resets_at": resets }, "seven_day": { "used_percentage": 40, "resets_at": resets } });
        let mut ids = Vec::new();
        for host in ["alert-box-a", "alert-box-b"] {
            let row = crate::supa::insert("sessions", &json!({ "cwd": "/tmp/alert", "status": "idle", "hostname": host, "usage": usage }), "return=representation").unwrap();
            ids.push(row[0]["id"].as_str().unwrap().to_string());
        }
        let mut sent = Vec::new();
        for host in ["alert-box-a", "alert-box-b"] {
            let mut w = Watcher::default();
            for _ in 0..2 {
                w.check_with(host, |n| {
                    sent.push(n.clone());
                    Ok(())
                })
                .unwrap();
            }
        }
        for id in &ids {
            let _ = api("DELETE", &format!("/rest/v1/sessions?id=eq.{id}"), None, Some("return=minimal"));
        }
        let _ = api("DELETE", &format!("/rest/v1/sent_alerts?key=like.five_hour:{resets}:*"), None, Some("return=minimal"));
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!(sent[0].title, "5-hour limit at 83%");
        assert!(sent[0].session_id.is_none());
    }

    /// Needs the local Supabase: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn status_change_pushes_and_drops_expired_devices() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        {
            let received = received.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut first = String::new();
                    reader.read_line(&mut first).unwrap();
                    let mut auth = String::new();
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line.trim().is_empty() {
                            break;
                        }
                        if line.to_lowercase().starts_with("authorization:") {
                            auth = line.trim().to_string();
                        }
                    }
                    let path = first.split_whitespace().nth(1).unwrap_or("").to_string();
                    received.lock().unwrap().push(format!("{path} {}", auth.contains("vapid t=")));
                    let status = if path.contains("gone") { "410 Gone" } else { "201 Created" };
                    let mut s = stream;
                    let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            });
        }
        let base = format!("http://127.0.0.1:{port}");
        let user = api("POST", "/auth/v1/admin/users", Some(&json!({ "email": "rust-push@test.invalid", "email_confirm": true })), None).unwrap();
        let uid = user["id"].as_str().unwrap().to_string();
        let cleanup = || {
            let _ = api("DELETE", &format!("/auth/v1/admin/users/{uid}"), None, None);
        };
        let rows = json!([{ "user_id": uid, "endpoint": format!("{base}/live") }, { "user_id": uid, "endpoint": format!("{base}/gone") }]);
        crate::supa::insert("push_subscriptions", &rows, "return=minimal").unwrap();
        let session = crate::supa::insert("sessions", &json!({ "cwd": "/tmp/push-probe", "status": "working", "hostname": "push-test-box" }), "return=representation").unwrap();
        let sid = session[0]["id"].as_str().unwrap().to_string();
        let allow = |e: &str| e.starts_with(&base);
        let mut w = Watcher::default();
        w.check_with("push-test-box", |n| notify_all_where(n, allow)).unwrap();
        crate::supa::update("sessions", &format!("id=eq.{sid}"), &json!({ "status": "waiting" })).unwrap();
        w.check_with("push-test-box", |n| notify_all_where(n, allow)).unwrap();
        let left = select_rows("push_subscriptions", &format!("user_id=eq.{uid}&select=endpoint")).unwrap();
        let _ = api("DELETE", &format!("/rest/v1/sessions?id=eq.{sid}"), None, Some("return=minimal"));
        cleanup();
        let got = received.lock().unwrap().clone();
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got.iter().all(|g| g.ends_with("true")), "every push is signed: {got:?}");
        assert_eq!(left.len(), 1);
        assert!(left[0]["endpoint"].as_str().unwrap().ends_with("/live"));
    }
}
