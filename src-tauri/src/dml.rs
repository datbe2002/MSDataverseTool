//! INSERT / UPDATE / DELETE support.
//!
//! The Dataverse TDS endpoint is read-only, so write statements are translated
//! the same way SQL 4 CDS does it:
//!   1. a SELECT over TDS finds the affected rows and evaluates the new values
//!   2. every row becomes one Web API request (PATCH / DELETE / POST)
//! `prepare` and `execute` are separate steps so the UI can show how many
//! records will change and ask for confirmation first.

use crate::error::{AppError, AppResult};
use crate::{metadata, sql};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Refuse statements that would touch more rows than this in one go.
const MAX_ROWS: usize = 100_000;
/// Hard ceiling on parallel Web API requests (Dataverse allows 52 concurrent
/// requests per user, and no environment recommends anywhere near that).
pub const MAX_WORKERS: usize = 32;
/// Workers to grow to when the server sends no `x-ms-dop-hint`.
const FALLBACK_WORKERS: usize = 8;
/// Give up on a request that keeps getting throttled.
const MAX_THROTTLE_RETRIES: u32 = 20;

// ---------------------------------------------------------------------------
// Plan / result types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DmlKind {
    Update,
    Delete,
    Insert,
}

impl DmlKind {
    fn as_str(self) -> &'static str {
        match self {
            DmlKind::Update => "update",
            DmlKind::Delete => "delete",
            DmlKind::Insert => "insert",
        }
    }
}

enum Op {
    Update { id: String, body: Value },
    Delete { id: String },
    Create { body: Value },
}

impl Op {
    fn describe(&self) -> String {
        match self {
            Op::Update { id, .. } | Op::Delete { id } => id.clone(),
            Op::Create { .. } => "new record".to_string(),
        }
    }
}

