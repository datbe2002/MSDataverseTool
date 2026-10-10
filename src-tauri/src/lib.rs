mod auth;
mod config;
mod connection;
mod discovery;
mod deps;
mod desktopflows;
mod dml;
mod engine;
mod error;
mod fetchxml;
mod flowapi;
mod flowruns;
mod flows;
mod flowtasks;
mod http;
mod jobs;
mod metadata;
mod odata;
mod plugins;
mod project;
mod security;
mod sql;
mod traces;
mod update;
mod webapi;
mod webresources;

use error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, State};

/// Global Discovery Service resource — used to enumerate environments.
const GLOBALDISCO: &str = "https://globaldisco.crm.dynamics.com";

#[derive(Default)]
pub struct AppState {
    /// "<project id>|<resource>" -> (access_token, unix_expiry_seconds)
    cache: Mutex<HashMap<String, (String, u64)>>,
    /// Prepared write statements waiting for the user's confirmation,
    /// with the project whose token must run them.
    plans: Mutex<HashMap<String, (String, dml::DmlPlan)>>,
    /// Full rows of recent streamed results whose long text the grid only
    /// got shortened (request id, rows), newest last.
    results: Mutex<std::collections::VecDeque<(String, std::sync::Arc<Vec<Vec<serde_json::Value>>>)>>,
    /// "<host>|<table>" -> entity set name, for FetchXML requests.
    entity_sets: Mutex<HashMap<String, String>>,
}

/// Longest text the grid gets per cell; the rest stays in the backend.
const UI_CELL_CHARS: usize = 1000;

/// Full results kept for copy/export (each can be hundreds of MB).
const RESULTS_KEPT: usize = 3;

/// Rows for the webview: long strings cut to `UI_CELL_CHARS` (+ "…").
/// `None` when nothing needed cutting.
fn clip_rows(rows: &[Vec<serde_json::Value>]) -> Option<Vec<Vec<serde_json::Value>>> {
    let long = |v: &serde_json::Value| matches!(v, serde_json::Value::String(s) if s.len() > UI_CELL_CHARS);
    if !rows.iter().any(|r| r.iter().any(long)) {
        return None;
    }
    Some(
        rows.iter()
            .map(|r| {
                r.iter()
                    .map(|v| match v {
                        serde_json::Value::String(s) if s.len() > UI_CELL_CHARS => {
                            let mut cut: String = s.chars().take(UI_CELL_CHARS).collect();
                            if cut.len() < s.len() {
                                cut.push('…');
                            }
                            serde_json::Value::String(cut)
                        }
                        other => other.clone(),
                    })
                    .collect()
            })
            .collect(),
    )
}

