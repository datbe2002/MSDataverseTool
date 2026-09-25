//! System jobs (`asyncoperation`), read only: async plug-ins, classic
//! workflows, bulk deletes, imports, rollups… with their state and errors.
//! Newest first, a page at a time; filters go to the server as `$filter`
//! (always with a time window when one is picked — the table is huge).

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use crate::odata::{formatted, guid, is_logical_name, literal, opt_str, str_field, LOOKUP_TABLE};
use crate::traces::exception_summary;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const PREFER: &str = "odata.include-annotations=\"*\"";
/// Rows per page ("Load more" follows `@odata.nextLink`).
const PAGE_SIZE: usize = 100;

/// Columns of a list row; `message` only for its gist (the full text comes with the detail).
const LIST_COLUMNS: &str = "asyncoperationid,name,operationtype,statecode,statuscode,createdon,startedon,completedon,postponeuntil,primaryentitytype,messagename,_regardingobjectid_value,_ownerid_value,_workflowactivationid_value,depth,retrycount,errorcode,correlationid,requestid,workflowstagename,message";

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct JobFilter {
    /// Only jobs created at or after this time (RFC 3339).
    pub since: Option<String>,
    /// Job name contains this.
    pub name: Option<String>,
    /// "failed" | "waiting" | "queued" | "inprogress" | "succeeded" | "canceled".
    pub status: Option<String>,
    /// `operationtype`, e.g. 10 = Workflow, 1 = System Event (async plug-in).
    pub operation_type: Option<i64>,
    /// Primary table logical name, e.g. "account".
    pub entity: Option<String>,
    /// The error message contains this.
    pub text: Option<String>,
    /// Jobs of one execution chain (same as the plug-in trace logs').
    pub correlation_id: Option<String>,
    /// Jobs about one record.
    pub regarding_id: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    pub id: String,
    pub name: String,
    pub operation_type: i64,
    pub operation_label: String,
    /// 0 Ready, 1 Suspended, 2 Locked, 3 Completed.
    pub state: i64,
    /// 0 Waiting for resources, 10 Waiting, 20 In progress, 21 Pausing,
    /// 22 Canceling, 30 Succeeded, 31 Failed, 32 Canceled.
    pub status: i64,
    pub status_label: String,
    pub created_on: String,
    pub started_on: Option<String>,
    pub completed_on: Option<String>,
    pub postpone_until: Option<String>,
    pub entity: String,
    pub message_name: String,
    pub regarding_id: Option<String>,
    pub regarding_table: Option<String>,
    pub regarding_name: Option<String>,
    pub owner: String,
    /// The workflow / process the job runs, if any.
    pub process: Option<String>,
    pub depth: i64,
    pub retry_count: i64,
    pub error_code: Option<i64>,
    pub correlation_id: Option<String>,
    pub request_id: Option<String>,
    pub stage: Option<String>,
    /// The gist of the error message.
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobPage {
    pub rows: Vec<JobRow>,
    /// Pass back to `system_jobs` for the next page.
    pub next: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    #[serde(flatten)]
    pub row: JobRow,
    pub message: String,
    pub friendly_message: String,
    pub created_by: String,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The `$filter` expression for `f`; None when nothing is filtered.
pub fn filter_expr(f: &JobFilter) -> AppResult<Option<String>> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(since) = non_empty(&f.since) {
        let at = chrono::DateTime::parse_from_rfc3339(since)
            .map_err(|_| AppError::msg(format!("Invalid time: {}", since)))?;
        parts.push(format!(
            "createdon ge {}",
            at.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ")
        ));
    }
    if let Some(n) = non_empty(&f.name) {
        parts.push(format!("contains(name,{})", literal(n)));
    }
    if let Some(s) = non_empty(&f.status) {
        parts.push(
            match s {
                "failed" => "statuscode eq 31",
                "waiting" => "statuscode eq 10",
                "queued" => "statuscode eq 0",
                "inprogress" => "statecode eq 2",
                "succeeded" => "statuscode eq 30",
                "canceled" => "statuscode eq 32",
                other => return Err(AppError::msg(format!("Invalid status: {}", other))),
            }
            .into(),
        );
    }
    if let Some(t) = f.operation_type {
        parts.push(format!("operationtype eq {}", t));
    }
    if let Some(e) = non_empty(&f.entity) {
        let e = e.to_ascii_lowercase();
        if !is_logical_name(&e) {
            return Err(AppError::msg(format!("Invalid table name: {}", e)));
        }
        parts.push(format!("primaryentitytype eq '{}'", e));
    }
    if let Some(t) = non_empty(&f.text) {
        parts.push(format!("contains(message,{})", literal(t)));
    }
    if let Some(id) = non_empty(&f.correlation_id) {
        parts.push(format!("correlationid eq {}", guid(id, "correlation id")?));
    }
    if let Some(id) = non_empty(&f.regarding_id) {
        parts.push(format!("_regardingobjectid_value eq {}", guid(id, "record id")?));
    }
    Ok(if parts.is_empty() { None } else { Some(parts.join(" and ")) })
}

fn status_label(status: i64) -> &'static str {
    match status {
        0 => "Waiting For Resources",
        10 => "Waiting",
        20 => "In Progress",
        21 => "Pausing",
        22 => "Canceling",
        30 => "Succeeded",
        31 => "Failed",
        32 => "Canceled",
        _ => "Unknown",
    }
}

