import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useStore } from "../store";
import {
  useFetchXml,
  activeTabOf,
  workspaceOf,
  tabLabel,
  tabHasWork,
  tabIsBlank,
  sourceChanged,
  FETCH_ROW_CAP,
  MAX_FETCH_TABS,
  type FetchRun,
  type FetchSource,
  type FetchTab,
} from "../lib/fetchXmlStore";
import { DEFAULT_FETCH, formatFetchXml, parseFetch } from "../lib/fetchXml";
import { EDITOR_THEME } from "../lib/monacoTheme";
import { formatMs, relativeTime } from "../lib/history";
import { toCsv, toJson } from "../lib/export";
import { ErrorState, Grid, Skeleton } from "./ResultsTable";
import { FetchTree, type TreeAction } from "./FetchTree";
import { FetchNodePanel, type Mutate } from "./FetchNodePanel";
import { FetchViewPicker } from "./FetchViewPicker";
import { Modal } from "./Modals";
import { lintFetch, queryTables, type Problem, type Severity } from "../lib/fetchLint";
import { registerFetchCompletion } from "../lib/fetchCompletion";
import { columnKey, useSchema } from "../lib/schema";
import { api } from "../api";
import { friendlyError } from "../lib/errors";
import type { SavedView } from "../types";
import {
  addChild,
  buildTree,
  edit,
  elementAt,
  elementRanges,
  moveNode,
  parseXml,
  removeNode,
  type NodeKind,
  type TreeNode,
} from "../lib/fetchModel";
import { AlertTriangle, ChevronDown, Clock, Download, FileCode, Folder, Info, Loader, Pencil, Plus, Refresh, Save, X } from "./Icon";
import type { QueryResult } from "../types";

const MARKER_OWNER = "fetchxml";
const LINT_OWNER = "fetchxml-lint";
const BUILDER_KEY = "cds.fetchxml.builder";
const WIDTHS_KEY = "cds.fetchxml.paneWidths";

/** Tree and properties widths (px); dragged by the user, remembered. */
const PANES = { tree: { min: 170, max: 480, initial: 240 }, panel: { min: 240, max: 640, initial: 320 } };
type Pane = keyof typeof PANES;

function readWidths(): Record<Pane, number> {
  const out = { tree: PANES.tree.initial, panel: PANES.panel.initial };
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}");
    for (const k of ["tree", "panel"] as Pane[]) {
      if (typeof saved[k] === "number") out[k] = Math.min(PANES[k].max, Math.max(PANES[k].min, saved[k]));
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Vertical drag handle; also moves with ←/→ when focused. */
function PaneResizer({ label, onDrag, onKey }: { label: string; onDrag: (dx: number, done: boolean) => void; onKey: (dx: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const x0 = e.clientX;
        const move = (ev: PointerEvent) => onDrag(ev.clientX - x0, false);
        const up = (ev: PointerEvent) => {
          onDrag(ev.clientX - x0, true);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onKey((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 64 : 16));
        }
      }}
      className="group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize outline-none"
    >
      <div className="mx-auto h-full w-px bg-line transition group-hover:w-[3px] group-hover:bg-brand group-focus-visible:w-[3px] group-focus-visible:bg-brand" />
    </div>
  );
}

/** Attributes a newly added element starts with. */
const NEW_ELEMENT: Partial<Record<NodeKind, Record<string, string>>> = {
  filter: { type: "and" },
  condition: { operator: "eq" },
};

function readBuilderOpen(): boolean {
  try {
    return localStorage.getItem(BUILDER_KEY) !== "0";
  } catch {
    return true;
  }
}

let formatterRegistered = false;

/** Shift+Alt+F (Format Document) in XML editors. */
function registerXmlFormatter(monaco: typeof Monaco) {
  if (formatterRegistered) return;
  formatterRegistered = true;
  monaco.languages.registerDocumentFormattingEditProvider("xml", {
    provideDocumentFormattingEdits: (model) => {
      const pretty = formatFetchXml(model.getValue());
      return pretty ? [{ range: model.getFullModelRange(), text: pretty }] : [];
    },
  });
}

/** Tooltip for the clock badge. */
function timingTitle(run: FetchRun): string {
  const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
  const lines = [
    `${run.requests} request${run.requests === 1 ? "" : "s"} · ${mb(run.bytes)}`,
    `Last page read: ${run.page}${run.more ? " (more available)" : ""}`,
  ];
  if (run.throttled) lines.push(`The server asked us to slow down ${run.throttled}×`);
  return lines.join("\n");
}

