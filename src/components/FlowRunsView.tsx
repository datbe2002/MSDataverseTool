import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useStore } from "../store";
import { useFlows } from "../lib/flows";
import {
  RUN_RANGES,
  bars as toBars,
  checkRunAccess,
  errorGist,
  errorText,
  failRate,
  monitorRunFiltersOf,
  rangeLabel,
  retentionLabel,
  runReadDepth,
  runSummaries,
  seesAllRuns,
  slotUnit,
  useMonitorRange,
  useMonitorRuns,
  type RunRange,
} from "../lib/flowRuns";
import { logTime } from "../lib/pagedStore";
import { relativeTime } from "../lib/history";
import { flowRoute } from "../lib/navigation";
import { RUN_SCOPE, RunChart, RunFamily, RunItem } from "./FlowRuns";
import { ErrorsTab, Quiet, RowsSkeleton, TopErrorsCard } from "./FlowRunErrors";
import { Activity, AlertTriangle, ArrowUpRight, Copy, Loader, Refresh, Search, X } from "./Icon";
import type { FlowRunStats, RunRow, RunSummary } from "../types";

type View = "overview" | "errors" | "flows";

const VIEWS: { key: View; label: string; title: string }[] = [
  { key: "overview", label: "Overview", title: "Flow runs" },
  { key: "errors", label: "Errors", title: "Errors" },
  { key: "flows", label: "Flows", title: "Flows and runs" },
];

