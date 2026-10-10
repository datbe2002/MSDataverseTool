import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useStore } from "../store";
import { definitionKey, summarize, useFlows } from "../lib/flows";
import { buildOutline, childFlowIds, keyLines, type ChildFlow, type OutlineNode } from "../lib/flowOutline";
import { ROUTES, flowRoute } from "../lib/navigation";
import { FlowOutline } from "./FlowOutline";
import { FlowDesigner } from "./FlowDesigner";
import { FlowRunsTab } from "./FlowRuns";
import { FlowAnalysisPane, GRADE_BADGE } from "./FlowAnalysis";
import { analyseFlow } from "../lib/flowAnalyzer";
import { AddToTask } from "./FlowTaskDialogs";
import { PaneResizer } from "./PaneResizer";
import { rangeLabel, runSummaries, useMonitorRange } from "../lib/flowRuns";
import { relativeTime } from "../lib/history";
import { EDITOR_THEME } from "../lib/monacoTheme";
import { Search, Refresh, Copy, Flow, AlertTriangle, ArrowLeft, ArrowUpRight, Loader, ChevronDown } from "./Icon";
import type { FlowMeta } from "../types";
import { SelectFace } from "./FormParts";

type StateFilter = "all" | "on" | "off" | "suspended";

const STATE_OF: Record<Exclude<StateFilter, "all">, number> = { off: 0, on: 1, suspended: 2 };

/** Solution picker value for flows outside any solution ("" = any). */
const NO_SOLUTION = "\u0000none";

function stateBadge(flow: FlowMeta) {
  if (flow.state === 1) return "badge-success";
  if (flow.state === 2) return "badge-warning";
  return "badge-neutral";
}

function stateDot(flow: FlowMeta) {
  if (flow.state === 1) return "bg-success";
  if (flow.state === 2) return "bg-warning";
  return "bg-line-strong";
}

const time = (iso: string) => (iso ? relativeTime(Date.parse(iso)) : "—");

const LIST_KEY = "cds.flows.listWidth";
/** Flow list width (px); dragged by the user, remembered. */
const LIST = { min: 300, max: 720, initial: 320 };

function readListWidth(): number {
  try {
    const w = Number(localStorage.getItem(LIST_KEY));
    return w ? Math.min(LIST.max, Math.max(LIST.min, w)) : LIST.initial;
  } catch {
    return LIST.initial;
  }
}

