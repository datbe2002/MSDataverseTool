//! App configuration: settings, connections directory, cached account name.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Well-known public client (Azure CLI) that supports the loopback/PKCE flow
/// and can be consented for Dataverse resources. Users can override this in
/// Settings with their own registered public client if their tenant blocks it.
pub const DEFAULT_CLIENT_ID: &str = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
pub const DEFAULT_TENANT: &str = "organizations";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub client_id: String,
    pub tenant: String,
    /// Parallel Web API requests for INSERT/UPDATE/DELETE; 0 = follow the
    /// server's `x-ms-dop-hint` (the way SQL 4 CDS does).
    #[serde(default)]
    pub worker_threads: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            client_id: DEFAULT_CLIENT_ID.to_string(),
            tenant: DEFAULT_TENANT.to_string(),
            worker_threads: 0,
        }
    }
}

pub fn config_dir() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("CdsSqlStudio");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn load_settings() -> Settings {
    let path = config_dir().join("settings.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(settings: &Settings) -> AppResult<()> {
    let path = config_dir().join("settings.json");
    std::fs::write(path, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

/// The single account stored before projects existed — read once, by the
/// project migration.
pub fn load_account() -> Option<String> {
    let path = config_dir().join("account.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("username")?.as_str().map(|s| s.to_string())
}