pub struct DmlPlan {
    kind: DmlKind,
    host: String,
    table: String,
    entity_set: String,
    columns: Vec<String>,
    ops: Vec<Op>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmlPreview {
    pub plan_id: String,
    pub kind: &'static str,
    pub table: String,
    pub count: usize,
    pub columns: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmlResult {
    pub kind: &'static str,
    pub table: String,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    pub elapsed_ms: u64,
    /// Most workers that ran at the same time.
    pub max_threads: usize,
    /// How many times the server asked us to slow down (429 / 503).
    pub throttled: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmlProgress {
    pub done: usize,
    pub total: usize,
    /// Workers currently alive.
    pub threads: usize,
    /// Workers sleeping until the server's `Retry-After` passes.
    pub paused: usize,
}

impl DmlPlan {
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn preview(&self, plan_id: String) -> DmlPreview {
        DmlPreview {
            plan_id,
            kind: self.kind.as_str(),
            table: self.table.clone(),
            count: self.ops.len(),
            columns: self.columns.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct UpdateStmt {
    target: String,
    assignments: Vec<(String, String)>,
    from: Option<String>,
    where_clause: Option<String>,
}

#[derive(Debug, PartialEq)]
struct DeleteStmt {
    target: String,
    from: Option<String>,
    where_clause: Option<String>,
}

#[derive(Debug, PartialEq)]
enum InsertSource {
    Values(Vec<Vec<String>>),
    Select(String),
}

#[derive(Debug, PartialEq)]
struct InsertStmt {
    table: String,
    columns: Vec<String>,
    source: InsertSource,
}

#[derive(Debug, PartialEq)]
enum Statement {
    Update(UpdateStmt),
    Delete(DeleteStmt),
    Insert(InsertStmt),
}

/// Strips leading comments and trailing semicolons.
fn trim_sql(sql: &str) -> &str {
    let mut s = sql;
    loop {
        s = s.trim_start();
        if s.starts_with("--") {
            s = s.find('\n').map_or("", |i| &s[i + 1..]);
        } else if s.starts_with("/*") {
            s = s.find("*/").map_or("", |i| &s[i + 2..]);
        } else {
            break;
        }
    }
    s.trim_end().trim_end_matches(';').trim_end()
}

fn first_word(s: &str) -> &str {
    let t = s.trim_start();
    let end = t
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(t.len());
    &t[..end]
}

fn skip_ws(s: &str, mut i: usize) -> usize {
    let b = s.as_bytes();
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// `true` for each byte that is plain SQL at parenthesis depth 0 — i.e. not
/// inside a string, [bracketed] or "quoted" identifier, comment or sub-expression.
fn top_level_mask(s: &str) -> Vec<bool> {
    let b = s.as_bytes();
    let n = b.len();
    let mut mask = vec![false; n];
    let mut depth = 0i32;
    let mut i = 0;
    while i < n {
        match b[i] {
            b'\'' => {
                i += 1;
                while i < n {
                    if b[i] == b'\'' {
                        if i + 1 < n && b[i + 1] == b'\'' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
            }
            b'[' => {
                while i < n && b[i] != b']' {
                    i += 1;
                }
            }
            b'"' => {
                i += 1;
                while i < n && b[i] != b'"' {
                    i += 1;
                }
            }
            b'-' if i + 1 < n && b[i + 1] == b'-' => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 1;
            }
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => mask[i] = depth == 0,
        }
        i += 1;
    }
    mask
}

fn is_word_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'@' | b'#' | b'$' | b'.') || c >= 0x80
}

/// Finds a top-level keyword (whole word, case-insensitive) at or after `from`.
fn find_kw(s: &str, mask: &[bool], kw: &str, from: usize) -> Option<usize> {
    let b = s.as_bytes();
    let k = kw.len();
    if b.len() < k {
        return None;
    }
    (from..=b.len() - k).find(|&i| {
        mask[i..i + k].iter().all(|m| *m)
            && b[i..i + k].eq_ignore_ascii_case(kw.as_bytes())
            && (i == 0 || !is_word_byte(b[i - 1]))
            && (i + k == b.len() || !is_word_byte(b[i + k]))
    })
}

/// Splits `s[start..end]` on top-level commas.
fn split_top(s: &str, mask: &[bool], start: usize, end: usize) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut parts = Vec::new();
    let mut from = start;
    for i in start..end {
        if mask[i] && b[i] == b',' {
            parts.push((from, i));
            from = i + 1;
        }
    }
    parts.push((from, end));
    parts
}

fn split_list(text: &str) -> Vec<&str> {
    let mask = top_level_mask(text);
    split_top(text, &mask, 0, text.len())
        .into_iter()
        .map(|(a, b)| text[a..b].trim())
        .collect()
}

fn matching_paren(s: &str, open: usize) -> AppResult<usize> {
    let b = s.as_bytes();
    let mut depth = 0i32;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'\'' => {
                i += 1;
                while i < b.len() {
                    if b[i] == b'\'' {
                        if i + 1 < b.len() && b[i + 1] == b'\'' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
            }
            b'[' => {
                while i < b.len() && b[i] != b']' {
                    i += 1;
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(AppError::msg("Unbalanced parentheses."))
}

fn ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let part = r#"(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_][\w@#$]*)"#;
        Regex::new(&format!(r"^{p}(?:\s*\.\s*{p})*$", p = part)).unwrap()
    })
}

/// `[dbo].[Contact]` / `c.firstname` -> `contact` / `firstname`
fn last_part(t: &str) -> String {
    let mut parts = vec![String::new()];
    let (mut bracket, mut quote) = (false, false);
    for c in t.chars() {
        match c {
            '[' if !quote => bracket = true,
            ']' if !quote => bracket = false,
            '"' if !bracket => quote = !quote,
            '.' if !bracket && !quote => {
                parts.push(String::new());
                continue;
            }
            _ => {}
        }
        parts.last_mut().unwrap().push(c);
    }
    parts
        .pop()
        .unwrap_or_default()
        .trim()
        .trim_matches(|c: char| c == '[' || c == ']' || c == '"')
        .to_ascii_lowercase()
}

fn single_ident(text: &str) -> AppResult<String> {
    let t = text.trim();
    if !ident_re().is_match(t) {
        return Err(AppError::msg(format!(
            "Expected a table or column name but found `{}`.",
            t
        )));
    }
    Ok(last_part(t))
}

fn parse(sql_text: &str) -> AppResult<Statement> {
    let s = trim_sql(sql_text);
    let mask = top_level_mask(s);
    if s.bytes().zip(&mask).any(|(c, top)| c == b';' && *top) {
        return Err(AppError::msg(
            "Run one INSERT / UPDATE / DELETE statement at a time.",
        ));
    }
    match first_word(s).to_ascii_lowercase().as_str() {
        "update" => parse_update(s, &mask).map(Statement::Update),
        "delete" => parse_delete(s, &mask).map(Statement::Delete),
        "insert" => parse_insert(s).map(Statement::Insert),
        _ => Err(AppError::msg(
            "Only INSERT, UPDATE and DELETE statements can modify data.",
        )),
    }
}

fn parse_update(s: &str, mask: &[bool]) -> AppResult<UpdateStmt> {
    let after = "update".len();
    let set_pos =
        find_kw(s, mask, "set", after).ok_or_else(|| AppError::msg("UPDATE is missing SET."))?;
    let target_text = &s[after..set_pos];
    if first_word(target_text).eq_ignore_ascii_case("top") {
        return Err(AppError::msg(
            "UPDATE TOP (n) is not supported — narrow the rows with WHERE instead.",
        ));
    }
    let target = single_ident(target_text)?;

    let body = set_pos + 3;
    let from_pos = find_kw(s, mask, "from", body);
    let where_pos = find_kw(s, mask, "where", body);
    let set_end = from_pos.into_iter().chain(where_pos).min().unwrap_or(s.len());

    let assignments = split_top(s, mask, body, set_end)
        .into_iter()
        .map(|(a, b)| parse_assignment(s, mask, a, b))
        .collect::<AppResult<Vec<_>>>()?;

    let from = from_pos.map(|p| {
        let end = where_pos.filter(|w| *w > p).unwrap_or(s.len());
        s[p + 4..end].trim().to_string()
    });
    let where_clause = where_pos.map(|p| s[p + 5..].trim().to_string());
    Ok(UpdateStmt {
        target,
        assignments,
        from,
        where_clause,
    })
}

/// `col = expr`, or compound `col += expr` which becomes `col + (expr)`.
fn parse_assignment(s: &str, mask: &[bool], a: usize, b: usize) -> AppResult<(String, String)> {
    let bytes = s.as_bytes();
    let invalid = || AppError::msg(format!("Invalid SET assignment: `{}`", s[a..b].trim()));
    let eq = (a..b)
        .find(|&i| mask[i] && bytes[i] == b'=')
        .ok_or_else(invalid)?;

    let compound = eq > a && mask[eq - 1] && b"+-*/%&|^".contains(&bytes[eq - 1]);
    let left_end = if compound { eq - 1 } else { eq };
    let column = single_ident(&s[a..left_end])?;
    let expr = s[eq + 1..b].trim();
    if expr.is_empty() {
        return Err(invalid());
    }
    let expr = if compound {
        format!("{} {} ({})", column, bytes[eq - 1] as char, expr)
    } else {
        expr.to_string()
    };
    Ok((column, expr))
}

fn parse_delete(s: &str, mask: &[bool]) -> AppResult<DeleteStmt> {
    let mut pos = skip_ws(s, "delete".len());
    if first_word(&s[pos..]).eq_ignore_ascii_case("top") {
        return Err(AppError::msg(
            "DELETE TOP (n) is not supported — narrow the rows with WHERE instead.",
        ));
    }
    if first_word(&s[pos..]).eq_ignore_ascii_case("from") {
        pos += 4;
    }
    let from_pos = find_kw(s, mask, "from", pos);
    let where_pos = find_kw(s, mask, "where", pos);
    let target_end = from_pos.into_iter().chain(where_pos).min().unwrap_or(s.len());
    let target = single_ident(&s[pos..target_end])?;

    let from = from_pos.map(|p| {
        let end = where_pos.filter(|w| *w > p).unwrap_or(s.len());
        s[p + 4..end].trim().to_string()
    });
    let where_clause = where_pos.map(|p| s[p + 5..].trim().to_string());
    Ok(DeleteStmt {
        target,
        from,
        where_clause,
    })
}

fn parse_insert(s: &str) -> AppResult<InsertStmt> {
    const COLUMN_LIST_HINT: &str = "INSERT needs a column list, e.g. INSERT INTO contact (firstname, lastname) VALUES ('Ann', 'Lee').";
    let b = s.as_bytes();
    let mut pos = skip_ws(s, "insert".len());
    if first_word(&s[pos..]).eq_ignore_ascii_case("into") {
        pos = skip_ws(s, pos + 4);
    }
    let open = (pos..b.len())
        .find(|&i| b[i] == b'(')
        .ok_or_else(|| AppError::msg(COLUMN_LIST_HINT))?;
    let table_text = s[pos..open].trim();
    if table_text.split_whitespace().count() != 1 {
        return Err(AppError::msg(COLUMN_LIST_HINT));
    }
    let table = single_ident(table_text)?;

    let close = matching_paren(s, open)?;
    let columns = split_list(&s[open + 1..close])
        .into_iter()
        .map(single_ident)
        .collect::<AppResult<Vec<_>>>()?;

    let rest = s[close + 1..].trim_start();
    let source = match first_word(rest).to_ascii_lowercase().as_str() {
        "values" => InsertSource::Values(parse_values(&rest[6..])?),
        "select" | "with" => InsertSource::Select(rest.to_string()),
        _ => {
            return Err(AppError::msg(
                "Expected VALUES (...) or SELECT ... after the INSERT column list.",
            ))
        }
    };
    Ok(InsertStmt {
        table,
        columns,
        source,
    })
}

fn parse_values(text: &str) -> AppResult<Vec<Vec<String>>> {
    let b = text.as_bytes();
    let mut rows = Vec::new();
    let mut i = skip_ws(text, 0);
    while i < b.len() {
        if b[i] != b'(' {
            return Err(AppError::msg("Expected ( ... ) in VALUES."));
        }
        let close = matching_paren(text, i)?;
        rows.push(
            split_list(&text[i + 1..close])
                .into_iter()
                .map(|v| v.to_string())
                .collect(),
        );
        i = skip_ws(text, close + 1);
        if i < b.len() {
            if b[i] != b',' {
                return Err(AppError::msg("Unexpected text after a VALUES row."));
            }
            i = skip_ws(text, i + 1);
        }
    }
    if rows.is_empty() {
        return Err(AppError::msg("VALUES has no rows."));
    }
    Ok(rows)
}

/// Literal values allowed in `INSERT ... VALUES`.
fn parse_literal(text: &str) -> AppResult<Value> {
    let t = text.trim();
    match t.to_ascii_lowercase().as_str() {
        "null" => return Ok(Value::Null),
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        _ => {}
    }
    let body = if t.len() > 1 && (t.starts_with("N'") || t.starts_with("n'")) {
        &t[1..]
    } else {
        t
    };
    if body.len() >= 2 && body.starts_with('\'') && body.ends_with('\'') {
        let inner = &body[1..body.len() - 1];
        // A lone quote inside means this is an expression like 'a' + 'b'.
        if !inner.replace("''", "").contains('\'') {
            return Ok(Value::String(inner.replace("''", "'")));
        }
    }
    if let Ok(i) = t.parse::<i64>() {
        return Ok(Value::from(i));
    }
    if let Some(n) = t.parse::<f64>().ok().and_then(serde_json::Number::from_f64) {
        return Ok(Value::Number(n));
    }
    Err(AppError::msg(format!(
        "Unsupported value `{}` in VALUES — use literals (text, numbers, NULL), or INSERT ... SELECT for expressions.",
        t
    )))
}

const NOT_ALIAS: &[&str] = &[
    "where", "join", "inner", "left", "right", "full", "outer", "cross", "on", "order", "group",
    "having", "union", "with", "as", "select", "set", "values", "option", "for",
];

/// (table, alias) pairs from a FROM clause.
fn table_refs(from_clause: &str) -> Vec<(String, Option<String>)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?i)\b(?:from|join)\s+((?:\[[^\]]+\]|"[^"]+"|\w+)(?:\.(?:\[[^\]]+\]|"[^"]+"|\w+))*)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?"#).unwrap()
    });
    let text = format!("from {}", from_clause);
    re.captures_iter(&text)
        .map(|c| {
            let alias = c
                .get(2)
                .map(|m| m.as_str().to_ascii_lowercase())
                .filter(|a| !NOT_ALIAS.contains(&a.as_str()));
            (last_part(&c[1]), alias)
        })
        .collect()
}

