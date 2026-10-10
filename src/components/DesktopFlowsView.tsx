import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useStore } from "../store";
import {
  DEFAULT_RUN_FILTERS,
  DESKTOP_TABS,
  RUN_MODES,
  RUN_STATUSES,
  desktopFlowsCache,
  desktopRunFiltersOf,
  isRunning,
  machinesCache,
  runDuration,
  runTone,
  useDesktopRuns,
  type DesktopRunFilters,
  type DesktopTab,
} from "../lib/desktopFlows";
import { TONE_BADGE } from "../lib/jobs";
import { RANGES, detailKey, formatDuration, logTime, type TimeRange } from "../lib/pagedStore";
import { useDebounced } from "../lib/useDebounced";
import { desktopRoute, flowRoute } from "../lib/navigation";
import { FilterChip, IdList, ListSkeleton, LogText, Stat } from "./LogParts";
import { FlowsTab, MachinesTab, RunItem } from "./DesktopFlowsCatalog";
import { Search, Refresh, Copy, AlertTriangle, Loader, ChevronDown, Monitor } from "./Icon";
import type { DesktopRun, DesktopRunDetail } from "../types";
import { SelectFace } from "./FormParts";

const DEBOUNCE_MS = 400;

export function DesktopFlowsView() {
  const activeId = useStore((s) => s.activeId);
  const { tab: raw, id } = useParams();
  const tab: DesktopTab = raw === "flows" || raw === "machines" ? raw : "runs";
  const navigate = useNavigate();

  // Another environment: its runs, flows and machines differ. Not on first render, so a deep link keeps its item.
  const prevActiveId = useRef(activeId);
  useEffect(() => {
    if (prevActiveId.current && prevActiveId.current !== activeId) navigate(desktopRoute(tab), { replace: true });
    prevActiveId.current = activeId;
  }, [activeId, navigate, tab]);

  if (!activeId) {
    return <div className="flex h-full items-center justify-center text-sm text-subtle">Select an environment to see its desktop flows.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-end gap-1 border-b border-line bg-s1 px-4" role="tablist" aria-label="Desktop flows">
        {DESKTOP_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className="tab h-10 px-2" onClick={() => navigate(desktopRoute(t.key))}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "runs" && <RunsTab connId={activeId} selected={id?.toLowerCase() ?? null} />}
        {tab === "flows" && <FlowsTab connId={activeId} selected={id?.toLowerCase() ?? null} />}
        {tab === "machines" && <MachinesTab connId={activeId} selected={id?.toLowerCase() ?? null} />}
      </div>
    </div>
  );
}