/// Tokens are per project *and* per resource — two projects may be signed in
/// as different accounts against the same environment.
fn cache_key(project_id: &str, resource: &str) -> String {
    format!("{}|{}", project_id, resource)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl AppState {
    fn cache_get(&self, key: &str) -> Option<String> {
        let guard = self.cache.lock().ok()?;
        guard.get(key).and_then(|(tok, exp)| {
            if *exp > now_secs() + 60 {
                Some(tok.clone())
            } else {
                None
            }
        })
    }

    fn cache_put(&self, key: &str, token: &str, expires_in: i64) {
        if let Ok(mut guard) = self.cache.lock() {
            let exp = now_secs() + expires_in.max(0) as u64;
            guard.insert(key.to_string(), (token.to_string(), exp));
        }
    }

    fn cache_clear_project(&self, project_id: &str) {
        if let Ok(mut guard) = self.cache.lock() {
            let prefix = format!("{}|", project_id);
            guard.retain(|k, _| !k.starts_with(&prefix));
        }
    }
}

/// Global settings with the project's own tenant / client id layered on top.
fn settings_for(project: &project::Project) -> config::Settings {
    let base = config::load_settings();
    config::Settings {
        client_id: project
            .client_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(base.client_id),
        tenant: if project.tenant.trim().is_empty() {
            base.tenant
        } else {
            project.tenant.clone()
        },
        worker_threads: base.worker_threads,
    }
}

/// Returns a valid access token for `resource` on `project_id`, acquiring one
/// silently via that project's refresh token, or interactively if needed.
async fn get_access_token(state: &AppState, project_id: &str, resource: &str) -> AppResult<String> {
    let key = cache_key(project_id, resource);
    if let Some(tok) = state.cache_get(&key) {
        return Ok(tok);
    }

    let project = project::get(project_id).ok_or_else(|| AppError::msg("Project not found"))?;
    let settings = settings_for(&project);
    // No browser from here: when the refresh token no longer works, the
    // command fails with SIGN_IN_REQUIRED and the app asks the user to sign
    // in again (sign_in), then retries it.
    let refresh = auth::load_refresh_token(project_id)
        .map_err(|_| auth::sign_in_required(project_id, "Not signed in"))?;
    let resource_owned = resource.to_string();

    let tokens = tokio::task::spawn_blocking(move || auth::refresh(&settings, &resource_owned, &refresh))
        .await
        .map_err(AppError::msg)?
        .map_err(|e| match e {
            auth::RefreshError::SignInRequired(reason) => auth::sign_in_required(project_id, &reason),
            auth::RefreshError::Other(e) => e,
        })?;

    if let Some(rt) = &tokens.refresh_token {
        let _ = auth::store_refresh_token(project_id, rt);
    }
    if let Some(username) = auth::username_from_id_token(tokens.id_token.as_deref()) {
        let _ = project::set_username(project_id, Some(username));
    }
    state.cache_put(&key, &tokens.access_token, tokens.expires_in);
    Ok(tokens.access_token)
}

/// Resolves a connection together with the project whose account owns it.
fn connection_project(connection_id: &str) -> AppResult<(connection::Connection, String)> {
    let conn = connection::get(connection_id)
        .ok_or_else(|| AppError::msg("Connection not found"))?;
    let project = project::for_connection(&conn.project_id)
        .ok_or_else(|| AppError::msg("This environment has no project. Create one and add it again."))?;
    Ok((conn, project.id))
}

#[tauri::command]
fn list_projects() -> Vec<project::Project> {
    project::list()
}

#[tauri::command]
fn create_project(
    name: String,
    tenant: Option<String>,
    client_id: Option<String>,
    color: Option<String>,
) -> AppResult<project::Project> {
    project::create(&name, tenant, client_id, color)
}

#[tauri::command]
fn update_project(
    id: String,
    name: String,
    tenant: Option<String>,
    client_id: Option<String>,
    color: Option<String>,
) -> AppResult<project::Project> {
    project::update(&id, &name, tenant, client_id, color)
}

/// Removes a project, its environments and its stored sign-in. Returns the
/// connection ids that went away so the UI can drop their saved tabs.
#[tauri::command]
fn delete_project(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    let removed = project::remove(&id)?;
    state.cache_clear_project(&id);
    Ok(removed)
}

#[tauri::command]
async fn sign_in(state: State<'_, AppState>, project_id: String) -> AppResult<project::Project> {
    let project = project::get(&project_id).ok_or_else(|| AppError::msg("Project not found"))?;
    let settings = settings_for(&project);
    let hint = project.username.clone();
    let tokens = tokio::task::spawn_blocking(move || {
        auth::interactive(&settings, GLOBALDISCO, hint.as_deref())
    })
    .await
    .map_err(AppError::msg)??;

    if let Some(rt) = &tokens.refresh_token {
        auth::store_refresh_token(&project_id, rt)?;
    }
    if let Some(username) = auth::username_from_id_token(tokens.id_token.as_deref()) {
        project::set_username(&project_id, Some(username))?;
    }
    state.cache_put(
        &cache_key(&project_id, GLOBALDISCO),
        &tokens.access_token,
        tokens.expires_in,
    );
    project::get(&project_id).ok_or_else(|| AppError::msg("Project not found"))
}

/// Stops an interactive sign-in that is waiting for the browser (its tab was
/// closed, or the user changed their mind). The waiting call fails with
/// `auth::SIGN_IN_CANCELLED`.
#[tauri::command]
fn cancel_sign_in() {
    auth::cancel_sign_in();
}

#[tauri::command]
fn sign_out(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    let _ = auth::clear_refresh_token(&project_id);
    let _ = project::set_username(&project_id, None);
    state.cache_clear_project(&project_id);
    Ok(())
}

#[tauri::command]
async fn list_environments(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<discovery::Environment>> {
    let token = get_access_token(state.inner(), &project_id, GLOBALDISCO).await?;
    let envs = tokio::task::spawn_blocking(move || discovery::list(&token))
        .await
        .map_err(AppError::msg)??;
    Ok(envs)
}

#[tauri::command]
fn list_connections() -> Vec<connection::Connection> {
    connection::list()
}

#[tauri::command]
fn save_connection(
    project_id: String,
    url: String,
    name: String,
) -> AppResult<connection::Connection> {
    if project::get(&project_id).is_none() {
        return Err(AppError::msg("Pick a project for this environment first"));
    }
    connection::save(&project_id, &url, &name)
}

#[tauri::command]
fn update_connection(
    id: String,
    name: String,
    tag: Option<String>,
    color: Option<String>,
) -> AppResult<connection::Connection> {
    connection::update(&id, &name, tag, color)
}

#[tauri::command]
fn delete_connection(id: String) -> AppResult<()> {
    connection::remove(&id)
}

/// The TDS endpoint refuses virtual entities and tables not enabled for
/// reporting.
fn tds_cannot_serve(err: &AppError) -> bool {
    err.to_string().contains("not available for reports")
}

/// One chunk of rows, sent to the webview while the query is still running.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryPage<'a> {
    request_id: &'a str,
    engine: &'a str,
    columns: &'a [sql::ColumnInfo],
    rows: &'a [Vec<serde_json::Value>],
}

/// `engine`: "tds" = TDS endpoint only (Settings → Use TDS endpoint).
/// Anything else = the FetchXML engine, handing the query to TDS right away
/// when the engine can't plan it (e.g. a T-SQL function it lacks) — nothing
/// has been read at that point, so no time is lost.
///
/// `request_id`: when given, rows are streamed as `query-page` events and
/// the returned result carries none (`streamed = true`).
#[tauri::command]
async fn run_query(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    max_rows: usize,
    engine: Option<String>,
    request_id: Option<String>,
) -> AppResult<sql::QueryResult> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let resource = format!("https://{}", conn.host);
    let token = get_access_token(state.inner(), &project_id, &resource).await?;
    let host = conn.host.clone();
    let use_tds = engine.as_deref() == Some("tds");
    // Set when a streamed page had text too long for the grid.
    let clipped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let on_batch: Option<sql::OnBatch> = request_id.clone().map(|id| {
        let app = app.clone();
        let clipped = clipped.clone();
        let cb: sql::OnBatch = std::sync::Arc::new(move |eng: &str, columns: &[sql::ColumnInfo], rows: &[Vec<serde_json::Value>]| {
            let short = clip_rows(rows);
            if short.is_some() {
                clipped.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            let rows = short.as_deref().unwrap_or(rows);
            let _ = app.emit("query-page", QueryPage { request_id: &id, engine: eng, columns, rows });
        });
        cb
    });
    let run_tds = || {
        let (h, t, s, cb) = (host.clone(), token.clone(), sql.clone(), on_batch.clone());
        tokio::task::spawn_blocking(move || sql::run_with_timeout(&h, &t, &s, max_rows, None, cb))
    };
    let workers = config::load_settings().worker_threads as usize;
    let run_fetchxml = || engine::run(&host, &token, &sql, max_rows, workers, on_batch.clone());

    let mut result = if use_tds {
        run_tds().await.map_err(AppError::msg)??
    } else {
        match run_fetchxml().await {
            Ok(r) => r,
            Err(e) if e.to_string().starts_with(engine::CANNOT_PLAN) => match run_tds().await.map_err(AppError::msg)? {
                Ok(mut r) => {
                    // Not shown as a badge — only in the timing tooltip.
                    r.note = Some(e.to_string());
                    r
                }
                // TDS can't read the table either: the engine's reason is the useful one.
                Err(tds) if tds_cannot_serve(&tds) => return Err(e),
                // Otherwise the T-SQL error says what's wrong with the statement.
                Err(tds) => return Err(tds),
            },
            Err(e) => return Err(e),
        }
    };
    if let Some(id) = &request_id {
        // The webview already has every row from the `query-page` events —
        // shortened ones included, whose full text stays here.
        let rows = std::mem::take(&mut result.rows);
        result.streamed = true;
        result.clipped = clipped.load(std::sync::atomic::Ordering::Relaxed);
        if result.clipped {
            if let Ok(mut kept) = state.results.lock() {
                kept.push_back((id.clone(), std::sync::Arc::new(rows)));
                while kept.len() > RESULTS_KEPT {
                    kept.pop_front();
                }
            }
        }
    }
    let _ = connection::touch(&connection_id);
    Ok(result)
}

/// Full rows of a recent streamed result (for copy / export), when its grid
/// copy had long text shortened.
#[tauri::command]
fn result_rows(state: State<'_, AppState>, request_id: String) -> AppResult<Vec<Vec<serde_json::Value>>> {
    let kept = state.results.lock().map_err(|_| AppError::msg("Result store unavailable"))?;
    kept.iter()
        .find(|(id, _)| *id == request_id)
        .map(|(_, rows)| rows.as_ref().clone())
        .ok_or_else(|| AppError::msg("The full rows of this result are no longer kept — run the query again."))
}

#[tauri::command]
async fn list_tables(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<metadata::TableMeta>> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || metadata::list_tables(&host, &token))
        .await
        .map_err(AppError::msg)?
}

