//! OAuth2 authorization-code + PKCE flow against Microsoft Entra, using a
//! loopback redirect. Tokens are acquired per-resource (Dataverse org, or the
//! global discovery service). The refresh token is stored in the OS keychain.

use crate::config::Settings;
use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const KEYRING_SERVICE: &str = "CdsSqlStudio";
const KEYRING_USER: &str = "refresh-token";

pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub expires_in: i64,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: i64,
}

fn authority(tenant: &str) -> String {
    format!("https://login.microsoftonline.com/{}", tenant)
}

fn scope_for(resource: &str) -> String {
    // `<resource>/.default` yields a token whose audience is that resource.
    format!("{}/.default offline_access openid profile", resource)
}

fn pkce() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let verifier = URL_SAFE_NO_PAD.encode(buf);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn random_token() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// How long an interactive sign-in waits for the browser to come back.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// How often the wait checks for cancellation / timeout.
const SIGN_IN_POLL: Duration = Duration::from_millis(250);

/// Error text of a sign-in the user cancelled (the UI shows no error for it).
pub const SIGN_IN_CANCELLED: &str = "Sign-in was cancelled";

/// Error text of a sign-in the browser never came back from.
pub const SIGN_IN_TIMED_OUT: &str = "Sign-in timed out";

/// Start of the error a command fails with when the project's sign-in no
/// longer works (refresh token expired or revoked, never signed in):
/// `SIGN_IN_REQUIRED:<project id>:<reason>`. The frontend asks the user to
/// sign in again and retries the command.
pub const SIGN_IN_REQUIRED: &str = "SIGN_IN_REQUIRED";

pub fn sign_in_required(project_id: &str, reason: &str) -> AppError {
    AppError::msg(format!("{}:{}:{}", SIGN_IN_REQUIRED, project_id, reason))
}

/// Why a refresh didn't give a token.
#[derive(Debug)]
pub enum RefreshError {
    /// Entra won't take the refresh token any more (expired, revoked, a
    /// policy wants a fresh sign-in or MFA): only signing in again helps.
    SignInRequired(String),
    /// Anything else (offline, Entra unavailable…): signing in wouldn't help.
    Other(AppError),
}

/// OAuth error codes that mean "sign in again" rather than "try later".
const SIGN_IN_ERRORS: &[&str] = &["invalid_grant", "interaction_required", "login_required", "consent_required"];

/// Cancel flag of the interactive sign-in currently waiting, if any.
static CURRENT_SIGN_IN: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Registers a new attempt, cancelling the one still waiting.
fn begin_attempt() -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut current) = CURRENT_SIGN_IN.lock() {
        if let Some(old) = current.replace(flag.clone()) {
            old.store(true, Ordering::Relaxed);
        }
    }
    flag
}

/// Stops the interactive sign-in that is waiting for the browser (no-op if none).
pub fn cancel_sign_in() {
    if let Ok(mut current) = CURRENT_SIGN_IN.lock() {
        if let Some(flag) = current.take() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Waits for the OAuth redirect: a request whose query carries `code`,
/// `error` or `state`. Anything else the browser sends (favicon, prefetch) is
/// answered 404 and ignored. Gives up when `cancel` is set or after `timeout`.
fn wait_for_redirect(
    server: &tiny_http::Server,
    cancel: &AtomicBool,
    timeout: Duration,
) -> AppResult<(tiny_http::Request, Vec<(String, String)>)> {
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::msg(SIGN_IN_CANCELLED));
        }
        if started.elapsed() >= timeout {
            return Err(AppError::msg(format!(
                "{} — the browser didn't come back within {} minutes. Try again.",
                SIGN_IN_TIMED_OUT,
                timeout.as_secs() / 60
            )));
        }
        let Some(request) = server.recv_timeout(SIGN_IN_POLL)? else { continue };
        let query: Vec<(String, String)> = url::Url::parse(&format!("http://localhost{}", request.url()))
            .map(|u| u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect())
            .unwrap_or_default();
        if query.iter().any(|(k, _)| k == "code" || k == "error" || k == "state") {
            return Ok((request, query));
        }
        let _ = request.respond(tiny_http::Response::empty(404));
    }
}

