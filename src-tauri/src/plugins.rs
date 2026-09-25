//! Plug-in registrations, read only, loaded in layers so the tool opens fast:
//! - `overview`: assemblies, plug-in types, service endpoints and a slim
//!   index of every step (id, handler, table, enabled) — enough for the tree
//!   and its counts — in four light requests at once;
//! - `steps`: the steps of one handler, one table, or matching a search, with
//!   the columns a list shows;
//! - `step`: one step in full, with its images.
//! Only what isn't part of the platform (`customizationlevel eq 1`); Microsoft's
//! own assemblies are left out on request (Dynamics 365 has thousands of steps).

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use crate::odata::{bool_field, formatted, get_all, guid, int, literal, logical_name, opt_str, split_list, str_field, LOOKUP_TABLE};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Only the annotations the lists use (labels and lookup tables), not every one.
const PREFER_LABELS: &str =
    "odata.include-annotations=\"OData.Community.Display.V1.FormattedValue,Microsoft.Dynamics.CRM.lookuplogicalname\",odata.maxpagesize=5000";
const PREFER_PLAIN: &str = "odata.maxpagesize=5000";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Assembly {
    pub id: String,
    pub name: String,
    pub version: String,
    /// "Sandbox" / "None" / "External".
    pub isolation: String,
    pub managed: bool,
    pub modified_on: String,
    pub description: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginType {
    pub id: String,
    pub assembly_id: String,
    pub type_name: String,
    pub is_workflow_activity: bool,
}

/// A service endpoint / webhook steps can send to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    /// "Webhook", "Queue", "Topic", "EventHub"…
    pub contract: String,
}

/// The slim index row of a step: enough to count and place it in the tree.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepRef {
    pub id: String,
    pub handler: Option<String>,
    /// Primary table, "none" for messages without one.
    pub table: String,
    pub enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub assemblies: Vec<Assembly>,
    pub types: Vec<PluginType>,
    pub endpoints: Vec<Endpoint>,
    pub steps: Vec<StepRef>,
    /// Service endpoints couldn't be read (the rest still came back).
    pub endpoints_error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// The plug-in type or service endpoint that runs.
    pub handler_id: Option<String>,
    /// "plugintype" | "serviceendpoint".
    pub handler_kind: Option<String>,
    pub handler_name: Option<String>,
    pub message: String,
    /// Primary table ("none" for messages without one).
    pub table: String,
    pub secondary_table: Option<String>,
    /// 10 Pre-validation, 20 Pre-operation, 30 Main operation, 40 Post-operation.
    pub stage: i64,
    pub stage_label: String,
    /// 0 synchronous, 1 asynchronous.
    pub mode: i64,
    /// Execution order within the stage.
    pub rank: i64,
    pub enabled: bool,
    /// Empty = runs on any column change.
    pub filtering_attributes: Vec<String>,
    pub configuration: Option<String>,
    pub run_as: Option<String>,
    pub async_auto_delete: bool,
    pub deployment: String,
    pub managed: bool,
    pub modified_on: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepImage {
    pub id: String,
    pub step_id: String,
    pub name: String,
    pub alias: String,
    /// 0 Pre, 1 Post, 2 Both.
    pub image_type: i64,
    /// Empty = every column.
    pub attributes: Vec<String>,
    pub message_property: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepDetail {
    pub step: Step,
    pub images: Vec<StepImage>,
    /// The assembly of the step's plug-in type (to open the tree at it).
    pub assembly_id: Option<String>,
}

/// Which steps to list: one handler's, one table's, or those whose name contains `search`.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct StepQuery {
    pub handler: Option<String>,
    pub table: Option<String>,
    pub search: Option<String>,
}

fn stage_label(stage: i64) -> String {
    match stage {
        10 => "Pre-validation",
        20 => "Pre-operation",
        30 => "Main operation",
        40 => "Post-operation",
        50 => "Post-operation (deprecated)",
        _ => return format!("Stage {}", stage),
    }
    .to_string()
}

