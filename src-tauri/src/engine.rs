//! DataFusion-backed SQL engine over Dataverse — the "SQL 4 CDS"-style path.
//!
//! DataFusion parses/plans/executes the SQL (joins, aggregates, subqueries…)
//! and pushes projection + simple WHERE filters + limit down to our
//! `TableProvider`, which turns them into FetchXML and reads rows through the
//! Web API. That works for every table — including virtual entities and
//! tables the TDS endpoint refuses ("not available for reports").
//!
//! Push-down scope: single-table WHERE (columns, =,<,>,<=,>=,<>, IS [NOT]
//! NULL, LIKE, IN, AND/OR), `TOP` / `ORDER BY … TOP`, paging, type mapping.
//! Anything FetchXML can't express is evaluated by DataFusion in memory.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use datafusion::arrow::array::{
    Array, ArrayRef, BooleanArray, BooleanBuilder, Float64Array, Float64Builder, Int32Array,
    Int32Builder, Int64Array, Int64Builder, StringArray, StringBuilder,
};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use datafusion::arrow::record_batch::{RecordBatch, RecordBatchOptions};
use datafusion::arrow::util::display::array_value_to_string;
use datafusion::catalog::{CatalogProvider, MemoryCatalogProvider, SchemaProvider, Session, TableProvider};
use datafusion::common::tree_node::{Transformed, TreeNode, TreeNodeRecursion};
use datafusion::common::{Column, ScalarValue};
use datafusion::datasource::{provider_as_source, source_as_provider, ViewTable};
use datafusion::error::{DataFusionError, Result as DfResult};
use datafusion::execution::TaskContext;
use datafusion::logical_expr::{
    Expr, LogicalPlan, Operator, Projection, Sort, SortExpr, SubqueryAlias, TableProviderFilterPushDown,
    TableScan, TableType,
};
use datafusion::physical_expr::{EquivalenceProperties, PhysicalExpr};
use datafusion::physical_plan::execution_plan::{Boundedness, EmissionType};
use datafusion::physical_plan::stream::RecordBatchStreamAdapter;
use datafusion::physical_plan::{
    DisplayAs, DisplayFormatType, ExecutionPlan, Partitioning, PlanProperties, SendableRecordBatchStream,
};
use datafusion::prelude::{SessionConfig, SessionContext};
use futures::stream::BoxStream;
use futures::StreamExt;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::http;
use crate::metadata;
use crate::sql::{ColumnInfo, OnBatch, QueryResult, Timings};

/// FetchXML `top`/`count` ceiling per request.
const PAGE_SIZE: usize = 5000;

/// Retries after a service-protection (429) or busy (503) response.
const MAX_RETRIES: u32 = 5;

/// Parallel reads: rows per range request, before and after splitting a key
/// page by the thread count.
const RANGE_MIN_ROWS: usize = 250;
const RANGE_MAX_ROWS: usize = 1000;

/// Parallel reads when the server sends no `x-ms-dop-hint`.
const FALLBACK_READ_THREADS: usize = 8;

const MORE_RECORDS: &str = "@Microsoft.Dynamics.CRM.morerecords";
const PAGING_COOKIE: &str = "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie";

/// The annotations paging depends on: without them the Web API never
/// reports `morerecords`, so only the first 5,000 rows would come back.
const PREFER_PAGING: &str = "odata.include-annotations=\"Microsoft.Dynamics.CRM.fetchxmlpagingcookie,\
Microsoft.Dynamics.CRM.morerecords\"";

/// Paging plus display labels, only when a `<attr>name` column is selected:
/// the server formats every value of every column for these, which costs
/// time and bytes.
const PREFER_WITH_LABELS: &str = "odata.include-annotations=\"OData.Community.Display.V1.FormattedValue,\
Microsoft.Dynamics.CRM.fetchxmlpagingcookie,Microsoft.Dynamics.CRM.morerecords\"";

// ---------------------------------------------------------------------------
// Shared connection context
// ---------------------------------------------------------------------------

struct EngineCtx {
    host: String,
    token: String,
    /// Parallel read requests: 0 = what the server recommends
    /// (`x-ms-dop-hint`), 1 = plain sequential paging.
    workers: usize,
    /// Rows per FetchXML page (5,000; smaller in tests).
    page_size: usize,
    /// Smallest range a key page is split into (smaller in tests).
    range_min: usize,
    /// Row caps at or below this are read sequentially.
    parallel_min: usize,
    /// One HTTP agent per query, so connections (and TLS sessions) are reused.
    agent: ureq::Agent,
    /// Caps parallel range requests; shrinks when the server throttles.
    limiter: Limiter,
    /// Where the time went, accumulated across every table and page.
    stats: Mutex<FetchStats>,
}

#[derive(Clone, Copy, Default)]
struct FetchStats {
    metadata_ms: u64,
    requests: usize,
    key_requests: usize,
    bytes: usize,
    wire_bytes: usize,
    wait_ms: u64,
    download_ms: u64,
    first: Option<Instant>,
    last: Option<Instant>,
    threads: usize,
    throttled: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum Req {
    Rows,
    Keys,
}

impl EngineCtx {
    fn new(host: &str, token: &str, workers: usize) -> Self {
        Self {
            host: host.to_string(),
            token: token.to_string(),
            workers,
            page_size: PAGE_SIZE,
            range_min: RANGE_MIN_ROWS,
            parallel_min: RANGE_MAX_ROWS,
            agent: ureq::AgentBuilder::new()
                .max_idle_connections_per_host(64)
                .timeout_connect(Duration::from_secs(30))
                .build(),
            limiter: Limiter::default(),
            stats: Mutex::new(FetchStats::default()),
        }
    }

    /// Hosts are bare names from the connection; a scheme only appears in tests.
    fn api_base(&self) -> String {
        if self.host.starts_with("http://") {
            format!("{}/api/data/v9.2", self.host)
        } else {
            format!("https://{}/api/data/v9.2", self.host)
        }
    }

    fn record(&self, f: impl FnOnce(&mut FetchStats)) {
        if let Ok(mut s) = self.stats.lock() {
            f(&mut s);
        }
    }

    fn stats(&self) -> FetchStats {
        self.stats.lock().map(|s| *s).unwrap_or_default()
    }

    /// Runs one FetchXML request through the Web API and hands the body to
    /// `parse`; also returns the server's recommended parallelism.
    fn fetchxml<T>(
        &self,
        entity_set: &str,
        fetch: &str,
        prefer: &str,
        kind: Req,
        parse: impl FnOnce(&mut dyn std::io::Read) -> std::io::Result<T>,
    ) -> AppResult<(T, Option<usize>)> {
        let url = format!(
            "{}/{}?fetchXml={}",
            self.api_base(),
            entity_set,
            utf8_percent_encode(fetch, NON_ALPHANUMERIC)
        );
        let t0 = Instant::now();
        let mut attempt = 0;
        let resp = loop {
            let resp = self
                .agent
                .get(&url)
                .set("Authorization", &format!("Bearer {}", self.token))
                .set("Accept", "application/json")
                .set("Accept-Encoding", http::ACCEPT_ENCODING)
                .set("OData-MaxVersion", "4.0")
                .set("OData-Version", "4.0")
                .set("Prefer", prefer)
                .call();
            match resp {
                // Service protection limits: wait as long as the server asks.
                Err(ureq::Error::Status(code, ref r)) if (code == 429 || code == 503) && attempt < MAX_RETRIES => {
                    let wait = r
                        .header("Retry-After")
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .unwrap_or(5)
                        .clamp(1, 300);
                    self.record(|s| s.throttled += 1);
                    // Like SQL 4 CDS's DynamicParallel: one request fewer at a
                    // time for the rest of the read.
                    self.limiter.shrink();
                    std::thread::sleep(Duration::from_secs(wait));
                    attempt += 1;
                }
                other => break other,
            }
        };
        let answered = Instant::now();
        let r = match resp {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let text = http::text(r);
                let msg = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.pointer("/error/message")?.as_str().map(|s| s.to_string()))
                    .unwrap_or(text);
                return Err(AppError::msg(format!("FetchXML request failed ({}): {}", code, msg)));
            }
            Err(e) => return Err(AppError::msg(e.to_string())),
        };
        let dop_hint = r.header("x-ms-dop-hint").and_then(|v| v.trim().parse::<usize>().ok());
        let (value, sizes) = http::read_body(r, parse)
            .map_err(|e| AppError::msg(format!("Reading the FetchXML response failed: {}", e)))?;
        let done = Instant::now();
        self.record(|s| {
            match kind {
                Req::Rows => s.requests += 1,
                Req::Keys => s.key_requests += 1,
            }
            s.bytes += sizes.decoded;
            s.wire_bytes += sizes.wire;
            s.wait_ms += (answered - t0).as_millis() as u64;
            s.download_ms += (done - answered).as_millis() as u64;
            s.first = Some(s.first.map_or(t0, |f| f.min(t0)));
            s.last = Some(s.last.map_or(done, |l| l.max(done)));
        });
        Ok((value, dop_hint))
    }
}

impl fmt::Debug for EngineCtx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EngineCtx").field("host", &self.host).finish_non_exhaustive()
    }
}

/// How many range requests may run at once (blocking threads wait here).
/// Starts unlimited; a parallel read sets it, a throttled request lowers it.
struct Limiter {
    /// (allowed, running)
    state: Mutex<(usize, usize)>,
    changed: std::sync::Condvar,
}

impl Default for Limiter {
    fn default() -> Self {
        Self { state: Mutex::new((usize::MAX, 0)), changed: std::sync::Condvar::new() }
    }
}

struct Permit<'a>(&'a Limiter);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        if let Ok(mut s) = self.0.state.lock() {
            s.1 -= 1;
        }
        self.0.changed.notify_all();
    }
}

impl Limiter {
    fn set(&self, allowed: usize) {
        if let Ok(mut s) = self.state.lock() {
            s.0 = allowed.max(1);
        }
        self.changed.notify_all();
    }

    fn shrink(&self) {
        if let Ok(mut s) = self.state.lock() {
            if s.0 != usize::MAX {
                s.0 = s.0.saturating_sub(1).max(1);
            }
        }
    }

    fn allowed(&self) -> usize {
        self.state.lock().map(|s| s.0).unwrap_or(1)
    }

    fn acquire(&self) -> Permit<'_> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while s.1 >= s.0 {
            s = self.changed.wait(s).unwrap_or_else(|e| e.into_inner());
        }
        s.1 += 1;
        Permit(self)
    }
}

/// Parallel read requests for a query.
fn read_threads(workers: usize, dop_hint: Option<usize>) -> usize {
    let n = if workers > 0 { workers } else { dop_hint.unwrap_or(FALLBACK_READ_THREADS) };
    n.clamp(1, crate::dml::MAX_WORKERS)
}

/// Rows per range request when `keys` keys are split over `threads`.
fn range_rows(keys: usize, range_min: usize, threads: usize) -> usize {
    keys.div_ceil(threads.max(1)).clamp(range_min.max(1), RANGE_MAX_ROWS.max(range_min))
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Text,
    Int,
    BigInt,
    Float,
    Bool,
    /// Lookup/Customer/Owner — the Web API returns `_<name>_value` (a GUID).
    Lookup,
    /// Synthesized `<attr>name` label column (TDS exposes these too), read
    /// from the `@OData.Community.Display.V1.FormattedValue` annotation.
    Formatted,
}

/// How far a WHERE condition on a column can be handed to FetchXML.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Push {
    /// FetchXML evaluates it exactly like T-SQL does over TDS.
    Exact,
    /// Sent to the server, but DataFusion re-checks the rows.
    Inexact,
    /// Never sent (e.g. synthesized label columns).
    Never,
}

/// How one SQL column maps onto the Web API payload.
#[derive(Clone, Debug)]
struct ColSpec {
    /// FetchXML `<attribute name>` that must be requested for this column.
    fetch_attr: String,
    /// JSON key holding the value in each row.
    json_key: String,
    kind: Kind,
    push: Push,
    /// FetchXML `<order>` on it sorts the way T-SQL does (choices and lookups
    /// sort by label in FetchXML, so they are not).
    orderable: bool,
}

