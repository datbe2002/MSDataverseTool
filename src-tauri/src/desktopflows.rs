//! Desktop flows (RPA, Power Automate for desktop), read only: the flows
//! (`workflow` rows with `category = 6`), their runs (`flowsession`) and the
//! machines / machine groups that run them (`flowmachine`, `flowmachinegroup`).

use crate::error::{AppError, AppResult};
use crate::odata::{formatted, guid, int, literal, opt_str, str_field};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `workflow.category` of a desktop flow.
const CATEGORY_DESKTOP_FLOW: i64 = 6;
const PREFER: &str = "odata.include-annotations=\"*\"";
const PREFER_ALL: &str = "odata.include-annotations=\"*\",odata.maxpagesize=5000";
/// Runs per page ("Load more" follows `@odata.nextLink`).
const PAGE_SIZE: usize = 100;
/// `flowmachinegroup.flowgrouptype` of the group Power Automate makes for each standalone machine.
const GROUP_TYPE_DEFAULT: i64 = 545940002;

const RUN_COLUMNS: &str = "flowsessionid,name,statecode,statuscode,createdon,startedon,completedon,runmode,triggertype,subcategory,errorcode,errormessage,_regardingobjectid_value,_machineid_value,_machinegroupid_value,_ownerid_value,sessionusername,processversion,parentcloudflowrunsequenceid,parentworkflowid,_parentdesktopflowrunid_value,correlationid,connectionid";

fn base(host: &str) -> String {
    format!("https://{}/api/data/v9.2", host)
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Turns the errors people actually hit into what to do about them.
pub fn explain(e: AppError, table: &str, what: &str) -> AppError {
    let msg = e.to_string();
    if msg.contains("(403)") || msg.contains("missing prvRead") {
        AppError::msg(format!(
            "This account can't read {}: it needs read access to the {} table. Ask an admin to add it to one of your security roles.",
            what, table
        ))
    } else if msg.contains("(404)") && msg.contains("Resource not found for the segment") {
        AppError::msg(format!("This environment has no {} table, so it keeps no {} in Dataverse.", table, what))
    } else {
        e
    }
}

/// GET with extra headers (`MSCRM.IncludeUnpublished`, …) as JSON.
fn get_json_with(url: &str, token: &str, prefer: &str, headers: &[(&str, &str)]) -> AppResult<Value> {
    let mut req = ureq::get(url)
        .set("Authorization", &format!("Bearer {}", token))
        .set("Accept", "application/json")
        .set("OData-MaxVersion", "4.0")
        .set("OData-Version", "4.0")
        .set("Accept-Encoding", crate::http::ACCEPT_ENCODING)
        .set("Prefer", prefer);
    for (k, v) in headers {
        req = req.set(k, v);
    }
    match req.call() {
        Ok(r) => Ok(crate::http::json(r)?),
        Err(ureq::Error::Status(code, r)) => Err(status_error(code, r)),
        Err(e) => Err(AppError::msg(e.to_string())),
    }
}

fn status_error(code: u16, r: ureq::Response) -> AppError {
    let text = crate::http::text(r);
    let msg = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or(text);
    AppError::msg(format!("Request failed ({}): {}", code, msg))
}

/// A file column's content as text (`…/<column>/$value`); None when no file is attached.
fn file_text(url: &str, token: &str) -> AppResult<Option<String>> {
    let resp = ureq::get(url)
        .set("Authorization", &format!("Bearer {}", token))
        .set("OData-MaxVersion", "4.0")
        .set("OData-Version", "4.0")
        .set("Accept-Encoding", crate::http::ACCEPT_ENCODING)
        .call();
    match resp {
        Ok(r) if r.status() == 204 => Ok(None),
        Ok(r) => {
            let text = crate::http::text(r);
            Ok(if text.trim().is_empty() { None } else { Some(text) })
        }
        // No file attached answers 404 ("No file attachment found…").
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(ureq::Error::Status(code, r)) => Err(status_error(code, r)),
        Err(e) => Err(AppError::msg(e.to_string())),
    }
}

/// Every row of a collection query (with extra headers), following `@odata.nextLink`.
fn get_all_with(first_url: String, token: &str, headers: &[(&str, &str)]) -> AppResult<Vec<Value>> {
    let mut rows = Vec::new();
    let mut next = Some(first_url);
    while let Some(url) = next.take() {
        let mut body = get_json_with(&url, token, PREFER_ALL, headers)?;
        if let Some(Value::Array(page)) = body.get_mut("value").map(Value::take) {
            rows.extend(page);
        }
        next = opt_str(&body, "@odata.nextLink");
    }
    Ok(rows)
}

// ---- Flows -------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFlow {
    pub id: String,
    pub name: String,
    pub description: String,
    /// 0 Draft, 1 Activated, 2 Suspended.
    pub state: i64,
    pub state_label: String,
    /// `uiflowtype` label, e.g. "Power Automate Desktop", "Selenium IDE".
    pub kind: Option<String>,
    pub managed: bool,
    pub owner: String,
    pub modified_on: String,
    pub modified_by: String,
    pub created_on: String,
}

