//! The FetchXML tool: runs one page of a FetchXML query the user wrote,
//! through the Web API, and hands the records back as JSON. Parsing the XML,
//! paging attributes and turning records into grid rows happen in the
//! webview (`src/lib/fetchXml.ts`).

use crate::error::{AppError, AppResult};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 5;

/// Formatted values (choice labels, lookup names), lookup table names, alias
/// sources, the paging cookie and `morerecords`.
const PREFER: &str = "odata.include-annotations=\"*\"";

const MORE_RECORDS: &str = "@Microsoft.Dynamics.CRM.morerecords";
const PAGING_COOKIE: &str = "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie";

/// Longest request URL Dataverse accepts for a GET.
const MAX_URL: usize = 32_768;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchPage {
    /// The rows as the Web API returned them, annotations included.
    pub records: Vec<Value>,
    pub more_records: bool,
    /// For the next page's `paging-cookie` attribute, already URL-decoded
    /// twice (not XML-escaped: the webview sets it as a DOM attribute).
    pub paging_cookie: Option<String>,
    pub elapsed_ms: u64,
    /// Response size after decompression.
    pub bytes: usize,
    /// Times the server said "slow down" (429 / 503) before answering.
    pub throttled: u32,
}

fn api_base(host: &str) -> String {
    // Tests point `host` at a local http server.
    if host.starts_with("http://") || host.starts_with("https://") {
        format!("{}/api/data/v9.2", host)
    } else {
        format!("https://{}/api/data/v9.2", host)
    }
}

/// The `pagingcookie` attribute of a `fetchxmlpagingcookie` annotation,
/// which arrives URL-encoded twice.
fn decode_cookie(raw: &str) -> Option<String> {
    let start = raw.find("pagingcookie=\"")? + "pagingcookie=\"".len();
    let end = raw[start..].find('"')? + start;
    let once = percent_decode_str(&raw[start..end]).decode_utf8_lossy().to_string();
    let twice = percent_decode_str(&once).decode_utf8_lossy().to_string();
    Some(twice).filter(|c| !c.is_empty())
}

/// Runs `fetch` (one page) against the `entity_set` collection.
pub fn run(host: &str, token: &str, entity_set: &str, fetch: &str) -> AppResult<FetchPage> {
    let url = format!(
        "{}/{}?fetchXml={}",
        api_base(host),
        entity_set,
        utf8_percent_encode(fetch, NON_ALPHANUMERIC)
    );
    if url.len() > MAX_URL {
        return Err(AppError::msg(format!(
            "This FetchXML is too long to send ({} characters once encoded; the limit is {}). Remove some conditions or values.",
            url.len(),
            MAX_URL
        )));
    }
    let t0 = Instant::now();
    let mut throttled = 0;
    let resp = loop {
        let resp = ureq::get(&url)
            .set("Authorization", &format!("Bearer {}", token))
            .set("Accept", "application/json")
            .set("Accept-Encoding", crate::http::ACCEPT_ENCODING)
            .set("OData-MaxVersion", "4.0")
            .set("OData-Version", "4.0")
            .set("Prefer", PREFER)
            .call();
        match resp {
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
        Err(ureq::Error::Status(code, r)) => {
            let text = crate::http::text(r);
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.pointer("/error/message")?.as_str().map(|s| s.to_string()))
                .unwrap_or(text);
            return Err(AppError::msg(format!("FetchXML request failed ({}): {}", code, msg)));
        }
        Err(e) => return Err(AppError::msg(e.to_string())),
    };
    let (mut body, sizes): (Value, _) = crate::http::json_sized(r)
        .map_err(|e| AppError::msg(format!("Reading the FetchXML response failed: {}", e)))?;

    let more_records = body.get(MORE_RECORDS).and_then(|v| v.as_bool()).unwrap_or(false);
    let paging_cookie = body.get(PAGING_COOKIE).and_then(|v| v.as_str()).and_then(decode_cookie);
    let records = match body.get_mut("value").map(Value::take) {
        Some(Value::Array(rows)) => rows,
        _ => return Err(AppError::msg("The FetchXML response had no rows (`value`).")),
    };
    Ok(FetchPage {
        records,
        more_records,
        paging_cookie,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        bytes: sizes.decoded,
        throttled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paging_cookie_is_decoded_twice() {
        let raw = r#"<cookie pagenumber="2" pagingcookie="%253ccookie%2520page%253d%25221%2522%253e%253caccountid%2520last%253d%2522%257bA%257d%2522%2520%252f%253e%253c%252fcookie%253e" istracking="False" />"#;
        assert_eq!(
            decode_cookie(raw).as_deref(),
            Some(r#"<cookie page="1"><accountid last="{A}" /></cookie>"#)
        );
        assert_eq!(decode_cookie(r#"<cookie pagenumber="2" istracking="False" />"#), None);
    }

    #[test]
    fn one_page_comes_back_with_its_paging_state() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let host = format!("http://{}", server.server_addr());
        let seen = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            let url = percent_decode_str(req.url()).decode_utf8_lossy().to_string();
            let prefer = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("Prefer"))
                .map(|h| h.value.to_string());
            let body = r#"{"value":[{"name":"a","_ownerid_value":"x","_ownerid_value@OData.Community.Display.V1.FormattedValue":"Ann"}],
                "@Microsoft.Dynamics.CRM.morerecords":true,
                "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie":"<cookie pagenumber=\"2\" pagingcookie=\"%253ccookie%2520page%253d%25221%2522%253e%253c%252fcookie%253e\" istracking=\"False\" />"}"#;
            req.respond(tiny_http::Response::from_string(body)).unwrap();
            (url, prefer)
        });
        let fetch = r#"<fetch><entity name="account"><attribute name="name" /></entity></fetch>"#;
        let page = run(&host, "t", "accounts", fetch).unwrap();
        let (url, prefer) = seen.join().unwrap();
        assert!(url.starts_with("/api/data/v9.2/accounts?fetchXml=<fetch>"), "{}", url);
        assert!(url.ends_with(fetch), "{}", url);
        assert_eq!(prefer.as_deref(), Some(PREFER));
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.records[0]["name"], "a");
        assert!(page.more_records);
        assert_eq!(page.paging_cookie.as_deref(), Some(r#"<cookie page="1"></cookie>"#));
    }

    #[test]
    fn web_api_errors_keep_their_message() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let host = format!("http://{}", server.server_addr());
        std::thread::spawn(move || {
            let req = server.recv().unwrap();
            let body = r#"{"error":{"code":"0x80041103","message":"'account' entity doesn't contain attribute with Name = 'nope'."}}"#;
            req.respond(tiny_http::Response::from_string(body).with_status_code(400)).unwrap();
        });
        let err = run(&host, "t", "accounts", "<fetch/>").err().unwrap().to_string();
        assert_eq!(
            err,
            "FetchXML request failed (400): 'account' entity doesn't contain attribute with Name = 'nope'."
        );
    }
}
