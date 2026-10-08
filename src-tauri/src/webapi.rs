//! The REST builder: sends the read-only (GET) Web API requests the user
//! built, and reads the table metadata the builder needs (entity set, columns
//! with what they're valid for, lookup targets, navigation properties).
//! Building the URL and the code samples happens in the webview
//! (`src/lib/restModel.ts`, `src/lib/restCode.ts`).

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use crate::odata::{is_logical_name, str_field};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 5;

/// Longest request URL Dataverse accepts for a GET.
const MAX_URL: usize = 32_768;

/// Largest response kept for the webview (a page of 5,000 wide rows fits).
const MAX_BODY: u64 = 256 * 1024 * 1024;

fn api_base(host: &str) -> String {
    // Tests point `host` at a local http server.
    if host.starts_with("http://") || host.starts_with("https://") {
        format!("{}/api/data/v9.2/", host)
    } else {
        format!("https://{}/api/data/v9.2/", host)
    }
}

/// What the server answered; HTTP errors come back here too (with their
/// body), so the builder can show them like any response.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub ok: bool,
    /// The full URL sent (percent-encoded).
    pub url: String,
    /// The JSON body; `null` when there was none or it wasn't JSON.
    pub body: Value,
    /// The body as text when it wasn't JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub elapsed_ms: u64,
    /// Response size after decompression.
    pub bytes: usize,
    /// Times the server said "slow down" (429 / 503) before answering.
    pub throttled: u32,
}

/// Characters sent as they are; anything else (spaces, quotes, non-ASCII…)
/// is percent-encoded. `%` stays: the webview already encoded the values
/// that hold `&`, `#`, `+` or `%`.
fn keep(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:@/?%[]".contains(c)
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if keep(c) {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// The URL for `path`: relative to the Web API root (`accounts?$select=name`,
/// `WhoAmI()`), or a full link the server gave (`@odata.nextLink`), which
/// must point at this environment's Web API.
pub fn request_url(host: &str, path: &str) -> AppResult<String> {
    let base = api_base(host);
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::msg("The request has no URL."));
    }
    let rest = if let Some(rest) = path.strip_prefix(&base) {
        rest
    } else if path.contains("://") {
        return Err(AppError::msg("Only this environment's Web API can be called."));
    } else {
        path.trim_start_matches('/')
    };
    if rest.chars().any(|c| c.is_control()) || rest.contains('#') {
        return Err(AppError::msg("The URL has characters that can't be sent."));
    }
    let resource = rest.split('?').next().unwrap_or("");
    if resource.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(AppError::msg("The URL can't leave the Web API (`..`)."));
    }
    let url = format!("{}{}", base, encode(rest));
    if url.len() > MAX_URL {
        return Err(AppError::msg(format!(
            "This request is too long to send ({} characters once encoded; the limit is {}).",
            url.len(),
            MAX_URL
        )));
    }
    Ok(url)
}

/// GETs `path` (see `request_url`). `prefer` is sent as the `Prefer` header.
pub fn get(host: &str, token: &str, path: &str, prefer: Option<&str>) -> AppResult<ApiResponse> {
    let url = request_url(host, path)?;
    let t0 = Instant::now();
    let mut throttled = 0;
    let resp = loop {
        let mut req = ureq::get(&url)
            .set("Authorization", &format!("Bearer {}", token))
            .set("Accept", "application/json")
            .set("Accept-Encoding", crate::http::ACCEPT_ENCODING)
            .set("OData-MaxVersion", "4.0")
            .set("OData-Version", "4.0");
        if let Some(p) = prefer.filter(|p| !p.trim().is_empty()) {
            req = req.set("Prefer", p);
        }
        match req.call() {
            // Service protection limits: wait as long as the server asks.
            Err(ureq::Error::Status(code, ref r)) if (code == 429 || code == 503) && throttled < MAX_RETRIES => {
                let wait = r
                    .header("Retry-After")
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .unwrap_or(5)
                    .clamp(1, 300);
                throttled += 1;
                std::thread::sleep(Duration::from_secs(wait));
            }
            other => break other,
        }
    };
    let r = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(AppError::msg(e.to_string())),
    };
    let status = r.status();
    let (text, sizes) = crate::http::read_body(r, |reader| {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(reader, MAX_BODY), &mut s)?;
        Ok(s)
    })
    .map_err(|e| AppError::msg(format!("Reading the response failed: {}", e)))?;
    let (body, text) = if text.trim().is_empty() {
        (Value::Null, None)
    } else {
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => (v, None),
            Err(_) => (Value::Null, Some(text)),
        }
    };
    Ok(ApiResponse {
        status,
        ok: (200..300).contains(&status),
        url,
        body,
        text,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        bytes: sizes.decoded,
        throttled,
    })
}

