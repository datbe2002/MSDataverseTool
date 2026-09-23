//! Power Platform Global Discovery Service — lists the environments the
//! signed-in user can access.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};

const DISCOVERY_URL: &str =
    "https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub friendly_name: String,
    pub url: String,
    pub api_url: String,
    pub url_name: String,
    pub version: String,
    pub state: String,
    pub host: String,
}

#[derive(Deserialize)]
struct DiscoResponse {
    #[serde(default)]
    value: Vec<Instance>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Instance {
    #[serde(default)]
    id: String,
    #[serde(default)]
    friendly_name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    api_url: String,
    #[serde(default)]
    url_name: String,
    #[serde(default)]
    version: String,
    /// The API returns this as a number (0 = enabled); accept anything.
    #[serde(default)]
    state: serde_json::Value,
}

fn state_label(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(0) => "Ready".to_string(),
            Some(1) => "Disabled".to_string(),
            Some(other) => format!("State {}", other),
            None => n.to_string(),
        },
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => "Ready".to_string(),
        other => other.to_string(),
    }
}

pub fn list(token: &str) -> AppResult<Vec<Environment>> {
    let resp = ureq::get(DISCOVERY_URL)
        .set("Authorization", &format!("Bearer {}", token))
        .set("Accept", "application/json")
        .call()?;

    let body: DiscoResponse = resp.into_json()?;

    let mut envs: Vec<Environment> = body
        .value
        .into_iter()
        .map(|i| {
            let host = url::Url::parse(&i.url)
                .ok()
                .and_then(|u| u.host_str().map(|s| s.to_string()))
                .unwrap_or_default();
            Environment {
                id: i.id,
                friendly_name: i.friendly_name,
                url: i.url,
                api_url: i.api_url,
                url_name: i.url_name,
                version: i.version,
                state: state_label(&i.state),
                host,
            }
        })
        .collect();

    envs.sort_by(|a, b| a.friendly_name.to_lowercase().cmp(&b.friendly_name.to_lowercase()));
    Ok(envs)
}
