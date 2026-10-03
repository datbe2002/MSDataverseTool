//! Flow tasks: the flows of one assigned task, checked out into a folder the
//! user picks. Someone else (another Claude) edits
//! `flows/<name>__<id8>/definition.json`; the original stays in
//! `.hexa/baseline/` so the app can show what changed — and whether the cloud
//! changed meanwhile — before anything goes back to the environment.
//!
//! The baseline is always kept by the app. Git is used on top when it is
//! installed (a commit when flows are added or removed); without it the app
//! keeps its own copies of each edited version in `.hexa/snapshots/`.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const TASK_FILE: &str = "task.json";
const CLAUDE_FILE: &str = "CLAUDE.md";
const HEXA_DIR: &str = ".hexa";
const FLOWS_DIR: &str = "flows";
const DEFINITION_FILE: &str = "definition.json";
const TASK_VERSION: u32 = 1;
/// Copies of edited versions kept per flow when there is no git.
const MAX_SNAPSHOTS: usize = 100;
const BLOCK_BEGIN: &str = "<!-- hexa:begin";
const BLOCK_END: &str = "<!-- hexa:end -->";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEnv {
    pub host: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFlow {
    /// `workflow` id, lowercase.
    pub id: String,
    pub name: String,
    /// Folder under `flows/`.
    pub folder: String,
    pub added_on: String,
    /// `modifiedon` of the flow when it was added.
    pub cloud_modified_on: String,
    #[serde(default)]
    pub cloud_modified_by: String,
    /// Hash of the baseline (see `hash_text`).
    pub baseline_hash: String,
    /// Hash of the working version the user marked as reviewed.
    #[serde(default)]
    pub reviewed_hash: Option<String>,
    /// When the baseline was last read from the cloud again (None: when added).
    #[serde(default)]
    pub baseline_on: Option<String>,
}

fn open_status() -> String {
    "open".into()
}

/// `task.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFile {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub ticket: String,
    /// What the task asks for; goes into CLAUDE.md.
    #[serde(default)]
    pub description: String,
    pub env: TaskEnv,
    pub created_on: String,
    /// "open" or "done".
    #[serde(default = "open_status")]
    pub status: String,
    #[serde(default)]
    pub flows: Vec<TaskFlow>,
}

/// A task in the list (the registry of task folders).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub path: String,
    pub id: String,
    pub name: String,
    pub env: Option<TaskEnv>,
    pub status: String,
    /// Ids (lowercase) of the task's flows.
    pub flow_ids: Vec<String>,
    pub created_on: String,
    pub last_opened: String,
    /// The folder (or its task.json) is gone or unreadable.
    pub missing: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    /// `git` runs on this machine.
    pub available: bool,
    /// The task folder is a git repository.
    pub repo: bool,
}

/// A flow of the task as it is on disk now.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlowState {
    pub id: String,
    /// Relative to the task folder, with `/`.
    pub file: String,
    /// None when the file is missing or isn't JSON.
    pub working_hash: Option<String>,
    /// Missing file / JSON error ("expected `,` at line 12 column 5").
    pub error: Option<String>,
    pub modified_at: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub path: String,
    pub task: TaskFile,
    pub git: GitState,
    pub flows: Vec<FlowState>,
    /// Something that went wrong besides the change itself (a git commit).
    pub warning: Option<String>,
}

/// Where a new task folder would go.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: String,
    /// What's wrong with the folder name; None when fine.
    pub problem: Option<String>,
    pub exists: bool,
    pub not_empty: bool,
    /// The git repository the folder would be inside.
    pub inside_repo: Option<String>,
    pub one_drive: bool,
    pub git_available: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    pub parent: String,
    pub folder: String,
    pub name: String,
    #[serde(default)]
    pub ticket: String,
    #[serde(default)]
    pub description: String,
    pub env: TaskEnv,
    pub git: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AddFlow {
    pub id: String,
    pub name: String,
}

/// What happens to the working copy when the baseline is read from the cloud again.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BaselineMode {
    /// Only the baseline changes; the edits stay.
    Keep,
    /// The working copy becomes the cloud version too (the edits are kept in history first).
    Take,
}

/// A version of a flow's file kept in the task: a git commit or a snapshot.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    /// `git:<sha>` or `snap:<file name>`.
    pub id: String,
    pub label: String,
    pub at: String,
}

/// A task flow as it is in the environment now.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LiveFlow {
    pub id: String,
    pub name: String,
    pub content: Option<String>,
    pub hash: Option<String>,
    pub modified_on: String,
    pub modified_by: String,
    pub error: Option<String>,
}

// ---------------------------------------------------------------- hashing

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                write_canonical(&map[k.as_str()], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// SHA-256 of the JSON with keys sorted and no whitespace: re-indenting or
/// reordering keys isn't a change. Err = the JSON error.
pub fn hash_text(text: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    let mut canonical = String::new();
    write_canonical(&value, &mut canonical);
    Ok(hex(&Sha256::digest(canonical.as_bytes())))
}

// ---------------------------------------------------------------- names, paths

/// Letters, digits, `_` and `-` from a name, for a folder; `fallback` if none.
pub fn slug(name: &str, max: usize, fallback: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let mut out: String = out.trim_matches('-').chars().take(max).collect();
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

/// `Invoice-Sync__3f2a9c1e`.
pub fn flow_folder(name: &str, id: &str) -> String {
    format!("{}__{}", slug(name, 60, "flow"), &id[..8.min(id.len())])
}

/// What's wrong with a folder name on Windows; None when fine.
pub fn folder_problem(name: &str) -> Option<&'static str> {
    let name_trim = name.trim();
    if name_trim.is_empty() {
        return Some("Enter a folder name.");
    }
    if name.chars().count() > 120 {
        return Some("The folder name is too long.");
    }
    if name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return Some("A folder name can't contain < > : \" / \\ | ? *.");
    }
    if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') {
        return Some("A folder name can't start with a space or end with a space or a dot.");
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: &[&str] = &["CON", "PRN", "AUX", "NUL"];
    let numbered = (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit();
    if RESERVED.contains(&stem.as_str()) || numbered {
        return Some("That name is reserved by Windows.");
    }
    None
}

/// The git repository `dir` (or a folder above it) belongs to.
pub fn enclosing_repo(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|d| d.join(".git").exists()).map(|d| d.to_path_buf())
}

/// Inside a OneDrive folder (syncing a git repository there breaks it).
pub fn in_one_drive(dir: &Path) -> bool {
    let lower = dir.to_string_lossy().to_lowercase().replace('/', "\\");
    ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"].iter().any(|var| {
        std::env::var(var)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(|v| {
                let root = v.to_lowercase().replace('/', "\\");
                let root = root.trim_end_matches('\\');
                lower == root || lower.starts_with(&format!("{}\\", root))
            })
            .unwrap_or(false)
    })
}

/// `%USERPROFILE%\HexaTasks`.
pub fn default_root() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("C:\\"))
        .join("HexaTasks")
        .to_string_lossy()
        .to_string()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}

