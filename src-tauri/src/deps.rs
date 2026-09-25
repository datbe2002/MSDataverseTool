//! What depends on a table or a column, read only:
//! - Dataverse's own dependency tracking (`RetrieveDependenciesForDelete` —
//!   what blocks deleting it — or `RetrieveDependentComponents` — everything
//!   that uses it), with each component's name looked up;
//! - plug-in steps that name the column (filtering attributes, images) or
//!   run on the table, which the tracking doesn't cover;
//! - cloud flows whose definition mentions it (a text search, on demand).

use crate::error::{AppError, AppResult};
use crate::metadata::{entity_set_name, get_json};
use crate::odata::{formatted, get_all, guid, int, logical_name, opt_str, str_field, PREFER_ALL};
use crate::plugins;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyItem {
    /// Solution component type (26 view, 29 process / flow, 60 form…).
    pub kind: i64,
    pub kind_label: String,
    pub id: String,
    /// The component's name; its id when it couldn't be looked up.
    pub name: String,
    /// More about it: form type, process category, owning table…
    pub detail: Option<String>,
    /// The table it belongs to, when that means something (views, forms, columns).
    pub table: Option<String>,
    /// 1 Solution internal, 2 Published, 4 Unpublished.
    pub dependency_type: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepUse {
    pub step_id: String,
    pub step_name: String,
    pub message: String,
    pub stage_label: String,
    pub enabled: bool,
    /// How the step touches it: "filtering attribute", "pre-image “Target”", "registered on the table"…
    pub how: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// "account" or "account.creditlimit".
    pub target: String,
    pub items: Vec<DependencyItem>,
    pub steps: Vec<StepUse>,
    /// Plug-in steps couldn't be read (the tracked dependencies still came back).
    pub steps_error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowMention {
    pub id: String,
    pub name: String,
    /// How many times the column (or the table, for a table) is named.
    pub hits: usize,
}

pub fn kind_label(kind: i64) -> String {
    match kind {
        1 => "Table",
        2 => "Column",
        3 | 10 => "Relationship",
        9 => "Choice",
        20 => "Security role",
        24 => "Form (legacy)",
        26 => "View",
        29 => "Process / flow",
        31 => "Report",
        36 => "Email template",
        59 => "Chart",
        60 => "Form",
        61 => "Web resource",
        62 => "Site map",
        63 => "Connection role",
        65 => "Hierarchy rule",
        66 => "Custom control",
        70 => "Field security profile",
        80 => "Model-driven app",
        90 => "Plug-in type",
        91 => "Plug-in assembly",
        92 => "Plug-in step",
        93 => "Plug-in step image",
        95 => "Service endpoint",
        150 => "Routing rule",
        161 => "Mobile offline profile",
        300 => "Canvas app",
        371 => "Connector",
        372 => "Connector",
        380 => "Environment variable",
        381 => "Environment variable value",
        _ => return format!("Component type {}", kind),
    }
    .to_string()
}

/// How a component type's name is looked up: entity set, key, and the columns to read.
struct Lookup {
    set: &'static str,
    key: &'static str,
    name: &'static str,
    /// A formatted column to show as the detail.
    detail: Option<&'static str>,
    /// A column holding the table it belongs to.
    table: Option<&'static str>,
}

fn lookup_for(kind: i64) -> Option<Lookup> {
    let l = |set, key, name, detail, table| Some(Lookup { set, key, name, detail, table });
    match kind {
        20 => l("roles", "roleid", "name", None, None),
        26 => l("savedqueries", "savedqueryid", "name", Some("querytype"), Some("returnedtypecode")),
        29 => l("workflows", "workflowid", "name", Some("category"), Some("primaryentity")),
        59 => l("savedqueryvisualizations", "savedqueryvisualizationid", "name", None, Some("primaryentitytypecode")),
        60 => l("systemforms", "formid", "name", Some("type"), Some("objecttypecode")),
        61 => l("webresourceset", "webresourceid", "name", Some("webresourcetype"), None),
        62 => l("sitemaps", "sitemapid", "sitemapname", None, None),
        80 => l("appmodules", "appmoduleid", "name", None, None),
        90 => l("plugintypes", "plugintypeid", "typename", None, None),
        91 => l("pluginassemblies", "pluginassemblyid", "name", None, None),
        92 => l("sdkmessageprocessingsteps", "sdkmessageprocessingstepid", "name", None, None),
        93 => l("sdkmessageprocessingstepimages", "sdkmessageprocessingstepimageid", "name", None, None),
        300 => l("canvasapps", "canvasappid", "displayname", None, None),
        380 => l("environmentvariabledefinitions", "environmentvariabledefinitionid", "displayname", None, None),
        _ => None,
    }
}

/// Names (and details) of records of one component type, a few ids per request.
fn names_from_records(base: &str, token: &str, l: &Lookup, ids: &[String]) -> HashMap<String, (String, Option<String>, Option<String>)> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(15) {
        let filter = chunk.iter().map(|id| format!("{} eq {}", l.key, id)).collect::<Vec<_>>().join(" or ");
        let mut select = vec![l.key, l.name];
        select.extend(l.detail);
        select.extend(l.table);
        let url = format!("{}/{}?$select={}&$filter={}", base, l.set, select.join(","), filter).replace(' ', "%20");
        // A type this account can't read keeps its ids.
        let Ok(rows) = get_all(url, token, PREFER_ALL) else { continue };
        for row in rows {
            let Some(id) = opt_str(&row, l.key) else { continue };
            let name = opt_str(&row, l.name).unwrap_or_else(|| id.clone());
            let detail = l.detail.and_then(|d| formatted(&row, d).or_else(|| opt_str(&row, d)));
            let table = l.table.and_then(|t| opt_str(&row, t)).filter(|t| t != "none");
            out.insert(id.to_ascii_lowercase(), (name, detail, table));
        }
    }
    out
}

/// A metadata definition's logical / schema name.
fn metadata_name(base: &str, token: &str, path: &str, field: &str) -> Option<String> {
    get_json(&format!("{}/{}?$select={}", base, path, field), token, None)
        .ok()
        .and_then(|v| opt_str(&v, field))
}

/// Looks up names for dependency rows (`dependentcomponent*` columns).
fn resolve(base: &str, token: &str, rows: &[Value]) -> Vec<DependencyItem> {
    let mut items: Vec<DependencyItem> = rows
        .iter()
        .filter_map(|r| {
            let id = opt_str(r, "dependentcomponentobjectid")?.to_ascii_lowercase();
            let kind = int(r, "dependentcomponenttype").unwrap_or(0);
            Some(DependencyItem {
                kind,
                kind_label: kind_label(kind),
                name: id.clone(),
                id,
                detail: None,
                table: opt_str(r, "dependentcomponentparentid").map(|p| p.to_ascii_lowercase()),
                dependency_type: int(r, "dependencytype").unwrap_or(0),
            })
        })
        .collect();
    // The same component can come back once per dependency path.
    items.sort_by(|a, b| (a.kind, &a.id).cmp(&(b.kind, &b.id)));
    items.dedup_by(|a, b| a.kind == b.kind && a.id == b.id);

    let mut by_kind: HashMap<i64, Vec<String>> = HashMap::new();
    for i in &items {
        by_kind.entry(i.kind).or_default().push(i.id.clone());
    }
    let mut names: HashMap<(i64, String), (String, Option<String>, Option<String>)> = HashMap::new();
    for (kind, ids) in &by_kind {
        if let Some(l) = lookup_for(*kind) {
            for (id, v) in names_from_records(base, token, &l, ids) {
                names.insert((*kind, id), v);
            }
        }
    }
    // Metadata components: one request each (there are few), tables cached.
    let mut tables: HashMap<String, Option<String>> = HashMap::new();
    let mut table_name = |id: &str| {
        tables
            .entry(id.to_string())
            .or_insert_with(|| metadata_name(base, token, &format!("EntityDefinitions({})", id), "LogicalName"))
            .clone()
    };
    for item in &mut items {
        // For metadata rows `table` holds the parent's metadata id until it's named.
        let parent = item.table.take();
        match item.kind {
            1 => {
                if let Some(n) = table_name(&item.id) {
                    item.name = n.clone();
                    item.table = Some(n);
                }
            }
            2 => {
                if let Some(p) = parent.as_deref() {
                    item.table = table_name(p);
                    if let Some(n) = metadata_name(base, token, &format!("EntityDefinitions({})/Attributes({})", p, item.id), "LogicalName") {
                        item.name = n;
                    }
                }
            }
            3 | 10 => {
                if let Some(n) = metadata_name(base, token, &format!("RelationshipDefinitions({})", item.id), "SchemaName") {
                    item.name = n;
                }
            }
            9 => {
                if let Some(n) = metadata_name(base, token, &format!("GlobalOptionSetDefinitions({})", item.id), "Name") {
                    item.name = n;
                }
            }
            kind => {
                if let Some((name, detail, table)) = names.remove(&(kind, item.id.clone())) {
                    item.name = name;
                    item.detail = detail;
                    item.table = table;
                }
            }
        }
    }
    items.sort_by(|a, b| (&a.kind_label, a.name.to_lowercase()).cmp(&(&b.kind_label, b.name.to_lowercase())));
    items
}

/// Steps that name `column` of `table`, or (no column) run on `table`.
pub fn step_uses(steps: &[plugins::Step], images: &[plugins::StepImage], table: &str, column: Option<&str>) -> Vec<StepUse> {
    let mut out = Vec::new();
    for step in steps.iter().filter(|s| s.table == table) {
        let mut how = Vec::new();
        match column {
            None => how.push("registered on the table".to_string()),
            Some(col) => {
                if step.filtering_attributes.iter().any(|a| a == col) {
                    how.push("filtering attribute".to_string());
                }
                for img in images.iter().filter(|i| i.step_id == step.id) {
                    let kind = match img.image_type {
                        0 => "pre-image",
                        1 => "post-image",
                        _ => "pre/post-image",
                    };
                    if img.attributes.iter().any(|a| a == col) {
                        how.push(format!("{} “{}”", kind, img.alias));
                    } else if img.attributes.is_empty() {
                        how.push(format!("{} “{}” (all columns)", kind, img.alias));
                    }
                }
            }
        }
        if !how.is_empty() {
            out.push(StepUse {
                step_id: step.id.clone(),
                step_name: step.name.clone(),
                message: step.message.clone(),
                stage_label: step.stage_label.clone(),
                enabled: step.enabled,
                how: how.join(", "),
            });
        }
    }
    out
}

/// Dependencies of a table, or of one of its columns. `for_delete`: only what
/// blocks deleting it; otherwise everything that depends on it.
pub fn report(host: &str, token: &str, table: &str, column: Option<&str>, for_delete: bool) -> AppResult<Report> {
    let table = logical_name(table, "table name")?;
    let column = column.map(|c| logical_name(c, "column name")).transpose()?;
    let base = format!("https://{}/api/data/v9.2", host);
    let not_found = |e: AppError, what: String| {
        if e.to_string().contains("(404)") {
            AppError::msg(format!("There is no {} in this environment.", what))
        } else {
            e
        }
    };
    let (path, kind, target) = match &column {
        Some(c) => (
            format!("EntityDefinitions(LogicalName='{}')/Attributes(LogicalName='{}')", table, c),
            2,
            format!("{}.{}", table, c),
        ),
        None => (format!("EntityDefinitions(LogicalName='{}')", table), 1, table.clone()),
    };
    let meta = get_json(&format!("{}/{}?$select=MetadataId", base, path), token, None)
        .map_err(|e| not_found(e, format!("`{}`", target)))?;
    let id = guid(&str_field(&meta, "MetadataId"), "metadata id")?;
    let function = if for_delete { "RetrieveDependenciesForDelete" } else { "RetrieveDependentComponents" };
    let url = format!("{}/{}(ObjectId=@id,ComponentType=@type)?@id={}&@type={}", base, function, id, kind);

    let (deps, on_table) = std::thread::scope(|s| {
        let on_table = s.spawn(|| plugins::steps_on_table(host, token, &table));
        let deps = get_json(&url, token, None);
        (deps, on_table.join().unwrap_or_else(|_| Err(AppError::msg("plug-in request panicked"))))
    });
    let rows = deps?.get("value").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let (steps, steps_error) = match on_table {
        Ok((steps, images)) => (step_uses(&steps, &images, &table, column.as_deref()), None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    Ok(Report { target, items: resolve(&base, token, &rows), steps, steps_error })
}

/// How often `name` is used in a flow definition as a word, not counting JSON keys
/// (`"name": …` is in every definition).
pub fn mentions(definition: &str, name: &str) -> usize {
    let Ok(re) = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(name))) else { return 0 };
    re.find_iter(definition)
        .filter(|m| {
            let rest = definition[m.end()..].trim_start_matches(['"', '\'']);
            !rest.trim_start().starts_with(':')
        })
        .count()
}

/// Cloud flows whose definition names the table (logical or entity set name)
/// and, for a column, the column. A text search: it can miss dynamic names
/// and can match a word that happens to be the same.
pub fn flows_mentioning(host: &str, token: &str, table: &str, column: Option<&str>) -> AppResult<Vec<FlowMention>> {
    let table = logical_name(table, "table name")?;
    let column = column.map(|c| logical_name(c, "column name")).transpose()?;
    let set = entity_set_name(host, token, &table)?;
    let url = format!(
        "https://{}/api/data/v9.2/workflows?$select=workflowid,name,clientdata&$filter=category eq 5",
        host
    )
    .replace(' ', "%20");
    let mut out = Vec::new();
    for row in get_all(url, token, PREFER_ALL)? {
        let data = str_field(&row, "clientdata");
        let on_table = mentions(&data, &table) + mentions(&data, &set);
        if on_table == 0 {
            continue;
        }
        let hits = match &column {
            Some(c) => mentions(&data, c),
            None => on_table,
        };
        if hits > 0 {
            out.push(FlowMention {
                id: str_field(&row, "workflowid"),
                name: str_field(&row, "name"),
                hits,
            });
        }
    }
    out.sort_by(|a, b| b.hits.cmp(&a.hits).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{Step, StepImage};

    fn step(id: &str, table: &str, filtering: &[&str]) -> Step {
        Step {
            id: id.into(),
            name: format!("step {}", id),
            description: None,
            handler_id: None,
            handler_kind: None,
            handler_name: None,
            message: "Update".into(),
            table: table.into(),
            secondary_table: None,
            stage: 20,
            stage_label: "Pre-operation".into(),
            mode: 0,
            rank: 1,
            enabled: true,
            filtering_attributes: filtering.iter().map(|s| s.to_string()).collect(),
            configuration: None,
            run_as: None,
            async_auto_delete: false,
            deployment: "Server".into(),
            managed: false,
            modified_on: String::new(),
        }
    }

    #[test]
    fn steps_that_use_a_column() {
        let steps = vec![step("a", "account", &["creditlimit"]), step("b", "account", &[]), step("c", "contact", &["creditlimit"])];
        let images = vec![
                StepImage { id: "i1".into(), step_id: "b".into(), name: "img".into(), alias: "Pre".into(), image_type: 0, attributes: vec![], message_property: "Target".into() },
                StepImage { id: "i2".into(), step_id: "a".into(), name: "img".into(), alias: "Post".into(), image_type: 1, attributes: vec!["creditlimit".into()], message_property: "Target".into() },
        ];
        let uses = step_uses(&steps, &images, "account", Some("creditlimit"));
        let short: Vec<_> = uses.iter().map(|u| (u.step_id.as_str(), u.how.as_str())).collect();
        assert_eq!(short, vec![("a", "filtering attribute, post-image “Post”"), ("b", "pre-image “Pre” (all columns)")]);
        assert_eq!(step_uses(&steps, &images, "account", None).len(), 2);
        assert!(step_uses(&steps, &images, "lead", None).is_empty());
    }

    #[test]
    fn flow_mentions_skip_json_keys_and_partial_words() {
        let def = r#"{"name": "Flow", "inputs": {"$select": "name,creditlimit", "path": "item()?['creditlimit']"}, "fullname": 1}"#;
        assert_eq!(mentions(def, "creditlimit"), 2);
        assert_eq!(mentions(def, "name"), 1, "only the $select one; the key and `fullname` don't count");
        assert_eq!(mentions(def, "accounts"), 0);
    }

    #[test]
    fn labels_for_component_types() {
        assert_eq!(kind_label(60), "Form");
        assert_eq!(kind_label(29), "Process / flow");
        assert_eq!(kind_label(12345), "Component type 12345");
        assert!(lookup_for(26).is_some() && lookup_for(2).is_none());
        assert!(report("x", "t", "account;", None, true).is_err());
    }
}