/// Filter push-down and ordering support per Dataverse attribute type.
fn capabilities(attr_type: &str) -> (Push, bool) {
    match attr_type {
        "String" | "Memo" | "Integer" | "BigInt" | "Decimal" | "Double" | "Money" | "Uniqueidentifier" => {
            (Push::Exact, true)
        }
        // Values are compared as text in memory; keep the server result checked.
        "DateTime" => (Push::Inexact, true),
        "Boolean" | "Picklist" | "State" | "Status" | "Lookup" | "Customer" | "Owner" => (Push::Exact, false),
        _ => (Push::Never, false),
    }
}

const FORMATTED: &str = "@OData.Community.Display.V1.FormattedValue";

/// Attribute types that get a companion `<name>name` label column.
fn has_label(attr_type: &str) -> bool {
    matches!(
        attr_type,
        "Picklist" | "State" | "Status" | "Boolean" | "Lookup" | "Customer" | "Owner" | "MultiSelectPicklist" | "EntityName"
    )
}

fn kind_of(attr_type: &str) -> Kind {
    match attr_type {
        "Integer" | "Picklist" | "State" | "Status" => Kind::Int,
        "BigInt" => Kind::BigInt,
        "Decimal" | "Double" | "Money" => Kind::Float,
        "Boolean" => Kind::Bool,
        "Lookup" | "Customer" | "Owner" => Kind::Lookup,
        _ => Kind::Text, // String, Memo, DateTime (ISO text), Uniqueidentifier, EntityName…
    }
}

fn arrow_type(kind: Kind) -> DataType {
    match kind {
        Kind::Int => DataType::Int32,
        Kind::BigInt => DataType::Int64,
        Kind::Float => DataType::Float64,
        Kind::Bool => DataType::Boolean,
        Kind::Text | Kind::Lookup | Kind::Formatted => DataType::Utf8,
    }
}

// ---------------------------------------------------------------------------
// FetchXML helpers
// ---------------------------------------------------------------------------

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn scalar_text(v: &ScalarValue) -> Option<String> {
    Some(match v {
        ScalarValue::Utf8(Some(s)) | ScalarValue::LargeUtf8(Some(s)) | ScalarValue::Utf8View(Some(s)) => {
            s.clone()
        }
        ScalarValue::Boolean(Some(b)) => if *b { "1" } else { "0" }.to_string(),
        ScalarValue::Int8(Some(n)) => n.to_string(),
        ScalarValue::Int16(Some(n)) => n.to_string(),
        ScalarValue::Int32(Some(n)) => n.to_string(),
        ScalarValue::Int64(Some(n)) => n.to_string(),
        ScalarValue::UInt8(Some(n)) => n.to_string(),
        ScalarValue::UInt16(Some(n)) => n.to_string(),
        ScalarValue::UInt32(Some(n)) => n.to_string(),
        ScalarValue::UInt64(Some(n)) => n.to_string(),
        ScalarValue::Float32(Some(n)) => n.to_string(),
        ScalarValue::Float64(Some(n)) => n.to_string(),
        _ => return None,
    })
}

fn column_name(e: &Expr) -> Option<String> {
    match e {
        Expr::Column(c) => Some(c.name.clone()),
        Expr::Cast(c) => column_name(&c.expr),
        _ => None,
    }
}

fn literal(e: &Expr) -> Option<&ScalarValue> {
    match e {
        Expr::Literal(v, _) => Some(v),
        Expr::Cast(c) => literal(&c.expr),
        _ => None,
    }
}

/// Maps a SQL column name to its FetchXML attribute and push-down support.
type Resolve<'a> = &'a dyn Fn(&str) -> Option<(String, Push)>;

/// Translate a DataFusion filter into a FetchXML `<condition>`/`<filter>`,
/// plus whether FetchXML evaluates it exactly; `None` when FetchXML can't
/// express it (DataFusion then evaluates it).
fn filter_to_xml(e: &Expr, resolve: Resolve) -> Option<(String, bool)> {
    let attr = |e: &Expr| -> Option<(String, bool)> {
        let (attr, push) = resolve(&column_name(e)?)?;
        match push {
            Push::Never => None,
            p => Some((attr, p == Push::Exact)),
        }
    };
    match e {
        Expr::BinaryExpr(b) => match b.op {
            Operator::And | Operator::Or => {
                let (l, l_exact) = filter_to_xml(&b.left, resolve)?;
                let (r, r_exact) = filter_to_xml(&b.right, resolve)?;
                let ty = if b.op == Operator::And { "and" } else { "or" };
                Some((format!("<filter type=\"{}\">{}{}</filter>", ty, l, r), l_exact && r_exact))
            }
            Operator::Eq | Operator::NotEq | Operator::Lt | Operator::LtEq | Operator::Gt | Operator::GtEq => {
                let ((col, exact), val, flipped) = if let (Some(c), Some(v)) = (attr(&b.left), literal(&b.right)) {
                    (c, v, false)
                } else if let (Some(v), Some(c)) = (literal(&b.left), attr(&b.right)) {
                    (c, v, true)
                } else {
                    return None;
                };
                let op = match (b.op, flipped) {
                    (Operator::Eq, _) => "eq",
                    (Operator::NotEq, _) => "ne",
                    (Operator::Lt, false) | (Operator::Gt, true) => "lt",
                    (Operator::LtEq, false) | (Operator::GtEq, true) => "le",
                    (Operator::Gt, false) | (Operator::Lt, true) => "gt",
                    (Operator::GtEq, false) | (Operator::LtEq, true) => "ge",
                    _ => return None,
                };
                let condition = format!(
                    "<condition attribute=\"{}\" operator=\"{}\" value=\"{}\"/>",
                    col,
                    op,
                    xml_escape(&scalar_text(val)?)
                );
                if op == "ne" {
                    // FetchXML `ne` also matches NULLs; T-SQL `<>` doesn't.
                    return Some((
                        format!(
                            "<filter type=\"and\">{}<condition attribute=\"{}\" operator=\"not-null\"/></filter>",
                            condition, col
                        ),
                        exact,
                    ));
                }
                Some((condition, exact))
            }
            _ => None,
        },
        Expr::IsNull(inner) => {
            let (col, _) = attr(inner)?;
            Some((format!("<condition attribute=\"{}\" operator=\"null\"/>", col), true))
        }
        Expr::IsNotNull(inner) => {
            let (col, _) = attr(inner)?;
            Some((format!("<condition attribute=\"{}\" operator=\"not-null\"/>", col), true))
        }
        Expr::Like(like) if !like.negated && like.escape_char.is_none() => {
            let (col, exact) = attr(&like.expr)?;
            let pat = scalar_text(literal(&like.pattern)?)?;
            Some((
                format!(
                    "<condition attribute=\"{}\" operator=\"like\" value=\"{}\"/>",
                    col,
                    xml_escape(&pat)
                ),
                exact,
            ))
        }
        Expr::InList(il) if !il.negated => {
            let (col, exact) = attr(&il.expr)?;
            let mut values = String::new();
            for item in &il.list {
                values.push_str(&format!("<value>{}</value>", xml_escape(&scalar_text(literal(item)?)?)));
            }
            Some((
                format!("<condition attribute=\"{}\" operator=\"in\">{}</condition>", col, values),
                exact,
            ))
        }
        _ => None,
    }
}

/// Pull the paging cookie out of a Web API `fetchxmlpagingcookie` annotation
/// and prepare it for the next `<fetch paging-cookie="…">` (it arrives
/// double-URL-encoded).
fn next_cookie(raw: &str) -> Option<String> {
    let start = raw.find("pagingcookie=\"")? + "pagingcookie=\"".len();
    let end = raw[start..].find('"')? + start;
    let once = percent_decode_str(&raw[start..end]).decode_utf8_lossy().to_string();
    let twice = percent_decode_str(&once).decode_utf8_lossy().to_string();
    Some(xml_escape(&twice))
}

// ---------------------------------------------------------------------------
// Streaming page parser: JSON rows go straight into Arrow builders
// ---------------------------------------------------------------------------

/// Where each JSON key of a row goes, for one projection.
#[derive(Debug)]
struct Layout {
    schema: SchemaRef,
    kinds: Vec<Kind>,
    /// JSON key → slot in `targets`.
    keys: HashMap<String, usize>,
    /// Per key: columns that read it, and label columns that fall back to it
    /// when the row has no formatted value (e.g. EntityName "systemuser").
    targets: Vec<(Vec<usize>, Vec<usize>)>,
}

impl Layout {
    fn new(schema: SchemaRef, cols: &[ColSpec]) -> Self {
        fn slot(keys: &mut HashMap<String, usize>, targets: &mut Vec<(Vec<usize>, Vec<usize>)>, key: &str) -> usize {
            if let Some(&s) = keys.get(key) {
                return s;
            }
            targets.push((Vec::new(), Vec::new()));
            keys.insert(key.to_string(), targets.len() - 1);
            targets.len() - 1
        }
        let mut keys = HashMap::new();
        let mut targets = Vec::new();
        for (i, c) in cols.iter().enumerate() {
            let s = slot(&mut keys, &mut targets, &c.json_key);
            targets[s].0.push(i);
            if let Some(raw) = c.json_key.strip_suffix(FORMATTED) {
                let s = slot(&mut keys, &mut targets, raw);
                targets[s].1.push(i);
            }
        }
        Self { schema, kinds: cols.iter().map(|c| c.kind).collect(), keys, targets }
    }
}

/// One JSON scalar of a row.
#[derive(Clone, Debug, PartialEq)]
enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
}

