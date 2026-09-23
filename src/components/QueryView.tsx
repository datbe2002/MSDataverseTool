import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useStore, activeTabOf, tabDirty, type StatementOutcome } from "../store";
import { ResultsTable } from "./ResultsTable";
import { Loader, Refresh, Copy, Download, Check, AlertTriangle, Plus, X, Pencil, Save, Clock } from "./Icon";
import { toCsv, toJson } from "../lib/export";
import { api } from "../api";
import { formatMs } from "../lib/history";
import { registerSqlCompletion } from "../lib/sqlCompletion";
import { useSchema } from "../lib/schema";
import { setEditor, clearEditor } from "../lib/editor";
import { tabTitle, MAX_TABS } from "../lib/tabs";
import { EDITOR_THEME } from "../lib/monacoTheme";
import type { editor as MonacoEditor } from "monaco-editor";
import type { QueryResult } from "../types";

/** Tooltip for the clock badge: where the time went. */
function timingTitle(result: QueryResult, uiMs: number): string {
  const t = result.timings;
  if (!t) return "Execution time";
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const lines = [`Total (as seen in the app): ${s(uiMs)}`, `Backend: ${s(t.totalMs)}`];
  let accounted = t.fetchMs;
  if (t.connectMs != null) {
    lines.push(`  · connect to TDS: ${s(t.connectMs)}`);
    accounted += t.connectMs;
  }
  if (t.execMs != null) {
    lines.push(`  · server ran the query: ${s(t.execMs)}`);
    accounted += t.execMs;
  }
  if (t.metadataMs != null) {
    lines.push(`  · table metadata: ${s(t.metadataMs)}`);
    accounted += t.metadataMs;
  }
  const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
  let fetch = `  · read rows: ${s(t.fetchMs)}`;
  if (t.pages != null) fetch += ` — ${t.pages} request${t.pages === 1 ? "" : "s"}`;
  if (t.threads != null && t.threads > 1) fetch += `, up to ${t.threads} at a time`;
  else if (t.threads === 1) fetch += `, one at a time`;
  if (t.keyPages) fetch += ` (${t.keyPages} to list the keys)`;
  lines.push(fetch);
  if (t.waitMs != null && t.downloadMs != null) {
    lines.push(`      server preparing: ${s(t.waitMs)} · downloading + parsing: ${s(t.downloadMs)} (summed over requests)`);
  }
  if (t.bytes != null) {
    let size = `      ${mb(t.bytes)}`;
    if (t.wireBytes != null && t.wireBytes > 0 && t.wireBytes < t.bytes) size += ` (${mb(t.wireBytes)} over the network)`;
    lines.push(size);
  }
  if (t.throttled) lines.push(`      the server asked us to slow down ${t.throttled}×`);
  lines.push(`  · processing: ${s(Math.max(0, t.totalMs - accounted))}`);
  lines.push(`Transfer to UI + overhead: ${s(Math.max(0, uiMs - t.totalMs))}`);

  const perRow = t.bytes != null && result.rowCount > 0 ? t.bytes / result.rowCount : 0;
  if (perRow > 8 * 1024) {
    lines.push(
      "",
      `Rows average ${(perRow / 1024).toFixed(0)} KB (long text columns). Selecting only the columns you need reads far less.`
    );
  }
  if (result.clipped) {
    lines.push("", "Long text is cut at 1,000 characters in the grid; Copy CSV / JSON gives the full text.");
  }
  if (result.note) {
    // The FetchXML engine couldn't plan the SQL, so it ran on the TDS endpoint.
    const why = result.note.length > 240 ? `${result.note.slice(0, 240)}…` : result.note;
    lines.push("", `Ran on the TDS endpoint. ${why}`);
  }
  return lines.join("\n");
}