#[tauri::command]
async fn list_columns(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> AppResult<Vec<metadata::ColumnMeta>> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || metadata::list_columns(&host, &token, &table))
        .await
        .map_err(AppError::msg)?
}

#[tauri::command]
async fn table_choices(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
) -> AppResult<metadata::TableChoices> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || metadata::table_choices(&host, &token, &table))
        .await
        .map_err(AppError::msg)?
}

#[tauri::command]
async fn list_flows(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<flows::FlowList> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || flows::list(&host, &token))
        .await
        .map_err(AppError::msg)?
}

#[tauri::command]
async fn flow_definition(
    state: State<'_, AppState>,
    connection_id: String,
    flow_id: String,
) -> AppResult<String> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || flows::definition(&host, &token, &flow_id))
        .await
        .map_err(AppError::msg)?
}

#[tauri::command]
async fn flow_calls(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<flows::FlowCall>> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || flows::calls(&host, &token))
        .await
        .map_err(AppError::msg)?
}

/// A page of plug-in trace logs, newest first (`next`: link from the previous page).
#[tauri::command]
async fn trace_logs(
    state: State<'_, AppState>,
    connection_id: String,
    filter: traces::TraceFilter,
    next: Option<String>,
) -> AppResult<traces::TracePage> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || traces::list(&host, &token, &filter, next.as_deref()))
        .await
        .map_err(AppError::msg)?
}

/// One plug-in trace log with its trace text and exception.
#[tauri::command]
async fn trace_log(
    state: State<'_, AppState>,
    connection_id: String,
    id: String,
) -> AppResult<traces::TraceDetail> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || traces::detail(&host, &token, &id))
        .await
        .map_err(AppError::msg)?
}

/// A page of system jobs (`asyncoperation`), newest first (`next`: link from the previous page).
#[tauri::command]
async fn system_jobs(
    state: State<'_, AppState>,
    connection_id: String,
    filter: jobs::JobFilter,
    next: Option<String>,
) -> AppResult<jobs::JobPage> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || jobs::list(&host, &token, &filter, next.as_deref()))
        .await
        .map_err(AppError::msg)?
}

/// One system job with its full messages.
#[tauri::command]
async fn system_job(
    state: State<'_, AppState>,
    connection_id: String,
    id: String,
) -> AppResult<jobs::JobDetail> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || jobs::detail(&host, &token, &id))
        .await
        .map_err(AppError::msg)?
}

/// Opens a record of the connection's environment in the browser (model-driven app).
#[tauri::command]
fn open_record(connection_id: String, table: String, id: String) -> AppResult<()> {
    let (conn, _) = connection_project(&connection_id)?;
    let url = jobs::record_url(&conn.host, &table, &id)?;
    webbrowser::open(&url)?;
    Ok(())
}

/// Opens a Microsoft Learn page (the Flow analysis "Docs" links) in the browser.
#[tauri::command]
fn open_docs(url: String) -> AppResult<()> {
    if !url.starts_with("https://learn.microsoft.com/") {
        return Err(AppError::msg("Only Microsoft Learn links can be opened"));
    }
    webbrowser::open(&url)?;
    Ok(())
}

/// Runs `f(host, token)` on a blocking thread with the connection's token.
async fn on_env<T: Send + 'static>(
    state: &AppState,
    connection_id: &str,
    f: impl FnOnce(&str, &str) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let (conn, project_id) = connection_project(connection_id)?;
    let token = get_access_token(state, &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || f(&host, &token)).await.map_err(AppError::msg)?
}

/// A page of cloud flow runs (`flowrun`), newest first (`next`: link from the previous page).
#[tauri::command]
async fn flow_runs(
    state: State<'_, AppState>,
    connection_id: String,
    filter: flowruns::RunFilter,
    next: Option<String>,
) -> AppResult<flowruns::RunPage> {
    on_env(state.inner(), &connection_id, move |host, token| flowruns::list(host, token, &filter, next.as_deref())).await
}

/// Every desktop flow (`workflow` category 6), drafts included.
#[tauri::command]
async fn desktop_flows(state: State<'_, AppState>, connection_id: String) -> AppResult<Vec<desktopflows::DesktopFlow>> {
    on_env(state.inner(), &connection_id, desktopflows::list_flows).await
}