/// Returns (table logical name, qualifier for the SELECT, FROM clause).
fn resolve_target(target: &str, from: Option<&str>) -> AppResult<(String, String, String)> {
    let Some(from) = from else {
        return Ok((target.to_string(), target.to_string(), target.to_string()));
    };
    let refs = table_refs(from);
    if let Some((table, alias)) = refs.iter().find(|(_, a)| a.as_deref() == Some(target)) {
        return Ok((table.clone(), alias.clone().unwrap(), from.to_string()));
    }
    if let Some((table, alias)) = refs.iter().find(|(t, _)| t == target) {
        let qualifier = alias.clone().unwrap_or_else(|| table.clone());
        return Ok((table.clone(), qualifier, from.to_string()));
    }
    Err(AppError::msg(format!(
        "`{}` is not a table or alias in the FROM clause.",
        target
    )))
}

// ---------------------------------------------------------------------------
// Planning: resolve metadata, run the SELECT, build Web API bodies
// ---------------------------------------------------------------------------

struct LookupTarget {
    entity: String,
    nav: String,
    set: String,
    pk: String,
}

enum WriteKind {
    Text,
    Int,
    Float,
    Bool,
    DateTime,
    Lookup(Vec<LookupTarget>),
}

struct WriteColumn {
    name: String,
    kind: WriteKind,
}