export function FetchXmlView() {
  const activeId = useStore((s) => s.activeId);
  const theme = useStore((s) => s.theme);
  const tab = useFetchXml((s) => (activeId ? activeTabOf(s, activeId) : null));
  const tabId = tab?.id ?? "";
  const xml = tab?.xml ?? DEFAULT_FETCH;
  const run = useFetchXml((s) => (tab ? s.runs[tab.id] : undefined));
  const formatted = useFetchXml((s) => s.formatted);
  const setFormatted = useFetchXml((s) => s.setFormatted);
  const setDraft = useFetchXml((s) => s.setDraft);
  const loadMore = useFetchXml((s) => s.loadMore);
  const stop = useFetchXml((s) => s.stop);
  const source = tab?.source;
  const setTabSource = useFetchXml((s) => s.setSource);
  const setSource = (next: FetchSource | null) => activeId && tabId && setTabSource(activeId, tabId, next);
  const newTab = useFetchXml((s) => s.newTab);
  const saveFile = useFetchXml((s) => s.save);
  const pushToast = useStore((s) => s.pushToast);
  const [viewsOpen, setViewsOpen] = useState(false);
  /** Results as the Web API returned them (JSON) instead of the grid. */
  const [jsonView, setJsonView] = useState(false);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);

  // --- builder: the XML as a tree, kept while the XML has an error ---
  const [builderOpen, setBuilderOpen] = useState(readBuilderOpen);
  const [widths, setWidths] = useState(readWidths);
  const dragFrom = useRef(widths);
  const resize = (pane: Pane, dx: number, done: boolean) => {
    const w = Math.round(Math.min(PANES[pane].max, Math.max(PANES[pane].min, dragFrom.current[pane] + dx)));
    const next = { ...dragFrom.current, [pane]: w };
    setWidths(next);
    if (done) {
      dragFrom.current = next;
      try {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    }
  };
  const nudge = (pane: Pane, dx: number) => {
    dragFrom.current = widths;
    resize(pane, dx, true);
  };
  const toggleBuilder = () =>
    setBuilderOpen((open) => {
      try {
        localStorage.setItem(BUILDER_KEY, open ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !open;
    });
  const doc = useMemo(() => parseXml(xml), [xml]);
  // Per tab: another tab's last good tree must never show here.
  const lastGood = useRef<{ tabId: string; doc: XMLDocument; tree: TreeNode } | null>(null);
  const shown = useMemo(() => {
    if (doc) lastGood.current = { tabId, doc, tree: buildTree(doc) };
    return lastGood.current?.tabId === tabId ? lastGood.current : null;
  }, [doc, tabId]);
  const validRef = useRef(!!doc);
  validRef.current = !!doc;
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => setSelected(null), [activeId, tabId]);
  /** Set when the next selection should scroll the XML to it (picked in the tree, or an edit). */
  const revealNext = useRef(false);
  /** True while the builder writes to the editor, so its cursor moves don't pick elements. */
  const writing = useRef(false);
  const decorations = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);

  // Checked as you type: the root table in the toolbar, XML errors as squiggles.
  const [check, setCheck] = useState(() => parseFetch(xml));
  useEffect(() => {
    const id = setTimeout(() => setCheck(parseFetch(xml)), 300);
    return () => clearTimeout(id);
  }, [xml]);
  // Another tab: its table and errors right away, not after the typing delay.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setCheck(parseFetch(xml)), [tabId]);
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const markers: Monaco.editor.IMarkerData[] = [];
    if (!check.ok && check.line) {
      const line = Math.min(check.line, model.getLineCount());
      const col = Math.max(1, Math.min(check.column ?? 1, model.getLineMaxColumn(line)));
      markers.push({
        severity: monaco.MarkerSeverity.Error,
        message: check.error,
        startLineNumber: line,
        startColumn: Math.max(1, col - 1),
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line),
      });
    }
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  }, [check]);

  // --- checks against the environment's metadata (tables, columns, types) ---
  const schemaTables = useSchema((s) => (activeId ? s.tables[activeId] : undefined));
  const schemaColumns = useSchema((s) => s.columns);
  const tableNames = useMemo(() => (doc ? queryTables(doc) : []), [doc]);
  const tablesKey = tableNames.join("|");
  useEffect(() => {
    if (!activeId) return;
    void useSchema.getState().loadTables(activeId);
    for (const t of tablesKey ? tablesKey.split("|") : []) void useSchema.getState().loadColumns(activeId, t);
  }, [activeId, tablesKey]);
  const problems = useMemo<Problem[]>(() => {
    if (!doc || !activeId) return [];
    const known = schemaTables?.length ? new Set(schemaTables.map((t) => t.logicalName)) : undefined;
    return lintFetch(doc, {
      tables: known,
      // An unknown table, or columns that failed to load (empty), skip the column checks.
      columns: (t) => {
        if (known && !known.has(t)) return undefined;
        const cols = schemaColumns[columnKey(activeId, t)];
        return cols?.length ? cols : undefined;
      },
    });
  }, [doc, activeId, schemaTables, schemaColumns]);
  const marks = useMemo(() => {
    const rank: Record<Severity, number> = { error: 3, warning: 2, info: 1 };
    const out: Record<number, Severity> = {};
    for (const p of problems) if (!out[p.id] || rank[p.severity] > rank[out[p.id]]) out[p.id] = p.severity;
    return out;
  }, [problems]);
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const ranges = doc ? elementRanges(xml) : [];
    const severity = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
    monaco.editor.setModelMarkers(
      model,
      LINT_OWNER,
      problems.flatMap((p) => {
        const r = ranges[p.id];
        if (!r) return [];
        const tagEnd = xml.indexOf(">", r.start);
        const from = model.getPositionAt(r.start);
        const to = model.getPositionAt(tagEnd >= 0 ? tagEnd + 1 : r.end);
        return [{ severity: severity[p.severity], message: p.message, source: "FetchXML", startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }];
      })
    );
  }, [problems, xml, doc]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    registerXmlFormatter(monaco);
    registerFetchCompletion(monaco);
    decorations.current = editor.createDecorationsCollection();
    // Undo / redo can add or remove elements: the picked id may now be another element.
    editor.onDidChangeModelContent((e) => {
      if (!writing.current && (e.isUndoing || e.isRedoing)) setSelected(null);
    });
    // Clicking / moving in the XML picks the element under the cursor in the tree.
    editor.onDidChangeCursorPosition((e) => {
      if (writing.current || !validRef.current || (e.source !== "mouse" && e.source !== "keyboard")) return;
      const model = editor.getModel();
      if (!model) return;
      const id = elementAt(elementRanges(model.getValue()), model.getOffsetAt(e.position));
      if (id !== null) setSelected(id);
    });
    editor.focus();
  }, []);

  // The selected element's lines are tinted in the XML.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !decorations.current) return;
    const range = selected === null || !doc ? undefined : elementRanges(xml)[selected];
    if (!range) {
      decorations.current.clear();
      return;
    }
    const start = model.getPositionAt(range.start);
    const end = model.getPositionAt(range.end);
    decorations.current.set([
      {
        range: { startLineNumber: start.lineNumber, startColumn: 1, endLineNumber: end.lineNumber, endColumn: 1 },
        options: { isWholeLine: true, className: "fx-selected-line", linesDecorationsClassName: "fx-selected-gutter" },
      },
    ]);
    if (revealNext.current) {
      revealNext.current = false;
      editor.revealLinesInCenterIfOutsideViewport(start.lineNumber, end.lineNumber);
    }
  }, [selected, xml, doc]);

  const setXml = (value: string) => {
    if (activeId && tabId) setDraft(activeId, tabId, value);
  };

  /**
   * Writes `next` through the editor (so Ctrl+Z undoes it), replacing only
   * the part that changed so the view doesn't jump. `merge` = no separate
   * undo step.
   */
  const applyXml = (next: string, merge = false) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return setXml(next);
    const cur = model.getValue();
    if (cur === next) return;
    let p = 0;
    while (p < cur.length && p < next.length && cur[p] === next[p]) p++;
    let q = 0;
    while (q < cur.length - p && q < next.length - p && cur[cur.length - 1 - q] === next[next.length - 1 - q]) q++;
    const from = model.getPositionAt(p);
    const to = model.getPositionAt(cur.length - q);
    writing.current = true;
    try {
      if (!merge) editor.pushUndoStop();
      editor.executeEdits("builder", [
        {
          range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column },
          text: next.slice(p, next.length - q),
        },
      ]);
      if (!merge) editor.pushUndoStop();
    } finally {
      writing.current = false;
    }
  };

  /** Replaces the whole query (New, Recent). */
  const replaceXml = (text: string) => {
    setSelected(null);
    applyXml(text);
    editorRef.current?.setPosition({ lineNumber: 1, column: 1 });
    editorRef.current?.focus();
  };

  /** Monaco keeps LF line ends; a file saved with CRLF would otherwise always look changed. */
  const lf = (text: string) => text.replace(/\r\n?/g, "\n");

  /**
   * Puts a query (a view, a file, a recent one) in a tab of its own, or in
   * this one when it holds nothing yet (or no more tabs fit — Ctrl+Z then
   * brings the old query back).
   */
  const openQuery = (text: string, next: FetchSource | null) => {
    if (!activeId || !tab) return;
    if (!tabIsBlank(tab) && newTab(activeId, text, next ?? undefined)) return;
    if (!tabIsBlank(tab)) {
      pushToast({ tone: "info", title: `${MAX_FETCH_TABS} tabs are open`, body: "Opened here instead — Ctrl+Z brings back the query that was in this tab." });
    }
    replaceXml(text);
    setSource(next);
  };

  const openView = (view: SavedView, table: string) => {
    setViewsOpen(false);
    const text = lf(formatFetchXml(view.fetchXml) ?? view.fetchXml);
    openQuery(text, { kind: "view", name: view.name, personal: view.personal, table, saved: text });
  };

  const openFile = async () => {
    if (!activeId) return;
    try {
      const file = await api.openXmlFile();
      if (!file) return;
      const text = lf(file.contents ?? "");
      openQuery(text, { kind: "file", name: file.name, path: file.path, saved: text });
    } catch (e) {
      pushToast({ tone: "error", title: "Could not open the file", body: friendlyError(String(e)) });
    }
  };

  // Ctrl+O opens a file (Ctrl+S / Ctrl+Shift+S are handled with the run keys in App).
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        e.stopPropagation();
        void openFileRef.current();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const dirty = source?.kind === "file" && !!tab && sourceChanged(tab);

  /** Changes the selected element in the XML and selects what the change returns. */
  const onEdit: Mutate = (fn, merge) => {
    if (selected === null || !doc) return;
    const result = edit(xml, selected, fn);
    if (!result) return;
    applyXml(result.xml, merge);
    revealNext.current = true;
    setSelected(result.select);
  };

  const onTreeAction = (action: TreeAction) => {
    if (action.type === "add") onEdit((el) => addChild(el, action.tag, NEW_ELEMENT[action.tag]));
    else if (action.type === "remove") onEdit((el) => removeNode(el));
    else onEdit((el) => moveNode(el, action.dir));
  };

  const pickInTree = (id: number) => {
    revealNext.current = true;
    setSelected(id);
  };

  // Through the editor, so Ctrl+Z undoes it.
  const format = () => void editorRef.current?.getAction("editor.action.formatDocument")?.run();

  const goToError = () => {
    if (check.ok || !check.line) return;
    editorRef.current?.revealLineInCenter(check.line);
    editorRef.current?.setPosition({ lineNumber: check.line, column: check.column ?? 1 });
    editorRef.current?.focus();
  };

  // --- vertical splitter between editor and results ---
  const [editorH, setEditorH] = useState(380);
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

  const result: QueryResult | null = useMemo(() => {
    if (!run || run.status !== "ok") return null;
    return {
      columns: run.flat.columns,
      rows: formatted ? run.flat.display : run.flat.raw,
      rowCount: run.records.length,
      elapsedMs: run.ms,
      truncated: run.capped,
    };
  }, [run, formatted]);

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        Select an environment to query it with FetchXML.
      </div>
    );
  }

  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FetchTabs
        connId={activeId}
        onClosed={(id) =>
          // After the editor has moved to the next tab's model.
          setTimeout(() => monacoRef.current?.editor.getModels().find((m) => m.uri.path.endsWith(`/fetch-${id}.xml`))?.dispose(), 0)
        }
      />
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-s1 px-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
          <FileCode size={14} className="text-brand" /> FetchXML
        </span>
        {check.ok ? (
          <span className="badge badge-brand font-mono" title="Table the query reads">
            {check.fetch.entity}
          </span>
        ) : xml.trim() && check.line ? (
          <button onClick={goToError} className="badge badge-danger" title={check.error}>
            <AlertTriangle size={11} /> XML error · line {check.line}
          </button>
        ) : null}
        {doc && problems.length > 0 && <ProblemsMenu problems={problems} onPick={pickInTree} />}
        {source && (
          <span
            className="flex min-w-0 items-center gap-1.5 truncate text-xs text-subtle"
            title={source.kind === "file" ? source.path : `${source.personal ? "Personal" : "System"} view of ${source.table} (a copy — the view isn't changed)`}
          >
            <span className="shrink-0">{source.kind === "file" ? "File" : "From view"}</span>
            <span className="truncate font-medium text-muted">{source.name}</span>
            {dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-warning" title="Unsaved changes" />}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            onClick={toggleBuilder}
            aria-pressed={builderOpen}
            className={`btn btn-sm ${builderOpen ? "btn-secondary" : "btn-ghost"}`}
            title={builderOpen ? "Hide the tree and properties" : "Build the query with a tree and properties"}
          >
            Builder
          </button>
          <button onClick={() => setViewsOpen(true)} className="btn btn-ghost btn-sm" title="Open a system or personal view of a table (read only)">
            <Folder size={13} /> Views
          </button>
          <FileMenu onOpen={openFile} onSave={() => void saveFile()} onSaveAs={() => void saveFile(true)} dirty={dirty} hasFile={source?.kind === "file"} />
          <RecentMenu onPick={(text) => openQuery(text, null)} />
          <button
            onClick={format}
            disabled={!check.ok && !!check.line}
            className="btn btn-ghost btn-sm"
            title="Indent the XML (Shift+Alt+F)"
          >
            Format
          </button>
        </div>
      </div>

      <div style={{ height: editorH }} className="flex min-w-0 shrink-0">
        {builderOpen && shown && (
          <>
            <div className="min-h-0 bg-s1" style={{ flex: `0 1 ${widths.tree}px`, minWidth: PANES.tree.min }}>
              <FetchTree key={tabId} root={shown.tree} selected={selected} onSelect={pickInTree} onAction={onTreeAction} readOnly={!doc} marks={doc ? marks : undefined} />
            </div>
            <PaneResizer label="Resize the tree" onDrag={(dx, done) => resize("tree", dx, done)} onKey={(dx) => nudge("tree", dx)} />
            <div className="min-h-0 bg-s1" style={{ flex: `0 1 ${widths.panel}px`, minWidth: PANES.panel.min }}>
              <FetchNodePanel connId={activeId} doc={shown.doc} selected={selected} onEdit={onEdit} readOnly={!doc} />
            </div>
            <PaneResizer label="Resize the properties" onDrag={(dx, done) => resize("panel", dx, done)} onKey={(dx) => nudge("panel", dx)} />
          </>
        )}
        <div className="min-w-[160px] flex-1" style={{ background: "var(--editor-bg)" }}>
        <Editor
          height="100%"
          defaultLanguage="xml"
          theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
          path={`fetch-${tabId}.xml`}
          value={xml}
          onChange={(v) => setXml(v ?? "")}
          onMount={handleMount}
          options={{
            fontSize: 13.5,
            fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace",
            fontLigatures: false,
            lineHeight: 22,
            lineNumbersMinChars: 3,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            padding: { top: 12, bottom: 12 },
            automaticLayout: true,
            tabSize: 2,
            wordBasedSuggestions: "off",
            // Attribute values (table / column names) suggest as you type.
            quickSuggestions: { other: true, strings: true, comments: false },
            suggestOnTriggerCharacters: true,
            suggest: { showWords: false },
          }}
        />
        </div>
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
      <div className="flex h-10 shrink-0 items-stretch gap-1 overflow-x-auto border-y border-line bg-s1 px-2">
        <span className="tab" aria-selected="true" role="tab">
          Results
        </span>
        {tab && <CountControl tabId={tab.id} xml={xml} valid={check.ok} />}
        {run?.status === "running" ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 pr-1 text-xs font-medium text-brand">
            <Loader size={12} /> Running
          </div>
        ) : run?.status === "ok" ? (
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-3 pr-1 text-xs text-muted">
            <span className="flex cursor-help items-center gap-1 tabular-nums" title={timingTitle(run)}>
              <Clock size={12} /> {formatMs(run.ms)}
            </span>
            <span className="badge badge-neutral">
              {run.records.length.toLocaleString()} row{run.records.length === 1 ? "" : "s"}
              {run.more ? " · more available" : ""}
              {run.capped ? ` (capped at ${FETCH_ROW_CAP.toLocaleString()})` : ""}
            </span>
            {run.loadingMore ? (
              <>
                <span className="flex items-center gap-1 text-brand">
                  <Loader size={12} /> Reading page {run.page + 1}…
                </span>
                <button onClick={stop} className="btn btn-secondary btn-sm">
                  Stop
                </button>
              </>
            ) : (
              run.more &&
              !run.capped && (
                <>
                  <button onClick={() => loadMore(false)} className="btn btn-secondary btn-sm" title="Read the next page">
                    Next page
                  </button>
                  <button
                    onClick={() => loadMore(true)}
                    className="btn btn-secondary btn-sm"
                    title={`Read every page (up to ${FETCH_ROW_CAP.toLocaleString()} rows)`}
                  >
                    Load all
                  </button>
                </>
              )
            )}
            <div className="seg" role="group" aria-label="Values">
              <button
                aria-pressed={formatted && !jsonView}
                onClick={() => {
                  setFormatted(true);
                  setJsonView(false);
                }}
                title="Lookup names, choice labels and formatted dates / numbers"
              >
                Formatted
              </button>
              <button
                aria-pressed={!formatted && !jsonView}
                onClick={() => {
                  setFormatted(false);
                  setJsonView(false);
                }}
                title="GUIDs, option values, ISO dates"
              >
                Raw
              </button>
              <button aria-pressed={jsonView} onClick={() => setJsonView(true)} title="The rows exactly as the Web API returned them, annotations included">
                JSON
              </button>
            </div>
            {result && <ExportMenu result={result} name={tab ? tabLabel(tab) : "rows"} onCopy={copy} />}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1" style={{ background: "var(--editor-bg)" }}>
        {jsonView && run?.status === "ok" ? <JsonRecords records={run.records} dark={theme === "dark"} /> : <Results run={run} result={result} />}
      </div>
      {viewsOpen && (
        <FetchViewPicker
          connId={activeId}
          initialTable={check.ok ? check.fetch.entity : source?.kind === "view" ? source.table : ""}
          onOpen={openView}
          onClose={() => setViewsOpen(false)}
        />
      )}
    </div>
  );
}

/** Open / Save / Save as for .xml files on this computer. */
function FileMenu({
  onOpen,
  onSave,
  onSaveAs,
  dirty,
  hasFile,
}: {
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  dirty: boolean;
  hasFile: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const item = (label: string, keys: string, run: () => void) => (
    <button
      className="menu-item"
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {label}
      <span className="ml-auto text-[11px] text-subtle">{keys}</span>
    </button>
  );
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost btn-sm" aria-expanded={open} title="Open or save a .xml file">
        <Save size={13} /> File
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label="Unsaved changes" />}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="pop popover absolute right-0 top-full z-50 mt-1.5 w-56 p-1" role="menu">
          {item("Open file…", "Ctrl+O", onOpen)}
          {item(hasFile ? "Save" : "Save…", "Ctrl+S", onSave)}
          {item("Save as…", "Ctrl+Shift+S", onSaveAs)}
        </div>
      )}
    </div>
  );
}

