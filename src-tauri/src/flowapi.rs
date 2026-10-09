//! The steps of one cloud flow run, read from the Power Automate API
//! (`api.flow.microsoft.com`): Dataverse's `flowrun` keeps only a run's outcome.
//! Its token is for another resource than Dataverse, which some tenants block
//! (Conditional Access, consent); that, and the API refusing the account, come
//! back as `FLOW_API_DENIED:<reason>` so the app can say there's no access.
//! Read only.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

/// The resource (token audience) of the Power Automate API.
pub const RESOURCE: &str = "https://service.flow.microsoft.com";
const API: &str = "https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments";
const VERSION: &str = "2016-11-01";

/// Prefix of the error when this account can't use the Power Automate API.
pub const DENIED: &str = "FLOW_API_DENIED";

pub fn denied(reason: &str) -> AppError {
    AppError::msg(format!("{}:{}", DENIED, reason))
}

/// Pages of actions read at most (the API pages them by 100 or so).
const MAX_PAGES: usize = 50;
/// Largest input / output body shown.
const MAX_CONTENT: usize = 2 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepetitionIndex {
    pub scope_name: String,
    pub item_index: i64,
}

/// A trigger, an action, or one repetition of an action inside a loop.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// The step's name in the definition (`Get_items`); a repetition's own name for repetitions.
    pub name: String,
    pub status: String,
    pub code: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// Signed links to the step's inputs / outputs (read with `content`).
    pub inputs_link: Option<String>,
    pub inputs_size: Option<i64>,
    pub outputs_link: Option<String>,
    pub outputs_size: Option<i64>,
    /// How many times it ran, for a step inside a loop.
    pub repetition_count: Option<i64>,
    /// Which loop items this repetition ran for (outermost first).
    pub repetition: Vec<RepetitionIndex>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunSteps {
    pub trigger: Option<Step>,
    pub actions: Vec<Step>,
    /// More actions than `MAX_PAGES` pages: the rest weren't read.
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    /// The body, JSON pretty-printed when it is JSON.
    pub text: String,
    pub truncated: bool,
}

fn s(v: &Value) -> Option<String> {
    v.as_str().filter(|x| !x.is_empty()).map(str::to_string)
}

/// A step from the API's `{ name, properties: { status, inputsLink, … } }`.
pub fn parse_step(v: &Value) -> Step {
    let p = &v["properties"];
    let link = |key: &str| (s(&p[key]["uri"]), p[key]["contentSize"].as_i64());
    let (inputs_link, inputs_size) = link("inputsLink");
    let (outputs_link, outputs_size) = link("outputsLink");
    let repetition = p["repetitionIndexes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    Some(RepetitionIndex {
                        scope_name: s(&r["scopeName"])?,
                        item_index: r["itemIndex"].as_i64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Step {
        name: s(&v["name"]).unwrap_or_default(),
        status: s(&p["status"]).unwrap_or_default(),
        code: s(&p["code"]),
        start_time: s(&p["startTime"]),
        end_time: s(&p["endTime"]),
        error_code: s(&p["error"]["code"]),
        error_message: s(&p["error"]["message"]),
        inputs_link,
        inputs_size,
        outputs_link,
        outputs_size,
        repetition_count: p["repetitionCount"].as_i64(),
        repetition,
    }
}

/// What a failed call means here. 401 / 403 = this account may not read the run.
fn status_error(code: u16, r: ureq::Response) -> AppError {
    let text = crate::http::text(r);
    let json = serde_json::from_str::<Value>(&text).ok();
    let api_code = json.as_ref().and_then(|v| s(&v["error"]["code"]));
    let msg = json
        .as_ref()
        .and_then(|v| s(&v["error"]["message"]))
        .unwrap_or_else(|| text.chars().take(500).collect());
    match code {
        401 | 403 => denied(&format!("Power Automate refused ({}{}): {}", code, api_code.map(|c| format!(" {}", c)).unwrap_or_default(), msg)),
        404 => AppError::msg(format!(
            "Not found in Power Automate (404{}): {}",
            api_code.map(|c| format!(" {}", c)).unwrap_or_default(),
            msg
        )),
        _ => AppError::msg(format!("Request failed ({}): {}", code, msg)),
    }
}

/// GET with the API token, trying again while the API is busy.
fn get(url: &str, token: &str) -> AppResult<Value> {
    let mut attempt = 0;
    loop {
        let resp = ureq::get(url)
            .set("Authorization", &format!("Bearer {}", token))
            .set("Accept", "application/json")
            .set("Accept-Encoding", crate::http::ACCEPT_ENCODING)
            .call();
        match resp {
            Ok(r) => return Ok(crate::http::json(r)?),
            Err(ureq::Error::Status(code, _)) if (code == 429 || code == 503) && attempt < 4 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_secs(2 * attempt));
            }
            Err(ureq::Error::Status(code, r)) => return Err(status_error(code, r)),
            Err(e) => return Err(AppError::msg(e.to_string())),
        }
    }
}