// ---------------------------------------------------------------- git

/// A `git` command for `dir` without a console window.
fn git_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs git in `dir`; Err = its message.
fn git(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = git_command(dir).args(args).output().map_err(|e| AppError::msg(format!("Couldn't run git: {}", e)))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(AppError::msg(format!("git {}: {}", args.first().unwrap_or(&""), err)))
    }
}

pub fn git_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let mut cmd = Command::new("git");
        cmd.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    })
}

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

const GITIGNORE: &str = "# Hexa Studio keeps the original of each flow here; it isn't part of the history.\n.hexa/\n";
const GITATTRIBUTES: &str = "* text=auto eol=lf\n";

fn git_init(dir: &Path) -> AppResult<()> {
    git(dir, &["init", "-q"])?;
    git(dir, &["config", "core.autocrlf", "false"])?;
    std::fs::write(dir.join(".gitignore"), GITIGNORE)?;
    std::fs::write(dir.join(".gitattributes"), GITATTRIBUTES)?;
    Ok(())
}

/// Commits `paths` (relative, may be deleted) when they changed. Uses a
/// stand-in author when git has none configured.
fn git_commit(dir: &Path, paths: &[String], message: &str) -> AppResult<()> {
    let mut add = vec!["add", "-A", "--"];
    add.extend(paths.iter().map(|p| p.as_str()));
    git(dir, &add)?;
    let mut staged = git_command(dir);
    staged.args(["diff", "--cached", "--quiet", "--"]).args(paths);
    if staged.status().map(|s| s.success()).unwrap_or(false) {
        return Ok(());
    }
    let has_email = git(dir, &["config", "user.email"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let mut args: Vec<&str> = Vec::new();
    if !has_email {
        args.extend(["-c", "user.name=Hexa Studio", "-c", "user.email=hexa-studio@localhost"]);
    }
    args.extend(["commit", "-q", "-m", message, "--"]);
    args.extend(paths.iter().map(|p| p.as_str()));
    git(dir, &args)?;
    Ok(())
}

// ---------------------------------------------------------------- registry

#[derive(Serialize, Deserialize, Default)]
struct Registry {
    tasks: Vec<RegistryEntry>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
    path: String,
    last_opened: String,
}

fn registry_file() -> PathBuf {
    if cfg!(test) {
        // One per test (tests run in parallel, each on a thread named after it).
        let name = std::thread::current().name().unwrap_or("test").replace(|c: char| !c.is_ascii_alphanumeric(), "_");
        return std::env::temp_dir().join(format!("hexa-flowtasks-registry-{}.json", name));
    }
    crate::config::config_dir().join("flow-tasks.json")
}

fn load_registry() -> Registry {
    std::fs::read_to_string(registry_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_registry(r: &Registry) -> AppResult<()> {
    std::fs::write(registry_file(), serde_json::to_string_pretty(r)?)?;
    Ok(())
}

fn remember(path: &str) -> AppResult<()> {
    let mut r = load_registry();
    r.tasks.retain(|t| !same_path(&t.path, path));
    r.tasks.insert(0, RegistryEntry { path: path.to_string(), last_opened: now() });
    save_registry(&r)
}

/// Only folders the user created or opened as tasks are read or written.
fn registered(path: &str) -> AppResult<PathBuf> {
    if load_registry().tasks.iter().any(|t| same_path(&t.path, path)) {
        Ok(PathBuf::from(path))
    } else {
        Err(AppError::msg("This folder isn't one of your flow tasks. Open it as a task first."))
    }
}

// ---------------------------------------------------------------- task files

fn read_task(dir: &Path) -> AppResult<TaskFile> {
    let text = std::fs::read_to_string(dir.join(TASK_FILE))
        .map_err(|_| AppError::msg(format!("{} has no {} — it isn't a flow task folder.", dir.display(), TASK_FILE)))?;
    serde_json::from_str(&text).map_err(|e| AppError::msg(format!("{} is damaged: {}", TASK_FILE, e)))
}

fn write_task(dir: &Path, task: &TaskFile) -> AppResult<()> {
    std::fs::write(dir.join(TASK_FILE), serde_json::to_string_pretty(task)? + "\n")?;
    Ok(())
}

fn summary(path: &str, last_opened: &str) -> TaskSummary {
    match read_task(Path::new(path)) {
        Ok(t) => TaskSummary {
            path: path.to_string(),
            id: t.id,
            name: t.name,
            env: Some(t.env),
            status: t.status,
            flow_ids: t.flows.iter().map(|f| f.id.clone()).collect(),
            created_on: t.created_on,
            last_opened: last_opened.to_string(),
            missing: false,
        },
        Err(_) => TaskSummary {
            path: path.to_string(),
            id: String::new(),
            name: Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            env: None,
            status: "open".into(),
            flow_ids: Vec::new(),
            created_on: String::new(),
            last_opened: last_opened.to_string(),
            missing: true,
        },
    }
}

/// The CLAUDE.md block the app owns (rewritten on every change).
fn claude_block(task: &TaskFile, git: bool) -> String {
    let mut s = String::new();
    s.push_str("<!-- hexa:begin — written by Hexa Studio; edits inside this block are replaced. Write your own notes below the end marker. -->\n");
    s.push_str(&format!("Environment: **{}** (`{}`)", task.env.name, task.env.host));
    if !task.ticket.trim().is_empty() {
        s.push_str(&format!(" · Ticket: {}", task.ticket.trim()));
    }
    s.push_str("\n\n## The task\n\n");
    if task.description.trim().is_empty() {
        s.push_str("_(No description yet — ask the user what needs to change.)_\n");
    } else {
        s.push_str(task.description.trim());
        s.push('\n');
    }
    s.push_str("\n## Flows in this task\n\n");
    if task.flows.is_empty() {
        s.push_str("_(None yet.)_\n");
    } else {
        s.push_str("| Flow | File to edit | Flow id |\n|---|---|---|\n");
        for f in &task.flows {
            s.push_str(&format!(
                "| {} | `{}/{}/{}` | `{}` |\n",
                f.name.replace('|', "\\|"),
                FLOWS_DIR,
                f.folder,
                DEFINITION_FILE,
                f.id
            ));
        }
    }
    s.push_str(
        "\n## How to edit these flows\n\n\
- Edit only `flows/*/definition.json`. Don't touch `.hexa/` or `task.json`: Hexa Studio keeps the original of each flow there and compares your version with it before anything goes back to Power Automate. Nothing here is deployed automatically.\n\
- Each file is the flow's `clientdata`: `properties.definition` (`triggers`, `actions`) and `properties.connectionReferences`. Keep `schemaVersion` and that shape. The file must stay valid JSON.\n\
- Keep the keys of `connectionReferences` as they are. Only use connectors the flow already references, unless the task says otherwise (a new connection reference must already exist in the environment).\n\
- Action names are unique across the whole flow. When you rename an action, update every `runAfter` that names it and every expression that does: `body('…')`, `outputs('…')`, `actions('…')`, `items('…')`, `result('…')`.\n\
- `runAfter` can only name actions in the same scope (siblings).\n\
- Declare variables with an \"Initialize variable\" action at the top level before any `variables('…')` uses them.\n\
- Leave existing `metadata.operationMetadataId` values alone; new actions don't need one.\n\
- Don't change the trigger unless the task asks for it.\n",
    );
    if git {
        s.push_str("- This folder is a git repository with no remote: committing is fine, but don't run `git reset`, `git checkout`, `git stash`, `git clean` or rewrite history.\n");
    }
    s.push_str(BLOCK_END);
    s
}

/// Rewrites the app's block of CLAUDE.md, keeping the rest of the file.
fn write_claude_md(dir: &Path, task: &TaskFile, git: bool) -> AppResult<()> {
    let block = claude_block(task, git);
    let file = dir.join(CLAUDE_FILE);
    let text = match std::fs::read_to_string(&file) {
        Ok(old) => match (old.find(BLOCK_BEGIN), old.find(BLOCK_END)) {
            (Some(b), Some(e)) if b < e => format!("{}{}{}", &old[..b], block, &old[e + BLOCK_END.len()..]),
            _ => format!("{}\n\n{}\n", old.trim_end(), block),
        },
        Err(_) => format!(
            "# {}\n\n{}\n\n## Notes\n\n_Your own notes for whoever edits these flows — Hexa Studio keeps everything outside the hexa:begin / hexa:end markers._\n",
            task.name, block
        ),
    };
    std::fs::write(file, text)?;
    Ok(())
}

fn baseline_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(HEXA_DIR).join("baseline").join(format!("{}.json", id))
}

fn working_rel(folder: &str) -> String {
    format!("{}/{}/{}", FLOWS_DIR, folder, DEFINITION_FILE)
}

fn snapshot_dir(dir: &Path, id: &str) -> PathBuf {
    dir.join(HEXA_DIR).join("snapshots").join(id)
}

fn is_snapshot_name(name: &str) -> bool {
    // 20261003T101500_0123456789ab.json
    let b = name.as_bytes();
    name.len() == 33
        && name.ends_with(".json")
        && b[8] == b'T'
        && b[15] == b'_'
        && name[..8].bytes().all(|c| c.is_ascii_digit())
        && name[9..15].bytes().all(|c| c.is_ascii_digit())
        && name[16..28].bytes().all(|c| c.is_ascii_hexdigit())
}

fn baseline_history_dir(dir: &Path, id: &str) -> PathBuf {
    dir.join(HEXA_DIR).join("baseline-history").join(id)
}

/// `<UTC>_<hash12>.json` files in a folder, oldest first.
fn stamped_files(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_snapshot_name(n)).collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// The time in a `<UTC>_<hash12>.json` name, as RFC 3339.
fn stamp_time(name: &str) -> String {
    chrono::NaiveDateTime::parse_from_str(&name[..15], "%Y%m%dT%H%M%S")
        .map(|t| t.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn stamp(hash: &str) -> String {
    format!("{}_{}.json", chrono::Utc::now().format("%Y%m%dT%H%M%S"), hash.get(..12).unwrap_or("000000000000"))
}

fn snapshots(dir: &Path, id: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(snapshot_dir(dir, id))
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_snapshot_name(n)).collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// Without git: keeps a copy of a new valid version that isn't the baseline.
fn snapshot_if_new(dir: &Path, flow: &TaskFlow, text: &str, hash: &str) -> AppResult<()> {
    if hash == flow.baseline_hash {
        return Ok(());
    }
    let existing = snapshots(dir, &flow.id);
    if existing.last().map(|n| &n[16..28] == &hash[..12]).unwrap_or(false) {
        return Ok(());
    }
    let folder = snapshot_dir(dir, &flow.id);
    std::fs::create_dir_all(&folder)?;
    let name = format!("{}_{}.json", chrono::Utc::now().format("%Y%m%dT%H%M%S"), &hash[..12]);
    std::fs::write(folder.join(name), text)?;
    if existing.len() + 1 > MAX_SNAPSHOTS {
        for old in &existing[..existing.len() + 1 - MAX_SNAPSHOTS] {
            let _ = std::fs::remove_file(folder.join(old));
        }
    }
    Ok(())
}

fn flow_state(dir: &Path, flow: &TaskFlow, repo: bool) -> FlowState {
    let rel = working_rel(&flow.folder);
    let path = dir.join(&rel);
    let modified_at = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    let (working_hash, error) = match std::fs::read_to_string(&path) {
        Err(_) => (None, Some(format!("{} is missing.", rel))),
        Ok(text) => match hash_text(&text) {
            Ok(hash) => {
                if !repo {
                    // A snapshot that can't be written isn't worth failing the view.
                    let _ = snapshot_if_new(dir, flow, &text, &hash);
                }
                (Some(hash), None)
            }
            Err(e) => (None, Some(format!("Not valid JSON: {}", e))),
        },
    };
    FlowState { id: flow.id.clone(), file: rel, working_hash, error, modified_at }
}

fn view_of(dir: &Path, task: TaskFile, warning: Option<String>) -> TaskView {
    let repo = is_repo(dir);
    let flows = task.flows.iter().map(|f| flow_state(dir, f, repo)).collect();
    TaskView {
        path: dir.to_string_lossy().to_string(),
        task,
        git: GitState { available: git_available(), repo },
        flows,
        warning,
    }
}

// ---------------------------------------------------------------- operations

/// Every task folder the user created or opened, last opened first.
pub fn list() -> Vec<TaskSummary> {
    load_registry().tasks.iter().map(|t| summary(&t.path, &t.last_opened)).collect()
}

pub fn check_location(parent: &str, folder: &str) -> Location {
    let path = Path::new(parent.trim()).join(folder.trim());
    let exists = path.exists();
    let not_empty = exists && std::fs::read_dir(&path).map(|mut d| d.next().is_some()).unwrap_or(true);
    let problem = if parent.trim().is_empty() {
        Some("Choose where to put the task.")
    } else if !Path::new(parent.trim()).is_absolute() {
        Some("Use a full path, like C:\\Users\\you\\HexaTasks.")
    } else {
        folder_problem(folder.trim())
    };
    Location {
        path: path.to_string_lossy().to_string(),
        problem: problem.map(|p| p.to_string()),
        exists,
        not_empty,
        inside_repo: enclosing_repo(&path).map(|p| p.to_string_lossy().to_string()),
        one_drive: in_one_drive(&path),
        git_available: git_available(),
    }
}

pub fn create(new: NewTask) -> AppResult<TaskView> {
    let loc = check_location(&new.parent, &new.folder);
    if let Some(p) = loc.problem {
        return Err(AppError::msg(p));
    }
    if loc.not_empty {
        return Err(AppError::msg(format!("{} already has files in it. Pick a new folder.", loc.path)));
    }
    if new.name.trim().is_empty() {
        return Err(AppError::msg("Give the task a name."));
    }
    let dir = PathBuf::from(&loc.path);
    std::fs::create_dir_all(dir.join(FLOWS_DIR))?;
    std::fs::create_dir_all(dir.join(HEXA_DIR).join("baseline"))?;
    let task = TaskFile {
        version: TASK_VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        name: new.name.trim().to_string(),
        ticket: new.ticket.trim().to_string(),
        description: new.description.trim().to_string(),
        env: TaskEnv { host: new.env.host.trim().to_ascii_lowercase(), name: new.env.name.trim().to_string() },
        created_on: now(),
        status: open_status(),
        flows: Vec::new(),
    };
    write_task(&dir, &task)?;
    let use_git = new.git && loc.git_available && loc.inside_repo.is_none();
    let mut warning = None;
    if use_git {
        if let Err(e) = git_init(&dir) {
            warning = Some(format!("Couldn't set up git: {}", e));
        }
    }
    write_claude_md(&dir, &task, is_repo(&dir))?;
    if is_repo(&dir) {
        let paths = [TASK_FILE, CLAUDE_FILE, ".gitignore", ".gitattributes"].map(String::from);
        if let Err(e) = git_commit(&dir, &paths, &format!("Create task: {}", task.name)) {
            warning = Some(format!("Couldn't commit: {}", e));
        }
    }
    remember(&loc.path)?;
    Ok(view_of(&dir, task, warning))
}

/// Adds an existing task folder to the list.
pub fn open(path: &str) -> AppResult<TaskView> {
    let dir = PathBuf::from(path);
    let task = read_task(&dir)?;
    remember(path)?;
    Ok(view_of(&dir, task, None))
}

/// Takes a task off the list; its folder stays.
pub fn forget(path: &str) -> AppResult<()> {
    let mut r = load_registry();
    r.tasks.retain(|t| !same_path(&t.path, path));
    save_registry(&r)
}

/// The task and its flows' files now (without git, also keeps a copy of
/// each new edited version).
pub fn load(path: &str) -> AppResult<TaskView> {
    let dir = registered(path)?;
    let task = read_task(&dir)?;
    Ok(view_of(&dir, task, None))
}

pub fn update_details(path: &str, name: &str, ticket: &str, description: &str, status: &str) -> AppResult<TaskView> {
    let dir = registered(path)?;
    let mut task = read_task(&dir)?;
    if name.trim().is_empty() {
        return Err(AppError::msg("Give the task a name."));
    }
    if status != "open" && status != "done" {
        return Err(AppError::msg("Unknown task status."));
    }
    task.name = name.trim().to_string();
    task.ticket = ticket.trim().to_string();
    task.description = description.trim().to_string();
    task.status = status.to_string();
    write_task(&dir, &task)?;
    write_claude_md(&dir, &task, is_repo(&dir))?;
    let mut warning = None;
    if is_repo(&dir) {
        if let Err(e) = git_commit(&dir, &[TASK_FILE.into(), CLAUDE_FILE.into()], "Update task details") {
            warning = Some(format!("Couldn't commit: {}", e));
        }
    }
    Ok(view_of(&dir, task, warning))
}

/// Reads the flows from the environment and checks them out into the task.
pub fn add_flows(path: &str, host: &str, token: &str, flows: &[AddFlow]) -> AppResult<TaskView> {
    let dir = registered(path)?;
    let task = read_task(&dir)?;
    if !task.env.host.eq_ignore_ascii_case(host) {
        return Err(AppError::msg(format!(
            "This task works on {} ({}); switch to that environment to add its flows.",
            task.env.name, task.env.host
        )));
    }
    let wanted: Vec<&AddFlow> = flows
        .iter()
        .filter(|f| !task.flows.iter().any(|t| t.id.eq_ignore_ascii_case(&f.id)))
        .collect();
    if wanted.is_empty() {
        return Ok(view_of(&dir, task, None));
    }
    let fetched = fetch_all(host, token, &wanted.iter().map(|f| f.id.to_ascii_lowercase()).collect::<Vec<_>>());
    add_fetched(&dir, task, &wanted, fetched)
}

/// Writes flows read from the environment into the task (baseline + working copy).
fn add_fetched(dir: &Path, mut task: TaskFile, wanted: &[&AddFlow], fetched: Vec<AppResult<crate::flows::FlowDefinition>>) -> AppResult<TaskView> {
    let dir = dir.to_path_buf();
    let mut problems = Vec::new();
    let mut added = Vec::new();
    for (f, got) in wanted.iter().zip(fetched) {
        let def = match got {
            Ok(d) => d,
            Err(e) => {
                problems.push(format!("{}: {}", f.name, e));
                continue;
            }
        };
        if def.managed {
            problems.push(format!("{} is managed — it can't be changed in this environment.", f.name));
            continue;
        }
        let id = f.id.to_ascii_lowercase();
        let name = if def.name.is_empty() { f.name.clone() } else { def.name.clone() };
        let folder = flow_folder(&name, &id);
        let working = dir.join(FLOWS_DIR).join(&folder);
        if working.join(DEFINITION_FILE).exists() {
            problems.push(format!("{}: flows/{} already exists.", name, folder));
            continue;
        }
        let text = format!("{}\n", def.content.trim_end());
        let hash = hash_text(&text).map_err(|e| AppError::msg(format!("{}: the definition isn't JSON ({})", name, e)))?;
        std::fs::create_dir_all(&working)?;
        std::fs::create_dir_all(dir.join(HEXA_DIR).join("baseline"))?;
        std::fs::write(baseline_file(&dir, &id), &text)?;
        std::fs::write(working.join(DEFINITION_FILE), &text)?;
        task.flows.push(TaskFlow {
            id,
            name,
            folder,
            added_on: now(),
            cloud_modified_on: def.modified_on,
            cloud_modified_by: def.modified_by,
            baseline_hash: hash,
            reviewed_hash: None,
            baseline_on: None,
        });
        added.push(task.flows.last().unwrap().clone());
    }
    if !added.is_empty() {
        write_task(&dir, &task)?;
        write_claude_md(&dir, &task, is_repo(&dir))?;
    }
    let mut warning = (!problems.is_empty()).then(|| format!("Not added — {}", problems.join("; ")));
    if is_repo(&dir) && !added.is_empty() {
        let mut paths: Vec<String> = added.iter().map(|f| format!("{}/{}", FLOWS_DIR, f.folder)).collect();
        paths.push(TASK_FILE.into());
        paths.push(CLAUDE_FILE.into());
        let names: Vec<&str> = added.iter().map(|f| f.name.as_str()).collect();
        let message = format!("Add {} (baseline from {})", names.join(", "), task.env.name);
        if let Err(e) = git_commit(&dir, &paths, &message) {
            let msg = format!("Couldn't commit: {}", e);
            warning = Some(warning.map(|w| format!("{} · {}", w, msg)).unwrap_or(msg));
        }
    }
    if added.is_empty() {
        return Err(AppError::msg(warning.unwrap_or_else(|| "Nothing was added.".into())));
    }
    Ok(view_of(&dir, task, warning))
}

/// Takes a flow out of the task; its files move to `.hexa/removed/`.
pub fn remove_flow(path: &str, flow_id: &str) -> AppResult<TaskView> {
    let dir = registered(path)?;
    let mut task = read_task(&dir)?;
    let Some(pos) = task.flows.iter().position(|f| f.id.eq_ignore_ascii_case(flow_id)) else {
        return Err(AppError::msg("That flow isn't in this task."));
    };
    let flow = task.flows.remove(pos);
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S").to_string();
    let removed = dir.join(HEXA_DIR).join("removed");
    std::fs::create_dir_all(&removed)?;
    let working = dir.join(FLOWS_DIR).join(&flow.folder);
    if working.exists() {
        std::fs::rename(&working, removed.join(format!("{}-{}", flow.folder, stamp)))?;
    }
    let baseline = baseline_file(&dir, &flow.id);
    if baseline.exists() {
        std::fs::rename(&baseline, removed.join(format!("{}-{}.baseline.json", flow.id, stamp)))?;
    }
    write_task(&dir, &task)?;
    write_claude_md(&dir, &task, is_repo(&dir))?;
    let mut warning = None;
    if is_repo(&dir) {
        let paths = vec![format!("{}/{}", FLOWS_DIR, flow.folder), TASK_FILE.into(), CLAUDE_FILE.into()];
        if let Err(e) = git_commit(&dir, &paths, &format!("Remove {}", flow.name)) {
            warning = Some(format!("Couldn't commit: {}", e));
        }
    }
    Ok(view_of(&dir, task, warning))
}

/// Marks the working version (by hash) as reviewed, or clears it.
pub fn set_reviewed(path: &str, flow_id: &str, hash: Option<String>) -> AppResult<TaskView> {
    let dir = registered(path)?;
    let mut task = read_task(&dir)?;
    let flow = task
        .flows
        .iter_mut()
        .find(|f| f.id.eq_ignore_ascii_case(flow_id))
        .ok_or_else(|| AppError::msg("That flow isn't in this task."))?;
    flow.reviewed_hash = hash;
    write_task(&dir, &task)?;
    Ok(view_of(&dir, task, None))
}

fn task_flow(task: &TaskFile, flow_id: &str) -> AppResult<TaskFlow> {
    task.flows
        .iter()
        .find(|f| f.id.eq_ignore_ascii_case(flow_id))
        .cloned()
        .ok_or_else(|| AppError::msg("That flow isn't in this task."))
}

/// Earlier versions of a flow's file: git commits, or the app's snapshots. Newest first.
pub fn versions(path: &str, flow_id: &str) -> AppResult<Vec<Version>> {
    let dir = registered(path)?;
    let task = read_task(&dir)?;
    let flow = task_flow(&task, flow_id)?;
    let mut out = if is_repo(&dir) && git_available() {
        let log = git(&dir, &["log", "--format=%H%x1f%cI%x1f%s", "--", &working_rel(&flow.folder)])?;
        parse_git_log(&log)
    } else {
        snapshots(&dir, &flow.id)
            .into_iter()
            .rev()
            .map(|name| Version { at: stamp_time(&name), id: format!("snap:{}", name), label: "Saved by Hexa Studio".into() })
            .collect()
    };
    // Baselines replaced by a newer read of the cloud.
    out.extend(
        stamped_files(&baseline_history_dir(&dir, &flow.id))
            .into_iter()
            .rev()
            .map(|name| Version { at: stamp_time(&name), id: format!("base:{}", name), label: "Earlier baseline".into() }),
    );
    Ok(out)
}

pub fn parse_git_log(out: &str) -> Vec<Version> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let sha = parts.next()?.trim();
            let at = parts.next()?.trim();
            let subject = parts.next().unwrap_or("").trim();
            (sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit())).then(|| Version {
                id: format!("git:{}", sha),
                label: subject.to_string(),
                at: at.to_string(),
            })
        })
        .collect()
}

/// A version's text: `baseline`, `working`, `git:<sha>`, `snap:<file>` or `base:<file>`.
pub fn version_text(path: &str, flow_id: &str, version: &str) -> AppResult<String> {
    let dir = registered(path)?;
    let task = read_task(&dir)?;
    let flow = task_flow(&task, flow_id)?;
    let text = if version == "baseline" {
        std::fs::read_to_string(baseline_file(&dir, &flow.id)).map_err(|_| AppError::msg("The baseline of this flow is missing from .hexa/baseline."))?
    } else if version == "working" {
        std::fs::read_to_string(dir.join(working_rel(&flow.folder))).map_err(|_| AppError::msg(format!("{} is missing.", working_rel(&flow.folder))))?
    } else if let Some(sha) = version.strip_prefix("git:") {
        if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::msg("Invalid commit."));
        }
        git(&dir, &["show", &format!("{}:{}", sha, working_rel(&flow.folder))])?
    } else if let Some(name) = version.strip_prefix("snap:") {
        if !is_snapshot_name(name) {
            return Err(AppError::msg("Invalid snapshot."));
        }
        std::fs::read_to_string(snapshot_dir(&dir, &flow.id).join(name))?
    } else if let Some(name) = version.strip_prefix("base:") {
        if !is_snapshot_name(name) {
            return Err(AppError::msg("Invalid baseline."));
        }
        std::fs::read_to_string(baseline_history_dir(&dir, &flow.id).join(name))?
    } else {
        return Err(AppError::msg("Unknown version."));
    };
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// Reads the flow from the cloud again as its baseline (the old one is kept
/// in `.hexa/baseline-history`). `Take` also replaces the working copy;
/// an unedited working copy always follows the cloud.
pub fn update_baseline(path: &str, host: &str, token: &str, flow_id: &str, mode: BaselineMode) -> AppResult<TaskView> {
    let dir = registered(path)?;
    let task = read_task(&dir)?;
    if !task.env.host.eq_ignore_ascii_case(host) {
        return Err(AppError::msg(format!("This task works on {} ({}).", task.env.name, task.env.host)));
    }
    let flow = task_flow(&task, flow_id)?;
    let def = crate::flows::definition_with_meta(host, token, &flow.id)?;
    rebase(&dir, task, &flow.id, def, mode)
}

