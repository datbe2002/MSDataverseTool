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

/// A table's key and name columns (`accountid`, `name`), for counting rows
/// and for a starting query.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableKeys {
    pub primary_id: String,
    pub primary_name: Option<String>,
}

pub fn table_keys(host: &str, token: &str, table: &str) -> AppResult<TableKeys> {
    let table = table.to_ascii_lowercase();
    if !is_valid_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')?$select=PrimaryIdAttribute,PrimaryNameAttribute",
        host, table
    );
    let body = get_json(&url, token, None)?;
    let field = |name: &str| body.get(name).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    Ok(TableKeys {
        primary_id: field("PrimaryIdAttribute").ok_or_else(|| AppError::msg(format!("Table `{}` has no primary key.", table)))?,
        primary_name: field("PrimaryNameAttribute"),
    })
}

/// The Web API collection a table is read from (`account` → `accounts`).
pub fn entity_set_name(host: &str, token: &str, table: &str) -> AppResult<String> {
    let table = table.to_ascii_lowercase();
    if !is_valid_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')?$select=EntitySetName",
        host, table
    );
    let body = get_json(&url, token, None).map_err(|e| {
        if e.to_string().contains("(404)") {
            AppError::msg(format!("There is no table named `{}` in this environment.", table))
        } else {
            e
        }
    })?;
    body.get("EntitySetName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::msg(format!("Table `{}` can't be read through the Web API.", table)))
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

// ---- relationships, for joins in the FetchXML tool ----

/// A way to join a table to another, as `<link-entity>` attributes.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    /// `manyToOne` (this table's lookup), `oneToMany` (another table's lookup
    /// to this one) or `manyToMany`.
    pub kind: &'static str,
    pub schema_name: String,
    /// The table joined in (`name`); for N:N the table on the other side.
    pub table: String,
    /// Column on `table` (`from`).
    pub from: String,
    /// Column on the queried table (`to`); for N:N its key.
    pub to: String,
    /// N:N: the intersect table, joined first with `from` = `intersect_from`
    /// (its column holding the queried table's key) and `to` = `to`; `table`
    /// is then joined to it with `from` = `from`, `to` = `intersect_to`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intersect: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intersect_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intersect_to: Option<String>,
}

fn relationships_from(table: &str, primary_id: &str, n1: &Value, one_n: &Value, nn: &Value) -> Vec<Relationship> {
    let rows = |v: &Value| v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let s = |r: &Value, key: &str| r.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut out = Vec::new();
    for r in rows(n1) {
        out.push(Relationship {
            kind: "manyToOne",
            schema_name: s(&r, "SchemaName"),
            table: s(&r, "ReferencedEntity"),
            from: s(&r, "ReferencedAttribute"),
            to: s(&r, "ReferencingAttribute"),
            intersect: None,
            intersect_from: None,
            intersect_to: None,
        });
    }
    for r in rows(one_n) {
        out.push(Relationship {
            kind: "oneToMany",
            schema_name: s(&r, "SchemaName"),
            table: s(&r, "ReferencingEntity"),
            from: s(&r, "ReferencingAttribute"),
            to: s(&r, "ReferencedAttribute"),
            intersect: None,
            intersect_from: None,
            intersect_to: None,
        });
    }
    for r in rows(nn) {
        let (e1, e2) = (s(&r, "Entity1LogicalName"), s(&r, "Entity2LogicalName"));
        let (a1, a2) = (s(&r, "Entity1IntersectAttribute"), s(&r, "Entity2IntersectAttribute"));
        // Which side is the queried table (entity 1 for a table related to itself).
        let (other, mine, theirs) = if e1 == table { (e2, a1, a2) } else { (e1, a2, a1) };
        out.push(Relationship {
            kind: "manyToMany",
            schema_name: s(&r, "SchemaName"),
            table: other,
            // Intersect columns are named after the keys they hold.
            from: theirs.clone(),
            to: primary_id.to_string(),
            intersect: Some(s(&r, "IntersectEntityName")),
            intersect_from: Some(mine),
            intersect_to: Some(theirs),
        });
    }
    out.retain(|r| !r.table.is_empty() && !r.from.is_empty() && !r.to.is_empty());
    out.sort_by(|a, b| (a.kind, &a.table, &a.to).cmp(&(b.kind, &b.table, &b.to)));
    out
}