fn write_columns(
    host: &str,
    token: &str,
    table: &str,
    names: &[String],
    kind: DmlKind,
    primary_id: &str,
) -> AppResult<Vec<WriteColumn>> {
    let attrs = metadata::write_attributes(host, token, table)?;
    let mut rels: Option<Vec<(String, String, String)>> = None;
    let mut entities: HashMap<String, metadata::EntityInfo> = HashMap::new();
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for name in names {
        if !seen.insert(name.as_str()) {
            return Err(AppError::msg(format!("Column `{}` is listed twice.", name)));
        }
        let attr = attrs.get(name).ok_or_else(|| {
            AppError::msg(format!("Column `{}` does not exist on table `{}`.", name, table))
        })?;
        if kind == DmlKind::Update && name == primary_id {
            return Err(AppError::msg(format!(
                "The primary key `{}` can't be updated.",
                name
            )));
        }
        let writable = if kind == DmlKind::Insert {
            attr.valid_for_create
        } else {
            attr.valid_for_update
        };
        if !writable {
            return Err(AppError::msg(format!(
                "Column `{}` can't be {} — it is read-only or calculated.",
                name,
                if kind == DmlKind::Insert { "set on create" } else { "updated" }
            )));
        }

        let write_kind = match attr.attribute_type.as_str() {
            "String" | "Memo" | "EntityName" | "Uniqueidentifier" => WriteKind::Text,
            "Integer" | "BigInt" | "Picklist" | "State" | "Status" => WriteKind::Int,
            "Decimal" | "Double" | "Money" => WriteKind::Float,
            "Boolean" => WriteKind::Bool,
            "DateTime" => WriteKind::DateTime,
            "Lookup" | "Customer" | "Owner" => {
                if rels.is_none() {
                    rels = Some(metadata::many_to_one(host, token, table)?);
                }
                let mut targets = Vec::new();
                for (_, referenced, nav) in rels.as_ref().unwrap().iter().filter(|(a, _, _)| a == name) {
                    // `ownerid` points at the abstract `owner` table: users or teams.
                    let candidates: Vec<&str> = if referenced == "owner" {
                        vec!["systemuser", "team"]
                    } else {
                        vec![referenced.as_str()]
                    };
                    for entity in candidates {
                        if !entities.contains_key(entity) {
                            entities.insert(entity.to_string(), metadata::entity_info(host, token, entity)?);
                        }
                        let info = &entities[entity];
                        targets.push(LookupTarget {
                            entity: entity.to_string(),
                            nav: nav.clone(),
                            set: info.entity_set.clone(),
                            pk: info.primary_id.clone(),
                        });
                    }
                }
                if targets.is_empty() {
                    return Err(AppError::msg(format!(
                        "Couldn't find the relationship behind lookup `{}`.",
                        name
                    )));
                }
                WriteKind::Lookup(targets)
            }
            other => {
                return Err(AppError::msg(format!(
                    "Writing `{}` columns ({}) isn't supported yet.",
                    other, name
                )))
            }
        };
        out.push(WriteColumn {
            name: name.clone(),
            kind: write_kind,
        });
    }
    Ok(out)
}

/// For lookups that can point at several tables (customer, owner, ...), find
/// which table each GUID belongs to. Returns `"column|guid" -> target index`.
fn resolve_polymorphic(
    host: &str,
    token: &str,
    columns: &[WriteColumn],
    rows: &[Vec<Value>],
    offset: usize,
) -> AppResult<HashMap<String, usize>> {
    let mut map = HashMap::new();
    for (ci, col) in columns.iter().enumerate() {
        let WriteKind::Lookup(targets) = &col.kind else { continue };
        if targets.len() < 2 {
            continue;
        }
        let mut pending: Vec<String> = rows
            .iter()
            .filter_map(|r| r.get(ci + offset)?.as_str())
            .filter_map(|s| uuid::Uuid::parse_str(s.trim()).ok())
            .map(|u| u.to_string())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        for (ti, target) in targets.iter().enumerate() {
            if pending.is_empty() {
                break;
            }
            let mut found = HashSet::new();
            for chunk in pending.chunks(200) {
                let ids = chunk.iter().map(|g| format!("'{}'", g)).collect::<Vec<_>>().join(",");
                let query = format!(
                    "SELECT {pk} FROM {entity} WHERE {pk} IN ({ids})",
                    pk = target.pk,
                    entity = target.entity,
                    ids = ids
                );
                for row in sql::run(host, token, &query, chunk.len() + 1)?.rows {
                    if let Some(id) = row.first().and_then(|v| v.as_str()).and_then(|s| uuid::Uuid::parse_str(s).ok()) {
                        found.insert(id.to_string());
                    }
                }
            }
            for id in &found {
                map.insert(format!("{}|{}", col.name, id), ti);
            }
            pending.retain(|g| !found.contains(g));
        }
    }
    Ok(map)
}

/// `2024-05-01 13:45:00.000` -> `2024-05-01T13:45:00.000Z` (TDS values are UTC).
fn to_iso(s: &str) -> String {
    let t = s.trim();
    if t.len() <= 10 {
        return t.to_string(); // date only
    }
    let mut out = t.replacen(' ', "T", 1);
    let has_zone = {
        let time = out.get(11..).unwrap_or("");
        time.ends_with('Z') || time.contains('+') || time.contains('-')
    };
    if !has_zone {
        out.push('Z');
    }
    out
}

fn json_value(
    col: &WriteColumn,
    v: &Value,
    lookups: &HashMap<String, usize>,
) -> AppResult<(String, Value)> {
    let bad = |expected: &str| {
        AppError::msg(format!(
            "Value {} is not valid for `{}` (expected {}).",
            v, col.name, expected
        ))
    };
    let key = col.name.clone();
    match &col.kind {
        WriteKind::Lookup(targets) => {
            if v.is_null() {
                return Ok((format!("{}@odata.bind", targets[0].nav), Value::Null));
            }
            let raw = v.as_str().ok_or_else(|| bad("a GUID"))?;
            let id = uuid::Uuid::parse_str(raw.trim())
                .map_err(|_| bad("a GUID"))?
                .to_string();
            let index = if targets.len() == 1 {
                0
            } else {
                *lookups.get(&format!("{}|{}", col.name, id)).ok_or_else(|| {
                    AppError::msg(format!(
                        "Record {} was not found in {} (for `{}`).",
                        id,
                        targets.iter().map(|t| t.entity.as_str()).collect::<Vec<_>>().join(" / "),
                        col.name
                    ))
                })?
            };
            let target = &targets[index];
            Ok((
                format!("{}@odata.bind", target.nav),
                Value::from(format!("/{}({})", target.set, id)),
            ))
        }
        _ if v.is_null() => Ok((key, Value::Null)),
        WriteKind::Text => Ok((
            key,
            match v {
                Value::String(s) => Value::String(s.clone()),
                other => Value::String(other.to_string()),
            },
        )),
        WriteKind::Int => {
            let n = match v {
                Value::Number(n) => n
                    .as_i64()
                    .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
                Value::String(s) => s.trim().parse::<i64>().ok(),
                Value::Bool(b) => Some(*b as i64),
                _ => None,
            };
            n.map(|n| (key, Value::from(n))).ok_or_else(|| bad("a whole number"))
        }
        WriteKind::Float => {
            let f = match v {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => s.trim().parse::<f64>().ok(),
                _ => None,
            };
            f.and_then(serde_json::Number::from_f64)
                .map(|n| (key, Value::Number(n)))
                .ok_or_else(|| bad("a number"))
        }
        WriteKind::Bool => {
            let b = match v {
                Value::Bool(b) => Some(*b),
                Value::Number(n) => n.as_i64().map(|i| i != 0),
                Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
                    "1" | "true" | "yes" => Some(true),
                    "0" | "false" | "no" => Some(false),
                    _ => None,
                },
                _ => None,
            };
            b.map(|b| (key, Value::Bool(b))).ok_or_else(|| bad("true / false"))
        }
        WriteKind::DateTime => {
            let s = v.as_str().ok_or_else(|| bad("a date/time"))?;
            Ok((key, Value::String(to_iso(s))))
        }
    }
}

