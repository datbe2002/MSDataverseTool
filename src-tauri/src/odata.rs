//! Small helpers for building and reading Dataverse Web API (OData) requests.

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use serde_json::Value;

pub const FORMATTED: &str = "@OData.Community.Display.V1.FormattedValue";
pub const LOOKUP_TABLE: &str = "@Microsoft.Dynamics.CRM.lookuplogicalname";
/// Labels, lookup tables and every page at the largest size.
pub const PREFER_ALL: &str = "odata.include-annotations=\"*\",odata.maxpagesize=5000";

pub fn is_guid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// `s` as a lowercase GUID, or an "Invalid <what>" error.
pub fn guid(s: &str, what: &str) -> AppResult<String> {
    if is_guid(s) {
        Ok(s.to_ascii_lowercase())
    } else {
        Err(AppError::msg(format!("Invalid {}: {}", what, s)))
    }
}

pub fn is_logical_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `s` lowercased as a table / column logical name, or an "Invalid <what>" error.
pub fn logical_name(s: &str, what: &str) -> AppResult<String> {
    let s = s.trim().to_ascii_lowercase();
    if is_logical_name(&s) {
        Ok(s)
    } else {
        Err(AppError::msg(format!("Invalid {}: {}", what, s)))
    }
}

/// An OData string literal: single quotes doubled.
pub fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Every row of a collection query, following `@odata.nextLink`.
pub fn get_all(first_url: String, token: &str, prefer: &str) -> AppResult<Vec<Value>> {
    let mut rows = Vec::new();
    let mut next = Some(first_url);
    while let Some(url) = next.take() {
        let mut body = get_json(&url, token, Some(prefer))?;
        if let Some(Value::Array(page)) = body.get_mut("value").map(Value::take) {
            rows.extend(page);
        }
        next = body.get("@odata.nextLink").and_then(|v| v.as_str()).map(|s| s.to_string());
    }
    Ok(rows)
}

pub fn str_field(row: &Value, key: &str) -> String {
    row.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

pub fn opt_str(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string())
}

/// The formatted value (label, lookup name) of `key`, if any.
pub fn formatted(row: &Value, key: &str) -> Option<String> {
    opt_str(row, &format!("{}{}", key, FORMATTED))
}

pub fn int(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(|v| v.as_i64())
}

pub fn bool_field(row: &Value, key: &str) -> bool {
    row.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// "a,b , c" → ["a", "b", "c"] (lowercase, no blanks).
pub fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_ascii_lowercase()).filter(|x| !x.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_ids_and_literals() {
        assert!(is_guid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        assert!(!is_guid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeg"));
        assert!(!is_guid("aaaaaaaabbbb-cccc-dddd-eeee-eeeeeeeeeee"));
        assert_eq!(guid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "id").unwrap(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert_eq!(logical_name(" Account ", "table").unwrap(), "account");
        assert!(logical_name("account'", "table").is_err());
        assert_eq!(literal("it's"), "'it''s'");
        assert_eq!(split_list("Name, statuscode ,,"), vec!["name", "statuscode"]);
    }
}