impl<'de> Deserialize<'de> for Cell {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Cell;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_unit<E>(self) -> Result<Cell, E> {
                Ok(Cell::Null)
            }
            fn visit_none<E>(self) -> Result<Cell, E> {
                Ok(Cell::Null)
            }
            fn visit_some<D2: Deserializer<'de>>(self, d: D2) -> Result<Cell, D2::Error> {
                Cell::deserialize(d)
            }
            fn visit_bool<E>(self, v: bool) -> Result<Cell, E> {
                Ok(Cell::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Cell, E> {
                Ok(Cell::Int(v))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Cell, E> {
                Ok(i64::try_from(v).map(Cell::Int).unwrap_or(Cell::Float(v as f64)))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Cell, E> {
                Ok(Cell::Float(v))
            }
            fn visit_str<E>(self, v: &str) -> Result<Cell, E> {
                Ok(Cell::Str(v.to_string()))
            }
            fn visit_string<E>(self, v: String) -> Result<Cell, E> {
                Ok(Cell::Str(v))
            }
            // Never expected in FetchXML rows; kept as JSON text.
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Cell, A::Error> {
                let v = Value::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
                Ok(Cell::Str(v.to_string()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Cell, A::Error> {
                let v = Value::deserialize(serde::de::value::SeqAccessDeserializer::new(seq))?;
                Ok(Cell::Str(v.to_string()))
            }
        }
        d.deserialize_any(V)
    }
}

impl Cell {
    fn int(self) -> Option<i64> {
        match self {
            Cell::Int(n) => Some(n),
            Cell::Float(f) if f.fract() == 0.0 => Some(f as i64),
            Cell::Str(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    fn float(self) -> Option<f64> {
        match self {
            Cell::Int(n) => Some(n as f64),
            Cell::Float(f) => Some(f),
            Cell::Str(s) => s.trim().parse().ok(),
            _ => None,
        }
    }
}

enum ColBuilder {
    Text(StringBuilder),
    Int(Int32Builder),
    BigInt(Int64Builder),
    Float(Float64Builder),
    Bool(BooleanBuilder),
}

impl ColBuilder {
    fn new(kind: Kind) -> Self {
        match kind {
            Kind::Text | Kind::Lookup | Kind::Formatted => ColBuilder::Text(StringBuilder::new()),
            Kind::Int => ColBuilder::Int(Int32Builder::new()),
            Kind::BigInt => ColBuilder::BigInt(Int64Builder::new()),
            Kind::Float => ColBuilder::Float(Float64Builder::new()),
            Kind::Bool => ColBuilder::Bool(BooleanBuilder::new()),
        }
    }

    fn push(&mut self, cell: Option<Cell>) {
        match self {
            ColBuilder::Text(b) => match cell {
                Some(Cell::Str(s)) => b.append_value(s),
                Some(Cell::Int(n)) => b.append_value(n.to_string()),
                Some(Cell::Float(f)) => b.append_value(Value::from(f).to_string()),
                Some(Cell::Bool(x)) => b.append_value(if x { "true" } else { "false" }),
                _ => b.append_null(),
            },
            ColBuilder::Int(b) => b.append_option(cell.and_then(Cell::int).map(|n| n as i32)),
            ColBuilder::BigInt(b) => b.append_option(cell.and_then(Cell::int)),
            ColBuilder::Float(b) => b.append_option(cell.and_then(Cell::float)),
            ColBuilder::Bool(b) => b.append_option(match cell {
                Some(Cell::Bool(x)) => Some(x),
                _ => None,
            }),
        }
    }

    fn finish(&mut self) -> ArrayRef {
        match self {
            ColBuilder::Text(b) => Arc::new(b.finish()),
            ColBuilder::Int(b) => Arc::new(b.finish()),
            ColBuilder::BigInt(b) => Arc::new(b.finish()),
            ColBuilder::Float(b) => Arc::new(b.finish()),
            ColBuilder::Bool(b) => Arc::new(b.finish()),
        }
    }
}

/// Rows parsed so far from one response.
struct Rows<'a> {
    layout: &'a Layout,
    builders: Vec<ColBuilder>,
    /// The current row's values per column, and label fallbacks.
    direct: Vec<Option<Cell>>,
    fallback: Vec<Option<Cell>>,
    n: usize,
}

impl<'a> Rows<'a> {
    fn new(layout: &'a Layout) -> Self {
        let width = layout.kinds.len();
        Self {
            layout,
            builders: layout.kinds.iter().map(|k| ColBuilder::new(*k)).collect(),
            direct: vec![None; width],
            fallback: vec![None; width],
            n: 0,
        }
    }

    fn set(&mut self, slot: usize, cell: Cell) {
        if cell == Cell::Null {
            return;
        }
        let (direct, fallback) = &self.layout.targets[slot];
        // Move the value into its last target instead of copying big strings.
        let mut left = direct.len() + fallback.len();
        let mut cell = Some(cell);
        let mut take = |left: &mut usize| {
            *left -= 1;
            if *left == 0 {
                cell.take()
            } else {
                cell.clone()
            }
        };
        for &c in direct {
            self.direct[c] = take(&mut left);
        }
        for &c in fallback {
            self.fallback[c] = take(&mut left);
        }
    }

    fn end_row(&mut self) {
        for (i, b) in self.builders.iter_mut().enumerate() {
            let fb = self.fallback[i].take();
            b.push(self.direct[i].take().or(fb));
        }
        self.n += 1;
    }

    fn finish(mut self) -> DfResult<RecordBatch> {
        let columns: Vec<ArrayRef> = self.builders.iter_mut().map(|b| b.finish()).collect();
        // A projection can be empty (e.g. COUNT(*)): the row count still matters.
        let options = RecordBatchOptions::new().with_row_count(Some(self.n));
        RecordBatch::try_new_with_options(self.layout.schema.clone(), columns, &options).map_err(DataFusionError::from)
    }
}

/// One FetchXML response: its rows plus the paging annotations.
struct Page {
    batch: RecordBatch,
    more: bool,
    cookie: Option<String>,
    dop_hint: Option<usize>,
}

struct PageSeed<'a>(&'a Layout);

impl<'de, 'a> DeserializeSeed<'de> for PageSeed<'a> {
    type Value = (RecordBatch, bool, Option<String>);
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de, 'a> Visitor<'de> for PageSeed<'a> {
    type Value = (RecordBatch, bool, Option<String>);
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a Web API FetchXML response")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut rows = Rows::new(self.0);
        let (mut more, mut cookie) = (false, None);
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "value" => map.next_value_seed(RowsSeed(&mut rows))?,
                MORE_RECORDS => more = map.next_value::<Option<bool>>()?.unwrap_or(false),
                PAGING_COOKIE => cookie = map.next_value::<Option<String>>()?.as_deref().and_then(next_cookie),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        let batch = rows.finish().map_err(serde::de::Error::custom)?;
        Ok((batch, more, cookie))
    }
}

struct RowsSeed<'a, 'b>(&'b mut Rows<'a>);

impl<'de, 'a, 'b> DeserializeSeed<'de> for RowsSeed<'a, 'b> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de, 'a, 'b> Visitor<'de> for RowsSeed<'a, 'b> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of rows")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while seq.next_element_seed(RowSeed(&mut *self.0))?.is_some() {}
        Ok(())
    }
}

struct RowSeed<'a, 'b>(&'b mut Rows<'a>);

impl<'de, 'a, 'b> DeserializeSeed<'de> for RowSeed<'a, 'b> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de, 'a, 'b> Visitor<'de> for RowSeed<'a, 'b> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a row object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let layout = self.0.layout;
        while let Some(slot) = map.next_key_seed(KeySeed(&layout.keys))? {
            match slot {
                Some(s) => {
                    let cell: Cell = map.next_value()?;
                    self.0.set(s, cell);
                }
                // Columns nobody selected (`@odata.etag`, other annotations…).
                None => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        self.0.end_row();
        Ok(())
    }
}

/// Looks a row key up without allocating it.
struct KeySeed<'a>(&'a HashMap<String, usize>);

impl<'de, 'a> DeserializeSeed<'de> for KeySeed<'a> {
    type Value = Option<usize>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Option<usize>, D::Error> {
        d.deserialize_str(self)
    }
}

impl<'de, 'a> Visitor<'de> for KeySeed<'a> {
    type Value = Option<usize>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a column name")
    }
    fn visit_str<E>(self, v: &str) -> Result<Option<usize>, E> {
        Ok(self.0.get(v).copied())
    }
}