/// A desktop flow's input and output variables.
#[tauri::command]
async fn desktop_flow(state: State<'_, AppState>, connection_id: String, id: String) -> AppResult<desktopflows::DesktopFlowDetail> {
    on_env(state.inner(), &connection_id, move |host, token| desktopflows::flow_detail(host, token, &id)).await
}

/// A page of desktop flow runs (`flowsession`), newest first (`next`: link from the previous page).
#[tauri::command]
async fn desktop_flow_runs(
    state: State<'_, AppState>,
    connection_id: String,
    filter: desktopflows::RunFilter,
    next: Option<String>,
) -> AppResult<desktopflows::RunPage> {
    on_env(state.inner(), &connection_id, move |host, token| desktopflows::list_runs(host, token, &filter, next.as_deref())).await
}

/// One desktop flow run with its error, inputs and outputs.
#[tauri::command]
async fn desktop_flow_run(state: State<'_, AppState>, connection_id: String, id: String) -> AppResult<desktopflows::RunDetail> {
    on_env(state.inner(), &connection_id, move |host, token| desktopflows::run_detail(host, token, &id)).await
}

/// The machines and machine groups that run desktop flows.
#[tauri::command]
async fn flow_machines(state: State<'_, AppState>, connection_id: String) -> AppResult<desktopflows::MachineList> {
    on_env(state.inner(), &connection_id, desktopflows::list_machines).await
}

/// How far this account can read `flowrun`: "none", "basic", "local", "deep" or "global".
#[tauri::command]
async fn flow_run_access(state: State<'_, AppState>, connection_id: String) -> AppResult<String> {
    on_env(state.inner(), &connection_id, flowruns::read_depth).await
}

/// Runs and failures per flow and per hour since `since`.
#[tauri::command]
async fn flow_run_summary(state: State<'_, AppState>, connection_id: String, since: String) -> AppResult<flowruns::RunSummary> {
    on_env(state.inner(), &connection_id, move |host, token| flowruns::summary(host, token, &since)).await
}

/// A Power Automate API token. When the refresh fails for it (an `AADSTS…`
/// answer) while the Dataverse one still works, the tenant blocks this resource
/// for the account (Conditional Access, consent): signing in again won't help,
/// so it's FLOW_API_DENIED rather than SIGN_IN_REQUIRED.
async fn flow_api_token(state: &AppState, project_id: &str, host: &str) -> AppResult<String> {
    match get_access_token(state, project_id, flowapi::RESOURCE).await {
        Ok(token) => Ok(token),
        Err(e) => {
            let msg = e.to_string();
            // Not an answer about this resource, or the sign-in itself expired.
            let expired = ["AADSTS70008", "AADSTS70043", "AADSTS700082", "AADSTS50133", "AADSTS50173"];
            if !msg.contains("AADSTS") || expired.iter().any(|c| msg.contains(c)) {
                return Err(e);
            }
            get_access_token(state, project_id, &format!("https://{}", host)).await?;
            let reason = msg
                .strip_prefix(auth::SIGN_IN_REQUIRED)
                .and_then(|rest| rest.splitn(3, ':').nth(2))
                .unwrap_or(&msg);
            Err(flowapi::denied(&format!("Sign-in to Power Automate was refused: {}", reason.trim())))
        }
    }
}

/// Runs `f(host, dataverse token, Power Automate token)` on a blocking thread.
async fn on_flow_api<T: Send + 'static>(
    state: &AppState,
    connection_id: &str,
    f: impl FnOnce(&str, &str, &str) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let (conn, project_id) = connection_project(connection_id)?;
    let dv = get_access_token(state, &project_id, &format!("https://{}", conn.host)).await?;
    let api = flow_api_token(state, &project_id, &conn.host).await?;
    let host = conn.host.clone();
    tokio::task::spawn_blocking(move || f(&host, &dv, &api)).await.map_err(AppError::msg)?
}

/// A cloud flow run's trigger and actions, from the Power Automate API.
#[tauri::command]
async fn flow_run_steps(
    state: State<'_, AppState>,
    connection_id: String,
    flow_id: String,
    run_name: String,
) -> AppResult<flowapi::RunSteps> {
    on_flow_api(state.inner(), &connection_id, move |host, dv, api| flowapi::run_steps(host, dv, api, &flow_id, &run_name)).await
}

/// Every repetition of a step inside a loop.
#[tauri::command]
async fn flow_run_step_repetitions(
    state: State<'_, AppState>,
    connection_id: String,
    flow_id: String,
    run_name: String,
    step: String,
) -> AppResult<Vec<flowapi::Step>> {
    on_flow_api(state.inner(), &connection_id, move |host, dv, api| flowapi::repetitions(host, dv, api, &flow_id, &run_name, &step)).await
}

/// Searches one run's step inputs and outputs for a value (Runs › Find in run data).
#[tauri::command]
async fn flow_run_search(
    state: State<'_, AppState>,
    connection_id: String,
    flow_id: String,
    run_name: String,
    needle: String,
    scope: flowapi::SearchScope,
    search_id: String,
) -> AppResult<flowapi::RunSearch> {
    on_flow_api(state.inner(), &connection_id, move |host, dv, api| {
        flowapi::search_run(host, dv, api, &flow_id, &run_name, &needle, &scope, &search_id)
    })
    .await
}

/// Which of these steps ran in one run (Runs › Catch ran).
#[tauri::command]
async fn flow_run_steps_ran(
    state: State<'_, AppState>,
    connection_id: String,
    flow_id: String,
    run_name: String,
    steps: Vec<String>,
    search_id: String,
) -> AppResult<flowapi::RunSearch> {
    on_flow_api(state.inner(), &connection_id, move |host, dv, api| {
        flowapi::steps_ran(host, dv, api, &flow_id, &run_name, &steps, &search_id)
    })
    .await
}

/// Ends the runs a stopped search is still reading.
#[tauri::command]
fn flow_run_search_stop(search_id: String) {
    flowapi::stop_search(&search_id);
}

