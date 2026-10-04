// Pieces shared by the flow run views (Flows › Runs tab, Flow runs monitor):
// a run row, a run's detail, the runs-per-slot chart.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useStore } from "../store";
import { useFlows } from "../lib/flows";
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
  runDuration,
  childRuns,
  runByName,
  runSummaries,
  useFlowRuns,
  checkRunAccess,
  useRunAccess,
  type Bar,
  type RunRange,
} from "../lib/flowRuns";
import { IdList, ListSkeleton } from "./LogParts";
import { Modal } from "./Modals";
import { Activity, ArrowUpRight, Copy, Loader, Refresh, Search, Shield } from "./Icon";
import type { FlowMeta, RunReadDepth, RunRow } from "../types";

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

/** One run in full: when, how long, why it failed, its ids. */
export function RunDetail({ connId, row, actions }: { connId: string; row: RunRow; actions?: React.ReactNode }) {
  const pushToast = useStore((s) => s.pushToast);
  const running = row.outcome === "running";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const duration = runDuration(row, now);

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

  return (
    <div className="fade-in flex h-full min-h-0 flex-col overflow-y-auto px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge badge-dot ${OUTCOME_BADGE[row.outcome]}`}>{row.status || OUTCOME_LABEL[row.outcome]}</span>
            {row.triggerType && <span className="badge badge-neutral">{row.triggerType}</span>}
            {row.parentRunId && <span className="badge badge-neutral">child run</span>}
          </div>
          <div className="mt-1.5 text-base font-semibold tracking-tight tabular-nums">
            {row.startTime ? new Date(row.startTime).toLocaleString() : "Start time unknown"}
          </div>
          <div className="mt-0.5 flex items-center text-sm text-muted">
            {duration !== null ? `took ${formatDuration(duration)}` : running ? "running" : "duration unknown"}
            {running && <Loader size={12} className="ml-1.5 text-info" />}
            {row.flowName && <span className="ml-1 truncate"> · {row.flowName}</span>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>

      <RunFamily connId={connId} row={row} />

      {(row.errorCode || row.errorMessage) && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10">
          <div className="flex items-center justify-between gap-2 border-b border-danger/20 px-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-danger">{row.errorCode || "Error"}</span>
            {row.errorMessage && (
              <button className="btn btn-ghost btn-sm" onClick={() => copy(row.errorMessage!, "error message")}>
                <Copy size={12} /> Copy
              </button>
            )}
          </div>
          {row.errorMessage && (
            <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12.5px] leading-5 text-fg">
              {errorText(row.errorMessage)}
            </pre>
          )}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
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
      <p className="mt-4 text-xs text-subtle">
        Dataverse keeps the run's outcome, not its steps. Search the run id in Power Automate to see each action.
      </p>
    </div>
  );
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
  const selected = rows.find((r) => r.id === runId) ?? null;
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
    <div className="grid h-full min-h-0 grid-cols-[clamp(300px,34%,400px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="flex items-center gap-2 px-3 pt-3">
          <select
            className="input !h-8 flex-1 !px-2 !text-[12.5px]"
            value={filters.range}
            onChange={(e) => setFilters(connId, { range: e.target.value as RunRange })}
            aria-label="Time range"
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
      </div>

      <div className="min-h-0 overflow-hidden">
        {selected ? (
          <RunDetail key={selected.id} connId={connId} row={selected} />
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