/// Names used in a URL path: GUIDs, run names (`08584…CU12`), step names. Refuses anything else.
pub fn segment(v: &str) -> AppResult<&str> {
    let ok = !v.is_empty() && v.len() <= 200 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(v)
    } else {
        Err(AppError::msg(format!("Not a valid name: {}", v)))
    }
}

/// A step name in a URL path: designers allow more than letters and `_`.
fn step_segment(name: &str) -> AppResult<String> {
    if name.is_empty() || name.len() > 400 {
        return Err(AppError::msg(format!("Not a valid step name: {}", name)));
    }
    Ok(name
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect())
}

static ENVIRONMENTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// The Power Platform environment id of a Dataverse org (cached per host).
pub fn environment_id(host: &str, dv_token: &str) -> AppResult<String> {
    if let Some((_, id)) = ENVIRONMENTS.lock().ok().and_then(|g| g.iter().find(|(h, _)| h == host).cloned()) {
        return Ok(id);
    }
    let url = format!(
        "https://{}/api/data/v9.2/RetrieveCurrentOrganization(AccessType=@p)?@p=Microsoft.Dynamics.CRM.EndpointAccessType'Default'",
        host
    );
    let v = crate::metadata::get_json(&url, dv_token, None)?;
    let id = s(&v["Detail"]["EnvironmentId"]).ok_or_else(|| AppError::msg("Dataverse didn't say which Power Platform environment this is"))?;
    if let Ok(mut g) = ENVIRONMENTS.lock() {
        g.push((host.to_string(), id.clone()));
    }
    Ok(id)
}

/// The run's page in the Power Automate portal.
pub fn portal_url(environment: &str, flow_id: &str, run_name: &str) -> AppResult<String> {
    Ok(format!(
        "https://make.powerautomate.com/environments/{}/flows/{}/runs/{}",
        segment(environment)?,
        segment(flow_id)?,
        segment(run_name)?
    ))
}

fn run_base(environment: &str, flow: &str, run_name: &str) -> AppResult<String> {
    Ok(format!("{}/{}/flows/{}/runs/{}", API, segment(environment)?, segment(flow)?, segment(run_name)?))
}

/// The name Power Automate knows a solution flow by: its `workflowid`, or (older
/// flows) the `resourceid` Dataverse keeps for it. None when there's no other.
fn other_flow_name(host: &str, dv_token: &str, flow_id: &str) -> Option<String> {
    let url = format!("https://{}/api/data/v9.2/workflows({})?$select=resourceid", host, segment(flow_id).ok()?);
    let v = crate::metadata::get_json(&url, dv_token, None).ok()?;
    s(&v["resourceid"]).filter(|r| !r.eq_ignore_ascii_case(flow_id))
}