pub fn parse_row(row: &Value) -> Option<JobRow> {
    let int = |key: &str| row.get(key).and_then(|v| v.as_i64());
    let status = int("statuscode").unwrap_or(-1);
    let operation_type = int("operationtype").unwrap_or(0);
    let message = str_field(row, "message");
    Some(JobRow {
        id: row.get("asyncoperationid")?.as_str()?.to_string(),
        name: str_field(row, "name"),
        operation_type,
        operation_label: formatted(row, "operationtype").unwrap_or_else(|| format!("Type {}", operation_type)),
        state: int("statecode").unwrap_or(0),
        status,
        status_label: formatted(row, "statuscode").unwrap_or_else(|| status_label(status).to_string()),
        created_on: str_field(row, "createdon"),
        started_on: opt_str(row, "startedon"),
        completed_on: opt_str(row, "completedon"),
        postpone_until: opt_str(row, "postponeuntil"),
        entity: str_field(row, "primaryentitytype"),
        message_name: str_field(row, "messagename"),
        regarding_id: opt_str(row, "_regardingobjectid_value"),
        regarding_table: opt_str(row, &format!("_regardingobjectid_value{}", LOOKUP_TABLE)),
        regarding_name: formatted(row, "_regardingobjectid_value"),
        owner: formatted(row, "_ownerid_value").unwrap_or_default(),
        process: formatted(row, "_workflowactivationid_value"),
        depth: int("depth").unwrap_or(0),
        retry_count: int("retrycount").unwrap_or(0),
        error_code: int("errorcode").filter(|c| *c != 0),
        correlation_id: opt_str(row, "correlationid"),
        request_id: opt_str(row, "requestid"),
        stage: opt_str(row, "workflowstagename"),
        // Succeeded jobs sometimes carry an informational message; only failures have an error.
        error: if matches!(status, 31 | 32) || int("errorcode").is_some_and(|c| c != 0) {
            exception_summary(&message)
        } else {
            None
        },
    })
}

/// A page of jobs, newest first: the first one for `filter`, or the one at
/// `next` (a link from the previous page).
pub fn list(host: &str, token: &str, filter: &JobFilter, next: Option<&str>) -> AppResult<JobPage> {
    let base = format!("https://{}/api/data/v9.2", host);
    let prefer = format!("{},odata.maxpagesize={}", PREFER, PAGE_SIZE);
    let body = match next {
        Some(link) => {
            // Only ever a link this environment handed out.
            if !link.starts_with(&format!("{}/asyncoperations?", base)) {
                return Err(AppError::msg("Invalid next page link"));
            }
            get_json(link, token, Some(&prefer))?
        }
        None => {
            let mut url = format!("{}/asyncoperations?$select={}&$orderby=createdon%20desc", base, LIST_COLUMNS);
            if let Some(expr) = filter_expr(filter)? {
                url.push_str("&$filter=");
                url.push_str(&utf8_percent_encode(&expr, NON_ALPHANUMERIC).to_string());
            }
            get_json(&url, token, Some(&prefer))?
        }
    };
    let rows = body
        .get("value")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(parse_row)
        .collect();
    Ok(JobPage { rows, next: opt_str(&body, "@odata.nextLink") })
}

/// One job with its full messages.
pub fn detail(host: &str, token: &str, id: &str) -> AppResult<JobDetail> {
    let id = guid(id, "job id")?;
    let url = format!(
        "https://{}/api/data/v9.2/asyncoperations({})?$select={},friendlymessage,_createdby_value",
        host, id, LIST_COLUMNS
    );
    let row = get_json(&url, token, Some(PREFER))?;
    Ok(JobDetail {
        row: parse_row(&row).ok_or_else(|| AppError::msg("The system job came back without an id"))?,
        message: str_field(&row, "message"),
        friendly_message: str_field(&row, "friendlymessage"),
        created_by: formatted(&row, "_createdby_value").unwrap_or_default(),
    })
}

