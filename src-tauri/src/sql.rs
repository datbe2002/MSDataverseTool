//! Runs SQL against the Dataverse TDS endpoint via ODBC Driver 17/18 for SQL
//! Server, authenticating with an Azure AD access token passed through the
//! `SQL_COPT_SS_ACCESS_TOKEN` connection attribute.
//!
//! Why ODBC instead of a pure-Rust TDS driver: Dataverse access tokens are
//! large (often >2560 chars). Pure-Rust drivers (tiberius) send the token
//! inline in the LOGIN7 packet (fedauth SECURITYTOKEN), which the Dataverse
//! gateway caps at 2560 chars ("password encoded as UTF-16 is longer than
//! platform limit"). The Microsoft ODBC driver uses the server-directed flow
//! that accepts large tokens — the same path SSMS and ADO.NET use.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::os::raw::c_void;
use std::ptr::null_mut;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
    pub elapsed_ms: u64,
    pub truncated: bool,
    /// Which path produced the rows: "tds" or "fetchxml".
    pub engine: String,
    /// Why the query ended up on that engine, when it wasn't the first choice.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The rows were already delivered page by page (`rows` is empty).
    pub streamed: bool,
    /// Some streamed text cells were shortened for the grid; the full rows
    /// stay in the backend (`result_rows`).
    pub clipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timings: Option<Timings>,
}

/// Where the time went, so slow queries can be diagnosed.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    /// Whole backend call.
    pub total_ms: u64,
    /// TDS: opening the ODBC connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_ms: Option<u64>,
    /// TDS: `SQLExecDirect` — the server running the query.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exec_ms: Option<u64>,
    /// FetchXML: loading table metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_ms: Option<u64>,
    /// Reading rows (TDS row loop / FetchXML HTTP requests, wall clock).
    pub fetch_ms: u64,
    /// FetchXML: HTTP requests for rows (including key-scan requests).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<usize>,
    /// Bytes parsed (after decompression).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    /// FetchXML: bytes that crossed the network (gzip-compressed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wire_bytes: Option<usize>,
    /// FetchXML: summed over requests — waiting for the server to start
    /// answering (incl. throttling waits) …
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
    /// … and downloading + parsing the answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_ms: Option<u64>,
    /// FetchXML: requests of the key scan that plans parallel reads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_pages: Option<usize>,
    /// FetchXML: parallel requests allowed (1 = sequential paging).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threads: Option<usize>,
    /// FetchXML: 429/503 answers that made us wait.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub throttled: Option<usize>,
}

/// Called with each chunk of rows as it arrives: `(engine, columns, rows)`.
pub type OnBatch = std::sync::Arc<dyn Fn(&str, &[ColumnInfo], &[Vec<Value>]) + Send + Sync>;

/// Rows per streamed chunk over TDS.
const TDS_CHUNK: usize = 2000;

/// Prefix of the error returned when our own client-side timeout fires.
pub const CLIENT_TIMEOUT: &str = "TDS query timed out";

// ---- ODBC constants ----
const SQL_HANDLE_ENV: i16 = 1;
const SQL_HANDLE_DBC: i16 = 2;
const SQL_HANDLE_STMT: i16 = 3;
const SQL_ATTR_ODBC_VERSION: i32 = 200;
const SQL_ATTR_QUERY_TIMEOUT: i32 = 0;
const SQL_OV_ODBC3: isize = 3;
const SQL_COPT_SS_ACCESS_TOKEN: i32 = 1256;
const SQL_IS_POINTER: i32 = -5;
const SQL_DRIVER_NOPROMPT: u16 = 0;
const SQL_C_WCHAR: i16 = -8;
const SQL_NULL_DATA: isize = -1;
const SQL_SUCCESS: i16 = 0;
const SQL_SUCCESS_WITH_INFO: i16 = 1;
const SQL_NO_DATA: i16 = 100;
const SQL_NTS: i16 = -3;

