//! Cloud flow run history, read from Dataverse's `flowrun` table (an elastic
//! table Power Automate fills for solution-aware flows; kept 28 days by
//! default, `organization.flowruntimetoliveinseconds`). Read only.
//!
//! Two reads: a page of runs, newest first (one flow's history, or recent
//! failures of every flow), and a summary of a time window — runs and
//! failures per flow and per hour — counted here from a slim scan of the
//! window, split into time slices read in parallel.

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use crate::odata::{formatted, guid, int, opt_str, str_field};
use chrono::{DateTime, Duration, DurationRound, Utc};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

/// Rows per page of the run list ("Load more" follows `@odata.nextLink`).
const PAGE_SIZE: usize = 100;
const PREFER_LIST: &str = "odata.include-annotations=\"OData.Community.Display.V1.FormattedValue\"";
/// The summary scan reads only these.
const SCAN_COLUMNS: &str = "status,starttime,_workflow_value,workflowid,errorcode";
/// Elastic tables answer at most 500 rows a page, whatever is asked for.
const PREFER_SCAN: &str = "odata.maxpagesize=5000";
/// Rows a summary reads at most; past that it says it's partial.
pub const MAX_SCAN_ROWS: usize = 250_000;
/// Time slices read at once.
const WORKERS: usize = 6;
const LIST_COLUMNS: &str = "flowrunid,name,status,starttime,endtime,duration,triggertype,errorcode,errormessage,_workflow_value,workflowid,parentrunid,_ownerid_value";

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RunFilter {
    /// Only runs started at or after this time (RFC 3339).
    pub since: Option<String>,
    /// One flow's runs (its `workflow` id).
    pub flow_id: Option<String>,
    /// "failed" | "succeeded" | "cancelled" | "running".
    pub status: Option<String>,
    /// One run, by its name (a child run's `parentRunId` finds the parent this way).
    pub run_name: Option<String>,
    /// The child runs a run started (their `parentrunid`).
    pub parent_run: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    /// The run's name: the id Power Automate shows (`08584…CU12`).
    pub run_name: String,
    /// The flow's `workflow` id (lowercase), if the row names it.
    pub flow_id: Option<String>,
    pub flow_name: Option<String>,
    /// As stored: Succeeded, Failed, Cancelled, Running…
    pub status: String,
    /// `failed` | `succeeded` | `cancelled` | `running` | `other`.
    pub outcome: &'static str,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub duration_ms: Option<i64>,
    pub trigger_type: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// The run of the parent flow, for a child flow's run.
    pub parent_run_id: Option<String>,
    pub owner: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub rows: Vec<RunRow>,
    /// Pass back to `flow_runs` for the next page.
    pub next: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowStats {
    /// The flow's `workflow` id (lowercase).
    pub flow_id: String,
    pub total: u64,
    pub failed: u64,
    pub succeeded: u64,
    pub cancelled: u64,
    pub running: u64,
    pub last_run: Option<String>,
    pub last_failure: Option<String>,
    /// Error code of the newest failure.
    pub last_error_code: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HourBucket {
    /// Start of the hour (UTC, RFC 3339).
    pub at: String,
    pub total: u64,
    pub failed: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub since: String,
    pub until: String,
    pub total: u64,
    pub failed: u64,
    pub succeeded: u64,
    pub cancelled: u64,
    pub running: u64,
    /// Flows that ran in the window, most failures first.
    pub flows: Vec<FlowStats>,
    /// Hours with runs, oldest first.
    pub hours: Vec<HourBucket>,
    /// Stopped at `MAX_SCAN_ROWS`: the counts are a lower bound.
    pub truncated: bool,
    /// How long the environment keeps runs (None if it couldn't be read).
    pub retention_seconds: Option<i64>,
}

/// What a run's `status` means, whatever its spelling.
pub fn outcome(status: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    if s.contains("fail") || s.contains("timedout") || s.contains("timed out") || s == "faulted" {
        "failed"
    } else if s.starts_with("succe") || s == "success" {
        "succeeded"
    } else if s.starts_with("cancel") || s == "aborted" {
        "cancelled"
    } else if matches!(s.as_str(), "running" | "waiting" | "paused" | "pending" | "inprogress") {
        "running"
    } else {
        "other"
    }
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn utc(s: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| AppError::msg(format!("Invalid time: {}", s)))
}

fn odata_time(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// The `$filter` expression for `f`; None when nothing is filtered.
pub fn filter_expr(f: &RunFilter) -> AppResult<Option<String>> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(since) = non_empty(&f.since) {
        parts.push(format!("starttime ge {}", odata_time(utc(since)?)));
    }
    if let Some(id) = non_empty(&f.flow_id) {
        let id = guid(id, "flow id")?;
        // The lookup is the reliable link; the text copy may be in either case.
        parts.push(format!(
            "(_workflow_value eq {id} or workflowid eq '{id}' or workflowid eq '{}')",
            id.to_ascii_uppercase()
        ));
    }
    if let Some(s) = non_empty(&f.status) {
        parts.push(
            match s {
                "failed" => "(status eq 'Failed' or status eq 'TimedOut')",
                "succeeded" => "(status eq 'Succeeded' or status eq 'Success')",
                "cancelled" => "(status eq 'Cancelled' or status eq 'Canceled')",
                "running" => "(status eq 'Running' or status eq 'Waiting')",
                other => return Err(AppError::msg(format!("Invalid status: {}", other))),
            }
            .into(),
        );
    }
    if let Some(n) = non_empty(&f.run_name) {
        parts.push(format!("name eq '{}'", run_name(n)?));
    }
    if let Some(n) = non_empty(&f.parent_run) {
        parts.push(format!("parentrunid eq '{}'", run_name(n)?));
    }
    Ok(if parts.is_empty() { None } else { Some(parts.join(" and ")) })
}

/// A run's name (`08584…CU12`): letters, digits, `_` and `-` only.
pub fn run_name(s: &str) -> AppResult<&str> {
    if !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        Ok(s)
    } else {
        Err(AppError::msg(format!("Invalid run id: {}", s)))
    }
}

/// A BigInt may come as a number or as a string.
fn big_int(row: &Value, key: &str) -> Option<i64> {
    int(row, key).or_else(|| row.get(key)?.as_str()?.parse().ok())
}

/// The flow a row belongs to: the lookup, else the text copy (lowercase).
fn flow_of(row: &Value) -> Option<String> {
    opt_str(row, "_workflow_value")
        .or_else(|| opt_str(row, "workflowid"))
        .map(|s| s.to_ascii_lowercase())
}

pub fn parse_row(row: &Value) -> Option<RunRow> {
    let status = str_field(row, "status");
    let error_code = opt_str(row, "errorcode");
    let error_message = opt_str(row, "errormessage");
    Some(RunRow {
        id: row.get("flowrunid")?.as_str()?.to_string(),
        run_name: str_field(row, "name"),
        flow_id: flow_of(row),
        flow_name: formatted(row, "_workflow_value"),
        outcome: outcome(&status),
        status,
        start_time: opt_str(row, "starttime"),
        end_time: opt_str(row, "endtime"),
        duration_ms: big_int(row, "duration"),
        trigger_type: opt_str(row, "triggertype"),
        error_code,
        error_message,
        parent_run_id: opt_str(row, "parentrunid"),
        owner: formatted(row, "_ownerid_value").unwrap_or_default(),
    })
}

/// Turns the errors people actually hit into what to do about them.
pub fn explain(e: AppError) -> AppError {
    let msg = e.to_string();
    if msg.contains("(403)") || msg.contains("prvReadflowrun") {
        AppError::msg(
            "This account can't read cloud flow run history: it needs read access to the Flow Run table (prvReadflowrun). \
             Ask an admin to add it to one of your security roles.",
        )
    } else if msg.contains("(404)") || msg.contains("Resource not found for the segment 'flowruns'") {
        AppError::msg("This environment has no Flow Run table, so cloud flow run history isn't kept in Dataverse here.")
    } else {
        e
    }
}

/// How far this account's read on `flowrun` reaches: "none", "basic" (only runs of
/// flows it owns — each run belongs to its flow's owner), "local", "deep" or "global".
/// Dataverse answers a "basic" reader with no rows rather than a 403, so the app asks.
pub fn read_depth(host: &str, token: &str) -> AppResult<String> {
    let who = get_json(&format!("{}/WhoAmI", base(host)), token, None)?;
    let user = guid(who["UserId"].as_str().unwrap_or_default(), "user id")?;
    let url = format!(
        "{}/systemusers({})/Microsoft.Dynamics.CRM.RetrieveUserPrivilegeByPrivilegeName(PrivilegeName='prvReadflowrun')",
        base(host),
        user
    );
    Ok(deepest(&get_json(&url, token, None)?).to_string())
}

/// The widest `Depth` among the role privileges (names or numbers, as the API may send either).
fn deepest(v: &Value) -> &'static str {
    const ORDER: [&str; 5] = ["none", "basic", "local", "deep", "global"];
    let rank = |d: &Value| -> usize {
        match d {
            Value::String(s) => ORDER.iter().position(|o| o.eq_ignore_ascii_case(s)).unwrap_or(0),
            Value::Number(n) => n.as_u64().map(|n| (n as usize + 1).min(4)).unwrap_or(0),
            _ => 0,
        }
    };
    let best = v["RolePrivileges"].as_array().map(|a| a.iter().map(|p| rank(&p["Depth"])).max().unwrap_or(0)).unwrap_or(0);
    ORDER[best]
}

