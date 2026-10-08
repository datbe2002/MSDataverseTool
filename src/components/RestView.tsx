import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useStore } from "../store";
import { ROW_CAP, MAX_TABS, activeTabOf, buildContext, restTables, tabLabel, useRest, workspaceOf, type RestRun, type RestTab } from "../lib/restStore";
import { KINDS, buildRequest, isWrite, kindInfo, readablePath, type RestKind, type RestRequest } from "../lib/restModel";
import { TARGETS, generateCode, type CodeTarget } from "../lib/restCode";
import { formatFetchXml, parseFetch } from "../lib/fetchXml";
import { lintFetch, queryTables } from "../lib/fetchLint";
import { elementRanges } from "../lib/fetchModel";
import { registerFetchCompletion } from "../lib/fetchCompletion";
import { columnKey, useSchema } from "../lib/schema";
import { EDITOR_FONT, EDITOR_THEME } from "../lib/monacoTheme";
import { formatMs } from "../lib/history";
import { toCsv, toJson } from "../lib/export";
import { friendlyError } from "../lib/errors";
import { api } from "../api";
import { RestForm } from "./RestForm";
import { ErrorState, Grid, Skeleton } from "./ResultsTable";
import { Modal } from "./Modals";
import { AlertTriangle, ChevronDown, Clock, Copy, Download, Loader, Pencil, Plus, Send, X } from "./Icon";
import type { QueryResult } from "../types";

const FORM_KEY = "cds.rest.formWidth";
const TARGET_KEY = "cds.rest.codeTarget";
const FORM = { min: 300, max: 760, initial: 380 };
const FETCH_FORM = { initial: 520 };