fn parse_page(r: &mut dyn std::io::Read, layout: &Layout) -> std::io::Result<(RecordBatch, bool, Option<String>)> {
    let mut de = serde_json::Deserializer::from_reader(r);
    let out = PageSeed(layout).deserialize(&mut de)?;
    de.end()?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Table provider
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct DataverseTable {
    ctx: Arc<EngineCtx>,
    name: String,
    entity_set: String,
    primary_id: String,
    /// Rows live in Dataverse SQL (Standard / Activity table): key ranges can
    /// be read in parallel. Virtual (e.g. `aaduser` via Microsoft Graph) and
    /// elastic tables reject `ge`/`le` on the key ("filter property that is
    /// not indexed").
    sql_backed: bool,
    schema: SchemaRef,
    cols: Vec<ColSpec>,
    /// `(attribute, descending)` pushed down from `ORDER BY … TOP n`.
    order: Vec<(String, bool)>,
    /// Row cap that comes with `order` (the Sort node sits above the scan,
    /// so DataFusion can't hand it to `scan` as a limit).
    top: Option<usize>,
}

/// Builds the Arrow schema + column specs for a table's readable attributes,
/// adding a `<attr>name` label column for choice/lookup/boolean attributes.
fn build_columns(attrs: &[(String, String)]) -> (Schema, Vec<ColSpec>) {
    let mut fields: Vec<Field> = Vec::with_capacity(attrs.len() * 2);
    let mut cols: Vec<ColSpec> = Vec::with_capacity(attrs.len() * 2);
    // Real (fetchable) attributes first; `Virtual` ones are never valid in
    // FetchXML `<attribute>`, so they are only used to name label columns.
    let real: Vec<&(String, String)> = attrs.iter().filter(|(_, ty)| ty != "Virtual").collect();
    let mut seen: std::collections::HashSet<String> = real.iter().map(|(n, _)| n.clone()).collect();

    let mut push_label = |fields: &mut Vec<Field>, cols: &mut Vec<ColSpec>, base: &str, base_key: &str, label: String| {
        if seen.insert(label.clone()) {
            fields.push(Field::new(label, DataType::Utf8, true));
            cols.push(ColSpec {
                fetch_attr: base.to_string(),
                json_key: format!("{}{}", base_key, FORMATTED),
                kind: Kind::Formatted,
                push: Push::Never,
                orderable: false,
            });
        }
    };

    let mut base_keys: HashMap<String, String> = HashMap::with_capacity(real.len());
    for (logical, ty) in &real {
        let k = kind_of(ty);
        let json_key = match k {
            Kind::Lookup => format!("_{}_value", logical),
            _ => logical.clone(),
        };
        let (push, orderable) = capabilities(ty);
        fields.push(Field::new(logical.clone(), arrow_type(k), true));
        cols.push(ColSpec { fetch_attr: logical.clone(), json_key: json_key.clone(), kind: k, push, orderable });
        base_keys.insert(logical.clone(), json_key.clone());

        if has_label(ty) {
            push_label(&mut fields, &mut cols, logical, &json_key, format!("{}name", logical));
        }
    }

    // Any `<x>name` virtual attribute Dataverse itself declares (e.g.
    // `owneridtypename`, `createdbyname`) — exactly what TDS exposes.
    for (logical, ty) in attrs {
        if ty != "Virtual" {
            continue;
        }
        if let Some(base) = logical.strip_suffix("name") {
            if let Some(base_key) = base_keys.get(base) {
                push_label(&mut fields, &mut cols, base, base_key, logical.clone());
            }
        }
    }
    (Schema::new(fields), cols)
}

impl DataverseTable {
    fn load(ctx: Arc<EngineCtx>, name: &str) -> AppResult<Self> {
        let t0 = std::time::Instant::now();
        let info = metadata::entity_info(&ctx.host, &ctx.token, name)?;
        let attrs = metadata::readable_attributes(&ctx.host, &ctx.token, name)?;
        ctx.record(|s| s.metadata_ms += t0.elapsed().as_millis() as u64);
        let (schema, cols) = build_columns(&attrs);
        let sql_backed = info.sql_backed();
        Ok(Self {
            ctx,
            name: name.to_string(),
            entity_set: info.entity_set,
            sql_backed,
            primary_id: info.primary_id,
            schema: Arc::new(schema),
            cols,
            order: Vec::new(),
            top: None,
        })
    }

    fn col_spec(&self, name: &str) -> Option<&ColSpec> {
        self.schema.index_of(name).ok().map(|i| &self.cols[i])
    }

    fn resolve(&self, name: &str) -> Option<(String, Push)> {
        self.col_spec(name).map(|c| (c.fetch_attr.clone(), c.push))
    }

    /// Whether one `<fetch top="cap">` request returns all `cap` rows. Virtual
    /// tables page on their own terms (`aaduser` answers 100 rows at a time
    /// and ignores `top`), so they always follow the paging cookie.
    fn one_request(&self, cap: usize) -> bool {
        cap <= self.ctx.page_size && self.sql_backed
    }

    /// The `<order>` elements for a scan capped at `cap` rows.
    fn order_xml(&self, cap: usize) -> String {
        let mut xml: String = self
            .order
            .iter()
            .map(|(a, desc)| format!("<order attribute=\"{}\" descending=\"{}\"/>", a, desc))
            .collect();
        // Paging is only consistent with a unique sort key at the end.
        if !self.one_request(cap) && !self.order.iter().any(|(a, _)| *a == self.primary_id) {
            xml.push_str(&format!("<order attribute=\"{}\"/>", self.primary_id));
        }
        xml
    }

    /// `<fetch …>` for page `page` of a scan capped at `cap` rows (`top` and
    /// paging are mutually exclusive in FetchXML).
    fn fetch_head(&self, cap: usize, page: usize, cookie: Option<&str>) -> String {
        let size = self.ctx.page_size;
        if self.one_request(cap) {
            format!("<fetch top=\"{}\">", cap)
        } else {
            match cookie {
                Some(c) => format!("<fetch count=\"{}\" page=\"{}\" paging-cookie=\"{}\">", size, page, c),
                None => format!("<fetch count=\"{}\" page=\"{}\">", size, page),
            }
        }
    }

    fn request(&self, fetch: &str, prefer: &str, kind: Req, layout: &Layout) -> AppResult<Page> {
        let ((batch, more, cookie), dop_hint) =
            self.ctx.fetchxml(&self.entity_set, fetch, prefer, kind, |r| parse_page(r, layout))?;
        Ok(Page { batch, more, cookie, dop_hint })
    }

    /// One page of the plain sequential scan.
    fn fetch_page(&self, spec: &PageSpec, page: usize, cookie: Option<&str>) -> AppResult<Page> {
        let fetch = format!(
            "{}<entity name=\"{}\">{}{}{}</entity></fetch>",
            self.fetch_head(spec.cap, page, cookie),
            self.name,
            spec.attr_xml,
            spec.filter_xml,
            spec.order_xml
        );
        self.request(&fetch, spec.prefer, Req::Rows, &spec.layout)
    }

    /// One page of primary keys (same filters, key order) — the cheap first
    /// pass that tells the parallel reader how to split the rows.
    fn fetch_keys(&self, spec: &PageSpec, page: usize, cookie: Option<&str>) -> AppResult<Page> {
        let fetch = format!(
            "{}<entity name=\"{}\"><attribute name=\"{}\"/>{}<order attribute=\"{}\"/></entity></fetch>",
            self.fetch_head(spec.cap, page, cookie),
            self.name,
            self.primary_id,
            spec.filter_xml,
            self.primary_id
        );
        self.request(&fetch, PREFER_PAGING, Req::Keys, &spec.key_layout)
    }

    /// Every selected column for the rows whose key is in `[first, last]`.
    fn fetch_range(&self, spec: &PageSpec, first: &str, last: &str) -> AppResult<Page> {
        let fetch = format!(
            "<fetch top=\"{}\"><entity name=\"{}\">{}<filter type=\"and\">\
             <condition attribute=\"{}\" operator=\"ge\" value=\"{}\"/>\
             <condition attribute=\"{}\" operator=\"le\" value=\"{}\"/>{}</filter>\
             <order attribute=\"{}\"/></entity></fetch>",
            self.ctx.page_size,
            self.name,
            spec.attr_xml,
            self.primary_id,
            xml_escape(first),
            self.primary_id,
            xml_escape(last),
            spec.filter_xml,
            self.primary_id
        );
        self.request(&fetch, spec.prefer, Req::Rows, &spec.layout)
    }
}

#[async_trait]
impl TableProvider for DataverseTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn table_type(&self) -> TableType {
        TableType::Base
    }

    fn supports_filters_pushdown(&self, filters: &[&Expr]) -> DfResult<Vec<TableProviderFilterPushDown>> {
        // Exact filters leave no in-memory Filter above the scan, which lets
        // TOP / ORDER BY … TOP reach the server too. Inexact ones are sent to
        // the server and re-checked by DataFusion.
        let resolve = |n: &str| self.resolve(n);
        Ok(filters
            .iter()
            .map(|f| match filter_to_xml(f, &resolve) {
                Some((_, true)) => TableProviderFilterPushDown::Exact,
                Some((_, false)) => TableProviderFilterPushDown::Inexact,
                None => TableProviderFilterPushDown::Unsupported,
            })
            .collect())
    }

    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> DfResult<Arc<dyn ExecutionPlan>> {
        let indices: Vec<usize> = match projection {
            Some(p) => p.clone(),
            None => (0..self.schema.fields().len()).collect(),
        };
        let projected = Arc::new(self.schema.project(&indices)?);
        let cols: Vec<ColSpec> = indices.iter().map(|&i| self.cols[i].clone()).collect();
        // Label columns share the FetchXML attribute of their base column.
        let mut attributes: Vec<String> = Vec::with_capacity(cols.len());
        for c in &cols {
            if !attributes.contains(&c.fetch_attr) {
                attributes.push(c.fetch_attr.clone());
            }
        }

        let resolve = |n: &str| self.resolve(n);
        let translated: Vec<(String, bool)> = filters.iter().filter_map(|f| filter_to_xml(f, &resolve)).collect();
        let filter_xml = if translated.is_empty() {
            String::new()
        } else {
            let conditions: String = translated.iter().map(|(x, _)| x.as_str()).collect();
            format!("<filter type=\"and\">{}</filter>", conditions)
        };

        // Only cap rows on the server when it evaluates every filter exactly.
        let all_exact = translated.len() == filters.len() && translated.iter().all(|(_, exact)| *exact);
        let cap = if all_exact {
            match (limit, self.top) {
                (Some(a), Some(b)) => a.min(b),
                (a, b) => a.or(b).unwrap_or(usize::MAX),
            }
        } else {
            usize::MAX
        };
        let _ = state;
        // No columns at all (e.g. COUNT(*)): FetchXML without `<attribute>`
        // would return every column, so ask for the key only.
        if attributes.is_empty() {
            attributes.push(self.primary_id.clone());
        }
        let labels = cols.iter().any(|c| c.kind == Kind::Formatted);
        let key_schema = Arc::new(Schema::new(vec![Field::new(self.primary_id.clone(), DataType::Utf8, true)]));
        let key_col = ColSpec {
            fetch_attr: self.primary_id.clone(),
            json_key: self.primary_id.clone(),
            kind: Kind::Text,
            push: Push::Exact,
            orderable: true,
        };
        // Parallel reads split the rows into key ranges. That needs a big read
        // in key order: a pushed ORDER BY keeps plain paging, and a key-only
        // read is exactly what the key scan already returns.
        let parallel = self.ctx.workers != 1
            && self.sql_backed
            && self.order.is_empty()
            && cap > self.ctx.parallel_min
            && attributes.iter().any(|a| *a != self.primary_id);

        let spec = Arc::new(PageSpec {
            table: self.clone(),
            attr_xml: attributes.iter().map(|a| format!("<attribute name=\"{}\"/>", a)).collect(),
            filter_xml,
            order_xml: self.order_xml(cap),
            cap,
            prefer: if labels { PREFER_WITH_LABELS } else { PREFER_PAGING },
            layout: Layout::new(projected.clone(), &cols),
            key_layout: Layout::new(key_schema, &[key_col]),
            parallel,
        });
        let props = PlanProperties::new(
            EquivalenceProperties::new(projected.clone()),
            Partitioning::UnknownPartitioning(1),
            EmissionType::Incremental,
            Boundedness::Bounded,
        );
        Ok(Arc::new(DataverseExec { spec, schema: projected, props: Arc::new(props) }))
    }
}

/// Everything a scan's FetchXML requests need besides page number / cookie.
#[derive(Debug)]
struct PageSpec {
    table: DataverseTable,
    attr_xml: String,
    filter_xml: String,
    order_xml: String,
    cap: usize,
    prefer: &'static str,
    /// JSON → Arrow for the selected columns, and for the key scan.
    layout: Layout,
    key_layout: Layout,
    /// Read key ranges in parallel instead of paging sequentially.
    parallel: bool,
}

/// Physical scan that yields record batches as FetchXML responses arrive, so
/// rows reach the caller while later ones are still downloading.
#[derive(Debug)]
struct DataverseExec {
    spec: Arc<PageSpec>,
    schema: SchemaRef,
    props: Arc<PlanProperties>,
}

impl DisplayAs for DataverseExec {
    fn fmt_as(&self, _t: DisplayFormatType, f: &mut fmt::Formatter) -> fmt::Result {
        let mode = if self.spec.parallel { "parallel key ranges" } else { "paged" };
        write!(f, "DataverseExec: table={} (FetchXML, {})", self.spec.table.name, mode)
    }
}

impl ExecutionPlan for DataverseExec {
    fn name(&self) -> &str {
        "DataverseExec"
    }

    fn properties(&self) -> &Arc<PlanProperties> {
        &self.props
    }

    fn apply_expressions(
        &self,
        _f: &mut dyn FnMut(&Arc<dyn PhysicalExpr>) -> DfResult<TreeNodeRecursion>,
    ) -> DfResult<TreeNodeRecursion> {
        // No expressions of its own — the filters were turned into FetchXML.
        Ok(TreeNodeRecursion::Continue)
    }

    fn children(&self) -> Vec<&Arc<dyn ExecutionPlan>> {
        vec![]
    }

    fn with_new_children(self: Arc<Self>, _children: Vec<Arc<dyn ExecutionPlan>>) -> DfResult<Arc<dyn ExecutionPlan>> {
        Ok(self)
    }

    fn execute(&self, _partition: usize, _context: Arc<TaskContext>) -> DfResult<SendableRecordBatchStream> {
        let stream = if self.spec.parallel {
            parallel_stream(self.spec.clone())
        } else {
            sequential_stream(self.spec.clone())
        };
        Ok(Box::pin(RecordBatchStreamAdapter::new(self.schema.clone(), stream)))
    }
}

// ---------------------------------------------------------------------------
// Reading rows: sequential paging, or parallel key ranges
// ---------------------------------------------------------------------------

fn join<T>(r: Result<AppResult<T>, tokio::task::JoinError>) -> DfResult<T> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(DataFusionError::Execution(e.to_string())),
        Err(e) => Err(DataFusionError::External(Box::new(e))),
    }
}

/// HTTP calls are blocking (ureq); keep them off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> DfResult<T> {
    join(tokio::task::spawn_blocking(f).await)
}

fn first_rows(batch: RecordBatch, n: usize) -> RecordBatch {
    if batch.num_rows() > n {
        batch.slice(0, n)
    } else {
        batch
    }
}

/// Up to `max` keys from a key-scan page.
fn key_ids(batch: &RecordBatch, max: usize) -> Vec<String> {
    let Some(col) = batch.columns().first().and_then(|c| c.as_any().downcast_ref::<StringArray>()) else {
        return Vec::new();
    };
    (0..col.len().min(max)).filter(|&i| !col.is_null(i)).map(|i| col.value(i).to_string()).collect()
}

struct Cursor {
    page: usize,
    cookie: Option<String>,
    fetched: usize,
    done: bool,
}

/// One request at a time, following the paging cookie.
fn sequential_stream(spec: Arc<PageSpec>) -> BoxStream<'static, DfResult<RecordBatch>> {
    spec.table.ctx.record(|s| s.threads = s.threads.max(1));
    let cursor = Cursor { page: 1, cookie: None, fetched: 0, done: false };
    futures::stream::unfold(cursor, move |mut cur| {
        let spec = spec.clone();
        async move {
            if cur.done {
                return None;
            }
            let (page, cookie) = (cur.page, cur.cookie.take());
            let s = spec.clone();
            let result = match blocking(move || s.table.fetch_page(&s, page, cookie.as_deref())).await {
                Ok(p) => p,
                Err(e) => {
                    cur.done = true;
                    return Some((Err(e), cur));
                }
            };
            let batch = first_rows(result.batch, spec.cap.saturating_sub(cur.fetched));
            cur.fetched += batch.num_rows();
            cur.cookie = result.cookie;
            cur.page += 1;
            // Without a paging cookie Dataverse falls back to simple paging
            // (page numbers only), which the next request then uses.
            cur.done = spec.table.one_request(spec.cap) || !result.more || cur.fetched >= spec.cap;
            Some((Ok(batch), cur))
        }
    })
    .boxed()
}