/// `get_json`, waiting and trying again when the server says it's busy.
fn get_patient(url: &str, token: &str, prefer: &str) -> AppResult<Value> {
    let mut attempt = 0;
    loop {
        match get_json(url, token, Some(prefer)) {
            Err(e) if attempt < 4 && (e.to_string().contains("(429)") || e.to_string().contains("(503)")) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_secs(2 * attempt));
            }
            other => return other,
        }
    }
}

fn base(host: &str) -> String {
    format!("https://{}/api/data/v9.2", host)
}

/// A page of runs, newest first: the first one for `filter`, or the one at
/// `next` (a link from the previous page).
pub fn list(host: &str, token: &str, filter: &RunFilter, next: Option<&str>) -> AppResult<RunPage> {
    let base = base(host);
    let prefer = format!("{},odata.maxpagesize={}", PREFER_LIST, PAGE_SIZE);
    let body = match next {
        Some(link) => {
            // Only ever a link this environment handed out.
            if !link.starts_with(&format!("{}/flowruns?", base)) {
                return Err(AppError::msg("Invalid next page link"));
            }
            get_patient(link, token, &prefer)
        }
        None => {
            let mut url = format!("{}/flowruns?$select={}&$orderby=starttime%20desc", base, LIST_COLUMNS);
            if let Some(expr) = filter_expr(filter)? {
                url.push_str("&$filter=");
                url.push_str(&utf8_percent_encode(&expr, NON_ALPHANUMERIC).to_string());
            }
            get_patient(&url, token, &prefer)
        }
    }
    .map_err(explain)?;
    let mut rows: Vec<RunRow> = body
        .get("value")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(parse_row)
        .collect();
    rows.sort_by(|a, b| b.start_time.cmp(&a.start_time));
    Ok(RunPage { rows, next: opt_str(&body, "@odata.nextLink") })
}

