// Pieces shared by the flow run views (Flows › Runs tab, Flow runs monitor):
// a run row, a run's detail, the runs-per-slot chart.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useStore } from "../store";
import { definitionKey, useFlows } from "../lib/flows";
import { buildOutline, type ChildFlow, type OutlineNode } from "../lib/flowOutline";
import { api } from "../api";
import { flowRoute } from "../lib/navigation";
import { formatDuration, logTime } from "../lib/pagedStore";
import {
  OUTCOME_BADGE,
  OUTCOME_DOT,
  OUTCOME_LABEL,
  RUN_RANGES,
  RUN_STATUSES,
  errorText,
  failRate,
  flowRunFiltersOf,
  rangeLabel,
  runSince,
  runDuration,
  childRuns,
  runByName,
  runSummaries,
  useFlowRuns,
  checkRunAccess,
  useRunAccess,
  STEP_DOT,
  byteSize,
  errorGist,
  firstFailure,
  isTokenDenial,
  repetitionsKey,
  runSteps,
  runStepsById,
  stepContent,
  stepDuration,
  stepLines,
  stepRepetitions,
  stepTone,
  stepsKey,
  useFlowApiAccess,
  type Bar,
  type RunRange,
  type RunStatusFilter,
  type StepLine,
} from "../lib/flowRuns";
import { IdList, ListSkeleton } from "./LogParts";
import { Collapse } from "./Collapse";
import { JsonView, parseJson } from "./JsonView";
import { MAX_RUNS, searchOf, useRunSearch, type SearchWindow } from "../lib/runSearch";
import { FlowDesigner } from "./FlowDesigner";
import { StepIcon } from "./StepIcon";
import { Modal } from "./Modals";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Clock,
  Copy,
  Info,
  Loader,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Refresh,
  Search,
  Shield,
  X,
} from "./Icon";
import type { FlowMeta, RunReadDepth, RunRow, RunSearchScope, RunStep } from "../types";