function RunsTab({ connId, selected }: { connId: string; selected: string | null }) {
  const filters = useDesktopRuns((s) => desktopRunFiltersOf(s, connId));
  const list = useDesktopRuns((s) => s.lists[connId]);
  const setFilters = useDesktopRuns((s) => s.setFilters);
  const load = useDesktopRuns((s) => s.load);
  const loadMore = useDesktopRuns((s) => s.loadMore);
  const flows = desktopFlowsCache.useEntry(connId);
  const machines = machinesCache.useEntry(connId);

  const navigate = useNavigate();
  const listRef = useRef<HTMLUListElement>(null);
  const [moreOpen, setMoreOpen] = useState(() => !!(filters.text || filters.runMode));

  const key = useDebounced(JSON.stringify(filters), DEBOUNCE_MS);
  useEffect(() => {
    load(connId);
  }, [connId, key, load]);

  // Moved with ↑ ↓: focus follows once the new row is selected.
  const focusSelected = useRef(false);
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    row?.scrollIntoView({ block: "nearest" });
    if (focusSelected.current) {
      focusSelected.current = false;
      row?.focus();
    }
  }, [selected, list?.rows]);

  const rows = list?.rows ?? [];
  const counts = useMemo(
    () => ({
      failed: rows.filter((r) => runTone(r.status) === "danger").length,
      waiting: rows.filter((r) => runTone(r.status) === "warning").length,
      running: rows.filter(isRunning).length,
    }),
    [rows]
  );

  const set = (patch: Partial<DesktopRunFilters>) => setFilters(connId, patch);
  const open = (id: string) => id.toLowerCase() !== selected && navigate(desktopRoute("runs", id), { replace: !!selected });
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      focusSelected.current = true;
      open(next.id);
    }
  };
  const loading = list?.status === "loading";
  const narrowed = JSON.stringify({ ...filters, range: DEFAULT_RUN_FILTERS.range }) !== JSON.stringify(DEFAULT_RUN_FILTERS);

  // A flow / machine picked elsewhere may not be in the lists (yet): keep it selectable.
  const flowOptions = flows.data ?? [];
  const groups = (machines.data?.groups ?? []).filter((g) => !g.implicit);
  const machineList = machines.data?.machines ?? [];
  const targetName = (target: string) => {
    const id = target.slice(2);
    return target.startsWith("g:") ? groups.find((g) => g.id === id)?.name : machineList.find((m) => m.id === id)?.name;
  };

  return (
    <div className="grid h-full grid-cols-[clamp(320px,32vw,420px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="flex items-center gap-2 px-3 pt-3">
          <select
            className="input min-w-0 flex-1 !h-9 !px-2 !text-[13px]"
            value={filters.flowId}
            onChange={(e) => set({ flowId: e.target.value })}
            aria-label="Desktop flow"
          >
            <SelectFace />
            <option value="">Every desktop flow</option>
            {filters.flowId && !flowOptions.some((f) => f.id === filters.flowId) && <option value={filters.flowId}>(this flow)</option>}
            {flowOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name || f.id}
              </option>
            ))}
          </select>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => load(connId, true)}
            disabled={loading}
            title="Read the newest runs again"
            aria-label="Refresh runs"
          >
            <Refresh size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 px-3 pt-2">
          <select className="input !h-8 !px-2 !text-[12.5px]" value={filters.range} onChange={(e) => set({ range: e.target.value as TimeRange })} aria-label="Time range">
            <SelectFace />
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <select
            className="input !h-8 !px-2 !text-[12.5px]"
            value={filters.status}
            onChange={(e) => set({ status: e.target.value as DesktopRunFilters["status"] })}
            aria-label="Status"
          >
            <SelectFace />
            {RUN_STATUSES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <select className="input col-span-2 !h-8 !px-2 !text-[12.5px]" value={filters.target} onChange={(e) => set({ target: e.target.value })} aria-label="Machine or machine group">
            <SelectFace />
            <option value="">Any machine</option>
            {filters.target && !targetName(filters.target) && <option value={filters.target}>(this {filters.target.startsWith("g:") ? "group" : "machine"})</option>}
            {groups.length > 0 && (
              <optgroup label="Machine groups">
                {groups.map((g) => (
                  <option key={g.id} value={`g:${g.id}`}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            )}
            {machineList.length > 0 && (
              <optgroup label="Machines">
                {machineList.map((m) => (
                  <option key={m.id} value={`m:${m.id}`}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="flex items-center justify-end px-3 pt-1.5">
          <button className="btn btn-ghost btn-sm" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} title="Filter by run mode or error text">
            More filters
            <ChevronDown size={12} className={`transition-transform ${moreOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
        {moreOpen && (
          <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-2 px-3">
            <select className="input !h-8 !px-2 !text-[12.5px]" value={filters.runMode} onChange={(e) => set({ runMode: e.target.value })} aria-label="Run mode">
              <SelectFace />
              {RUN_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <input
              className="input !h-8 !px-2 !text-[12.5px]"
              placeholder="Error message contains…"
              value={filters.text}
              onChange={(e) => set({ text: e.target.value })}
              aria-label="Error message contains"
            />
          </div>
        )}
        {filters.target && (
          <FilterChip
            label={filters.target.startsWith("g:") ? "One machine group" : "One machine"}
            value={targetName(filters.target) ?? `${filters.target.slice(2, 10)}…`}
            onClear={() => set({ target: "" })}
            clearLabel="Show every machine"
          />
        )}

        <div className="flex items-center justify-between px-4 pb-1.5 pt-3 text-[11.5px] text-subtle">
          <span className="min-w-0 truncate">
            {list?.status === "ready" || rows.length ? `${rows.length.toLocaleString()}${list?.next ? "+" : ""} run${rows.length === 1 ? "" : "s"}` : " "}
            {counts.failed > 0 && <span className="text-danger"> · {counts.failed} failed</span>}
            {counts.waiting > 0 && <span className="text-warning"> · {counts.waiting} waiting</span>}
            {counts.running > 0 && <span className="text-info"> · {counts.running} running</span>}
          </span>
          {list?.status === "ready" && (
            <span className="shrink-0 pl-2" title={new Date(list.at).toLocaleString()}>
              as of {logTime(new Date(list.at).toISOString())}
            </span>
          )}
        </div>

        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label="Desktop flow runs" onKeyDown={onListKey}>
          {list?.status === "error" ? (
            <li className="px-3 py-8 text-center text-xs text-subtle">
              <div className="text-warning">Couldn't read the desktop flow runs.</div>
              <div className="mt-1 break-words">{list.error}</div>
              <button className="btn btn-secondary btn-sm mt-3" onClick={() => load(connId, true)}>
                <Refresh size={12} /> Retry
              </button>
            </li>
          ) : !rows.length && (loading || !list) ? (
            <ListSkeleton />
          ) : rows.length === 0 ? (
            <li className="fade-in px-3 py-10 text-center">
              <div className="empty-icon">
                <Monitor size={18} />
              </div>
              <div className="mt-3 text-sm font-medium">No desktop flow runs</div>
              <div className="mt-1 text-xs text-subtle">
                {narrowed ? "Nothing matches these filters." : "Nothing ran in this time range."}
                {filters.range !== "all" && " Try a longer time range."}
              </div>
              <div className="mx-auto mt-2 max-w-xs text-[11.5px] text-subtle">
                Runs started from the Power Automate for desktop console are only kept here with a premium (or trial) license.
              </div>
            </li>
          ) : (
            <>
              {rows.map((r) => (
                <li key={r.id}>
                  <RunItem row={r} selected={r.id === selected} onOpen={() => open(r.id)} />
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
          <RunDetailPane
            key={selected}
            connId={connId}
            id={selected}
            row={rows.find((r) => r.id === selected) ?? null}
            filters={filters}
            onFilter={(patch) => set({ ...patch, range: "30d" })}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="empty-icon">
              <Monitor size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">No run selected</div>
              <div className="mt-0.5 max-w-sm text-xs text-subtle">
                Pick a desktop flow run on the left to see where it ran, how long it took, its inputs and outputs and why it failed. ↑ ↓ move through the list.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type TextTab = "error" | "inputs" | "outputs" | "details";

function RunDetailPane({
  connId,
  id,
  row,
  filters,
  onFilter,
}: {
  connId: string;
  id: string;
  row: DesktopRun | null;
  filters: DesktopRunFilters;
  onFilter: (patch: Partial<DesktopRunFilters>) => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const navigate = useNavigate();
  const key = detailKey(connId, id);
  const detail = useDesktopRuns((s) => s.details[key]);
  const error = useDesktopRuns((s) => s.detailErrors[key]);
  const loadDetail = useDesktopRuns((s) => s.loadDetail);
  const flows = desktopFlowsCache.useEntry(connId);
  const machines = machinesCache.useEntry(connId);

  useEffect(() => {
    loadDetail(connId, id);
  }, [connId, id, loadDetail]);

  // The list row shows the header right away; the detail fills in the rest.
  const r: (DesktopRun & Partial<DesktopRunDetail>) | null = detail ?? row;
  const [tab, setTab] = useState<TextTab | null>(null);
  const errorText = detail
    ? [detail.errorMessage.trim(), detail.errorDetails.trim() && detail.errorDetails.trim() !== detail.errorMessage.trim() ? detail.errorDetails.trim() : ""]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const tabs: { key: TextTab; label: string; text: string; empty: string }[] = detail
    ? [
        { key: "error" as const, label: "Error", text: errorText, empty: "This run has no error." },
        { key: "inputs" as const, label: "Inputs", text: detail.inputs ?? "", empty: detail.filesError ? `Couldn't read the inputs: ${detail.filesError}` : "This run had no inputs." },
        { key: "outputs" as const, label: "Outputs", text: detail.outputs ?? "", empty: detail.filesError ? `Couldn't read the outputs: ${detail.filesError}` : "This run had no outputs." },
        { key: "details" as const, label: "Run details", text: detail.runDetails, empty: "No run details." },
      ].filter((t) => (t.key === "error" ? !!t.text || runTone(detail.status) === "danger" : t.key !== "details" || !!t.text.trim()))
    : [];
  const current = tabs.find((x) => x.key === tab) ?? tabs[0] ?? null;

  // A running run's duration counts up.
  const running = !!r && isRunning(r);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));

  if (!r) {
    return error ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
        <AlertTriangle size={18} className="text-warning" />
        <div className="font-medium">Couldn't read this run</div>
        <div className="max-w-xl break-words text-xs text-subtle">{error}</div>
      </div>
    ) : (
      <div className="space-y-3 p-8">
        <div className="skeleton h-5 w-1/3" />
        <div className="skeleton h-3 w-1/2" />
        <div className="skeleton mt-6 h-16" />
      </div>
    );
  }

  const tone = runTone(r.status);
  const duration = runDuration(r, now);
  const knownFlow = !!r.flowId && !!flows.data?.some((f) => f.id === r.flowId);
  const knownMachine = !!r.machineId && !!machines.data?.machines.some((m) => m.id === r.machineId);
  // The parent is a desktop flow when we know it as one; otherwise a cloud flow.
  const parentIsDesktop = !!r.parentFlowId && !!flows.data?.some((f) => f.id === r.parentFlowId);
  const openParent = () =>
    r.parentFlowId && navigate(parentIsDesktop ? desktopRoute("flows", r.parentFlowId) : flowRoute(r.parentFlowId));

  return (
    <div className="fade-in flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pb-5 pt-7 xl:px-8 short:pb-3 short:pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={r.flowName ?? r.name}>
                {r.flowName || r.name || "(unknown flow)"}
              </h2>
              <span className={`badge badge-dot ${TONE_BADGE[tone]}`}>{r.statusLabel}</span>
              {r.runModeLabel && <span className="badge badge-neutral">{r.runModeLabel}</span>}
              {r.test && <span className="badge badge-brand">Test run</span>}
            </div>
            <p className="mt-0.5 truncate text-sm text-muted">
              {[r.trigger ? `Started by ${r.trigger}` : null, r.processVersion ? `version ${r.processVersion}` : null, r.owner || null].filter(Boolean).join(" · ") || " "}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {r.flowId && !filters.flowId && (
              <button className="btn btn-ghost" onClick={() => onFilter({ flowId: r.flowId! })} title="List every run of this flow">
                <Search size={14} /> Same flow
              </button>
            )}
            {r.machineId && !filters.target && (
              <button className="btn btn-ghost" onClick={() => onFilter({ target: `m:${r.machineId}` })} title="List every run on this machine">
                <Search size={14} /> Same machine
              </button>
            )}
          </div>
        </div>

        {r.error && (
          <p className="mt-3 line-clamp-3 max-w-4xl rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger short:line-clamp-1">
            {r.errorCode && <b className="mr-1.5 font-mono text-[12px]">{r.errorCode}</b>}
            {r.error}
          </p>
        )}

        <div className="card mt-4 grid grid-cols-4 divide-x divide-line">
          <Stat label="Flow">
            {r.flowId && knownFlow ? (
              <button className="min-w-0 truncate text-left hover:text-brand hover:underline" onClick={() => navigate(desktopRoute("flows", r.flowId))} title="Open the flow">
                {r.flowName || r.flowId}
              </button>
            ) : (
              <span className="truncate">{r.flowName || "—"}</span>
            )}
          </Stat>
          <Stat label="Machine">
            {r.machineId && knownMachine ? (
              <button className="min-w-0 truncate text-left hover:text-brand hover:underline" onClick={() => navigate(desktopRoute("machines", r.machineId))} title="Open the machine">
                {r.machineName || r.machineId}
              </button>
            ) : (
              <span className="truncate">{r.machineName || r.groupName || "—"}</span>
            )}
          </Stat>
          <Stat label="Duration">
            <span className="tabular-nums">{duration !== null ? formatDuration(duration) : running ? "running" : "—"}</span>
            {running && <Loader size={12} className="ml-1.5 text-info" />}
          </Stat>
          <Stat label="Created">
            <span className="truncate tabular-nums" title={new Date(r.createdOn).toLocaleString()}>
              {new Date(r.createdOn).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </Stat>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-8">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-4 gap-y-1 text-xs">
            {(
              [
                ["Started", r.startedOn ? new Date(r.startedOn).toLocaleString() : null],
                ["Completed", r.completedOn ? new Date(r.completedOn).toLocaleString() : null],
                ["Machine group", r.groupName && r.groupName !== r.machineName ? r.groupName : null],
                ["Windows user", r.sessionUser],
                ["Run by", r.owner || null],
                ["Created by", r.createdBy && r.createdBy !== r.owner ? r.createdBy : null],
              ] as const
            ).map(([label, value]) =>
              value ? (
                <div key={label} className="contents">
                  <dt className="eyebrow leading-5">{label}</dt>
                  <dd className="truncate leading-5 text-muted">{value}</dd>
                </div>
              ) : null
            )}
            {r.parentFlowId && (
              <div className="contents">
                <dt className="eyebrow leading-5">Started by flow</dt>
                <dd className="truncate leading-5">
                  <button className="text-muted hover:text-brand hover:underline" onClick={openParent} title={parentIsDesktop ? "Open the parent desktop flow" : "Open the cloud flow in the Flows tool"}>
                    {(parentIsDesktop && flows.data?.find((f) => f.id === r.parentFlowId)?.name) || (parentIsDesktop ? "Desktop flow" : "Cloud flow")} ↗
                  </button>
                </dd>
              </div>
            )}
          </dl>
          <IdList
            ids={[
              ["Run", r.id],
              ["Flow", r.flowId],
              ["Cloud flow run", r.parentCloudRun],
              ["Parent run", r.parentDesktopRun],
              ["Correlation", r.correlationId],
              ["Connection", r.connectionId],
            ]}
            onCopy={(v, label) => copy(v, `${label} id`)}
          />
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-end gap-1 border-t border-b border-line bg-s1 px-4" role="tablist" aria-label="Run details">
        {detail ? (
          <>
            {tabs.map((x) => (
              <button key={x.key} role="tab" aria-selected={current?.key === x.key} className="tab h-9" onClick={() => setTab(x.key)}>
                {x.label}
              </button>
            ))}
            {current?.text.trim() && (
              <button className="btn btn-ghost btn-sm mb-1 ml-auto" onClick={() => copy(current.text, current.label.toLowerCase())}>
                <Copy size={12} /> Copy
              </button>
            )}
          </>
        ) : (
          <span className="flex h-9 items-center gap-1.5 text-xs text-subtle">
            {error ? (
              <span className="text-warning" title={error}>
                Couldn't read the run's details.
              </span>
            ) : (
              <>
                <Loader size={12} className="text-brand" /> Reading the run…
              </>
            )}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1" style={{ background: "var(--editor-bg)" }}>
        {current && <LogText path={`desktop-run-${id}-${current.key}.txt`} text={current.text} empty={current.empty} />}
      </div>
    </div>
  );
}

