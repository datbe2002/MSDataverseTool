//! Saved connections, persisted as JSON in the config directory.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    /// Owning project (one tenant / signed-in account).
    #[serde(default)]
    pub project_id: String,
    pub name: String,
    pub url: String,
    pub host: String,
    pub api_url: String,
    pub friendly_name: String,
    pub last_used: Option<String>,
    /// Short label shown next to the connection, e.g. "UAT" or "PROD".
    #[serde(default)]
    pub tag: Option<String>,
    /// Palette key for the tag (red, amber, green, blue, violet, pink, cyan, slate).
    #[serde(default)]
    pub color: Option<String>,
}

/// Guess a tag + colour from a name like "Sales UAT" or "Contoso PROD".
/// Order matters: production keywords win over everything else.
fn infer_tag(name: &str) -> Option<(String, String)> {
    const RULES: &[(&str, &str, &str)] = &[
        ("prod", "PROD", "red"),
        ("production", "PROD", "red"),
        ("live", "PROD", "red"),
        ("uat", "UAT", "amber"),
        ("staging", "UAT", "amber"),
        ("stage", "UAT", "amber"),
        ("preprod", "UAT", "amber"),
        ("sit", "SIT", "violet"),
        ("qa", "QA", "blue"),
        ("test", "TEST", "blue"),
        ("dev", "DEV", "green"),
        ("sandbox", "DEV", "green"),
        ("trial", "DEV", "green"),
    ];
    let lower = name.to_ascii_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    RULES
        .iter()
        .find(|(key, _, _)| words.iter().any(|w| w == key))
        .map(|(_, tag, color)| (tag.to_string(), color.to_string()))
}

fn path() -> std::path::PathBuf {
    crate::config::config_dir().join("connections.json")
}

pub fn list() -> Vec<Connection> {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(items: &[Connection]) -> AppResult<()> {
    std::fs::write(path(), serde_json::to_string_pretty(items)?)?;
    Ok(())
}

/// Returns (base_url, host, api_url)
fn normalize(url: &str) -> AppResult<(String, String, String)> {
    let mut u = url.trim().to_string();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        u = format!("https://{}", u);
    }
    let parsed = url::Url::parse(&u)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::msg("Invalid environment URL: no host found"))?
        .to_string();
    let base = format!("https://{}", host);
    let api = format!("{}/api/data/v9.2", base);
    Ok((base, host, api))
}

/// One-time migration: put every existing connection into `project_id`.
pub fn assign_all(project_id: &str) -> AppResult<()> {
    let mut items = list();
    if items.is_empty() {
        return Ok(());
    }
    for c in items.iter_mut() {
        if c.project_id.is_empty() {
            c.project_id = project_id.to_string();
        }
    }
    write(&items)
}

/// Drops every connection of a project; returns the ids that were removed.
pub fn remove_for_project(project_id: &str) -> AppResult<Vec<String>> {
    let items = list();
    let removed: Vec<String> = items
        .iter()
        .filter(|c| c.project_id == project_id)
        .map(|c| c.id.clone())
        .collect();
    let kept: Vec<Connection> = items
        .into_iter()
        .filter(|c| c.project_id != project_id)
        .collect();
    write(&kept)?;
    Ok(removed)
}

pub fn save(project_id: &str, url: &str, name: &str) -> AppResult<Connection> {
    let (base, host, api) = normalize(url)?;
    let mut items = list();

    // The same environment can exist under two projects (different accounts),
    // so uniqueness is per project.
    if let Some(existing) = items
        .iter_mut()
        .find(|c| c.host == host && c.project_id == project_id)
    {
        if !name.trim().is_empty() {
            existing.name = name.trim().to_string();
        }
        let cloned = existing.clone();
        write(&items)?;
        return Ok(cloned);
    }

    let display = if name.trim().is_empty() {
        host.clone()
    } else {
        name.trim().to_string()
    };
    let (tag, color) = match infer_tag(&display) {
        Some((t, c)) => (Some(t), Some(c)),
        None => (None, None),
    };
    let conn = Connection {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        name: display,
        url: base,
        host: host.clone(),
        api_url: api,
        friendly_name: host,
        last_used: None,
        tag,
        color,
    };
    items.push(conn.clone());
    write(&items)?;
    Ok(conn)
}

pub fn update(
    id: &str,
    name: &str,
    tag: Option<String>,
    color: Option<String>,
) -> AppResult<Connection> {
    let mut items = list();
    let conn = items
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::msg("Connection not found"))?;
    if !name.trim().is_empty() {
        conn.name = name.trim().to_string();
    }
    conn.tag = tag
        .map(|t| t.trim().to_uppercase())
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(12).collect());
    conn.color = color.filter(|c| !c.trim().is_empty());
    let updated = conn.clone();
    write(&items)?;
    Ok(updated)
}

pub fn get(id: &str) -> Option<Connection> {
    list().into_iter().find(|c| c.id == id)
}

pub fn remove(id: &str) -> AppResult<()> {
    let mut items = list();
    items.retain(|c| c.id != id);
    write(&items)
}

pub fn touch(id: &str) -> AppResult<()> {
    let mut items = list();
    if let Some(c) = items.iter_mut().find(|c| c.id == id) {
        c.last_used = Some(chrono::Utc::now().to_rfc3339());
    }
    write(&items)
}