/// Reads `path` under the run, for the flow's `workflowid` and, if Power Automate
/// doesn't know that one, its `resourceid`.
fn under_run(host: &str, dv_token: &str, token: &str, environment: &str, flow_id: &str, run_name: &str, path: &str) -> AppResult<Value> {
    let first = get(&format!("{}{}", run_base(environment, flow_id, run_name)?, path), token);
    match first {
        Err(e) if e.to_string().contains("(404") => match other_flow_name(host, dv_token, flow_id) {
            Some(other) => get(&format!("{}{}", run_base(environment, &other, run_name)?, path), token),
            None => Err(e),
        },
        other => other,
    }
}

/// A run's trigger and every action that ran (or was skipped), in the API's order.
pub fn run_steps(host: &str, dv_token: &str, token: &str, flow_id: &str, run_name: &str) -> AppResult<RunSteps> {
    let env = environment_id(host, dv_token)?;
    let run = under_run(host, dv_token, token, &env, flow_id, run_name, &format!("?api-version={}", VERSION))?;
    let trigger = run["properties"]["trigger"].is_object().then(|| parse_step(&run["properties"]["trigger"]));

    let mut actions = Vec::new();
    let mut page = under_run(host, dv_token, token, &env, flow_id, run_name, &format!("/actions?api-version={}", VERSION))?;
    let mut truncated = false;
    for n in 0.. {
        actions.extend(page["value"].as_array().into_iter().flatten().map(parse_step));
        let Some(next) = s(&page["nextLink"]) else { break };
        if n + 1 >= MAX_PAGES {
            truncated = true;
            break;
        }
        if !next.starts_with("https://api.flow.microsoft.com/") {
            return Err(AppError::msg("Unexpected next page link"));
        }
        page = get(&next, token)?;
    }
    remember(trigger.iter().chain(actions.iter()));
    Ok(RunSteps { trigger, actions, truncated })
}

/// Every repetition of a step inside a loop.
pub fn repetitions(host: &str, dv_token: &str, token: &str, flow_id: &str, run_name: &str, step: &str) -> AppResult<Vec<Step>> {
    let env = environment_id(host, dv_token)?;
    let path = format!("/actions/{}/repetitions?api-version={}", step_segment(step)?, VERSION);
    let mut page = under_run(host, dv_token, token, &env, flow_id, run_name, &path)?;
    let mut out = Vec::new();
    for n in 0.. {
        out.extend(page["value"].as_array().into_iter().flatten().map(parse_step));
        let Some(next) = s(&page["nextLink"]) else { break };
        if n + 1 >= MAX_PAGES || !next.starts_with("https://api.flow.microsoft.com/") {
            break;
        }
        page = get(&next, token)?;
    }
    remember(out.iter());
    Ok(out)
}

/// Inputs / outputs links the API handed out this session: only those are read,
/// whatever host they point at (it differs by region and cloud).
static ISSUED: Mutex<Vec<String>> = Mutex::new(Vec::new());
const MAX_ISSUED: usize = 20_000;

fn remember<'a>(steps: impl Iterator<Item = &'a Step>) {
    let Ok(mut issued) = ISSUED.lock() else { return };
    for link in steps.flat_map(|s| [&s.inputs_link, &s.outputs_link]).flatten() {
        if !issued.contains(link) {
            issued.push(link.clone());
        }
    }
    let extra = issued.len().saturating_sub(MAX_ISSUED);
    issued.drain(..extra);
}

/// The host of an https link (lowercase, no port); None for anything else.
pub fn https_host(link: &str) -> Option<String> {
    let rest = link.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?.split(':').next()?.to_ascii_lowercase();
    (!host.is_empty() && !host.contains('@')).then_some(host)
}

/// Links on the API itself need its token; signed links elsewhere carry their own signature.
pub fn needs_token(host: &str) -> bool {
    host == "api.flow.microsoft.com"
}