/// A step's inputs or outputs, behind the signed link the API gave.
#[tauri::command]
async fn flow_run_content(state: State<'_, AppState>, connection_id: String, link: String) -> AppResult<flowapi::Content> {
    on_flow_api(state.inner(), &connection_id, move |_, _, api| flowapi::content(&link, api)).await
}

/// Opens the run in the Power Automate portal (the browser has its own sign-in).
#[tauri::command]
async fn open_flow_run(state: State<'_, AppState>, connection_id: String, flow_id: String, run_name: String) -> AppResult<()> {
    let url = on_env(state.inner(), &connection_id, move |host, token| {
        flowapi::portal_url(&flowapi::environment_id(host, token)?, &flow_id, &run_name)
    })
    .await?;
    webbrowser::open(&url)?;
    Ok(())
}

/// Runs file / git work for flow tasks off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(AppError::msg)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FlowTaskDefaults {
    default_root: String,
    git_available: bool,
}

/// Every flow task folder the user created or opened.
#[tauri::command]
async fn flow_tasks() -> AppResult<Vec<flowtasks::TaskSummary>> {
    blocking(|| Ok(flowtasks::list())).await
}

/// Where new tasks go by default, and whether git is installed.
#[tauri::command]
async fn flow_task_defaults() -> AppResult<FlowTaskDefaults> {
    blocking(|| Ok(FlowTaskDefaults { default_root: flowtasks::default_root(), git_available: flowtasks::git_available() })).await
}

/// Checks where a new task folder would go (exists, inside a repo, OneDrive).
#[tauri::command]
async fn flow_task_location(parent: String, folder: String) -> AppResult<flowtasks::Location> {
    blocking(move || Ok(flowtasks::check_location(&parent, &folder))).await
}

#[tauri::command]
async fn create_flow_task(task: flowtasks::NewTask) -> AppResult<flowtasks::TaskView> {
    blocking(move || flowtasks::create(task)).await
}

/// Adds an existing task folder (one with a task.json) to the list.
#[tauri::command]
async fn open_flow_task(path: String) -> AppResult<flowtasks::TaskView> {
    blocking(move || flowtasks::open(&path)).await
}

/// Takes a task off the list; the folder stays.
#[tauri::command]
async fn forget_flow_task(path: String) -> AppResult<()> {
    blocking(move || flowtasks::forget(&path)).await
}

/// The task and the state of its flows' files (called again to notice edits).
#[tauri::command]
async fn flow_task(path: String) -> AppResult<flowtasks::TaskView> {
    blocking(move || flowtasks::load(&path)).await
}

#[tauri::command]
async fn update_flow_task(path: String, name: String, ticket: String, description: String, status: String) -> AppResult<flowtasks::TaskView> {
    blocking(move || flowtasks::update_details(&path, &name, &ticket, &description, &status)).await
}

/// Reads flows from the environment and checks them out into the task.
#[tauri::command]
async fn add_task_flows(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    flows: Vec<flowtasks::AddFlow>,
) -> AppResult<flowtasks::TaskView> {
    on_env(state.inner(), &connection_id, move |host, token| flowtasks::add_flows(&path, host, token, &flows)).await
}

#[tauri::command]
async fn remove_task_flow(path: String, flow_id: String) -> AppResult<flowtasks::TaskView> {
    blocking(move || flowtasks::remove_flow(&path, &flow_id)).await
}

/// Marks the working version (`hash`) as reviewed; null clears it.
#[tauri::command]
async fn set_task_flow_reviewed(path: String, flow_id: String, hash: Option<String>) -> AppResult<flowtasks::TaskView> {
    blocking(move || flowtasks::set_reviewed(&path, &flow_id, hash)).await
}

/// Earlier versions of a task flow's file (git commits or snapshots), newest first.
#[tauri::command]
async fn task_flow_versions(path: String, flow_id: String) -> AppResult<Vec<flowtasks::Version>> {
    blocking(move || flowtasks::versions(&path, &flow_id)).await
}

/// The text of a version: baseline, working, git:<sha>, snap:<file>.
#[tauri::command]
async fn task_flow_text(path: String, flow_id: String, version: String) -> AppResult<String> {
    blocking(move || flowtasks::version_text(&path, &flow_id, &version)).await
}

/// The task's flows as they are in the environment now.
#[tauri::command]
async fn task_live(state: State<'_, AppState>, connection_id: String, path: String) -> AppResult<Vec<flowtasks::LiveFlow>> {
    on_env(state.inner(), &connection_id, move |host, token| flowtasks::live(&path, host, token)).await
}

/// Reads a task flow from the environment again as its baseline; `mode` says what happens to the edits.
#[tauri::command]
async fn update_task_baseline(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    flow_id: String,
    mode: flowtasks::BaselineMode,
) -> AppResult<flowtasks::TaskView> {
    on_env(state.inner(), &connection_id, move |host, token| flowtasks::update_baseline(&path, host, token, &flow_id, mode)).await
}

/// Deploys a version of a task flow to its environment; only DEV-tagged connections.
#[tauri::command]
async fn deploy_task_flow(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    flow_id: String,
    version: String,
) -> AppResult<flowtasks::TaskView> {
    let (conn, _) = connection_project(&connection_id)?;
    if !conn.tag.as_deref().is_some_and(|t| t.trim().eq_ignore_ascii_case("DEV")) {
        return Err(AppError::msg(format!(
            "{} isn't tagged DEV. Flows are only deployed to DEV environments; set the tag in the connection's settings.",
            conn.name
        )));
    }
    on_env(state.inner(), &connection_id, move |host, token| flowtasks::deploy(&path, host, token, &flow_id, &version)).await
}

/// Opens the task folder in Explorer.
#[tauri::command]
async fn reveal_flow_task(path: String) -> AppResult<()> {
    blocking(move || flowtasks::reveal(&path)).await
}

