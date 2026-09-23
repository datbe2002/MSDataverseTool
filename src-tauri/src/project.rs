//! Projects — one sign-in (tenant + account) plus the environments under it.
//!
//! A user who works with several customers signs in once per project (ACME,
//! Fabrikam, …); each project keeps its own refresh token, so they stay signed in
//! side by side. Connections belong to exactly one project.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Entra tenant to sign in against: empty = the global default
    /// ("organizations"), or a tenant GUID / domain to pin one tenant.
    #[serde(default)]
    pub tenant: String,
    /// Optional per-project public client id (empty = global setting).
    #[serde(default)]
    pub client_id: Option<String>,
    /// The account this project is signed in as, from the id token.
    #[serde(default)]
    pub username: Option<String>,
    /// Palette key, same set as connection tags.
    #[serde(default)]
    pub color: Option<String>,
    pub created_at: String,
}

const PALETTE: &[&str] = &["violet", "blue", "cyan", "green", "amber", "pink", "red", "slate"];

fn path() -> PathBuf {
    crate::config::config_dir().join("projects.json")
}

pub fn list() -> Vec<Project> {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(items: &[Project]) -> AppResult<()> {
    std::fs::write(path(), serde_json::to_string_pretty(items)?)?;
    Ok(())
}

pub fn get(id: &str) -> Option<Project> {
    list().into_iter().find(|p| p.id == id)
}

/// The project a connection belongs to, falling back to the first project for
/// entries saved before projects existed.
pub fn for_connection(project_id: &str) -> Option<Project> {
    if !project_id.is_empty() {
        if let Some(p) = get(project_id) {
            return Some(p);
        }
    }
    list().into_iter().next()
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn create(
    name: &str,
    tenant: Option<String>,
    client_id: Option<String>,
    color: Option<String>,
) -> AppResult<Project> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("A project needs a name"));
    }
    let mut items = list();
    if items.iter().any(|p| p.name.eq_ignore_ascii_case(name)) {
        return Err(AppError::msg(format!("A project called \"{}\" already exists", name)));
    }
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        tenant: clean(tenant).unwrap_or_default(),
        client_id: clean(client_id),
        username: None,
        color: clean(color).or_else(|| Some(PALETTE[items.len() % PALETTE.len()].to_string())),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    items.push(project.clone());
    write(&items)?;
    Ok(project)
}

pub fn update(
    id: &str,
    name: &str,
    tenant: Option<String>,
    client_id: Option<String>,
    color: Option<String>,
) -> AppResult<Project> {
    let mut items = list();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("A project needs a name"));
    }
    if items
        .iter()
        .any(|p| p.id != id && p.name.eq_ignore_ascii_case(&name))
    {
        return Err(AppError::msg(format!("A project called \"{}\" already exists", name)));
    }
    let project = items
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::msg("Project not found"))?;
    project.name = name;
    project.tenant = clean(tenant).unwrap_or_default();
    project.client_id = clean(client_id);
    project.color = clean(color).or_else(|| project.color.clone());
    let updated = project.clone();
    write(&items)?;
    Ok(updated)
}

pub fn set_username(id: &str, username: Option<String>) -> AppResult<()> {
    let mut items = list();
    if let Some(p) = items.iter_mut().find(|p| p.id == id) {
        p.username = clean(username);
        write(&items)?;
    }
    Ok(())
}

/// Removes the project and everything under it; returns the connection ids
/// that went with it so the UI can drop their saved tabs.
pub fn remove(id: &str) -> AppResult<Vec<String>> {
    let mut items = list();
    if !items.iter().any(|p| p.id == id) {
        return Err(AppError::msg("Project not found"));
    }
    items.retain(|p| p.id != id);
    write(&items)?;
    let _ = crate::auth::clear_refresh_token(id);
    crate::connection::remove_for_project(id)
}

/// Derives a friendly project name from an account: `dat@acme.com` → `ACME`.
fn name_from_username(username: &str) -> Option<String> {
    let label = username.split('@').nth(1)?.split('.').next()?;
    if label.is_empty() {
        return None;
    }
    if label.len() <= 5 {
        return Some(label.to_uppercase());
    }
    let mut chars = label.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().collect::<String>() + chars.as_str())
}

/// First run after the multi-project upgrade: wrap whatever the user already
/// had (one account, its connections, its refresh token) into one project.
pub fn migrate() {
    if path().exists() {
        return;
    }
    let account = crate::config::load_account();
    let name = account
        .as_deref()
        .and_then(name_from_username)
        .unwrap_or_else(|| "My tenant".to_string());
    let settings = crate::config::load_settings();
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        tenant: if settings.tenant == crate::config::DEFAULT_TENANT {
            String::new()
        } else {
            settings.tenant
        },
        client_id: None,
        username: account,
        color: Some(PALETTE[0].to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    if write(std::slice::from_ref(&project)).is_err() {
        return;
    }
    let _ = crate::connection::assign_all(&project.id);
    if let Some(token) = crate::auth::take_legacy_refresh_token() {
        let _ = crate::auth::store_refresh_token(&project.id, &token);
    }
}

#[cfg(test)]
mod tests {
    use super::name_from_username;

    #[test]
    fn project_name_comes_from_the_email_domain() {
        assert_eq!(name_from_username("dat@acme.com").as_deref(), Some("ACME"));
        assert_eq!(name_from_username("a.b@abc.com.vn").as_deref(), Some("ABC"));
        assert_eq!(name_from_username("x@contoso.com").as_deref(), Some("Contoso"));
        assert_eq!(name_from_username("nodomain"), None);
    }
}