fn rebase(dir: &Path, mut task: TaskFile, flow_id: &str, def: crate::flows::FlowDefinition, mode: BaselineMode) -> AppResult<TaskView> {
    let text = format!("{}\n", def.content.trim_end());
    let hash = hash_text(&text).map_err(|e| AppError::msg(format!("The flow in the cloud isn't JSON ({})", e)))?;
    let i = task
        .flows
        .iter()
        .position(|f| f.id.eq_ignore_ascii_case(flow_id))
        .ok_or_else(|| AppError::msg("That flow isn't in this task."))?;
    let flow = task.flows[i].clone();
    let repo = is_repo(dir);
    let working_rel_path = working_rel(&flow.folder);
    let working_path = dir.join(&working_rel_path);
    let working = std::fs::read_to_string(&working_path).ok();
    let working_hash = working.as_deref().and_then(|t| hash_text(t).ok());
    let edited = working_hash.as_deref() != Some(flow.baseline_hash.as_str());
    let replace_working = mode == BaselineMode::Take || !edited;
    let mut warnings = Vec::new();

    // The old baseline stays comparable.
    if let Ok(old) = std::fs::read_to_string(baseline_file(dir, &flow.id)) {
        let history = baseline_history_dir(dir, &flow.id);
        std::fs::create_dir_all(&history)?;
        std::fs::write(history.join(stamp(&flow.baseline_hash)), old)?;
    }
    // Edits about to be replaced are kept first.
    if replace_working && edited {
        if let Some(w) = &working {
            if repo {
                let message = format!("Edits to {} before taking the {} version", flow.name, task.env.name);
                if let Err(e) = git_commit(dir, &[format!("{}/{}", FLOWS_DIR, flow.folder)], &message) {
                    warnings.push(format!("Couldn't commit your edits first: {}", e));
                }
            } else if let Some(h) = &working_hash {
                snapshot_if_new(dir, &flow, w, h)?;
            } else {
                // Not JSON: no hash to name it by.
                let replaced = dir.join(HEXA_DIR).join("replaced");
                std::fs::create_dir_all(&replaced)?;
                std::fs::write(replaced.join(format!("{}-{}.json", flow.id, chrono::Utc::now().format("%Y%m%dT%H%M%S"))), w)?;
            }
        }
    }

    std::fs::create_dir_all(dir.join(HEXA_DIR).join("baseline"))?;
    std::fs::write(baseline_file(dir, &flow.id), &text)?;
    if replace_working {
        if let Some(parent) = working_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&working_path, &text)?;
    }
    let f = &mut task.flows[i];
    f.baseline_hash = hash;
    f.cloud_modified_on = def.modified_on;
    f.cloud_modified_by = def.modified_by;
    f.reviewed_hash = None;
    f.baseline_on = Some(now());
    if !def.name.is_empty() {
        f.name = def.name;
    }
    let name = f.name.clone();
    write_task(dir, &task)?;
    write_claude_md(dir, &task, repo)?;
    if repo {
        let message = if replace_working && edited {
            format!("Take {} from {} (new baseline)", name, task.env.name)
        } else {
            format!("Update baseline of {} from {}", name, task.env.name)
        };
        let paths = vec![format!("{}/{}", FLOWS_DIR, flow.folder), TASK_FILE.into(), CLAUDE_FILE.into()];
        if let Err(e) = git_commit(dir, &paths, &message) {
            warnings.push(format!("Couldn't commit: {}", e));
        }
    }
    let warning = (!warnings.is_empty()).then(|| warnings.join(" · "));
    Ok(view_of(dir, task, warning))
}

