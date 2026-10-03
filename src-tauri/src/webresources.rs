//! Web resources, read only (Phase 1 of the Web resources tool):
//! - `list`: every visible web resource without its content, with the
//!   solutions it is part of, in three requests at once;
//! - `detail`: one web resource with its published content and, when it
//!   differs, the unpublished (saved but not published) one.
//! Writes (Phase 2), each confirmed in the webview first:
//! - `update`: new content (saved, not published), refused when someone else
//!   saved since the editor read it;
//! - `publish`: one `PublishXml` for any number of web resources;
//! - `create` (optionally into a solution) and `delete`.
//! Content stays base64 end to end; the webview decodes text and shows images.

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use crate::odata::{bool_field, formatted, get_all, guid, int, opt_str, str_field};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// `solutioncomponent.componenttype` of a web resource.
pub const COMPONENT_WEB_RESOURCE: i64 = 61;
/// Solutions every component belongs to; listing them says nothing.
const HIDDEN_SOLUTIONS: &[&str] = &["Default", "Active", "Basic"];

const PREFER_LABELS: &str =
    "odata.include-annotations=\"OData.Community.Display.V1.FormattedValue\",odata.maxpagesize=5000";
const PREFER_PLAIN: &str = "odata.maxpagesize=5000";

/// Starts the error of a save refused because the web resource changed on the server.
pub const CONFLICT: &str = "CONFLICT:";

const LIST_COLUMNS: &str =
    "webresourceid,name,displayname,description,webresourcetype,ismanaged,ishidden,modifiedon,_modifiedby_value";