/// Every relationship of `table` (N:1, 1:N, N:N).
pub fn relationships(host: &str, token: &str, table: &str) -> AppResult<Vec<Relationship>> {
    let table = table.to_ascii_lowercase();
    if !is_valid_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let base = format!("https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')", host, table);
    let urls = [
        format!("{}?$select=PrimaryIdAttribute", base),
        format!("{}/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencedAttribute,ReferencingAttribute", base),
        format!("{}/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedAttribute", base),
        format!(
            "{}/ManyToManyRelationships?$select=SchemaName,IntersectEntityName,Entity1LogicalName,Entity1IntersectAttribute,Entity2LogicalName,Entity2IntersectAttribute",
            base
        ),
    ];
    let results: Vec<AppResult<Value>> = std::thread::scope(|s| {
        let handles: Vec<_> = urls.iter().map(|url| s.spawn(move || get_json(url, token, None))).collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err(AppError::msg("metadata request panicked"))))
            .collect()
    });
    let mut it = results.into_iter();
    let mut next = || it.next().unwrap_or_else(|| Err(AppError::msg("missing metadata response")));
    let entity = next()?;
    let (n1, one_n, nn) = (next()?, next()?, next()?);
    let primary_id = entity.get("PrimaryIdAttribute").and_then(|v| v.as_str()).unwrap_or("");
    Ok(relationships_from(&table, primary_id, &n1, &one_n, &nn))
}

// ---- choice labels for the Flows tool (a step compares `statuscode` to 100000001) ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOption {
    pub value: i64,
    pub label: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableChoices {
    /// The table's logical name (it may have been asked for by entity set name).
    pub table: String,
    /// Column logical name → its options (choice, multi-select choice, status, status reason).
    pub columns: HashMap<String, Vec<ChoiceOption>>,
}

/// Choice columns of a table and their options. `table` is a logical name or
/// an entity set name — flows name tables both ways (`account` in a trigger,
/// `accounts` in "List rows").
pub fn table_choices(host: &str, token: &str, table: &str) -> AppResult<TableChoices> {
    let name = table.to_ascii_lowercase();
    if !is_valid_logical_name(&name) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/EntityDefinitions?$select=LogicalName&$filter=LogicalName eq '{}' or EntitySetName eq '{}'",
        host, name, table
    );
    let body = get_json(&url, token, None)?;
    let logical = body
        .get("value")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|e| e.get("LogicalName"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::msg(format!("Table `{}` not found.", table)))?;

    const KINDS: &[&str] = &[
        "PicklistAttributeMetadata",
        "MultiSelectPicklistAttributeMetadata",
        "StatusAttributeMetadata",
        "StateAttributeMetadata",
    ];
    let results: Vec<AppResult<Value>> = std::thread::scope(|s| {
        let handles: Vec<_> = KINDS
            .iter()
            .map(|kind| {
                let url = format!(
                    "https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')/Attributes/Microsoft.Dynamics.CRM.{}?$select=LogicalName&$expand=OptionSet($select=Options)",
                    host, logical, kind
                );
                s.spawn(move || get_json(&url, token, None))
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err(AppError::msg("metadata request panicked"))))
            .collect()
    });

    let mut columns = HashMap::new();
    for body in results {
        for a in body?.get("value").and_then(|v| v.as_array()).into_iter().flatten() {
            let Some(name) = a.get("LogicalName").and_then(|s| s.as_str()) else { continue };
            let options: Vec<ChoiceOption> = a
                .get("OptionSet")
                .and_then(|o| o.get("Options"))
                .and_then(|o| o.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| {
                            Some(ChoiceOption {
                                value: o.get("Value")?.as_i64()?,
                                label: o.get("Label").map(label).unwrap_or_default(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            columns.insert(name.to_string(), options);
        }
    }
    Ok(TableChoices { table: logical, columns })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relationships_become_link_entity_attributes() {
        let n1 = json!({"value":[{"SchemaName":"account_primary_contact","ReferencedEntity":"contact","ReferencedAttribute":"contactid","ReferencingAttribute":"primarycontactid"}]});
        let one_n = json!({"value":[{"SchemaName":"contact_customer_accounts","ReferencingEntity":"contact","ReferencingAttribute":"parentcustomerid","ReferencedAttribute":"accountid"}]});
        let nn = json!({"value":[{"SchemaName":"accountleads_association","IntersectEntityName":"accountleads","Entity1LogicalName":"lead","Entity1IntersectAttribute":"leadid","Entity2LogicalName":"account","Entity2IntersectAttribute":"accountid"}]});
        let rels = relationships_from("account", "accountid", &n1, &one_n, &nn);
        let short: Vec<_> = rels.iter().map(|r| (r.kind, r.table.as_str(), r.from.as_str(), r.to.as_str())).collect();
        assert_eq!(
            short,
            vec![
                ("manyToMany", "lead", "leadid", "accountid"),
                ("manyToOne", "contact", "contactid", "primarycontactid"),
                ("oneToMany", "contact", "parentcustomerid", "accountid"),
            ]
        );
        assert_eq!(rels[0].intersect.as_deref(), Some("accountleads"));
        assert_eq!(rels[0].intersect_from.as_deref(), Some("accountid"));
        assert_eq!(rels[0].intersect_to.as_deref(), Some("leadid"));
    }
}
