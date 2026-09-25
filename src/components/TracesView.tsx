import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useStore } from "../store";
import {
  RANGES,
  detailKey,
  filterKey,
  filtersOf,
  formatDuration,
  shortType,
  traceTime,
  useTraces,
  type TraceFilters,
  type TraceRange,
} from "../lib/traces";
import { ROUTES, pluginRoute, traceRoute } from "../lib/navigation";
import { DEFAULT_JOB_FILTERS, useJobs } from "../lib/jobs";
import { useDebounced } from "../lib/useDebounced";
import { FilterChip, IdList, ListSkeleton, LogText, Stat } from "./LogParts";
import { Search, Refresh, Copy, Bug, AlertTriangle, Loader, Info, ChevronDown, Activity, Plug } from "./Icon";
import type { TraceDetail, TraceRow } from "../types";

/** Typing in a filter box waits this long before asking the server. */
const DEBOUNCE_MS = 400;

export function TracesView() {
  const activeId = useStore((s) => s.activeId);
  const connection = useStore((s) => s.connections.find((c) => c.id === s.activeId) ?? null);
  const filters = useTraces((s) => filtersOf(s, activeId));
  const list = useTraces((s) => (activeId ? s.lists[activeId] : undefined));
  const setFilters = useTraces((s) => s.setFilters);
  const load = useTraces((s) => s.load);
  const loadMore = useTraces((s) => s.loadMore);

  const { traceId } = useParams();
  const selected = traceId?.toLowerCase() ?? null;
  const navigate = useNavigate();
  const listRef = useRef<HTMLUListElement>(null);
  const [moreOpen, setMoreOpen] = useState(() => !!(filters.text || filters.minDuration));

  // Every change reads the list again; typing waits a moment first.
  const key = useDebounced(filterKey(filters), DEBOUNCE_MS);
  useEffect(() => {
    if (activeId) load(activeId);
  }, [activeId, key, load]);

  // Another environment: its traces differ. Not on first render, so a deep link keeps its trace.
  const prevActiveId = useRef(activeId);
  useEffect(() => {
    if (prevActiveId.current && prevActiveId.current !== activeId) navigate(ROUTES.traces, { replace: true });
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
  const failed = useMemo(() => rows.filter((r) => r.exception).length, [rows]);

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        Select an environment to see its plug-in trace logs.
      </div>
    );
  }

  const set = (patch: Partial<TraceFilters>) => setFilters(activeId, patch);
  const open = (id: string) => id.toLowerCase() !== selected && navigate(traceRoute(id), { replace: !!selected });
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
  const narrowed = !!(
    filters.typeName.trim() ||
    filters.message.trim() ||
    filters.entity.trim() ||
    filters.mode ||
    filters.exceptionsOnly ||
    filters.correlationId ||
    filters.text.trim() ||
    filters.minDuration.trim()
  );

  return (
    <div className="grid h-full grid-cols-[clamp(320px,32vw,420px)_minmax(0,1fr)]">
      {/* Trace list */}
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              className="input !pl-8"
              placeholder="Plug-in class…"
              value={filters.typeName}
              onChange={(e) => set({ typeName: e.target.value })}
              aria-label="Filter by plug-in class name"
            />
          </div>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => load(activeId, true)}
            disabled={loading}
            title="Read the newest traces again"
            aria-label="Refresh traces"
          >
            <Refresh size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 px-3 pt-2">
          <select
            className="input !h-8 !px-2 !text-[12.5px]"
            value={filters.range}
            onChange={(e) => set({ range: e.target.value as TraceRange })}
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
            value={filters.mode}
            onChange={(e) => set({ mode: e.target.value as TraceFilters["mode"] })}
            aria-label="Execution mode"
          >
            <option value="">Sync and async</option>
            <option value="0">Synchronous</option>
            <option value="1">Asynchronous</option>
          </select>
          <input
            className="input !h-8 !px-2 !text-[12.5px]"
            placeholder="Message (Create…)"
            value={filters.message}
            onChange={(e) => set({ message: e.target.value })}
            aria-label="Filter by message name"
          />
          <input
            className="input !h-8 !px-2 !text-[12.5px]"
            placeholder="Table (account…)"
            value={filters.entity}
            onChange={(e) => set({ entity: e.target.value })}
            aria-label="Filter by table logical name"
          />
        </div>

        <div className="flex items-center gap-2 px-3 pt-2.5">
          <div className="seg !flex flex-1" role="group" aria-label="Filter by outcome">
            <button className="flex-1" aria-pressed={!filters.exceptionsOnly} onClick={() => set({ exceptionsOnly: false })}>
              All
            </button>
            <button className="flex-1" aria-pressed={filters.exceptionsOnly} onClick={() => set({ exceptionsOnly: true })}>
              Exceptions
            </button>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            title="Search the trace text, slow runs"
          >
            More
            <ChevronDown size={12} className={`transition-transform ${moreOpen ? "rotate-180" : ""}`} />
          </button>
        </div>

        {moreOpen && (
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2 px-3 pt-2">
            <input
              className="input !h-8 !px-2 !text-[12.5px]"
              placeholder="Trace or exception contains…"
              value={filters.text}
              onChange={(e) => set({ text: e.target.value })}
              aria-label="Trace text or exception contains"
            />
            <input
              className="input !h-8 !px-2 !text-[12.5px]"
              placeholder="Min ms"
              inputMode="numeric"
              value={filters.minDuration}
              onChange={(e) => set({ minDuration: e.target.value.replace(/\D/g, "") })}
              aria-label="Minimum duration in milliseconds"
              title="Runs that took at least this many milliseconds"
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

        {list?.first?.logging === 0 ? (
          <Notice tone="warning">
            Trace logging is <b>off</b> in {connection?.name ?? "this environment"}. Turn it on in System Settings →
            Customization → “Enable logging to plug-in trace log”.
          </Notice>
        ) : list?.first?.logging === 1 ? (
          <Notice tone="info">Only runs that threw are logged here (the setting is “Exception”).</Notice>
        ) : null}

        <div className="flex items-center justify-between px-4 pb-1.5 pt-3 text-[11.5px] text-subtle">
          <span>
            {list?.status === "ready" || rows.length
              ? `${rows.length.toLocaleString()}${list?.next ? "+" : ""} trace${rows.length === 1 ? "" : "s"}`
              : " "}
            {failed > 0 && <span className="text-danger"> · {failed} with exceptions</span>}
          </span>
          {list?.status === "ready" && <span title={new Date(list.at).toLocaleString()}>as of {traceTime(new Date(list.at).toISOString())}</span>}
        </div>

        <ul
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          role="listbox"
          aria-label="Trace logs"
          onKeyDown={onListKey}
        >
          {list?.status === "error" ? (
            <li className="px-3 py-8 text-center text-xs text-subtle">
              <div className="text-warning">Couldn't read the trace logs.</div>
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
                <Bug size={18} />
              </div>
              <div className="mt-3 text-sm font-medium">No trace logs</div>
              <div className="mt-1 text-xs text-subtle">
                {narrowed ? "Nothing matches these filters." : "Nothing was logged in this time range."}
                {filters.range !== "all" && " Try a longer time range."}
              </div>
            </li>
          ) : (
            <>
              {rows.map((r) => (
                <li key={r.id}>
                  <TraceItem row={r} selected={r.id.toLowerCase() === selected} onOpen={() => open(r.id)} />
                </li>
              ))}
              {list?.next && (
                <li className="px-2 pt-2">
                  <button
                    className="btn btn-secondary btn-sm w-full justify-center"
                    onClick={() => loadMore(activeId)}
                    disabled={list.loadingMore}
                  >
                    {list.loadingMore ? <Loader size={12} /> : null}
                    {list.loadingMore ? "Loading…" : "Load more"}
                  </button>
                </li>
              )}
              {list?.error && list.status === "ready" && (
                <li className="px-3 pt-2 text-center text-xs text-warning">{list.error}</li>
              )}
            </>
          )}
        </ul>
      </div>

      {/* Detail */}
      <div className="min-h-0 overflow-hidden">
        {selected ? (
          <TraceDetailPane
            key={selected}
            connId={activeId}
            id={selected}
            row={rows.find((r) => r.id.toLowerCase() === selected) ?? null}
            onChain={(correlationId) => set({ correlationId, range: "all" })}
            chainActive={!!filters.correlationId}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="empty-icon">
              <Bug size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">No trace selected</div>
              <div className="mt-0.5 max-w-sm text-xs text-subtle">
                Pick a trace on the left to read what the plug-in wrote and why it failed. ↑ ↓ move through the list.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warning" | "info"; children: React.ReactNode }) {
  const style = tone === "warning" ? "border-warning/30 bg-warning/10" : "border-info/30 bg-info/10";
  return (
    <div className={`mx-3 mt-2.5 flex gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] leading-relaxed ${style}`} role="status">
      {tone === "warning" ? (
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
      ) : (
        <Info size={13} className="mt-0.5 shrink-0 text-info" />
      )}
      <span>{children}</span>
    </div>
  );
}

function TraceItem({ row, selected, onOpen }: { row: TraceRow; selected: boolean; onOpen: () => void }) {
  const failed = !!row.exception;
  return (
    <button
      role="option"
      aria-selected={selected}
      aria-current={selected ? "page" : undefined}
      tabIndex={selected ? 0 : -1}
      className="nav-item nav-item-tall !items-start"
      onClick={onOpen}
      title={row.typeName}
    >
      <span
        className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${failed ? "bg-danger" : "bg-line-strong"}`}
        aria-label={failed ? "Threw an exception" : "Completed"}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{shortType(row.typeName) || "(no class)"}</span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-subtle">{traceTime(row.createdOn)}</span>
        </span>
        <span className="block truncate text-xs font-normal text-subtle">
          {[row.message, row.entity || null, formatDuration(row.durationMs), row.mode === 1 ? "async" : null, row.depth > 1 ? `depth ${row.depth}` : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {row.exception && <span className="block truncate text-xs font-normal text-danger">{row.exception}</span>}
      </span>
    </button>
  );
}

type TextTab = "exception" | "trace" | "configuration";

function TraceDetailPane({
  connId,
  id,
  row,
  onChain,
  chainActive,
}: {
  connId: string;
  id: string;
  row: TraceRow | null;
  onChain: (correlationId: string) => void;
  chainActive: boolean;
}) {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.pushToast);
  const key = detailKey(connId, id);
  const detail = useTraces((s) => s.details[key]);
  const error = useTraces((s) => s.detailErrors[key]);
  const loadDetail = useTraces((s) => s.loadDetail);

  useEffect(() => {
    loadDetail(connId, id);
  }, [connId, id, loadDetail]);

  // The list row shows the header right away; the detail fills in the rest.
  const t: (TraceRow & Partial<TraceDetail>) | null = detail ?? row;
  const [tab, setTab] = useState<TextTab | null>(null);
  const tabs: { key: TextTab; label: string; text: string }[] = detail
    ? ([
        detail.exceptionDetails && { key: "exception", label: "Exception", text: detail.exceptionDetails },
        { key: "trace", label: "Trace", text: detail.messageBlock },
        detail.configuration && { key: "configuration", label: "Configuration", text: detail.configuration },
      ].filter(Boolean) as { key: TextTab; label: string; text: string }[])
    : [];
  const current = tabs.find((x) => x.key === tab) ?? tabs[0] ?? null;

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));

  if (!t) {
    return error ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
        <AlertTriangle size={18} className="text-warning" />
        <div className="font-medium">Couldn't read this trace</div>
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

  const failed = !!t.exception;
  return (
    <div className="fade-in flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pb-5 pt-7 xl:px-8 short:pb-3 short:pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={t.typeName}>
                {shortType(t.typeName) || "(no class)"}
              </h2>
              <span className={`badge badge-dot ${failed ? "badge-danger" : "badge-success"}`}>
                {failed ? "Exception" : "Completed"}
              </span>
              <span className="badge badge-neutral">{t.modeLabel}</span>
              <span className="badge badge-neutral">{t.operationLabel}</span>
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-subtle" title={t.typeName}>
              {t.typeName}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {t.correlationId && t.mode === 1 && (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  useJobs.getState().setFilters(connId, { ...DEFAULT_JOB_FILTERS, correlationId: t.correlationId!, range: "all" });
                  navigate(ROUTES.jobs);
                }}
                title="The system job that ran this asynchronous plug-in (same correlation id)"
              >
                <Activity size={14} /> System job
              </button>
            )}
            {t.stepId && (
              <button className="btn btn-ghost" onClick={() => navigate(pluginRoute(`step:${t.stepId}`))} title="The plug-in step registration that ran">
                <Plug size={14} /> Plug-in step
              </button>
            )}
            {t.correlationId && !chainActive && (
              <button
                className="btn btn-secondary"
                onClick={() => onChain(t.correlationId!)}
                title="List every trace of this execution chain (same correlation id)"
              >
                <Search size={14} /> Same chain
              </button>
            )}
            <button className="btn btn-ghost" disabled={!current} onClick={() => current && copy(current.text, current.label.toLowerCase())}>
              <Copy size={14} /> Copy {current ? current.label.toLowerCase() : "text"}
            </button>
          </div>
        </div>

        {t.exception && (
          <p className="mt-3 line-clamp-3 max-w-4xl rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger short:line-clamp-1">
            {t.exception}
          </p>
        )}

        <div className="card mt-4 grid grid-cols-4 divide-x divide-line">
          <Stat label="Message">
            <span className="truncate">{t.message || "—"}</span>
            {t.entity && <span className="ml-1.5 font-mono text-xs text-subtle">{t.entity}</span>}
          </Stat>
          <Stat label="Duration">
            <span className="tabular-nums">{formatDuration(t.durationMs)}</span>
            {t.constructorMs ? <span className="ml-1.5 text-xs text-subtle" title="Time to construct the plug-in">+{formatDuration(t.constructorMs)} ctor</span> : null}
          </Stat>
          <Stat label="Created">
            <span className="tabular-nums" title={t.createdOn}>
              {t.createdOn ? new Date(t.createdOn).toLocaleString() : "—"}
            </span>
          </Stat>
          <Stat label="Depth · by">
            <span className="tabular-nums">{t.depth}</span>
            {t.createdBy && <span className="ml-1.5 text-xs text-subtle">{t.createdBy}</span>}
          </Stat>
        </div>

        <IdList
          ids={[
            ["Correlation", t.correlationId],
            ["Request", t.requestId],
            ["Step", t.stepId],
            ["Trace", t.id],
          ]}
          onCopy={(v, label) => copy(v, `${label} id`)}
        />
      </div>

      <div className="flex h-9 shrink-0 items-end gap-1 border-t border-b border-line bg-s1 px-4" role="tablist" aria-label="Trace text">
        {detail ? (
          tabs.map((x) => (
            <button key={x.key} role="tab" aria-selected={current?.key === x.key} className="tab h-9" onClick={() => setTab(x.key)}>
              {x.label}
            </button>
          ))
        ) : (
          <span className="flex h-9 items-center gap-1.5 text-xs text-subtle">
            {error ? (
              <span className="text-warning" title={error}>
                Couldn't read the trace text.
              </span>
            ) : (
              <>
                <Loader size={12} className="text-brand" /> Reading the trace…
              </>
            )}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1" style={{ background: "var(--editor-bg)" }}>
        {current && (
          <LogText
            path={`trace-${id}-${current.key}.txt`}
            text={current.text}
            empty={current.key === "trace" ? "The plug-in didn't write anything to the trace." : "Empty."}
          />
        )}
      </div>
    </div>
  );
}