fn isolation_label(mode: Option<i64>) -> String {
    match mode {
        Some(2) => "Sandbox",
        Some(3) => "External",
        _ => "None",
    }
    .to_string()
}

fn description(row: &Value) -> Option<String> {
    opt_str(row, "description").map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn filter_table(row: &Value) -> (String, Option<String>) {
    let filter = row.get("sdkmessagefilterid").filter(|v| v.is_object());
    (
        filter.and_then(|f| opt_str(f, "primaryobjecttypecode")).unwrap_or_else(|| "none".to_string()),
        filter.and_then(|f| opt_str(f, "secondaryobjecttypecode")).filter(|s| s != "none"),
    )
}

pub fn parse_assembly(row: &Value) -> Option<Assembly> {
    Some(Assembly {
        id: opt_str(row, "pluginassemblyid")?,
        name: str_field(row, "name"),
        version: str_field(row, "version"),
        isolation: isolation_label(int(row, "isolationmode")),
        managed: bool_field(row, "ismanaged"),
        modified_on: str_field(row, "modifiedon"),
        description: description(row),
    })
}

pub fn parse_type(row: &Value) -> Option<PluginType> {
    Some(PluginType {
        id: opt_str(row, "plugintypeid")?,
        assembly_id: opt_str(row, "_pluginassemblyid_value")?,
        type_name: str_field(row, "typename"),
        is_workflow_activity: bool_field(row, "isworkflowactivity"),
    })
}

pub fn parse_endpoint(row: &Value) -> Option<Endpoint> {
    Some(Endpoint {
        id: opt_str(row, "serviceendpointid")?,
        name: str_field(row, "name"),
        contract: formatted(row, "contract").unwrap_or_default(),
    })
}

pub fn parse_step_ref(row: &Value) -> Option<StepRef> {
    Some(StepRef {
        id: opt_str(row, "sdkmessageprocessingstepid")?,
        handler: opt_str(row, "_eventhandler_value"),
        table: filter_table(row).0,
        enabled: int(row, "statecode") == Some(0),
    })
}

pub fn parse_step(row: &Value) -> Option<Step> {
    let stage = int(row, "stage").unwrap_or(0);
    let (table, secondary_table) = filter_table(row);
    Some(Step {
        id: opt_str(row, "sdkmessageprocessingstepid")?,
        name: str_field(row, "name"),
        description: description(row),
        handler_id: opt_str(row, "_eventhandler_value"),
        handler_kind: opt_str(row, &format!("_eventhandler_value{}", LOOKUP_TABLE)),
        handler_name: formatted(row, "_eventhandler_value"),
        message: formatted(row, "_sdkmessageid_value").unwrap_or_default(),
        table,
        secondary_table,
        stage,
        stage_label: formatted(row, "stage").unwrap_or_else(|| stage_label(stage)),
        mode: int(row, "mode").unwrap_or(0),
        rank: int(row, "rank").unwrap_or(1),
        enabled: int(row, "statecode") == Some(0),
        filtering_attributes: split_list(&str_field(row, "filteringattributes")),
        configuration: opt_str(row, "configuration"),
        run_as: formatted(row, "_impersonatinguserid_value"),
        async_auto_delete: bool_field(row, "asyncautodelete"),
        deployment: formatted(row, "supporteddeployment").unwrap_or_else(|| "Server".into()),
        managed: bool_field(row, "ismanaged"),
        modified_on: str_field(row, "modifiedon"),
    })
}

pub fn parse_image(row: &Value) -> Option<StepImage> {
    Some(StepImage {
        id: opt_str(row, "sdkmessageprocessingstepimageid")?,
        step_id: opt_str(row, "_sdkmessageprocessingstepid_value")?,
        name: str_field(row, "name"),
        alias: str_field(row, "entityalias"),
        image_type: int(row, "imagetype").unwrap_or(0),
        attributes: split_list(&str_field(row, "attributes")),
        message_property: str_field(row, "messagepropertyname"),
    })
}

fn join<T>(h: std::thread::ScopedJoinHandle<'_, AppResult<T>>) -> AppResult<T> {
    h.join().unwrap_or_else(|_| Err(AppError::msg("plug-in request panicked")))
}

/// Assemblies, types, endpoints and the step index, in four requests at once.
/// `hide_microsoft`: leave out assemblies named `Microsoft.*` and their types.
pub fn overview(host: &str, token: &str, hide_microsoft: bool) -> AppResult<Overview> {
    let base = format!("https://{}/api/data/v9.2", host);
    let url = |path: String| format!("{}/{}", base, path).replace(' ', "%20");
    let (not_ms_asm, not_ms_type) = if hide_microsoft {
        (" and not startswith(name,'Microsoft.')", " and not startswith(pluginassemblyid/name,'Microsoft.')")
    } else {
        ("", "")
    };
    let assemblies = url(format!(
        "pluginassemblies?$select=pluginassemblyid,name,version,isolationmode,ismanaged,modifiedon,description&$filter=customizationlevel eq 1{}&$orderby=name",
        not_ms_asm
    ));
    let types = url(format!(
        "plugintypes?$select=plugintypeid,typename,isworkflowactivity,_pluginassemblyid_value&$filter=customizationlevel eq 1{}&$orderby=typename",
        not_ms_type
    ));
    let endpoints = url("serviceendpoints?$select=serviceendpointid,name,contract&$filter=customizationlevel eq 1&$orderby=name".into());
    let steps = url("sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,_eventhandler_value,statecode&$expand=sdkmessagefilterid($select=primaryobjecttypecode)&$filter=customizationlevel eq 1".into());

    let (a, t, e, s) = std::thread::scope(|sc| {
        let a = sc.spawn(|| get_all(assemblies, token, PREFER_PLAIN));
        let t = sc.spawn(|| get_all(types, token, PREFER_PLAIN));
        let e = sc.spawn(|| get_all(endpoints, token, PREFER_LABELS));
        let s = sc.spawn(|| get_all(steps, token, PREFER_PLAIN));
        (join(a), join(t), join(e), join(s))
    });
    let (endpoints, endpoints_error) = match e {
        Ok(rows) => (rows.iter().filter_map(parse_endpoint).collect(), None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    Ok(Overview {
        assemblies: a?.iter().filter_map(parse_assembly).collect(),
        types: t?.iter().filter_map(parse_type).collect(),
        endpoints,
        steps: s?.iter().filter_map(parse_step_ref).collect(),
        endpoints_error,
    })
}

/// Columns of a step in a list (no configuration / description: those come with `step`).
const STEP_COLUMNS: &str = "sdkmessageprocessingstepid,name,stage,mode,rank,statecode,filteringattributes,asyncautodelete,supporteddeployment,ismanaged,modifiedon,_eventhandler_value,_impersonatinguserid_value,_sdkmessageid_value";
const STEP_EXPAND: &str = "sdkmessagefilterid($select=primaryobjecttypecode,secondaryobjecttypecode)";

/// The `$filter` for a step query.
pub fn step_filter(q: &StepQuery) -> AppResult<String> {
    let mut parts = vec!["customizationlevel eq 1".to_string()];
    if let Some(h) = q.handler.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("_eventhandler_value eq {}", guid(h, "handler id")?));
    }
    if let Some(t) = q.table.as_deref().filter(|s| !s.is_empty()) {
        if t == "none" {
            parts.push("_sdkmessagefilterid_value eq null".into());
        } else {
            parts.push(format!("sdkmessagefilterid/primaryobjecttypecode eq '{}'", logical_name(t, "table name")?));
        }
    }
    if let Some(s) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("contains(name,{})", literal(s)));
    }
    if parts.len() == 1 {
        return Err(AppError::msg("Pick a handler, a table or a search"));
    }
    Ok(parts.join(" and "))
}