/// Reads definitions on up to `FETCH_THREADS` threads; results in `ids` order.
fn fetch_all(host: &str, token: &str, ids: &[String]) -> Vec<AppResult<crate::flows::FlowDefinition>> {
    const FETCH_THREADS: usize = 6;
    if ids.is_empty() {
        return Vec::new();
    }
    let per_thread = ids.len().div_ceil(FETCH_THREADS);
    std::thread::scope(|s| {
        let handles: Vec<_> = ids
            .chunks(per_thread)
            .map(|chunk| {
                s.spawn(move || chunk.iter().map(|id| crate::flows::definition_with_meta(host, token, id)).collect::<Vec<_>>())
            })
            .collect();
        handles
            .into_iter()
            .zip(ids.chunks(per_thread))
            .flat_map(|(h, chunk)| {
                h.join().unwrap_or_else(|_| chunk.iter().map(|_| Err(AppError::msg("Reading the flow stopped unexpectedly."))).collect())
            })
            .collect()
    })
}

/// The task's flows as they are in the environment now.
pub fn live(path: &str, host: &str, token: &str) -> AppResult<Vec<LiveFlow>> {
    let dir = registered(path)?;
    let task = read_task(&dir)?;
    if !task.env.host.eq_ignore_ascii_case(host) {
        return Err(AppError::msg(format!("This task works on {} ({}).", task.env.name, task.env.host)));
    }
    let ids: Vec<String> = task.flows.iter().map(|f| f.id.clone()).collect();
    Ok(task
        .flows
        .iter()
        .zip(fetch_all(host, token, &ids))
        .map(|(f, got)| match got {
            Ok(d) => LiveFlow {
                id: f.id.clone(),
                name: d.name,
                hash: hash_text(&d.content).ok(),
                content: Some(format!("{}\n", d.content.trim_end())),
                modified_on: d.modified_on,
                modified_by: d.modified_by,
                error: None,
            },
            Err(e) => LiveFlow {
                id: f.id.clone(),
                name: f.name.clone(),
                content: None,
                hash: None,
                modified_on: String::new(),
                modified_by: String::new(),
                error: Some(e.to_string()),
            },
        })
        .collect())
}

