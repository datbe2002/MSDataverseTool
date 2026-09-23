//! Table / column metadata for editor autocompletion, read from the Dataverse
//! Web API (`EntityDefinitions`). Uses the same org-scoped token as queries.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub logical_name: String,
    pub display_name: String,
    pub is_custom: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub logical_name: String,
    pub display_name: String,
    pub attribute_type: String,
}

fn label(v: &Value) -> String {
    v.get("UserLocalizedLabel")
        .and_then(|l| l.get("Label"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// GET a Web API URL as JSON; `prefer` is sent as the `Prefer` header.
pub(crate) fn get_json(url: &str, token: &str, prefer: Option<&str>) -> AppResult<Value> {
    let mut req = ureq::get(url)
        .set("Authorization", &format!("Bearer {}", token))
        .set("Accept", "application/json")
        .set("OData-MaxVersion", "4.0")
        .set("OData-Version", "4.0")
        .set("Accept-Encoding", crate::http::ACCEPT_ENCODING);
    if let Some(prefer) = prefer {
        req = req.set("Prefer", prefer);
    }
    let resp = req.call();

    match resp {
        Ok(r) => Ok(crate::http::json(r)?),
        Err(ureq::Error::Status(code, r)) => {
            let text = crate::http::text(r);
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    v.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or(text);
            Err(AppError::msg(format!("Request failed ({}): {}", code, msg)))
        }
        Err(e) => Err(AppError::msg(e.to_string())),
    }
}

pub fn list_tables(host: &str, token: &str) -> AppResult<Vec<TableMeta>> {
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions?$select=LogicalName,DisplayName,IsCustomEntity",
        host
    );
    let body = get_json(&url, token, None)?;

    let mut tables: Vec<TableMeta> = body
        .get("value")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    Some(TableMeta {
                        logical_name: e.get("LogicalName")?.as_str()?.to_string(),
                        display_name: e.get("DisplayName").map(label).unwrap_or_default(),
                        is_custom: e
                            .get("IsCustomEntity")
                            .and_then(|b| b.as_bool())
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    tables.sort_by(|a, b| a.logical_name.cmp(&b.logical_name));
    Ok(tables)
}

fn is_valid_logical_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn list_columns(host: &str, token: &str, table: &str) -> AppResult<Vec<ColumnMeta>> {
    let table = table.to_ascii_lowercase();
    if !is_valid_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')/Attributes?$select=LogicalName,DisplayName,AttributeType",
        host, table
    );
    let body = get_json(&url, token, None)?;

    let mut columns: Vec<ColumnMeta> = body
        .get("value")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    Some(ColumnMeta {
                        logical_name: a.get("LogicalName")?.as_str()?.to_string(),
                        display_name: a.get("DisplayName").map(label).unwrap_or_default(),
                        attribute_type: a
                            .get("AttributeType")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    columns.sort_by(|a, b| a.logical_name.cmp(&b.logical_name));
    Ok(columns)
}

// ---- metadata needed by the FetchXML query engine (engine.rs) ----

/// Readable attributes of a table: (logical name, attribute type).
/// Excludes types FetchXML can't retrieve as plain values.
pub fn readable_attributes(host: &str, token: &str, table: &str) -> AppResult<Vec<(String, String)>> {
    let table = table.to_ascii_lowercase();
    if !is_valid_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')/Attributes?$select=LogicalName,AttributeType,IsValidForRead",
        host, table
    );
    let body = get_json(&url, token, None)?;
    // `Virtual` is kept: the engine turns `<x>name` virtual attributes into
    // label columns and drops the rest.
    const SKIP: &[&str] = &["PartyList", "CalendarRules", "ManagedProperty", "File", "Image"];
    let mut out: Vec<(String, String)> = body
        .get("value")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let readable = a.get("IsValidForRead").and_then(|b| b.as_bool()).unwrap_or(true);
                    let name = a.get("LogicalName")?.as_str()?.to_string();
                    let ty = a.get("AttributeType").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    if !readable || SKIP.contains(&ty.as_str()) {
                        return None;
                    }
                    Some((name, ty))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

// ---- metadata needed to write data (used by dml.rs) ----

pub struct EntityInfo {
    pub entity_set: String,
    pub primary_id: String,
    /// `Standard`, `Activity`, `Virtual` (served by a data provider such as
    /// Microsoft Graph for `aaduser`) or `Elastic` (Cosmos DB).
    pub table_type: String,
}

impl EntityInfo {
    /// Rows live in Dataverse's own SQL database, so FetchXML can filter and
    /// order on any column (virtual and elastic tables only support some).
    pub fn sql_backed(&self) -> bool {
        matches!(self.table_type.as_str(), "Standard" | "Activity")
    }
}

pub fn entity_info(host: &str, token: &str, table: &str) -> AppResult<EntityInfo> {
    let table = table.to_ascii_lowercase();
    if !is_valid_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')?$select=EntitySetName,PrimaryIdAttribute,TableType",
        host, table
    );
    let body = get_json(&url, token, None)?;
    let field = |name: &str| {
        body.get(name)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    Ok(EntityInfo {
        entity_set: field("EntitySetName").ok_or_else(|| {
            AppError::msg(format!("Table `{}` can't be written through the Web API.", table))
        })?,
        primary_id: field("PrimaryIdAttribute")
            .ok_or_else(|| AppError::msg(format!("Table `{}` has no primary key.", table)))?,
        table_type: field("TableType").unwrap_or_else(|| "Standard".to_string()),
    })
}

pub struct WriteAttribute {
    pub attribute_type: String,
    pub valid_for_create: bool,
    pub valid_for_update: bool,
}

pub fn write_attributes(
    host: &str,
    token: &str,
    table: &str,
) -> AppResult<HashMap<String, WriteAttribute>> {
    let table = table.to_ascii_lowercase();
    if !is_valid_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')/Attributes?$select=LogicalName,AttributeType,IsValidForCreate,IsValidForUpdate",
        host, table
    );
    let body = get_json(&url, token, None)?;
    Ok(body
        .get("value")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let name = a.get("LogicalName")?.as_str()?.to_string();
                    let flag = |key: &str| a.get(key).and_then(|b| b.as_bool()).unwrap_or(false);
                    Some((
                        name,
                        WriteAttribute {
                            attribute_type: a
                                .get("AttributeType")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string(),
                            valid_for_create: flag("IsValidForCreate"),
                            valid_for_update: flag("IsValidForUpdate"),
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Lookup relationships: (referencing attribute, referenced table, navigation property).
pub fn many_to_one(host: &str, token: &str, table: &str) -> AppResult<Vec<(String, String, String)>> {
    let table = table.to_ascii_lowercase();
    if !is_valid_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName",
        host, table
    );
    let body = get_json(&url, token, None)?;
    Ok(body
        .get("value")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let s = |key: &str| r.get(key).and_then(|v| v.as_str()).map(|v| v.to_string());
                    Some((
                        s("ReferencingAttribute")?,
                        s("ReferencedEntity")?,
                        s("ReferencingEntityNavigationPropertyName")?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}