#[allow(non_snake_case)]
#[link(name = "odbc32")]
extern "system" {
    fn SQLAllocHandle(HandleType: i16, InputHandle: *mut c_void, OutputHandle: *mut *mut c_void) -> i16;
    fn SQLSetEnvAttr(EnvironmentHandle: *mut c_void, Attribute: i32, Value: *mut c_void, StringLength: i32) -> i16;
    fn SQLSetConnectAttrW(ConnectionHandle: *mut c_void, Attribute: i32, Value: *mut c_void, StringLength: i32) -> i16;
    fn SQLDriverConnectW(
        ConnectionHandle: *mut c_void,
        WindowHandle: *mut c_void,
        InConnectionString: *const u16,
        StringLength1: i16,
        OutConnectionString: *mut u16,
        BufferLength: i16,
        StringLength2Ptr: *mut i16,
        DriverCompletion: u16,
    ) -> i16;
    fn SQLSetStmtAttrW(StatementHandle: *mut c_void, Attribute: i32, Value: *mut c_void, StringLength: i32) -> i16;
    fn SQLExecDirectW(StatementHandle: *mut c_void, StatementText: *const u16, TextLength: i32) -> i16;
    fn SQLNumResultCols(StatementHandle: *mut c_void, ColumnCountPtr: *mut i16) -> i16;
    fn SQLDescribeColW(
        StatementHandle: *mut c_void,
        ColumnNumber: u16,
        ColumnName: *mut u16,
        BufferLength: i16,
        NameLengthPtr: *mut i16,
        DataTypePtr: *mut i16,
        ColumnSizePtr: *mut usize,
        DecimalDigitsPtr: *mut i16,
        NullablePtr: *mut i16,
    ) -> i16;
    fn SQLFetch(StatementHandle: *mut c_void) -> i16;
    fn SQLGetData(
        StatementHandle: *mut c_void,
        ColumnNumber: u16,
        TargetType: i16,
        TargetValuePtr: *mut c_void,
        BufferLength: isize,
        StrLenOrIndPtr: *mut isize,
    ) -> i16;
    fn SQLGetDiagRecW(
        HandleType: i16,
        Handle: *mut c_void,
        RecNumber: i16,
        SQLState: *mut u16,
        NativeErrorPtr: *mut i32,
        MessageText: *mut u16,
        BufferLength: i16,
        TextLengthPtr: *mut i16,
    ) -> i16;
    fn SQLFreeHandle(HandleType: i16, Handle: *mut c_void) -> i16;
    fn SQLDisconnect(ConnectionHandle: *mut c_void) -> i16;
}

fn succeeded(r: i16) -> bool {
    r == SQL_SUCCESS || r == SQL_SUCCESS_WITH_INFO
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// RAII guards so early returns always clean up.
struct EnvGuard(*mut c_void);
impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            SQLFreeHandle(SQL_HANDLE_ENV, self.0);
        }
    }
}
struct DbcGuard {
    h: *mut c_void,
    connected: bool,
}
impl Drop for DbcGuard {
    fn drop(&mut self) {
        unsafe {
            if self.connected {
                SQLDisconnect(self.h);
            }
            SQLFreeHandle(SQL_HANDLE_DBC, self.h);
        }
    }
}
struct StmtGuard(*mut c_void);
impl Drop for StmtGuard {
    fn drop(&mut self) {
        unsafe {
            SQLFreeHandle(SQL_HANDLE_STMT, self.0);
        }
    }
}

unsafe fn diagnostics(handle_type: i16, handle: *mut c_void) -> String {
    let mut messages = Vec::new();
    let mut rec: i16 = 1;
    loop {
        let mut state = [0u16; 6];
        let mut native: i32 = 0;
        let mut msg = [0u16; 1024];
        let mut msg_len: i16 = 0;
        let r = SQLGetDiagRecW(
            handle_type,
            handle,
            rec,
            state.as_mut_ptr(),
            &mut native,
            msg.as_mut_ptr(),
            msg.len() as i16,
            &mut msg_len,
        );
        if !succeeded(r) {
            break;
        }
        let text = String::from_utf16_lossy(&msg[..msg_len.max(0) as usize]);
        messages.push(text.trim().to_string());
        rec += 1;
        if rec > 8 {
            break;
        }
    }
    if messages.is_empty() {
        "Unknown ODBC error".to_string()
    } else {
        messages.join("\n")
    }
}

/// SQLSTATE of the first diagnostic record (e.g. `HYT00` = timeout expired).
unsafe fn sql_state(handle_type: i16, handle: *mut c_void) -> String {
    let mut state = [0u16; 6];
    let mut native: i32 = 0;
    let mut msg = [0u16; 1];
    let mut msg_len: i16 = 0;
    SQLGetDiagRecW(
        handle_type,
        handle,
        1,
        state.as_mut_ptr(),
        &mut native,
        msg.as_mut_ptr(),
        msg.len() as i16,
        &mut msg_len,
    );
    String::from_utf16_lossy(&state[..5])
}

unsafe fn get_wstring(stmt: *mut c_void, col: u16) -> Option<String> {
    let mut out: Vec<u16> = Vec::new();
    let mut buf: Vec<u16> = vec![0u16; 4096];
    loop {
        let mut ind: isize = 0;
        let r = SQLGetData(
            stmt,
            col,
            SQL_C_WCHAR,
            buf.as_mut_ptr() as *mut c_void,
            (buf.len() * 2) as isize,
            &mut ind,
        );
        if r == SQL_NO_DATA {
            break;
        }
        if !succeeded(r) {
            break;
        }
        if ind == SQL_NULL_DATA {
            return None;
        }
        // The buffer holds a null-terminated (possibly truncated) chunk.
        let chunk = buf
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(buf.len() - 1);
        out.extend_from_slice(&buf[..chunk]);
        if r == SQL_SUCCESS {
            break; // all data delivered
        }
        // SQL_SUCCESS_WITH_INFO -> more data remains; loop again.
    }
    Some(String::from_utf16_lossy(&out))
}