/// Name prefixes of Microsoft's own web resources, for rows whose solutions
/// couldn't be read.
const MICROSOFT_PREFIXES: &[&str] = &["msdyn", "mscrm", "msdynce", "adx_", "mspp_", "msfp_", "msa_", "mspcat_", "msft_", "cc_"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebResource {
    pub id: String,
    /// Unique name, often a path: `new_/scripts/account.js`.
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    /// 1 HTML · 2 CSS · 3 JS · 4 XML · 5 PNG · 6 JPG · 7 GIF · 8 XAP · 9 XSL · 10 ICO · 11 SVG · 12 RESX.
    pub kind: i64,
    pub managed: bool,
    pub modified_on: String,
    pub modified_by: Option<String>,
    /// Friendly names of the (visible) solutions it is part of.
    pub solutions: Vec<String>,
    /// Shipped by Microsoft (a Dynamics 365 app, the platform…).
    pub microsoft: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Solution {
    pub id: String,
    pub unique_name: String,
    pub friendly_name: String,
    pub managed: bool,
    pub publisher: String,
    /// The publisher's customization prefix (`new`, `contoso`…).
    pub prefix: String,
    pub microsoft: bool,
    /// Visible web resources in it (0 for a solution to create one in).
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebResourceList {
    pub items: Vec<WebResource>,
    /// Every visible solution, with how many of the web resources it holds.
    pub solutions: Vec<Solution>,
    /// Solutions couldn't be read (usually a missing `prvReadSolution`);
    /// the web resources are still listed.
    pub solutions_error: Option<String>,
    /// The environment's largest file (`organization.maxuploadfilesize`, bytes);
    /// web resources can't be larger.
    pub max_upload_size: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebResourceDetail {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub kind: i64,
    pub managed: bool,
    pub customizable: bool,
    pub can_be_deleted: bool,
    pub language: Option<i64>,
    pub introduced_version: Option<String>,
    pub created_on: String,
    pub created_by: Option<String>,
    pub modified_on: String,
    pub modified_by: Option<String>,
    /// Published content, base64 ("" when there is none).
    pub content: String,
    /// Decoded size of `content` in bytes.
    pub size: usize,
    /// Saved-but-not-published content, only when it differs from `content`.
    pub unpublished: Option<String>,
    pub unpublished_size: Option<usize>,
    /// The unpublished version couldn't be read (the published one still came back).
    pub unpublished_error: Option<String>,
    pub etag: Option<String>,
    /// Hash of the latest content (unpublished, else published): a save sends
    /// it back so a change someone else made meanwhile isn't overwritten.
    pub latest_hash: String,
}

/// A managed boolean property (`{ "Value": true, … }`) or a plain boolean.
fn managed_bool(row: &Value, key: &str) -> Option<bool> {
    match row.get(key)? {
        Value::Bool(b) => Some(*b),
        v => v.get("Value").and_then(|x| x.as_bool()),
    }
}

/// Bytes `b64` decodes to, without decoding it.
pub fn decoded_len(b64: &str) -> usize {
    let s = b64.trim_end();
    let pad = s.bytes().rev().take_while(|b| *b == b'=').count();
    (s.len() * 3 / 4).saturating_sub(pad)
}

pub fn is_microsoft_publisher(unique_name: &str) -> bool {
    let n = unique_name.to_ascii_lowercase();
    n.contains("microsoft") || n.starts_with("dynamics365") || n == "msdyn"
}

fn has_microsoft_prefix(name: &str) -> bool {
    let n = name.trim_start_matches('/').to_ascii_lowercase();
    MICROSOFT_PREFIXES.iter().any(|p| n.starts_with(p))
}

pub fn parse_resource(row: &Value) -> Option<WebResource> {
    Some(WebResource {
        id: opt_str(row, "webresourceid")?.to_ascii_lowercase(),
        name: str_field(row, "name"),
        display_name: str_field(row, "displayname"),
        description: opt_str(row, "description").filter(|d| !d.trim().is_empty()),
        kind: int(row, "webresourcetype").unwrap_or(0),
        managed: bool_field(row, "ismanaged"),
        modified_on: str_field(row, "modifiedon"),
        modified_by: formatted(row, "_modifiedby_value"),
        solutions: Vec::new(),
        microsoft: false,
    })
}

pub fn parse_solution(row: &Value) -> Option<Solution> {
    let unique_name = str_field(row, "uniquename");
    if !row.get("isvisible").and_then(|v| v.as_bool()).unwrap_or(true) || HIDDEN_SOLUTIONS.contains(&unique_name.as_str()) {
        return None;
    }
    let publisher = row.get("publisherid").filter(|p| p.is_object());
    let publisher_name = publisher.map(|p| str_field(p, "uniquename")).unwrap_or_default();
    Some(Solution {
        id: opt_str(row, "solutionid")?.to_ascii_lowercase(),
        friendly_name: match str_field(row, "friendlyname") {
            n if n.is_empty() => unique_name.clone(),
            n => n,
        },
        unique_name,
        managed: bool_field(row, "ismanaged"),
        microsoft: is_microsoft_publisher(&publisher_name),
        count: 0,
        prefix: publisher.map(|p| str_field(p, "customizationprefix")).unwrap_or_default(),
        publisher: publisher.and_then(|p| opt_str(p, "friendlyname")).unwrap_or(publisher_name),
    })
}

/// Puts the solutions on each web resource, counts each solution's and
/// decides which web resources are Microsoft's:
/// managed, and either every solution it's in is published by Microsoft or
/// (no solution known) its name has one of Microsoft's prefixes.
pub fn attach_solutions(items: &mut [WebResource], solutions: &[Solution], components: &[(String, String)]) -> Vec<Solution> {
    let by_id: HashMap<&str, &Solution> = solutions.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut of_resource: HashMap<&str, Vec<&Solution>> = HashMap::new();
    for (object, solution) in components {
        if let Some(s) = by_id.get(solution.as_str()) {
            let list = of_resource.entry(object.as_str()).or_default();
            if !list.iter().any(|x| x.id == s.id) {
                list.push(s);
            }
        }
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for item in items.iter_mut() {
        let sols = of_resource.get(item.id.as_str()).map(|v| v.as_slice()).unwrap_or(&[]);
        let mut names: Vec<String> = sols.iter().map(|s| s.friendly_name.clone()).collect();
        names.sort_by_key(|n| n.to_lowercase());
        item.solutions = names;
        item.microsoft = item.managed
            && if sols.is_empty() {
                has_microsoft_prefix(&item.name)
            } else {
                sols.iter().all(|s| s.microsoft)
            };
        for s in sols {
            *counts.entry(s.id.as_str()).or_default() += 1;
        }
    }
    let mut all: Vec<Solution> = solutions
        .iter()
        .map(|s| Solution { count: counts.get(s.id.as_str()).copied().unwrap_or(0), ..s.clone() })
        .collect();
    all.sort_by_key(|s| s.friendly_name.to_lowercase());
    all
}

fn list_rows(base: &str, token: &str) -> AppResult<Vec<Value>> {
    let url = format!("{}/webresourceset?$select={}&$filter=ishidden/Value eq false", base, LIST_COLUMNS).replace(' ', "%20");
    match get_all(url, token, PREFER_LABELS) {
        Ok(rows) => Ok(rows),
        // Filtering on a managed property isn't accepted everywhere: read all, drop hidden ones here.
        Err(e) if e.to_string().contains("(400)") => {
            let url = format!("{}/webresourceset?$select={}", base, LIST_COLUMNS);
            Ok(get_all(url, token, PREFER_LABELS)?
                .into_iter()
                .filter(|r| !managed_bool(r, "ishidden").unwrap_or(false))
                .collect())
        }
        Err(e) => Err(e),
    }
}

fn solution_rows(base: &str, token: &str) -> AppResult<(Vec<Solution>, Vec<(String, String)>)> {
    let (solutions, components) = std::thread::scope(|s| {
        let components = s.spawn(|| {
            let url = format!(
                "{}/solutioncomponents?$select=objectid,_solutionid_value&$filter=componenttype eq {}",
                base, COMPONENT_WEB_RESOURCE
            )
            .replace(' ', "%20");
            get_all(url, token, PREFER_PLAIN)
        });
        let url = format!(
            "{}/solutions?$select=solutionid,uniquename,friendlyname,ismanaged,isvisible&$expand=publisherid($select=uniquename,friendlyname,customizationprefix)",
            base
        );
        let solutions = get_all(url, token, PREFER_PLAIN);
        (solutions, components.join().unwrap_or_else(|_| Err(AppError::msg("solution request panicked"))))
    });
    let solutions = solutions?.iter().filter_map(parse_solution).collect();
    let components = components?
        .iter()
        .filter_map(|r| Some((opt_str(r, "objectid")?.to_ascii_lowercase(), opt_str(r, "_solutionid_value")?.to_ascii_lowercase())))
        .collect();
    Ok((solutions, components))
}

pub fn list(host: &str, token: &str) -> AppResult<WebResourceList> {
    let base = format!("https://{}/api/data/v9.2", host);
    let (rows, sols, max_upload_size) = std::thread::scope(|s| {
        let sols = s.spawn(|| solution_rows(&base, token));
        let limit = s.spawn(|| {
            get_json(&format!("{}/organizations?$select=maxuploadfilesize", base), token, None)
                .ok()
                .and_then(|v| v.get("value")?.get(0)?.get("maxuploadfilesize")?.as_i64())
        });
        let rows = list_rows(&base, token);
        (
            rows,
            sols.join().unwrap_or_else(|_| Err(AppError::msg("solution request panicked"))),
            limit.join().ok().flatten(),
        )
    });
    let mut items: Vec<WebResource> = rows?.iter().filter_map(parse_resource).collect();
    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let (solutions, solutions_error) = match sols {
        Ok((solutions, components)) => (attach_solutions(&mut items, &solutions, &components), None),
        Err(e) => {
            attach_solutions(&mut items, &[], &[]);
            (Vec::new(), Some(e.to_string()))
        }
    };
    Ok(WebResourceList { items, solutions, solutions_error, max_upload_size })
}

pub fn detail(host: &str, token: &str, id: &str) -> AppResult<WebResourceDetail> {
    let id = guid(id, "web resource id")?;
    let base = format!("https://{}/api/data/v9.2", host);
    let url = format!(
        "{}/webresourceset({})?$select=webresourceid,name,displayname,description,webresourcetype,ismanaged,iscustomizable,canbedeleted,languagecode,introducedversion,createdon,_createdby_value,modifiedon,_modifiedby_value,content",
        base, id
    );
    let unpublished_url = format!("{}/webresourceset({})/Microsoft.Dynamics.CRM.RetrieveUnpublished()", base, id);
    let (row, unpublished) = std::thread::scope(|s| {
        let unpublished = s.spawn(|| get_json(&unpublished_url, token, None));
        let row = get_json(&url, token, Some(PREFER_LABELS));
        (row, unpublished.join().unwrap_or_else(|_| Err(AppError::msg("request panicked"))))
    });
    let row = row.map_err(|e| {
        if e.to_string().contains("(404)") {
            AppError::msg("This web resource isn't in this environment (it may have been deleted).")
        } else {
            e
        }
    })?;
    let content = str_field(&row, "content");
    let (unpublished, unpublished_error) = match unpublished {
        Ok(u) => (Some(str_field(&u, "content")).filter(|c| *c != content), None),
        Err(e) => (None, Some(e.to_string())),
    };
    Ok(WebResourceDetail {
        id,
        name: str_field(&row, "name"),
        display_name: str_field(&row, "displayname"),
        description: opt_str(&row, "description").filter(|d| !d.trim().is_empty()),
        kind: int(&row, "webresourcetype").unwrap_or(0),
        managed: bool_field(&row, "ismanaged"),
        customizable: managed_bool(&row, "iscustomizable").unwrap_or(true),
        can_be_deleted: managed_bool(&row, "canbedeleted").unwrap_or(true),
        language: int(&row, "languagecode").filter(|l| *l > 0),
        introduced_version: opt_str(&row, "introducedversion"),
        created_on: str_field(&row, "createdon"),
        created_by: formatted(&row, "_createdby_value"),
        modified_on: str_field(&row, "modifiedon"),
        modified_by: formatted(&row, "_modifiedby_value"),
        size: decoded_len(&content),
        unpublished_size: unpublished.as_deref().map(decoded_len),
        etag: opt_str(&row, "@odata.etag"),
        latest_hash: hash(unpublished.as_deref().unwrap_or(&content)),
        unpublished,
        unpublished_error,
        content,
    })
}

/// Identifies a content (base64) without sending it back and forth.
pub fn hash(content: &str) -> String {
    Sha256::digest(content.trim().as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}

/// The latest content: the unpublished one, or the published one when that
/// can't be read.
fn latest_content(base: &str, token: &str, id: &str) -> AppResult<String> {
    match get_json(&format!("{}/webresourceset({})/Microsoft.Dynamics.CRM.RetrieveUnpublished()", base, id), token, None) {
        Ok(v) => Ok(str_field(&v, "content")),
        Err(_) => Ok(str_field(&get_json(&format!("{}/webresourceset({})?$select=content", base, id), token, None)?, "content")),
    }
}

/// Sends a write; errors carry the server's message.
fn send(method: &str, url: &str, token: &str, body: Option<&Value>, headers: &[(&str, &str)]) -> AppResult<ureq::Response> {
    let mut req = ureq::request(method, url)
        .set("Authorization", &format!("Bearer {}", token))
        .set("Accept", "application/json")
        .set("OData-MaxVersion", "4.0")
        .set("OData-Version", "4.0");
    for (k, v) in headers {
        req = req.set(k, v);
    }
    let resp = match body {
        Some(b) => req.set("Content-Type", "application/json; charset=utf-8").send_string(&b.to_string()),
        None => req.call(),
    };
    match resp {
        Ok(r) => Ok(r),
        Err(ureq::Error::Status(code, r)) => {
            let text = crate::http::text(r);
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.pointer("/error/message")?.as_str().map(|s| s.to_string()))
                .unwrap_or(text);
            Err(AppError::msg(format!("Request failed ({}): {}", code, msg)))
        }
        Err(e) => Err(AppError::msg(e.to_string())),
    }
}

/// `content` checked to be base64 (so a bad value fails here, not on the server).
fn checked_content(content: &str) -> AppResult<&str> {
    let content = content.trim();
    STANDARD.decode(content).map_err(|_| AppError::msg("The content isn't valid base64."))?;
    Ok(content)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    /// Hash of the content now on the server (the next save's base).
    pub hash: String,
}

/// Saves new content (unpublished until `publish`). With `base_hash`, refuses
/// when the latest content on the server isn't the one the editor started from.
pub fn update(host: &str, token: &str, id: &str, content: &str, base_hash: Option<&str>) -> AppResult<Saved> {
    let id = guid(id, "web resource id")?;
    let content = checked_content(content)?;
    let base = format!("https://{}/api/data/v9.2", host);
    if let Some(expected) = base_hash {
        if hash(&latest_content(&base, token, &id)?) != expected {
            return Err(AppError::msg(format!(
                "{} Someone saved this web resource after you opened it.",
                CONFLICT
            )));
        }
    }
    // If-Match: * — update only, never create (PATCH would upsert a missing id).
    send("PATCH", &format!("{}/webresourceset({})", base, id), token, Some(&json!({ "content": content })), &[("If-Match", "*")])?;
    Ok(Saved { hash: hash(content) })
}

/// `PublishXml` parameter for these web resources.
pub fn publish_xml(ids: &[String]) -> String {
    let items: String = ids.iter().map(|id| format!("<webresource>{{{}}}</webresource>", id)).collect();
    format!("<importexportxml><webresources>{}</webresources></importexportxml>", items)
}

/// Publishes web resources (one request for all of them).
pub fn publish(host: &str, token: &str, ids: &[String]) -> AppResult<()> {
    let ids = ids.iter().map(|id| guid(id, "web resource id")).collect::<AppResult<Vec<_>>>()?;
    if ids.is_empty() {
        return Ok(());
    }
    let url = format!("https://{}/api/data/v9.2/PublishXml", host);
    send("POST", &url, token, Some(&json!({ "ParameterXml": publish_xml(&ids) })), &[])?;
    Ok(())
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewWebResource {
    /// Full unique name, prefix included: `contoso_/scripts/account.js`.
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub kind: i64,
    /// Base64, may be empty.
    pub content: String,
    /// Unique name of the solution to add it to; none = only the default solution.
    pub solution: Option<String>,
}

/// Why a web resource name can't be used, if it can't.
pub fn name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("Enter a name.");
    }
    if name.chars().count() > 256 {
        return Some("The name is longer than 256 characters.");
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-')) {
        return Some("Use only letters, numbers, _ . - and /.");
    }
    if name.starts_with('/') || name.ends_with('/') || name.contains("//") || name.contains("..") {
        return Some("Folder names can't be empty, and \"..\" isn't allowed.");
    }
    if !name.contains('_') {
        return Some("Start the name with the publisher prefix and an underscore (contoso_…).");
    }
    None
}

/// Creates a web resource (not published); returns its id.
pub fn create(host: &str, token: &str, new: &NewWebResource) -> AppResult<String> {
    if let Some(problem) = name_problem(&new.name) {
        return Err(AppError::msg(problem));
    }
    if !(1..=12).contains(&new.kind) || new.kind == 8 {
        return Err(AppError::msg("Pick a web resource type."));
    }
    if new.display_name.chars().count() > 200 {
        return Err(AppError::msg("The display name is longer than 200 characters."));
    }
    let solution = new.solution.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = solution {
        if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(AppError::msg(format!("Invalid solution name: {}", s)));
        }
    }
    let display = match new.display_name.trim() {
        "" => new.name.rsplit('/').next().unwrap_or(&new.name),
        d => d,
    };
    let mut body = json!({
        "name": new.name,
        "displayname": display,
        "webresourcetype": new.kind,
        "content": checked_content(&new.content)?,
    });
    if let Some(d) = new.description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        body["description"] = json!(d);
    }
    let url = format!("https://{}/api/data/v9.2/webresourceset?$select=webresourceid", host);
    let mut headers = vec![("Prefer", "return=representation")];
    if let Some(s) = solution {
        headers.push(("MSCRM.SolutionUniqueName", s));
    }
    let created: Value = crate::http::json(send("POST", &url, token, Some(&body), &headers)?)?;
    opt_str(&created, "webresourceid")
        .map(|id| id.to_ascii_lowercase())
        .ok_or_else(|| AppError::msg("The web resource was created but its id didn't come back. Refresh the list."))
}

/// Deletes a web resource (the webview checked what blocks it first).
pub fn delete(host: &str, token: &str, id: &str) -> AppResult<()> {
    let id = guid(id, "web resource id")?;
    send("DELETE", &format!("https://{}/api/data/v9.2/webresourceset({})", host, id), token, None, &[])?;
    Ok(())
}

/// Characters kept as they are in a web resource URL path.
const PATH: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'%').add(b'<').add(b'>').add(b'?').add(b'`').add(b'{').add(b'}');

/// Where the environment serves a (published) web resource.
pub fn url(host: &str, name: &str) -> AppResult<String> {
    let name = name.trim_start_matches('/');
    if name.is_empty() || name.contains("..") || name.contains('\\') || name.chars().any(|c| c.is_control()) {
        return Err(AppError::msg(format!("Invalid web resource name: {}", name)));
    }
    Ok(format!("https://{}/WebResources/{}", host, utf8_percent_encode(name, PATH)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decoded_sizes() {
        assert_eq!(decoded_len(""), 0);
        assert_eq!(decoded_len("YQ=="), 1);
        assert_eq!(decoded_len("YWI="), 2);
        assert_eq!(decoded_len("YWJj"), 3);
        assert_eq!(decoded_len("YWJjZA=="), 4);
        assert_eq!(decoded_len("YWI"), 2, "unpadded");
    }

    #[test]
    fn rows_and_managed_properties() {
        let row = json!({
            "webresourceid": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
            "name": "new_/scripts/account.js",
            "displayname": "Account",
            "description": " ",
            "webresourcetype": 3,
            "ismanaged": false,
            "modifiedon": "2026-09-01T10:00:00Z",
            "_modifiedby_value@OData.Community.Display.V1.FormattedValue": "Dat",
        });
        let r = parse_resource(&row).unwrap();
        assert_eq!(r.id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert_eq!((r.kind, r.description, r.modified_by.as_deref()), (3, None, Some("Dat")));
        assert_eq!(managed_bool(&json!({ "ishidden": { "Value": true } }), "ishidden"), Some(true));
        assert_eq!(managed_bool(&json!({ "x": false }), "x"), Some(false));
        assert_eq!(managed_bool(&json!({}), "x"), None);
    }

    #[test]
    fn microsoft_resources() {
        let sol = |id: &str, publisher: &str| {
            parse_solution(&json!({
                "solutionid": id, "uniquename": id, "friendlyname": id.to_uppercase(), "ismanaged": true, "isvisible": true,
                "publisherid": { "uniquename": publisher, "friendlyname": publisher, "customizationprefix": "x" }
            }))
            .unwrap()
        };
        assert!(parse_solution(&json!({ "solutionid": "d", "uniquename": "Default", "isvisible": true })).is_none());
        let solutions = vec![sol("ms", "MicrosoftCorporation"), sol("mine", "contoso")];
        let res = |id: &str, name: &str, managed: bool| WebResource {
            id: id.into(),
            name: name.into(),
            display_name: String::new(),
            description: None,
            kind: 3,
            managed,
            modified_on: String::new(),
            modified_by: None,
            solutions: vec![],
            microsoft: false,
        };
        let mut items = vec![res("a", "msdyn_/x.js", true), res("b", "new_/y.js", true), res("c", "msdyn_z.js", true), res("d", "msdyn_w.js", false)];
        let comps = vec![("a".to_string(), "ms".to_string()), ("b".to_string(), "ms".to_string()), ("b".to_string(), "mine".to_string())];
        let all = attach_solutions(&mut items, &solutions, &comps);
        assert_eq!(items.iter().map(|i| i.microsoft).collect::<Vec<_>>(), vec![true, false, true, false]);
        assert_eq!(items[1].solutions, vec!["MINE", "MS"]);
        assert_eq!(all.iter().map(|s| (s.unique_name.as_str(), s.count)).collect::<Vec<_>>(), vec![("mine", 1), ("ms", 2)]);
    }

    #[test]
    fn writes_are_checked() {
        assert_eq!(
            publish_xml(&["a".into(), "b".into()]),
            "<importexportxml><webresources><webresource>{a}</webresource><webresource>{b}</webresource></webresources></importexportxml>"
        );
        assert_eq!(name_problem("contoso_/scripts/account.js"), None);
        assert_eq!(name_problem("new_x.js"), None);
        for bad in ["", "noprefix.js", "contoso_/a b.js", "contoso_//a.js", "contoso_/a/", "/contoso_a.js", "contoso_/../a.js"] {
            assert!(name_problem(bad).is_some(), "{}", bad);
        }
        assert!(checked_content("YWJj").is_ok() && checked_content("").is_ok());
        assert!(checked_content("not base64!").is_err());
        assert_eq!(hash(" YWJj\n"), hash("YWJj"));
        assert!(update("h", "t", "not-a-guid", "YWJj", None).is_err());
        assert!(publish("h", "t", &["x".into()]).is_err());
        assert!(publish("h", "t", &[]).is_ok());
    }

    #[test]
    fn resource_urls() {
        assert_eq!(url("org.crm.dynamics.com", "new_/scripts/a b.js").unwrap(), "https://org.crm.dynamics.com/WebResources/new_/scripts/a%20b.js");
        assert!(url("h", "../x").is_err());
        assert!(url("h", "").is_err());
    }
}
