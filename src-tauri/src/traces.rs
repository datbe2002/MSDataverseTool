//! Plug-in trace logs (`plugintracelog`), read only: what plug-ins and custom
//! workflow activities wrote with `ITracingService`, and their exceptions.
//! Newest first, a page at a time; filters go to the server as `$filter`.

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use crate::odata::{formatted as formatted_opt, guid, literal, opt_str, str_field};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Rows per page ("Load more" follows `@odata.nextLink`).
const PAGE_SIZE: usize = 100;
/// The list shows the exception's gist; the full text comes with the detail.
const SUMMARY_CHARS: usize = 300;

/// Columns of a list row. `exceptiondetails` only to tell failed runs apart
/// (and show their gist); the trace text itself comes with the detail.
const LIST_COLUMNS: &str = "plugintracelogid,typename,messagename,primaryentity,mode,operationtype,depth,createdon,performanceexecutionduration,correlationid,requestid,pluginstepid,exceptiondetails";

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct TraceFilter {
    /// Only traces created at or after this time (RFC 3339).
    pub since: Option<String>,
    /// Plug-in class name contains this.
    pub type_name: Option<String>,
    /// Message name, e.g. "Create" (exact, case-insensitive on the server).
    pub message: Option<String>,
    /// Table logical name, e.g. "account".
    pub entity: Option<String>,
    /// 0 = synchronous, 1 = asynchronous.
    pub mode: Option<i64>,
    pub exceptions_only: bool,
    /// Every trace of one execution chain.
    pub correlation_id: Option<String>,
    /// The trace text or the exception contains this.
    pub text: Option<String>,
    /// Runs that took at least this long.
    pub min_duration_ms: Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TraceRow {
    pub id: String,
    pub type_name: String,
    pub message: String,
    pub entity: String,
    /// 0 = synchronous, 1 = asynchronous.
    pub mode: i64,
    pub mode_label: String,
    /// 1 = plug-in, 2 = workflow activity.
    pub operation_type: i64,
    pub operation_label: String,
    pub depth: i64,
    pub created_on: String,
    pub duration_ms: Option<i64>,
    pub correlation_id: Option<String>,
    pub request_id: Option<String>,
    pub step_id: Option<String>,
    /// The run threw: the gist of its exception (the "Message:" line).
    pub exception: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TracePage {
    pub rows: Vec<TraceRow>,
    /// Pass back to `trace_logs` for the next page.
    pub next: Option<String>,
    /// The environment's "Enable logging to plug-in trace log" setting
    /// (0 = off, 1 = exceptions, 2 = all); first page only, None if unreadable.
    pub logging: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceDetail {
    #[serde(flatten)]
    pub row: TraceRow,
    pub message_block: String,
    pub exception_details: String,
    pub configuration: String,
    pub created_by: String,
    pub constructor_ms: Option<i64>,
    pub execution_start: String,
    pub system_created: bool,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The `$filter` expression for `f`; None when nothing is filtered.
pub fn filter_expr(f: &TraceFilter) -> AppResult<Option<String>> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(since) = non_empty(&f.since) {
        let at = chrono::DateTime::parse_from_rfc3339(since)
            .map_err(|_| AppError::msg(format!("Invalid time: {}", since)))?;
        parts.push(format!(
            "createdon ge {}",
            at.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ")
        ));
    }
    if let Some(t) = non_empty(&f.type_name) {
        parts.push(format!("contains(typename,{})", literal(t)));
    }
    if let Some(m) = non_empty(&f.message) {
        parts.push(format!("messagename eq {}", literal(m)));
    }
    if let Some(e) = non_empty(&f.entity) {
        parts.push(format!("primaryentity eq {}", literal(e)));
    }
    if let Some(mode) = f.mode {
        if !matches!(mode, 0 | 1) {
            return Err(AppError::msg(format!("Invalid mode: {}", mode)));
        }
        parts.push(format!("mode eq {}", mode));
    }
    if f.exceptions_only {
        parts.push("exceptiondetails ne null".into());
    }
    if let Some(id) = non_empty(&f.correlation_id) {
        parts.push(format!("correlationid eq {}", guid(id, "correlation id")?));
    }
    if let Some(t) = non_empty(&f.text) {
        let t = literal(t);
        parts.push(format!("(contains(messageblock,{t}) or contains(exceptiondetails,{t}))"));
    }
    if let Some(ms) = f.min_duration_ms.filter(|ms| *ms > 0) {
        parts.push(format!("performanceexecutionduration ge {}", ms));
    }
    Ok(if parts.is_empty() { None } else { Some(parts.join(" and ")) })
}

fn formatted(row: &Value, key: &str) -> String {
    formatted_opt(row, key).unwrap_or_default()
}

/// The gist of an exception: its "Message:" line, else its first line.
pub fn exception_summary(details: &str) -> Option<String> {
    let lines = || details.lines().map(str::trim).filter(|l| !l.is_empty());
    let line = lines()
        .find_map(|l| l.strip_prefix("Message:").map(str::trim).filter(|m| !m.is_empty()))
        .or_else(|| lines().next())?;
    let mut out: String = line.chars().take(SUMMARY_CHARS).collect();
    if out.len() < line.len() {
        out.push('…');
    }
    Some(out)
}

pub fn parse_row(row: &Value) -> Option<TraceRow> {
    let mode = row.get("mode").and_then(|v| v.as_i64()).unwrap_or(0);
    let operation_type = row.get("operationtype").and_then(|v| v.as_i64()).unwrap_or(0);
    let label = |key: &str, fallback: &str| match formatted(row, key) {
        s if s.is_empty() => fallback.to_string(),
        s => s,
    };
    Some(TraceRow {
        id: row.get("plugintracelogid")?.as_str()?.to_string(),
        type_name: str_field(row, "typename"),
        message: str_field(row, "messagename"),
        entity: str_field(row, "primaryentity"),
        mode,
        mode_label: label("mode", if mode == 1 { "Asynchronous" } else { "Synchronous" }),
        operation_type,
        operation_label: label(
            "operationtype",
            match operation_type {
                1 => "Plug-in",
                2 => "Workflow Activity",
                _ => "Unknown",
            },
        ),
        depth: row.get("depth").and_then(|v| v.as_i64()).unwrap_or(0),
        created_on: str_field(row, "createdon"),
        duration_ms: row.get("performanceexecutionduration").and_then(|v| v.as_i64()),
        correlation_id: opt_str(row, "correlationid"),
        request_id: opt_str(row, "requestid"),
        step_id: opt_str(row, "pluginstepid"),
        exception: row
            .get("exceptiondetails")
            .and_then(|v| v.as_str())
            .and_then(exception_summary),
    })
}

/// The environment's trace log setting; None when it can't be read.
fn logging_setting(base: &str, token: &str) -> Option<i64> {
    let body = get_json(&format!("{}/organizations?$select=plugintracelogsetting", base), token, None).ok()?;
    body.get("value")?.as_array()?.first()?.get("plugintracelogsetting")?.as_i64()
}

/// A page of traces, newest first: the first one for `filter`, or the one at
/// `next` (a link from the previous page).
pub fn list(host: &str, token: &str, filter: &TraceFilter, next: Option<&str>) -> AppResult<TracePage> {
    let base = format!("https://{}/api/data/v9.2", host);
    let prefer = format!(
        "odata.include-annotations=\"OData.Community.Display.V1.FormattedValue\",odata.maxpagesize={}",
        PAGE_SIZE
    );
    let (body, logging) = match next {
        Some(link) => {
            // Only ever a link this environment handed out.
            if !link.starts_with(&format!("{}/plugintracelogs?", base)) {
                return Err(AppError::msg("Invalid next page link"));
            }
            (get_json(link, token, Some(&prefer))?, None)
        }
        None => {
            let mut url = format!("{}/plugintracelogs?$select={}&$orderby=createdon%20desc", base, LIST_COLUMNS);
            if let Some(expr) = filter_expr(filter)? {
                url.push_str("&$filter=");
                url.push_str(&utf8_percent_encode(&expr, NON_ALPHANUMERIC).to_string());
            }
            let (body, logging) = std::thread::scope(|s| {
                let setting = s.spawn(|| logging_setting(&base, token));
                let body = get_json(&url, token, Some(&prefer));
                (body, setting.join().ok().flatten())
            });
            (body?, logging)
        }
    };
    let rows = body
        .get("value")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(parse_row)
        .collect();
    let next = opt_str(&body, "@odata.nextLink");
    Ok(TracePage { rows, next, logging })
}

/// One trace with its full text.
pub fn detail(host: &str, token: &str, id: &str) -> AppResult<TraceDetail> {
    let id = guid(id, "trace id")?;
    let url = format!(
        "https://{}/api/data/v9.2/plugintracelogs({})?$select={},messageblock,configuration,_createdby_value,performanceconstructorduration,performanceexecutionstarttime,issystemcreated",
        host, id, LIST_COLUMNS
    );
    let row = get_json(&url, token, Some("odata.include-annotations=\"OData.Community.Display.V1.FormattedValue\""))?;
    Ok(TraceDetail {
        row: parse_row(&row).ok_or_else(|| AppError::msg("The trace log came back without an id"))?,
        message_block: str_field(&row, "messageblock"),
        exception_details: str_field(&row, "exceptiondetails"),
        configuration: str_field(&row, "configuration"),
        created_by: formatted(&row, "_createdby_value"),
        constructor_ms: row.get("performanceconstructorduration").and_then(|v| v.as_i64()),
        execution_start: str_field(&row, "performanceexecutionstarttime"),
        system_created: row.get("issystemcreated").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_become_one_odata_expression() {
        assert_eq!(filter_expr(&TraceFilter::default()).unwrap(), None);
        let f = TraceFilter {
            since: Some("2026-09-25T10:00:00+07:00".into()),
            type_name: Some(" Contoso.Plugins ".into()),
            message: Some("Create".into()),
            entity: Some("account".into()),
            mode: Some(0),
            exceptions_only: true,
            correlation_id: Some("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE".into()),
            text: Some("it's".into()),
            min_duration_ms: Some(500),
        };
        assert_eq!(
            filter_expr(&f).unwrap().unwrap(),
            "createdon ge 2026-09-25T03:00:00Z and contains(typename,'Contoso.Plugins') and messagename eq 'Create' \
             and primaryentity eq 'account' and mode eq 0 and exceptiondetails ne null \
             and correlationid eq aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
             and (contains(messageblock,'it''s') or contains(exceptiondetails,'it''s')) \
             and performanceexecutionduration ge 500"
        );
    }

    #[test]
    fn bad_filter_values_are_refused() {
        let bad = |f: TraceFilter| filter_expr(&f).is_err();
        assert!(bad(TraceFilter { since: Some("yesterday".into()), ..Default::default() }));
        assert!(bad(TraceFilter { correlation_id: Some("1 or 1 eq 1".into()), ..Default::default() }));
        assert!(bad(TraceFilter { mode: Some(3), ..Default::default() }));
        assert!(detail("x", "t", "not-a-guid").is_err());
        assert!(list("x", "t", &TraceFilter::default(), Some("https://evil.example/api")).is_err());
    }

    #[test]
    fn exception_gist_is_the_message_line() {
        let details = "Unhandled exception: \nException type: System.ServiceModel.FaultException`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]\nMessage: Credit limit exceeded\nDetail: \n<OrganizationServiceFault>";
        assert_eq!(exception_summary(details).as_deref(), Some("Credit limit exceeded"));
        assert_eq!(exception_summary("\n  Boom  \nat X.Y()").as_deref(), Some("Boom"));
        assert_eq!(exception_summary("  \n "), None);
        let long = format!("Message: {}", "x".repeat(SUMMARY_CHARS + 10));
        assert_eq!(exception_summary(&long).unwrap().chars().count(), SUMMARY_CHARS + 1);
    }

    #[test]
    fn a_row_reads_labels_and_exception() {
        let row = json!({
            "plugintracelogid": "11111111-2222-3333-4444-555555555555",
            "typename": "Contoso.Plugins.AccountCreate",
            "messagename": "Create",
            "primaryentity": "account",
            "mode": 1,
            "mode@OData.Community.Display.V1.FormattedValue": "Asynchronous",
            "operationtype": 1,
            "depth": 2,
            "createdon": "2026-09-25T03:00:00Z",
            "performanceexecutionduration": 812,
            "correlationid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "exceptiondetails": "Message: Nope"
        });
        let r = parse_row(&row).unwrap();
        assert_eq!(r.mode_label, "Asynchronous");
        assert_eq!(r.operation_label, "Plug-in");
        assert_eq!(r.duration_ms, Some(812));
        assert_eq!(r.exception.as_deref(), Some("Nope"));
        assert_eq!(r.request_id, None);
        assert!(parse_row(&json!({ "typename": "no id" })).is_none());
    }
}