fn sql_type_name(t: i16) -> String {
    let name = match t {
        1 => "CHAR",
        12 => "VARCHAR",
        -1 => "TEXT",
        -8 => "NCHAR",
        -9 => "NVARCHAR",
        -10 => "NTEXT",
        2 => "NUMERIC",
        3 => "DECIMAL",
        4 => "INT",
        5 => "SMALLINT",
        -6 => "TINYINT",
        -5 => "BIGINT",
        6 => "FLOAT",
        7 => "REAL",
        8 => "DOUBLE",
        -7 => "BIT",
        91 => "DATE",
        92 => "TIME",
        93 => "DATETIME",
        -155 => "DATETIMEOFFSET",
        -11 => "UNIQUEIDENTIFIER",
        -2 => "BINARY",
        -3 => "VARBINARY",
        -4 => "IMAGE",
        _ => return format!("TYPE({})", t),
    };
    name.to_string()
}

unsafe fn cell_to_json(stmt: *mut c_void, col: u16, dtype: i16) -> Value {
    let s = match get_wstring(stmt, col) {
        None => return Value::Null,
        Some(s) => s,
    };
    match dtype {
        -7 => match s.trim() {
            "1" | "true" | "True" => Value::Bool(true),
            "0" | "false" | "False" => Value::Bool(false),
            _ => Value::from(s),
        },
        4 | 5 | -6 | -5 => s
            .trim()
            .parse::<i64>()
            .map(Value::from)
            .unwrap_or_else(|_| Value::from(s)),
        6 | 7 | 8 => s
            .trim()
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| Value::from(s)),
        _ => Value::from(s),
    }
}

/// Blocking. Call from a blocking context (e.g. `spawn_blocking`).
pub fn run(host: &str, token: &str, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
    run_with_timeout(host, token, sql, max_rows, None, None)
}