pub fn parse_flow(row: &Value) -> Option<DesktopFlow> {
    let state = int(row, "statecode").unwrap_or(0);
    Some(DesktopFlow {
        id: row.get("workflowid")?.as_str()?.to_ascii_lowercase(),
        name: str_field(row, "name"),
        description: str_field(row, "description"),
        state,
        state_label: formatted(row, "statecode").unwrap_or_else(|| {
            match state {
                0 => "Draft",
                1 => "Activated",
                2 => "Suspended",
                _ => "Unknown",
            }
            .to_string()
        }),
        kind: formatted(row, "uiflowtype"),
        managed: row.get("ismanaged").and_then(|v| v.as_bool()).unwrap_or(false),
        owner: formatted(row, "_ownerid_value").unwrap_or_default(),
        modified_on: str_field(row, "modifiedon"),
        modified_by: formatted(row, "_modifiedby_value").unwrap_or_default(),
        created_on: str_field(row, "createdon"),
    })
}

/// Every desktop flow, drafts included, by name.
pub fn list_flows(host: &str, token: &str) -> AppResult<Vec<DesktopFlow>> {
    let url = format!(
        "{}/workflows?$select=workflowid,name,description,statecode,uiflowtype,ismanaged,modifiedon,createdon,_ownerid_value,_modifiedby_value&$filter=category%20eq%20{}&$orderby=name",
        base(host),
        CATEGORY_DESKTOP_FLOW
    );
    let rows = get_all_with(url, token, &[("MSCRM.IncludeUnpublished", "true")]).map_err(|e| explain(e, "Process", "desktop flows"))?;
    let mut flows: Vec<DesktopFlow> = Vec::new();
    for flow in rows.iter().filter_map(parse_flow) {
        // A draft and its published copy share an id; keep one.
        if !flows.iter().any(|f| f.id == flow.id) {
            flows.push(flow);
        }
    }
    Ok(flows)
}

/// An input or output variable of a desktop flow.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowParam {
    pub name: String,
    /// JSON schema type: "string", "number", "boolean", "object", "array"…
    pub kind: String,
    pub description: String,
    pub default: Option<String>,
    pub sensitive: bool,
}