/// The model-driven app URL of a record in this environment.
pub fn record_url(host: &str, table: &str, id: &str) -> AppResult<String> {
    if !is_logical_name(table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    Ok(format!(
        "https://{}/main.aspx?pagetype=entityrecord&etn={}&id={}",
        host,
        table.to_ascii_lowercase(),
        guid(id, "record id")?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_become_one_odata_expression() {
        assert_eq!(filter_expr(&JobFilter::default()).unwrap(), None);
        let f = JobFilter {
            since: Some("2026-09-25T10:00:00+07:00".into()),
            name: Some("Recalc".into()),
            status: Some("failed".into()),
            operation_type: Some(10),
            entity: Some("Account".into()),
            text: Some("it's".into()),
            correlation_id: Some("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE".into()),
            regarding_id: Some("11111111-2222-3333-4444-555555555555".into()),
        };
        assert_eq!(
            filter_expr(&f).unwrap().unwrap(),
            "createdon ge 2026-09-25T03:00:00Z and contains(name,'Recalc') and statuscode eq 31 \
             and operationtype eq 10 and primaryentitytype eq 'account' and contains(message,'it''s') \
             and correlationid eq aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
             and _regardingobjectid_value eq 11111111-2222-3333-4444-555555555555"
        );
        let status = |s: &str| filter_expr(&JobFilter { status: Some(s.into()), ..Default::default() }).unwrap().unwrap();
        assert_eq!(status("inprogress"), "statecode eq 2");
        assert_eq!(status("queued"), "statuscode eq 0");
    }

    #[test]
    fn bad_filter_values_are_refused() {
        let bad = |f: JobFilter| filter_expr(&f).is_err();
        assert!(bad(JobFilter { status: Some("broken".into()), ..Default::default() }));
        assert!(bad(JobFilter { entity: Some("account' or 1 eq 1".into()), ..Default::default() }));
        assert!(bad(JobFilter { regarding_id: Some("x".into()), ..Default::default() }));
        assert!(bad(JobFilter { since: Some("today".into()), ..Default::default() }));
        assert!(detail("x", "t", "nope").is_err());
        assert!(list("x", "t", &JobFilter::default(), Some("https://evil.example/asyncoperations?")).is_err());
        assert!(record_url("x", "account;", "11111111-2222-3333-4444-555555555555").is_err());
        assert_eq!(
            record_url("org.crm.dynamics.com", "Account", "11111111-2222-3333-4444-555555555555").unwrap(),
            "https://org.crm.dynamics.com/main.aspx?pagetype=entityrecord&etn=account&id=11111111-2222-3333-4444-555555555555"
        );
    }

    #[test]
    fn a_failed_row_reads_labels_regarding_and_error() {
        let row = json!({
            "asyncoperationid": "11111111-2222-3333-4444-555555555555",
            "name": "Contoso.Plugins.SyncToErp",
            "operationtype": 1,
            "operationtype@OData.Community.Display.V1.FormattedValue": "System Event",
            "statecode": 3,
            "statuscode": 31,
            "createdon": "2026-09-25T03:00:00Z",
            "startedon": "2026-09-25T03:00:02Z",
            "completedon": "2026-09-25T03:00:05Z",
            "_regardingobjectid_value": "99999999-8888-7777-6666-555555555555",
            "_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "account",
            "_regardingobjectid_value@OData.Community.Display.V1.FormattedValue": "Contoso Ltd",
            "errorcode": -2147220891,
            "message": "Unhandled exception:\nMessage: ERP is down"
        });
        let r = parse_row(&row).unwrap();
        assert_eq!(r.operation_label, "System Event");
        assert_eq!(r.status_label, "Failed");
        assert_eq!(r.regarding_table.as_deref(), Some("account"));
        assert_eq!(r.regarding_name.as_deref(), Some("Contoso Ltd"));
        assert_eq!(r.error.as_deref(), Some("ERP is down"));
        assert_eq!(r.error_code, Some(-2147220891));
        assert!(parse_row(&json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn a_succeeded_job_has_no_error() {
        let row = json!({ "asyncoperationid": "x", "statuscode": 30, "errorcode": 0, "message": "Done." });
        let r = parse_row(&row).unwrap();
        assert_eq!(r.error, None);
        assert_eq!(r.error_code, None);
        assert_eq!(r.status_label, "Succeeded");
    }
}
