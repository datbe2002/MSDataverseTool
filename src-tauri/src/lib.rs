mod auth;
mod config;
mod connection;
mod discovery;
mod dml;
mod engine;
mod error;
mod flows;
mod http;
mod metadata;
mod project;
mod sql;

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
    let hint = project.username.clone();
    let refresh = auth::load_refresh_token(project_id).ok();
    let resource_owned = resource.to_string();

    let tokens = tokio::task::spawn_blocking(move || -> AppResult<auth::Tokens> {
        if let Some(rt) = refresh {
            if let Ok(t) = auth::refresh(&settings, &resource_owned, &rt) {
                return Ok(t);
            }
        }
        auth::interactive(&settings, &resource_owned, hint.as_deref())
    })
    .await
    .map_err(AppError::msg)??;

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
    let (project_id, plan) = state
        .plans
        .lock()
        .ok()
        .and_then(|mut plans| plans.remove(&plan_id))
        .ok_or_else(|| AppError::msg("This change has expired — run the statement again."))?;
    let token =
        get_access_token(state.inner(), &project_id, &format!("https://{}", plan.host())).await?;

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
        .manage(AppState::default())
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
            list_flows,
            flow_definition,
            flow_calls,
            prepare_dml,
            execute_dml,
            discard_dml,
            get_settings,
            set_settings
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
