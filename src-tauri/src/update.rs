//! In-app updates, driven from Rust. The updater plugin's JS `download()`
//! sends one IPC message per network chunk (a few KB each), and the webview
//! works through thousands of them for a 15 MB installer — far slower than
//! the download itself. Here the chunks stay in Rust and the webview gets
//! a progress event a few times a second.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Gap between two `update-progress` events.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

#[derive(Default)]
pub struct UpdateState {
    /// Found by `check_update`, waiting for `download_update`.
    found: Mutex<Option<Update>>,
    /// Downloaded and verified, waiting for `install_update`.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Looks for a newer version; `None` when this one is the latest.
#[tauri::command]
pub async fn check_update(app: AppHandle, state: State<'_, UpdateState>) -> AppResult<Option<UpdateInfo>> {
    let update = app.updater()?.check().await?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() });
    *state.found.lock().map_err(AppError::msg)? = update;
    Ok(info)
}

/// Downloads the update `check_update` found, emitting `update-progress`
/// (0..1, when the size is known) as it goes. The signature is checked here.
#[tauri::command]
pub async fn download_update(app: AppHandle, state: State<'_, UpdateState>) -> AppResult<()> {
    let update = state
        .found
        .lock()
        .map_err(AppError::msg)?
        .take()
        .ok_or_else(|| AppError::msg("No update to download — check for updates first."))?;
    let mut done: u64 = 0;
    let mut last = Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    if last.elapsed() >= PROGRESS_EVERY {
                        last = Instant::now();
                        let _ = app.emit("update-progress", (done as f64 / total as f64).min(1.0));
                    }
                }
            },
            || {},
        )
        .await?;
    *state.ready.lock().map_err(AppError::msg)? = Some((update, bytes));
    Ok(())
}

/// Runs the downloaded installer. On Windows this exits the app, and the
/// installer reopens the new version.
#[tauri::command]
pub fn install_update(state: State<'_, UpdateState>) -> AppResult<()> {
    let ready = state.ready.lock().map_err(AppError::msg)?;
    let (update, bytes) = ready.as_ref().ok_or_else(|| AppError::msg("The update isn't downloaded yet."))?;
    update.install(bytes)?;
    Ok(())
}