export function FlowsView() {
  const activeId = useStore((s) => s.activeId);
  const connection = useStore((s) => s.connections.find((c) => c.id === s.activeId) ?? null);
  const list = useFlows((s) => (activeId ? s.lists[activeId] : undefined));
  const status = useFlows((s) => (activeId ? s.status[activeId] : undefined));
  const error = useFlows((s) => (activeId ? s.errors[activeId] : undefined));
  const loadFlows = useFlows((s) => s.loadFlows);
  // Failures per flow, once Flow runs has counted this environment.
  const runRange = useMonitorRange((s) => s.range);
  const runSummary = runSummaries.useStore((s) => (activeId ? s.data[`${activeId}|${runRange}`] : undefined));
  const failuresOf = useMemo(
    () => new Map((runSummary?.flows ?? []).filter((f) => f.failed > 0).map((f) => [f.flowId, f.failed])),
    [runSummary]
  );

  const [filter, setFilter] = useState("");
  const [state, setState] = useState<StateFilter>("all");
  const [owner, setOwner] = useState("");
  const [solution, setSolution] = useState("");
  const [listWidth, setListWidth] = useState(readListWidth);
  const dragFrom = useRef(listWidth);
  const resizeList = (dx: number, done: boolean) => {
    const w = Math.round(Math.min(LIST.max, Math.max(LIST.min, dragFrom.current + dx)));
    setListWidth(w);
    if (done) {
      dragFrom.current = w;
      try {
        localStorage.setItem(LIST_KEY, String(w));
      } catch {
        // Only a convenience.
      }
    }
  };
  // The picked flow lives in the URL (/flows/:flowId): back/forward and reload keep it.
  const { flowId } = useParams();
  const selected = flowId ?? null;
  const navigate = useNavigate();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (activeId) loadFlows(activeId);
  }, [activeId, loadFlows]);

  // Another environment: its owners / solutions / flows differ. Not on first
  // render, so a deep link (or reload) keeps its flow.
  const prevActiveId = useRef(activeId);
  useEffect(() => {
    if (prevActiveId.current && prevActiveId.current !== activeId) {
      setOwner("");
      setSolution("");
      navigate(ROUTES.flows, { replace: true });
    }
    prevActiveId.current = activeId;
  }, [activeId, navigate]);

  const flows = list?.flows;
  const owners = useMemo(
    () => [...new Set((flows ?? []).map((f) => f.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [flows]
  );
  const solutions = useMemo(
    () => [...new Set((flows ?? []).flatMap((f) => f.solutions))].sort((a, b) => a.localeCompare(b)),
    [flows]
  );

  // Status counts follow the other filters, so they add up to what's listed.
  const matchesOthers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (f: FlowMeta) =>
      (!owner || f.owner === owner) &&
      (!solution || (solution === NO_SOLUTION ? f.solutions.length === 0 : f.solutions.includes(solution))) &&
      (!q ||
        f.name.toLowerCase().includes(q) ||
        f.owner.toLowerCase().includes(q) ||
        f.solutions.some((s) => s.toLowerCase().includes(q)) ||
        f.id.includes(q));
  }, [filter, owner, solution]);

  const base = useMemo(() => (flows ?? []).filter(matchesOthers), [flows, matchesOthers]);
  const counts = useMemo(
    () => ({
      all: base.length,
      on: base.filter((f) => f.state === 1).length,
      off: base.filter((f) => f.state === 0).length,
      suspended: base.filter((f) => f.state === 2).length,
    }),
    [base]
  );
  const shown = useMemo(
    () => (state === "all" ? base : base.filter((f) => f.state === STATE_OF[state])),
    [base, state]
  );

  const flow = flows?.find((f) => f.id === selected) ?? null;

  // A deep-linked flow may be far down the list.
  useEffect(() => {
    listRef.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, flows]);

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        Select an environment to see its cloud flows.
      </div>
    );
  }

  const filtered = !!(filter.trim() || owner || solution);

  return (
    <div className="flex h-full">
      {/* Flow list */}
      <div className="flex min-h-0 flex-col bg-s1" style={{ flex: `0 1 ${listWidth}px`, minWidth: LIST.min }}>
        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              className="input !pl-8"
              placeholder={flows ? `Filter ${flows.length.toLocaleString()} flows…` : "Filter flows…"}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter flows by name, owner or solution"
            />
          </div>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => loadFlows(activeId, true)}
            disabled={status === "loading"}
            title="Reload flows from the environment"
            aria-label="Reload flows"
          >
            <Refresh size={14} className={status === "loading" ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 px-3 pt-2">
          <select
            className="input !h-8 !px-2 !text-[12.5px]"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            aria-label="Filter by owner"
            disabled={!flows}
          >
            <SelectFace />
            <option value="">Any owner</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <select
            className="input !h-8 !px-2 !text-[12.5px]"
            value={solution}
            onChange={(e) => setSolution(e.target.value)}
            aria-label="Filter by solution"
            disabled={!flows || !!list?.solutionsError}
            title={list?.solutionsError ? "Solutions can't be read with this account" : undefined}
          >
            <SelectFace />
            <option value="">{list?.solutionsError ? "Solutions unavailable" : "Any solution"}</option>
            {solutions.length > 0 && <option value={NO_SOLUTION}>Not in a solution</option>}
            {solutions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="seg mx-3 my-2.5 !flex" role="group" aria-label="Filter by status">
          {(
            [
              ["all", "All"],
              ["on", "On"],
              ["off", "Off"],
              ["suspended", "Suspended"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} onClick={() => setState(key)} aria-pressed={state === key} className="flex-1">
              {label}
              {flows && <span className="seg-count">{counts[key]}</span>}
            </button>
          ))}
        </div>

        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label="Flows">
          {status === "error" ? (
            <li className="px-3 py-8 text-center text-xs text-subtle">
              <div className="text-warning">Couldn't load flows.</div>
              <div className="mt-1 break-words">{error}</div>
              <button className="btn btn-secondary btn-sm mt-3" onClick={() => loadFlows(activeId, true)}>
                <Refresh size={12} /> Retry
              </button>
            </li>
          ) : !flows ? (
            Array.from({ length: 10 }, (_, i) => (
              <li key={i} className="flex items-center gap-2.5 px-2.5 py-2">
                <div className="skeleton h-2 w-2 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-3 w-2/3" />
                  <div className="skeleton h-2.5 w-1/2" />
                </div>
              </li>
            ))
          ) : shown.length === 0 ? (
            <li className="fade-in px-3 py-10 text-center">
              <div className="empty-icon">
                <Flow size={18} />
              </div>
              <div className="mt-3 text-sm font-medium">
                {flows.length === 0 ? "No cloud flows in this environment" : "No flows match"}
              </div>
              <div className="mt-1 text-xs text-subtle">
                {flows.length === 0
                  ? "Or this account can't read them."
                  : filtered
                  ? "Clear the search or pickers above."
                  : "Switch the status filter above."}
              </div>
            </li>
          ) : (
            shown.map((f) => (
              <li key={f.id}>
                <button
                  role="option"
                  aria-selected={f.id === selected}
                  aria-current={f.id === selected ? "page" : undefined}
                  className="nav-item nav-item-tall"
                  onClick={() => f.id !== selected && navigate(flowRoute(f.id))}
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${stateDot(f)}`}
                    title={f.stateLabel}
                    aria-label={f.stateLabel}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{f.name || "(no name)"}</span>
                    <span className="block truncate text-xs font-normal text-subtle">
                      {f.owner || "—"} · {time(f.modifiedOn)}
                    </span>
                  </span>
                  {failuresOf.has(f.id.toLowerCase()) && (
                    <span
                      className="badge badge-danger shrink-0 tabular-nums"
                      title={`${failuresOf.get(f.id.toLowerCase())} failed runs in the ${rangeLabel(runRange).toLowerCase()}`}
                    >
                      {failuresOf.get(f.id.toLowerCase())!.toLocaleString()}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      <PaneResizer
        label="Resize the flow list"
        onDrag={resizeList}
        onKey={(dx) => {
          dragFrom.current = listWidth;
          resizeList(dx, true);
        }}
      />

      {/* Detail */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {selected && flows && !flow ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="empty-icon">
              <Flow size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">Flow not found</div>
              <div className="mt-0.5 max-w-sm text-xs text-subtle">
                {connection?.name ?? "This environment"} has no flow with id{" "}
                <span className="font-mono">{selected}</span>. It may have been deleted, or the link is from
                another environment.
              </div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate(ROUTES.flows, { replace: true })}>
              Back to all flows
            </button>
          </div>
        ) : !flow ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="empty-icon">
              <Flow size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">No flow selected</div>
              <div className="mt-0.5 text-xs text-subtle">
                Pick a flow on the left to see its trigger, actions and definition.
              </div>
            </div>
            {list?.solutionsError && (
              <div className="mt-2 max-w-md text-xs text-subtle">
                Solutions aren't shown: this account can't read the solution table in{" "}
                {connection?.name ?? "this environment"}.
              </div>
            )}
          </div>
        ) : (
          <FlowDetail key={flow.id} connId={activeId} flow={flow} flows={flows ?? []} />
        )}
      </div>
    </div>
  );
}

type DefinitionTab = "json" | "designer" | "analysis" | "runs";
const TAB_KEY = "cds.flowTab";
const DETAILS_KEY = "cds.flows.detailsOpen";

/**
 * A flow opened from another one (a child flow, a caller): the flows it was
 * opened from, oldest first, with the step each was left at. Kept in the
 * history entry, so Back steps through them; `?step=` / `?tab=` on those
 * entries bring the step back.
 */
interface Opened {
  flowId: string;
  /** Name of the step it was opened from, for the breadcrumb. */
  step: string | null;
}

function openedFrom(state: unknown): Opened[] {
  const trail = typeof state === "object" && state !== null ? (state as { trail?: unknown }).trail : undefined;
  return Array.isArray(trail) ? (trail as Opened[]) : [];
}

/** "Run child flow" from a step id (its last path part). */
const stepLabel = (id: string) => id.split("\u0001").pop()!.replace(/_/g, " ");

function readDetailsOpen(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) !== "0";
  } catch {
    return true;
  }
}

function readTab(): DefinitionTab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return t === "designer" || t === "analysis" ? t : "json";
  } catch {
    return "json";
  }
}

/** A link to another flow of the environment (a child flow or a caller). */
function FlowChip({ id, name, onOpen }: { id: string; name: string | null; onOpen: (id: string) => void }) {
  if (!name) {
    return (
      <span className="badge badge-neutral font-mono" title={`No flow with id ${id} in this environment`}>
        {id.slice(0, 8)}…
      </span>
    );
  }
  return (
    <button className="badge badge-brand gap-1 hover:underline" onClick={() => onOpen(id)} title={`Open “${name}”`}>
      {name}
      <ArrowUpRight size={11} />
    </button>
  );
}

function FlowDetail({ connId, flow, flows }: { connId: string; flow: FlowMeta; flows: FlowMeta[] }) {
  const theme = useStore((s) => s.theme);
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const trail = useMemo(() => openedFrom(location.state), [location.state]);
  const pushToast = useStore((s) => s.pushToast);
  const key = definitionKey(connId, flow.id);
  const definitions = useFlows((s) => s.definitions);
  const definitionErrors = useFlows((s) => s.definitionErrors);
  const definition = definitions[key];
  const definitionError = definitionErrors[key];
  const loadDefinition = useFlows((s) => s.loadDefinition);

  useEffect(() => {
    loadDefinition(connId, flow.id);
  }, [connId, flow.id, loadDefinition]);

  const summary = useMemo(() => (definition ? summarize(definition) : null), [definition]);
  const outline = useMemo(() => (definition ? buildOutline(definition) : null), [definition]);
  const lines = useMemo(() => (definition ? keyLines(definition) : null), [definition]);
  const analysis = useMemo(() => {
    if (!definition) return null;
    try {
      return { result: analyseFlow(definition), error: null };
    } catch (e) {
      return { result: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [definition]);

  // Child flows: the ones this flow runs, and (on demand) the ones that run it.
  const byId = useMemo(() => new Map(flows.map((f) => [f.id.toLowerCase(), f])), [flows]);
  const flowName = useCallback((id: string) => byId.get(id.toLowerCase())?.name ?? null, [byId]);
  const children = useMemo(() => (outline ? childFlowIds(outline) : []), [outline]);

  // Child flows shown inside this one in the Designer (loaded when opened there).
  const childOutlines = useRef(new Map<string, { json: string; outline: OutlineNode[] | null }>());
  const childFlow = useCallback(
    (id: string): ChildFlow => {
      const meta = byId.get(id.toLowerCase());
      if (!meta) return { status: "missing" };
      const k = definitionKey(connId, meta.id);
      if (definitionErrors[k]) return { status: "error", message: definitionErrors[k] };
      const json = definitions[k];
      if (json === undefined) {
        loadDefinition(connId, meta.id);
        return { status: "loading" };
      }
      let cached = childOutlines.current.get(k);
      if (!cached || cached.json !== json) childOutlines.current.set(k, (cached = { json, outline: buildOutline(json) }));
      return cached.outline ? { status: "ready", outline: cached.outline } : { status: "error", message: "Not a cloud flow" };
    },
    [byId, connId, definitions, definitionErrors, loadDefinition]
  );
  // Only manually triggered flows can be run as a child flow.
  const callable = !!outline?.some((n) => n.kind === "trigger" && n.type.startsWith("Request"));
  const calls = useFlows((s) => s.calls[connId]);
  const callsStatus = useFlows((s) => s.callsStatus[connId]);
  const callsError = useFlows((s) => s.callsErrors[connId]);
  const loadCalls = useFlows((s) => s.loadCalls);
  const callers = useMemo(() => {
    if (!calls) return null;
    const me = flow.id.toLowerCase();
    return [...new Set(calls.filter((c) => c.child === me).map((c) => c.parent))].sort((a, b) =>
      (flowName(a) ?? a).localeCompare(flowName(b) ?? b)
    );
  }, [calls, flow.id, flowName]);

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const highlight = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  // Coming Back from a child flow (or opened at a step): that step is picked.
  const [step, setStep] = useState<string | null>(() => params.get("step"));
  const [editorReady, setEditorReady] = useState(false);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    highlight.current = editor.createDecorationsCollection();
    setEditorReady(true);
  };

  /** Scrolls the JSON to the step's key and marks that line. */
  const reveal = useCallback(
    (node: OutlineNode) => {
      setStep(node.id);
      const editor = editorRef.current;
      const line = lines?.get(node.id);
      if (!editor || !line) return;
      // Near the top, so the step's body shows below its key.
      const inView = editor
        .getVisibleRanges()
        .some((r) => line >= r.startLineNumber && line <= r.endLineNumber - 5);
      if (!inView) editor.revealLineNearTop(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      highlight.current?.set([
        { range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: "flow-line-hl" } },
      ]);
    },
    [lines]
  );
  // Still waiting for the definition (vs. failed / not a flow: show dashes).
  const pending = definition === undefined && !definitionError;

  // JSON (outline + editor) or Designer; both follow the same picked step.
  const [tab, setTabState] = useState<DefinitionTab>(() => {
    const t = params.get("tab");
    return t === "json" || t === "designer" || t === "analysis" || t === "runs" ? t : readTab();
  });
  // The run picked on the Runs tab; kept in the URL (?tab=runs&run=<id>) so Back and reload keep it.
  const runId = params.get("run");
  const setUrl = (t: DefinitionTab, run: string | null) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    if (run) next.set("run", run);
    else next.delete("run");
    void navigate({ pathname: location.pathname, search: `?${next}` }, { replace: true, state: location.state });
  };
  const setTab = (t: DefinitionTab) => {
    setTabState(t);
    if (t === "runs" || params.get("tab") === "runs") setUrl(t, t === "runs" ? runId : null);
    // Runs is a look at one flow's history; opening flows keeps landing on the definition.
    if (t === "runs") return;
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // Only a convenience.
    }
  };
  const monitorRange = useMonitorRange((s) => s.range);
  const runFailures = runSummaries.useStore(
    (s) => s.data[`${connId}|${monitorRange}`]?.flows.find((f) => f.flowId === flow.id.toLowerCase())?.failed ?? 0
  );
  const stepsById = useMemo(() => {
    const map = new Map<string, OutlineNode>();
    const walk = (nodes: OutlineNode[]) => nodes.forEach((n) => (map.set(n.id, n), walk(n.children)));
    walk(outline ?? []);
    return map;
  }, [outline]);
  // Back on the JSON tab: the editor was hidden, so lay it out, then show the step.
  useEffect(() => {
    if (tab !== "json") return;
    const t = setTimeout(() => {
      editorRef.current?.layout();
      const node = step ? stepsById.get(step) : null;
      if (node) reveal(node);
    }, 30);
    return () => clearTimeout(t);
    // Only when switching tabs; picks within the JSON tab reveal themselves.
  }, [tab]);
  // Opened at a step on the JSON tab: show it once the editor is up.
  useEffect(() => {
    if (!editorReady || tab !== "json") return;
    const node = step ? stepsById.get(step) : null;
    if (node) reveal(node);
    // Once, when the editor first has the text.
  }, [editorReady, lines]);

  /**
   * Opens another flow. This page is first marked with the step it's left
   * at (`from`, or the picked one), so Back returns to that step.
   * `at` opens the other flow at one of its steps.
   */
  const openFlow = useCallback(
    async (id: string, from?: string | null, at?: { step: string; tab: DefinitionTab }) => {
      const target = byId.get(id.toLowerCase())?.id ?? id;
      const here = from === undefined ? step : from;
      const back = new URLSearchParams({ tab });
      if (here) back.set("step", here);
      await navigate({ pathname: location.pathname, search: `?${back}` }, { replace: true, state: location.state });
      const there = at ? `?${new URLSearchParams({ step: at.step, tab: at.tab })}` : "";
      await navigate(
        { pathname: flowRoute(target), search: there },
        { state: { trail: [...trail, { flowId: flow.id, step: here ? stepLabel(here) : null }] } }
      );
    },
    [byId, step, tab, navigate, location.pathname, location.state, trail, flow.id]
  );
  /** The first step running a child flow (a "Calls" chip opens it from there). */
  const callerStep = useCallback(
    (childId: string) => [...stepsById.values()].find((n) => n.childFlowId === childId.toLowerCase())?.id ?? null,
    [stepsById]
  );

  // Collapsed keeps the title row only, so the designer gets the height; it stays so across flows.
  const [detailsOpen, setDetailsOpen] = useState(readDetailsOpen);
  const toggleDetails = () =>
    setDetailsOpen((open) => {
      try {
        localStorage.setItem(DETAILS_KEY, open ? "0" : "1");
      } catch {
        // Only a convenience.
      }
      return !open;
    });

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));

  return (
    <div className="fade-in flex h-full min-h-0 flex-col">
      <div className={`shrink-0 px-6 xl:px-8 ${detailsOpen ? "pb-5 short:pb-3" : "pb-3"} ${trail.length || !detailsOpen ? "pt-3" : "pt-7 short:pt-4"}`}>
        {trail.length > 0 && (
          <nav className="mb-2 flex min-w-0 flex-wrap items-center gap-1 text-xs text-subtle" aria-label="Opened from">
            <button
              className="btn btn-ghost btn-sm -ml-2"
              onClick={() => navigate(-1)}
              title={`Back to “${flowName(trail[trail.length - 1].flowId) ?? "the previous flow"}”${
                trail[trail.length - 1].step ? ` at ${trail[trail.length - 1].step}` : ""
              }`}
            >
              <ArrowLeft size={13} /> Back
            </button>
            {trail.map((t, i) => (
              <Fragment key={i}>
                <button
                  className="max-w-[320px] truncate rounded px-1 hover:text-fg hover:underline"
                  onClick={() => navigate(-(trail.length - i))}
                  title={t.step ? `Back to ${t.step}` : undefined}
                >
                  {flowName(t.flowId) ?? t.flowId}
                  {t.step && <span className="text-subtle"> · {t.step}</span>}
                </button>
                <span aria-hidden="true">›</span>
              </Fragment>
            ))}
            <span className="max-w-[320px] truncate px-1 text-muted" aria-current="page">
              {flow.name || "(no name)"}
            </span>
          </nav>
        )}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn btn-ghost btn-sm btn-icon -ml-2 shrink-0"
                onClick={toggleDetails}
                aria-expanded={detailsOpen}
                aria-label={detailsOpen ? "Collapse flow details" : "Expand flow details"}
                title={detailsOpen ? "Collapse flow details" : "Expand flow details"}
              >
                <ChevronDown size={14} className={detailsOpen ? "" : "-rotate-90"} />
              </button>
              <h2 className="line-clamp-2 min-w-0 text-lg font-semibold tracking-tight [overflow-wrap:anywhere]" title={flow.name}>
                {flow.name || "(no name)"}
              </h2>
              <span className={`badge badge-dot ${stateBadge(flow)}`}>{flow.state === 1 ? "On" : flow.stateLabel}</span>
              <span className="badge badge-neutral">{flow.managed ? "managed" : "unmanaged"}</span>
            </div>
            {detailsOpen && (
              <p className="mt-0.5 text-sm text-muted short:truncate">
                {flow.owner || "Unknown owner"} · modified {time(flow.modifiedOn)}
                {flow.modifiedBy && ` by ${flow.modifiedBy}`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <AddToTask connId={connId} flow={flow} />
            <button className="btn btn-secondary" disabled={!definition} onClick={() => copy(definition ?? "", "definition")}>
              <Copy size={14} /> Copy JSON
            </button>
            <button className="btn btn-ghost" onClick={() => copy(flow.id, "flow id")} title={flow.id}>
              <Copy size={14} /> Copy id
            </button>
          </div>
        </div>

        {detailsOpen && (
          <>
          {flow.description && <p className="mt-3 line-clamp-3 max-w-3xl text-sm text-muted short:line-clamp-1" title={flow.description}>{flow.description}</p>}

          {(flow.solutions.length > 0 || children.length > 0 || callable || !!callers?.length) && (
            <div className="mt-3 space-y-1.5">
              {flow.solutions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="eyebrow w-[76px] shrink-0">Solutions</span>
                  {flow.solutions.map((s) => (
                    <span key={s} className="badge badge-neutral">
                      {s}
                    </span>
                  ))}
                </div>
              )}
              {children.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="eyebrow w-[76px] shrink-0" title="Child flows this flow runs">
                    Calls
                  </span>
                  {children.map((id) => (
                    <FlowChip key={id} id={id} name={flowName(id)} onOpen={(c) => void openFlow(c, callerStep(c))} />
                  ))}
                </div>
              )}
              {(callable || !!callers?.length) && (
                <div className="flex min-h-[26px] flex-wrap items-center gap-1.5">
                  <span className="eyebrow w-[76px] shrink-0" title="Flows that run this one as a child flow">
                    Called by
                  </span>
                  {callers ? (
                    callers.length ? (
                      callers.map((id) => <FlowChip key={id} id={id} name={flowName(id)} onOpen={(c) => void openFlow(c)} />)
                    ) : (
                      <span className="text-xs text-subtle">No flow in this environment runs it</span>
                    )
                  ) : callsStatus === "loading" ? (
                    <span className="flex items-center gap-1.5 text-xs text-subtle" role="status">
                      <Loader size={12} className="text-brand" /> Reading every flow…
                    </span>
                  ) : callsStatus === "error" ? (
                    <span className="flex items-center gap-2 text-xs">
                      <span className="text-warning" title={callsError}>
                        Couldn't read the flows.
                      </span>
                      <button className="btn btn-ghost btn-sm" onClick={() => loadCalls(connId)}>
                        <Refresh size={12} /> Retry
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn btn-ghost btn-sm -ml-1.5"
                      onClick={() => loadCalls(connId)}
                      title="Reads the definition of every flow in this environment once, then answers for all of them"
                    >
                      <Search size={12} /> Find parent flows
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* A short window needs the room for the designer, which shows all of this too; Runs needs it for the steps. */}
          <div className={`card mt-5 grid grid-cols-3 divide-x divide-line short:hidden ${tab === "runs" ? "hidden" : ""}`}>
            <Stat label="Trigger">
              {pending ? (
                <div className="skeleton mt-1 h-3 w-32" />
              ) : !summary || summary.triggers.length === 0 ? (
                <span className="text-subtle">—</span>
              ) : (
                summary.triggers.map((t) => (
                  <div key={t.name} className="truncate" title={`${t.name} (${t.type})`}>
                    {t.name}
                    {t.type && t.type.toLowerCase() !== t.name.toLowerCase() && (
                      <span className="ml-1.5 text-xs text-subtle">{t.type}</span>
                    )}
                  </div>
                ))
              )}
            </Stat>
            <Stat label="Actions">
              {pending ? (
                <div className="skeleton mt-1 h-3 w-10" />
              ) : !summary ? (
                <span className="text-subtle">—</span>
              ) : (
                <span className="tabular-nums">{summary.actionCount}</span>
              )}
            </Stat>
            <Stat label="Connectors">
              {pending ? (
                <div className="skeleton mt-1 h-3 w-24" />
              ) : !summary ? (
                <span className="text-subtle">—</span>
              ) : summary.connectors.length === 0 ? (
                <span className="text-subtle">None</span>
              ) : (
                <div className="truncate font-mono text-[12.5px]" title={summary.connectors.join(", ")}>
                  {summary.connectors.join(", ")}
                </div>
              )}
            </Stat>
          </div>
          </>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-end gap-1 border-t border-b border-line bg-s1 px-4" role="tablist" aria-label="Definition view">
        {(
          [
            ["json", "JSON"],
            ["designer", "Designer"],
            ["analysis", "Analysis"],
            ["runs", "Runs"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className="tab h-9"
            onClick={() => setTab(key)}
          >
            {label}
            {key === "analysis" && analysis?.result && (
              <span
                className={`badge ${GRADE_BADGE[analysis.result.score.grade]} ml-1.5 !px-1.5`}
                title={`Grade ${analysis.result.score.grade} (${analysis.result.score.overall} / 100)`}
              >
                {analysis.result.score.grade}
              </span>
            )}
            {key === "runs" && runFailures > 0 && (
              <span className="badge badge-danger ml-1.5 !px-1.5 tabular-nums" title={`${runFailures} failed runs`}>
                {runFailures.toLocaleString()}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "runs" && (
        <div className="min-h-0 flex-1">
          <FlowRunsTab connId={connId} flow={flow} runId={runId} onRun={(id) => setUrl("runs", id)} />
        </div>
      )}
      <div className={`min-h-0 flex-1 ${tab === "runs" ? "hidden" : ""}`} style={{ background: "var(--editor-bg)" }}>
        {definitionError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
            <AlertTriangle size={18} className="text-warning" />
            <div className="font-medium">Couldn't load the definition</div>
            <div className="max-w-xl break-words text-xs text-subtle">{definitionError}</div>
          </div>
        ) : definition === undefined ? (
          <div className="space-y-2 p-6">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="skeleton h-3" style={{ width: `${30 + ((i * 37) % 50)}%` }} />
            ))}
          </div>
        ) : (
          <>
            {tab === "designer" && outline && (
              <FlowDesigner
                connId={connId}
                flowId={flow.id}
                outline={outline}
                selectedId={step}
                onSelect={setStep}
                flowName={flowName}
                onOpenFlow={(id, from) => void openFlow(id, from)}
                childFlow={childFlow}
                onShowInJson={(node) => {
                  // A step of a child flow shown inline: its own flow has its JSON.
                  if (node.origin) {
                    void openFlow(node.origin.flowId, node.id, { step: node.origin.id, tab: "json" });
                    return;
                  }
                  setStep(node.id);
                  setTab("json");
                }}
                theme={theme}
              />
            )}
            {tab === "analysis" && (
              <FlowAnalysisPane
                analysis={analysis?.result ?? null}
                error={analysis?.error ?? null}
                onShowStep={(name) => {
                  const node = [...stepsById.values()].find((n) => n.key === name);
                  if (node) setStep(node.id);
                  setTab("designer");
                }}
              />
            )}
            {tab === "designer" && !outline && (
              <div className="flex h-full items-center justify-center text-sm text-subtle">
                This definition isn't a cloud flow the designer can draw. Use the JSON tab.
              </div>
            )}
            {/* Kept mounted (hidden) so the editor keeps its state. */}
            <div className={`${tab === "json" ? "" : "hidden"} h-full ${outline ? "grid grid-cols-[clamp(200px,30%,300px)_minmax(0,1fr)]" : ""}`}>
              {outline && (
                <div className="min-h-0 border-r border-line bg-s1">
                  <FlowOutline
                    nodes={outline}
                    selectedId={step}
                    onSelect={reveal}
                    flowName={flowName}
                    onOpenFlow={(id, from) => void openFlow(id, from)}
                  />
                </div>
              )}
              <div className="min-h-0">
                <Editor
                  height="100%"
                  language="json"
                  path={`flow-${flow.id}.json`}
                  value={definition}
                  onMount={onMount}
                  theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
                  options={{
                    readOnly: true,
                    domReadOnly: true,
                    fontSize: 13,
                    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace",
                    fontLigatures: false,
                    lineHeight: 20,
                    lineNumbersMinChars: 4,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    padding: { top: 12, bottom: 12 },
                    renderLineHighlight: "none",
                    automaticLayout: true,
                    tabSize: 2,
                    folding: true,
                    wordWrap: "off",
                    // Rainbow brackets clash with the app theme on bracket-heavy JSON.
                    bracketPairColorization: { enabled: false },
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}