/// Folder picker (for a task's location, or an existing task); None when cancelled.
#[tauri::command]
async fn pick_folder(window: tauri::WebviewWindow, title: String, start: Option<String>) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tokio::task::spawn_blocking(move || {
        let mut dialog = window.dialog().file().set_parent(&window).set_title(title);
        if let Some(start) = start.filter(|s| std::path::Path::new(s).is_dir()) {
            dialog = dialog.set_directory(start);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(AppError::msg)?;
    let Some(picked) = picked else { return Ok(None) };
    Ok(Some(picked.into_path().map_err(AppError::msg)?.to_string_lossy().to_string()))
}

/// Plug-in assemblies, types, service endpoints and a slim index of every step.
#[tauri::command]
async fn plugin_overview(state: State<'_, AppState>, connection_id: String, hide_microsoft: bool) -> AppResult<plugins::Overview> {
    on_env(state.inner(), &connection_id, move |host, token| plugins::overview(host, token, hide_microsoft)).await
}

/// Steps of one handler, one table, or matching a search.
#[tauri::command]
async fn plugin_steps(state: State<'_, AppState>, connection_id: String, query: plugins::StepQuery) -> AppResult<Vec<plugins::Step>> {
    on_env(state.inner(), &connection_id, move |host, token| plugins::steps(host, token, &query)).await
}

/// One step in full, with its images.
#[tauri::command]
async fn plugin_step(state: State<'_, AppState>, connection_id: String, id: String) -> AppResult<plugins::StepDetail> {
    on_env(state.inner(), &connection_id, move |host, token| plugins::step(host, token, &id)).await
}

/// What depends on a table or column; `for_delete`: only what blocks deleting it.
#[tauri::command]
async fn component_dependencies(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
    column: Option<String>,
    for_delete: bool,
) -> AppResult<deps::Report> {
    on_env(state.inner(), &connection_id, move |host, token| {
        deps::report(host, token, &table, column.as_deref(), for_delete)
    })
    .await
}

/// Cloud flows whose definition names the table (and column).
#[tauri::command]
async fn flows_mentioning(
    state: State<'_, AppState>,
    connection_id: String,
    table: String,
    column: Option<String>,
) -> AppResult<Vec<deps::FlowMention>> {
    on_env(state.inner(), &connection_id, move |host, token| {
        deps::flows_mentioning(host, token, &table, column.as_deref())
    })
    .await
}

/// Every visible web resource (no content), with its solutions.
#[tauri::command]
async fn web_resources(state: State<'_, AppState>, connection_id: String) -> AppResult<webresources::WebResourceList> {
    on_env(state.inner(), &connection_id, webresources::list).await
}

/// One web resource with its published and unpublished content.
#[tauri::command]
async fn web_resource(state: State<'_, AppState>, connection_id: String, id: String) -> AppResult<webresources::WebResourceDetail> {
    on_env(state.inner(), &connection_id, move |host, token| webresources::detail(host, token, &id)).await
}

/// What uses a web resource (forms, ribbons, other web resources…);
/// `for_delete`: only what blocks deleting it.
#[tauri::command]
async fn web_resource_dependents(
    state: State<'_, AppState>,
    connection_id: String,
    id: String,
    for_delete: Option<bool>,
) -> AppResult<Vec<deps::DependencyItem>> {
    on_env(state.inner(), &connection_id, move |host, token| {
        deps::dependents_of(host, token, &id, webresources::COMPONENT_WEB_RESOURCE, for_delete.unwrap_or(false))
    })
    .await
}

/// Saves a web resource's content (not published). `base_hash`: refuse when
/// the content on the server isn't the one the editor started from.
#[tauri::command]
async fn save_web_resource(
    state: State<'_, AppState>,
    connection_id: String,
    id: String,
    content: String,
    base_hash: Option<String>,
) -> AppResult<webresources::Saved> {
    on_env(state.inner(), &connection_id, move |host, token| {
        webresources::update(host, token, &id, &content, base_hash.as_deref())
    })
    .await
}

/// Publishes web resources in one request.
#[tauri::command]
async fn publish_web_resources(state: State<'_, AppState>, connection_id: String, ids: Vec<String>) -> AppResult<()> {
    on_env(state.inner(), &connection_id, move |host, token| webresources::publish(host, token, &ids)).await
}

/// Creates a web resource (not published); returns its id.
#[tauri::command]
async fn create_web_resource(state: State<'_, AppState>, connection_id: String, resource: webresources::NewWebResource) -> AppResult<String> {
    on_env(state.inner(), &connection_id, move |host, token| webresources::create(host, token, &resource)).await
}

/// Deletes a web resource.
#[tauri::command]
async fn delete_web_resource(state: State<'_, AppState>, connection_id: String, id: String) -> AppResult<()> {
    on_env(state.inner(), &connection_id, move |host, token| webresources::delete(host, token, &id)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    name: String,
    path: String,
    /// Base64.
    content: String,
    size: usize,
}

/// Asks for a file to put in a web resource and reads it (base64); `None`
/// when the dialog was cancelled.
#[tauri::command]
async fn open_web_resource_file(window: tauri::WebviewWindow) -> AppResult<Option<PickedFile>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use tauri_plugin_dialog::DialogExt;
    let picked = tokio::task::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Choose a file")
            .add_filter(
                "Web resources",
                &["js", "html", "htm", "css", "xml", "xsl", "xslt", "png", "jpg", "jpeg", "gif", "ico", "svg", "resx"],
            )
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(AppError::msg)?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(AppError::msg)?;
    if std::fs::metadata(&path)?.len() > MAX_WEB_RESOURCE_FILE as u64 {
        return Err(AppError::msg("This file is too large for a web resource."));
    }
    let bytes = std::fs::read(&path)?;
    Ok(Some(PickedFile {
        name: file_name(&path),
        path: path.to_string_lossy().to_string(),
        size: bytes.len(),
        content: STANDARD.encode(bytes),
    }))
}

/// Opens the published web resource in the browser.
#[tauri::command]
fn open_web_resource(connection_id: String, name: String) -> AppResult<()> {
    let (conn, _) = connection_project(&connection_id)?;
    webbrowser::open(&webresources::url(&conn.host, &name)?)?;
    Ok(())
}

/// Largest web resource written to disk (Dataverse's own limit is lower).
const MAX_WEB_RESOURCE_FILE: usize = 64 * 1024 * 1024;

/// Saves a web resource's content (base64) to a file the user picks; `None`
/// when the dialog was cancelled.
#[tauri::command]
async fn save_web_resource_file(window: tauri::WebviewWindow, content: String, file_name: String) -> AppResult<Option<XmlFile>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use tauri_plugin_dialog::DialogExt;
    if content.len() > MAX_WEB_RESOURCE_FILE {
        return Err(AppError::msg("This web resource is too large to save."));
    }
    let bytes = STANDARD.decode(content.trim()).map_err(|_| AppError::msg("The web resource's content isn't valid base64."))?;
    let suggested = file_name.rsplit(['/', '\\']).next().unwrap_or("").to_string();
    let ext = std::path::Path::new(&suggested).extension().map(|e| e.to_string_lossy().to_string());
    let picked = tokio::task::spawn_blocking(move || {
        let mut dialog = window.dialog().file().set_parent(&window).set_title("Save web resource").set_file_name(suggested);
        if let Some(ext) = &ext {
            dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
        }
        dialog.add_filter("All files", &["*"]).blocking_save_file()
    })
    .await
    .map_err(AppError::msg)?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(AppError::msg)?;
    std::fs::write(&path, bytes)?;
    Ok(Some(XmlFile { name: self::file_name(&path), path: path.to_string_lossy().to_string(), contents: None }))
}

#[tauri::command]
async fn security_users(state: State<'_, AppState>, connection_id: String) -> AppResult<Vec<security::User>> {
    on_env(state.inner(), &connection_id, |host, token| security::users(host, token)).await
}

#[tauri::command]
async fn security_roles(state: State<'_, AppState>, connection_id: String) -> AppResult<Vec<security::Role>> {
    on_env(state.inner(), &connection_id, |host, token| security::roles(host, token)).await
}

/// A user's roles: their own and their teams'.
#[tauri::command]
async fn user_roles(state: State<'_, AppState>, connection_id: String, user_id: String) -> AppResult<security::UserRoles> {
    on_env(state.inner(), &connection_id, move |host, token| security::user_roles(host, token, &user_id)).await
}

#[tauri::command]
async fn role_privileges(state: State<'_, AppState>, connection_id: String, role_id: String) -> AppResult<Vec<security::Privilege>> {
    on_env(state.inner(), &connection_id, move |host, token| security::role_privileges(host, token, &role_id)).await
}

/// What access a user has to one record, and who owns it.
#[tauri::command]
async fn principal_access(
    state: State<'_, AppState>,
    connection_id: String,
    user_id: String,
    table: String,
    record_id: String,
) -> AppResult<security::AccessCheck> {
    on_env(state.inner(), &connection_id, move |host, token| {
        security::principal_access(host, token, &user_id, &table, &record_id)
    })
    .await
}

/// A file the app saved for the user (exported rows, a web resource).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct XmlFile {
    path: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    contents: Option<String>,
}