/// The variables of an inputs / outputs schema (`{"schema": {"properties": {…}}}`), in file order.
pub fn parse_params(raw: &str) -> Vec<FlowParam> {
    let Ok(v) = serde_json::from_str::<Value>(raw) else { return Vec::new() };
    let props = v.pointer("/schema/properties").or_else(|| v.get("properties"));
    let Some(Value::Object(props)) = props else { return Vec::new() };
    props
        .iter()
        .map(|(name, p)| {
            let text = |key: &str| match p.get(key) {
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                Some(Value::Null) | None => None,
                Some(Value::String(_)) => None,
                Some(other) => Some(other.to_string()),
            };
            FlowParam {
                name: text("title").unwrap_or_else(|| name.clone()),
                kind: text("type").unwrap_or_default(),
                description: text("description").unwrap_or_default(),
                default: text("default").or_else(|| text("value")),
                sensitive: p.get("x-ms-sensitive").or_else(|| p.get("sensitive")).and_then(|v| v.as_bool()).unwrap_or(false),
            }
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFlowDetail {
    pub inputs: Vec<FlowParam>,
    pub outputs: Vec<FlowParam>,
    /// Why the input / output schema couldn't be read, if it couldn't.
    pub schema_error: Option<String>,
}

/// A desktop flow's input and output variables.
pub fn flow_detail(host: &str, token: &str, id: &str) -> AppResult<DesktopFlowDetail> {
    let id = guid(id, "flow id")?;
    let read = |column: &str| file_text(&format!("{}/workflows({})/{}/$value", base(host), id, column), token);
    let (inputs, outputs) = (read("inputs"), read("outputs"));
    let schema_error = inputs.as_ref().err().or(outputs.as_ref().err()).map(|e| e.to_string());
    let params = |r: AppResult<Option<String>>| r.ok().flatten().map(|t| parse_params(&t)).unwrap_or_default();
    Ok(DesktopFlowDetail { inputs: params(inputs), outputs: params(outputs), schema_error })
}

// ---- Runs --------------------------------------------------------------------------------------

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RunFilter {
    /// Only runs created at or after this time (RFC 3339).
    pub since: Option<String>,
    /// "failed" | "running" | "waiting" | "succeeded" | "canceled".
    pub status: Option<String>,
    pub flow_id: Option<String>,
    pub machine_id: Option<String>,
    pub group_id: Option<String>,
    /// `runmode`: 0 Local, 1 Attended, 2 Unattended.
    pub run_mode: Option<i64>,
    /// The error message contains this.
    pub text: Option<String>,
    /// Only the newest `top` runs, one page.
    pub top: Option<usize>,
}

/// The `$filter` expression for `f`; None when nothing is filtered.
pub fn filter_expr(f: &RunFilter) -> AppResult<Option<String>> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(since) = non_empty(&f.since) {
        let at = chrono::DateTime::parse_from_rfc3339(since).map_err(|_| AppError::msg(format!("Invalid time: {}", since)))?;
        parts.push(format!("createdon ge {}", at.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ")));
    }
    if let Some(s) = non_empty(&f.status) {
        let codes: &[i64] = match s {
            "failed" => &[8, 9, 10],
            "running" => &[2],
            "waiting" => &[1, 3, 6],
            "succeeded" => &[4],
            "canceled" => &[7, 11, 14],
            other => return Err(AppError::msg(format!("Invalid status: {}", other))),
        };
        let any = codes.iter().map(|c| format!("statuscode eq {}", c)).collect::<Vec<_>>().join(" or ");
        parts.push(if codes.len() > 1 { format!("({})", any) } else { any });
    }
    if let Some(id) = non_empty(&f.flow_id) {
        parts.push(format!("_regardingobjectid_value eq {}", guid(id, "flow id")?));
    }
    if let Some(id) = non_empty(&f.machine_id) {
        parts.push(format!("_machineid_value eq {}", guid(id, "machine id")?));
    }
    if let Some(id) = non_empty(&f.group_id) {
        parts.push(format!("_machinegroupid_value eq {}", guid(id, "machine group id")?));
    }
    if let Some(m) = f.run_mode {
        if !(0..=2).contains(&m) {
            return Err(AppError::msg(format!("Invalid run mode: {}", m)));
        }
        parts.push(format!("runmode eq {}", m));
    }
    if let Some(t) = non_empty(&f.text) {
        parts.push(format!("contains(errormessage,{})", literal(t)));
    }
    Ok(if parts.is_empty() { None } else { Some(parts.join(" and ")) })
}

fn status_label(status: i64) -> &'static str {
    match status {
        0 => "Not specified",
        1 => "Paused",
        2 => "Running",
        3 => "Waiting",
        4 => "Succeeded",
        5 => "Skipped",
        6 => "Suspended",
        7 => "Cancelled",
        8 => "Failed",
        9 => "Faulted",
        10 => "Timed out",
        11 => "Aborted",
        12 => "Ignored",
        13 => "Deleted",
        14 => "Terminated",
        _ => "Unknown",
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub name: String,
    pub status: i64,
    pub status_label: String,
    pub state: i64,
    pub created_on: String,
    pub started_on: Option<String>,
    pub completed_on: Option<String>,
    pub run_mode: Option<i64>,
    pub run_mode_label: Option<String>,
    pub trigger: Option<String>,
    /// A test run from the designer.
    pub test: bool,
    pub flow_id: Option<String>,
    pub flow_name: Option<String>,
    pub machine_id: Option<String>,
    pub machine_name: Option<String>,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub owner: String,
    pub session_user: Option<String>,
    pub process_version: Option<String>,
    pub error_code: Option<String>,
    /// The first line of the error message.
    pub error: Option<String>,
    /// The cloud flow run (`flowrun` name) that started this one.
    pub parent_cloud_run: Option<String>,
    /// The cloud or desktop flow that started this one (`workflow` id).
    pub parent_flow_id: Option<String>,
    pub parent_desktop_run: Option<String>,
    pub correlation_id: Option<String>,
    pub connection_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub rows: Vec<RunRow>,
    pub next: Option<String>,
}

fn gist(message: &str) -> Option<String> {
    let line = message.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(if line.chars().count() > 300 { format!("{}…", line.chars().take(300).collect::<String>()) } else { line.to_string() })
}

pub fn parse_run(row: &Value) -> Option<RunRow> {
    let status = int(row, "statuscode").unwrap_or(-1);
    let lower = |key: &str| opt_str(row, key).map(|s| s.to_ascii_lowercase());
    Some(RunRow {
        id: row.get("flowsessionid")?.as_str()?.to_ascii_lowercase(),
        name: str_field(row, "name"),
        status,
        status_label: formatted(row, "statuscode").unwrap_or_else(|| status_label(status).to_string()),
        state: int(row, "statecode").unwrap_or(0),
        created_on: str_field(row, "createdon"),
        started_on: opt_str(row, "startedon"),
        completed_on: opt_str(row, "completedon"),
        run_mode: int(row, "runmode"),
        run_mode_label: formatted(row, "runmode"),
        trigger: formatted(row, "triggertype"),
        test: int(row, "subcategory") == Some(1),
        flow_id: lower("_regardingobjectid_value"),
        flow_name: formatted(row, "_regardingobjectid_value"),
        machine_id: lower("_machineid_value"),
        machine_name: formatted(row, "_machineid_value"),
        group_id: lower("_machinegroupid_value"),
        group_name: formatted(row, "_machinegroupid_value"),
        owner: formatted(row, "_ownerid_value").unwrap_or_default(),
        session_user: opt_str(row, "sessionusername"),
        process_version: opt_str(row, "processversion"),
        error_code: opt_str(row, "errorcode"),
        error: opt_str(row, "errormessage").as_deref().and_then(gist),
        parent_cloud_run: opt_str(row, "parentcloudflowrunsequenceid"),
        parent_flow_id: lower("parentworkflowid"),
        parent_desktop_run: lower("_parentdesktopflowrunid_value"),
        correlation_id: lower("correlationid"),
        connection_id: opt_str(row, "connectionid"),
    })
}

/// A page of runs, newest first: the first one for `filter`, or the one at `next`.
pub fn list_runs(host: &str, token: &str, filter: &RunFilter, next: Option<&str>) -> AppResult<RunPage> {
    let base = base(host);
    let page = filter.top.unwrap_or(PAGE_SIZE).clamp(1, PAGE_SIZE);
    let prefer = format!("{},odata.maxpagesize={}", PREFER, page);
    let body = match next {
        Some(link) => {
            // Only ever a link this environment handed out.
            if !link.starts_with(&format!("{}/flowsessions?", base)) {
                return Err(AppError::msg("Invalid next page link"));
            }
            get_json_with(link, token, &prefer, &[])
        }
        None => {
            let mut url = format!("{}/flowsessions?$select={}&$orderby=createdon%20desc", base, RUN_COLUMNS);
            if let Some(expr) = filter_expr(filter)? {
                url.push_str("&$filter=");
                url.push_str(&utf8_percent_encode(&expr, NON_ALPHANUMERIC).to_string());
            }
            if let Some(top) = filter.top {
                url.push_str(&format!("&$top={}", top.clamp(1, PAGE_SIZE)));
            }
            get_json_with(&url, token, &prefer, &[])
        }
    }
    .map_err(|e| explain(e, "Flow Session", "desktop flow runs"))?;
    let rows = body.get("value").and_then(|v| v.as_array()).into_iter().flatten().filter_map(parse_run).collect();
    Ok(RunPage { rows, next: if filter.top.is_some() { None } else { opt_str(&body, "@odata.nextLink") } })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    #[serde(flatten)]
    pub row: RunRow,
    pub error_message: String,
    pub error_details: String,
    pub run_details: String,
    /// The run's inputs / outputs (JSON, pretty-printed); None when it had none.
    pub inputs: Option<String>,
    pub outputs: Option<String>,
    /// Why the inputs / outputs couldn't be read, if they couldn't.
    pub files_error: Option<String>,
    pub created_by: String,
}

/// One run with its full error, inputs and outputs.
pub fn run_detail(host: &str, token: &str, id: &str) -> AppResult<RunDetail> {
    let id = guid(id, "run id")?;
    let url = format!(
        "{}/flowsessions({})?$select={},errordetails,rundetails,_createdby_value",
        base(host),
        id,
        RUN_COLUMNS
    );
    let row = get_json_with(&url, token, PREFER, &[]).map_err(|e| explain(e, "Flow Session", "desktop flow runs"))?;
    let read = |column: &str| file_text(&format!("{}/flowsessions({})/{}/$value", base(host), id, column), token);
    let (inputs, outputs) = (read("inputs"), read("outputs"));
    let files_error = inputs.as_ref().err().or(outputs.as_ref().err()).map(|e| e.to_string());
    let pretty = |r: AppResult<Option<String>>| r.ok().flatten().map(|t| crate::flows::pretty(&t));
    Ok(RunDetail {
        row: parse_run(&row).ok_or_else(|| AppError::msg("The run came back without an id"))?,
        error_message: str_field(&row, "errormessage"),
        error_details: crate::flows::pretty(&str_field(&row, "errordetails")),
        run_details: crate::flows::pretty(&str_field(&row, "rundetails")),
        inputs: pretty(inputs),
        outputs: pretty(outputs),
        files_error,
        created_by: formatted(&row, "_createdby_value").unwrap_or_default(),
    })
}

// ---- Machines ----------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub description: String,
    /// 0 Active, 1 Inactive, 2 Maintenance.
    pub state: i64,
    pub status: i64,
    pub status_label: String,
    pub agent_version: Option<String>,
    pub last_heartbeat: Option<String>,
    /// "Customer" (registered by a person), "Hosted", "CloudPc".
    pub hosting: Option<String>,
    pub session_capacity: Option<i64>,
    pub group_id: Option<String>,
    pub owner: String,
    pub created_on: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineGroup {
    pub id: String,
    pub name: String,
    pub description: String,
    pub state: i64,
    pub status_label: String,
    /// The group Power Automate keeps behind each standalone machine (not one people made).
    pub implicit: bool,
    pub last_run: Option<String>,
    pub owner: String,
    pub created_on: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineList {
    pub machines: Vec<Machine>,
    pub groups: Vec<MachineGroup>,
    /// Why the machine groups couldn't be read, if they couldn't.
    pub groups_error: Option<String>,
}

pub fn parse_machine(row: &Value) -> Option<Machine> {
    let status = int(row, "statuscode").unwrap_or(0);
    Some(Machine {
        id: row.get("flowmachineid")?.as_str()?.to_ascii_lowercase(),
        name: str_field(row, "name"),
        description: str_field(row, "description"),
        state: int(row, "statecode").unwrap_or(0),
        status,
        status_label: formatted(row, "statuscode").unwrap_or_else(|| format!("Status {}", status)),
        agent_version: opt_str(row, "agentversion"),
        last_heartbeat: opt_str(row, "lastheartbeatdate"),
        hosting: formatted(row, "hostingtype"),
        session_capacity: int(row, "sessioncapacity"),
        group_id: opt_str(row, "_flowmachinegroupid_value").map(|s| s.to_ascii_lowercase()),
        owner: formatted(row, "_ownerid_value").unwrap_or_default(),
        created_on: str_field(row, "createdon"),
    })
}

pub fn parse_group(row: &Value) -> Option<MachineGroup> {
    Some(MachineGroup {
        id: row.get("flowmachinegroupid")?.as_str()?.to_ascii_lowercase(),
        name: str_field(row, "name"),
        description: str_field(row, "description"),
        state: int(row, "statecode").unwrap_or(0),
        status_label: formatted(row, "statuscode").unwrap_or_default(),
        implicit: int(row, "flowgrouptype") == Some(GROUP_TYPE_DEFAULT),
        last_run: opt_str(row, "lastrundate"),
        owner: formatted(row, "_ownerid_value").unwrap_or_default(),
        created_on: str_field(row, "createdon"),
    })
}

/// Every machine and machine group this account can see, by name.
pub fn list_machines(host: &str, token: &str) -> AppResult<MachineList> {
    let url = format!(
        "{}/flowmachines?$select=flowmachineid,name,description,statecode,statuscode,agentversion,lastheartbeatdate,hostingtype,sessioncapacity,_flowmachinegroupid_value,_ownerid_value,createdon&$orderby=name",
        base(host)
    );
    let machines = get_all_with(url, token, &[])
        .map_err(|e| explain(e, "Flow Machine", "machines"))?
        .iter()
        .filter_map(parse_machine)
        .collect();
    let url = format!(
        "{}/flowmachinegroups?$select=flowmachinegroupid,name,description,statecode,statuscode,flowgrouptype,lastrundate,_ownerid_value,createdon&$orderby=name",
        base(host)
    );
    let (groups, groups_error) = match get_all_with(url, token, &[]) {
        Ok(rows) => (rows.iter().filter_map(parse_group).collect(), None),
        Err(e) => (Vec::new(), Some(explain(e, "Flow Machine Group", "machine groups").to_string())),
    };
    Ok(MachineList { machines, groups, groups_error })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_become_one_odata_expression() {
        assert_eq!(filter_expr(&RunFilter::default()).unwrap(), None);
        let f = RunFilter {
            since: Some("2026-10-05T10:00:00+07:00".into()),
            status: Some("failed".into()),
            flow_id: Some("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE".into()),
            machine_id: Some("11111111-2222-3333-4444-555555555555".into()),
            group_id: None,
            run_mode: Some(2),
            text: Some("can't".into()),
            top: None,
        };
        assert_eq!(
            filter_expr(&f).unwrap().unwrap(),
            "createdon ge 2026-10-05T03:00:00Z and (statuscode eq 8 or statuscode eq 9 or statuscode eq 10) \
             and _regardingobjectid_value eq aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
             and _machineid_value eq 11111111-2222-3333-4444-555555555555 and runmode eq 2 \
             and contains(errormessage,'can''t')"
        );
        let status = |s: &str| filter_expr(&RunFilter { status: Some(s.into()), ..Default::default() }).unwrap().unwrap();
        assert_eq!(status("running"), "statuscode eq 2");
        assert_eq!(status("succeeded"), "statuscode eq 4");
    }

    #[test]
    fn bad_filter_values_are_refused() {
        let bad = |f: RunFilter| filter_expr(&f).is_err();
        assert!(bad(RunFilter { status: Some("broken".into()), ..Default::default() }));
        assert!(bad(RunFilter { flow_id: Some("x' or 1 eq 1".into()), ..Default::default() }));
        assert!(bad(RunFilter { run_mode: Some(7), ..Default::default() }));
        assert!(bad(RunFilter { since: Some("today".into()), ..Default::default() }));
        assert!(run_detail("x", "t", "nope").is_err());
        assert!(flow_detail("x", "t", "nope").is_err());
        assert!(list_runs("x", "t", &RunFilter::default(), Some("https://evil.example/flowsessions?")).is_err());
    }

    #[test]
    fn a_failed_run_reads_labels_flow_machine_and_error() {
        let row = json!({
            "flowsessionid": "D9687093-D0C0-EC11-983E-0022480B428A",
            "statuscode": 8,
            "statecode": 0,
            "createdon": "2026-10-05T03:00:00Z",
            "startedon": "2026-10-05T03:00:02Z",
            "runmode": 2,
            "runmode@OData.Community.Display.V1.FormattedValue": "Unattended",
            "subcategory": 0,
            "_regardingobjectid_value": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
            "_regardingobjectid_value@OData.Community.Display.V1.FormattedValue": "Invoice bot",
            "_machineid_value": "11111111-2222-3333-4444-555555555555",
            "_machineid_value@OData.Community.Display.V1.FormattedValue": "RPA-VM-01",
            "errorcode": "UIElementNotFound",
            "errormessage": "\n  Element 'Save' wasn't found.\nat Subflow Main, action 12"
        });
        let r = parse_run(&row).unwrap();
        assert_eq!(r.id, "d9687093-d0c0-ec11-983e-0022480b428a");
        assert_eq!(r.status_label, "Failed");
        assert_eq!(r.run_mode_label.as_deref(), Some("Unattended"));
        assert_eq!(r.flow_id.as_deref(), Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        assert_eq!(r.flow_name.as_deref(), Some("Invoice bot"));
        assert_eq!(r.machine_name.as_deref(), Some("RPA-VM-01"));
        assert_eq!(r.error.as_deref(), Some("Element 'Save' wasn't found."));
        assert!(!r.test);
        assert!(parse_run(&json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn input_and_output_schemas_become_variables() {
        let raw = r#"{"schema":{"properties":{
            "inputText":{"default":"","description":"Customer name","format":null,"title":"inputText","type":"string","value":""},
            "inputInteger":{"default":"","description":"","format":null,"title":"inputInteger","type":"number","value":"0"}
        },"type":"object"}}"#;
        let p = parse_params(raw);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].name, "inputText");
        assert_eq!(p[0].kind, "string");
        assert_eq!(p[0].description, "Customer name");
        assert_eq!(p[0].default, None);
        assert_eq!(p[1].default.as_deref(), Some("0"));
        assert!(parse_params("not json").is_empty());
        assert!(parse_params("{}").is_empty());
    }

    #[test]
    fn flows_machines_and_groups_parse() {
        let f = parse_flow(&json!({
            "workflowid": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "name": "Invoice bot", "statecode": 0,
            "uiflowtype@OData.Community.Display.V1.FormattedValue": "Power Automate Desktop"
        }))
        .unwrap();
        assert_eq!(f.state_label, "Draft");
        assert_eq!(f.kind.as_deref(), Some("Power Automate Desktop"));
        let m = parse_machine(&json!({
            "flowmachineid": "11111111-2222-3333-4444-555555555555", "name": "RPA-VM-01", "statecode": 0, "statuscode": 1,
            "_flowmachinegroupid_value": "99999999-8888-7777-6666-555555555555"
        }))
        .unwrap();
        assert_eq!(m.status_label, "Status 1");
        assert_eq!(m.group_id.as_deref(), Some("99999999-8888-7777-6666-555555555555"));
        let g = parse_group(&json!({ "flowmachinegroupid": "99999999-8888-7777-6666-555555555555", "name": "RPA-VM-01", "flowgrouptype": 545940002 })).unwrap();
        assert!(g.implicit);
    }
}