fn build_body(
    columns: &[WriteColumn],
    values: &[Value],
    lookups: &HashMap<String, usize>,
) -> AppResult<Value> {
    let mut body = Map::new();
    for (col, v) in columns.iter().zip(values) {
        let (key, value) = json_value(col, v, lookups)?;
        body.insert(key, value);
    }
    Ok(Value::Object(body))
}

fn with_where(mut select: String, where_clause: &Option<String>) -> AppResult<String> {
    if let Some(w) = where_clause {
        if w.is_empty() {
            return Err(AppError::msg("The WHERE clause is empty."));
        }
        select.push_str(" WHERE ");
        select.push_str(w);
    }
    Ok(select)
}

fn run_rows(host: &str, token: &str, select: &str) -> AppResult<Vec<Vec<Value>>> {
    let result = sql::run(host, token, select, MAX_ROWS)?;
    if result.truncated {
        return Err(AppError::msg(format!(
            "More than {} rows match — narrow the WHERE clause and run it in batches.",
            MAX_ROWS
        )));
    }
    Ok(result.rows)
}

fn record_id(row: &[Value]) -> AppResult<String> {
    row.first()
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::msg("Could not read the record id."))
}

/// Blocking. Parses the statement, finds the affected rows and builds every
/// Web API request — nothing is written yet.
pub fn prepare(host: &str, token: &str, sql_text: &str) -> AppResult<DmlPlan> {
    match parse(sql_text)? {
        Statement::Update(u) => {
            let (table, qualifier, from_sql) = resolve_target(&u.target, u.from.as_deref())?;
            let info = metadata::entity_info(host, token, &table)?;
            let names: Vec<String> = u.assignments.iter().map(|(c, _)| c.clone()).collect();
            let columns =
                write_columns(host, token, &table, &names, DmlKind::Update, &info.primary_id)?;

            // TDS evaluates the new values, so expressions like
            // `SET fullname = firstname + ' ' + lastname` just work.
            let values = u
                .assignments
                .iter()
                .enumerate()
                .map(|(i, (_, expr))| format!("({}) AS [__v{}]", expr, i))
                .collect::<Vec<_>>()
                .join(", ");
            let select = with_where(
                format!(
                    "SELECT {}.{} AS [__id], {} FROM {}",
                    qualifier, info.primary_id, values, from_sql
                ),
                &u.where_clause,
            )?;
            let rows = run_rows(host, token, &select)?;
            let lookups = resolve_polymorphic(host, token, &columns, &rows, 1)?;

            let ops = rows
                .iter()
                .map(|row| {
                    Ok(Op::Update {
                        id: record_id(row)?,
                        body: build_body(&columns, &row[1..], &lookups)?,
                    })
                })
                .collect::<AppResult<Vec<_>>>()?;

            Ok(DmlPlan {
                kind: DmlKind::Update,
                host: host.to_string(),
                table,
                entity_set: info.entity_set,
                columns: names,
                ops,
            })
        }

        Statement::Delete(d) => {
            let (table, qualifier, from_sql) = resolve_target(&d.target, d.from.as_deref())?;
            let info = metadata::entity_info(host, token, &table)?;
            let select = with_where(
                format!("SELECT {}.{} FROM {}", qualifier, info.primary_id, from_sql),
                &d.where_clause,
            )?;
            let ops = run_rows(host, token, &select)?
                .iter()
                .map(|row| Ok(Op::Delete { id: record_id(row)? }))
                .collect::<AppResult<Vec<_>>>()?;

            Ok(DmlPlan {
                kind: DmlKind::Delete,
                host: host.to_string(),
                table,
                entity_set: info.entity_set,
                columns: Vec::new(),
                ops,
            })
        }

        Statement::Insert(ins) => {
            let info = metadata::entity_info(host, token, &ins.table)?;
            let columns = write_columns(
                host,
                token,
                &ins.table,
                &ins.columns,
                DmlKind::Insert,
                &info.primary_id,
            )?;

            let rows: Vec<Vec<Value>> = match &ins.source {
                InsertSource::Values(tuples) => tuples
                    .iter()
                    .map(|tuple| -> AppResult<Vec<Value>> {
                        if tuple.len() != ins.columns.len() {
                            return Err(AppError::msg(format!(
                                "A VALUES row has {} values but {} columns were listed.",
                                tuple.len(),
                                ins.columns.len()
                            )));
                        }
                        tuple.iter().map(|v| parse_literal(v)).collect()
                    })
                    .collect::<AppResult<_>>()?,
                InsertSource::Select(query) => {
                    let result = sql::run(host, token, query, MAX_ROWS)?;
                    if result.truncated {
                        return Err(AppError::msg(format!(
                            "The SELECT returns more than {} rows.",
                            MAX_ROWS
                        )));
                    }
                    if result.columns.len() != ins.columns.len() {
                        return Err(AppError::msg(format!(
                            "The SELECT returns {} columns but {} were listed.",
                            result.columns.len(),
                            ins.columns.len()
                        )));
                    }
                    result.rows
                }
            };

            let lookups = resolve_polymorphic(host, token, &columns, &rows, 0)?;
            let ops = rows
                .iter()
                .map(|row| Ok(Op::Create { body: build_body(&columns, row, &lookups)? }))
                .collect::<AppResult<Vec<_>>>()?;

            Ok(DmlPlan {
                kind: DmlKind::Insert,
                host: host.to_string(),
                table: ins.table.clone(),
                entity_set: info.entity_set,
                columns: ins.columns.clone(),
                ops,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

enum SendError {
    /// Service protection limit: wait this long, then try again.
    Throttled(Duration),
    Failed(String),
}

/// Sends one request; `Ok` carries the server's `x-ms-dop-hint`, if any.
fn send(agent: &ureq::Agent, base: &str, auth: &str, op: &Op) -> Result<Option<usize>, SendError> {
    let request = |method: &str, url: String| {
        agent
            .request(method, &url)
            .set("Authorization", auth)
            .set("Accept", "application/json")
            .set("OData-MaxVersion", "4.0")
            .set("OData-Version", "4.0")
    };
    let response = match op {
        // If-Match: * makes PATCH update-only (no accidental upsert).
        Op::Update { id, body } => request("PATCH", format!("{}({})", base, id))
            .set("If-Match", "*")
            .set("Content-Type", "application/json")
            .send_string(&body.to_string()),
        Op::Delete { id } => request("DELETE", format!("{}({})", base, id)).call(),
        Op::Create { body } => request("POST", base.to_string())
            .set("Content-Type", "application/json")
            .send_string(&body.to_string()),
    };
    match response {
        Ok(r) => Ok(r.header("x-ms-dop-hint").and_then(|h| h.trim().parse().ok())),
        Err(ureq::Error::Status(code, r)) if code == 429 || code == 503 => {
            let secs = r
                .header("Retry-After")
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(5);
            Err(SendError::Throttled(Duration::from_secs(secs)))
        }
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            Err(SendError::Failed(
                serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.pointer("/error/message")?.as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| format!("HTTP {}", code)),
            ))
        }
        Err(e) => Err(SendError::Failed(e.to_string())),
    }
}

/// The server can ask for very long waits; trust it less each time.
fn throttle_wait(asked: Duration, attempt: u32) -> Duration {
    let cap = match attempt {
        0 => Duration::from_secs(300),
        1 | 2 => Duration::from_secs(120),
        _ => Duration::from_secs(60),
    };
    asked.min(cap)
}

/// Shared between the workers and the monitor thread.
struct Pool {
    /// Workers may grow to this many. Auto mode starts at 1 and adopts the
    /// server's `x-ms-dop-hint` from the first response.
    max: AtomicUsize,
    auto: bool,
    hinted: AtomicBool,
    active: AtomicUsize,
    peak: AtomicUsize,
    paused: AtomicUsize,
    /// Votes: a request succeeded (grow) / was throttled (shrink).
    grow: AtomicBool,
    shrink: AtomicBool,
    /// Once shrunk, never grow again in this run.
    shrunk: AtomicBool,
    /// Workers that should exit at their next check.
    stop: AtomicUsize,
    any_success: AtomicBool,
    throttled: AtomicUsize,
    next: AtomicUsize,
    done: AtomicUsize,
    succeeded: AtomicUsize,
    errors: Mutex<Vec<String>>,
}

impl Pool {
    fn adopt_hint(&self, hint: Option<usize>) {
        if !self.auto || self.hinted.swap(true, Ordering::SeqCst) {
            return;
        }
        let max = hint.unwrap_or(FALLBACK_WORKERS).clamp(1, MAX_WORKERS);
        self.max.store(max, Ordering::SeqCst);
    }

    fn progress(&self, total: usize) -> DmlProgress {
        DmlProgress {
            done: self.done.load(Ordering::SeqCst),
            total,
            threads: self.active.load(Ordering::SeqCst),
            paused: self.paused.load(Ordering::SeqCst),
        }
    }
}

/// One worker: takes ops until none are left or the monitor asks it to stop.
fn worker(pool: &Pool, plan: &DmlPlan, agent: &ureq::Agent, base: &str, auth: &str) {
    let total = plan.ops.len();
    loop {
        // Honour a shrink request, but never leave the pool empty.
        if pool.stop.load(Ordering::SeqCst) > 0
            && pool.active.load(Ordering::SeqCst) > 1
            && pool
                .stop
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
        {
            break;
        }
        let i = pool.next.fetch_add(1, Ordering::SeqCst);
        if i >= total {
            break;
        }
        let op = &plan.ops[i];
        let mut attempt = 0u32;
        let outcome = loop {
            match send(agent, base, auth, op) {
                Err(SendError::Throttled(asked)) if attempt < MAX_THROTTLE_RETRIES => {
                    pool.throttled.fetch_add(1, Ordering::SeqCst);
                    // Like SQL 4 CDS: only shrink once something has worked,
                    // otherwise a single throttle would leave us at one thread.
                    if pool.any_success.load(Ordering::SeqCst) {
                        pool.shrink.store(true, Ordering::SeqCst);
                    }
                    pool.paused.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(throttle_wait(asked, attempt));
                    pool.paused.fetch_sub(1, Ordering::SeqCst);
                    attempt += 1;
                }
                Err(SendError::Throttled(_)) => {
                    break Err("the server kept asking to slow down (429)".to_string())
                }
                Err(SendError::Failed(msg)) => break Err(msg),
                Ok(hint) => break Ok(hint),
            }
        };
        match outcome {
            Ok(hint) => {
                pool.adopt_hint(hint);
                pool.succeeded.fetch_add(1, Ordering::SeqCst);
                pool.any_success.store(true, Ordering::SeqCst);
                pool.grow.store(true, Ordering::SeqCst);
            }
            Err(msg) => {
                if let Ok(mut list) = pool.errors.lock() {
                    if list.len() < 50 {
                        list.push(format!("{}: {}", op.describe(), msg));
                    }
                }
            }
        }
        pool.done.fetch_add(1, Ordering::SeqCst);
    }
    pool.active.fetch_sub(1, Ordering::SeqCst);
}

/// Blocking. Sends every request of the plan in parallel, the way SQL 4 CDS
/// does: start with one worker, add one per second while requests succeed
/// (up to `max_workers`, or the server's `x-ms-dop-hint` when 0), drop one
/// when the server throttles us, and never grow again after that.
pub fn execute(
    plan: &DmlPlan,
    token: &str,
    max_workers: usize,
    progress: &(dyn Fn(DmlProgress) + Sync),
) -> DmlResult {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .build();
    // Hosts are bare names from the connection; a scheme only appears in tests.
    let scheme = if plan.host.starts_with("http://") { "" } else { "https://" };
    let base = format!("{}{}/api/data/v9.2/{}", scheme, plan.host, plan.entity_set);
    let auth = format!("Bearer {}", token);
    let total = plan.ops.len();
    let started = Instant::now();

    let auto = max_workers == 0;
    let pool = Pool {
        max: AtomicUsize::new(if auto { 1 } else { max_workers.clamp(1, MAX_WORKERS) }),
        auto,
        hinted: AtomicBool::new(false),
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        paused: AtomicUsize::new(0),
        grow: AtomicBool::new(false),
        shrink: AtomicBool::new(false),
        shrunk: AtomicBool::new(false),
        stop: AtomicUsize::new(0),
        any_success: AtomicBool::new(false),
        throttled: AtomicUsize::new(0),
        next: AtomicUsize::new(0),
        done: AtomicUsize::new(0),
        succeeded: AtomicUsize::new(0),
        errors: Mutex::new(Vec::new()),
    };

    fn spawn<'scope>(
        scope: &'scope std::thread::Scope<'scope, '_>,
        pool: &'scope Pool,
        plan: &'scope DmlPlan,
        agent: &'scope ureq::Agent,
        base: &'scope str,
        auth: &'scope str,
    ) {
        pool.active.fetch_add(1, Ordering::SeqCst);
        pool.peak.fetch_max(pool.active.load(Ordering::SeqCst), Ordering::SeqCst);
        scope.spawn(move || worker(pool, plan, agent, base, auth));
    }

    if total > 0 {
        std::thread::scope(|scope| {
            spawn(scope, &pool, plan, &agent, &base, &auth);

            // Monitor: adjusts the worker count once a second and reports progress.
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let active = pool.active.load(Ordering::SeqCst);
                if active == 0 {
                    break;
                }
                let remaining = total.saturating_sub(pool.next.load(Ordering::SeqCst));
                if pool.shrink.swap(false, Ordering::SeqCst) && active > 1 {
                    pool.stop.fetch_add(1, Ordering::SeqCst);
                    pool.shrunk.store(true, Ordering::SeqCst);
                } else if !pool.shrunk.load(Ordering::SeqCst)
                    && active < pool.max.load(Ordering::SeqCst)
                    && remaining > 0
                    && pool.grow.swap(false, Ordering::SeqCst)
                {
                    spawn(scope, &pool, plan, &agent, &base, &auth);
                }
                progress(pool.progress(total));
            }
        });
    }
    progress(pool.progress(total));

    let ok = pool.succeeded.load(Ordering::SeqCst);
    DmlResult {
        kind: plan.kind.as_str(),
        table: plan.table.clone(),
        total,
        succeeded: ok,
        failed: total - ok,
        errors: pool.errors.into_inner().unwrap_or_else(|e| e.into_inner()),
        elapsed_ms: started.elapsed().as_millis() as u64,
        max_threads: pool.peak.load(Ordering::SeqCst),
        throttled: pool.throttled.load(Ordering::SeqCst),
    }
}

// ---------------------------------------------------------------------------
// Tests (parser + a local fake Web API — nothing leaves the machine)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn throttle_waits_are_capped_more_each_retry() {
        let hour = Duration::from_secs(3600);
        assert_eq!(throttle_wait(hour, 0), Duration::from_secs(300));
        assert_eq!(throttle_wait(hour, 1), Duration::from_secs(120));
        assert_eq!(throttle_wait(hour, 3), Duration::from_secs(60));
        assert_eq!(throttle_wait(Duration::from_secs(2), 0), Duration::from_secs(2));
    }

    /// A fake Dataverse: every DELETE takes `latency`; `throttle_every`th
    /// request is answered 429 (Retry-After: 1) the first time it is seen.
    /// Returns the host to put in the plan and the peak concurrency observed.
    fn fake_server(latency: Duration, throttle_every: usize, dop_hint: Option<&'static str>) -> (String, Arc<AtomicUsize>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let host = format!("http://{}", server.server_addr());
        let peak = Arc::new(AtomicUsize::new(0));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(HashSet::<String>::new()));
        let served = Arc::new(AtomicUsize::new(0));
        let peak_out = peak.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let (peak, in_flight, seen, served) =
                    (peak.clone(), in_flight.clone(), seen.clone(), served.clone());
                std::thread::spawn(move || {
                    let n = served.fetch_add(1, Ordering::SeqCst) + 1;
                    let url = request.url().to_string();
                    let first_time = seen.lock().unwrap().insert(url);
                    if throttle_every > 0 && n % throttle_every == 0 && first_time {
                        let _ = request.respond(
                            tiny_http::Response::empty(429)
                                .with_header(tiny_http::Header::from_bytes("Retry-After", "1").unwrap()),
                        );
                        return;
                    }
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(latency);
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    let mut resp = tiny_http::Response::empty(204);
                    if let Some(h) = dop_hint {
                        resp = resp.with_header(tiny_http::Header::from_bytes("x-ms-dop-hint", h).unwrap());
                    }
                    let _ = request.respond(resp);
                });
            }
        });
        (host, peak_out)
    }

    fn delete_plan(host: &str, n: usize) -> DmlPlan {
        DmlPlan {
            kind: DmlKind::Delete,
            host: host.to_string(),
            table: "contact".into(),
            entity_set: "contacts".into(),
            columns: vec![],
            ops: (0..n).map(|i| Op::Delete { id: format!("id-{}", i) }).collect(),
        }
    }

    #[test]
    fn auto_mode_grows_to_the_servers_dop_hint() {
        let (host, peak) = fake_server(Duration::from_millis(150), 0, Some("3"));
        let plan = delete_plan(&host, 60);
        let result = execute(&plan, "t", 0, &|_| {});
        assert_eq!((result.succeeded, result.failed, result.throttled), (60, 0, 0));
        // grew past one worker, but never beyond the hint
        assert!(result.max_threads >= 2 && result.max_threads <= 3, "max_threads = {}", result.max_threads);
        assert!(peak.load(Ordering::SeqCst) <= 3);
    }

    #[test]
    fn throttling_retries_the_request_and_stops_growing() {
        let (host, _) = fake_server(Duration::from_millis(100), 7, None);
        let plan = delete_plan(&host, 40);
        let seen_paused = AtomicBool::new(false);
        let result = execute(&plan, "t", 6, &|p| {
            if p.paused > 0 {
                seen_paused.store(true, Ordering::SeqCst);
            }
        });
        // every throttled request was retried and eventually went through
        assert_eq!((result.succeeded, result.failed), (40, 0));
        assert!(result.throttled >= 1);
        assert!(seen_paused.load(Ordering::SeqCst), "progress never reported a paused worker");
        // shrank after the first 429, so it can't have reached the ceiling
        assert!(result.max_threads < 6, "max_threads = {}", result.max_threads);
    }

    #[test]
    fn fixed_worker_count_ignores_the_hint() {
        let (host, peak) = fake_server(Duration::from_millis(100), 0, Some("1"));
        let plan = delete_plan(&host, 40);
        let result = execute(&plan, "t", 4, &|_| {});
        assert_eq!(result.succeeded, 40);
        assert!(result.max_threads >= 2, "max_threads = {}", result.max_threads);
        assert!(peak.load(Ordering::SeqCst) <= 4);
    }

    #[test]
    fn update_simple_and_compound() {
        let s = parse("UPDATE contact SET firstname = 'A, B', new_score += 1 WHERE statecode = 0;")
            .unwrap();
        assert_eq!(
            s,
            Statement::Update(UpdateStmt {
                target: "contact".into(),
                assignments: vec![
                    ("firstname".into(), "'A, B'".into()),
                    ("new_score".into(), "new_score + (1)".into()),
                ],
                from: None,
                where_clause: Some("statecode = 0".into()),
            })
        );
    }

    #[test]
    fn update_with_join_and_subquery() {
        let sql = "-- fix descriptions\nUPDATE c SET c.description = (SELECT TOP 1 name FROM account WHERE accountid = c.parentcustomerid) FROM contact c JOIN account a ON a.accountid = c.parentcustomerid WHERE a.name = 'where from'";
        let Statement::Update(u) = parse(sql).unwrap() else { panic!("not an update") };
        assert_eq!(u.target, "c");
        assert_eq!(u.assignments[0].0, "description");
        assert!(u.assignments[0].1.starts_with("(SELECT TOP 1 name"));
        assert_eq!(
            u.from.as_deref(),
            Some("contact c JOIN account a ON a.accountid = c.parentcustomerid")
        );
        assert_eq!(u.where_clause.as_deref(), Some("a.name = 'where from'"));
        let (table, qualifier, _) = resolve_target(&u.target, u.from.as_deref()).unwrap();
        assert_eq!((table.as_str(), qualifier.as_str()), ("contact", "c"));
    }

    #[test]
    fn delete_forms() {
        assert_eq!(
            parse("DELETE FROM contact WHERE lastname IS NULL").unwrap(),
            Statement::Delete(DeleteStmt {
                target: "contact".into(),
                from: None,
                where_clause: Some("lastname IS NULL".into()),
            })
        );
        assert_eq!(
            parse("delete [dbo].[Contact]").unwrap(),
            Statement::Delete(DeleteStmt {
                target: "contact".into(),
                from: None,
                where_clause: None,
            })
        );
        let Statement::Delete(d) = parse("DELETE c FROM contact c WHERE c.statecode = 1").unwrap() else {
            panic!("not a delete")
        };
        assert_eq!(d.target, "c");
        assert_eq!(d.from.as_deref(), Some("contact c"));
    }

    #[test]
    fn insert_values_and_select() {
        let Statement::Insert(i) =
            parse("INSERT INTO contact (firstname, [lastname]) VALUES ('Ann', N'O''Neil'), ('Bob', NULL)")
                .unwrap()
        else {
            panic!("not an insert")
        };
        assert_eq!(i.table, "contact");
        assert_eq!(i.columns, vec!["firstname", "lastname"]);
        assert_eq!(
            i.source,
            InsertSource::Values(vec![
                vec!["'Ann'".into(), "N'O''Neil'".into()],
                vec!["'Bob'".into(), "NULL".into()],
            ])
        );

        let Statement::Insert(i) =
            parse("insert contact (lastname) select fullname from contact where statecode = 0").unwrap()
        else {
            panic!("not an insert")
        };
        assert_eq!(
            i.source,
            InsertSource::Select("select fullname from contact where statecode = 0".into())
        );
    }

    #[test]
    fn literals() {
        assert_eq!(parse_literal("N'It''s'").unwrap(), Value::from("It's"));
        assert_eq!(parse_literal("-12").unwrap(), Value::from(-12));
        assert_eq!(parse_literal("3.5").unwrap(), Value::from(3.5));
        assert_eq!(parse_literal("null").unwrap(), Value::Null);
        assert!(parse_literal("'a' + 'b'").is_err());
        assert!(parse_literal("GETDATE()").is_err());
    }

    #[test]
    fn rejects_unsupported() {
        assert!(parse("UPDATE TOP (5) contact SET firstname = 'x'").is_err());
        assert!(parse("DELETE TOP (5) FROM contact").is_err());
        assert!(parse("UPDATE contact SET a = 1; DELETE FROM contact").is_err());
        assert!(parse("INSERT INTO contact VALUES (1)").is_err());
        assert!(parse("SELECT * FROM contact").is_err());
    }

    #[test]
    fn iso_dates() {
        assert_eq!(to_iso("2024-05-01 13:45:00.000"), "2024-05-01T13:45:00.000Z");
        assert_eq!(to_iso("2024-05-01"), "2024-05-01");
        assert_eq!(to_iso("2024-05-01T10:00:00+07:00"), "2024-05-01T10:00:00+07:00");
    }
}