fn file_name(path: &std::path::Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// Saves exported rows (`extension` = "csv" or "json") to a file the user
/// picks; `None` when the dialog was cancelled. CSV gets a UTF-8 BOM so
/// Excel reads accents right.
#[tauri::command]
async fn export_file(
    window: tauri::WebviewWindow,
    contents: String,
    suggested_name: String,
    extension: String,
) -> AppResult<Option<XmlFile>> {
    use tauri_plugin_dialog::DialogExt;
    let ext = extension.to_ascii_lowercase();
    let label = match ext.as_str() {
        "csv" => "CSV",
        "json" => "JSON",
        _ => return Err(AppError::msg("Rows are exported as .csv or .json.")),
    };
    let ext_for_dialog = ext.clone();
    let picked = tokio::task::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Export rows")
            .set_file_name(suggested_name)
            .add_filter(label, &[ext_for_dialog.as_str()])
            .blocking_save_file()
    })
    .await
    .map_err(AppError::msg)?;
    let Some(picked) = picked else { return Ok(None) };
    let mut path = picked.into_path().map_err(AppError::msg)?;
    let same_ext = path
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case(&ext))
        .unwrap_or(false);
    if !same_ext {
        path.set_extension(&ext);
    }
    let mut bytes = Vec::with_capacity(contents.len() + 3);
    if ext == "csv" {
        bytes.extend_from_slice(b"\xEF\xBB\xBF");
    }
    bytes.extend_from_slice(contents.as_bytes());
    std::fs::write(&path, bytes)?;
    Ok(Some(XmlFile { name: file_name(&path), path: path.to_string_lossy().to_string(), contents: None }))
}

/// One page of a FetchXML query from the REST builder. `entity` is the
/// root `<entity name>`; the webview adds the paging attributes itself.
#[tauri::command]
async fn run_fetchxml(
    state: State<'_, AppState>,
    connection_id: String,
    entity: String,
    fetch_xml: String,
) -> AppResult<fetchxml::FetchPage> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    let key = format!("{}|{}", host, entity.to_ascii_lowercase());
    let known = state.entity_sets.lock().ok().and_then(|m| m.get(&key).cloned());
    let entity_set = match known {
        Some(set) => set,
        None => {
            let (h, t) = (host.clone(), token.clone());
            let set = tokio::task::spawn_blocking(move || metadata::entity_set_name(&h, &t, &entity))
                .await
                .map_err(AppError::msg)??;
            if let Ok(mut m) = state.entity_sets.lock() {
                m.insert(key, set.clone());
            }
            set
        }
    };
    let page = tokio::task::spawn_blocking(move || fetchxml::run(&host, &token, &entity_set, &fetch_xml))
        .await
        .map_err(AppError::msg)??;
    let _ = connection::touch(&connection_id);
    Ok(page)
}

/// A read-only (GET) Web API request built in the REST builder: `path` is
/// relative to the Web API root, or an `@odata.nextLink`.
#[tauri::command]
async fn webapi_get(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    prefer: Option<String>,
) -> AppResult<webapi::ApiResponse> {
    let r = on_env(state.inner(), &connection_id, move |host, token| webapi::get(host, token, &path, prefer.as_deref())).await?;
    let _ = connection::touch(&connection_id);
    Ok(r)
}

