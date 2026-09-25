import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useStore } from "../store";
import {
  DEFAULT_JOB_FILTERS,
  JOB_STATUSES,
  JOB_TYPES,
  TONE_BADGE,
  TONE_DOT,
  hexCode,
  jobDuration,
  jobFiltersOf,
  jobTone,
  useJobs,
  type JobFilters,
} from "../lib/jobs";
import { RANGES, detailKey, formatDuration, logTime, type TimeRange } from "../lib/pagedStore";
import { DEFAULT_FILTERS as DEFAULT_TRACE_FILTERS, useTraces } from "../lib/traces";
import { useDebounced } from "../lib/useDebounced";
import { ROUTES, jobRoute } from "../lib/navigation";
import { FilterChip, IdList, ListSkeleton, LogText, Stat } from "./LogParts";
import { Search, Refresh, Copy, Activity, AlertTriangle, Loader, ChevronDown, ArrowUpRight, Bug } from "./Icon";
import type { JobDetail, JobRow } from "../types";

const DEBOUNCE_MS = 400;

export function JobsView() {
  const activeId = useStore((s) => s.activeId);
  const filters = useJobs((s) => jobFiltersOf(s, activeId));
  const list = useJobs((s) => (activeId ? s.lists[activeId] : undefined));
  const setFilters = useJobs((s) => s.setFilters);
  const load = useJobs((s) => s.load);
  const loadMore = useJobs((s) => s.loadMore);

  const { jobId } = useParams();
  const selected = jobId?.toLowerCase() ?? null;
  const navigate = useNavigate();
  const listRef = useRef<HTMLUListElement>(null);
  const [moreOpen, setMoreOpen] = useState(() => !!(filters.entity || filters.text));

  const key = useDebounced(JSON.stringify(filters), DEBOUNCE_MS);
  useEffect(() => {
    if (activeId) load(activeId);
  }, [activeId, key, load]);

  // Another environment: its jobs differ. Not on first render, so a deep link keeps its job.
  const prevActiveId = useRef(activeId);
  useEffect(() => {
    if (prevActiveId.current && prevActiveId.current !== activeId) navigate(ROUTES.jobs, { replace: true });
    prevActiveId.current = activeId;
  }, [activeId, navigate]);

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
      failed: rows.filter((r) => r.status === 31).length,
      waiting: rows.filter((r) => r.status === 10 || r.status === 0).length,
      running: rows.filter((r) => r.state === 2).length,
    }),
    [rows]
  );

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        Select an environment to see its system jobs.
      </div>
    );
  }

  const set = (patch: Partial<JobFilters>) => setFilters(activeId, patch);
  const open = (id: string) => id.toLowerCase() !== selected && navigate(jobRoute(id), { replace: !!selected });
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id.toLowerCase() === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      focusSelected.current = true;
      open(next.id);
    }
  };
  const loading = list?.status === "loading";
  const narrowed = JSON.stringify({ ...filters, range: DEFAULT_JOB_FILTERS.range }) !== JSON.stringify(DEFAULT_JOB_FILTERS);

  return (
    <div className="grid h-full grid-cols-[clamp(320px,32vw,420px)_minmax(0,1fr)]">
      {/* Job list */}
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              className="input !pl-8"
              placeholder="Job name…"
              value={filters.name}
              onChange={(e) => set({ name: e.target.value })}
              aria-label="Filter by job name"
            />
          </div>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => load(activeId, true)}
            disabled={loading}
            title="Read the newest jobs again"
            aria-label="Refresh jobs"
          >
            <Refresh size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 px-3 pt-2">
          <select
            className="input !h-8 !px-2 !text-[12.5px]"
            value={filters.range}
            onChange={(e) => set({ range: e.target.value as TimeRange })}
            aria-label="Time range"
          >
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <select
            className="input !h-8 !px-2 !text-[12.5px]"
            value={filters.status}
            onChange={(e) => set({ status: e.target.value as JobFilters["status"] })}
            aria-label="Status"
          >
            {JOB_STATUSES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            className="input col-span-2 !h-8 !px-2 !text-[12.5px]"
            value={filters.operationType}
            onChange={(e) => set({ operationType: e.target.value })}
            aria-label="Job type"
          >
            {JOB_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-end px-3 pt-1.5">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            title="Filter by table or error text"
          >
            More filters
            <ChevronDown size={12} className={`transition-transform ${moreOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
        {moreOpen && (
          <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 px-3">
            <input
              className="input !h-8 !px-2 !text-[12.5px]"
              placeholder="Table…"
              value={filters.entity}
              onChange={(e) => set({ entity: e.target.value })}
              aria-label="Filter by table logical name"
            />
            <input
              className="input !h-8 !px-2 !text-[12.5px]"
              placeholder="Error message contains…"
              value={filters.text}
              onChange={(e) => set({ text: e.target.value })}
              aria-label="Error message contains"
            />
          </div>
        )}

        {filters.correlationId && (
          <FilterChip
            label="One execution chain"
            value={`${filters.correlationId.slice(0, 8)}…`}
            title={filters.correlationId}
            onClear={() => set({ correlationId: "" })}
            clearLabel="Show every chain"
          />
        )}
        {filters.regardingId && (
          <FilterChip
            label="One record"
            value={filters.regardingName || `${filters.regardingId.slice(0, 8)}…`}
            title={filters.regardingId}
            onClear={() => set({ regardingId: "", regardingName: "" })}
            clearLabel="Show every record"
          />
        )}

        <div className="flex items-center justify-between px-4 pb-1.5 pt-3 text-[11.5px] text-subtle">
          <span className="min-w-0 truncate">
            {list?.status === "ready" || rows.length
              ? `${rows.length.toLocaleString()}${list?.next ? "+" : ""} job${rows.length === 1 ? "" : "s"}`
              : " "}
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

        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label="System jobs" onKeyDown={onListKey}>
          {list?.status === "error" ? (
            <li className="px-3 py-8 text-center text-xs text-subtle">
              <div className="text-warning">Couldn't read the system jobs.</div>
              <div className="mt-1 break-words">{list.error}</div>
              <button className="btn btn-secondary btn-sm mt-3" onClick={() => load(activeId, true)}>
                <Refresh size={12} /> Retry
              </button>
            </li>
          ) : !rows.length && (loading || !list) ? (
            <ListSkeleton />
          ) : rows.length === 0 ? (
            <li className="fade-in px-3 py-10 text-center">
              <div className="empty-icon">
                <Activity size={18} />
              </div>
              <div className="mt-3 text-sm font-medium">No system jobs</div>
              <div className="mt-1 text-xs text-subtle">
                {narrowed ? "Nothing matches these filters." : "Nothing ran in this time range."}
                {filters.range !== "all" && " Try a longer time range."}
              </div>
            </li>
          ) : (
            <>
              {rows.map((r) => (
                <li key={r.id}>
                  <JobItem row={r} selected={r.id.toLowerCase() === selected} onOpen={() => open(r.id)} />
                </li>
              ))}
              {list?.next && (
                <li className="px-2 pt-2">
                  <button className="btn btn-secondary btn-sm w-full justify-center" onClick={() => loadMore(activeId)} disabled={list.loadingMore}>
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

      {/* Detail */}
      <div className="min-h-0 overflow-hidden">
        {selected ? (
          <JobDetailPane
            key={selected}
            connId={activeId}
            id={selected}
            row={rows.find((r) => r.id.toLowerCase() === selected) ?? null}
            filters={filters}
            onFilter={(patch) => set({ ...patch, range: "all" })}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="empty-icon">
              <Activity size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">No job selected</div>
              <div className="mt-0.5 max-w-sm text-xs text-subtle">
                Pick a system job on the left to see when it ran, what it was about and why it failed. ↑ ↓ move through the list.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function JobItem({ row, selected, onOpen }: { row: JobRow; selected: boolean; onOpen: () => void }) {
  const tone = jobTone(row.status);
  const duration = jobDuration(row);
  return (
    <button
      role="option"
      aria-selected={selected}
      aria-current={selected ? "page" : undefined}
      tabIndex={selected ? 0 : -1}
      className="nav-item nav-item-tall !items-start"
      onClick={onOpen}
      title={row.name}
    >
      <span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]} ${tone === "info" ? "animate-pulse" : ""}`} aria-label={row.statusLabel} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{row.name || "(no name)"}</span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-subtle">{logTime(row.createdOn)}</span>
        </span>
        <span className="block truncate text-xs font-normal text-subtle">
          {[row.statusLabel, row.operationLabel, row.entity || null, duration !== null ? formatDuration(duration) : null].filter(Boolean).join(" · ")}
        </span>
        {row.error && <span className="block truncate text-xs font-normal text-danger">{row.error}</span>}
      </span>
    </button>
  );
}