fn sort_steps(steps: &mut [Step]) {
    steps.sort_by(|x, y| (&x.table, &x.message, x.stage, x.rank, &x.name).cmp(&(&y.table, &y.message, y.stage, y.rank, &y.name)));
}

/// Steps of one handler, one table, or matching a search (at most 500 for a search).
pub fn steps(host: &str, token: &str, q: &StepQuery) -> AppResult<Vec<Step>> {
    let filter = step_filter(q)?;
    let top = if q.search.is_some() { "&$top=500" } else { "" };
    let url = format!(
        "https://{}/api/data/v9.2/sdkmessageprocessingsteps?$select={}&$expand={}&$filter={}{}",
        host,
        STEP_COLUMNS,
        STEP_EXPAND,
        utf8_percent_encode(&filter, NON_ALPHANUMERIC),
        top
    );
    let mut out: Vec<Step> = get_all(url, token, PREFER_LABELS)?.iter().filter_map(parse_step).collect();
    sort_steps(&mut out);
    Ok(out)
}

fn images_of(host: &str, token: &str, step_ids: &[String]) -> AppResult<Vec<StepImage>> {
    let mut out = Vec::new();
    for chunk in step_ids.chunks(20) {
        let filter = chunk
            .iter()
            .map(|id| format!("_sdkmessageprocessingstepid_value eq {}", id))
            .collect::<Vec<_>>()
            .join(" or ");
        let url = format!(
            "https://{}/api/data/v9.2/sdkmessageprocessingstepimages?$select=sdkmessageprocessingstepimageid,name,entityalias,imagetype,attributes,messagepropertyname,_sdkmessageprocessingstepid_value&$filter={}",
            host, filter
        )
        .replace(' ', "%20");
        out.extend(get_all(url, token, PREFER_PLAIN)?.iter().filter_map(parse_image));
    }
    Ok(out)
}