/// An input / output body behind a step's link.
pub fn content(link: &str, token: &str) -> AppResult<Content> {
    let host = https_host(link).ok_or_else(|| AppError::msg("Not an https link"))?;
    let issued = ISSUED.lock().map(|g| g.iter().any(|l| l == link)).unwrap_or(false);
    if !issued {
        return Err(AppError::msg(format!(
            "This link ({}) didn't come from the run's steps: read the steps again",
            host
        )));
    }
    let (raw, truncated) = fetch(link, &host, token)?;
    let text = if truncated {
        raw
    } else {
        serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| serde_json::to_string_pretty(&v).ok())
            .unwrap_or(raw)
    };
    Ok(Content { text, truncated })
}

/// The body behind a content link, as text (at most `MAX_CONTENT`; true = cut).
fn fetch(link: &str, host: &str, token: &str) -> AppResult<(String, bool)> {
    let mut req = ureq::get(link).set("Accept-Encoding", crate::http::ACCEPT_ENCODING);
    if needs_token(host) {
        req = req.set("Authorization", &format!("Bearer {}", token));
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(403, _)) => {
            return Err(AppError::msg("The link to this content has expired. Read the run's steps again."))
        }
        Err(ureq::Error::Status(code, r)) => return Err(status_error(code, r)),
        Err(e) => return Err(AppError::msg(e.to_string())),
    };
    let (bytes, _) = crate::http::read_body(resp, |r| {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(r, (MAX_CONTENT + 1) as u64), &mut buf)?;
        Ok(buf)
    })?;
    let truncated = bytes.len() > MAX_CONTENT;
    let raw = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_CONTENT)]).into_owned();
    // Some bodies start with a byte order mark, which JSON parsers refuse.
    let raw = raw.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(raw);
    Ok((raw, truncated))
}

// ---- Searching runs for a value (a PO number…) ----

/// Bodies read while searching, kept so a second search of the same runs is quick.
struct BodyCache {
    bodies: HashMap<String, Arc<String>>,
    order: VecDeque<String>,
    bytes: usize,
}

const CACHE_BYTES: usize = 96 * 1024 * 1024;

fn cache() -> &'static Mutex<BodyCache> {
    static CACHE: OnceLock<Mutex<BodyCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BodyCache { bodies: HashMap::new(), order: VecDeque::new(), bytes: 0 }))
}

/// A body by its link, from the cache or read (links are signed per run, so a
/// link's body never changes).
fn cached_body(link: &str, token: &str) -> AppResult<Arc<String>> {
    // The signature changes between reads of the same run: key on the path.
    let key = link.split('?').next().unwrap_or(link).to_string();
    if let Some(body) = cache().lock().ok().and_then(|c| c.bodies.get(&key).cloned()) {
        return Ok(body);
    }
    let host = https_host(link).ok_or_else(|| AppError::msg("Not an https link"))?;
    let (text, _) = fetch(link, &host, token)?;
    let body = Arc::new(text);
    if let Ok(mut c) = cache().lock() {
        c.bytes += body.len();
        c.bodies.insert(key.clone(), body.clone());
        c.order.push_back(key);
        while c.bytes > CACHE_BYTES {
            let Some(old) = c.order.pop_front() else { break };
            if let Some(b) = c.bodies.remove(&old) {
                c.bytes -= b.len();
            }
        }
    }
    Ok(body)
}

/// Which steps a search reads.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchScope {
    /// Step names (as in the definition); None = every step.
    pub steps: Option<Vec<String>>,
    /// With `steps`: the trigger's outputs too.
    #[serde(default)]
    pub trigger: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// The step's name in the definition.
    pub step: String,
    /// "inputs" or "outputs".
    pub part: &'static str,
    /// The loop items, for a step inside a loop.
    pub repetition: Vec<RepetitionIndex>,
    /// The text around the match.
    pub snippet: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunSearch {
    pub hits: Vec<SearchHit>,
    /// Bodies that couldn't be read (the search went on without them).
    pub skipped: usize,
}

/// Repetitions of a looped step read at most per run.
const MAX_REPETITIONS: usize = 500;