function Results({ run, result }: { run: FetchRun | undefined; result: QueryResult | null }) {
  const runKey = useStore((s) => s.keybindings.run[0]);
  if (!run) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="empty-icon">
          <FileCode size={20} />
        </div>
        <div>
          <div className="text-sm font-medium">No results yet</div>
          <div className="mt-0.5 text-xs text-subtle">
            Execute the query{runKey ? ` (${runKey})` : ""} to see its rows here.
          </div>
        </div>
      </div>
    );
  }
  if (run.status === "running") return <Skeleton />;
  if (run.status === "error") {
    const where = run.line ? `Line ${run.line}${run.column ? `, column ${run.column}` : ""}: ` : "";
    return <ErrorState title={run.line ? "Invalid XML" : "FetchXML failed"} message={`${where}${run.error ?? ""}`} />;
  }
  if (!result) return null;
  if (result.rows.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-subtle">No rows match this query.</div>;
  }
  // New set of columns (a later page can add some) → fresh column widths.
  const key = result.columns.map((c) => c.name).join("\u0001");
  return <Grid key={key} result={result} />;
}

/** Queries run before (every environment), newest first; picking one puts it in the editor. */
function RecentMenu({ onPick }: { onPick: (xml: string) => void }) {
  const recent = useFetchXml((s) => s.recent);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={recent.length === 0}
        className="btn btn-ghost btn-sm"
        aria-expanded={open}
        title={recent.length ? "Queries you ran before" : "Queries you run show up here"}
      >
        <Clock size={13} /> Recent <ChevronDown size={13} />
      </button>
      {open && (
        <div className="pop popover absolute right-0 top-full z-50 mt-1.5 w-96 overflow-hidden">
          <ul className="max-h-96 overflow-y-auto p-1" role="listbox" aria-label="Recent FetchXML queries">
            {recent.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => {
                    onPick(r.xml);
                    setOpen(false);
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-s3"
                  title={r.xml}
                >
                  <span className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-fg">{r.entity}</span>
                    <span className="truncate text-subtle">{r.connectionName}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-subtle">
                      {r.rows.toLocaleString()} rows · {relativeTime(r.at)}
                    </span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted">
                    {r.xml.replace(/\s+/g, " ").trim().slice(0, 140)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The environment's query tabs: pick, rename (double-click), close, add. */
function FetchTabs({ connId, onClosed }: { connId: string; onClosed: (tabId: string) => void }) {
  const ws = useFetchXml((s) => workspaceOf(s, connId));
  const runs = useFetchXml((s) => s.runs);
  const { selectTab, renameTab, closeTab, newTab } = useFetchXml.getState();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [closing, setClosing] = useState<FetchTab | null>(null);
  const atLimit = ws.tabs.length >= MAX_FETCH_TABS;

  const close = (t: FetchTab) => {
    closeTab(connId, t.id);
    onClosed(t.id);
  };
  const requestClose = (t: FetchTab) => (tabHasWork(t) ? setClosing(t) : close(t));
  const commitRename = () => {
    if (editing) renameTab(connId, editing, draft);
    setEditing(null);
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-s1 pr-2">
      <div className="flex min-h-0 min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden" role="tablist" aria-label="FetchXML tabs">
        {ws.tabs.map((t) => {
          const active = t.id === ws.active;
          const label = tabLabel(t);
          const busy = runs[t.id]?.status === "running" || !!runs[t.id]?.loadingMore;
          const unsaved = t.source?.kind === "file" && sourceChanged(t);
          const canClose = ws.tabs.length > 1 || tabHasWork(t) || !!t.source;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => editing !== t.id && selectTab(connId, t.id)}
              onDoubleClick={() => {
                setDraft(label);
                setEditing(t.id);
              }}
              onAuxClick={(e) => e.button === 1 && canClose && requestClose(t)}
              className="doc-tab group"
              title={t.source ? `${label} — ${t.source.kind === "file" ? t.source.path : `view of ${t.source.table}`}` : label}
            >
              {busy && <Loader size={11} className="shrink-0 text-brand" />}
              {editing === t.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setEditing(null);
                  }}
                  maxLength={40}
                  className="h-6 w-32 rounded border border-brand/60 bg-bg px-1.5 text-xs text-fg outline-none"
                  aria-label="Tab name"
                />
              ) : (
                <span className="max-w-[14rem] truncate pr-0.5">{label}</span>
              )}
              {active && editing !== t.id && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDraft(label);
                    setEditing(t.id);
                  }}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-subtle transition hover:bg-s3 hover:text-fg"
                  aria-label="Rename tab"
                  title="Rename tab"
                >
                  <Pencil size={11} />
                </button>
              )}
              {editing !== t.id && (
                <span className="grid h-5 w-5 shrink-0 place-items-center">
                  {unsaved && <span className={`h-2 w-2 rounded-full bg-warning ${canClose ? "group-hover:hidden" : ""}`} title="Unsaved changes" />}
                  {canClose && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        requestClose(t);
                      }}
                      className={`h-5 w-5 place-items-center rounded text-subtle transition hover:bg-s3 hover:text-fg ${
                        unsaved ? "hidden group-hover:grid" : active ? "grid" : "grid opacity-0 group-hover:opacity-100"
                      }`}
                      aria-label="Close tab"
                      title="Close tab (middle-click)"
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
          onClick={() => newTab(connId)}
          disabled={atLimit}
          title={atLimit ? `At most ${MAX_FETCH_TABS} tabs` : "New tab"}
          aria-label="New FetchXML tab"
          className="mx-1 grid h-7 w-7 shrink-0 self-center place-items-center rounded-md text-muted transition hover:bg-s3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={15} />
        </button>
      </div>
      {closing && (
        <Modal title="Close this tab?" icon={<AlertTriangle size={15} className="text-warning" />} onClose={() => setClosing(null)}>
          <p className="text-sm text-muted">
            {closing.source?.kind === "file" ? (
              <>
                <span className="font-medium text-fg">{closing.source.name}</span> has changes that aren't saved to the file.
              </>
            ) : closing.source ? (
              <>
                Your changes to the query from the view <span className="font-medium text-fg">{closing.source.name}</span> will be lost (the view itself is unchanged).
              </>
            ) : (
              <>
                The query in <span className="font-medium text-fg">{tabLabel(closing)}</span> isn't saved to a file. Queries you ran stay in Recent.
              </>
            )}
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-line p-2 font-mono text-[11.5px] text-muted" style={{ background: "var(--editor-bg)" }}>
            {closing.xml.trim().slice(0, 1200)}
          </pre>
          <div className="modal-footer">
            <button autoFocus className="btn btn-secondary" onClick={() => setClosing(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                close(closing);
                setClosing(null);
              }}
            >
              Close without saving
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const SEVERITY_STYLE: Record<Severity, { badge: string; text: string; label: string }> = {
  error: { badge: "badge-danger", text: "text-danger", label: "error" },
  warning: { badge: "badge-warning", text: "text-warning", label: "warning" },
  info: { badge: "badge-neutral", text: "text-muted", label: "note" },
};

/** Problems found in the query; picking one selects its element. */
function ProblemsMenu({ problems, onPick }: { problems: Problem[]; onPick: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const counts = { error: 0, warning: 0, info: 0 } as Record<Severity, number>;
  for (const p of problems) counts[p.severity]++;
  const worst: Severity = counts.error ? "error" : counts.warning ? "warning" : "info";
  const summary = (["error", "warning", "info"] as Severity[])
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${SEVERITY_STYLE[s].label}${counts[s] === 1 ? "" : "s"}`)
    .join(", ");
  const order: Severity[] = ["error", "warning", "info"];
  const sorted = [...problems].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.id - b.id);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className={`badge ${SEVERITY_STYLE[worst].badge}`} aria-expanded={open} title="Problems found in the query">
        {worst === "info" ? <Info size={11} /> : <AlertTriangle size={11} />} {summary}
      </button>
      {open && (
        <div className="pop popover absolute left-0 top-full z-50 mt-1.5 w-[28rem] max-w-[80vw] p-1" role="menu">
          <ul className="max-h-80 overflow-y-auto">
            {sorted.map((p, i) => (
              <li key={i}>
                <button
                  className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-s3"
                  onClick={() => {
                    setOpen(false);
                    onPick(p.id);
                  }}
                >
                  <span className={`mt-0.5 shrink-0 ${SEVERITY_STYLE[p.severity].text}`}>
                    {p.severity === "info" ? <Info size={13} /> : <AlertTriangle size={13} />}
                  </span>
                  <span className="text-fg">{p.message}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-2.5 py-1.5 text-[11px] text-subtle">Checked against this environment's tables and columns. The query still runs.</p>
        </div>
      )}
    </div>
  );
}

/** "Count rows": how many rows the query matches, without reading them. */
function CountControl({ tabId, xml, valid }: { tabId: string; xml: string; valid: boolean }) {
  const count = useFetchXml((s) => s.counts[tabId]);
  const { countRows, stopCount } = useFetchXml.getState();
  const current = count && count.xml === xml ? count : undefined;
  const again = (
    <button onClick={() => void countRows()} className="btn btn-ghost btn-sm btn-icon" title="Count again" aria-label="Count again">
      <Refresh size={12} />
    </button>
  );
  if (current?.status === "running") {
    return (
      <div className="flex shrink-0 items-center gap-1.5 pl-2 text-xs text-brand">
        <Loader size={12} />
        {current.method === "pages" ? `Counting page by page… ${current.value.toLocaleString()}` : "Counting…"}
        <button onClick={stopCount} className="btn btn-secondary btn-sm">
          Stop
        </button>
      </div>
    );
  }
  if (current?.status === "done" || current?.status === "stopped") {
    const stopped = current.status === "stopped";
    return (
      <div className="flex shrink-0 items-center gap-1 pl-2 text-xs">
        <span
          className="badge badge-brand tabular-nums"
          title={
            stopped
              ? "Stopped before the end — at least this many rows"
              : current.method === "pages"
              ? "Too many rows for an aggregate count, so their keys were read page by page"
              : "Counted with an aggregate query (the rows weren't read)"
          }
        >
          {stopped ? "≥ " : ""}
          {current.value.toLocaleString()} row{current.value === 1 ? "" : "s"} match
        </span>
        {again}
      </div>
    );
  }
  if (current?.status === "error") {
    return (
      <div className="flex shrink-0 items-center gap-1 pl-2 text-xs">
        <span className="badge badge-danger" title={current.error}>
          <AlertTriangle size={11} /> Count failed
        </span>
        {again}
      </div>
    );
  }
  return (
    <button
      onClick={() => void countRows()}
      disabled={!valid}
      className="btn btn-ghost btn-sm shrink-0 self-center"
      title="How many rows this query matches — counted without reading them"
    >
      Count rows
    </button>
  );
}

/** Copy or save the rows shown in the grid. */
function ExportMenu({ result, name, onCopy }: { result: QueryResult; name: string; onCopy: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pushToast = useStore((s) => s.pushToast);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const base = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").trim() || "rows";
  const save = async (ext: "csv" | "json") => {
    try {
      const file = await api.exportFile(ext === "csv" ? toCsv(result) : toJson(result), `${base}.${ext}`, ext);
      if (file) pushToast({ tone: "success", title: `Saved ${file.name}`, body: `${result.rows.length.toLocaleString()} rows · ${file.path}` });
    } catch (e) {
      pushToast({ tone: "error", title: "Could not save the file", body: friendlyError(String(e)) });
    }
  };
  const item = (label: string, run: () => void) => (
    <button
      className="menu-item"
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="btn btn-secondary btn-sm" aria-expanded={open} title="Copy or save these rows">
        <Download size={13} /> Export <ChevronDown size={12} />
      </button>
      {open && (
        <div className="pop popover absolute right-0 top-full z-50 mt-1.5 w-48 p-1" role="menu">
          {item("Copy as CSV", () => onCopy(toCsv(result)))}
          {item("Copy as JSON", () => onCopy(toJson(result)))}
          <div className="my-1 border-t border-line" />
          {item("Save as CSV…", () => void save("csv"))}
          {item("Save as JSON…", () => void save("json"))}
        </div>
      )}
    </div>
  );
}

/** Most records shown in the JSON view (the text gets heavy past this). */
const JSON_MAX = 5000;

function JsonRecords({ records, dark }: { records: Record<string, unknown>[]; dark: boolean }) {
  const text = useMemo(() => JSON.stringify(records.slice(0, JSON_MAX), null, 2), [records]);
  return (
    <div className="flex h-full flex-col">
      {records.length > JSON_MAX && (
        <div className="shrink-0 border-b border-line bg-s1 px-3 py-1 text-[11px] text-subtle">
          Showing the first {JSON_MAX.toLocaleString()} of {records.length.toLocaleString()} rows.
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          language="json"
          path="fetch-results.json"
          value={text}
          theme={dark ? EDITOR_THEME.dark : EDITOR_THEME.light}
          options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12.5, lineNumbersMinChars: 4, scrollBeyondLastLine: false, automaticLayout: true, folding: true }}
        />
      </div>
    </div>
  );
}
