//! Power Automate cloud flows, read from Dataverse: every flow in an
//! environment with Dataverse is a `workflow` row with `category = 5`, its
//! definition JSON in `clientdata`. Uses the same org-scoped token as queries,
//! so no Power Automate API token (which Conditional Access may block) is needed.

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// `workflow.category` of a modern (cloud) flow.
const CATEGORY_CLOUD_FLOW: i64 = 5;
/// `solutioncomponent.componenttype` of a workflow.
const COMPONENT_WORKFLOW: i64 = 29;
/// Solutions every component belongs to; listing them says nothing.
const HIDDEN_SOLUTIONS: &[&str] = &["Default", "Active", "Basic"];

const FORMATTED: &str = "@OData.Community.Display.V1.FormattedValue";
const PREFER_ALL_PAGES: &str =
    "odata.include-annotations=\"OData.Community.Display.V1.FormattedValue\",odata.maxpagesize=5000";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowMeta {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// 0 = Draft (off), 1 = Activated (on), 2 = Suspended.
    pub state: i64,
    pub state_label: String,
    pub owner: String,
    pub modified_by: String,
    pub modified_on: String,
    pub created_on: String,
    pub managed: bool,
    /// Friendly names of the (visible) solutions that contain the flow.
    pub solutions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowList {
    pub flows: Vec<FlowMeta>,
    /// Why solutions couldn't be read (usually a missing `prvReadSolution`);
    /// the flows are still listed, just without solutions.
    pub solutions_error: Option<String>,
}

fn str_field(row: &Value, key: &str) -> String {
    row.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn formatted(row: &Value, key: &str) -> String {
    str_field(row, &format!("{}{}", key, FORMATTED))
}

pub fn parse_flow(row: &Value) -> Option<FlowMeta> {
    let state = row.get("statecode").and_then(|v| v.as_i64()).unwrap_or(0);
    let state_label = match formatted(row, "statecode") {
        s if s.is_empty() => match state {
            1 => "Activated",
            2 => "Suspended",
            _ => "Draft",
        }
        .to_string(),
        s => s,
    };
    Some(FlowMeta {
        id: row.get("workflowid")?.as_str()?.to_string(),
        name: str_field(row, "name"),
        description: row
            .get("description")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string()),
        state,
        state_label,
        owner: formatted(row, "_ownerid_value"),
        modified_by: formatted(row, "_modifiedby_value"),
        modified_on: str_field(row, "modifiedon"),
        created_on: str_field(row, "createdon"),
        managed: row.get("ismanaged").and_then(|v| v.as_bool()).unwrap_or(false),
        solutions: Vec::new(),
    })
}

/// Flow id (lowercase) → friendly names of the solutions it is part of.
pub fn parse_solution_components(rows: &[Value]) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (Some(flow_id), Some(solution)) = (
            row.get("objectid").and_then(|v| v.as_str()),
            row.get("solutionid").filter(|s| s.is_object()),
        ) else {
            continue;
        };
        let visible = solution.get("isvisible").and_then(|v| v.as_bool()).unwrap_or(true);
        let unique = str_field(solution, "uniquename");
        if !visible || HIDDEN_SOLUTIONS.contains(&unique.as_str()) {
            continue;
        }
        let name = match str_field(solution, "friendlyname") {
            n if n.is_empty() => unique,
            n => n,
        };
        let names = map.entry(flow_id.to_ascii_lowercase()).or_default();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    for names in map.values_mut() {
        names.sort();
    }
    map
}

pub fn list(host: &str, token: &str) -> AppResult<FlowList> {
    let url = format!(
        "https://{}/api/data/v9.2/workflows?$select=workflowid,name,description,statecode,modifiedon,createdon,ismanaged,_ownerid_value,_modifiedby_value&$filter=category eq {}&$orderby=name",
        host, CATEGORY_CLOUD_FLOW
    )
    .replace(' ', "%20");
    let mut flows: Vec<FlowMeta> = crate::odata::get_all(url, token, PREFER_ALL_PAGES)?.iter().filter_map(parse_flow).collect();

    let url = format!(
        "https://{}/api/data/v9.2/solutioncomponents?$select=objectid&$filter=componenttype eq {}&$expand=solutionid($select=friendlyname,uniquename,isvisible)",
        host, COMPONENT_WORKFLOW
    )
    .replace(' ', "%20");
    let solutions_error = match crate::odata::get_all(url, token, PREFER_ALL_PAGES) {
        Ok(rows) => {
            let map = parse_solution_components(&rows);
            for flow in &mut flows {
                if let Some(names) = map.get(&flow.id.to_ascii_lowercase()) {
                    flow.solutions = names.clone();
                }
            }
            None
        }
        Err(e) => Some(e.to_string()),
    };

    Ok(FlowList { flows, solutions_error })
}

/// One "Run a Child Flow" call: `parent` runs `child` (both `workflow` ids, lowercase).
#[derive(Serialize, Debug, PartialEq)]
pub struct FlowCall {
    pub parent: String,
    pub child: String,
}