/// Interactive sign-in for a specific resource. Opens the system browser and
/// waits for the loopback redirect. `login_hint` preselects the account a
/// project was last signed in as, which matters when several tenants are open.
pub fn interactive(settings: &Settings, resource: &str, login_hint: Option<&str>) -> AppResult<Tokens> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(AppError::msg)?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| AppError::msg("Failed to bind loopback port"))?
        .port();
    let redirect = format!("http://localhost:{}", port);

    let (verifier, challenge) = pkce();
    let state = random_token();
    let scope = scope_for(resource);

    let mut params: Vec<(&str, &str)> = vec![
        ("client_id", settings.client_id.as_str()),
        ("response_type", "code"),
        ("redirect_uri", redirect.as_str()),
        ("response_mode", "query"),
        ("scope", scope.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("state", state.as_str()),
        ("prompt", "select_account"),
    ];
    if let Some(hint) = login_hint.filter(|h| !h.trim().is_empty()) {
        params.push(("login_hint", hint));
    }
    let query = serde_urlencoded::to_string(params)?;
    let auth_url = format!("{}/oauth2/v2.0/authorize?{}", authority(&settings.tenant), query);

    // A new sign-in replaces one still waiting (e.g. its tab was closed).
    let cancel = begin_attempt();
    webbrowser::open(&auth_url)?;

    // Wait for the browser to redirect back to the loopback server — but not
    // forever: closing the sign-in tab sends nothing back.
    let (request, redirect_query) = wait_for_redirect(&server, &cancel, SIGN_IN_TIMEOUT)?;

    let mut code: Option<String> = None;
    let mut err: Option<String> = None;
    let mut returned_state: Option<String> = None;
    for (k, v) in redirect_query {
        match k.as_str() {
            "code" => code = Some(v),
            "error_description" => err = Some(v),
            "error" => {
                if err.is_none() {
                    err = Some(v);
                }
            }
            "state" => returned_state = Some(v),
            _ => {}
        }
    }

    let html = "<!doctype html><html><body style=\"font-family:system-ui,sans-serif;background:#0b0f17;color:#e5e9f0;display:flex;height:100vh;margin:0;align-items:center;justify-content:center\"><div style=\"text-align:center\"><h2 style=\"margin:0 0 8px\">✓ Signed in</h2><p style=\"color:#94a3b8\">You can close this tab and return to Hexa Studio.</p></div></body></html>";
    let header =
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
            .map_err(|_| AppError::msg("header"))?;
    let _ = request.respond(tiny_http::Response::from_string(html).with_header(header));

    if let Some(e) = err {
        return Err(AppError::msg(format!("Sign-in failed: {}", e)));
    }
    if returned_state.as_deref() != Some(state.as_str()) {
        return Err(AppError::msg("Sign-in state mismatch (possible CSRF). Try again."));
    }
    let code = code.ok_or_else(|| AppError::msg("No authorization code was returned"))?;

    let body = serde_urlencoded::to_string([
        ("client_id", settings.client_id.as_str()),
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code_verifier", verifier.as_str()),
        ("scope", scope.as_str()),
    ])?;
    exchange(settings, &body).map_err(|(_, e)| e)
}