/// Opens the task folder in Explorer.
pub fn reveal(path: &str) -> AppResult<()> {
    let dir = registered(path)?;
    Command::new("explorer").arg(&dir).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_ignore_whitespace_and_key_order() {
        let a = hash_text("{\"b\": 1, \"a\": [1, {\"y\": 2, \"x\": 3}]}").unwrap();
        let b = hash_text("{\n  \"a\": [1, {\"x\": 3, \"y\": 2}],\n  \"b\": 1\n}\n").unwrap();
        let c = hash_text("{\"a\": [1, {\"x\": 3, \"y\": 2}], \"b\": 2}").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(hash_text("\u{feff}{}").unwrap(), hash_text("{}").unwrap());
        assert!(hash_text("{\"a\": }").unwrap_err().contains("line 1"));
    }

    #[test]
    fn folders_are_named_after_the_flow_and_its_id() {
        assert_eq!(flow_folder("Invoice Sync (v2) — daily", "3f2a9c1e-0000-4000-8000-000000000001"), "Invoice-Sync-v2-daily__3f2a9c1e");
        assert_eq!(flow_folder("Đồng bộ", "aaaaaaaa-0"), "ng-b__aaaaaaaa");
        assert_eq!(flow_folder("!!!", "bbbbbbbb-1"), "flow__bbbbbbbb");
        assert_eq!(slug(&"x".repeat(100), 60, "f").len(), 60);
    }

    #[test]
    fn folder_names_windows_refuses_are_caught() {
        assert!(folder_problem("TASK-482 invoice").is_none());
        assert!(folder_problem("").is_some());
        assert!(folder_problem("a/b").is_some());
        assert!(folder_problem("a:b").is_some());
        assert!(folder_problem("name.").is_some());
        assert!(folder_problem("CON").is_some());
        assert!(folder_problem("com1.txt").is_some());
        assert!(folder_problem("COMPANY").is_none());
    }

    #[test]
    fn snapshot_names_are_checked() {
        assert!(is_snapshot_name("20261003T101500_0123456789ab.json"));
        assert!(!is_snapshot_name("20261003T101500_0123456789ab.json.bak"));
        assert!(!is_snapshot_name("../../secret.json"));
        assert!(!is_snapshot_name("2026100XT101500_0123456789ab.json"));
    }

    #[test]
    fn git_log_lines_become_versions() {
        let sha = "a".repeat(40);
        let out = format!("{}\u{1f}2026-10-03T10:00:00+07:00\u{1f}Add Invoice Sync (baseline from DEV)\nnot a line\n", sha);
        assert_eq!(
            parse_git_log(&out),
            vec![Version { id: format!("git:{}", sha), label: "Add Invoice Sync (baseline from DEV)".into(), at: "2026-10-03T10:00:00+07:00".into() }]
        );
    }

    fn task(flows: Vec<TaskFlow>) -> TaskFile {
        TaskFile {
            version: 1,
            id: "t".into(),
            name: "TASK-1".into(),
            ticket: String::new(),
            description: "Fix the invoice sync".into(),
            env: TaskEnv { host: "dev.crm.dynamics.com".into(), name: "DEV".into() },
            created_on: now(),
            status: "open".into(),
            flows,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hexa-flowtasks-{}-{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_md_keeps_the_users_own_notes() {
        let dir = temp_dir("claude");
        let mut t = task(vec![]);
        write_claude_md(&dir, &t, false).unwrap();
        let first = std::fs::read_to_string(dir.join(CLAUDE_FILE)).unwrap();
        assert!(first.starts_with("# TASK-1"));
        assert!(first.contains("Fix the invoice sync"));
        assert!(!first.contains("git reset"));
        std::fs::write(dir.join(CLAUDE_FILE), first.replace("## Notes", "## Notes\n\nUse the EU tenant.")).unwrap();
        t.flows.push(TaskFlow {
            id: "3f2a9c1e-0000-4000-8000-000000000001".into(),
            name: "Invoice | Sync".into(),
            folder: "Invoice-Sync__3f2a9c1e".into(),
            added_on: now(),
            cloud_modified_on: String::new(),
            cloud_modified_by: String::new(),
            baseline_hash: String::new(),
            reviewed_hash: None,
            baseline_on: None,
        });
        write_claude_md(&dir, &t, true).unwrap();
        let second = std::fs::read_to_string(dir.join(CLAUDE_FILE)).unwrap();
        assert!(second.contains("Use the EU tenant."));
        assert!(second.contains("`flows/Invoice-Sync__3f2a9c1e/definition.json`"));
        assert!(second.contains("Invoice \\| Sync"));
        assert!(second.contains("git reset"));
        assert_eq!(second.matches(BLOCK_END).count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn edited_versions_are_kept_once_each_without_git() {
        let dir = temp_dir("snap");
        let text = "{\"a\": 1}";
        let base = hash_text(text).unwrap();
        let flow = TaskFlow {
            id: "3f2a9c1e-0000-4000-8000-000000000001".into(),
            name: "F".into(),
            folder: "F__3f2a9c1e".into(),
            added_on: now(),
            cloud_modified_on: String::new(),
            cloud_modified_by: String::new(),
            baseline_hash: base.clone(),
            reviewed_hash: None,
            baseline_on: None,
        };
        snapshot_if_new(&dir, &flow, text, &base).unwrap();
        assert!(snapshots(&dir, &flow.id).is_empty());
        let edited = "{\"a\": 2}";
        let h = hash_text(edited).unwrap();
        snapshot_if_new(&dir, &flow, edited, &h).unwrap();
        snapshot_if_new(&dir, &flow, "{ \"a\":2 }", &h).unwrap();
        assert_eq!(snapshots(&dir, &flow.id).len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn git_commits_only_the_given_paths() {
        if !git_available() {
            return;
        }
        let dir = temp_dir("git");
        git_init(&dir).unwrap();
        std::fs::create_dir_all(dir.join("flows/A__1")).unwrap();
        std::fs::create_dir_all(dir.join("flows/B__2")).unwrap();
        std::fs::write(dir.join("flows/A__1/definition.json"), "{}\n").unwrap();
        std::fs::write(dir.join("flows/B__2/definition.json"), "{\"edited\": true}\n").unwrap();
        git_commit(&dir, &["flows/A__1".into()], "Add A").unwrap();
        // Nothing changed: no empty commit.
        git_commit(&dir, &["flows/A__1".into()], "Add A again").unwrap();
        let log = git(&dir, &["log", "--format=%H%x1f%cI%x1f%s", "--", "flows/A__1/definition.json"]).unwrap();
        let versions = parse_git_log(&log);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].label, "Add A");
        let status = git(&dir, &["status", "--porcelain", "--", "flows/B__2"]).unwrap();
        assert!(status.contains("flows/B__2"), "B stays uncommitted: {}", status);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn definition(name: &str, body: &str, managed: bool) -> AppResult<crate::flows::FlowDefinition> {
        Ok(crate::flows::FlowDefinition {
            name: name.into(),
            content: body.into(),
            modified_on: "2026-10-01T00:00:00Z".into(),
            modified_by: "Dat".into(),
            managed,
        })
    }

    #[test]
    fn a_task_goes_from_folder_to_reviewed_flow() {
        let parent = temp_dir("e2e");
        let view = create(NewTask {
            parent: parent.to_string_lossy().to_string(),
            folder: "TASK-1".into(),
            name: "TASK-1 Fix sync".into(),
            ticket: "#1".into(),
            description: "Only active lines".into(),
            env: TaskEnv { host: "Dev.CRM.dynamics.com".into(), name: "DEV".into() },
            git: true,
        })
        .unwrap();
        let dir = PathBuf::from(&view.path);
        assert_eq!(view.task.env.host, "dev.crm.dynamics.com");
        assert!(dir.join(TASK_FILE).exists() && dir.join(CLAUDE_FILE).exists());
        assert_eq!(view.git.repo, git_available());
        // A second task can't take a folder with files in it.
        assert!(create(NewTask {
            parent: parent.to_string_lossy().to_string(),
            folder: "TASK-1".into(),
            name: "again".into(),
            ticket: String::new(),
            description: String::new(),
            env: TaskEnv { host: "h".into(), name: "DEV".into() },
            git: false,
        })
        .is_err());

        let a = AddFlow { id: "3F2A9C1E-0000-4000-8000-000000000001".into(), name: "Invoice Sync".into() };
        let m = AddFlow { id: "aaaaaaaa-0000-4000-8000-000000000002".into(), name: "Managed one".into() };
        let wanted = vec![&a, &m];
        let body = "{
  \"properties\": {\"definition\": {\"actions\": {}}}
}";
        let view = add_fetched(&dir, read_task(&dir).unwrap(), &wanted, vec![definition("Invoice Sync", body, false), definition("Managed one", "{}", true)]).unwrap();
        assert_eq!(view.task.flows.len(), 1);
        assert!(view.warning.as_deref().unwrap_or("").contains("managed"));
        let flow = &view.task.flows[0];
        assert_eq!(flow.id, "3f2a9c1e-0000-4000-8000-000000000001");
        assert_eq!(flow.folder, "Invoice-Sync__3f2a9c1e");
        assert_eq!(view.flows[0].working_hash.as_deref(), Some(flow.baseline_hash.as_str()));
        let claude = std::fs::read_to_string(dir.join(CLAUDE_FILE)).unwrap();
        assert!(claude.contains("flows/Invoice-Sync__3f2a9c1e/definition.json"));

        let path = view.path.clone();
        // Someone edits the working copy: noticed, kept, reviewable.
        std::fs::write(dir.join(working_rel(&flow.folder)), "{\"properties\": {\"definition\": {\"actions\": {\"X\": {}}}}}").unwrap();
        let view = load(&path).unwrap();
        let edited = view.flows[0].working_hash.clone().unwrap();
        assert_ne!(edited, flow.baseline_hash);
        let versions = versions(&path, &flow.id).unwrap();
        if view.git.repo {
            assert_eq!(versions.len(), 1, "the baseline commit");
            assert!(versions[0].label.starts_with("Add Invoice Sync"));
            assert!(version_text(&path, &flow.id, &versions[0].id).unwrap().contains("\"actions\": {}"));
        } else {
            assert_eq!(versions.len(), 1, "one snapshot of the edit");
        }
        assert!(version_text(&path, &flow.id, "baseline").unwrap().contains("\"actions\": {}"));
        assert!(version_text(&path, &flow.id, "working").unwrap().contains("\"X\""));
        assert!(version_text(&path, &flow.id, "snap:../../task.json").is_err());
        let view = set_reviewed(&path, &flow.id, Some(edited.clone())).unwrap();
        assert_eq!(view.task.flows[0].reviewed_hash.as_deref(), Some(edited.as_str()));

        // Broken JSON shows as an error, not a crash.
        std::fs::write(dir.join(working_rel(&flow.folder)), "{ nope").unwrap();
        let view = load(&path).unwrap();
        assert!(view.flows[0].working_hash.is_none());
        assert!(view.flows[0].error.as_deref().unwrap().starts_with("Not valid JSON"));

        let view = remove_flow(&path, &flow.id).unwrap();
        assert!(view.task.flows.is_empty());
        assert!(!dir.join("flows/Invoice-Sync__3f2a9c1e").exists());
        assert!(std::fs::read_dir(dir.join(".hexa/removed")).unwrap().count() >= 1);

        assert!(list().iter().any(|t| same_path(&t.path, &path)));
        forget(&path).unwrap();
        assert!(load(&path).is_err(), "unlisted folders aren't read");
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn the_baseline_can_follow_the_cloud_keeping_or_dropping_edits() {
        let parent = temp_dir("rebase");
        let view = create(NewTask {
            parent: parent.to_string_lossy().to_string(),
            folder: "T".into(),
            name: "T".into(),
            ticket: String::new(),
            description: String::new(),
            env: TaskEnv { host: "dev".into(), name: "DEV".into() },
            git: true,
        })
        .unwrap();
        let dir = PathBuf::from(&view.path);
        let a = AddFlow { id: "3f2a9c1e-0000-4000-8000-000000000001".into(), name: "F".into() };
        let v1 = "{\"v\": 1}";
        let view = add_fetched(&dir, read_task(&dir).unwrap(), &[&a], vec![definition("F", v1, false)]).unwrap();
        let flow = view.task.flows[0].clone();
        let working = dir.join(working_rel(&flow.folder));
        let cloud = |v: &str| crate::flows::FlowDefinition { name: "F".into(), content: v.into(), modified_on: "later".into(), modified_by: "An".into(), managed: false };

        // Not edited: both follow the cloud.
        let view = rebase(&dir, read_task(&dir).unwrap(), &flow.id, cloud("{\"v\": 2}"), BaselineMode::Keep).unwrap();
        assert_eq!(view.task.flows[0].baseline_hash, hash_text("{\"v\": 2}").unwrap());
        assert_eq!(view.flows[0].working_hash, Some(view.task.flows[0].baseline_hash.clone()));
        assert_eq!(view.task.flows[0].cloud_modified_by, "An");
        assert!(view.task.flows[0].baseline_on.is_some());

        // Edited + Keep: only the baseline moves; the old one is listed.
        std::fs::write(&working, "{\"v\": 2, \"mine\": true}").unwrap();
        let mine = hash_text("{\"v\": 2, \"mine\": true}").unwrap();
        set_reviewed(&view.path, &flow.id, Some(mine.clone())).unwrap();
        let view = rebase(&dir, read_task(&dir).unwrap(), &flow.id, cloud("{\"v\": 3}"), BaselineMode::Keep).unwrap();
        assert_eq!(view.flows[0].working_hash.as_deref(), Some(mine.as_str()));
        assert_eq!(view.task.flows[0].reviewed_hash, None, "review starts over");
        let earlier: Vec<Version> = versions(&view.path, &flow.id).unwrap().into_iter().filter(|v| v.id.starts_with("base:")).collect();
        assert_eq!(earlier.len(), 2);
        // (Both were replaced within the same second here, so their order isn't known.)
        assert!(earlier.iter().any(|v| version_text(&view.path, &flow.id, &v.id).unwrap().contains("\"v\": 2")));
        assert!(version_text(&view.path, &flow.id, "base:../x.json").is_err());

        // Edited + Take: the edits are kept in history, the file is the cloud's.
        let view = rebase(&dir, read_task(&dir).unwrap(), &flow.id, cloud("{\"v\": 4}"), BaselineMode::Take).unwrap();
        assert_eq!(view.flows[0].working_hash, Some(hash_text("{\"v\": 4}").unwrap()));
        let kept = versions(&view.path, &flow.id).unwrap();
        let has_mine = kept
            .iter()
            .filter(|v| !v.id.starts_with("base:"))
            .any(|v| version_text(&view.path, &flow.id, &v.id).map(|t| t.contains("mine")).unwrap_or(false));
        assert!(has_mine, "the edits are still somewhere: {:?}", kept);
        forget(&view.path).unwrap();
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn a_task_file_round_trips_and_old_ones_default() {
        let t = task(vec![]);
        let text = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<TaskFile>(&text).unwrap(), t);
        let minimal = r#"{"version":1,"id":"x","name":"n","env":{"host":"h","name":"DEV"},"createdOn":"c"}"#;
        let parsed: TaskFile = serde_json::from_str(minimal).unwrap();
        assert_eq!(parsed.status, "open");
        assert!(parsed.flows.is_empty());
    }

    #[test]
    fn one_drive_paths_are_spotted() {
        std::env::set_var("OneDrive", "C:\\Users\\me\\OneDrive");
        assert!(in_one_drive(Path::new("C:\\Users\\me\\OneDrive\\Tasks\\T1")));
        assert!(in_one_drive(Path::new("c:/users/me/onedrive/T1")));
        assert!(!in_one_drive(Path::new("C:\\Users\\me\\OneDriveBackup\\T1")));
        assert!(!in_one_drive(Path::new("C:\\Users\\me\\HexaTasks\\T1")));
    }
}