type TextTab = "message" | "friendly";

function JobDetailPane({
  connId,
  id,
  row,
  filters,
  onFilter,
}: {
  connId: string;
  id: string;
  row: JobRow | null;
  filters: JobFilters;
  onFilter: (patch: Partial<JobFilters>) => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const navigate = useNavigate();
  const key = detailKey(connId, id);
  const detail = useJobs((s) => s.details[key]);
  const error = useJobs((s) => s.detailErrors[key]);
  const loadDetail = useJobs((s) => s.loadDetail);

  useEffect(() => {
    loadDetail(connId, id);
  }, [connId, id, loadDetail]);

  // The list row shows the header right away; the detail fills in the rest.
  const j: (JobRow & Partial<JobDetail>) | null = detail ?? row;
  const [tab, setTab] = useState<TextTab | null>(null);
  const tabs: { key: TextTab; label: string; text: string }[] = detail
    ? ([
        { key: "message", label: "Message", text: detail.message },
        detail.friendlyMessage.trim() && detail.friendlyMessage.trim() !== detail.message.trim()
          ? { key: "friendly", label: "Friendly message", text: detail.friendlyMessage }
          : null,
      ].filter(Boolean) as { key: TextTab; label: string; text: string }[])
    : [];
  const current = tabs.find((x) => x.key === tab) ?? tabs[0] ?? null;

  // A running job's duration counts up.
  const running = j?.state === 2;
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

  if (!j) {
    return error ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
        <AlertTriangle size={18} className="text-warning" />
        <div className="font-medium">Couldn't read this job</div>
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

  const tone = jobTone(j.status);
  const duration = jobDuration(j, now);
  const openTraces = () => {
    useTraces.getState().setFilters(connId, { ...DEFAULT_TRACE_FILTERS, correlationId: j.correlationId!, range: "all" });
    navigate(ROUTES.traces);
  };
  const openRecord = () =>
    api.openRecord(connId, j.regardingTable!, j.regardingId!).catch((e) => pushToast({ tone: "error", title: "Couldn't open the record", body: String(e) }));

  return (
    <div className="fade-in flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pb-5 pt-7 xl:px-8 short:pb-3 short:pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={j.name}>
                {j.name || "(no name)"}
              </h2>
              <span className={`badge badge-dot ${TONE_BADGE[tone]}`}>{j.statusLabel}</span>
              <span className="badge badge-neutral">{j.operationLabel}</span>
              {j.retryCount > 0 && <span className="badge badge-warning">retried {j.retryCount}×</span>}
            </div>
            <p className="mt-0.5 truncate text-sm text-muted">
              {[j.process && j.process !== j.name ? j.process : null, j.messageName || null, j.stage ? `stage ${j.stage}` : null].filter(Boolean).join(" · ") ||
                `${j.owner || "Unknown owner"}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {j.correlationId && (
              <button className="btn btn-secondary" onClick={openTraces} title="Plug-in trace logs of the same execution chain">
                <Bug size={14} /> Trace logs
              </button>
            )}
            {j.correlationId && !filters.correlationId && (
              <button className="btn btn-ghost" onClick={() => onFilter({ correlationId: j.correlationId! })} title="List every job of this execution chain">
                <Search size={14} /> Same chain
              </button>
            )}
            {j.regardingId && !filters.regardingId && (
              <button
                className="btn btn-ghost"
                onClick={() => onFilter({ regardingId: j.regardingId!, regardingName: j.regardingName ?? "" })}
                title="List every job about this record"
              >
                <Search size={14} /> Same record
              </button>
            )}
          </div>
        </div>

        {j.error && (
          <p className="mt-3 line-clamp-3 max-w-4xl rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger short:line-clamp-1">
            {j.error}
          </p>
        )}
        {j.status === 10 && j.postponeUntil && (
          <p className="mt-3 max-w-4xl rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
            Waiting until <b>{new Date(j.postponeUntil).toLocaleString()}</b>
          </p>
        )}

        <div className="card mt-4 grid grid-cols-4 divide-x divide-line">
          <Stat label="Regarding">
            {j.regardingId ? (
              j.regardingTable ? (
                <button className="min-w-0 truncate text-left hover:text-brand hover:underline" onClick={openRecord} title="Open the record in Dataverse">
                  {j.regardingName || j.regardingId}
                  <ArrowUpRight size={12} className="ml-1 inline" />
                </button>
              ) : (
                <span className="truncate">{j.regardingName || j.regardingId}</span>
              )
            ) : (
              <span className="text-subtle">—</span>
            )}
          </Stat>
          <Stat label="Duration">
            <span className="tabular-nums">{duration !== null ? formatDuration(duration) : j.state === 2 ? "running" : "—"}</span>
            {j.state === 2 && <Loader size={12} className="ml-1.5 text-info" />}
          </Stat>
          <Stat label="Created">
            <span className="truncate tabular-nums" title={j.createdOn ? new Date(j.createdOn).toLocaleString() : undefined}>
              {j.createdOn
                ? new Date(j.createdOn).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
                : "—"}
            </span>
          </Stat>
          <Stat label="Owner">
            <span className="truncate">{j.owner || "—"}</span>
          </Stat>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-8">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-4 gap-y-1 text-xs">
            {(
              [
                ["Table", j.entity || null],
                ["Started", j.startedOn ? new Date(j.startedOn).toLocaleString() : null],
                ["Completed", j.completedOn ? new Date(j.completedOn).toLocaleString() : null],
                ["Depth", j.depth > 0 ? String(j.depth) : null],
                ["Error code", j.errorCode !== null ? `${hexCode(j.errorCode)} (${j.errorCode})` : null],
                ["Created by", j.createdBy || null],
              ] as const
            ).map(([label, value]) =>
              value ? (
                <div key={label} className="contents">
                  <dt className="eyebrow leading-5">{label}</dt>
                  <dd className="truncate leading-5 text-muted">{value}</dd>
                </div>
              ) : null
            )}
          </dl>
          <IdList
            ids={[
              ["Correlation", j.correlationId],
              ["Request", j.requestId],
              ["Record", j.regardingId],
              ["Job", j.id],
            ]}
            onCopy={(v, label) => copy(v, `${label} id`)}
          />
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-end gap-1 border-t border-b border-line bg-s1 px-4" role="tablist" aria-label="Job messages">
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
                Couldn't read the job's message.
              </span>
            ) : (
              <>
                <Loader size={12} className="text-brand" /> Reading the job…
              </>
            )}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1" style={{ background: "var(--editor-bg)" }}>
        {current && <LogText path={`job-${id}-${current.key}.txt`} text={current.text} empty="This job has no message." />}
      </div>
    </div>
  );
}