function readNumber(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function readTarget(): CodeTarget {
  try {
    const t = localStorage.getItem(TARGET_KEY);
    return TARGETS.some((x) => x.id === t) ? (t as CodeTarget) : "xrm";
  } catch {
    return "xrm";
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const METHOD_TONE: Record<string, string> = { GET: "badge-brand", POST: "badge-success", PATCH: "badge-warning", PUT: "badge-warning", DELETE: "badge-danger" };

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

export function RestView() {
  const activeId = useStore((s) => s.activeId);
  const connections = useStore((s) => s.connections);
  const theme = useStore((s) => s.theme);
  const pushToast = useStore((s) => s.pushToast);
  const conn = connections.find((c) => c.id === activeId);
  const tab = useRest((s) => (activeId ? activeTabOf(s, activeId) : null));
  const lastRun = useRest((s) => (tab ? s.runs[tab.id] : undefined));
  const req = tab?.request;
  // A run of another request type (before the type was changed) isn't this request's answer.
  const run = lastRun && lastRun.kind === req?.kind ? lastRun : undefined;
  const update = useCallback((patch: Partial<RestRequest>) => activeId && tab && useRest.getState().update(activeId, tab.id, patch), [activeId, tab]);

  // --- metadata: the table, its expand / parameter tables, every table's entity set ---
  const table = req && req.kind !== "fetchXml" && !((req.kind === "function" || req.kind === "action") && req.bound === "none") ? req.table.trim().toLowerCase() : "";
  const metaEntry = restTables.useEntry(activeId && table ? activeId : null, table);
  const cacheData = restTables.useStore((s) => s.data);
  const schemaTables = useSchema((s) => (activeId ? s.tables[activeId] : undefined));
  useEffect(() => {
    if (activeId) void useSchema.getState().loadTables(activeId);
  }, [activeId]);
  const related = useMemo(() => {
    if (!req || !metaEntry.data) return [];
    const out = new Set<string>();
    for (const e of req.expand) {
      const nav = metaEntry.data.navigation.find((n) => n.name === e.nav);
      if (nav) out.add(nav.table.toLowerCase());
    }
    const nav = metaEntry.data.navigation.find((n) => n.name === req.nav);
    if (nav) out.add(nav.table.toLowerCase());
    for (const p of req.params) if (p.type === "record" && p.table) out.add(p.table.toLowerCase());
    return [...out];
  }, [req, metaEntry.data]);
  useEffect(() => {
    if (activeId) for (const t of related) restTables.load(activeId, t).catch(() => {});
  }, [activeId, related]);

  const built = useMemo(() => {
    if (!req || !activeId) return null;
    return buildRequest(req, buildContext(activeId, table));
    // cacheData / schemaTables: rebuild once more metadata arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, activeId, table, cacheData, schemaTables]);

  // --- code ---
  const [target, setTarget] = useState<CodeTarget>(readTarget);
  const code = useMemo(() => {
    if (!req || !built || !activeId) return "";
    const ctx = buildContext(activeId, table);
    return generateCode(target, { host: conn?.host ?? "org.crm.dynamics.com", req, built, meta: ctx.meta, metaOf: ctx.metaOf });
  }, [target, req, built, activeId, table, conn?.host]);

  // --- layout ---
  const isFetch = req?.kind === "fetchXml";
  const widthKey = isFetch ? `${FORM_KEY}.fetch` : FORM_KEY;
  const [formW, setFormW] = useState(() => readNumber(widthKey, isFetch ? FETCH_FORM.initial : FORM.initial));
  useEffect(() => setFormW(readNumber(widthKey, isFetch ? FETCH_FORM.initial : FORM.initial)), [widthKey, isFetch]);
  const dragFrom = useRef(formW);
  const resize = (dx: number, done: boolean) => {
    const w = Math.round(Math.min(FORM.max, Math.max(FORM.min, dragFrom.current + dx)));
    setFormW(w);
    if (done) {
      dragFrom.current = w;
      remember(widthKey, String(w));
    }
  };
  const [codeH, setCodeH] = useState(() => readNumber("cds.rest.codeHeight", 300));
  const vDrag = useRef<{ y: number; h: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => vDrag.current && setCodeH(Math.min(Math.max(90, vDrag.current.h + e.clientY - vDrag.current.y), 900));
    const onUp = () => {
      if (!vDrag.current) return;
      vDrag.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setCodeH((h) => {
        remember("cds.rest.codeHeight", String(h));
        return h;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!activeId || !tab || !req || !built) {
    return <div className="flex h-full items-center justify-center text-sm text-subtle">Select an environment to build Web API requests for it.</div>;
  }

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: "Could not copy" }));
  const fullUrl = `https://${conn?.host ?? ""}/api/data/v9.2/${readablePath(built)}`;
  const write = isWrite(req.kind);
  const language = TARGETS.find((t) => t.id === target)?.language ?? "plaintext";

  const changeKind = (kind: RestKind) => {
    if (kind === req.kind) return;
    const fromOp = req.kind === "function" || req.kind === "action";
    const toOp = kind === "function" || kind === "action";
    update({
      kind,
      // Functions and actions have different names / parameters; a table request keeps its table.
      ...(toOp && !fromOp ? { operation: kind === "function" ? "WhoAmI" : "", params: [], bound: "none" as const } : {}),
      ...(toOp && fromOp ? { operation: "", params: [] } : {}),
      ...(kind === "retrieveMultiple" && !req.top ? { top: "50" } : {}),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RestTabs connId={activeId} />
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-s1 px-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
          <Send size={14} className="text-brand" /> Request
        </span>
        <select className="input h-7 w-auto py-0 text-[12.5px]" value={req.kind} onChange={(e) => changeKind(e.target.value as RestKind)} aria-label="Request type" title={kindInfo(req.kind).hint}>
          <optgroup label="Read — runs here">
            {KINDS.filter((k) => !k.write).map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Write — code only">
            {KINDS.filter((k) => k.write).map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </optgroup>
        </select>
        {write && (
          <span className="badge badge-neutral" title="Writes aren't sent from Hexa Studio yet: copy the code and run it where you need it.">
            Code only
          </span>
        )}
        <span className="truncate text-xs text-subtle">{kindInfo(req.kind).hint}</span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Form */}
        <div className="min-h-0 shrink-0 overflow-y-auto border-r border-line bg-s1" style={{ width: formW }}>
          {isFetch ? (
            <FetchEditor connId={activeId} tabId={tab.id} xml={req.fetchXml} onChange={(fetchXml) => update({ fetchXml })} formatted={req.formatted} onFormatted={(formatted) => update({ formatted })} dark={theme === "dark"} />
          ) : (
            <RestForm connId={activeId} req={req} update={update} meta={metaEntry.data} metaLoading={metaEntry.loading} metaError={metaEntry.error} />
          )}
        </div>
        <PaneResizer
          label="Resize the form"
          onDrag={(dx, done) => resize(dx, done)}
          onKey={(dx) => {
            dragFrom.current = formW;
            resize(dx, true);
          }}
        />

        {/* Request, code, response */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className={`badge ${METHOD_TONE[built.method]} font-mono`}>{built.method}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={fullUrl}>
              {readablePath(built)}
            </code>
            {built.problems.length > 0 && (
              <span className="badge badge-warning shrink-0" title={built.problems.join("\n")}>
                <AlertTriangle size={11} /> {built.problems.length === 1 ? built.problems[0] : `${built.problems.length} things to fill in`}
              </span>
            )}
            <button className="btn btn-ghost btn-sm shrink-0" onClick={() => copy(fullUrl, "the URL")} title="Copy the full URL">
              <Copy size={13} /> URL
            </button>
          </div>
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-s1 px-2">
            <div className="seg" role="group" aria-label="Code for">
              {TARGETS.map((t) => (
                <button
                  key={t.id}
                  aria-pressed={target === t.id}
                  title={t.hint}
                  onClick={() => {
                    setTarget(t.id);
                    remember(TARGET_KEY, t.id);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button className="btn btn-secondary btn-sm ml-auto shrink-0" onClick={() => copy(code, "the code")}>
              <Copy size={13} /> Copy code
            </button>
          </div>
          <div className="shrink-0" style={{ height: codeH, background: "var(--editor-bg)" }}>
            <Editor
              height="100%"
              language={language}
              path={`rest-code.${target}`}
              value={code}
              theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                fontSize: 12.5,
                fontFamily: EDITOR_FONT,
                lineNumbersMinChars: 3,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderLineHighlight: "none",
                padding: { top: 8, bottom: 8 },
              }}
            />
          </div>
          <div
            onMouseDown={(e) => {
              vDrag.current = { y: e.clientY, h: codeH };
              document.body.style.cursor = "row-resize";
              document.body.style.userSelect = "none";
            }}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the code"
            className="group relative flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-t border-line bg-s1"
          >
            <div className="h-1 w-10 rounded-full bg-line-strong transition group-hover:w-16 group-hover:bg-brand" />
          </div>
          <ResponsePane tab={tab} run={run} write={write} dark={theme === "dark"} />
        </div>
      </div>
    </div>
  );
}

// ---------- FetchXML ----------

const MARKER_OWNER = "fetchxml";
const LINT_OWNER = "fetchxml-lint";

/** The FetchXML request's editor: autocomplete, XML errors and checks against the environment's metadata. */
function FetchEditor({
  connId,
  tabId,
  xml,
  onChange,
  formatted,
  onFormatted,
  dark,
}: {
  connId: string;
  tabId: string;
  xml: string;
  onChange: (xml: string) => void;
  formatted: boolean;
  onFormatted: (on: boolean) => void;
  dark: boolean;
}) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [check, setCheck] = useState(() => parseFetch(xml));
  useEffect(() => {
    const id = setTimeout(() => setCheck(parseFetch(xml)), 300);
    return () => clearTimeout(id);
  }, [xml]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setCheck(parseFetch(xml)), [tabId]);

  const doc = useMemo(() => {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    return parsed.getElementsByTagName("parsererror").length ? null : parsed;
  }, [xml]);
  const schemaTables = useSchema((s) => s.tables[connId]);
  const schemaColumns = useSchema((s) => s.columns);
  const tablesKey = useMemo(() => (doc ? queryTables(doc) : []).join("|"), [doc]);
  useEffect(() => {
    void useSchema.getState().loadTables(connId);
    for (const t of tablesKey ? tablesKey.split("|") : []) void useSchema.getState().loadColumns(connId, t);
  }, [connId, tablesKey]);
  const problems = useMemo(() => {
    if (!doc) return [];
    const known = schemaTables?.length ? new Set(schemaTables.map((t) => t.logicalName)) : undefined;
    return lintFetch(doc, {
      tables: known,
      columns: (t) => {
        if (known && !known.has(t)) return undefined;
        const cols = schemaColumns[columnKey(connId, t)];
        return cols?.length ? cols : undefined;
      },
    });
  }, [doc, connId, schemaTables, schemaColumns]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const markers: Monaco.editor.IMarkerData[] = [];
    if (!check.ok && check.line) {
      const line = Math.min(check.line, model.getLineCount());
      const col = Math.max(1, Math.min(check.column ?? 1, model.getLineMaxColumn(line)));
      markers.push({ severity: monaco.MarkerSeverity.Error, message: check.error, startLineNumber: line, startColumn: Math.max(1, col - 1), endLineNumber: line, endColumn: model.getLineMaxColumn(line) });
    }
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  }, [check]);
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

  const onMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    registerXmlFormatter(monaco);
    registerFetchCompletion(monaco);
    editor.focus();
  }, []);

  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <h3 className="text-[12px] font-semibold text-fg">FetchXML</h3>
        {check.ok ? (
          <span className="badge badge-brand font-mono" title="Table the query reads">
            {check.fetch.entity}
          </span>
        ) : xml.trim() && check.line ? (
          <button
            className="badge badge-danger"
            title={check.error}
            onClick={() => {
              editorRef.current?.revealLineInCenter(check.line!);
              editorRef.current?.setPosition({ lineNumber: check.line!, column: check.column ?? 1 });
              editorRef.current?.focus();
            }}
          >
            <AlertTriangle size={11} /> XML error · line {check.line}
          </button>
        ) : null}
        {(errors > 0 || warnings > 0) && (
          <span className={`badge ${errors ? "badge-danger" : "badge-warning"}`} title={problems.map((p) => p.message).join("\n")}>
            <AlertTriangle size={11} /> {[errors && `${errors} error${errors === 1 ? "" : "s"}`, warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`].filter(Boolean).join(", ")}
          </span>
        )}
        <label className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted" title='Prefer: odata.include-annotations="*"'>
          <input type="checkbox" checked={formatted} onChange={(e) => onFormatted(e.target.checked)} /> Labels
        </label>
        <button className="btn btn-ghost btn-sm shrink-0" disabled={!check.ok && !!check.line} onClick={() => void editorRef.current?.getAction("editor.action.formatDocument")?.run()} title="Indent the XML (Shift+Alt+F)">
          Format
        </button>
      </div>
      <div className="min-h-0 flex-1" style={{ background: "var(--editor-bg)" }}>
        <Editor
          height="100%"
          defaultLanguage="xml"
          theme={dark ? EDITOR_THEME.dark : EDITOR_THEME.light}
          path={`fetch-${tabId}.xml`}
          value={xml}
          onChange={(v) => onChange(v ?? "")}
          onMount={onMount}
          options={{
            fontSize: 13,
            fontFamily: EDITOR_FONT,
            fontLigatures: false,
            lineHeight: 21,
            lineNumbersMinChars: 3,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            padding: { top: 10, bottom: 10 },
            automaticLayout: true,
            tabSize: 2,
            wordBasedSuggestions: "off",
            quickSuggestions: { other: true, strings: true, comments: false },
            suggestOnTriggerCharacters: true,
            suggest: { showWords: false },
          }}
        />
      </div>
    </div>
  );
}

// ---------- response ----------

function ResponsePane({ tab, run, write, dark }: { tab: RestTab; run: RestRun | undefined; write: boolean; dark: boolean }) {
  const formatted = useRest((s) => s.formatted);
  const { setFormatted, loadMore, stop } = useRest.getState();
  const [view, setView] = useState<"table" | "json">("table");
  const runKey = useStore((s) => s.keybindings.run[0]);
  const hasRows = !!run?.records;
  const result: QueryResult | null = useMemo(() => {
    if (!run || run.status !== "ok" || !run.records) return null;
    return { columns: run.flat.columns, rows: formatted ? run.flat.display : run.flat.raw, rowCount: run.records.length, elapsedMs: run.ms, truncated: run.capped };
  }, [run, formatted]);
  const showJson = view === "json" || (run?.status === "ok" && !hasRows);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-line bg-s1 px-2">
        <span className="tab" aria-selected="true" role="tab">
          Response
        </span>
        {run?.status === "running" ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 pr-1 text-xs font-medium text-brand">
            <Loader size={12} /> Sending
          </div>
        ) : run ? (
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-3 pr-1 text-xs text-muted">
            {run.httpStatus !== undefined && <span className={`badge ${run.status === "ok" ? "badge-success" : "badge-danger"} font-mono`}>{run.httpStatus}</span>}
            <span className="flex items-center gap-1 tabular-nums" title={`${run.requests} request${run.requests === 1 ? "" : "s"} · ${(run.bytes / 1_048_576).toFixed(2)} MB${run.throttled ? ` · slowed down ${run.throttled}×` : ""}`}>
              <Clock size={12} /> {formatMs(run.ms)}
            </span>
            {run.records && (
              <span className="badge badge-neutral">
                {run.records.length.toLocaleString()} row{run.records.length === 1 ? "" : "s"}
                {run.total !== undefined ? ` of ${run.total.toLocaleString()}` : ""}
                {run.more ? " · more available" : ""}
                {run.capped ? ` (capped at ${ROW_CAP.toLocaleString()})` : ""}
              </span>
            )}
            {run.loadingMore ? (
              <>
                <span className="flex items-center gap-1 text-brand">
                  <Loader size={12} /> Reading the next page…
                </span>
                <button onClick={stop} className="btn btn-secondary btn-sm">
                  Stop
                </button>
              </>
            ) : (
              run.more &&
              !run.capped && (
                <>
                  <button onClick={() => void loadMore(false)} className="btn btn-secondary btn-sm">
                    Next page
                  </button>
                  <button onClick={() => void loadMore(true)} className="btn btn-secondary btn-sm" title={`Read every page (up to ${ROW_CAP.toLocaleString()} rows)`}>
                    Load all
                  </button>
                </>
              )
            )}
            {run.status === "ok" && hasRows && (
              <div className="seg" role="group" aria-label="Show">
                <button aria-pressed={view === "table" && formatted} onClick={() => (setView("table"), setFormatted(true))} title="Lookup names, choice labels and formatted dates / numbers">
                  Formatted
                </button>
                <button aria-pressed={view === "table" && !formatted} onClick={() => (setView("table"), setFormatted(false))} title="GUIDs, option values, ISO dates">
                  Raw
                </button>
                <button aria-pressed={view === "json"} onClick={() => setView("json")} title="The response body as the Web API returned it">
                  JSON
                </button>
              </div>
            )}
            {result && <ExportMenu result={result} name={tabLabel(tab)} />}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1" style={{ background: "var(--editor-bg)" }}>
        {!run ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="empty-icon">
              <Send size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">{write ? "Code only, for now" : "No response yet"}</div>
              <div className="mt-0.5 max-w-sm text-xs text-subtle">
                {write ? "Hexa Studio doesn't send writes yet. Copy the code above and run it where you need it." : `Execute the request${runKey ? ` (${runKey})` : ""} to see what the Web API answers.`}
              </div>
            </div>
          </div>
        ) : run.status === "running" ? (
          <Skeleton />
        ) : run.status === "error" ? (
          run.body && view === "json" ? (
            <JsonView value={run.body} dark={dark} path="rest-error.json" />
          ) : (
            <div className="flex h-full flex-col">
              <ErrorState title={run.line ? "Invalid XML" : run.httpStatus ? `Request failed (${run.httpStatus})` : "Request failed"} message={`${run.line ? `Line ${run.line}: ` : ""}${run.error ?? ""}`} />
              {run.body != null && (
                <div className="shrink-0 border-t border-line p-2 text-center">
                  <button className="btn btn-ghost btn-sm" onClick={() => setView("json")}>
                    Show the response body
                  </button>
                </div>
              )}
            </div>
          )
        ) : showJson ? (
          <JsonView value={hasRows && run.kind !== "retrieve" ? run.records : run.body} dark={dark} path="rest-response.json" />
        ) : run.kind === "retrieve" && run.records?.[0] ? (
          <RecordFields record={run.records[0]} formatted={formatted} />
        ) : result && result.rows.length > 0 ? (
          <Grid key={result.columns.map((c) => c.name).join("\u0001")} result={result} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-subtle">No rows match.</div>
        )}
      </div>
    </div>
  );
}

const FORMATTED = "@OData.Community.Display.V1.FormattedValue";

/** One record as a two-column list: column, value (formatted when asked and there is one). */
function RecordFields({ record, formatted }: { record: Record<string, unknown>; formatted: boolean }) {
  const rows = Object.keys(record)
    .filter((k) => !k.includes("@"))
    .map((k) => {
      const raw = record[k];
      const label = record[`${k}${FORMATTED}`];
      const value = formatted && label !== undefined ? label : raw;
      return { k, value: value === null || value === undefined ? null : typeof value === "object" ? JSON.stringify(value) : String(value), raw: typeof raw === "object" && raw !== null ? JSON.stringify(raw) : String(raw) };
    });
  return (
    <div className="h-full overflow-auto">
      <table className="tbl w-full">
        <thead>
          <tr>
            <th className="w-72">Column</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <td className="font-mono text-[12px] text-muted">{r.k}</td>
              <td className="font-mono text-[12px]" title={r.raw}>
                {r.value === null ? <span className="text-subtle">null</span> : r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Most rows shown as JSON (the text gets heavy past this). */
const JSON_MAX = 5000;

function JsonView({ value, dark, path }: { value: unknown; dark: boolean; path: string }) {
  const many = Array.isArray(value) && value.length > JSON_MAX;
  const text = useMemo(() => (typeof value === "string" ? value : JSON.stringify(many ? (value as unknown[]).slice(0, JSON_MAX) : value, null, 2)), [value, many]);
  return (
    <div className="flex h-full flex-col">
      {many && <div className="shrink-0 border-b border-line bg-s1 px-3 py-1 text-[11px] text-subtle">Showing the first {JSON_MAX.toLocaleString()} rows.</div>}
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          language={typeof value === "string" ? "plaintext" : "json"}
          path={path}
          value={text}
          theme={dark ? EDITOR_THEME.dark : EDITOR_THEME.light}
          options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12.5, fontFamily: EDITOR_FONT, lineNumbersMinChars: 4, scrollBeyondLastLine: false, automaticLayout: true, folding: true }}
        />
      </div>
    </div>
  );
}

/** Copy or save the rows shown in the grid. */
function ExportMenu({ result, name }: { result: QueryResult; name: string }) {
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
  const base = name.replace(/[<>:"/\\|?*\u0000-\u001f·]+/g, " ").replace(/\s+/g, " ").trim() || "rows";
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
  const copyText = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="btn btn-secondary btn-sm" aria-expanded={open} title="Copy or save these rows">
        <Download size={13} /> Export <ChevronDown size={12} />
      </button>
      {open && (
        <div className="pop popover absolute right-0 top-full z-50 mt-1.5 w-48 p-1" role="menu">
          {item("Copy as CSV", () => copyText(toCsv(result)))}
          {item("Copy as JSON", () => copyText(toJson(result)))}
          <div className="my-1 border-t border-line" />
          {item("Save as CSV…", () => void save("csv"))}
          {item("Save as JSON…", () => void save("json"))}
        </div>
      )}
    </div>
  );
}

// ---------- tabs ----------

/** The environment's request tabs: pick, rename (double-click), close, add. */
function RestTabs({ connId }: { connId: string }) {
  const ws = useRest((s) => workspaceOf(s, connId));
  const runs = useRest((s) => s.runs);
  const { selectTab, renameTab, closeTab, newTab } = useRest.getState();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [closing, setClosing] = useState<RestTab | null>(null);
  const atLimit = ws.tabs.length >= MAX_TABS;
  const commitRename = () => {
    if (editing) renameTab(connId, editing, draft);
    setEditing(null);
  };
  // A FetchXML query is the only typed work a tab holds; the form is quick to redo.
  const requestClose = (t: RestTab) => (t.request.kind === "fetchXml" && t.request.fetchXml.trim() ? setClosing(t) : closeTab(connId, t.id));

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-s1 pr-2">
      <div className="flex min-h-0 min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden" role="tablist" aria-label="Request tabs">
        {ws.tabs.map((t) => {
          const active = t.id === ws.active;
          const label = tabLabel(t);
          const busy = runs[t.id]?.status === "running" || !!runs[t.id]?.loadingMore;
          const canClose = ws.tabs.length > 1;
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
              title={label}
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
              {editing !== t.id && canClose && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    requestClose(t);
                  }}
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded text-subtle transition hover:bg-s3 hover:text-fg ${active ? "" : "opacity-0 group-hover:opacity-100"}`}
                  aria-label="Close tab"
                  title="Close tab (middle-click)"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}
        <button
          onClick={() => newTab(connId)}
          disabled={atLimit}
          title={atLimit ? `At most ${MAX_TABS} tabs` : "New request"}
          aria-label="New request tab"
          className="mx-1 grid h-7 w-7 shrink-0 self-center place-items-center rounded-md text-muted transition hover:bg-s3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={15} />
        </button>
      </div>
      {closing && (
        <Modal title="Close this tab?" icon={<AlertTriangle size={15} className="text-warning" />} onClose={() => setClosing(null)}>
          <p className="text-sm text-muted">
            The FetchXML in <span className="font-medium text-fg">{tabLabel(closing)}</span> isn't saved anywhere else.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-line p-2 font-mono text-[11.5px] text-muted" style={{ background: "var(--editor-bg)" }}>
            {closing.request.fetchXml.trim().slice(0, 1200)}
          </pre>
          <div className="modal-footer">
            <button autoFocus className="btn btn-secondary" onClick={() => setClosing(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                closeTab(connId, closing.id);
                setClosing(null);
              }}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