/// Ids of the flows a definition runs as child flows. A child flow action
/// (`"type": "Workflow"`) names its target in `inputs.host.workflowReferenceName`.
pub fn child_flow_ids(clientdata: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#""workflowReferenceName"\s*:\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})""#)
            .unwrap()
    });
    let mut ids: Vec<String> = Vec::new();
    for cap in re.captures_iter(clientdata) {
        let id = cap[1].to_ascii_lowercase();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// Every child flow call in the environment. Reads all definitions, so the
/// UI asks for it only when someone wants to know who calls a flow.
pub fn calls(host: &str, token: &str) -> AppResult<Vec<FlowCall>> {
    let url = format!(
        "https://{}/api/data/v9.2/workflows?$select=workflowid,clientdata&$filter=category eq {}",
        host, CATEGORY_CLOUD_FLOW
    )
    .replace(' ', "%20");
    let mut out = Vec::new();
    for row in crate::odata::get_all(url, token, PREFER_ALL_PAGES)? {
        let (Some(parent), Some(data)) = (
            row.get("workflowid").and_then(|v| v.as_str()),
            row.get("clientdata").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        for child in child_flow_ids(data) {
            out.push(FlowCall { parent: parent.to_ascii_lowercase(), child });
        }
    }
    Ok(out)
}

fn is_guid(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// The flow's definition (`clientdata`), pretty-printed.
pub fn definition(host: &str, token: &str, flow_id: &str) -> AppResult<String> {
    if !is_guid(flow_id) {
        return Err(AppError::msg(format!("Invalid flow id: {}", flow_id)));
    }
    let url = format!(
        "https://{}/api/data/v9.2/workflows({})?$select=clientdata",
        host, flow_id
    );
    let body = get_json(&url, token, None)?;
    let raw = body.get("clientdata").and_then(|v| v.as_str()).unwrap_or("");
    if raw.is_empty() {
        return Err(AppError::msg("This flow has no definition stored in Dataverse."));
    }
    Ok(pretty(raw))
}

/// Pretty-prints JSON; text that isn't JSON is returned unchanged.
pub fn pretty(raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or_else(|| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_flow_row_uses_the_formatted_owner_and_state() {
        let row = json!({
            "workflowid": "87023c69-962c-ec11-b6e6-000d3a574957",
            "name": "[Scheduled] Clean up",
            "description": "  ",
            "statecode": 1,
            "statecode@OData.Community.Display.V1.FormattedValue": "Activated",
            "_ownerid_value": "9dc6a53e-98ae-4f14-898c-ded6096dd757",
            "_ownerid_value@OData.Community.Display.V1.FormattedValue": "SYSTEM",
            "modifiedon": "2026-09-22T01:02:03Z",
            "ismanaged": true
        });
        let flow = parse_flow(&row).unwrap();
        assert_eq!(flow.state, 1);
        assert_eq!(flow.state_label, "Activated");
        assert_eq!(flow.owner, "SYSTEM");
        assert_eq!(flow.description, None);
        assert!(flow.managed);
        assert!(parse_flow(&json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn solutions_skip_the_ones_every_component_is_in() {
        let rows = vec![
            json!({ "objectid": "AAA", "solutionid": { "friendlyname": "PO Automation", "uniquename": "poauto", "isvisible": true } }),
            json!({ "objectid": "aaa", "solutionid": { "friendlyname": "Default Solution", "uniquename": "Default", "isvisible": true } }),
            json!({ "objectid": "aaa", "solutionid": { "friendlyname": "Active Solution", "uniquename": "Active", "isvisible": false } }),
            json!({ "objectid": "aaa", "solutionid": { "friendlyname": "Core", "uniquename": "core", "isvisible": true } }),
            json!({ "objectid": "bbb", "solutionid": null }),
        ];
        let map = parse_solution_components(&rows);
        assert_eq!(map.get("aaa").unwrap(), &vec!["Core".to_string(), "PO Automation".to_string()]);
        assert!(map.get("bbb").is_none());
    }

    #[test]
    fn child_flow_calls_are_found_once_each() {
        let data = r#"{"properties":{"definition":{"actions":{
            "Run_A":{"type":"Workflow","inputs":{"host":{"workflowReferenceName":"40F27D96-068B-F111-8076-002248ECCAE3"}}},
            "Scope":{"type":"Scope","actions":{
                "Run_A_again":{"type":"Workflow","inputs":{"host":{"workflowReferenceName": "40f27d96-068b-f111-8076-002248eccae3"}}},
                "Run_B":{"type":"Workflow","inputs":{"host":{"workflowReferenceName":"140f20b9-4dab-f111-aaab-6045bd597a00"}}}
            }},
            "Compose":{"type":"Compose","inputs":"workflowReferenceName"}
        }}}}"#;
        assert_eq!(
            child_flow_ids(data),
            vec!["40f27d96-068b-f111-8076-002248eccae3", "140f20b9-4dab-f111-aaab-6045bd597a00"]
        );
        assert!(child_flow_ids("{}").is_empty());
    }

    #[test]
    fn definitions_are_pretty_printed_and_ids_checked() {
        assert_eq!(pretty("{\"a\":1}"), "{\n  \"a\": 1\n}");
        assert_eq!(pretty("not json"), "not json");
        assert!(definition("x", "t", "1 or 1=1").is_err());
    }
}