/// What the REST builder needs about a table (entity set, columns, navigation properties).
#[tauri::command]
async fn rest_table(state: State<'_, AppState>, connection_id: String, table: String) -> AppResult<webapi::RestTable> {
    on_env(state.inner(), &connection_id, move |host, token| webapi::table(host, token, &table)).await
}

/// Step 1 of a write: find the affected rows and build the requests.
#[tauri::command]
async fn prepare_dml(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> AppResult<dml::DmlPreview> {
    let (conn, project_id) = connection_project(&connection_id)?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", conn.host)).await?;
    let host = conn.host.clone();
    let plan = tokio::task::spawn_blocking(move || dml::prepare(&host, &token, &sql))
        .await
        .map_err(AppError::msg)??;

    let plan_id = uuid::Uuid::new_v4().to_string();
    let preview = plan.preview(plan_id.clone());
    if let Ok(mut plans) = state.plans.lock() {
        plans.clear(); // only the latest statement can be confirmed
        plans.insert(plan_id, (project_id, plan));
    }
    Ok(preview)
}

/// Step 2 of a write: the user confirmed — send the requests.
#[tauri::command]
async fn execute_dml(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
) -> AppResult<dml::DmlResult> {
    const EXPIRED: &str = "This change has expired — run the statement again.";
    // The token first: when it needs a new sign-in, the plan stays for the retry.
    let (project_id, host) = state
        .plans
        .lock()
        .ok()
        .and_then(|plans| plans.get(&plan_id).map(|(p, plan)| (p.clone(), plan.host().to_string())))
        .ok_or_else(|| AppError::msg(EXPIRED))?;
    let token = get_access_token(state.inner(), &project_id, &format!("https://{}", host)).await?;
    let (_, plan) = state
        .plans
        .lock()
        .ok()
        .and_then(|mut plans| plans.remove(&plan_id))
        .ok_or_else(|| AppError::msg(EXPIRED))?;

    let max_workers = config::load_settings().worker_threads as usize;
    let result = tokio::task::spawn_blocking(move || {
        dml::execute(&plan, &token, max_workers, &|p: dml::DmlProgress| {
            let _ = app.emit("dml-progress", p);
        })
    })
    .await
    .map_err(AppError::msg)?;
    Ok(result)
}

#[tauri::command]
fn discard_dml(state: State<'_, AppState>, plan_id: String) {
    if let Ok(mut plans) = state.plans.lock() {
        plans.remove(&plan_id);
    }
}

#[tauri::command]
fn get_settings() -> config::Settings {
    config::load_settings()
}

#[tauri::command]
fn set_settings(client_id: String, tenant: String, worker_threads: u32) -> AppResult<config::Settings> {
    let settings = config::Settings {
        worker_threads: worker_threads.min(dml::MAX_WORKERS as u32),
        client_id: if client_id.trim().is_empty() {
            config::DEFAULT_CLIENT_ID.to_string()
        } else {
            client_id.trim().to_string()
        },
        tenant: if tenant.trim().is_empty() {
            config::DEFAULT_TENANT.to_string()
        } else {
            tenant.trim().to_string()
        },
    };
    config::save_settings(&settings)?;
    Ok(settings)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(update::UpdateState::default())
        .setup(|_app| {
            // Wraps a pre-projects install (one account + its connections)
            // into a first project.
            project::migrate();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            update_project,
            delete_project,
            sign_in,
            sign_out,
            cancel_sign_in,
            list_environments,
            list_connections,
            save_connection,
            update_connection,
            delete_connection,
            run_query,
            result_rows,
            list_tables,
            list_columns,
            table_choices,
            list_flows,
            flow_definition,
            flow_calls,
            flow_runs,
            flow_run_summary,
            flow_run_access,
            flow_run_steps,
            flow_run_step_repetitions,
            flow_run_content,
            flow_run_search,
            flow_run_search_stop,
            flow_run_steps_ran,
            open_flow_run,
            flow_tasks,
            flow_task_defaults,
            flow_task_location,
            create_flow_task,
            open_flow_task,
            forget_flow_task,
            flow_task,
            update_flow_task,
            add_task_flows,
            remove_task_flow,
            set_task_flow_reviewed,
            task_flow_versions,
            task_flow_text,
            task_live,
            update_task_baseline,
            deploy_task_flow,
            reveal_flow_task,
            pick_folder,
            run_fetchxml,
            webapi_get,
            rest_table,
            trace_logs,
            trace_log,
            system_jobs,
            system_job,
            desktop_flows,
            desktop_flow,
            desktop_flow_runs,
            desktop_flow_run,
            flow_machines,
            open_record,
            open_docs,
            plugin_overview,
            plugin_steps,
            plugin_step,
            component_dependencies,
            flows_mentioning,
            web_resources,
            web_resource,
            web_resource_dependents,
            open_web_resource,
            save_web_resource_file,
            save_web_resource,
            publish_web_resources,
            create_web_resource,
            delete_web_resource,
            open_web_resource_file,
            security_users,
            security_roles,
            user_roles,
            role_privileges,
            principal_access,
            export_file,
            prepare_dml,
            execute_dml,
            discard_dml,
            get_settings,
            set_settings,
            update::check_update,
            update::download_update,
            update::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hexa Studio");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn long_text_is_clipped_for_the_grid_only_when_needed() {
        let short = vec![vec![json!("a"), json!(1), json!(null)]];
        assert!(clip_rows(&short).is_none());

        let long = "x".repeat(UI_CELL_CHARS + 50);
        let rows = vec![vec![json!(long), json!(2)], vec![json!("b"), json!(3)]];
        let clipped = clip_rows(&rows).unwrap();
        let cell = clipped[0][0].as_str().unwrap();
        assert_eq!(cell.chars().count(), UI_CELL_CHARS + 1);
        assert!(cell.ends_with('…'));
        assert_eq!(clipped[0][1], json!(2));
        assert_eq!(clipped[1], rows[1]);
    }
}