/// One step in full, its images, and the assembly of its plug-in type.
pub fn step(host: &str, token: &str, id: &str) -> AppResult<StepDetail> {
    let id = guid(id, "step id")?;
    let url = format!(
        "https://{}/api/data/v9.2/sdkmessageprocessingsteps({})?$select={},description,configuration&$expand={}",
        host, id, STEP_COLUMNS, STEP_EXPAND
    );
    let (row, images) = std::thread::scope(|sc| {
        let images = sc.spawn(|| images_of(host, token, std::slice::from_ref(&id)));
        (get_json(&url, token, Some(PREFER_LABELS)), join(images))
    });
    let step = parse_step(&row?).ok_or_else(|| AppError::msg("The step came back without an id"))?;
    let assembly_id = match (&step.handler_kind, &step.handler_id) {
        (Some(kind), Some(handler)) if kind == "plugintype" => get_json(
            &format!("https://{}/api/data/v9.2/plugintypes({})?$select=_pluginassemblyid_value", host, handler),
            token,
            None,
        )
        .ok()
        .and_then(|v| opt_str(&v, "_pluginassemblyid_value")),
        _ => None,
    };
    Ok(StepDetail { step, images: images?, assembly_id })
}

/// Steps registered on a table and their images (for the dependency check).
pub fn steps_on_table(host: &str, token: &str, table: &str) -> AppResult<(Vec<Step>, Vec<StepImage>)> {
    let steps = steps(host, token, &StepQuery { table: Some(table.to_string()), ..Default::default() })?;
    let ids: Vec<String> = steps.iter().map(|s| s.id.clone()).collect();
    let images = images_of(host, token, &ids)?;
    Ok((steps, images))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_step_reads_its_message_table_handler_and_columns() {
        let row = json!({
            "sdkmessageprocessingstepid": "11111111-2222-3333-4444-555555555555",
            "name": "Contoso.Plugins.AccountCreate: Update of account",
            "stage": 20,
            "stage@OData.Community.Display.V1.FormattedValue": "Pre-operation",
            "mode": 0,
            "rank": 2,
            "statecode": 1,
            "filteringattributes": "name, creditlimit",
            "_eventhandler_value": "99999999-8888-7777-6666-555555555555",
            "_eventhandler_value@Microsoft.Dynamics.CRM.lookuplogicalname": "plugintype",
            "_eventhandler_value@OData.Community.Display.V1.FormattedValue": "Contoso.Plugins.AccountCreate",
            "_sdkmessageid_value@OData.Community.Display.V1.FormattedValue": "Update",
            "sdkmessagefilterid": { "primaryobjecttypecode": "account", "secondaryobjecttypecode": "none" }
        });
        let s = parse_step(&row).unwrap();
        assert_eq!(s.message, "Update");
        assert_eq!(s.table, "account");
        assert_eq!(s.secondary_table, None);
        assert_eq!(s.stage_label, "Pre-operation");
        assert!(!s.enabled);
        assert_eq!(s.filtering_attributes, vec!["name", "creditlimit"]);
        assert_eq!(s.handler_kind.as_deref(), Some("plugintype"));
        let r = parse_step_ref(&row).unwrap();
        assert_eq!((r.table.as_str(), r.enabled), ("account", false));
        assert_eq!(r.handler.as_deref(), Some("99999999-8888-7777-6666-555555555555"));
    }

    #[test]
    fn a_step_without_a_filter_runs_on_no_table() {
        let s = parse_step(&json!({ "sdkmessageprocessingstepid": "x", "stage": 40 })).unwrap();
        assert_eq!(s.table, "none");
        assert_eq!(s.stage_label, "Post-operation");
        assert!(s.filtering_attributes.is_empty());
        assert!(parse_step(&json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn assemblies_types_endpoints_and_images() {
        let a = parse_assembly(&json!({ "pluginassemblyid": "a", "name": "Contoso.Plugins", "isolationmode": 2, "description": " " })).unwrap();
        assert_eq!(a.isolation, "Sandbox");
        assert_eq!(a.description, None);
        assert!(parse_type(&json!({ "plugintypeid": "t" })).is_none(), "a type needs its assembly");
        let e = parse_endpoint(&json!({ "serviceendpointid": "e", "name": "ERP", "contract@OData.Community.Display.V1.FormattedValue": "Webhook" })).unwrap();
        assert_eq!(e.contract, "Webhook");
        let i = parse_image(&json!({ "sdkmessageprocessingstepimageid": "i", "_sdkmessageprocessingstepid_value": "s", "imagetype": 0, "attributes": "Name,OwnerId" })).unwrap();
        assert_eq!(i.attributes, vec!["name", "ownerid"]);
    }

    #[test]
    fn step_queries_become_filters() {
        let q = |h: Option<&str>, t: Option<&str>, s: Option<&str>| StepQuery {
            handler: h.map(String::from),
            table: t.map(String::from),
            search: s.map(String::from),
        };
        assert_eq!(
            step_filter(&q(Some("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"), None, None)).unwrap(),
            "customizationlevel eq 1 and _eventhandler_value eq aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
        assert_eq!(
            step_filter(&q(None, Some("Account"), None)).unwrap(),
            "customizationlevel eq 1 and sdkmessagefilterid/primaryobjecttypecode eq 'account'"
        );
        assert_eq!(step_filter(&q(None, Some("none"), None)).unwrap(), "customizationlevel eq 1 and _sdkmessagefilterid_value eq null");
        assert_eq!(step_filter(&q(None, None, Some(" it's "))).unwrap(), "customizationlevel eq 1 and contains(name,'it''s')");
        assert!(step_filter(&q(None, None, None)).is_err());
        assert!(step_filter(&q(Some("x"), None, None)).is_err());
        assert!(step_filter(&q(None, Some("acc'"), None)).is_err());
    }
}