/** A run in a list: status dot, time, duration, the error's first line. */
export function RunItem({
  row,
  selected,
  onOpen,
  showFlow,
}: {
  row: RunRow;
  selected: boolean;
  onOpen: () => void;
  /** Name the flow (lists of several flows). */
  showFlow?: string | null;
}) {
  const duration = runDuration(row);
  return (
    <button
      role="option"
      aria-selected={selected}
      aria-current={selected ? "page" : undefined}
      tabIndex={selected ? 0 : -1}
      className="nav-item nav-item-tall !items-start"
      onClick={onOpen}
      title={row.runName}
    >
      <span
        className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${OUTCOME_DOT[row.outcome]} ${row.outcome === "running" ? "animate-pulse" : ""}`}
        aria-label={row.status || OUTCOME_LABEL[row.outcome]}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {showFlow !== undefined ? showFlow || row.flowName || "(unknown flow)" : row.status || OUTCOME_LABEL[row.outcome]}
          </span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-subtle">{logTime(row.startTime)}</span>
        </span>
        <span className="block truncate text-xs font-normal text-subtle">
          {[
            showFlow !== undefined ? row.status || OUTCOME_LABEL[row.outcome] : null,
            row.parentRunId ? "child run" : row.triggerType,
            duration !== null ? formatDuration(duration) : null,
            row.errorCode,
          ]
            .filter(Boolean)
            .join(" · ") || "—"}
        </span>
      </span>
    </button>
  );
}

/** Where a run sits among child flows: the run that started it, the runs it started. */
export function RunFamily({ connId, row }: { connId: string; row: RunRow }) {
  const navigate = useNavigate();
  const flows = useFlows((s) => s.lists[connId]?.flows);
  const nameOf = (id: string | null) => (id ? flows?.find((f) => f.id.toLowerCase() === id)?.name ?? null : null);
  const parent = runByName.useEntry(row.parentRunId ? connId : null, row.parentRunId ?? "");
  const children = childRuns.useEntry(row.runName ? connId : null, row.runName);
  const goTo = (r: RunRow) => r.flowId && navigate(`${flowRoute(r.flowId)}?${new URLSearchParams({ tab: "runs", run: r.id })}`);
  const pushToast = useStore((s) => s.pushToast);
  const copyText = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what.toLowerCase()}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what.toLowerCase()}` }));

  // Flows that run this one, for when the parent run isn't in Dataverse.
  const calls = useFlows((s) => s.calls[connId]);
  const callsStatus = useFlows((s) => s.callsStatus[connId]);
  const loadCalls = useFlows((s) => s.loadCalls);
  const callers = row.flowId && calls ? [...new Set(calls.filter((c) => c.child === row.flowId).map((c) => c.parent))] : null;

  const line = (r: RunRow, label: string) => (
    <div className="flex min-w-0 items-center gap-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${OUTCOME_DOT[r.outcome]}`} aria-label={r.status} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{nameOf(r.flowId) ?? r.flowName ?? "(unknown flow)"}</span>
        <span className="text-subtle">
          {" "}
          · {r.status || OUTCOME_LABEL[r.outcome]} · {logTime(r.startTime)}
        </span>
      </span>
      {r.flowId && nameOf(r.flowId) && (
        <button className="btn btn-ghost btn-sm shrink-0" onClick={() => goTo(r)} title={`Open this run of “${nameOf(r.flowId)}”`}>
          {label}
        </button>
      )}
    </div>
  );

  return (
    <>
      {row.parentRunId && (
        <div className="mt-4 rounded-lg border border-line bg-s2 px-3 py-2.5 text-xs">
          <div className="eyebrow mb-1.5">Started by (parent run)</div>
          {parent.loading ? (
            <div className="flex items-center gap-1.5 text-subtle" role="status">
              <Loader size={12} className="text-brand" /> Finding the parent run…
            </div>
          ) : parent.data ? (
            <>
              {line(parent.data, "Go to parent run")}
              <IdList
                ids={[
                  ["Parent flow id", parent.data.flowId],
                  ["Parent run id", parent.data.runName],
                ]}
                onCopy={(v, label) => copyText(v, label)}
              />
              {parent.data.parentRunId && (
                <div className="mt-1.5 text-subtle">The parent is a child run too: go to it to climb further.</div>
              )}
            </>
          ) : (
            <div className="space-y-1.5">
              <div className="text-muted">
                {parent.error ? (
                  <span className="text-warning">Couldn't look it up: {parent.error}</span>
                ) : (
                  <>
                    Run <span className="font-mono">{row.parentRunId}</span> isn't in Dataverse: it's older than the run history kept, or the parent
                    flow isn't in a solution.
                  </>
                )}
              </div>
              {callers ? (
                callers.length ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-subtle">Flows that run this one:</span>
                    {callers.map((id) => (
                      <button key={id} className="badge badge-brand gap-1 hover:underline" onClick={() => navigate(`${flowRoute(id)}?tab=runs`)}>
                        {nameOf(id) ?? `${id.slice(0, 8)}…`} <ArrowUpRight size={11} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="text-subtle">No flow in this environment runs this one.</div>
                )
              ) : (
                <button className="btn btn-ghost btn-sm -ml-1.5" onClick={() => loadCalls(connId)} disabled={callsStatus === "loading"}>
                  {callsStatus === "loading" ? <Loader size={12} /> : <Search size={12} />} Find the flows that run this one
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {!!children.data?.length && (
        <div className="mt-4 rounded-lg border border-line bg-s2 px-3 py-2.5 text-xs">
          <div className="eyebrow mb-1.5">
            Child runs ({children.data.length}
            {children.data.length >= 100 ? "+" : ""})
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {children.data.map((c) => (
              <div key={c.id}>{line(c, "Open")}</div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * One run: a compact header (outcome, when, the error on one line, details on
 * demand) above its steps, which fill the rest.
 */
export function RunDetail({
  connId,
  row,
  focusStep,
  listHidden,
  onToggleList,
}: {
  connId: string;
  row: RunRow;
  /** Step to show first (by its name), e.g. where a search found its value. */
  focusStep?: string | null;
  /** The run list beside it is hidden (more room for the steps). */
  listHidden?: boolean;
  onToggleList?: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const running = row.outcome === "running";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const duration = runDuration(row, now);
  const [details, setDetails] = useState(false);
  const [fullError, setFullError] = useState(false);
  const children = childRuns.useEntry(row.runName ? connId : null, row.runName);
  const childCount = children.data?.length ?? 0;
  const openInPortal = useOpenInPortal(connId, row.flowId ?? "", row.runName);

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);
  const hasError = !!(row.errorCode || row.errorMessage);
  const gist = errorGist(row.errorMessage);
  // Only when the full error says more than its first line.
  const expandable = !!row.errorMessage && errorText(row.errorMessage).trim() !== (gist ?? "").trim();

  return (
    <div className="fade-in flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line bg-s1 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {onToggleList && (
            <button
              className="btn btn-ghost btn-icon btn-sm shrink-0"
              onClick={onToggleList}
              title={listHidden ? "Show the run list" : "Hide the run list (more room for the steps)"}
              aria-label={listHidden ? "Show the run list" : "Hide the run list"}
            >
              {listHidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          )}
          <span className={`badge badge-dot shrink-0 ${OUTCOME_BADGE[row.outcome]}`}>{row.status || OUTCOME_LABEL[row.outcome]}</span>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-[14px] font-semibold tabular-nums">
              {row.startTime ? new Date(row.startTime).toLocaleString() : "Start time unknown"}
            </span>
            <span className="flex shrink-0 items-center text-xs text-muted">
              {duration !== null ? formatDuration(duration) : running ? "running" : ""}
              {running && <Loader size={11} className="ml-1 text-info" />}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {row.runName && (
              <button className="btn btn-ghost btn-sm" onClick={() => copy(row.runName, "run id")} title={`Copy the run id (${row.runName})`}>
                <Copy size={12} /> Run id
              </button>
            )}
            {row.flowId && row.runName && (
              <button className="btn btn-ghost btn-sm" onClick={openInPortal} title="Open this run in Power Automate (in the browser)">
                <ArrowUpRight size={12} /> Power Automate
              </button>
            )}
            <button
              className={`btn btn-sm ${details ? "btn-secondary" : "btn-ghost"}`}
              onClick={() => setDetails((v) => !v)}
              aria-expanded={details}
              title="Times, owner, ids, parent and child runs"
            >
              <Info size={12} /> Details
            </button>
          </div>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-0.5 text-xs text-subtle">
          {[row.triggerType, row.owner || null].filter(Boolean).map((t, i) => (
            <span key={i} className="after:ml-2 after:content-['·'] last:after:hidden">
              {t}
            </span>
          ))}
          {row.parentRunId && (
            <button className="text-brand hover:underline" onClick={() => setDetails(true)}>
              Child run · show the parent run
            </button>
          )}
          {childCount > 0 && (
            <button className="text-brand hover:underline" onClick={() => setDetails(true)}>
              Started {childCount}
              {childCount >= 100 ? "+" : ""} child run{childCount === 1 ? "" : "s"}
            </button>
          )}
        </div>

        {hasError && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10">
            <div className="flex items-start gap-2 px-2.5 py-1.5">
              <AlertTriangle size={13} className="mt-[3px] shrink-0 text-danger" />
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => expandable && setFullError((v) => !v)}
                aria-expanded={expandable ? fullError : undefined}
                title={expandable ? (fullError ? "Hide the full error" : "Show the full error") : undefined}
              >
                <span className={`block text-[12.5px] leading-5 ${fullError ? "" : "truncate"}`}>
                  {row.errorCode && <span className="mr-1.5 font-mono text-[11.5px] text-danger">{row.errorCode}</span>}
                  {gist}
                </span>
              </button>
              {row.errorMessage && (
                <>
                  <button className="btn btn-ghost btn-icon btn-sm shrink-0" onClick={() => copy(row.errorMessage!, "error message")} title="Copy the error">
                    <Copy size={12} />
                  </button>
                  {expandable && (
                    <button
                      className="btn btn-ghost btn-icon btn-sm shrink-0"
                      onClick={() => setFullError((v) => !v)}
                      aria-label={fullError ? "Hide the full error" : "Show the full error"}
                    >
                      <ChevronDown size={13} className={`transition-transform ${fullError ? "rotate-180" : ""}`} />
                    </button>
                  )}
                </>
              )}
            </div>
            {expandable && row.errorMessage && (
              <Collapse open={fullError}>
                <pre className="max-h-[28vh] overflow-auto whitespace-pre-wrap break-words border-t border-danger/20 px-3 py-2 font-mono text-[12px] leading-5 text-fg">
                  {errorText(row.errorMessage)}
                </pre>
              </Collapse>
            )}
          </div>
        )}

        <Collapse open={details} className="pt-2">
          <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-line bg-s2 px-3 py-2.5">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
              {(
                [
                  ["Started", when(row.startTime), null],
                  ["Ended", when(row.endTime), null],
                  ["Owner", row.owner || null, null],
                  ["Run", row.runName || null, "run id"],
                  ["Parent run", row.parentRunId, "parent run id"],
                  ["Record id", row.id, "flowrun id"],
                ] as const
              ).map(([label, value, copyAs]) =>
                value ? (
                  <div key={label} className="contents">
                    <dt className="eyebrow leading-5">{label}</dt>
                    <dd className="min-w-0 truncate leading-5">
                      {copyAs ? (
                        <button className="font-mono text-muted hover:text-fg hover:underline" onClick={() => copy(value, copyAs)} title="Copy">
                          {value}
                        </button>
                      ) : (
                        <span className="text-muted">{value}</span>
                      )}
                    </dd>
                  </div>
                ) : null
              )}
            </dl>
            <RunFamily connId={connId} row={row} />
          </div>
        </Collapse>
      </header>

      {row.flowId && row.runName ? (
        <RunStepsSection connId={connId} flowId={row.flowId} runName={row.runName} running={running} focusStep={focusStep ?? null} />
      ) : (
        <p className="px-5 py-4 text-xs text-subtle">Dataverse didn't say which flow ran, so its steps can't be read.</p>
      )}
    </div>
  );
}

/** Opens the run in the Power Automate portal. */
function useOpenInPortal(connId: string, flowId: string, runName: string) {
  const pushToast = useStore((s) => s.pushToast);
  return () =>
    api.openFlowRun(connId, flowId, runName).catch((e) => pushToast({ tone: "error", title: "Couldn't open the run", body: String(e) }));
}

/** A run's trigger and actions from the Power Automate API, filling the space under the run's header. */
function RunStepsSection({
  connId,
  flowId,
  runName,
  running,
  focusStep,
}: {
  connId: string;
  flowId: string;
  runName: string;
  running: boolean;
  /** Step to show first instead of the first failure. */
  focusStep: string | null;
}) {
  const theme = useStore((s) => s.theme);
  const steps = runSteps.useEntry(connId, stepsKey(flowId, runName));
  // A failed re-read hides what was read before.
  const data = steps.error ? undefined : steps.data;
  const denied = useFlowApiAccess((s) => s.denied[connId]);
  const openInPortal = useOpenInPortal(connId, flowId, runName);

  // The flow's definition, when Flows already read it: steps in its order, nested.
  const flows = useFlows((s) => s.lists[connId]?.flows);
  const flowMetaId = flows?.find((f) => f.id.toLowerCase() === flowId)?.id ?? flowId;
  const definitionError = useFlows((s) => s.definitionErrors[definitionKey(connId, flowMetaId)]);
  const definition = useFlows((s) => s.definitions[definitionKey(connId, flowMetaId)]);
  const loadDefinition = useFlows((s) => s.loadDefinition);
  const outline = useMemo(() => (definition ? buildOutline(definition) : null), [definition]);
  const lines = useMemo(() => (data ? stepLines(data, outline) : []), [data, outline]);
  const byId = useMemo(() => (data && outline ? runStepsById(data, outline) : null), [data, outline]);

  const [view, setView] = useState<StepsView>(readStepsView);
  const pickView = (v: StepsView) => {
    setView(v);
    try {
      localStorage.setItem(STEPS_VIEW_KEY, v);
    } catch {
      // Only a convenience.
    }
  };
  // The diagram is drawn from the definition: read it if Flows hasn't yet.
  useEffect(() => {
    if (view === "diagram" && definition === undefined && !definitionError) loadDefinition(connId, flowMetaId);
  }, [view, definition, definitionError, connId, flowMetaId, loadDefinition]);
  const diagram = view === "diagram" && !!outline && !!byId;
  const waitingForDefinition = view === "diagram" && definition === undefined && !definitionError;

  const [onlyFailed, setOnlyFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The step picked on the diagram (an outline id).
  const [picked, setPicked] = useState<string | null>(null);
  // Opens the step to look at first, once the steps are read (and placed on the diagram):
  // the one asked for, else the first failure.
  const opened = useRef(false);
  useEffect(() => {
    opened.current = false;
  }, [focusStep]);
  useEffect(() => {
    if (opened.current || !lines.length || (view === "diagram" && !outline && waitingForDefinition)) return;
    opened.current = true;
    const asked = focusStep ? lines.find((l) => l.kind === "step" && l.step.name === focusStep) : undefined;
    const first = asked?.kind === "step" ? asked.step : firstFailure(lines);
    if (!first) return;
    setOpen(new Set([first.name]));
    const line = lines.find((l) => l.kind === "step" && l.step === first);
    if (line?.kind === "step" && line.node) setPicked(line.node.id);
  }, [lines, view, outline, waitingForDefinition, focusStep]);
  const toggle = (name: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const stepCount = lines.filter((l) => l.kind === "step").length;
  const isFailed = (l: StepLine) => l.kind === "step" && stepTone(l.step.status) === "failed";
  const failedCount = lines.filter(isFailed).length;
  const shown = onlyFailed ? lines.filter(isFailed) : lines;

  const centered = (children: React.ReactNode) => <div className="flex h-full items-start justify-center overflow-y-auto p-5">{children}</div>;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Steps">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-1.5">
        <h3 className="eyebrow">Steps</h3>
        {data && (
          <span className="text-xs text-subtle">
            {stepCount} step{stepCount === 1 ? "" : "s"}
            {failedCount > 0 && <span className="text-danger"> · {failedCount} failed</span>}
          </span>
        )}
        {data?.truncated && <span className="text-xs text-warning">only the first steps were read</span>}
        <span className="flex-1" />
        {data && failedCount > 0 && view === "list" && (
          <div className="seg" role="group" aria-label="Which steps">
            <button aria-pressed={!onlyFailed} onClick={() => setOnlyFailed(false)}>
              All
            </button>
            <button aria-pressed={onlyFailed} onClick={() => setOnlyFailed(true)}>
              Failed
            </button>
          </div>
        )}
        <div className="seg" role="group" aria-label="Show steps as">
          <button aria-pressed={view === "diagram"} onClick={() => pickView("diagram")} title="Draw the run on the flow's designer">
            Diagram
          </button>
          <button aria-pressed={view === "list"} onClick={() => pickView("list")} title="One line per step">
            List
          </button>
        </div>
        <button
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => {
            opened.current = false;
            steps.reload();
          }}
          disabled={steps.loading}
          title={running ? "The run is still going: read its steps again" : "Read the steps again"}
          aria-label="Read the steps again"
        >
          <Refresh size={13} className={steps.loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {(steps.loading && !data) || (data && !diagram && waitingForDefinition) ? (
          centered(
            <div className="mt-10 flex items-center gap-2 text-sm text-subtle" role="status">
              <Loader size={14} className="text-brand" />
              {steps.loading && !data ? "Reading the run's steps from Power Automate…" : "Reading the flow's definition…"}
            </div>
          )
        ) : steps.error && denied ? (
          centered(
            <div className="w-full max-w-xl">
              <FlowApiDenied reason={denied} onOpen={openInPortal} />
            </div>
          )
        ) : steps.error ? (
          centered(
            <div className="w-full max-w-xl rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs">
              <div className="font-medium text-warning">Couldn't read the steps</div>
              <div className="mt-1 break-words text-muted">{steps.error}</div>
              {steps.error.includes("(404") && (
                <div className="mt-1 text-subtle">Power Automate keeps run details for 28 days; older runs only have their outcome in Dataverse.</div>
              )}
              <button className="btn btn-secondary btn-sm mt-2" onClick={() => steps.reload()}>
                <Refresh size={12} /> Retry
              </button>
            </div>
          )
        ) : data && diagram ? (
          <div className="absolute inset-0">
            <FlowDesigner
              connId={connId}
              flowId={flowMetaId}
              outline={outline!}
              selectedId={picked}
              onSelect={setPicked}
              flowName={(id) => flows?.find((f) => f.id.toLowerCase() === id)?.name ?? null}
              onOpenFlow={() => {}}
              childFlow={noChildFlow}
              onShowInJson={() => {}}
              theme={theme}
              run={{
                steps: byId!,
                panel: (node) => (
                  <RunStepPanel
                    key={node.id}
                    connId={connId}
                    flowId={flowId}
                    runName={runName}
                    node={node}
                    step={byId!.get(node.id) ?? null}
                    onClose={() => setPicked(null)}
                  />
                ),
              }}
            />
          </div>
        ) : data ? (
          <div className="h-full overflow-y-auto px-4 py-3">
            {view === "diagram" && (
              <div className="mb-2 text-xs text-subtle">
                {definitionError ? `Couldn't read the flow's definition (${definitionError}): showing the steps as a list.` : "Showing the steps as a list."}
              </div>
            )}
            <ul className="overflow-hidden rounded-lg border border-line">
              {shown.map((l, i) =>
                l.kind === "branch" ? (
                  <li
                    key={`b${i}`}
                    className="border-t border-line bg-s2 py-1 text-[11px] font-medium uppercase tracking-wide text-subtle first:border-t-0"
                    style={{ paddingLeft: 12 + l.depth * 16 }}
                  >
                    {l.label}
                  </li>
                ) : (
                  <StepItem
                    key={l.step.name}
                    connId={connId}
                    flowId={flowId}
                    runName={runName}
                    line={l}
                    flat={onlyFailed}
                    open={open.has(l.step.name)}
                    onToggle={() => toggle(l.step.name)}
                  />
                )
              )}
              {!shown.length && <li className="px-3 py-4 text-center text-xs text-subtle">No steps.</li>}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

type StepsView = "diagram" | "list";
const STEPS_VIEW_KEY = "cds.runSteps.view";

function readStepsView(): StepsView {
  try {
    return localStorage.getItem(STEPS_VIEW_KEY) === "list" ? "list" : "diagram";
  } catch {
    return "diagram";
  }
}

/** The diagram of a run doesn't open child flows inside their steps. */
const noChildFlow = (): ChildFlow => ({ status: "missing" });

/** The diagram's side panel: the picked step's result in this run. */
function RunStepPanel({
  connId,
  flowId,
  runName,
  node,
  step,
  onClose,
}: {
  connId: string;
  flowId: string;
  runName: string;
  node: OutlineNode;
  step: RunStep | null;
  onClose: () => void;
}) {
  const tone = step ? stepTone(step.status) : null;
  const duration = step ? stepDuration(step) : null;
  return (
    <aside
      className="flex h-full min-h-0 w-[400px] shrink-0 flex-col border-l border-line bg-s1 @max-3xl/designer:absolute @max-3xl/designer:inset-y-0 @max-3xl/designer:right-0 @max-3xl/designer:z-10 @max-3xl/designer:w-[min(400px,calc(100%-40px))] @max-3xl/designer:shadow-lg"
      aria-label={`Step ${node.name} in this run`}
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
        <StepIcon step={node} size={34} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-snug break-words">{node.name}</div>
          <div className="mt-0.5 truncate text-xs text-subtle">{[node.type, node.detail].filter(Boolean).join(" · ")}</div>
        </div>
        <button className="btn btn-ghost btn-icon btn-sm shrink-0" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {step ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
              <span className={`badge badge-dot ${tone === "failed" ? "badge-danger" : tone === "succeeded" ? "badge-success" : tone === "running" ? "badge-info" : tone === "cancelled" ? "badge-warning" : "badge-neutral"}`}>
                {step.status || "—"}
              </span>
              {step.code && step.code !== step.status && <span>{step.code}</span>}
              {step.startTime && <span>started {clock(step.startTime)}</span>}
              {duration !== null && tone !== "skipped" && <span>took {formatDuration(duration)}</span>}
            </div>
            {(step.repetitionCount ?? 0) > 0 ? (
              <Repetitions connId={connId} flowId={flowId} runName={runName} step={step} />
            ) : (
              <StepDetail connId={connId} step={step} />
            )}
          </>
        ) : (
          <div className="text-xs text-subtle">
            {node.kind === "branch" ? "" : "This step has no result in this run: it didn't run, or the flow changed since."}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Power Automate won't let this account read the run's steps. */
function FlowApiDenied({ reason, onOpen }: { reason: string; onOpen: () => void }) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-warning">
        <Shield size={13} /> No access to this run's steps
      </div>
      <div className="mt-1 leading-relaxed text-muted">
        {isTokenDenial(reason)
          ? "Your organization doesn't let this app sign in to Power Automate for this account (usually a Conditional Access policy)."
          : "Power Automate doesn't let this account read this flow's runs: it has to own or co-own the flow, or be an admin of the environment."}{" "}
        The run's outcome above still comes from Dataverse.
      </div>
      <div className="mt-1.5 break-words font-mono text-[11.5px] text-subtle">{reason}</div>
      <button className="btn btn-secondary btn-sm mt-2" onClick={onOpen}>
        <ArrowUpRight size={12} /> Open in Power Automate
      </button>
    </div>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** One step: a row that opens to its error, inputs and outputs (per repetition in a loop). */
function StepItem({
  connId,
  flowId,
  runName,
  line,
  flat,
  open,
  onToggle,
}: {
  connId: string;
  flowId: string;
  runName: string;
  line: Extract<StepLine, { kind: "step" }>;
  /** No nesting (the Failed filter). */
  flat: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { step } = line;
  const tone = stepTone(step.status);
  const duration = stepDuration(step);
  const looped = (step.repetitionCount ?? 0) > 0;
  const indent = flat ? 0 : line.depth * 16;
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        className={`flex w-full items-start gap-2 py-1.5 pr-3 text-left hover:bg-s2 ${open ? "bg-s2" : ""} ${tone === "skipped" ? "opacity-60" : ""}`}
        style={{ paddingLeft: 8 + indent }}
        onClick={onToggle}
        aria-expanded={open}
      >
        <ChevronDown size={12} className={`mt-[3px] shrink-0 text-subtle transition-transform ${open ? "" : "-rotate-90"}`} />
        <span
          className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${STEP_DOT[tone]} ${tone === "running" ? "animate-pulse" : ""}`}
          aria-label={step.status}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`min-w-0 truncate text-[13px] ${tone === "failed" ? "font-medium text-danger" : ""}`}>{line.label}</span>
            {line.type && <span className="min-w-0 shrink truncate text-[11px] text-subtle">{line.type}</span>}
            <span className="flex-1" />
            {looped && <span className="badge badge-neutral shrink-0">×{step.repetitionCount}</span>}
            <span className="shrink-0 text-[11px] tabular-nums text-subtle">
              {tone === "skipped" ? "Skipped" : duration !== null ? formatDuration(duration) : step.status}
            </span>
          </span>
          {tone === "failed" && step.errorMessage && !open && (
            <span className="block truncate text-xs text-subtle">{errorGist(step.errorMessage)}</span>
          )}
        </span>
      </button>
      <Collapse open={open}>
        <div className="space-y-2 border-t border-line bg-s1 py-2.5 pr-3" style={{ paddingLeft: 30 + indent }}>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-subtle">
            <span>
              <span className={tone === "failed" ? "text-danger" : ""}>{step.status || "—"}</span>
              {step.code && step.code !== step.status && <> · {step.code}</>}
            </span>
            {step.startTime && <span>started {clock(step.startTime)}</span>}
            {duration !== null && <span>took {formatDuration(duration)}</span>}
            <span className="font-mono">{step.name}</span>
          </div>
          {looped ? <Repetitions connId={connId} flowId={flowId} runName={runName} step={step} /> : <StepDetail connId={connId} step={step} />}
        </div>
      </Collapse>
    </li>
  );
}

/** A step's error, inputs and outputs. */
function StepDetail({ connId, step }: { connId: string; step: RunStep }) {
  return (
    <div className="space-y-2">
      {(step.errorCode || step.errorMessage) && (
        <ContentBlock title={step.errorCode || "Error"} tone="danger" text={step.errorMessage ? errorText(step.errorMessage) : ""} />
      )}
      {step.inputsLink && <LinkedContent connId={connId} title="Inputs" link={step.inputsLink} size={step.inputsSize} />}
      {step.outputsLink && <LinkedContent connId={connId} title="Outputs" link={step.outputsLink} size={step.outputsSize} />}
      {!step.inputsLink && !step.outputsLink && !step.errorMessage && (
        <div className="text-xs text-subtle">{stepTone(step.status) === "skipped" ? "It didn't run." : "No inputs or outputs recorded."}</div>
      )}
    </div>
  );
}

/** The repetitions of a step in a loop: pick one (the first failure to start with). */
function Repetitions({ connId, flowId, runName, step }: { connId: string; flowId: string; runName: string; step: RunStep }) {
  const reps = stepRepetitions.useEntry(connId, repetitionsKey(flowId, runName, step.name));
  const [picked, setPicked] = useState<string | null>(null);
  const list = reps.data ?? [];
  const current = list.find((r) => r.name === picked) ?? list.find((r) => stepTone(r.status) === "failed") ?? list[0] ?? null;
  const label = (r: RunStep) =>
    r.repetition.length ? r.repetition.map((x) => `${x.scopeName.replace(/_/g, " ")} #${x.itemIndex + 1}`).join(" › ") : r.name;

  if (reps.loading && !reps.data)
    return (
      <div className="flex items-center gap-1.5 text-xs text-subtle" role="status">
        <Loader size={12} className="text-brand" /> Reading {step.repetitionCount} repetitions…
      </div>
    );
  if (reps.error) return <div className="break-words text-xs text-warning">Couldn't read the repetitions: {reps.error}</div>;
  if (!current) return <div className="text-xs text-subtle">No repetitions recorded.</div>;
  const failed = list.filter((r) => stepTone(r.status) === "failed").length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className="input !h-7 max-w-full !px-2 !text-[12px]" value={current.name} onChange={(e) => setPicked(e.target.value)} aria-label="Repetition">
          {list.map((r) => (
            <option key={r.name} value={r.name}>
              {label(r)} · {r.status}
            </option>
          ))}
        </select>
        <span className="text-subtle">
          {list.length} repetition{list.length === 1 ? "" : "s"}
          {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
        </span>
      </div>
      <StepDetail key={current.name} connId={connId} step={current} />
    </div>
  );
}

/** Inputs or outputs, read from their link when shown. */
function LinkedContent({ connId, title, link, size }: { connId: string; title: string; link: string; size: number | null }) {
  const content = stepContent.useEntry(connId, link);
  return (
    <ContentBlock
      title={title}
      meta={byteSize(size)}
      text={content.data?.text ?? ""}
      truncated={content.data?.truncated}
      loading={content.loading && !content.data}
      error={content.error}
      onRetry={content.reload}
    />
  );
}

/** A titled block of text (error, inputs, outputs) with Copy. */
function ContentBlock({
  title,
  meta,
  text,
  tone,
  truncated,
  loading,
  error,
  onRetry,
}: {
  title: string;
  meta?: string | null;
  text: string;
  tone?: "danger";
  truncated?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  // JSON is shown as a tree (or pretty-printed), anything else as it came.
  const json = useMemo(() => (text ? parseJson(text) : undefined), [text]);
  const isJson = json !== undefined && json !== null && typeof json === "object";
  const pretty = useMemo(() => (isJson ? JSON.stringify(json, null, 2) : text), [isJson, json, text]);
  const [view, setView] = useState<JsonMode>(readJsonMode);
  // Expand all / Collapse all redraw the tree opened that deep.
  const [depth, setDepth] = useState<{ levels: number; n: number }>({ levels: 2, n: 0 });
  const pickView = (v: JsonMode) => {
    setView(v);
    try {
      localStorage.setItem(JSON_MODE_KEY, v);
    } catch {
      // Only a convenience.
    }
  };
  const copy = () =>
    navigator.clipboard
      .writeText(pretty)
      .then(() => pushToast({ tone: "success", title: `Copied ${title.toLowerCase()}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${title.toLowerCase()}` }));
  const danger = tone === "danger";
  const tree = isJson && view === "tree" && !loading && !error;
  return (
    <div className={`rounded-lg border ${danger ? "border-danger/30 bg-danger/10" : "border-line bg-s2"}`}>
      <div className={`flex items-center gap-1 border-b py-1 pl-3 pr-1 ${danger ? "border-danger/20" : "border-line"}`}>
        <span className={`min-w-0 flex-1 truncate text-xs font-medium ${danger ? "font-mono text-danger" : ""}`}>
          {title}
          {meta && <span className="ml-1.5 font-normal text-subtle">{meta}</span>}
        </span>
        {tree && (
          <>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              onClick={() => setDepth((d) => ({ levels: 99, n: d.n + 1 }))}
              title="Expand all"
              aria-label="Expand all"
            >
              <Plus size={13} />
            </button>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              onClick={() => setDepth((d) => ({ levels: 1, n: d.n + 1 }))}
              title="Collapse all"
              aria-label="Collapse all"
            >
              <Minus size={13} />
            </button>
          </>
        )}
        {isJson && !loading && !error && (
          <div className="seg !h-6 text-[11px]" role="group" aria-label="Show as">
            <button aria-pressed={view === "tree"} onClick={() => pickView("tree")}>
              Tree
            </button>
            <button aria-pressed={view === "raw"} onClick={() => pickView("raw")}>
              Raw
            </button>
          </div>
        )}
        {text && (
          <button className="btn btn-ghost btn-icon btn-sm" onClick={copy} title={`Copy ${title.toLowerCase()}`} aria-label={`Copy ${title.toLowerCase()}`}>
            <Copy size={12} />
          </button>
        )}
      </div>
      {loading ? (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-subtle" role="status">
          <Loader size={12} className="text-brand" /> Reading…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-warning">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {onRetry && (
            <button className="btn btn-ghost btn-sm shrink-0" onClick={onRetry}>
              <Refresh size={12} /> Retry
            </button>
          )}
        </div>
      ) : tree ? (
        <div className="max-h-[50vh] overflow-auto px-2 py-2">
          <JsonView key={depth.n} value={json} depth={depth.levels} />
        </div>
      ) : text ? (
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-5 text-fg">{pretty}</pre>
      ) : null}
      {truncated && <div className="px-3 pb-2 text-[11.5px] text-warning">Too large: only the first 2 MB is shown.</div>}
    </div>
  );
}

type JsonMode = "tree" | "raw";
const JSON_MODE_KEY = "cds.runSteps.json";

function readJsonMode(): JsonMode {
  try {
    return localStorage.getItem(JSON_MODE_KEY) === "raw" ? "raw" : "tree";
  } catch {
    return "tree";
  }
}

/** Runs per hour / day as stacked columns: failures (red) under the other runs. */
export function RunChart({ bars, unit }: { bars: Bar[]; unit: "hour" | "day" }) {
  const max = Math.max(1, ...bars.map((b) => b.total));
  const [hover, setHover] = useState<number | null>(null);
  const label = (t: number) =>
    unit === "hour"
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  const tip = hover !== null ? bars[hover] : null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-muted" aria-hidden="true">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-danger" /> Failed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-line-strong" /> Other runs
        </span>
        <span className="ml-auto tabular-nums text-subtle">peak {max.toLocaleString()} / {unit}</span>
      </div>
      <div className="relative">
        <div
          className="flex h-[120px] items-end gap-[2px] border-b border-line"
          role="img"
          aria-label={`Runs per ${unit}: ${bars.reduce((a, b) => a + b.total, 0)} runs, ${bars.reduce((a, b) => a + b.failed, 0)} failed`}
          onMouseLeave={() => setHover(null)}
        >
          {bars.map((b, i) => {
            const ok = b.total - b.failed;
            return (
              // The whole column is the hover target, not just the mark.
              <div key={b.at} className="flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
                <div
                  className={`flex w-full flex-col justify-end gap-[2px] ${hover === i ? "opacity-100" : hover !== null ? "opacity-60" : ""}`}
                  style={{ height: `${(b.total / max) * 100}%` }}
                >
                  {ok > 0 && <div className="w-full rounded-t-[4px] bg-line-strong" style={{ flexGrow: ok, minHeight: 2 }} />}
                  {b.failed > 0 && (
                    <div className={`w-full bg-danger ${ok > 0 ? "" : "rounded-t-[4px]"}`} style={{ flexGrow: b.failed, minHeight: 2 }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {tip && hover !== null && (
          <div
            className="popover pointer-events-none absolute bottom-[calc(100%+6px)] z-10 whitespace-nowrap px-2.5 py-1.5 text-xs"
            style={{ left: `${((hover + 0.5) / bars.length) * 100}%`, transform: "translateX(-50%)" }}
          >
            <div className="font-medium">
              {unit === "hour"
                ? new Date(tip.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                : new Date(tip.at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
            </div>
            <div className="tabular-nums text-muted">
              {tip.total.toLocaleString()} run{tip.total === 1 ? "" : "s"}
              {tip.failed > 0 && <span className="text-danger"> · {tip.failed.toLocaleString()} failed</span>}
            </div>
          </div>
        )}
      </div>
      {bars.length > 0 && (
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-subtle">
          <span>{label(bars[0].at)}</span>
          {bars.length > 4 && <span>{label(bars[Math.floor(bars.length / 2)].at)}</span>}
          <span>{label(bars[bars.length - 1].at)}</span>
        </div>
      )}
    </div>
  );
}

/** Flows › Runs: one flow's run history, newest first, with the picked run beside it. */
export function FlowRunsTab({
  connId,
  flow,
  runId,
  onRun,
}: {
  connId: string;
  flow: FlowMeta;
  runId: string | null;
  onRun: (id: string | null) => void;
}) {
  const filters = useFlowRuns((s) => flowRunFiltersOf(s, connId));
  const list = useFlowRuns((s) => s.lists[connId]);
  const setFilters = useFlowRuns((s) => s.setFilters);
  const load = useFlowRuns((s) => s.load);
  const loadMore = useFlowRuns((s) => s.loadMore);
  const flowId = flow.id.toLowerCase();
  // This flow's figures if the monitor already counted this range (no scan from here).
  const summary = runSummaries.useStore((s) => s.data[`${connId}|${filters.range}`]);
  const stats = summary?.flows.find((f) => f.flowId === flowId) ?? null;
  const listRef = useRef<HTMLUListElement>(null);
  const [listHidden, setListHidden] = useState(readListHidden);
  // Find in run data: the search shown in place of the list, and the step to open a found run at.
  const search = useRunSearch((s) => searchOf(s.searches, connId, flowId));
  const [focus, setFocus] = useState<{ runId: string; step: string } | null>(null);
  const definition = useFlows((s) => s.definitions[definitionKey(connId, flow.id)]);
  const loadDefinition = useFlows((s) => s.loadDefinition);
  useEffect(() => {
    if (definition === undefined) loadDefinition(connId, flow.id);
  }, [definition, connId, flow.id, loadDefinition]);
  const options = useMemo(() => stepOptions(definition ? buildOutline(definition) : null), [definition]);
  const names = useMemo(() => new Map(options.map((o) => [o.key, o.name])), [options]);
  const openFound = (run: RunRow, step: string) => {
    setFocus({ runId: run.id, step });
    onRun(run.id);
  };
  const toggleList = () =>
    setListHidden((hidden) => {
      try {
        localStorage.setItem(LIST_HIDDEN_KEY, hidden ? "0" : "1");
      } catch {
        // Only a convenience.
      }
      return !hidden;
    });

  useEffect(() => checkRunAccess(connId), [connId]);
  useEffect(() => {
    if (filters.flowId !== flowId) setFilters(connId, { flowId });
  }, [connId, flowId, filters.flowId, setFilters]);
  useEffect(() => {
    if (filters.flowId === flowId) load(connId);
  }, [connId, flowId, filters, load]);

  // Rows of another flow (just switched) aren't this flow's.
  const mine = !!list && list.key === JSON.stringify(filters) && filters.flowId === flowId;
  const rows = mine ? list.rows : [];
  const loading = !mine || list.status === "loading";
  // A run a search found may be older than the list's first page.
  const selected = rows.find((r) => r.id === runId) ?? search?.matches.find((m) => m.run.id === runId)?.run ?? null;
  const failed = rows.filter((r) => r.outcome === "failed").length;

  const focusSelected = useRef(false);
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    row?.scrollIntoView({ block: "nearest" });
    if (focusSelected.current) {
      focusSelected.current = false;
      row?.focus();
    }
  }, [runId, rows]);
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === runId);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      focusSelected.current = true;
      onRun(next.id);
    }
  };

  return (
    <div
      className={`grid h-full min-h-0 transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none ${
        selected && listHidden ? "grid-cols-[0px_minmax(0,1fr)]" : "grid-cols-[clamp(280px,30%,380px)_minmax(0,1fr)]"
      }`}
    >
      <div
        className={`flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-line bg-s1 transition-[opacity,visibility] duration-200 ${
          selected && listHidden ? "invisible opacity-0" : ""
        }`}
        aria-hidden={selected && listHidden ? true : undefined}
      >
        <div className="flex items-center gap-2 px-3 pt-3">
          <Clock size={13} className="pointer-events-none relative left-[22px] z-[1] -mr-2 shrink-0 text-subtle" />
          <select
            className="input !h-8 min-w-0 flex-1 !pl-7 !pr-2 !text-[12.5px]"
            value={filters.range}
            onChange={(e) => setFilters(connId, { range: e.target.value as RunRange })}
            aria-label="Time range"
            title="Runs started in this window"
          >
            {RUN_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => load(connId, true)}
            disabled={mine && list.status === "loading"}
            title="Read the newest runs again"
            aria-label="Refresh runs"
          >
            <Refresh size={14} className={mine && list.status === "loading" ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="seg mx-3 mt-2 !flex" role="group" aria-label="Filter by status">
          {RUN_STATUSES.slice(0, 4).map((s) => (
            <button key={s.key} className="flex-1" aria-pressed={filters.status === s.key} onClick={() => setFilters(connId, { status: s.key })}>
              {s.label}
            </button>
          ))}
        </div>
        <RunSearchBar connId={connId} flowId={flowId} options={options} filters={filters} />

        {search ? (
          <RunSearchResults connId={connId} flowId={flowId} runId={runId} names={names} onOpen={openFound} />
        ) : (
          <>
            <div className="flex items-center justify-between px-4 pb-1.5 pt-3 text-[11.5px] text-subtle">
              <span className="min-w-0 truncate">
                {stats ? (
                  <span title={`Counted by Flow runs (${rangeLabel(filters.range).toLowerCase()})`}>
                    {stats.total.toLocaleString()} run{stats.total === 1 ? "" : "s"}
                    {stats.failed > 0 ? (
                      <span className="text-danger">
                        {" "}
                        · {stats.failed.toLocaleString()} failed ({failRate(stats.failed, stats.total)})
                      </span>
                    ) : (
                      " · none failed"
                    )}
                  </span>
                ) : mine && list.status === "ready" ? (
                  <>
                    {rows.length.toLocaleString()}
                    {list.next ? "+" : ""} run{rows.length === 1 ? "" : "s"}
                    {failed > 0 && filters.status !== "failed" && <span className="text-danger"> · {failed} failed</span>}
                  </>
                ) : (
                  " "
                )}
              </span>
              {mine && list.status === "ready" && (
                <span className="shrink-0 pl-2" title={new Date(list.at).toLocaleString()}>
                  as of {logTime(new Date(list.at).toISOString())}
                </span>
              )}
            </div>

            <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label="Runs" onKeyDown={onListKey}>
              {mine && list.status === "error" ? (
                <li className="px-3 py-8 text-center text-xs text-subtle">
                  <div className="text-warning">Couldn't read the run history.</div>
                  <div className="mt-1 break-words">{list.error}</div>
                  <button className="btn btn-secondary btn-sm mt-3" onClick={() => load(connId, true)}>
                    <Refresh size={12} /> Retry
                  </button>
                </li>
              ) : loading && !rows.length ? (
                <ListSkeleton />
              ) : rows.length === 0 ? (
                <li className="fade-in px-3 py-10 text-center">
                  <div className="empty-icon">
                    <Activity size={18} />
                  </div>
                  <div className="mt-3 text-sm font-medium">{filters.status ? `No ${filters.status} runs` : "No runs"}</div>
                  <div className="mt-1 text-xs text-subtle">
                    {flow.solutions.length === 0
                      ? "Dataverse only keeps run history for flows in a solution, and this one isn't in any (that this account can see)."
                      : `Nothing ran in the ${rangeLabel(filters.range).toLowerCase()}.${filters.range !== "28d" ? " Try a longer time range." : ""}`}
                  </div>
                </li>
              ) : (
                <>
                  {rows.map((r) => (
                    <li key={r.id}>
                      <RunItem row={r} selected={r.id === runId} onOpen={() => onRun(r.id)} />
                    </li>
                  ))}
                  {list?.next && (
                    <li className="px-2 pt-2">
                      <button className="btn btn-secondary btn-sm w-full justify-center" onClick={() => loadMore(connId)} disabled={list.loadingMore}>
                        {list.loadingMore ? <Loader size={12} /> : null}
                        {list.loadingMore ? "Loading…" : "Load more"}
                      </button>
                    </li>
                  )}
                  {list?.error && list.status === "ready" && <li className="px-3 pt-2 text-center text-xs text-warning">{list.error}</li>}
                </>
              )}
            </ul>
          </>
        )}
      </div>

      <div className="min-h-0 overflow-hidden">
        {selected ? (
          <RunDetail
            key={selected.id}
            connId={connId}
            row={selected}
            focusStep={focus?.runId === selected.id ? focus.step : null}
            listHidden={listHidden}
            onToggleList={toggleList}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <div className="empty-icon">
              <Activity size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">{runId && !loading ? "Run not in this list" : "No run selected"}</div>
              <div className="mt-0.5 max-w-sm text-xs text-subtle">
                {runId && !loading
                  ? "It may be older than the time range, or hidden by the status filter."
                  : "Pick a run on the left to see when it ran and why it failed. ↑ ↓ move through the list."}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A step a search can be limited to (Runs › Find in run data). */
interface StepOption {
  key: string;
  name: string;
  depth: number;
  trigger: boolean;
}

function stepOptions(outline: OutlineNode[] | null): StepOption[] {
  const out: StepOption[] = [];
  const walk = (nodes: OutlineNode[], depth: number) => {
    for (const n of nodes) {
      if (n.kind === "branch") {
        walk(n.children, depth);
        continue;
      }
      out.push({ key: n.key, name: n.name, depth, trigger: n.kind === "trigger" });
      walk(n.children, depth + 1);
    }
  };
  if (outline) walk(outline, 0);
  return out;
}

const searchStepKey = (flowId: string) => `cds.runSearch.step.${flowId}`;

function readSearchStep(flowId: string): string {
  try {
    return localStorage.getItem(searchStepKey(flowId)) ?? "";
  } catch {
    return "";
  }
}

/** Runs › Find in run data: the box, the step to look in, Search / Stop. */
function RunSearchBar({
  connId,
  flowId,
  options,
  filters,
}: {
  connId: string;
  flowId: string;
  options: StepOption[];
  filters: { range: RunRange; status: RunStatusFilter };
}) {
  const search = useRunSearch((s) => searchOf(s.searches, connId, flowId));
  const start = useRunSearch((s) => s.start);
  const stop = useRunSearch((s) => s.stop);
  const [needle, setNeedle] = useState(search?.needle ?? "");
  const [step, setStep] = useState(() => readSearchStep(flowId));
  // When: one of the list's ranges, or from–to (narrower is quicker).
  const [when, setWhen] = useState<RunRange | "custom">(filters.range);
  const [from, setFrom] = useState(() => localInput(Date.now() - 24 * 60 * 60_000));
  const [to, setTo] = useState(() => localInput(Date.now()));
  const custom = when === "custom";
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const windowProblem = !custom
    ? null
    : !from || !to || Number.isNaN(fromMs) || Number.isNaN(toMs)
    ? "Pick both times"
    : fromMs >= toMs
    ? "“From” has to be before “To”"
    : null;
  const option = options.find((o) => o.key === step) ?? null;
  const running = search?.status === "running";

  const pickStep = (key: string) => {
    setStep(key);
    try {
      localStorage.setItem(searchStepKey(flowId), key);
    } catch {
      // Only a convenience.
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = needle.trim();
    if (!value || running || windowProblem) return;
    const window: SearchWindow = custom
      ? {
          since: new Date(fromMs).toISOString(),
          until: new Date(toMs).toISOString(),
          status: filters.status,
          label: windowText(fromMs, toMs),
          widenable: true,
        }
      : { since: runSince(when), until: null, status: filters.status, label: rangeLabel(when).toLowerCase(), widenable: when !== "28d" };
    const scope: RunSearchScope = !option
      ? { steps: null, trigger: false }
      : option.trigger
      ? { steps: [], trigger: true }
      : { steps: [option.key], trigger: false };
    start(connId, flowId, value, scope, option ? option.name : "every step", window);
  };

  return (
    <form className="mx-3 mt-2.5 space-y-1.5" onSubmit={submit} role="search" aria-label="Find in run data">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
        <input
          className="input !h-8 w-full !pl-8 !text-[12.5px]"
          placeholder="Find a value in the runs (PO number…)"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          aria-label="Value to find in the runs' inputs and outputs"
        />
      </div>
      <Collapse open={!!needle.trim() || !!search}>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1.5">
          <span className="text-[11.5px] text-subtle">in</span>
          <select
            className="input col-span-2 !h-7 min-w-0 !px-2 !text-[12px]"
            value={option ? option.key : ""}
            onChange={(e) => pickStep(e.target.value)}
            aria-label="Step to look in"
            title="Looking in one step is much quicker than in every step"
          >
            <option value="">Every step (slow)</option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {"  ".repeat(o.depth)}
                {o.name}
              </option>
            ))}
          </select>
          <span className="text-[11.5px] text-subtle">when</span>
          <select
            className="input !h-7 min-w-0 !px-2 !text-[12px]"
            value={when}
            onChange={(e) => setWhen(e.target.value as RunRange | "custom")}
            aria-label="Runs started"
            title="A narrower window is quicker to search"
          >
            {RUN_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
            <option value="custom">Between… (pick dates)</option>
          </select>
          {running ? (
            <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={() => stop(connId, flowId)}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary btn-sm shrink-0" disabled={!needle.trim() || !!windowProblem} title={windowProblem ?? undefined}>
              Search
            </button>
          )}
          {custom && (
            <>
              <span className="text-[11.5px] text-subtle">from</span>
              <input
                type="datetime-local"
                className="input col-span-2 !h-7 min-w-0 !px-2 !text-[12px]"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="Runs started from"
              />
              <span className="text-[11.5px] text-subtle">to</span>
              <input
                type="datetime-local"
                className="input col-span-2 !h-7 min-w-0 !px-2 !text-[12px]"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                aria-label="Runs started before"
              />
              {windowProblem && <span className="col-span-3 text-[11px] text-warning">{windowProblem}</span>}
            </>
          )}
        </div>
      </Collapse>
    </form>
  );
}

/** A time as a datetime-local input value (local time, minutes). */
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Oct 8, 09:00 – 18:00", or with both dates when they differ. */
function windowText(from: number, to: number): string {
  const day = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return day(from) === day(to) ? `${day(from)}, ${hm(from)} – ${hm(to)}` : `${day(from)}, ${hm(from)} – ${day(to)}, ${hm(to)}`;
}

/** The needle marked in a snippet. */
function Marked({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-warning/30 px-px text-fg">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

/** The runs a search found, with where in each one; replaces the run list while shown. */
function RunSearchResults({
  connId,
  flowId,
  runId,
  names,
  onOpen,
}: {
  connId: string;
  flowId: string;
  runId: string | null;
  /** Step name in the definition → its display name. */
  names: Map<string, string>;
  onOpen: (run: RunRow, step: string) => void;
}) {
  const search = useRunSearch((s) => searchOf(s.searches, connId, flowId));
  const clear = useRunSearch((s) => s.clear);
  if (!search) return null;

  const matches = [...search.matches].sort((a, b) => (b.run.startTime ?? "").localeCompare(a.run.startTime ?? ""));
  const total = `${search.total.toLocaleString()}${search.listed ? "" : "+"}`;
  const found = matches.length;
  const pct = search.total ? Math.min(100, (search.scanned / search.total) * 100) : 0;
  const summary =
    search.status === "running"
      ? `Searching… ${search.scanned.toLocaleString()} / ${total} runs`
      : search.status === "stopped"
      ? `Stopped after ${search.scanned.toLocaleString()} of ${total} runs`
      : search.status === "error"
      ? "The search stopped"
      : found
      ? `Found in ${found.toLocaleString()} of ${search.total.toLocaleString()} run${search.total === 1 ? "" : "s"}`
      : `Not found in ${search.total.toLocaleString()} run${search.total === 1 ? "" : "s"}`;
  const label = (step: string) => names.get(step) ?? step.replace(/_/g, " ");

  return (
    <>
      <div className="px-3 pb-1.5 pt-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[12px] font-medium">
              {search.status === "running" && <Loader size={12} className="shrink-0 text-brand" />}
              <span className="truncate">{summary}</span>
              {search.status !== "error" && found > 0 && <span className="badge badge-brand shrink-0">{found}</span>}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-subtle" title={`“${search.needle}” in ${search.scopeLabel} · ${search.windowLabel}`}>
              “{search.needle}” in {search.scopeLabel} · {search.windowLabel}
            </div>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm shrink-0" onClick={() => clear(connId, flowId)} title="Clear the search (back to the run list)" aria-label="Clear the search">
            <X size={13} />
          </button>
        </div>
        {(search.status === "running" || search.status === "stopped") && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-s3" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
        )}
        {search.error && <div className="mt-1.5 break-words text-[11.5px] text-warning">{search.error}</div>}
        {(search.capped || search.failed > 0 || search.skipped > 0) && (
          <div className="mt-1.5 space-y-0.5 text-[11px] text-subtle">
            {search.capped && <div>Only the newest {MAX_RUNS.toLocaleString()} runs of the window are searched.</div>}
            {search.failed > 0 && <div className="text-warning">{search.failed.toLocaleString()} run(s) couldn't be searched.</div>}
            {search.skipped > 0 && <div>{search.skipped.toLocaleString()} input/output bodies couldn't be read.</div>}
          </div>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Runs where it was found">
        {matches.map(({ run, hits }) => (
          <li key={run.id} className="fade-in">
            <RunItem row={run} selected={run.id === runId} onOpen={() => onOpen(run, hits[0].step)} />
            <div className="mb-1.5 ml-5 space-y-0.5">
              {hits.slice(0, 3).map((h, i) => (
                <button
                  key={i}
                  className="block w-full rounded-md px-2 py-1 text-left hover:bg-s2"
                  onClick={() => onOpen(run, h.step)}
                  title="Open the run at this step"
                >
                  <div className="truncate text-[11.5px] text-muted">
                    {label(h.step)} <span className="text-subtle">· {h.part}</span>
                    {h.repetition.length > 0 && (
                      <span className="text-subtle"> · {h.repetition.map((r) => `${label(r.scopeName)} #${r.itemIndex + 1}`).join(" › ")}</span>
                    )}
                  </div>
                  <div className="line-clamp-2 break-all font-mono text-[11px] leading-4 text-subtle">
                    <Marked text={h.snippet} needle={search.needle} />
                  </div>
                </button>
              ))}
              {hits.length > 3 && <div className="px-2 text-[11px] text-subtle">+{hits.length - 3} more place(s) in this run</div>}
            </div>
          </li>
        ))}
        {!matches.length && search.status !== "running" && (
          <li className="fade-in px-3 py-10 text-center">
            <div className="empty-icon">
              <Search size={18} />
            </div>
            <div className="mt-3 text-sm font-medium">{search.status === "error" ? "Search stopped" : "Nothing found"}</div>
            <div className="mt-1 text-xs text-subtle">
              {search.status === "done"
                ? `No run (${search.windowLabel}) has “${search.needle}” in ${search.scopeLabel}.${
                    search.widenable ? " Try a wider time window" : ""
                  }${search.scope.steps ? `${search.widenable ? ", or" : " Try"} every step.` : search.widenable ? "." : ""}`
                : ""}
            </div>
          </li>
        )}
        {!matches.length && search.status === "running" && (
          <li className="px-3 py-8 text-center text-xs text-subtle">Runs where it's found show up here as the search goes.</li>
        )}
      </ul>
    </>
  );
}

const LIST_HIDDEN_KEY = "cds.runs.listHidden";

function readListHidden(): boolean {
  try {
    return localStorage.getItem(LIST_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** What each read depth short of "global" lets the account see. */
export const RUN_SCOPE: Record<Exclude<RunReadDepth, "global">, string> = {
  none: "no runs at all",
  basic: "only runs of flows it owns",
  local: "only runs of flows owned by people in its business unit",
  deep: "only runs of flows owned by people in its business unit and the units below it",
};

/** This account can't see every run of an environment (see `useRunAccess`). */
export function RunAccessModal() {
  const denied = useRunAccess((s) => s.denied);
  const dismiss = useRunAccess((s) => s.dismiss);
  const connection = useStore((s) => s.connections.find((c) => c.id === denied?.connId) ?? null);
  const account = useStore((s) => s.projects.find((p) => p.id === connection?.projectId)?.username ?? null);
  const pushToast = useStore((s) => s.pushToast);
  if (!denied || denied.depth === "global") return null;

  const none = denied.depth === "none";
  const env = connection?.name ?? "this environment";
  const request = [
    `Please give ${account ?? "my account"} ${none ? "" : "Organization-level "}read access to the Flow Run table (privilege prvReadflowrun)`,
    `in ${connection ? `${connection.name} (${connection.url})` : "this environment"},`,
    "so I can see the cloud flow run history of every flow.",
  ].join(" ");
  const copy = () =>
    navigator.clipboard
      .writeText(request)
      .then(() => pushToast({ tone: "success", title: "Copied the request" }))
      .catch(() => pushToast({ tone: "error", title: "Couldn't copy the request" }));
  const who = account ? <span className="font-medium text-fg">{account}</span> : "This account";

  return (
    <Modal
      title={none ? "No access to flow runs" : "Limited access to flow runs"}
      icon={<Shield size={15} className="text-warning" />}
      onClose={dismiss}
      width="max-w-md"
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          {none ? (
            <>
              {who} doesn't have permission to see cloud flow run history in <span className="font-medium text-fg">{env}</span>.
            </>
          ) : (
            <>
              In <span className="font-medium text-fg">{env}</span>, {who} can see {RUN_SCOPE[denied.depth]}. Runs of other flows
              are hidden, so counts and lists show fewer runs than there are, or none.
            </>
          )}
        </p>
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm leading-relaxed">
          {none ? "It needs read access" : <>It needs <span className="font-medium">Organization</span>-level read access</>} to the{" "}
          <span className="font-medium">Flow Run</span> table (<span className="font-mono text-[12.5px]">prvReadflowrun</span>). Ask an admin
          to add it to one of your security roles, then press Refresh.
        </p>
        <p className="text-xs text-subtle">Flows and their definitions still work; only run history and the Flow runs monitor need this.</p>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={copy}>
            <Copy size={14} /> Copy request for admin
          </button>
          <button className="btn btn-primary" onClick={dismiss} autoFocus>
            OK
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The Power Automate API refused this account (see `useFlowApiAccess`): once per environment. */
export function FlowApiAccessModal() {
  const dialog = useFlowApiAccess((s) => s.dialog);
  const dismiss = useFlowApiAccess((s) => s.dismiss);
  const connection = useStore((s) => s.connections.find((c) => c.id === dialog?.connId) ?? null);
  const account = useStore((s) => s.projects.find((p) => p.id === connection?.projectId)?.username ?? null);
  const pushToast = useStore((s) => s.pushToast);
  if (!dialog) return null;

  const token = isTokenDenial(dialog.reason);
  const env = connection?.name ?? "this environment";
  const request = token
    ? [
        `Please allow ${account ?? "my account"} to get a token for Power Automate (Microsoft Flow Service, 7df0a125-d3be-4c96-aa54-591f83ff541c)`,
        "from the Hexa Studio desktop app, so it can read cloud flow run details.",
        `Sign-in error: ${dialog.reason}`,
      ].join(" ")
    : [
        `Please make ${account ?? "my account"} a co-owner of the flows I need to troubleshoot`,
        `in ${connection ? `${connection.name} (${connection.url})` : "this environment"}, or an environment admin,`,
        "so I can read their run details in Power Automate.",
      ].join(" ");
  const copy = () =>
    navigator.clipboard
      .writeText(request)
      .then(() => pushToast({ tone: "success", title: "Copied the request" }))
      .catch(() => pushToast({ tone: "error", title: "Couldn't copy the request" }));
  const who = account ? <span className="font-medium text-fg">{account}</span> : "This account";

  return (
    <Modal title="No access to run steps" icon={<Shield size={15} className="text-warning" />} onClose={dismiss} width="max-w-md">
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          {who} can't read the steps of cloud flow runs from Power Automate in <span className="font-medium text-fg">{env}</span>.
        </p>
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm leading-relaxed">
          {token ? (
            <>
              Your organization's sign-in policy (usually <span className="font-medium">Conditional Access</span>) doesn't let this app get a
              Power Automate token for this account. Signing in again won't change it: an admin has to allow it.
            </>
          ) : (
            <>
              Power Automate only shows a run's steps to the flow's <span className="font-medium">owners and co-owners</span> and to
              environment admins.
            </>
          )}
        </p>
        <div className="break-words rounded-lg bg-s2 px-3 py-2 font-mono text-[11.5px] leading-5 text-subtle">{dialog.reason}</div>
        <p className="text-xs text-subtle">
          Run history from Dataverse (status, times, error message) still works. "Open in Power Automate" shows the steps in your browser, if it
          lets you in.
        </p>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={copy}>
            <Copy size={14} /> Copy request for admin
          </button>
          <button className="btn btn-primary" onClick={dismiss} autoFocus>
            OK
          </button>
        </div>
      </div>
    </Modal>
  );
}