export function QueryView() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const newTab = useStore((s) => s.newTab);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const renameTab = useStore((s) => s.renameTab);
  const saveActiveTab = useStore((s) => s.saveActiveTab);
  const activeDirty = useStore((s) => tabDirty(activeTabOf(s)));
  const sql = useStore((s) => activeTabOf(s).sql);
  const setSql = useStore((s) => s.setSql);
  const setHasSelection = useStore((s) => s.setHasSelection);
  const theme = useStore((s) => s.theme);
  const outcomes = useStore((s) => activeTabOf(s).outcomes);
  const viewIndex = useStore((s) => activeTabOf(s).viewIndex);
  const setViewIndex = useStore((s) => s.setViewIndex);
  const running = useStore((s) => s.running);
  const activeId = useStore((s) => s.activeId);
  const pushToast = useStore((s) => s.pushToast);

  const outcome = outcomes[viewIndex] ?? null;
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

  // Inline tab rename.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const startRename = (id: string, current: string) => {
    setDraft(current);
    setEditingId(id);
  };
  const commitRename = () => {
    if (editingId) renameTab(editingId, draft);
    setEditingId(null);
  };

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      registerSqlCompletion(monaco);
      editorRef.current = editor;
      setEditor(editor);
      const sync = () => setHasSelection(!editor.getSelection()?.isEmpty());
      editor.onDidChangeCursorSelection(sync);
      sync();
      editor.focus();
    },
    [setHasSelection]
  );

  useEffect(() => () => clearEditor(editorRef.current), []);

  useEffect(() => {
    if (activeId) useSchema.getState().loadTables(activeId);
  }, [activeId]);

  // --- vertical splitter between editor and results ---
  const [editorH, setEditorH] = useState(300);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setEditorH(Math.min(Math.max(140, startH.current + e.clientY - startY.current), 900));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  /** CSV / JSON of the whole result — with the full text of cells the grid shows shortened. */
  const copyResult = async (r: QueryResult, format: (r: QueryResult) => string) => {
    let full = r;
    if (r.clipped && r.requestId) {
      try {
        full = { ...r, rows: await api.resultRows(r.requestId) };
      } catch (e) {
        pushToast({
          tone: "warning",
          title: "Copied with shortened text",
          body: `Long text cells are cut at 1,000 characters. ${String(e)}`,
        });
      }
    }
    await copy(format(full));
  };

  const result = outcome?.result ?? null;
  const atLimit = tabs.length >= MAX_TABS;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Query tab bar */}
      <div className="flex h-10 items-stretch gap-2 border-b border-line bg-s1 pr-3">
        <div className="flex min-h-0 min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden" role="tablist" aria-label="Query tabs">
          {tabs.map((t) => {
            const active = t.id === activeTabId;
            const label = t.title?.trim() ? t.title : tabTitle(t.sql);
            const editing = editingId === t.id;
            const dirty = tabDirty(t);
            const canClose = tabs.length > 1;
            return (
              <div
                key={t.id}
                onClick={() => !editing && setActiveTab(t.id)}
                onDoubleClick={() => startRename(t.id, label)}
                role="tab"
                aria-selected={active}
                className="doc-tab group"
                title={
                  editing
                    ? undefined
                    : t.sql.trim()
                    ? t.sql.replace(/\s+/g, " ").trim().slice(0, 120)
                    : "Empty query"
                }
              >
                {editing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                    maxLength={40}
                    className="h-6 w-28 rounded border border-brand/60 bg-bg px-1.5 text-xs text-fg outline-none"
                    aria-label="Tab name"
                  />
                ) : (
                  <span className="truncate pr-0.5">{label}</span>
                )}
                {active && !editing && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(t.id, label);
                    }}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-subtle transition hover:bg-s3 hover:text-fg"
                    aria-label="Rename tab"
                    title="Rename tab"
                  >
                    <Pencil size={11} />
                  </button>
                )}
                {!editing && (
                  <span className="grid h-5 w-5 shrink-0 place-items-center">
                    {/* Unsaved dot; turns into the close button on hover. */}
                    {dirty && (
                      <span
                        className={`h-2 w-2 rounded-full bg-warning ${canClose ? "group-hover:hidden" : ""}`}
                        title="Unsaved changes"
                      />
                    )}
                    {canClose && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          requestCloseTab(t.id);
                        }}
                        className={`h-5 w-5 place-items-center rounded text-subtle transition hover:bg-s3 hover:text-fg ${
                          dirty
                            ? "hidden group-hover:grid"
                            : active
                            ? "grid"
                            : "grid opacity-0 group-hover:opacity-100"
                        }`}
                        aria-label="Close tab"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
          <button
            onClick={newTab}
            disabled={atLimit}
            title={atLimit ? `Maximum ${MAX_TABS} tabs` : "New query tab"}
            aria-label="New query tab"
            className="mx-1 grid h-7 w-7 shrink-0 self-center place-items-center rounded-md text-muted transition hover:bg-s3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={15} />
          </button>
        </div>
        <button
          onClick={saveActiveTab}
          disabled={!activeDirty}
          title={activeDirty ? "Save tab (Ctrl+S)" : "All changes saved"}
          className="btn btn-ghost btn-sm shrink-0 self-center"
        >
          <Save size={13} />
          {activeDirty ? "Save" : "Saved"}
        </button>
        {activeId && <span className="flex shrink-0 self-center"><SchemaBadge connId={activeId} /></span>}
      </div>

      <div style={{ height: editorH, background: "var(--editor-bg)" }} className="shrink-0">
        <Editor
          height="100%"
          defaultLanguage="sql"
          theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
          path={`tab-${activeTabId}.sql`}
          value={sql}
          onChange={(v) => setSql(v ?? "")}
          onMount={handleMount}
          options={{
            fontSize: 13.5,
            fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace",
            fontLigatures: false,
            lineHeight: 22,
            lineNumbersMinChars: 3,
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            padding: { top: 12, bottom: 12 },
            renderLineHighlight: "line",
            automaticLayout: true,
            tabSize: 2,
            quickSuggestions: { other: true, comments: false, strings: false },
            suggestOnTriggerCharacters: true,
            wordBasedSuggestions: "off",
            suggest: { showWords: false },
          }}
        />
      </div>

      {/* Splitter */}
      <div
        onMouseDown={(e) => {
          dragging.current = true;
          startY.current = e.clientY;
          startH.current = editorH;
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
        }}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor"
        className="group relative flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-t border-line bg-s1"
      >
        <div className="h-1 w-10 rounded-full bg-line-strong transition group-hover:w-16 group-hover:bg-brand" />
      </div>

      {/* Results header */}
      <div className="flex h-10 items-stretch gap-1 overflow-x-auto border-y border-line bg-s1 px-2">
        {outcomes.length <= 1 ? (
          <span className="tab" aria-selected="true" role="tab">
            Results
          </span>
        ) : (
          outcomes.map((o) => (
            <StatementTab
              key={o.index}
              outcome={o}
              active={o.index === viewIndex}
              onClick={() => setViewIndex(o.index)}
            />
          ))
        )}

        {running ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 pr-1 text-xs font-medium text-brand">
            <Loader size={12} /> Running <RunTimer />
            {outcome?.status === "running" && outcome.result && outcome.result.rowCount > 0 && (
              <span className="font-normal text-muted">
                · {outcome.result.rowCount.toLocaleString()} rows so far
              </span>
            )}
          </div>
        ) : outcome ? (
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-3 pr-1 text-xs text-muted">
            <span
              className="flex cursor-help items-center gap-1 tabular-nums"
              title={result ? timingTitle(result, outcome.ms) : "Execution time"}
            >
              <Clock size={12} /> {formatMs(outcome.ms)}
            </span>
            {result && (
              <>
                <span className="badge badge-neutral">
                  {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? "" : "s"}
                  {result.truncated ? " (capped at 50,000)" : ""}
                </span>
                <button onClick={() => copyResult(result, toCsv)} className="btn btn-secondary btn-sm" title="Copy results as CSV">
                  <Copy size={13} /> CSV
                </button>
                <button onClick={() => copyResult(result, toJson)} className="btn btn-secondary btn-sm" title="Copy results as JSON">
                  <Download size={13} /> JSON
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1" style={{ background: "var(--editor-bg)" }}>
        <ResultsTable />
      </div>
    </div>
  );
}

/** Live-ticking elapsed timer shown while a query runs. */
function RunTimer() {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const id = setInterval(() => setMs(performance.now() - start), 100);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{(ms / 1000).toFixed(1)}s</span>;
}

function StatementTab({
  outcome,
  active,
  onClick,
}: {
  outcome: StatementOutcome;
  active: boolean;
  onClick: () => void;
}) {
  const icon = {
    ok: <Check size={11} className="text-success" />,
    write: <Check size={11} className="text-info" />,
    error: <AlertTriangle size={11} className="text-danger" />,
    running: <Loader size={11} className="text-brand" />,
    pending: <span className="h-1.5 w-1.5 rounded-full bg-subtle/50" />,
    cancelled: <span className="h-1.5 w-1.5 rounded-full bg-subtle/40" />,
  }[outcome.status];

  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="tab shrink-0 font-mono"
      title={outcome.sql.replace(/\s+/g, " ").trim().slice(0, 120)}
    >
      {icon}
      <span>#{outcome.index + 1}</span>
    </button>
  );
}

function SchemaBadge({ connId }: { connId: string }) {
  const status = useSchema((s) => s.status[connId]);
  const count = useSchema((s) => s.tables[connId]?.length);
  const error = useSchema((s) => s.errors[connId]);

  const reload = () => {
    const schema = useSchema.getState();
    schema.reset(connId);
    schema.loadTables(connId);
  };

  if (status === "loading")
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-subtle">
        <Loader size={12} /> Loading schema…
      </span>
    );
  if (status === "error")
    return (
      <button onClick={reload} title={error} className="btn btn-ghost btn-sm shrink-0 text-warning hover:!text-warning">
        <Refresh size={12} /> Schema unavailable
      </button>
    );
  if (status === "ready")
    return (
      <button onClick={reload} title="Reload tables & columns" className="btn btn-ghost btn-sm shrink-0">
        <Refresh size={12} /> {count?.toLocaleString()} tables
      </button>
    );
  return null;
}