// ---- table metadata for the builder ----

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestColumn {
    pub logical_name: String,
    pub display_name: String,
    pub attribute_type: String,
    /// `AttributeTypeName` (e.g. `MultiSelectPicklistType`, `FileType`).
    pub type_name: String,
    /// Set on columns that belong to another one (`owneridname` → `ownerid`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribute_of: Option<String>,
    pub readable: bool,
    pub creatable: bool,
    pub updatable: bool,
    /// Tables a lookup can point at.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NavProperty {
    /// The name used in `$expand` and `@odata.bind`.
    pub name: String,
    /// `single` (this table's lookup, N:1) or `collection` (1:N, N:N).
    pub kind: &'static str,
    /// `manyToOne`, `oneToMany` or `manyToMany`.
    pub relationship: &'static str,
    pub schema_name: String,
    /// The table on the other side.
    pub table: String,
    /// N:1: this table's lookup column; 1:N: the other table's lookup column.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestTable {
    pub logical_name: String,
    pub display_name: String,
    pub collection_display_name: String,
    pub entity_set: String,
    pub primary_id: String,
    pub primary_name: Option<String>,
    pub columns: Vec<RestColumn>,
    pub navigation: Vec<NavProperty>,
}

fn label(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|l| l.get("UserLocalizedLabel"))
        .and_then(|l| l.get("Label"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

fn rows(v: &Value) -> Vec<Value> {
    v.get("value").and_then(|a| a.as_array()).cloned().unwrap_or_default()
}

fn columns_from(attributes: &Value, lookups: &Value) -> Vec<RestColumn> {
    let mut targets = std::collections::HashMap::new();
    for r in rows(lookups) {
        let list: Vec<String> = r
            .get("Targets")
            .and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        targets.insert(str_field(&r, "LogicalName"), list);
    }
    let flag = |r: &Value, key: &str| r.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    let mut out: Vec<RestColumn> = rows(attributes)
        .iter()
        .map(|r| {
            let logical_name = str_field(r, "LogicalName");
            RestColumn {
                display_name: label(r, "DisplayName"),
                attribute_type: str_field(r, "AttributeType"),
                type_name: r
                    .get("AttributeTypeName")
                    .and_then(|t| t.get("Value"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
                attribute_of: r.get("AttributeOf").and_then(|s| s.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
                readable: flag(r, "IsValidForRead"),
                creatable: flag(r, "IsValidForCreate"),
                updatable: flag(r, "IsValidForUpdate"),
                targets: targets.remove(&logical_name).unwrap_or_default(),
                logical_name,
            }
        })
        .filter(|c| !c.logical_name.is_empty())
        .collect();
    out.sort_by(|a, b| a.logical_name.cmp(&b.logical_name));
    out
}

fn navigation_from(table: &str, n1: &Value, one_n: &Value, nn: &Value) -> Vec<NavProperty> {
    let mut out = Vec::new();
    for r in rows(n1) {
        out.push(NavProperty {
            name: str_field(&r, "ReferencingEntityNavigationPropertyName"),
            kind: "single",
            relationship: "manyToOne",
            schema_name: str_field(&r, "SchemaName"),
            table: str_field(&r, "ReferencedEntity"),
            column: Some(str_field(&r, "ReferencingAttribute")),
        });
    }
    for r in rows(one_n) {
        out.push(NavProperty {
            name: str_field(&r, "ReferencedEntityNavigationPropertyName"),
            kind: "collection",
            relationship: "oneToMany",
            schema_name: str_field(&r, "SchemaName"),
            table: str_field(&r, "ReferencingEntity"),
            column: Some(str_field(&r, "ReferencingAttribute")),
        });
    }
    for r in rows(nn) {
        let (e1, e2) = (str_field(&r, "Entity1LogicalName"), str_field(&r, "Entity2LogicalName"));
        // A table related to itself has the relationship from both sides.
        if e1 == table {
            out.push(NavProperty {
                name: str_field(&r, "Entity1NavigationPropertyName"),
                kind: "collection",
                relationship: "manyToMany",
                schema_name: str_field(&r, "SchemaName"),
                table: e2.clone(),
                column: None,
            });
        }
        if e2 == table {
            out.push(NavProperty {
                name: str_field(&r, "Entity2NavigationPropertyName"),
                kind: "collection",
                relationship: "manyToMany",
                schema_name: str_field(&r, "SchemaName"),
                table: e1,
                column: None,
            });
        }
    }
    out.retain(|n| !n.name.is_empty() && !n.table.is_empty());
    out.sort_by(|a, b| (a.kind != "single", &a.name).cmp(&(b.kind != "single", &b.name)));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

/// Everything the builder needs about `table`, read with 6 requests at once.
pub fn table(host: &str, token: &str, table: &str) -> AppResult<RestTable> {
    let table = table.trim().to_ascii_lowercase();
    if !is_logical_name(&table) {
        return Err(AppError::msg(format!("Invalid table name: {}", table)));
    }
    let base = format!("https://{}/api/data/v9.2/EntityDefinitions(LogicalName='{}')", host, table);
    let urls = [
        format!("{}?$select=LogicalName,DisplayName,DisplayCollectionName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute", base),
        format!(
            "{}/Attributes?$select=LogicalName,DisplayName,AttributeType,AttributeTypeName,AttributeOf,IsValidForRead,IsValidForCreate,IsValidForUpdate",
            base
        ),
        format!("{}/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets", base),
        format!("{}/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingAttribute,ReferencingEntityNavigationPropertyName", base),
        format!("{}/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedEntityNavigationPropertyName", base),
        format!(
            "{}/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,Entity1NavigationPropertyName,Entity2NavigationPropertyName",
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
    let (attributes, lookups) = (next()?, next()?);
    let (n1, one_n, nn) = (next()?, next()?, next()?);
    let entity_set = str_field(&entity, "EntitySetName");
    if entity_set.is_empty() {
        return Err(AppError::msg(format!("Table `{}` can't be used with the Web API (it has no entity set).", table)));
    }
    Ok(RestTable {
        display_name: label(&entity, "DisplayName"),
        collection_display_name: label(&entity, "DisplayCollectionName"),
        entity_set,
        primary_id: str_field(&entity, "PrimaryIdAttribute"),
        primary_name: Some(str_field(&entity, "PrimaryNameAttribute")).filter(|s| !s.is_empty()),
        columns: columns_from(&attributes, &lookups),
        navigation: navigation_from(&table, &n1, &one_n, &nn),
        logical_name: table,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn urls_stay_on_the_web_api_and_get_encoded() {
        let host = "org.crm.dynamics.com";
        assert_eq!(
            request_url(host, "accounts?$select=name&$filter=name eq 'A b'").unwrap(),
            "https://org.crm.dynamics.com/api/data/v9.2/accounts?$select=name&$filter=name%20eq%20'A%20b'"
        );
        assert_eq!(request_url(host, "/WhoAmI()").unwrap(), "https://org.crm.dynamics.com/api/data/v9.2/WhoAmI()");
        // Values the webview encoded stay as they are; non-ASCII gets encoded.
        assert_eq!(
            request_url(host, "accounts?$filter=name eq 'R%26D Ä'").unwrap(),
            "https://org.crm.dynamics.com/api/data/v9.2/accounts?$filter=name%20eq%20'R%26D%20%C3%84'"
        );
        let next = "https://org.crm.dynamics.com/api/data/v9.2/accounts?$skiptoken=%3Ccookie%20pagenumber=%222%22%20/%3E";
        assert_eq!(request_url(host, next).unwrap(), next);
        assert!(request_url(host, "https://evil.example.com/api/data/v9.2/accounts").is_err());
        assert!(request_url(host, "../../_api/x").is_err());
        assert!(request_url(host, "accounts#x").is_err());
        assert!(request_url(host, "  ").is_err());
    }

    #[test]
    fn errors_come_back_as_responses() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let host = format!("http://{}", server.server_addr());
        let seen = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            let prefer = req.headers().iter().find(|h| h.field.equiv("Prefer")).map(|h| h.value.to_string());
            let url = req.url().to_string();
            let body = r#"{"error":{"code":"0x80060888","message":"Resource not found for the segment 'acounts'."}}"#;
            req.respond(tiny_http::Response::from_string(body).with_status_code(404)).unwrap();
            (url, prefer)
        });
        let r = get(&host, "t", "acounts?$top=1", Some("odata.maxpagesize=10")).unwrap();
        let (url, prefer) = seen.join().unwrap();
        assert_eq!(url, "/api/data/v9.2/acounts?$top=1");
        assert_eq!(prefer.as_deref(), Some("odata.maxpagesize=10"));
        assert_eq!(r.status, 404);
        assert!(!r.ok);
        assert_eq!(r.body["error"]["message"], "Resource not found for the segment 'acounts'.");
    }

    #[test]
    fn navigation_properties_from_every_relationship() {
        let n1 = json!({"value":[{"SchemaName":"account_primary_contact","ReferencedEntity":"contact","ReferencingAttribute":"primarycontactid","ReferencingEntityNavigationPropertyName":"primarycontactid"}]});
        let one_n = json!({"value":[{"SchemaName":"contact_customer_accounts","ReferencingEntity":"contact","ReferencingAttribute":"parentcustomerid","ReferencedEntityNavigationPropertyName":"contact_customer_accounts"}]});
        let nn = json!({"value":[
            {"SchemaName":"accountleads_association","Entity1LogicalName":"account","Entity2LogicalName":"lead","Entity1NavigationPropertyName":"accountleads_association","Entity2NavigationPropertyName":"accountleads_association"},
            {"SchemaName":"self","Entity1LogicalName":"account","Entity2LogicalName":"account","Entity1NavigationPropertyName":"self_referencing","Entity2NavigationPropertyName":"self_referenced"}
        ]});
        let nav = navigation_from("account", &n1, &one_n, &nn);
        let names: Vec<(&str, &str, &str)> = nav.iter().map(|n| (n.name.as_str(), n.kind, n.table.as_str())).collect();
        assert_eq!(
            names,
            vec![
                ("primarycontactid", "single", "contact"),
                ("accountleads_association", "collection", "lead"),
                ("contact_customer_accounts", "collection", "contact"),
                ("self_referenced", "collection", "account"),
                ("self_referencing", "collection", "account"),
            ]
        );
        assert_eq!(nav[0].column.as_deref(), Some("primarycontactid"));
    }

    #[test]
    fn columns_carry_lookup_targets_and_what_they_are_valid_for() {
        let attrs = json!({"value":[
            {"LogicalName":"parentcustomerid","AttributeType":"Customer","AttributeTypeName":{"Value":"CustomerType"},"IsValidForRead":true,"IsValidForCreate":true,"IsValidForUpdate":true,"DisplayName":{"UserLocalizedLabel":{"Label":"Company Name"}}},
            {"LogicalName":"parentcustomeridname","AttributeType":"String","AttributeOf":"parentcustomerid","IsValidForRead":true}
        ]});
        let lookups = json!({"value":[{"LogicalName":"parentcustomerid","Targets":["account","contact"]}]});
        let cols = columns_from(&attrs, &lookups);
        assert_eq!(cols[0].targets, vec!["account", "contact"]);
        assert_eq!(cols[0].type_name, "CustomerType");
        assert_eq!(cols[0].display_name, "Company Name");
        assert!(cols[0].creatable);
        assert_eq!(cols[1].attribute_of.as_deref(), Some("parentcustomerid"));
        assert!(!cols[1].creatable);
    }
}