/// `[from, to)` cut into slices: an hour each for a day or two, a day each beyond.
pub fn slices(from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    let step = if to - from <= Duration::hours(48) { Duration::hours(1) } else { Duration::days(1) };
    let mut out = Vec::new();
    let mut at = from;
    while at < to {
        let end = (at + step).min(to);
        out.push((at, end));
        at = end;
    }
    out
}

/// Counts of a summary while it's read.
#[derive(Default, Debug)]
pub struct Tally {
    pub flows: HashMap<String, FlowStats>,
    /// Hour (Unix seconds) → (runs, failures).
    pub hours: HashMap<i64, (u64, u64)>,
    pub rows: usize,
}

impl Tally {
    pub fn add(&mut self, row: &Value) {
        self.rows += 1;
        let status = str_field(row, "status");
        let what = outcome(&status);
        let start = opt_str(row, "starttime");
        let flow_id = flow_of(row).unwrap_or_default();
        let s = self.flows.entry(flow_id.clone()).or_insert_with(|| FlowStats { flow_id, ..Default::default() });
        s.total += 1;
        match what {
            "failed" => s.failed += 1,
            "succeeded" => s.succeeded += 1,
            "cancelled" => s.cancelled += 1,
            "running" => s.running += 1,
            _ => {}
        }
        if start > s.last_run {
            s.last_run = start.clone();
        }
        if what == "failed" && start > s.last_failure {
            s.last_failure = start.clone();
            s.last_error_code = opt_str(row, "errorcode");
        }
        if let Some(hour) = start
            .as_deref()
            .and_then(|t| utc(t).ok())
            .and_then(|t| t.duration_trunc(Duration::hours(1)).ok())
        {
            let h = self.hours.entry(hour.timestamp()).or_default();
            h.0 += 1;
            if what == "failed" {
                h.1 += 1;
            }
        }
    }

