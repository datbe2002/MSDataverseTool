//! Saved views of a table, for the FetchXML tool to open (read only):
//! system views (`savedquery`) and the user's personal views (`userquery`,
//! their own and ones shared with them).

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub name: String,
    /// A personal view (`userquery`) rather than a system view.
    pub personal: bool,
    pub query_type: i64,
    /// "Public", "Advanced Find", "Lookup", …
    pub type_label: String,
    /// The table's default public view.
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub fetch_xml: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewList {
    pub views: Vec<View>,
    /// Personal views couldn't be read (the system views still came back).
    pub personal_error: Option<String>,
}

/// `querytype` of a saved query, as the maker portal names it.
fn type_label(query_type: i64, personal: bool) -> String {
    match query_type {
        0 if personal => "Personal",
        0 => "Public",
        1 => "Advanced Find",
        2 => "Associated",
        4 => "Quick Find",
        16 => "Offline",
        64 => "Lookup",
        128 => "Service",
        256 => "Outlook filter",
        512 => "Address book",
        1024 => "Main application",
        2048 => "Saved query",
        4096 => "Interactive workflow",
        8192 => "Offline template",
        16384 => "Custom",
        32768 => "Outlook template",
        _ => return format!("Type {}", query_type),
    }
    .to_string()
}

fn views_from(body: &Value, personal: bool) -> Vec<View> {
    let id_key = if personal { "userqueryid" } else { "savedqueryid" };
    body.get("value")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let fetch_xml = r.get("fetchxml")?.as_str()?.trim().to_string();
            if fetch_xml.is_empty() {
                return None;
            }
            let query_type = r.get("querytype").and_then(|v| v.as_i64()).unwrap_or(0);
            Some(View {
                id: r.get(id_key)?.as_str()?.to_string(),
                name: r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                personal,
                query_type,
                type_label: type_label(query_type, personal),
                is_default: r.get("isdefault").and_then(|v| v.as_bool()).unwrap_or(false),
                description: r
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                fetch_xml,
            })
        })
        .collect()
}

/// System before personal; public views first (the default one on top), then the rest by type; then by name.
fn sort_views(views: &mut [View]) {
    let key = |v: &View| (v.personal, v.query_type, !v.is_default, v.name.to_lowercase());
    views.sort_by(|a, b| key(a).cmp(&key(b)));
}

/// Active views of `table` that have FetchXML.
pub fn list(host: &str, token: &str, table: &str) -> AppResult<ViewList> {
    let table = table.to_ascii_lowercase();
    if table.is_empty() || !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let base = format!("https://{}/api/data/v9.2", host);
    let filter = format!("returnedtypecode eq '{}' and statecode eq 0", table);
    let system_url = format!(
        "{}/savedqueries?$select=savedqueryid,name,querytype,isdefault,description,fetchxml&$filter={}",
        base, filter
    );
    let personal_url = format!(
        "{}/userqueries?$select=userqueryid,name,querytype,description,fetchxml&$filter={}",
        base, filter
    );
    let (system, personal) = std::thread::scope(|s| {
        let a = s.spawn(|| get_json(&system_url, token, None));
        let b = s.spawn(|| get_json(&personal_url, token, None));
        (
            a.join().unwrap_or_else(|_| Err(AppError::msg("view request panicked"))),
            b.join().unwrap_or_else(|_| Err(AppError::msg("view request panicked"))),
        )
    });
    let mut views = views_from(&system?, false);
    let personal_error = match personal {
        Ok(body) => {
            views.extend(views_from(&body, true));
            None
        }
        Err(e) => Some(e.to_string()),
    };
    sort_views(&mut views);
    Ok(ViewList { views, personal_error })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn views_are_read_labelled_and_sorted() {
        let system = json!({"value":[
            {"savedqueryid":"1","name":"Account Lookup View","querytype":64,"isdefault":true,"fetchxml":"<fetch/>"},
            {"savedqueryid":"2","name":"My Active Accounts","querytype":0,"isdefault":false,"fetchxml":"<fetch/>"},
            {"savedqueryid":"3","name":"Active Accounts","querytype":0,"isdefault":true,"fetchxml":"<fetch/>","description":"  "},
            {"savedqueryid":"4","name":"No query","querytype":0,"fetchxml":null}
        ]});
        let personal = json!({"value":[{"userqueryid":"9","name":"Mine","querytype":0,"fetchxml":"<fetch/>","description":"x"}]});
        let mut views = views_from(&system, false);
        views.extend(views_from(&personal, true));
        sort_views(&mut views);
        let short: Vec<_> = views.iter().map(|v| (v.id.as_str(), v.type_label.as_str())).collect();
        assert_eq!(short, vec![("3", "Public"), ("2", "Public"), ("1", "Lookup"), ("9", "Personal")]);
        assert_eq!(views[0].description, None);
        assert_eq!(views[3].description.as_deref(), Some("x"));
    }
}
