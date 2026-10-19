//! Web Push to members' phones when a session needs them or finishes.
//!
//! The pushes are empty: the phone shows a generic notice and opens the page,
//! so nothing about a session passes through Google's, Apple's or Mozilla's
//! push service. Empty pushes need no encryption, only a VAPID signature (ES256).

use crate::config;
use crate::supa::{api, log, quote, select_rows};
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::LineEnding;
use p256::SecretKey;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// Endpoints are written by the page, so only ever contact real push services.
const PUSH_HOSTS: [&str; 4] = ["fcm.googleapis.com", ".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

// A session's status changes that are worth a buzz.
const NOTEWORTHY: [(&str, &str); 4] = [("working", "waiting"), ("idle", "waiting"), ("starting", "waiting"), ("working", "idle")];

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

/// Send one empty push. Returns the HTTP status (0 if it couldn't connect).
pub fn send(endpoint: &str, key: &SigningKey, public: &str, contact: &str) -> u16 {
    let Ok(url) = url::Url::parse(endpoint) else { return 0 };
    let audience = format!("{}://{}", url.scheme(), url.host_str().unwrap_or("")) + &url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let res = crate::supa::agent(15)
        .post(endpoint)
        .set("Authorization", &format!("vapid t={}, k={public}", vapid_jwt(key, &audience, contact)))
        .set("TTL", "3600")
        .set("Urgency", "high")
        .send_bytes(&[]);
    match res {
        Ok(r) => r.status(),
        Err(ureq::Error::Status(code, _)) => code,
        Err(_) => 0,
    }
}

fn host_of(endpoint: &str) -> String {
    url::Url::parse(endpoint).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

pub fn notify_all() -> Result<()> {
    notify_all_where(allowed)
}

/// `allow` decides which endpoints may be contacted (tests point it at a stand-in).
pub fn notify_all_where(allow: impl Fn(&str) -> bool) -> Result<()> {
    let subs = select_rows("push_subscriptions", "select=id,endpoint")?;
    if subs.is_empty() {
        return Ok(());
    }
    let key = signing_key()?;
    let public = public_key()?;
    let who = contact()?;
    for sub in subs {
        let endpoint = sub["endpoint"].as_str().unwrap_or("");
        if !allow(endpoint) {
            log(format!("push: skipping endpoint that isn't a known push service: {}", host_of(endpoint)));
            continue;
        }
        let status = send(endpoint, &key, &public, &who);
        if status == 404 || status == 410 {
            // The phone unsubscribed or the browser dropped it.
            api("DELETE", &format!("/rest/v1/push_subscriptions?id=eq.{}", sub["id"]), None, Some("return=minimal"))?;
        } else if !(200..300).contains(&status) {
            log(format!("push: {} answered {status}", host_of(endpoint)));
        }
    }
    Ok(())
}

/// Remembers each session's status and pushes when one changes in a way that matters.
#[derive(Default)]
pub struct Watcher {
    statuses: Option<HashMap<String, String>>,
    last_push: Option<Instant>,
}

impl Watcher {
    pub fn check(&mut self, machine: &str) -> Result<()> {
        self.check_with(machine, notify_all)
    }

    pub fn check_with(&mut self, machine: &str, notify: impl FnOnce() -> Result<()>) -> Result<()> {
        // Each computer pushes for its own sessions, so a phone isn't told twice.
        let rows = select_rows("sessions", &format!("status=neq.ended&hostname=eq.{}&select=id,status", quote(machine)))?;
        let current: HashMap<String, String> = rows
            .iter()
            .filter_map(|r| Some((r["id"].as_str()?.to_string(), r["status"].as_str()?.to_string())))
            .collect();
        if let Some(before) = &self.statuses {
            let changed = current.iter().any(|(id, now)| {
                let was = before.get(id).map(String::as_str).unwrap_or("");
                NOTEWORTHY.contains(&(was, now.as_str()))
            });
            // One buzz covers several sessions changing at once.
            let quiet = self.last_push.is_none_or(|t| t.elapsed().as_secs() > 20);
            if changed && quiet {
                self.last_push = Some(Instant::now());
                notify()?;
            }
        }
        self.statuses = Some(current);
        Ok(())
    }
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
        w.check_with("push-test-box", || notify_all_where(allow)).unwrap();
        crate::supa::update("sessions", &format!("id=eq.{sid}"), &json!({ "status": "waiting" })).unwrap();
        w.check_with("push-test-box", || notify_all_where(allow)).unwrap();
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