/// Like [`run`], but gives up after `timeout_secs` with an error starting
/// with [`CLIENT_TIMEOUT`], and hands rows to `on_batch` as they are read.
pub fn run_with_timeout(
    host: &str,
    token: &str,
    sql: &str,
    max_rows: usize,
    timeout_secs: Option<u32>,
    on_batch: Option<OnBatch>,
) -> AppResult<QueryResult> {
    let t0 = std::time::Instant::now();
    let stmt_error = |stmt: *mut c_void| unsafe {
        match timeout_secs {
            Some(secs) if sql_state(SQL_HANDLE_STMT, stmt) == "HYT00" => {
                AppError::msg(format!("{} after {}s", CLIENT_TIMEOUT, secs))
            }
            _ => AppError::msg(diagnostics(SQL_HANDLE_STMT, stmt)),
        }
    };
    unsafe {
        // --- environment ---
        let mut env: *mut c_void = null_mut();
        if !succeeded(SQLAllocHandle(SQL_HANDLE_ENV, null_mut(), &mut env)) {
            return Err(AppError::msg("Failed to allocate ODBC environment"));
        }
        let _env = EnvGuard(env);
        SQLSetEnvAttr(
            env,
            SQL_ATTR_ODBC_VERSION,
            SQL_OV_ODBC3 as *mut c_void,
            0,
        );

        // --- connection ---
        let mut dbc: *mut c_void = null_mut();
        if !succeeded(SQLAllocHandle(SQL_HANDLE_DBC, env, &mut dbc)) {
            return Err(AppError::msg(diagnostics(SQL_HANDLE_ENV, env)));
        }
        let mut dbc_guard = DbcGuard {
            h: dbc,
            connected: false,
        };

        // Build the ACCESSTOKEN struct: DWORD dataSize + UTF-16LE token bytes.
        let token_bytes: Vec<u8> = token
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let mut token_struct: Vec<u8> = Vec::with_capacity(4 + token_bytes.len());
        token_struct.extend_from_slice(&(token_bytes.len() as u32).to_le_bytes());
        token_struct.extend_from_slice(&token_bytes);

        let r = SQLSetConnectAttrW(
            dbc,
            SQL_COPT_SS_ACCESS_TOKEN,
            token_struct.as_ptr() as *mut c_void,
            SQL_IS_POINTER,
        );
        if !succeeded(r) {
            return Err(AppError::msg(diagnostics(SQL_HANDLE_DBC, dbc)));
        }

        // Same shape SSMS uses for Dataverse: `host,5558`, no `tcp:` prefix
        // (Dataverse parses the server name as a URI), no Database, and no
        // UID/PWD/Authentication (the token attribute handles auth).
        let conn_str = format!(
            "Driver={{ODBC Driver 17 for SQL Server}};Server={host},5558;Encrypt=yes;TrustServerCertificate=no;",
            host = host
        );
        let t_connect = std::time::Instant::now();
        let conn_w = to_wide(&conn_str);
        let mut out_buf = [0u16; 2048];
        let mut out_len: i16 = 0;
        let r = SQLDriverConnectW(
            dbc,
            null_mut(),
            conn_w.as_ptr(),
            SQL_NTS,
            out_buf.as_mut_ptr(),
            out_buf.len() as i16,
            &mut out_len,
            SQL_DRIVER_NOPROMPT,
        );
        if !succeeded(r) {
            return Err(AppError::msg(diagnostics(SQL_HANDLE_DBC, dbc)));
        }
        dbc_guard.connected = true;
        let connect_ms = t_connect.elapsed().as_millis() as u64;
        // token_struct must outlive the connect call; safe to drop now.
        drop(token_struct);

        // --- statement ---
        let mut stmt: *mut c_void = null_mut();
        if !succeeded(SQLAllocHandle(SQL_HANDLE_STMT, dbc, &mut stmt)) {
            return Err(AppError::msg(diagnostics(SQL_HANDLE_DBC, dbc)));
        }
        let stmt_guard = StmtGuard(stmt);

        if let Some(secs) = timeout_secs {
            SQLSetStmtAttrW(stmt, SQL_ATTR_QUERY_TIMEOUT, secs as usize as *mut c_void, 0);
        }

        let t_exec = std::time::Instant::now();
        let sql_w = to_wide(sql);
        let r = SQLExecDirectW(stmt, sql_w.as_ptr(), SQL_NTS as i32);
        if !succeeded(r) && r != SQL_NO_DATA {
            return Err(stmt_error(stmt));
        }
        let exec_ms = t_exec.elapsed().as_millis() as u64;

        // --- columns ---
        let mut ncols: i16 = 0;
        SQLNumResultCols(stmt, &mut ncols);
        let mut col_types: Vec<i16> = Vec::new();
        let mut columns: Vec<ColumnInfo> = Vec::new();
        for c in 1..=ncols.max(0) {
            let mut name_buf = [0u16; 256];
            let mut name_len: i16 = 0;
            let mut dtype: i16 = 0;
            let mut col_size: usize = 0;
            let mut dec_digits: i16 = 0;
            let mut nullable: i16 = 0;
            SQLDescribeColW(
                stmt,
                c as u16,
                name_buf.as_mut_ptr(),
                name_buf.len() as i16,
                &mut name_len,
                &mut dtype,
                &mut col_size,
                &mut dec_digits,
                &mut nullable,
            );
            let name = String::from_utf16_lossy(&name_buf[..name_len.max(0) as usize]);
            col_types.push(dtype);
            columns.push(ColumnInfo {
                name,
                data_type: sql_type_name(dtype),
            });
        }

        // --- rows ---
        let start = std::time::Instant::now();
        let mut rows: Vec<Vec<Value>> = Vec::new();
        let mut truncated = false;
        let mut flushed = 0usize;

        if ncols > 0 {
            loop {
                let r = SQLFetch(stmt);
                if r == SQL_NO_DATA {
                    break;
                }
                if !succeeded(r) {
                    return Err(stmt_error(stmt));
                }
                if rows.len() >= max_rows {
                    truncated = true;
                    break;
                }
                let mut row = Vec::with_capacity(ncols as usize);
                for c in 1..=ncols {
                    row.push(cell_to_json(stmt, c as u16, col_types[(c - 1) as usize]));
                }
                rows.push(row);
                if let Some(cb) = &on_batch {
                    if rows.len() - flushed >= TDS_CHUNK {
                        cb("tds", &columns, &rows[flushed..]);
                        flushed = rows.len();
                    }
                }
            }
        }
        if let Some(cb) = &on_batch {
            if flushed < rows.len() {
                cb("tds", &columns, &rows[flushed..]);
            }
        }

        let fetch_ms = start.elapsed().as_millis() as u64;
        let row_count = rows.len();

        drop(stmt_guard);
        drop(dbc_guard);

        Ok(QueryResult {
            columns,
            rows,
            row_count,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            truncated,
            engine: "tds".to_string(),
            note: None,
            streamed: false,
            clipped: false,
            timings: Some(Timings {
                total_ms: t0.elapsed().as_millis() as u64,
                connect_ms: Some(connect_ms),
                exec_ms: Some(exec_ms),
                fetch_ms,
                ..Timings::default()
            }),
        })
    }
}