/// Silent token acquisition for a resource using a stored refresh token.
pub fn refresh(settings: &Settings, resource: &str, refresh_token: &str) -> Result<Tokens, RefreshError> {
    let scope = scope_for(resource);
    let body = serde_urlencoded::to_string([
        ("client_id", settings.client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", scope.as_str()),
    ])
    .map_err(|e| RefreshError::Other(e.into()))?;
    exchange(settings, &body).map_err(|(code, e)| refresh_error(code.as_deref(), e))
}

fn refresh_error(code: Option<&str>, e: AppError) -> RefreshError {
    match code {
        Some(code) if SIGN_IN_ERRORS.contains(&code) => RefreshError::SignInRequired(first_line(&e.to_string())),
        _ => RefreshError::Other(e),
    }
}

/// Entra's error_description minus its trace / correlation id lines.
fn first_line(description: &str) -> String {
    description.lines().next().unwrap_or("").trim().to_string()
}

/// Redeems a grant at the token endpoint. On an error answer, the OAuth
/// `error` code comes with it.
fn exchange(settings: &Settings, body: &str) -> Result<Tokens, (Option<String>, AppError)> {
    let token_url = format!("{}/oauth2/v2.0/token", authority(&settings.tenant));
    let resp = ureq::post(&token_url)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(body);

    match resp {
        Ok(r) => {
            let tr: TokenResponse = r.into_json().map_err(|e| (None, e.into()))?;
            Ok(Tokens {
                access_token: tr.access_token,
                refresh_token: tr.refresh_token,
                id_token: tr.id_token,
                expires_in: tr.expires_in,
            })
        }
        Err(ureq::Error::Status(_code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let json = serde_json::from_str::<serde_json::Value>(&text).ok();
            let field = |key: &str| json.as_ref().and_then(|v| v.get(key)).and_then(|x| x.as_str()).map(|s| s.to_string());
            let code = field("error");
            let msg = field("error_description").or_else(|| code.clone()).unwrap_or(text);
            Err((code, AppError::msg(msg)))
        }
        Err(e) => Err((None, AppError::msg(e.to_string()))),
    }
}

pub fn username_from_id_token(id_token: Option<&str>) -> Option<String> {
    let token = id_token?;
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("preferred_username")
        .or_else(|| v.get("upn"))
        .or_else(|| v.get("email"))
        .or_else(|| v.get("name"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

// Windows Credential Manager caps a credential blob at 2560 *bytes*, i.e.
// 1280 UTF-16 chars (keyring reports it as "2560 chars"), and Azure AD refresh
// tokens routinely exceed that. So the token is stored as several chunked
// entries (`<user>-count`, `<user>-0`, `<user>-1`, ...).
const CHUNK_CHARS: usize = 1200;
const MAX_CHUNKS: usize = 24;

/// Each project keeps its own token, so several tenants stay signed in at once.
fn prefix(project_id: &str) -> String {
    format!("{}-{}", KEYRING_USER, project_id)
}

fn entry(name: &str) -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, name)?)
}

fn delete_entry(name: &str) -> AppResult<()> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn store_chunked(prefix: &str, token: &str) -> AppResult<()> {
    clear_chunked(prefix)?;
    let chars: Vec<char> = token.chars().collect();
    let chunks: Vec<String> = chars
        .chunks(CHUNK_CHARS)
        .map(|c| c.iter().collect())
        .collect();
    if chunks.len() > MAX_CHUNKS {
        return Err(AppError::msg("Refresh token is unexpectedly large"));
    }
    for (i, chunk) in chunks.iter().enumerate() {
        entry(&format!("{}-{}", prefix, i))?.set_password(chunk)?;
    }
    entry(&format!("{}-count", prefix))?.set_password(&chunks.len().to_string())?;
    Ok(())
}

fn load_chunked(prefix: &str) -> AppResult<String> {
    let count: usize = entry(&format!("{}-count", prefix))?
        .get_password()?
        .trim()
        .parse()?;
    let mut token = String::new();
    for i in 0..count {
        token.push_str(&entry(&format!("{}-{}", prefix, i))?.get_password()?);
    }
    Ok(token)
}

fn clear_chunked(prefix: &str) -> AppResult<()> {
    for i in 0..MAX_CHUNKS {
        delete_entry(&format!("{}-{}", prefix, i))?;
    }
    delete_entry(&format!("{}-count", prefix))
}

pub fn store_refresh_token(project_id: &str, token: &str) -> AppResult<()> {
    store_chunked(&prefix(project_id), token)
}

pub fn load_refresh_token(project_id: &str) -> AppResult<String> {
    load_chunked(&prefix(project_id))
}

pub fn clear_refresh_token(project_id: &str) -> AppResult<()> {
    clear_chunked(&prefix(project_id))
}

/// Reads (and removes) the single token stored before projects existed, so it
/// can be re-keyed under the migrated project.
pub fn take_legacy_refresh_token() -> Option<String> {
    let token = load_chunked(KEYRING_USER)
        .ok()
        .or_else(|| entry(KEYRING_USER).ok()?.get_password().ok());
    let _ = clear_chunked(KEYRING_USER);
    let _ = delete_entry(KEYRING_USER);
    token.filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_dead_refresh_token_asks_for_a_new_sign_in() {
        let expired = "AADSTS700082: The refresh token has expired due to inactivity.
Trace ID: 1
Correlation ID: 2";
        match refresh_error(Some("invalid_grant"), AppError::msg(expired)) {
            RefreshError::SignInRequired(reason) => {
                assert_eq!(reason, "AADSTS700082: The refresh token has expired due to inactivity.")
            }
            RefreshError::Other(_) => panic!("invalid_grant must ask for a sign-in"),
        }
        assert!(matches!(refresh_error(Some("interaction_required"), AppError::msg("MFA")), RefreshError::SignInRequired(_)));
        // Offline, or Entra having a bad day: signing in wouldn't help.
        assert!(matches!(refresh_error(None, AppError::msg("Connection refused")), RefreshError::Other(_)));
        assert!(matches!(refresh_error(Some("temporarily_unavailable"), AppError::msg("busy")), RefreshError::Other(_)));
    }

    #[test]
    fn sign_in_required_names_the_project() {
        assert_eq!(sign_in_required("p1", "Not signed in").to_string(), "SIGN_IN_REQUIRED:p1:Not signed in");
    }

    fn loopback() -> (tiny_http::Server, String) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        (server, base)
    }

    #[test]
    fn stray_requests_are_ignored_until_the_redirect_arrives() {
        let (server, base) = loopback();
        let client = std::thread::spawn(move || {
            let favicon = ureq::get(&format!("{}/favicon.ico", base)).call();
            assert!(matches!(favicon, Err(ureq::Error::Status(404, _))));
            let _ = ureq::get(&format!("{}/?code=abc&state=xyz", base)).call();
        });
        let cancel = AtomicBool::new(false);
        let (request, query) = wait_for_redirect(&server, &cancel, Duration::from_secs(10)).unwrap();
        let _ = request.respond(tiny_http::Response::empty(200));
        client.join().unwrap();
        assert!(query.contains(&("code".to_string(), "abc".to_string())));
        assert!(query.contains(&("state".to_string(), "xyz".to_string())));
    }

    #[test]
    fn a_closed_tab_times_out_instead_of_waiting_forever() {
        let (server, _) = loopback();
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let err = wait_for_redirect(&server, &cancel, Duration::from_millis(600)).err().unwrap();
        assert!(err.to_string().starts_with(SIGN_IN_TIMED_OUT), "{}", err);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn cancel_stops_the_wait_and_a_new_attempt_replaces_the_old() {
        let (server, _) = loopback();
        let first = begin_attempt();
        let second = begin_attempt();
        assert!(first.load(Ordering::Relaxed), "a new sign-in cancels the one still waiting");
        let waiter = std::thread::spawn(move || {
            let err = wait_for_redirect(&server, &second, Duration::from_secs(30)).err().unwrap();
            err.to_string()
        });
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        cancel_sign_in();
        assert_eq!(waiter.join().unwrap(), SIGN_IN_CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