/// The text around the first match of `needle` (lowercase) in `text`, on one line.
pub fn snippet(text: &str, needle: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let at = lower.find(needle)?;
    // Lowercasing can change byte lengths: count characters instead.
    let start_char = lower[..at].chars().count();
    let len = needle.chars().count();
    let chars: Vec<char> = text.chars().collect();
    let from = start_char.saturating_sub(60);
    let to = (start_char + len + 60).min(chars.len());
    let mut s: String = chars[from.min(chars.len())..to].iter().collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if from > 0 {
        s.insert(0, '…');
    }
    if to < chars.len() {
        s.push('…');
    }
    Some(s)
}

/// Searches one run's step inputs and outputs for `needle` (any case).
pub fn search_run(host: &str, dv_token: &str, token: &str, flow_id: &str, run_name: &str, needle: &str, scope: &SearchScope) -> AppResult<RunSearch> {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return Err(AppError::msg("Nothing to search for"));
    }
    let env = environment_id(host, dv_token)?;
    let mut steps = Vec::new();
    match &scope.steps {
        None => {
            let all = run_steps(host, dv_token, token, flow_id, run_name)?;
            steps.extend(all.trigger);
            steps.extend(all.actions);
        }
        Some(names) => {
            if scope.trigger {
                let run = under_run(host, dv_token, token, &env, flow_id, run_name, &format!("?api-version={}", VERSION))?;
                if run["properties"]["trigger"].is_object() {
                    steps.push(parse_step(&run["properties"]["trigger"]));
                }
            }
            for name in names {
                let path = format!("/actions/{}?api-version={}", step_segment(name)?, VERSION);
                match under_run(host, dv_token, token, &env, flow_id, run_name, &path) {
                    Ok(v) => steps.push(parse_step(&v)),
                    // The step isn't in this run (the flow changed since).
                    Err(e) if e.to_string().contains("(404") => {}
                    Err(e) => return Err(e),
                }
            }
        }
    }

    let mut hits = Vec::new();
    let mut skipped = 0;
    for step in &steps {
        // In a loop the step's own links (if any) are one repetition: read them all.
        let looped = step.repetition_count.unwrap_or(0) > 0;
        let reads: Vec<Step> = if looped {
            let mut reps = repetitions(host, dv_token, token, flow_id, run_name, &step.name)?;
            reps.truncate(MAX_REPETITIONS);
            reps
        } else {
            vec![step.clone()]
        };
        for read in &reads {
            for (part, link) in [("inputs", &read.inputs_link), ("outputs", &read.outputs_link)] {
                let Some(link) = link else { continue };
                match cached_body(link, token) {
                    Ok(body) => {
                        if let Some(snippet) = snippet(&body, &needle) {
                            hits.push(SearchHit { step: step.name.clone(), part, repetition: read.repetition.clone(), snippet });
                        }
                    }
                    Err(_) => skipped += 1,
                }
            }
        }
    }
    Ok(RunSearch { hits, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_failed_action_reads_its_error_links_and_loop() {
        let step = parse_step(&json!({
            "name": "Update_a_row",
            "properties": {
                "status": "Failed",
                "code": "BadRequest",
                "startTime": "2026-10-09T01:02:03Z",
                "endTime": "2026-10-09T01:02:04Z",
                "error": { "code": "BadRequest", "message": "Invalid property" },
                "inputsLink": { "uri": "https://prod-1.westeurope.logic.azure.com:443/x/contents/ActionInputs?sig=a", "contentSize": 120 },
                "outputsLink": { "uri": "https://prod-1.westeurope.logic.azure.com:443/x/contents/ActionOutputs?sig=b" },
                "repetitionCount": 3
            }
        }));
        assert_eq!(step.name, "Update_a_row");
        assert_eq!(step.status, "Failed");
        assert_eq!(step.error_message.as_deref(), Some("Invalid property"));
        assert_eq!(step.inputs_size, Some(120));
        assert!(step.outputs_link.unwrap().ends_with("sig=b"));
        assert_eq!(step.repetition_count, Some(3));
    }

    #[test]
    fn a_repetition_knows_its_loop_items() {
        let step = parse_step(&json!({
            "name": "000002-000001",
            "properties": {
                "status": "Succeeded",
                "repetitionIndexes": [ { "scopeName": "Apply_to_each", "itemIndex": 2 }, { "scopeName": "Inner", "itemIndex": 1 } ]
            }
        }));
        assert_eq!(
            step.repetition,
            vec![
                RepetitionIndex { scope_name: "Apply_to_each".into(), item_index: 2 },
                RepetitionIndex { scope_name: "Inner".into(), item_index: 1 },
            ]
        );
        assert!(step.inputs_link.is_none() && step.error_code.is_none());
    }

    #[test]
    fn links_name_their_host_and_only_the_api_gets_the_token() {
        assert_eq!(
            https_host("https://prod-12.westeurope.logic.azure.com:443/workflows/x?sig=1").as_deref(),
            Some("prod-12.westeurope.logic.azure.com")
        );
        assert_eq!(https_host("https://Example.net?x=1").as_deref(), Some("example.net"));
        assert!(https_host("http://prod-12.westeurope.logic.azure.com/x").is_none());
        assert!(https_host("https://user@evil.example/x").is_none());
        assert!(needs_token("api.flow.microsoft.com"));
        assert!(!needs_token("api.flow.microsoft.com.evil.example"));
    }

    #[test]
    fn only_links_from_the_steps_are_read() {
        let link = "https://region.example-flow-host.net/runs/x/contents/ActionInputs?sig=z".to_string();
        let err = content(&link, "t").unwrap_err().to_string();
        assert!(err.contains("region.example-flow-host.net"), "{}", err);
        remember([Step { inputs_link: Some(link.clone()), ..Default::default() }].iter());
        assert!(ISSUED.lock().unwrap().contains(&link));
    }

    #[test]
    fn names_in_paths_are_checked() {
        assert!(segment("08584512345678901234567890CU12").is_ok());
        assert!(segment("Apply_to_each").is_ok());
        assert!(segment("a/../b").is_err());
        assert!(segment("x?y").is_err());
        assert!(segment("").is_err());
        assert_eq!(step_segment("Gửi mail (2)").unwrap(), "G%E1%BB%ADi%20mail%20%282%29");
        assert!(step_segment("").is_err());
        assert_eq!(
            portal_url("Default-1", "0a1b", "0858CU1").unwrap(),
            "https://make.powerautomate.com/environments/Default-1/flows/0a1b/runs/0858CU1"
        );
    }

    #[test]
    fn snippets_show_the_match_in_context_on_one_line() {
        let text = format!("{}\n  \"PONumber\": \"4500012345\",\n{}", "x".repeat(100), "y".repeat(100));
        let s = snippet(&text, "4500012345").unwrap();
        assert!(s.contains("\"PONumber\": \"4500012345\","), "{}", s);
        assert!(s.starts_with('…') && s.ends_with('…') && !s.contains('\n'));
        assert_eq!(snippet("Đơn hàng PO-77 xong", "po-77").as_deref(), Some("Đơn hàng PO-77 xong"));
        assert!(snippet("nothing here", "4500").is_none());
    }

    #[test]
    fn a_search_scope_reads_from_the_frontend() {
        let s: SearchScope = serde_json::from_value(json!({ "steps": ["Parse_JSON"], "trigger": false })).unwrap();
        assert_eq!(s.steps.as_deref(), Some(&["Parse_JSON".to_string()][..]));
        let all: SearchScope = serde_json::from_value(json!({ "steps": null })).unwrap();
        assert!(all.steps.is_none() && !all.trigger);
    }

    #[test]
    fn denials_carry_the_prefix() {
        assert_eq!(denied("blocked").to_string(), "FLOW_API_DENIED:blocked");
    }
}