    pub fn merge(&mut self, other: Tally) {
        self.rows += other.rows;
        for (k, (t, f)) in other.hours {
            let h = self.hours.entry(k).or_default();
            h.0 += t;
            h.1 += f;
        }
        for (k, o) in other.flows {
            let s = self.flows.entry(k).or_insert_with(|| FlowStats { flow_id: o.flow_id.clone(), ..Default::default() });
            s.total += o.total;
            s.failed += o.failed;
            s.succeeded += o.succeeded;
            s.cancelled += o.cancelled;
            s.running += o.running;
            if o.last_run > s.last_run {
                s.last_run = o.last_run;
            }
            if o.last_failure > s.last_failure {
                s.last_failure = o.last_failure;
                s.last_error_code = o.last_error_code;
            }
        }
    }

    pub fn into_summary(self, since: DateTime<Utc>, until: DateTime<Utc>, truncated: bool, retention_seconds: Option<i64>) -> RunSummary {
        let mut flows: Vec<FlowStats> = self.flows.into_values().collect();
        flows.sort_by(|a, b| b.failed.cmp(&a.failed).then(b.total.cmp(&a.total)).then(a.flow_id.cmp(&b.flow_id)));
        let mut hours: Vec<(i64, (u64, u64))> = self.hours.into_iter().collect();
        hours.sort_by_key(|(h, _)| *h);
        let sum = |f: fn(&FlowStats) -> u64| flows.iter().map(f).sum::<u64>();
        RunSummary {
            since: odata_time(since),
            until: odata_time(until),
            total: sum(|s| s.total),
            failed: sum(|s| s.failed),
            succeeded: sum(|s| s.succeeded),
            cancelled: sum(|s| s.cancelled),
            running: sum(|s| s.running),
            hours: hours
                .into_iter()
                .filter_map(|(h, (total, failed))| {
                    Some(HourBucket { at: odata_time(DateTime::from_timestamp(h, 0)?), total, failed })
                })
                .collect(),
            flows,
            truncated,
            retention_seconds,
        }
    }
}

/// How long the environment keeps flow runs; None if it can't be read.
fn retention(host: &str, token: &str) -> Option<i64> {
    let url = format!("{}/organizations?$select=flowruntimetoliveinseconds", base(host));
    let body = get_json(&url, token, None).ok()?;
    big_int(body.get("value")?.as_array()?.first()?, "flowruntimetoliveinseconds")
}