/// Tells range requests that haven't started yet that nobody wants their
/// rows any more (LIMIT reached, an error, …).
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Parallel read: a cheap key-only scan (same filters, key order) runs ahead
/// and each page of keys is cut into `[first, last]` ranges, which up to
/// `threads` requests download at once. Batches come out as ranges finish,
/// so without an ORDER BY the row order isn't the key order.
fn parallel_stream(spec: Arc<PageSpec>) -> BoxStream<'static, DfResult<RecordBatch>> {
    let stop = Arc::new(AtomicBool::new(false));
    let guard = StopOnDrop(stop.clone());
    let started = async move {
        let s = spec.clone();
        let page = match blocking(move || s.table.fetch_keys(&s, 1, None)).await {
            Ok(p) => p,
            Err(e) => return futures::stream::iter(vec![Err(e)]).boxed(),
        };
        let ctx = spec.table.ctx.clone();
        let threads = read_threads(ctx.workers, page.dop_hint);
        ctx.record(|s| s.threads = s.threads.max(threads));
        ctx.limiter.set(threads);
        let range_min = ctx.range_min;

        let cap = spec.cap;
        let first_ids = key_ids(&page.batch, cap);
        let cursor = Cursor {
            page: 2,
            cookie: page.cookie,
            fetched: first_ids.len(),
            done: cap <= ctx.page_size || !page.more || first_ids.len() >= cap,
        };
        let key_spec = spec.clone();
        let more_keys = futures::stream::unfold(cursor, move |mut cur| {
            let spec = key_spec.clone();
            async move {
                if cur.done {
                    return None;
                }
                let (p, c) = (cur.page, cur.cookie.take());
                let s = spec.clone();
                match blocking(move || s.table.fetch_keys(&s, p, c.as_deref())).await {
                    Err(e) => {
                        cur.done = true;
                        Some((Err(e), cur))
                    }
                    Ok(page) => {
                        let ids = key_ids(&page.batch, spec.cap.saturating_sub(cur.fetched));
                        cur.fetched += ids.len();
                        cur.cookie = page.cookie;
                        cur.page += 1;
                        cur.done = !page.more || cur.fetched >= spec.cap;
                        Some((Ok(ids), cur))
                    }
                }
            }
        });

        let range_spec = spec.clone();
        futures::stream::once(async move { Ok::<_, DataFusionError>(first_ids) })
            .chain(more_keys)
            .flat_map(move |ids| {
                let ranges: Vec<DfResult<(String, String)>> = match ids {
                    Ok(ids) => {
                        // Every thread gets a share of this page of keys.
                        let per_range = range_rows(ids.len(), range_min, threads);
                        ids.chunks(per_range).map(|c| Ok((c[0].clone(), c[c.len() - 1].clone()))).collect()
                    }
                    Err(e) => vec![Err(e)],
                };
                futures::stream::iter(ranges)
            })
            .map(move |range| {
                let spec = range_spec.clone();
                let stop = stop.clone();
                // Starts downloading as soon as `buffer_unordered` pulls it.
                let task = range.map(|(first, last)| {
                    tokio::task::spawn_blocking(move || {
                        // Fewer may run than were started once throttled.
                        let _permit = spec.table.ctx.limiter.acquire();
                        if stop.load(Ordering::Relaxed) {
                            return Err(AppError::msg("cancelled"));
                        }
                        spec.table.fetch_range(&spec, &first, &last).map(|p| p.batch)
                    })
                });
                async move {
                    match task {
                        Err(e) => Err(e),
                        Ok(handle) => join(handle.await),
                    }
                }
            })
            .buffer_unordered(threads)
            .boxed()
    };
    futures::stream::once(started)
        .flatten()
        .map(move |batch| {
            let _alive = &guard;
            batch
        })
        .boxed()
}

// ---------------------------------------------------------------------------
// ORDER BY … TOP push-down
// ---------------------------------------------------------------------------

/// DataFusion can't hand a sort to a `TableProvider`, so after optimizing,
/// `Sort(fetch = n)` over a lone Dataverse scan (through projections and
/// aliases only — no in-memory filter, join or aggregate) gets a copy of the
/// table that asks FetchXML for the first `n` rows in that order. The Sort
/// node stays and re-sorts those `n` rows.
fn push_sort_into_scans(plan: LogicalPlan) -> DfResult<LogicalPlan> {
    plan.transform_down(|node| {
        let LogicalPlan::Sort(sort) = &node else {
            return Ok(Transformed::no(node));
        };
        let (Some(fetch), Some(keys)) = (sort.fetch, sort_keys(&sort.expr)) else {
            return Ok(Transformed::no(node));
        };
        let expr = sort.expr.clone();
        match with_pushed_order(&sort.input, &keys, fetch)? {
            Some(input) => Ok(Transformed::yes(LogicalPlan::Sort(Sort {
                expr,
                input: Arc::new(input),
                fetch: Some(fetch),
            }))),
            None => Ok(Transformed::no(node)),
        }
    })
    .map(|t| t.data)
}

/// Plain-column sort keys whose NULL placement matches FetchXML (NULLs lowest).
fn sort_keys(exprs: &[SortExpr]) -> Option<Vec<(Column, bool)>> {
    exprs
        .iter()
        .map(|s| match &s.expr {
            Expr::Column(c) if s.nulls_first == s.asc => Some((c.clone(), !s.asc)),
            _ => None,
        })
        .collect()
}