/** Flow runs (Monitoring): how many runs failed in a window, which flows, and why. */
export function FlowRunsView() {
  const activeId = useStore((s) => s.activeId);
  const connection = useStore((s) => s.connections.find((c) => c.id === s.activeId) ?? null);
  const range = useMonitorRange((s) => s.range);
  const setRange = useMonitorRange((s) => s.setRange);
  const summary = runSummaries.useEntry(activeId, range);
  const flowList = useFlows((s) => (activeId ? s.lists[activeId] : undefined));
  const loadFlows = useFlows((s) => s.loadFlows);
  const [params, setParams] = useSearchParams();
  const pickedFlow = params.get("flow")?.toLowerCase() ?? null;
  // ?view=…; an old link with only ?flow= opens the Flows tab.
  const asked = params.get("view") as View | null;
  const view: View = asked && VIEWS.some((v) => v.key === asked) ? asked : pickedFlow ? "flows" : "overview";

  useEffect(() => {
    if (activeId) loadFlows(activeId);
  }, [activeId, loadFlows]);
  useEffect(() => {
    if (activeId) checkRunAccess(activeId);
  }, [activeId]);
  const depth = runReadDepth.useStore((st) => (activeId ? st.data[`${activeId}|`] : undefined));

  // Another environment: the picked flow isn't there. Not on first render, so a deep link keeps it.
  const prevActiveId = useRef(activeId);
  useEffect(() => {
    if (prevActiveId.current && prevActiveId.current !== activeId) setParams({}, { replace: true });
    prevActiveId.current = activeId;
  }, [activeId, setParams]);

  const names = useMemo(() => new Map((flowList?.flows ?? []).map((f) => [f.id.toLowerCase(), f.name])), [flowList]);
  const s = summary.data;
  const chart = useMemo(() => (s ? toBars(s, range) : null), [s, range]);
  const failing = s ? s.flows.filter((f) => f.failed > 0).length : 0;

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        Select an environment to see its cloud flow runs.
      </div>
    );
  }

  /** Another tab, flow or error code; what isn't given is kept (null drops it). */
  const go = (to: { view: View; flow?: string | null; code?: string | null }) => {
    const next = new URLSearchParams(params);
    next.set("view", to.view);
    if (to.flow !== undefined) {
      if (to.flow === null) next.delete("flow");
      else next.set("flow", to.flow);
    }
    if (to.code !== undefined) {
      if (to.code === null) next.delete("code");
      else next.set("code", to.code);
    }
    next.delete("run");
    setParams(next, { replace: true });
  };
  const kept = retentionLabel(s?.retentionSeconds ?? null);

  const tiles = [
    {
      label: "Runs",
      value: s ? s.total.toLocaleString() : null,
      sub: s
        ? [
            `${s.succeeded.toLocaleString()} succeeded`,
            s.cancelled ? `${s.cancelled.toLocaleString()} cancelled` : null,
            s.running ? `${s.running.toLocaleString()} running` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "",
      tone: "text-subtle",
    },
    {
      label: "Failed",
      value: s ? s.failed.toLocaleString() : null,
      sub: s ? (s.failed ? `${s.errors.length.toLocaleString()} error code${s.errors.length === 1 ? "" : "s"}` : "no failures") : "",
      tone: s?.failed ? "text-danger" : "text-success",
      valueTone: s?.failed ? "text-danger" : "",
    },
    {
      label: "Fail rate",
      value: s ? (s.total ? failRate(s.failed, s.total) : "—") : null,
      sub: s ? `of runs in the ${rangeLabel(range).toLowerCase()}` : "",
      tone: "text-subtle",
      valueTone: s?.failed ? "text-danger" : "",
    },
    {
      label: "Flows with failures",
      value: s ? failing.toLocaleString() : null,
      sub: s ? `of ${s.flows.length.toLocaleString()} flow${s.flows.length === 1 ? "" : "s"} that ran` : "",
      tone: failing ? "text-danger" : "text-subtle",
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-end gap-1 border-b border-line bg-s1 px-4" role="tablist" aria-label="Flow runs">
        {VIEWS.map((v) => (
          <button key={v.key} role="tab" aria-selected={view === v.key} className="tab h-10 px-2" onClick={() => go({ view: v.key })}>
            {v.label}
            {v.key === "errors" && s && s.errors.length > 0 && (
              <span className="ml-1.5 text-[11px] tabular-nums text-subtle">{s.errors.length.toLocaleString()}</span>
            )}
          </button>
        ))}
      </div>
      <section className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="page-title">{VIEWS.find((v) => v.key === view)?.title}</h1>
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                <span className="truncate">
                  {connection?.name ?? "This environment"} · cloud flows in a solution
                  {kept && ` · Dataverse keeps ${kept}`}
                </span>
                {summary.loading ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-subtle" role="status">
                    · <Loader size={12} className="text-brand" /> Counting runs…
                  </span>
                ) : s ? (
                  <span className="shrink-0 text-subtle" title={new Date(s.until).toLocaleString()}>
                    · as of {logTime(s.until)}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="seg" role="group" aria-label="Time range">
                {RUN_RANGES.map((r) => (
                  <button key={r.key} aria-pressed={range === r.key} onClick={() => setRange(r.key)} title={r.label}>
                    {r.short}
                  </button>
                ))}
              </div>
              <button className="btn btn-secondary" onClick={summary.reload} disabled={summary.loading} title="Count the runs again, up to now">
                <Refresh size={14} className={summary.loading ? "animate-spin" : ""} /> Refresh
              </button>
            </div>
          </div>

          {depth && !seesAllRuns(depth) && depth !== "none" && (
            <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
              This account can see {RUN_SCOPE[depth]} (read on Flow Run below Organization level), so the figures below can be lower than
              the real ones.
            </p>
          )}

          {summary.error && !s ? (
            <div className="card flex flex-col items-center gap-2 px-8 py-12 text-center">
              <AlertTriangle size={20} className="text-warning" />
              <div className="text-sm font-medium">Couldn't read the flow runs</div>
              <div className="max-w-xl break-words text-xs text-subtle">{summary.error}</div>
              <button className="btn btn-secondary btn-sm mt-2" onClick={summary.reload}>
                <Refresh size={12} /> Retry
              </button>
            </div>
          ) : (
            <>
              {summary.error && s && (
                <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
                  Couldn't refresh: {summary.error} The figures below are from {logTime(s.until)}.
                </p>
              )}
              {s?.truncated && (
                <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
                  This window has more than {(250_000).toLocaleString()} runs; counting stopped there, so the figures are a lower bound. Pick a shorter range for exact counts.
                </p>
              )}

              {view === "overview" && (
                <>
                  <div className="card grid grid-cols-2 gap-px overflow-hidden !bg-line xl:grid-cols-4">
                    {tiles.map((t) => (
                      <div key={t.label} className="bg-s1 px-5 py-4 dark:bg-s2">
                        <div className="eyebrow">{t.label}</div>
                        {t.value === null ? (
                          <div className="skeleton mt-3 h-6 w-20" />
                        ) : (
                          <div className={`mt-2 text-[28px] leading-8 font-semibold tracking-tight ${t.valueTone ?? ""}`}>{t.value}</div>
                        )}
                        <div className={`mt-1 h-4 truncate text-xs ${t.tone}`}>{t.sub}</div>
                      </div>
                    ))}
                  </div>

                  <div className="card">
                    <div className="card-header">
                      <h2 className="card-title">Runs and fail rate per {chart?.unit ?? slotUnit(range)}</h2>
                      {s && (
                        <span className="text-xs tabular-nums text-subtle">
                          {new Date(s.since).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} – now
                        </span>
                      )}
                    </div>
                    <div className="px-5 pb-4 pt-4">
                      {chart ? (
                        s && s.total === 0 ? (
                          <div className="py-8 text-center text-sm text-subtle">No flow ran in the {rangeLabel(range).toLowerCase()}.</div>
                        ) : (
                          <RunChart bars={chart.bars} unit={chart.unit} rate />
                        )
                      ) : (
                        <div className="skeleton h-[220px]" />
                      )}
                    </div>
                  </div>

                  <div className="grid gap-6 lg:grid-cols-2">
                    <TopFlowsCard summary={s} names={names} onPick={(id) => go({ view: "flows", flow: id })} onAll={() => go({ view: "flows" })} />
                    <TopErrorsCard summary={s} onPick={(code) => go({ view: "errors", code })} onAll={() => go({ view: "errors" })} />
                  </div>
                </>
              )}

              {view === "errors" && (
                <ErrorsTab
                  connId={activeId}
                  summary={s}
                  range={range}
                  names={names}
                  picked={params.has("code") ? params.get("code") : null}
                  onPick={(code) => go({ view: "errors", code })}
                  onFlow={(id) => go({ view: "flows", flow: id })}
                />
              )}

              {view === "flows" && (
                <div className="grid gap-6 xl:grid-cols-5">
                  <FlowTable
                    stats={s?.flows ?? null}
                    names={names}
                    picked={pickedFlow}
                    onPick={(id) => go({ view: "flows", flow: id === pickedFlow ? null : id })}
                    range={range}
                  />
                  <RunsCard
                    connId={activeId}
                    range={range}
                    flowId={pickedFlow}
                    flowName={pickedFlow ? names.get(pickedFlow) ?? null : null}
                    names={names}
                    onClearFlow={() => go({ view: "flows", flow: null })}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/** The flows that failed most in the window, for the overview. */
function TopFlowsCard({
  summary,
  names,
  onPick,
  onAll,
}: {
  summary: RunSummary | undefined;
  names: Map<string, string>;
  onPick: (flowId: string) => void;
  onAll: () => void;
}) {
  const failing = summary?.flows.filter((f) => f.failed > 0) ?? null;
  const top = failing?.slice(0, 5) ?? null;
  const most = Math.max(1, top?.[0]?.failed ?? 1);
  return (
    <div className="card flex min-w-0 flex-col">
      <div className="card-header">
        <h2 className="card-title">Most failing flows</h2>
        {failing && failing.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={onAll}>
            View all {failing.length.toLocaleString()}
          </button>
        )}
      </div>
      {!top ? (
        <RowsSkeleton />
      ) : top.length === 0 ? (
        <Quiet title="No flow failed" text="Every run in this window succeeded." />
      ) : (
        <ul className="px-2 py-2">
          {top.map((f) => {
            const name = names.get(f.flowId) ?? null;
            return (
              <li key={f.flowId}>
                <button className="nav-item nav-item-tall !items-start" onClick={() => onPick(f.flowId)} title="Show this flow's runs">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {name ?? <span className="font-mono text-subtle">{f.flowId ? `${f.flowId.slice(0, 8)}…` : "(no flow)"}</span>}
                      </span>
                      <span className="shrink-0 text-[13px] font-medium tabular-nums text-danger">{f.failed.toLocaleString()}</span>
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-s3" aria-hidden="true">
                        <span className="block h-full rounded-full bg-danger" style={{ width: `${(f.failed / most) * 100}%` }} />
                      </span>
                      <span className="shrink-0 text-[11px] font-normal tabular-nums text-subtle">
                        {failRate(f.failed, f.total)} of {f.total.toLocaleString()} runs
                        {f.lastErrorCode ? ` · ${f.lastErrorCode}` : ""}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FlowTable({
  stats,
  names,
  picked,
  onPick,
  range,
}: {
  stats: FlowRunStats[] | null;
  names: Map<string, string>;
  picked: string | null;
  onPick: (id: string) => void;
  range: RunRange;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [failingOnly, setFailingOnly] = useState(true);
  const nameOf = (id: string) => names.get(id) ?? null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (stats ?? []).filter(
      (f) => (!failingOnly || f.failed > 0) && (!q || (nameOf(f.flowId) ?? "").toLowerCase().includes(q) || f.flowId.includes(q))
    );
    // nameOf reads `names`.
  }, [stats, failingOnly, query, names]);
  const maxRate = Math.max(0.0001, ...shown.map((f) => (f.total ? f.failed / f.total : 0)));

  return (
    <div className="card flex min-w-0 flex-col xl:col-span-3">
      <div className="card-header gap-3">
        <h2 className="card-title shrink-0">Flows</h2>
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative min-w-0">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              className="input !h-7 w-44 !pl-7 !text-[12.5px]"
              placeholder="Filter flows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter flows by name"
            />
          </div>
          <div className="seg" role="group" aria-label="Which flows">
            <button aria-pressed={failingOnly} onClick={() => setFailingOnly(true)}>
              Failing
            </button>
            <button aria-pressed={!failingOnly} onClick={() => setFailingOnly(false)}>
              All
            </button>
          </div>
        </div>
      </div>
      <div className="max-h-[560px] min-h-[200px] overflow-y-auto">
        {!stats ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton h-4" style={{ width: `${55 + ((i * 23) % 40)}%` }} />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="empty-icon">
              <Activity size={18} />
            </div>
            <div className="mt-3 text-sm font-medium">
              {stats.length === 0 ? "No runs" : failingOnly && !query ? "No flow failed" : "No flows match"}
            </div>
            <div className="mt-1 text-xs text-subtle">
              {stats.length === 0
                ? `No flow ran in the ${rangeLabel(range).toLowerCase()}, or none is in a solution.`
                : failingOnly && !query
                ? `Every run in the ${rangeLabel(range).toLowerCase()} succeeded. Pick “All” to see them.`
                : "Clear the filter above."}
            </div>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Flow</th>
                <th className="!text-right">Failed</th>
                <th className="!text-right">Runs</th>
                <th>Fail rate</th>
                <th>Last failure</th>
                <th className="!px-2" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => {
                const name = nameOf(f.flowId);
                const rate = f.total ? f.failed / f.total : 0;
                return (
                  <tr
                    key={f.flowId}
                    className={`row cursor-pointer ${picked === f.flowId ? "!bg-s3" : ""}`}
                    onClick={() => onPick(f.flowId)}
                    aria-selected={picked === f.flowId}
                    title={picked === f.flowId ? "Show every flow's runs" : "Show this flow's runs"}
                  >
                    <td className="max-w-[260px]">
                      <div className="truncate">{name ?? <span className="font-mono text-subtle">{f.flowId ? `${f.flowId.slice(0, 8)}…` : "(no flow)"}</span>}</div>
                      {!name && <div className="text-[11px] text-subtle">deleted, or not visible to you</div>}
                    </td>
                    <td className={`text-right tabular-nums ${f.failed ? "font-medium text-danger" : "text-subtle"}`}>{f.failed.toLocaleString()}</td>
                    <td className="text-right tabular-nums text-muted">{f.total.toLocaleString()}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-s3" aria-hidden="true">
                          <div className="h-full rounded-full bg-danger" style={{ width: `${(rate / maxRate) * 100}%` }} />
                        </div>
                        <span className="w-10 text-xs tabular-nums text-muted">{failRate(f.failed, f.total)}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted">
                      {f.lastFailure ? (
                        <span title={`${new Date(f.lastFailure).toLocaleString()}${f.lastErrorCode ? ` · ${f.lastErrorCode}` : ""}`}>
                          {relativeTime(Date.parse(f.lastFailure))}
                        </span>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                    <td className="!px-2">
                      {name && (
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`${flowRoute(f.flowId)}?tab=runs`);
                          }}
                          title="Open its run history in Flows"
                          aria-label={`Open ${name} in Flows`}
                        >
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Failures of every flow (or the runs of the flow picked on the left), newest first. */
function RunsCard({
  connId,
  range,
  flowId,
  flowName,
  names,
  onClearFlow,
}: {
  connId: string;
  range: RunRange;
  flowId: string | null;
  flowName: string | null;
  names: Map<string, string>;
  onClearFlow: () => void;
}) {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.pushToast);
  const filters = useMonitorRuns((s) => monitorRunFiltersOf(s, connId));
  const list = useMonitorRuns((s) => s.lists[connId]);
  const setFilters = useMonitorRuns((s) => s.setFilters);
  const load = useMonitorRuns((s) => s.load);
  const loadMore = useMonitorRuns((s) => s.loadMore);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (filters.range !== range || filters.flowId !== (flowId ?? "")) setFilters(connId, { range, flowId: flowId ?? "" });
  }, [connId, range, flowId, filters.range, filters.flowId, setFilters]);
  const current = filters.range === range && filters.flowId === (flowId ?? "");
  useEffect(() => {
    if (current) load(connId);
  }, [connId, current, filters, load]);

  const rows = current && list?.key === JSON.stringify(filters) ? list.rows : [];
  const loading = !current || !list || list.key !== JSON.stringify(filters) || list.status === "loading";

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));
  const openInFlows = (r: RunRow) => navigate(`${flowRoute(r.flowId!)}?${new URLSearchParams({ tab: "runs", run: r.id })}`);

  return (
    <div className="card flex min-w-0 flex-col xl:col-span-2">
      <div className="card-header gap-2">
        <h2 className="card-title min-w-0 truncate" title={flowName ?? undefined}>
          {flowId ? flowName ?? "This flow" : filters.status === "failed" ? "Recent failures" : "Recent runs"}
        </h2>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="seg" role="group" aria-label="Which runs">
            <button aria-pressed={filters.status === "failed"} onClick={() => setFilters(connId, { status: "failed" })}>
              Failed
            </button>
            <button aria-pressed={filters.status === ""} onClick={() => setFilters(connId, { status: "" })}>
              All
            </button>
          </div>
          {flowId && (
            <button className="btn btn-ghost btn-icon btn-sm" onClick={onClearFlow} title="Show every flow" aria-label="Show every flow">
              <X size={13} />
            </button>
          )}
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => load(connId, true)}
            disabled={loading && current}
            title="Read the newest runs again"
            aria-label="Refresh runs"
          >
            <Refresh size={13} className={current && list?.status === "loading" ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      <ul className="max-h-[560px] min-h-[200px] overflow-y-auto px-2 py-2" role="listbox" aria-label="Runs">
        {current && list?.status === "error" ? (
          <li className="px-3 py-8 text-center text-xs text-subtle">
            <div className="text-warning">Couldn't read the runs.</div>
            <div className="mt-1 break-words">{list.error}</div>
            <button className="btn btn-secondary btn-sm mt-3" onClick={() => load(connId, true)}>
              <Refresh size={12} /> Retry
            </button>
          </li>
        ) : loading && !rows.length ? (
          Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex items-start gap-2.5 px-2.5 py-2">
              <div className="skeleton mt-1 h-2 w-2 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3 w-2/3" />
                <div className="skeleton h-2.5 w-1/2" />
              </div>
            </li>
          ))
        ) : rows.length === 0 ? (
          <li className="px-3 py-12 text-center">
            <div className="empty-icon">
              <Activity size={18} />
            </div>
            <div className="mt-3 text-sm font-medium">{filters.status === "failed" ? "No failed runs" : "No runs"}</div>
            <div className="mt-1 text-xs text-subtle">In the {rangeLabel(range).toLowerCase()}.</div>
          </li>
        ) : (
          <>
            {rows.map((r) => (
              <li key={r.id}>
                <RunItem
                  row={r}
                  selected={open === r.id}
                  onOpen={() => setOpen((o) => (o === r.id ? null : r.id))}
                  showFlow={flowId ? undefined : (r.flowId && names.get(r.flowId)) || r.flowName}
                />
                {open === r.id && (
                  <div className="fade-in mx-2 mb-2 mt-1 rounded-lg border border-line bg-s2 p-3 text-xs">
                    {r.errorMessage ? (
                      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5">{errorText(r.errorMessage)}</pre>
                    ) : (
                      <div className="text-subtle">{errorGist(r.errorMessage) ?? "No error message."}</div>
                    )}
                    <RunFamily connId={connId} row={r} />
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {r.flowId && names.has(r.flowId) && (
                        <button className="btn btn-secondary btn-sm" onClick={() => openInFlows(r)}>
                          <ArrowUpRight size={12} /> Open in Flows
                        </button>
                      )}
                      {r.runName && (
                        <button className="btn btn-ghost btn-sm" onClick={() => copy(r.runName, "run id")} title={r.runName}>
                          <Copy size={12} /> Copy run id
                        </button>
                      )}
                      {r.errorMessage && (
                        <button className="btn btn-ghost btn-sm" onClick={() => copy(r.errorMessage!, "error message")}>
                          <Copy size={12} /> Copy error
                        </button>
                      )}
                    </div>
                  </div>
                )}
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
          </>
        )}
      </ul>
    </div>
  );
}