/// Runs and failures per flow and per hour since `since` (RFC 3339).
pub fn summary(host: &str, token: &str, since: &str) -> AppResult<RunSummary> {
    let until = Utc::now();
    let since = utc(since)?.min(until);
    let work = slices(since, until);
    let next_slice = AtomicUsize::new(0);
    let rows = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let truncated = AtomicBool::new(false);
    let total = Mutex::new(Tally::default());
    let error: Mutex<Option<AppError>> = Mutex::new(None);
    let base = base(host);

    let retention_seconds = std::thread::scope(|scope| {
        let kept = scope.spawn(|| retention(host, token));
        for _ in 0..WORKERS.min(work.len().max(1)) {
            scope.spawn(|| {
                let mut tally = Tally::default();
                loop {
                    let i = next_slice.fetch_add(1, Ordering::SeqCst);
                    if i >= work.len() || stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let (from, to) = work[i];
                    let expr = format!("starttime ge {} and starttime lt {}", odata_time(from), odata_time(to));
                    let mut url = Some(format!(
                        "{}/flowruns?$select={}&$filter={}",
                        base,
                        SCAN_COLUMNS,
                        utf8_percent_encode(&expr, NON_ALPHANUMERIC)
                    ));
                    while let Some(u) = url.take() {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let body = match get_patient(&u, token, PREFER_SCAN) {
                            Ok(b) => b,
                            Err(e) => {
                                stop.store(true, Ordering::SeqCst);
                                error.lock().unwrap().get_or_insert(explain(e));
                                break;
                            }
                        };
                        let page = body.get("value").and_then(|v| v.as_array()).map(Vec::as_slice).unwrap_or_default();
                        for row in page {
                            tally.add(row);
                        }
                        if rows.fetch_add(page.len(), Ordering::SeqCst) + page.len() >= MAX_SCAN_ROWS {
                            truncated.store(true, Ordering::SeqCst);
                            stop.store(true, Ordering::SeqCst);
                            break;
                        }
                        url = opt_str(&body, "@odata.nextLink");
                    }
                }
                total.lock().unwrap().merge(tally);
            });
        }
        kept.join().ok().flatten()
    });

    if let Some(e) = error.into_inner().unwrap() {
        return Err(e);
    }
    Ok(total
        .into_inner()
        .unwrap()
        .into_summary(since, until, truncated.load(Ordering::SeqCst), retention_seconds))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_become_one_odata_expression() {
        assert_eq!(filter_expr(&RunFilter::default()).unwrap(), None);
        let f = RunFilter {
            since: Some("2026-10-03T10:00:00+07:00".into()),
            flow_id: Some("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE".into()),
            status: Some("failed".into()),
            ..Default::default()
        };
        assert_eq!(
            filter_expr(&f).unwrap().unwrap(),
            "starttime ge 2026-10-03T03:00:00Z and (_workflow_value eq aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
             or workflowid eq 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' or workflowid eq 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE') \
             and (status eq 'Failed' or status eq 'TimedOut')"
        );
    }

    #[test]
    fn runs_are_found_by_name_and_by_parent() {
        let by_name = RunFilter { run_name: Some("08584612345678901234567890CU12".into()), ..Default::default() };
        assert_eq!(filter_expr(&by_name).unwrap().unwrap(), "name eq '08584612345678901234567890CU12'");
        let children = RunFilter { parent_run: Some("08584_parent-1".into()), ..Default::default() };
        assert_eq!(filter_expr(&children).unwrap().unwrap(), "parentrunid eq '08584_parent-1'");
        assert!(filter_expr(&RunFilter { run_name: Some("x' or 1 eq 1".into()), ..Default::default() }).is_err());
        assert!(filter_expr(&RunFilter { parent_run: Some("a/b".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn bad_values_are_refused() {
        let bad = |f: RunFilter| filter_expr(&f).is_err();
        assert!(bad(RunFilter { status: Some("broken".into()), ..Default::default() }));
        assert!(bad(RunFilter { flow_id: Some("x' or 1 eq 1".into()), ..Default::default() }));
        assert!(bad(RunFilter { since: Some("today".into()), ..Default::default() }));
        assert!(list("x", "t", &RunFilter::default(), Some("https://evil.example/flowruns?")).is_err());
        assert!(summary("x", "t", "yesterday").is_err());
    }

    #[test]
    fn statuses_read_the_same_whatever_the_spelling() {
        assert_eq!(outcome("Failed"), "failed");
        assert_eq!(outcome("TimedOut"), "failed");
        assert_eq!(outcome("Succeeded"), "succeeded");
        assert_eq!(outcome("Success"), "succeeded");
        assert_eq!(outcome("Cancelled"), "cancelled");
        assert_eq!(outcome("Canceled"), "cancelled");
        assert_eq!(outcome("Running"), "running");
        assert_eq!(outcome("Skipped"), "other");
    }

    #[test]
    fn a_failed_row_reads_its_flow_and_error() {
        let row = json!({
            "flowrunid": "11111111-2222-3333-4444-555555555555",
            "name": "08584612345678901234567890CU12",
            "status": "Failed",
            "starttime": "2026-10-03T03:00:00Z",
            "endtime": "2026-10-03T03:00:05Z",
            "duration": "5123",
            "triggertype": "Automated",
            "errorcode": "ActionFailed",
            "errormessage": "An action failed. No dependent actions succeeded.",
            "_workflow_value": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
            "_workflow_value@OData.Community.Display.V1.FormattedValue": "Sync orders"
        });
        let r = parse_row(&row).unwrap();
        assert_eq!(r.outcome, "failed");
        assert_eq!(r.flow_id.as_deref(), Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        assert_eq!(r.flow_name.as_deref(), Some("Sync orders"));
        assert_eq!(r.duration_ms, Some(5123));
        assert_eq!(r.error_code.as_deref(), Some("ActionFailed"));
        // No lookup: the text copy names the flow.
        let r = parse_row(&json!({ "flowrunid": "x", "status": "Succeeded", "workflowid": "ABC" })).unwrap();
        assert_eq!(r.flow_id.as_deref(), Some("abc"));
        assert!(parse_row(&json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn windows_are_sliced_by_hour_or_day() {
        let t = |s: &str| utc(s).unwrap();
        let day = slices(t("2026-10-02T10:30:00Z"), t("2026-10-03T10:30:00Z"));
        assert_eq!(day.len(), 24);
        assert_eq!(day[0], (t("2026-10-02T10:30:00Z"), t("2026-10-02T11:30:00Z")));
        let week = slices(t("2026-09-26T10:30:00Z"), t("2026-10-03T12:00:00Z"));
        assert_eq!(week.len(), 8);
        assert_eq!(week.last().unwrap().1, t("2026-10-03T12:00:00Z"));
        assert!(slices(t("2026-10-03T10:00:00Z"), t("2026-10-03T10:00:00Z")).is_empty());
    }

    #[test]
    fn tallies_count_per_flow_and_hour_and_merge() {
        let row = |flow: &str, status: &str, at: &str, code: Option<&str>| {
            json!({ "_workflow_value": flow, "status": status, "starttime": at, "errorcode": code })
        };
        let mut a = Tally::default();
        a.add(&row("F1", "Failed", "2026-10-03T03:10:00Z", Some("Old")));
        a.add(&row("F1", "Succeeded", "2026-10-03T03:50:00Z", None));
        a.add(&row("F2", "Succeeded", "2026-10-03T04:05:00Z", None));
        let mut b = Tally::default();
        b.add(&row("f1", "Failed", "2026-10-03T05:00:00Z", Some("New")));
        b.add(&row("F2", "Cancelled", "2026-10-03T05:30:00Z", None));
        a.merge(b);
        let t = |s: &str| utc(s).unwrap();
        let s = a.into_summary(t("2026-10-03T00:00:00Z"), t("2026-10-03T06:00:00Z"), false, Some(2_419_200));
        assert_eq!((s.total, s.failed, s.succeeded, s.cancelled), (5, 2, 2, 1));
        assert_eq!(s.flows[0].flow_id, "f1");
        assert_eq!(s.flows[0].failed, 2);
        assert_eq!(s.flows[0].last_failure.as_deref(), Some("2026-10-03T05:00:00Z"));
        assert_eq!(s.flows[0].last_error_code.as_deref(), Some("New"));
        assert_eq!(s.flows[1].last_run.as_deref(), Some("2026-10-03T05:30:00Z"));
        assert_eq!(
            s.hours,
            vec![
                HourBucket { at: "2026-10-03T03:00:00Z".into(), total: 2, failed: 1 },
                HourBucket { at: "2026-10-03T04:00:00Z".into(), total: 1, failed: 0 },
                HourBucket { at: "2026-10-03T05:00:00Z".into(), total: 2, failed: 1 },
            ]
        );
    }

    #[test]
    fn deepest_read_depth_wins() {
        let v = serde_json::json!({ "RolePrivileges": [{ "Depth": "Basic" }, { "Depth": "Global" }, { "Depth": "Local" }] });
        assert_eq!(deepest(&v), "global");
        assert_eq!(deepest(&serde_json::json!({ "RolePrivileges": [{ "Depth": "Basic" }] })), "basic");
        assert_eq!(deepest(&serde_json::json!({ "RolePrivileges": [{ "Depth": 2 }] })), "deep");
        assert_eq!(deepest(&serde_json::json!({ "RolePrivileges": [] })), "none");
        assert_eq!(deepest(&serde_json::json!({})), "none");
    }

    #[test]
    fn permission_and_missing_table_errors_say_what_to_do() {
        let e = explain(AppError::msg("Request failed (403): Principal user is missing prvReadflowrun privilege"));
        assert!(e.to_string().contains("prvReadflowrun"));
        assert!(e.to_string().starts_with("This account can't read"));
        let e = explain(AppError::msg("Request failed (404): Resource not found for the segment 'flowruns'."));
        assert!(e.to_string().contains("no Flow Run table"));
        assert_eq!(explain(AppError::msg("Request failed (500): boom")).to_string(), "Request failed (500): boom");
    }
}