fn with_pushed_order(plan: &LogicalPlan, keys: &[(Column, bool)], fetch: usize) -> DfResult<Option<LogicalPlan>> {
    match plan {
        LogicalPlan::Projection(p) => {
            // Follow each key back to the column it projects.
            let mut inner = Vec::with_capacity(keys.len());
            for (c, desc) in keys {
                let Ok(i) = p.schema.index_of_column(c) else { return Ok(None) };
                match p.expr[i].clone().unalias() {
                    Expr::Column(src) => inner.push((src, *desc)),
                    _ => return Ok(None),
                }
            }
            Ok(match with_pushed_order(&p.input, &inner, fetch)? {
                Some(input) => Some(LogicalPlan::Projection(Projection::try_new_with_schema(
                    p.expr.clone(),
                    Arc::new(input),
                    p.schema.clone(),
                )?)),
                None => None,
            })
        }
        LogicalPlan::SubqueryAlias(a) => Ok(match with_pushed_order(&a.input, keys, fetch)? {
            Some(input) => Some(LogicalPlan::SubqueryAlias(SubqueryAlias::try_new(Arc::new(input), a.alias.clone())?)),
            None => None,
        }),
        LogicalPlan::TableScan(scan) => {
            let Ok(provider) = source_as_provider(&scan.source) else { return Ok(None) };
            let Some(table) = provider.downcast_ref::<DataverseTable>() else { return Ok(None) };
            let resolve = |n: &str| table.resolve(n);
            if !scan.filters.iter().all(|f| matches!(filter_to_xml(f, &resolve), Some((_, true)))) {
                return Ok(None);
            }
            let mut order = Vec::with_capacity(keys.len());
            for (c, desc) in keys {
                match table.col_spec(&c.name) {
                    Some(spec) if spec.orderable => order.push((spec.fetch_attr.clone(), *desc)),
                    _ => return Ok(None),
                }
            }
            let mut pushed = table.clone();
            pushed.order = order;
            pushed.top = Some(fetch);
            Ok(Some(LogicalPlan::TableScan(TableScan {
                source: provider_as_source(Arc::new(pushed)),
                ..scan.clone()
            })))
        }
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Schema provider: resolves table names lazily against Dataverse metadata
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct DataverseSchema {
    ctx: Arc<EngineCtx>,
    cache: Mutex<HashMap<String, Arc<dyn TableProvider>>>,
}

#[async_trait]
impl SchemaProvider for DataverseSchema {
    fn table_names(&self) -> Vec<String> {
        self.cache.lock().map(|c| c.keys().cloned().collect()).unwrap_or_default()
    }

    fn register_table(
        &self,
        name: String,
        table: Arc<dyn TableProvider>,
    ) -> DfResult<Option<Arc<dyn TableProvider>>> {
        Ok(self
            .cache
            .lock()
            .ok()
            .and_then(|mut c| c.insert(name.to_ascii_lowercase(), table)))
    }

    async fn table(&self, name: &str) -> DfResult<Option<Arc<dyn TableProvider>>> {
        let key = name.to_ascii_lowercase();
        if let Some(t) = self.cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
            return Ok(Some(t));
        }
        let ctx = self.ctx.clone();
        let k = key.clone();
        let loaded = tokio::task::spawn_blocking(move || DataverseTable::load(ctx, &k))
            .await
            .map_err(|e| DataFusionError::External(Box::new(e)))?;
        match loaded {
            Ok(t) => {
                let t: Arc<dyn TableProvider> = Arc::new(t);
                if let Ok(mut c) = self.cache.lock() {
                    c.insert(key, t.clone());
                }
                Ok(Some(t))
            }
            // Surface the real reason (metadata 404, permission, …) instead of
            // a bare "table not found".
            Err(e) => Err(DataFusionError::Plan(format!("Cannot load table '{}': {}", key, e))),
        }
    }

    fn table_exist(&self, _name: &str) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// `SELECT TOP n …` (T-SQL) → `SELECT … LIMIT n` for DataFusion.
fn rewrite_top(sql: &str) -> String {
    let re = regex::Regex::new(r"(?i)\bSELECT\s+TOP\s*\(?\s*(\d+)\s*\)?\s+").unwrap();
    if let Some(m) = re.captures(sql) {
        let n = m[1].to_string();
        let without = re.replace(sql, "SELECT ").to_string();
        let trimmed = without.trim_end().trim_end_matches(';').to_string();
        format!("{} LIMIT {}", trimmed, n)
    } else {
        sql.to_string()
    }
}

fn batch_rows(batch: &RecordBatch) -> Vec<Vec<Value>> {
    (0..batch.num_rows())
        .map(|i| batch.columns().iter().map(|col| cell_json(col, i)).collect())
        .collect()
}

fn cell_json(col: &ArrayRef, i: usize) -> Value {
    if col.is_null(i) {
        return Value::Null;
    }
    let any = col.as_any();
    if let Some(a) = any.downcast_ref::<StringArray>() {
        return Value::from(a.value(i));
    }
    if let Some(a) = any.downcast_ref::<Int32Array>() {
        return Value::from(a.value(i));
    }
    if let Some(a) = any.downcast_ref::<Int64Array>() {
        return Value::from(a.value(i));
    }
    if let Some(a) = any.downcast_ref::<Float64Array>() {
        return serde_json::Number::from_f64(a.value(i)).map(Value::Number).unwrap_or(Value::Null);
    }
    if let Some(a) = any.downcast_ref::<BooleanArray>() {
        return Value::Bool(a.value(i));
    }
    array_value_to_string(col, i).map(Value::from).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::logical_expr::{col, lit};

    #[test]
    fn top_becomes_limit() {
        assert_eq!(rewrite_top("SELECT TOP 5 a FROM t;"), "SELECT a FROM t LIMIT 5");
        assert_eq!(rewrite_top("select top(10) a from t"), "SELECT a from t LIMIT 10");
        assert_eq!(rewrite_top("SELECT a FROM t"), "SELECT a FROM t");
    }

    /// Every column is an exact, same-named attribute except `created*`
    /// (inexact) and `*label` (never pushed).
    fn resolve_test(name: &str) -> Option<(String, Push)> {
        let push = if name.starts_with("created") {
            Push::Inexact
        } else if name.ends_with("label") {
            Push::Never
        } else {
            Push::Exact
        };
        Some((name.to_string(), push))
    }

    #[test]
    fn filters_translate_to_fetchxml() {
        let x = |e: &Expr| filter_to_xml(e, &resolve_test);
        let e = col("statecode").eq(lit(0)).and(col("fullname").like(lit("A%")));
        assert_eq!(
            x(&e).unwrap(),
            (
                r#"<filter type="and"><condition attribute="statecode" operator="eq" value="0"/><condition attribute="fullname" operator="like" value="A%"/></filter>"#.to_string(),
                true
            )
        );
        assert_eq!(x(&col("x").is_null()).unwrap().0, r#"<condition attribute="x" operator="null"/>"#);
        // literal on the left flips the operator
        assert_eq!(x(&lit(5).gt(col("n"))).unwrap().0, r#"<condition attribute="n" operator="lt" value="5"/>"#);
        assert_eq!(
            x(&col("s").in_list(vec![lit(1), lit(2)], false)).unwrap().0,
            r#"<condition attribute="s" operator="in"><value>1</value><value>2</value></condition>"#
        );
        // column-to-column comparisons stay in DataFusion
        assert!(x(&col("a").eq(col("b"))).is_none());
    }

    #[test]
    fn not_equal_excludes_nulls_like_tsql() {
        assert_eq!(
            filter_to_xml(&col("name").not_eq(lit("x")), &resolve_test).unwrap().0,
            r#"<filter type="and"><condition attribute="name" operator="ne" value="x"/><condition attribute="name" operator="not-null"/></filter>"#
        );
    }

    #[test]
    fn push_down_exactness_follows_the_column() {
        let x = |e: &Expr| filter_to_xml(e, &resolve_test);
        assert_eq!(x(&col("createdon").gt(lit("2024-01-01"))).unwrap().1, false);
        // one inexact side makes the whole OR inexact
        assert_eq!(x(&col("name").eq(lit("a")).or(col("createdon").is_null())).unwrap().1, true);
        assert_eq!(x(&col("name").eq(lit("a")).or(col("createdon").gt(lit("2024")))).unwrap().1, false);
        // label columns never reach FetchXML
        assert!(x(&col("statuslabel").eq(lit("Active"))).is_none());
        assert!(x(&col("name").eq(lit("a")).and(col("statuslabel").eq(lit("Active")))).is_none());
    }

    /// A table whose metadata is already known, so planning needs no network.
    fn offline_ctx() -> (SessionContext, Arc<EngineCtx>) {
        offline_ctx_at("example.invalid")
    }

    fn offline_ctx_at(host: &str) -> (SessionContext, Arc<EngineCtx>) {
        offline_ctx_with(host, |_| {})
    }

    fn offline_ctx_with(host: &str, tune: impl FnOnce(&mut EngineCtx)) -> (SessionContext, Arc<EngineCtx>) {
        offline_ctx_table(host, tune, true)
    }

    /// `sql_backed: false` = a virtual / elastic table.
    fn offline_ctx_table(
        host: &str,
        tune: impl FnOnce(&mut EngineCtx),
        sql_backed: bool,
    ) -> (SessionContext, Arc<EngineCtx>) {
        let attrs: Vec<(String, String)> = [
            ("accountid", "Uniqueidentifier"),
            ("createdon", "DateTime"),
            ("name", "String"),
            ("revenue", "Money"),
            ("statecode", "State"),
        ]
        .iter()
        .map(|(n, t)| (n.to_string(), t.to_string()))
        .collect();
        let (schema, cols) = build_columns(&attrs);
        let mut engine = EngineCtx::new(host, "", 0);
        tune(&mut engine);
        let engine = Arc::new(engine);
        let table = DataverseTable {
            ctx: engine.clone(),
            name: "account".into(),
            entity_set: "accounts".into(),
            primary_id: "accountid".into(),
            sql_backed,
            schema: Arc::new(schema),
            cols,
            order: Vec::new(),
            top: None,
        };
        let mut cache: HashMap<String, Arc<dyn TableProvider>> = HashMap::new();
        cache.insert("account".into(), Arc::new(table));
        (session(engine.clone(), cache).unwrap(), engine)
    }

    /// A fake Web API that serves two FetchXML pages (3 rows, then 1) and
    /// records the URLs it was asked for.
    fn fake_pages() -> (String, Arc<Mutex<Vec<String>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let host = format!("http://{}", server.server_addr());
        let urls = Arc::new(Mutex::new(Vec::new()));
        let seen = urls.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let n = {
                    let mut u = seen.lock().unwrap();
                    u.push(request.url().to_string());
                    u.len()
                };
                let body = if n == 1 {
                    r#"{"value":[{"name":"a"},{"name":"b"},{"name":"c"}],"@Microsoft.Dynamics.CRM.morerecords":true,"@Microsoft.Dynamics.CRM.fetchxmlpagingcookie":"<cookie pagenumber=\"2\" pagingcookie=\"%253ccookie%2520page%253d%25221%2522%253e%253c%252fcookie%253e\" istracking=\"False\" />"}"#
                } else {
                    r#"{"value":[{"name":"d"}]}"#
                };
                let _ = request.respond(
                    tiny_http::Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap()),
                );
            }
        });
        (host, urls)
    }

    #[tokio::test]
    async fn pages_stream_as_they_arrive() {
        let (host, urls) = fake_pages();
        // Sequential paging (parallel reads are covered below).
        let (ctx, engine) = offline_ctx_with(&host, |e| e.workers = 1);
        let pages = Arc::new(Mutex::new(Vec::<usize>::new()));
        let seen = pages.clone();
        let on_batch: OnBatch = Arc::new(move |eng: &str, cols: &[ColumnInfo], rows: &[Vec<Value>]| {
            assert_eq!(eng, "fetchxml");
            assert_eq!(cols[0].name, "name");
            seen.lock().unwrap().push(rows.len());
        });
        let r = run_in(&ctx, &engine, "SELECT name FROM account", 50_000, Some(on_batch)).await.unwrap();
        assert_eq!(*pages.lock().unwrap(), vec![3, 1]);
        assert_eq!(r.row_count, 4);
        assert_eq!(r.rows[3][0], Value::from("d"));
        let t = r.timings.unwrap();
        assert_eq!(t.pages, Some(2));
        assert!(t.bytes.unwrap() > 0);
        // the second request carried the decoded cookie back
        let urls = urls.lock().unwrap();
        assert_eq!(urls.len(), 2);
        let second = percent_decode_str(&urls[1]).decode_utf8_lossy().to_string();
        assert!(second.contains(r#"page="2""#), "{}", second);
        assert!(second.contains(r#"paging-cookie="&lt;cookie page=&quot;1&quot;&gt;&lt;/cookie&gt;""#), "{}", second);
    }

    /// (order, top) handed to the Dataverse scan, or `None` if nothing was pushed.
    async fn pushed(sql: &str) -> Option<(Vec<(String, bool)>, Option<usize>)> {
        let (ctx, _) = offline_ctx();
        let df = ctx.sql(&rewrite_top(sql)).await.unwrap().limit(0, Some(50_001)).unwrap();
        let state = ctx.state();
        let plan = push_sort_into_scans(state.optimize(df.logical_plan()).unwrap()).unwrap();
        // Physical planning optimizes again (and would run the scan, i.e. hit
        // the network): the push-down must survive that second pass.
        let plan = state.optimize(&plan).unwrap();
        let mut found = None;
        plan.apply(|node| {
            if let LogicalPlan::TableScan(scan) = node {
                if let Ok(p) = source_as_provider(&scan.source) {
                    if let Some(t) = p.downcast_ref::<DataverseTable>() {
                        if t.top.is_some() {
                            found = Some((t.order.clone(), t.top));
                        }
                    }
                }
            }
            Ok(datafusion::common::tree_node::TreeNodeRecursion::Continue)
        })
        .unwrap();
        found
    }

    /// `fetch` DataFusion itself hands to the scan (plain TOP / row cap).
    async fn scan_fetch(sql: &str) -> Option<usize> {
        let (ctx, _) = offline_ctx();
        let df = ctx.sql(&rewrite_top(sql)).await.unwrap().limit(0, Some(50_001)).unwrap();
        let plan = ctx.state().optimize(df.logical_plan()).unwrap();
        let mut fetch = None;
        plan.apply(|node| {
            if let LogicalPlan::TableScan(scan) = node {
                fetch = scan.fetch;
            }
            Ok(datafusion::common::tree_node::TreeNodeRecursion::Continue)
        })
        .unwrap();
        fetch
    }

    #[tokio::test]
    async fn top_with_exact_filters_reaches_fetchxml() {
        assert_eq!(scan_fetch("SELECT TOP 5 name FROM account WHERE name = 'x' AND statecode = 0").await, Some(5));
        assert_eq!(scan_fetch("SELECT name FROM account").await, Some(50_001));
        // re-checked in memory → the server can't stop early
        assert_eq!(scan_fetch("SELECT TOP 5 name FROM account WHERE createdon > '2024'").await, None);
    }

    #[tokio::test]
    async fn order_by_top_reaches_fetchxml() {
        assert_eq!(
            pushed("SELECT TOP 10 name FROM account ORDER BY createdon DESC").await,
            Some((vec![("createdon".into(), true)], Some(10)))
        );
        // through an alias, with an exact WHERE
        assert_eq!(
            pushed("SELECT TOP 5 a.name AS n FROM account a WHERE a.name LIKE 'C%' ORDER BY n").await,
            Some((vec![("name".into(), false)], Some(5)))
        );
        // no TOP: the 50,001-row cap still orders server-side
        assert_eq!(
            pushed("SELECT name FROM account ORDER BY revenue").await,
            Some((vec![("revenue".into(), false)], Some(50_001)))
        );
    }

    #[tokio::test]
    async fn order_stays_in_memory_when_the_server_cant_match_it() {
        // choices sort by label in FetchXML
        assert_eq!(pushed("SELECT TOP 10 name FROM account ORDER BY statecode").await, None);
        // an inexact filter would drop rows after the server picked the top 10
        assert_eq!(
            pushed("SELECT TOP 10 name FROM account WHERE createdon > '2024-01-01' ORDER BY name").await,
            None
        );
        // NULLS LAST differs from FetchXML
        assert_eq!(pushed("SELECT TOP 10 name FROM account ORDER BY name NULLS LAST").await, None);
        // expressions and aggregates
        assert_eq!(pushed("SELECT TOP 10 name FROM account ORDER BY upper(name)").await, None);
        assert_eq!(
            pushed("SELECT TOP 3 name, count(*) c FROM account GROUP BY name ORDER BY name").await,
            None
        );
    }

    #[test]
    fn label_columns_are_synthesized() {
        let attrs = vec![
            ("accountcategorycode".to_string(), "Picklist".to_string()),
            ("accountcategorycodename".to_string(), "Virtual".to_string()),
            ("entityimage_url".to_string(), "Virtual".to_string()),
            ("name".to_string(), "String".to_string()),
            ("owneridtype".to_string(), "EntityName".to_string()),
            ("owneridtypename".to_string(), "Virtual".to_string()),
            ("parentaccountid".to_string(), "Lookup".to_string()),
        ];
        let (schema, cols) = build_columns(&attrs);
        let names: Vec<&str> = schema.fields().iter().map(|f| f.name().as_str()).collect();
        assert_eq!(
            names,
            [
                "accountcategorycode",
                "accountcategorycodename",
                "name",
                "owneridtype",
                "owneridtypename",
                "parentaccountid",
                "parentaccountidname"
            ]
        );
        assert_eq!(cols[1].fetch_attr, "accountcategorycode");
        assert_eq!(cols[1].json_key, "accountcategorycode@OData.Community.Display.V1.FormattedValue");
        assert_eq!(cols[5].json_key, "_parentaccountid_value");
        assert_eq!(cols[6].json_key, "_parentaccountid_value@OData.Community.Display.V1.FormattedValue");
        assert_eq!(cols[6].kind, Kind::Formatted);
        // virtual attrs are never requested from FetchXML
        assert!(cols.iter().all(|c| !c.fetch_attr.ends_with("name") || c.fetch_attr == "name"));
    }

    /// Live diagnostic (needs a signed-in app):
    /// `CDS_DIAG_HOST=org.crm5.dynamics.com CDS_DIAG_SQL="SELECT TOP 5 * FROM owner"
    ///  cargo test --lib engine::tests::diag_live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn diag_live() {
        let host = std::env::var("CDS_DIAG_HOST").expect("CDS_DIAG_HOST");
        let sql = std::env::var("CDS_DIAG_SQL").unwrap_or_else(|_| "SELECT TOP 5 * FROM owner".into());
        let project = std::env::var("CDS_DIAG_PROJECT")
            .ok()
            .and_then(|id| crate::project::get(&id))
            .or_else(|| crate::project::list().into_iter().next())
            .expect("no project — sign in through the app first");
        let settings = crate::settings_for(&project);
        let rt = crate::auth::load_refresh_token(&project.id)
            .expect("no stored refresh token — sign in through the app first");
        let tokens = crate::auth::refresh(&settings, &format!("https://{}", host), &rt).expect("refresh failed");
        let workers = std::env::var("CDS_DIAG_WORKERS").ok().and_then(|w| w.parse().ok()).unwrap_or(0);
        let max_rows = std::env::var("CDS_DIAG_MAX").ok().and_then(|w| w.parse().ok()).unwrap_or(50);
        match run(&host, &tokens.access_token, &sql, max_rows, workers, None).await {
            Ok(r) => {
                println!("OK {} rows in {} ms; columns: {:?}", r.row_count, r.elapsed_ms,
                    r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>());
                println!("timings: {}", serde_json::to_string(&r.timings).unwrap());
                let distinct: std::collections::HashSet<String> =
                    r.rows.iter().filter_map(|row| row.first().map(|v| v.to_string())).collect();
                println!("distinct first-column values: {}", distinct.len());
                for row in r.rows.iter().take(3) {
                    let line = serde_json::to_string(row).unwrap();
                    println!("{}", line.chars().take(400).collect::<String>());
                }
            }
            Err(e) => println!("ENGINE ERROR: {}", e),
        }
    }

    #[test]
    fn paging_cookie_is_decoded_twice_and_escaped() {
        assert_eq!(
            next_cookie(
                "<cookie pagenumber=\"2\" pagingcookie=\"%253ccookie%2520page%253d%25221%2522%253e%253c%252fcookie%253e\" istracking=\"False\" />"
            )
            .unwrap(),
            "&lt;cookie page=&quot;1&quot;&gt;&lt;/cookie&gt;"
        );
    }

    fn parse(json: &str, attrs: &[(&str, &str)], pick: &[&str]) -> (RecordBatch, bool, Option<String>) {
        let attrs: Vec<(String, String)> = attrs.iter().map(|(n, t)| (n.to_string(), t.to_string())).collect();
        let (schema, cols) = build_columns(&attrs);
        let idx: Vec<usize> = pick.iter().map(|n| schema.index_of(n).unwrap()).collect();
        let projected = Arc::new(schema.project(&idx).unwrap());
        let cols: Vec<ColSpec> = idx.iter().map(|&i| cols[i].clone()).collect();
        let layout = Layout::new(projected, &cols);
        parse_page(&mut json.as_bytes(), &layout).unwrap()
    }

    fn texts(batch: &RecordBatch, col: usize) -> Vec<Option<String>> {
        (0..batch.num_rows())
            .map(|i| {
                let c = batch.column(col);
                (!c.is_null(i)).then(|| array_value_to_string(c, i).unwrap())
            })
            .collect()
    }

    #[test]
    fn pages_parse_straight_into_columns() {
        let json = r#"{
            "@odata.context": "x",
            "value": [
                {"@odata.etag": "W/1", "name": "Contoso", "revenue": 12.5, "numberofemployees": "42",
                 "statecode": 1, "statecode@OData.Community.Display.V1.FormattedValue": "Inactive",
                 "_parentaccountid_value": "p-1", "donotphone": true, "owneridtype": "systemuser",
                 "notes": {"nested": [1, 2]}},
                {"name": null, "statecode": 0, "revenue": 3}
            ],
            "@Microsoft.Dynamics.CRM.morerecords": true,
            "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie": "<cookie pagenumber=\"2\" pagingcookie=\"%253ccookie%2520page%253d%25221%2522%253e%253c%252fcookie%253e\" istracking=\"False\" />"
        }"#;
        let attrs = [
            ("name", "String"),
            ("revenue", "Money"),
            ("numberofemployees", "Integer"),
            ("statecode", "State"),
            ("parentaccountid", "Lookup"),
            ("donotphone", "Boolean"),
            ("owneridtype", "EntityName"),
            ("notes", "Memo"),
        ];
        let pick = [
            "name", "revenue", "numberofemployees", "statecode", "statecodename", "parentaccountid",
            "donotphone", "owneridtypename", "notes",
        ];
        let (b, more, cookie) = parse(json, &attrs, &pick);
        assert!(more);
        assert_eq!(cookie.as_deref(), Some("&lt;cookie page=&quot;1&quot;&gt;&lt;/cookie&gt;"));
        assert_eq!(b.num_rows(), 2);
        assert_eq!(texts(&b, 0), vec![Some("Contoso".into()), None]);
        assert_eq!(texts(&b, 1), vec![Some("12.5".into()), Some("3.0".into())]);
        // numbers sent as text still land in numeric columns
        assert_eq!(texts(&b, 2), vec![Some("42".into()), None]);
        assert_eq!(texts(&b, 3), vec![Some("1".into()), Some("0".into())]);
        // (a label without its formatted value shows the raw value, as before)
        assert_eq!(texts(&b, 4), vec![Some("Inactive".into()), Some("0".into())]);
        assert_eq!(texts(&b, 5), vec![Some("p-1".into()), None]);
        assert_eq!(texts(&b, 6), vec![Some("true".into()), None]);
        // label without a formatted value falls back to the raw value
        assert_eq!(texts(&b, 7), vec![Some("systemuser".into()), None]);
        assert_eq!(texts(&b, 8), vec![Some(r#"{"nested":[1,2]}"#.into()), None]);
    }

    #[test]
    fn empty_projection_still_counts_rows() {
        let (b, more, cookie) = parse(r#"{"value":[{"a":1},{"a":2},{"a":3}]}"#, &[("name", "String")], &[]);
        assert_eq!((b.num_rows(), b.num_columns(), more, cookie), (3, 0, false, None));
    }

    #[test]
    fn read_threads_and_range_sizes() {
        assert_eq!(read_threads(0, Some(6)), 6);
        assert_eq!(read_threads(0, None), FALLBACK_READ_THREADS);
        assert_eq!(read_threads(3, Some(6)), 3);
        assert_eq!(read_threads(0, Some(500)), crate::dml::MAX_WORKERS);
        assert_eq!(range_rows(5000, RANGE_MIN_ROWS, 8), 625);
        assert_eq!(range_rows(5000, RANGE_MIN_ROWS, 2), RANGE_MAX_ROWS);
        assert_eq!(range_rows(5000, RANGE_MIN_ROWS, 32), RANGE_MIN_ROWS);
        assert_eq!(range_rows(4, 1, 3), 2);
    }

    /// Everything a fake Web API saw.
    #[derive(Default)]
    struct Seen {
        key_requests: usize,
        ranges: Vec<(String, String)>,
        prefers: Vec<String>,
        in_flight: usize,
        peak: usize,
        /// Answer the next range request with 429 + `Retry-After: 1`.
        throttle_next: bool,
    }

    /// A fake Web API over `n` accounts that answers key scans (paged by
    /// `count`/`page`, or `top`) and `ge`/`le` key-range reads, slowly enough
    /// that parallel requests overlap. Sends `x-ms-dop-hint: 3`.
    fn fake_ranges(n: usize) -> (String, Arc<Mutex<Seen>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let host = format!("http://{}", server.server_addr());
        let seen = Arc::new(Mutex::new(Seen::default()));
        let state = seen.clone();
        let ids: Vec<String> = (0..n).map(|i| format!("00000000-0000-0000-0000-{:012}", i)).collect();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let (state, ids) = (state.clone(), ids.clone());
                std::thread::spawn(move || {
                    let fetch = percent_decode_str(request.url()).decode_utf8_lossy().to_string();
                    let prefer = request
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("Prefer"))
                        .map(|h| h.value.to_string())
                        .unwrap_or_default();
                    let num = |attr: &str| {
                        regex::Regex::new(&format!(r#"{}="(\d+)""#, attr))
                            .unwrap()
                            .captures(&fetch)
                            .map(|c| c[1].parse::<usize>().unwrap())
                    };
                    let bound = |op: &str| {
                        regex::Regex::new(&format!(r#"operator="{}" value="([^"]+)""#, op))
                            .unwrap()
                            .captures(&fetch)
                            .map(|c| c[1].to_string())
                    };
                    if bound("ge").is_some() {
                        let mut s = state.lock().unwrap();
                        if s.throttle_next {
                            s.throttle_next = false;
                            drop(s);
                            let _ = request.respond(
                                tiny_http::Response::from_string("{}")
                                    .with_status_code(429)
                                    .with_header(tiny_http::Header::from_bytes("Retry-After", "1").unwrap()),
                            );
                            return;
                        }
                    }
                    {
                        let mut s = state.lock().unwrap();
                        s.in_flight += 1;
                        s.peak = s.peak.max(s.in_flight);
                    }
                    let row = |i: usize| {
                        serde_json::json!({
                            "accountid": ids[i],
                            "name": format!("n{}", i),
                            "statecode": i % 2,
                            "createdon": "2024-01-01T00:00:00Z",
                            "statecode@OData.Community.Display.V1.FormattedValue": if i % 2 == 0 { "Active" } else { "Inactive" },
                        })
                    };
                    let body = if let (Some(lo), Some(hi)) = (bound("ge"), bound("le")) {
                        std::thread::sleep(Duration::from_millis(80));
                        let mut s = state.lock().unwrap();
                        s.ranges.push((lo.clone(), hi.clone()));
                        s.prefers.push(prefer);
                        drop(s);
                        let rows: Vec<Value> =
                            (0..n).filter(|&i| ids[i] >= lo && ids[i] <= hi).map(row).collect();
                        serde_json::json!({ "value": rows })
                    } else {
                        state.lock().unwrap().key_requests += 1;
                        assert!(!prefer.contains("FormattedValue"), "key scans never need labels");
                        let (start, len) = match (num("top"), num("count"), num("page")) {
                            (Some(top), _, _) => (0, top),
                            (None, Some(count), page) => ((page.unwrap_or(1) - 1) * count, count),
                            _ => (0, n),
                        };
                        let end = (start + len).min(n);
                        let keys: Vec<Value> =
                            (start.min(n)..end).map(|i| serde_json::json!({ "accountid": ids[i] })).collect();
                        let mut body = serde_json::json!({ "value": keys });
                        if end < n && num("top").is_none() {
                            body[MORE_RECORDS] = Value::Bool(true);
                            body[PAGING_COOKIE] = Value::from(format!(
                                "<cookie pagenumber=\"{}\" pagingcookie=\"%253ccookie%2520page%253d%2522{}%2522%253e%253c%252fcookie%253e\" />",
                                num("page").unwrap_or(1) + 1,
                                num("page").unwrap_or(1)
                            ));
                        }
                        body
                    };
                    state.lock().unwrap().in_flight -= 1;
                    let _ = request.respond(
                        tiny_http::Response::from_string(body.to_string())
                            .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
                            .with_header(tiny_http::Header::from_bytes("x-ms-dop-hint", "3").unwrap()),
                    );
                });
            }
        });
        (host, seen)
    }

    fn small_pages(e: &mut EngineCtx) {
        e.page_size = 4;
        e.range_min = 1;
        e.parallel_min = 2;
    }

    #[tokio::test]
    async fn big_reads_split_into_parallel_key_ranges() {
        let (host, seen) = fake_ranges(10);
        let (ctx, engine) = offline_ctx_with(&host, small_pages);
        let batches = Arc::new(Mutex::new(0usize));
        let counter = batches.clone();
        let on_batch: OnBatch = Arc::new(move |_: &str, _: &[ColumnInfo], _: &[Vec<Value>]| {
            *counter.lock().unwrap() += 1;
        });
        let r = run_in(&ctx, &engine, "SELECT name FROM account", 50_000, Some(on_batch)).await.unwrap();
        let mut names: Vec<String> = r.rows.iter().map(|row| row[0].as_str().unwrap().to_string()).collect();
        names.sort_by_key(|n| n[1..].parse::<usize>().unwrap());
        assert_eq!(names, (0..10).map(|i| format!("n{}", i)).collect::<Vec<_>>());

        let s = seen.lock().unwrap();
        // 10 keys in pages of 4 → 3 key requests; each page cut for 3 threads
        // (the server's hint) → ranges of 2, 2, 2, 2, 1, 1 keys.
        assert_eq!(s.key_requests, 3);
        let mut ranges = s.ranges.clone();
        ranges.sort();
        assert_eq!(ranges.len(), 6);
        assert_eq!(ranges[0].0, "00000000-0000-0000-0000-000000000000");
        assert_eq!(ranges[0].1, "00000000-0000-0000-0000-000000000001");
        assert!(s.peak > 1 && s.peak <= 3, "peak concurrency {}", s.peak);
        // no label column selected → no formatted values requested
        assert!(s.prefers.iter().all(|p| !p.contains("FormattedValue") && p.contains("morerecords")));
        assert_eq!(*batches.lock().unwrap(), 6);

        let t = r.timings.unwrap();
        assert_eq!((t.threads, t.key_pages, t.pages), (Some(3), Some(3), Some(9)));
        assert!(t.wire_bytes.unwrap() > 0);
    }

    #[tokio::test]
    async fn parallel_reads_honour_top_and_labels() {
        let (host, seen) = fake_ranges(10);
        let (ctx, engine) = offline_ctx_with(&host, |e| {
            small_pages(e);
            e.workers = 2;
        });
        let r = run_in(&ctx, &engine, "SELECT TOP 5 name, statecodename FROM account", 50_000, None)
            .await
            .unwrap();
        assert_eq!(r.row_count, 5);
        let mut rows: Vec<(String, String)> = r
            .rows
            .iter()
            .map(|row| (row[0].as_str().unwrap().to_string(), row[1].as_str().unwrap().to_string()))
            .collect();
        rows.sort();
        assert_eq!(rows[0], ("n0".to_string(), "Active".to_string()));
        assert_eq!(rows[4], ("n4".to_string(), "Active".to_string()));
        let s = seen.lock().unwrap();
        assert!(s.prefers.iter().all(|p| p.contains("FormattedValue")));
        assert!(s.peak <= 2);
        assert_eq!(r.timings.unwrap().threads, Some(2));
    }

    #[test]
    fn limiter_shrinks_to_one_and_never_below() {
        let l = Limiter::default();
        l.shrink(); // no parallel read yet: unlimited stays unlimited
        assert_eq!(l.allowed(), usize::MAX);
        l.set(3);
        l.shrink();
        assert_eq!(l.allowed(), 2);
        for _ in 0..5 {
            l.shrink();
        }
        assert_eq!(l.allowed(), 1);
        let p = l.acquire();
        drop(p);
        let _again = l.acquire();
    }

    #[tokio::test]
    async fn throttled_range_waits_retries_and_drops_a_thread() {
        let (host, seen) = fake_ranges(10);
        seen.lock().unwrap().throttle_next = true;
        let (ctx, engine) = offline_ctx_with(&host, small_pages);
        let r = run_in(&ctx, &engine, "SELECT name FROM account", 50_000, None).await.unwrap();
        assert_eq!(r.row_count, 10);
        assert_eq!(r.timings.unwrap().throttled, Some(1));
        // started with the server's 3, one fewer after the 429
        assert_eq!(engine.limiter.allowed(), 2);
    }

    #[tokio::test]
    async fn limit_over_a_rechecked_filter_stops_reading_early() {
        // `createdon` is re-checked in memory, so TOP can't reach FetchXML and
        // the scan only stops when DataFusion stops asking for rows.
        let (host, seen) = fake_ranges(40);
        let (ctx, engine) = offline_ctx_with(&host, small_pages);
        let r = run_in(&ctx, &engine, "SELECT TOP 3 name FROM account WHERE createdon > '2000-01-01'", 50_000, None)
            .await
            .unwrap();
        assert_eq!(r.row_count, 3);
        // 40 keys would be 20 ranges; only the few already in flight may finish.
        let fetched = seen.lock().unwrap().ranges.len();
        assert!(fetched <= 6, "fetched {} ranges for 3 rows", fetched);
    }

    #[tokio::test]
    async fn sql_the_engine_cannot_plan_is_flagged_before_any_request() {
        // T-SQL-only function: the caller hands such queries to TDS.
        let (host, urls) = fake_pages();
        let (ctx, engine) = offline_ctx_at(&host);
        let err = run_in(&ctx, &engine, "SELECT GETDATE() AS now, name FROM account", 50_000, None)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(err.starts_with(CANNOT_PLAN), "{}", err);
        assert!(urls.lock().unwrap().is_empty(), "no FetchXML request was sent");
        // A plain query plans fine.
        assert!(run_in(&ctx, &engine, "SELECT name FROM account", 50_000, None).await.is_ok());
    }

    #[tokio::test]
    async fn virtual_tables_are_read_page_by_page() {
        // e.g. `aaduser` (Microsoft Graph) rejects `ge`/`le` on its key:
        // "The request uses a filter property that is not indexed."
        let (host, seen) = fake_ranges(10);
        let (ctx, engine) = offline_ctx_table(&host, small_pages, false);
        let r = run_in(&ctx, &engine, "SELECT name FROM account", 50_000, None).await.unwrap();
        assert_eq!(r.row_count, 10);
        let s = seen.lock().unwrap();
        assert!(s.ranges.is_empty(), "no key-range requests: {:?}", s.ranges);
        assert_eq!(r.timings.unwrap().threads, Some(1));
    }

    #[tokio::test]
    async fn virtual_tables_page_past_a_short_first_answer_for_top() {
        // The provider answers fewer rows than `top` asked for (Graph: 100)
        // and says there are more: TOP 4 must keep paging, not stop at 3.
        let (host, urls) = fake_pages();
        let (ctx, engine) = offline_ctx_table(&host, |_| {}, false);
        let r = run_in(&ctx, &engine, "SELECT TOP 4 name FROM account", 50_000, None).await.unwrap();
        assert_eq!(r.row_count, 4);
        let urls = urls.lock().unwrap();
        let first = percent_decode_str(&urls[0]).decode_utf8_lossy().to_string();
        assert!(first.contains(r#"page="1""#) && !first.contains("top="), "{}", first);
    }

    #[tokio::test]
    async fn key_only_and_ordered_reads_stay_sequential() {
        let (host, seen) = fake_ranges(10);
        let (ctx, engine) = offline_ctx_with(&host, small_pages);
        // COUNT(*) only needs keys: the plain scan asks for the key column.
        let r = run_in(&ctx, &engine, "SELECT COUNT(*) FROM account", 50_000, None).await.unwrap();
        assert_eq!(r.rows[0][0], Value::from(10));
        assert!(seen.lock().unwrap().ranges.is_empty());
    }
}

/// `owner` = every undeleted user + team; the Web API exposes no `owners`
/// entity set, so it is emulated with the same columns TDS/SQL 4 CDS show.
const VIEWS: &[(&str, &str)] = &[(
    "owner",
    "SELECT fullname AS name, systemuserid AS ownerid, 'systemuser' AS owneridtype, \
     'User' AS owneridtypename, versionnumber, yomifullname AS yominame FROM systemuser \
     UNION ALL \
     SELECT name, teamid AS ownerid, 'team' AS owneridtype, 'Team' AS owneridtypename, \
     versionnumber, yominame FROM team",
)];

/// Start of the error returned when the engine can't plan the SQL at all
/// (before any request for rows) — the caller may hand it to TDS instead.
pub const CANNOT_PLAN: &str = "The FetchXML engine can't run this query";

/// Run `sql` through DataFusion against Dataverse (FetchXML / Web API),
/// handing rows to `on_batch` page by page as they arrive. `workers`: parallel
/// read requests (0 = the server's recommendation, 1 = sequential).
pub async fn run(
    host: &str,
    token: &str,
    sql: &str,
    max_rows: usize,
    workers: usize,
    on_batch: Option<OnBatch>,
) -> AppResult<QueryResult> {
    let engine = Arc::new(EngineCtx::new(host, token, workers));
    let ctx = session(engine.clone(), HashMap::new())?;
    run_in(&ctx, &engine, sql, max_rows, on_batch).await
}

/// A DataFusion session whose `dbo` schema resolves tables against Dataverse
/// (`preloaded` seeds the table cache — tests use it to skip metadata).
fn session(engine: Arc<EngineCtx>, preloaded: HashMap<String, Arc<dyn TableProvider>>) -> AppResult<SessionContext> {
    let config = SessionConfig::new()
        // One partition: the time goes into HTTP (parallelized inside the
        // scan), not CPU. With several, DataFusion inserts a repartition that
        // drains the scan eagerly — past LIMIT — downloading rows nobody needs.
        .with_target_partitions(1)
        .with_default_catalog_and_schema("dataverse", "dbo")
        .set_str("datafusion.sql_parser.dialect", "mssql")
        // NULLs sort lowest, as in SQL Server and FetchXML.
        .set_str("datafusion.sql_parser.default_null_ordering", "nulls_min");
    let ctx = SessionContext::new_with_config(config);
    let schema = Arc::new(DataverseSchema { ctx: engine, cache: Mutex::new(preloaded) });
    let catalog = MemoryCatalogProvider::new();
    catalog
        .register_schema("dbo", schema)
        .map_err(|e| AppError::msg(e.to_string()))?;
    ctx.register_catalog("dataverse", Arc::new(catalog));
    Ok(ctx)
}

async fn run_in(
    ctx: &SessionContext,
    engine: &EngineCtx,
    sql: &str,
    max_rows: usize,
    on_batch: Option<OnBatch>,
) -> AppResult<QueryResult> {
    let started = std::time::Instant::now();

    // Abstract tables the Web API has no entity set for are served as views
    // over their concrete members (registered only when referenced, since
    // planning the view loads the member tables' metadata).
    for (name, view_sql) in VIEWS {
        let mentioned = regex::Regex::new(&format!(r"(?i)\b{}\b", name)).unwrap();
        if mentioned.is_match(sql) {
            let plan = ctx
                .state()
                .create_logical_plan(view_sql)
                .await
                .map_err(|e| AppError::msg(format!("Cannot build view '{}': {}", name, e)))?;
            ctx.register_table(*name, Arc::new(ViewTable::new(plan, Some((*view_sql).to_string()))))
                .map_err(|e| AppError::msg(e.to_string()))?;
        }
    }

    // Failing here means the SQL can't be planned (syntax or a function the
    // engine lacks, unknown table…) and no row has been read yet.
    let physical = physical_plan(ctx, sql, max_rows)
        .await
        .map_err(|e| AppError::msg(format!("{}: {}", CANNOT_PLAN, e)))?;
    let mut stream = datafusion::physical_plan::execute_stream(physical, ctx.task_ctx())
        .map_err(|e| AppError::msg(e.to_string()))?;
    let columns: Vec<ColumnInfo> = stream
        .schema()
        .fields()
        .iter()
        .map(|f| ColumnInfo { name: f.name().clone(), data_type: format!("{}", f.data_type()) })
        .collect();

    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    while let Some(batch) = stream.next().await {
        let batch = batch.map_err(|e| AppError::msg(e.to_string()))?;
        let mut page = batch_rows(&batch);
        if rows.len() + page.len() > max_rows {
            page.truncate(max_rows - rows.len());
            truncated = true;
        }
        if let Some(cb) = &on_batch {
            if !page.is_empty() {
                cb("fetchxml", &columns, &page);
            }
        }
        rows.extend(page);
        if truncated {
            break;
        }
    }

    let stats = engine.stats();
    Ok(QueryResult {
        columns,
        row_count: rows.len(),
        rows,
        elapsed_ms: started.elapsed().as_millis() as u64,
        truncated,
        engine: "fetchxml".to_string(),
        note: None,
        streamed: false,
        clipped: false,
        timings: Some(Timings {
            total_ms: started.elapsed().as_millis() as u64,
            metadata_ms: Some(stats.metadata_ms),
            // Wall clock from the first request out to the last answer in.
            fetch_ms: match (stats.first, stats.last) {
                (Some(a), Some(b)) => (b - a).as_millis() as u64,
                _ => 0,
            },
            pages: Some(stats.requests + stats.key_requests),
            bytes: Some(stats.bytes),
            wire_bytes: Some(stats.wire_bytes),
            wait_ms: Some(stats.wait_ms),
            download_ms: Some(stats.download_ms),
            key_pages: Some(stats.key_requests),
            threads: Some(stats.threads.max(1)),
            throttled: Some(stats.throttled),
            ..Timings::default()
        }),
    })
}

async fn physical_plan(ctx: &SessionContext, sql: &str, max_rows: usize) -> DfResult<Arc<dyn ExecutionPlan>> {
    let df = ctx.sql(&rewrite_top(sql)).await?;
    let df = df.limit(0, Some(max_rows.saturating_add(1)))?;
    let state = ctx.state();
    let plan = push_sort_into_scans(state.optimize(df.logical_plan())?)?;
    state.create_physical_plan(&plan).await
}
