// Flow runs › Errors: failures grouped by error code (counted by the summary
// scan), and for one code the flows it hit and what its runs' messages say
// (read from the newest failed runs with that code).
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  SAMPLE_MAX,
  bars as toBars,
  codeLabel,
  errorSamples,
  errorText,
  failRate,
  messageGroups,
  rangeLabel,
  sampleKey,
  type Bar,
  type RunRange,
} from "../lib/flowRuns";
import { relativeTime } from "../lib/history";
import { flowRoute } from "../lib/navigation";
import { RunItem } from "./FlowRuns";
import { Activity, AlertTriangle, ArrowUpRight, ChevronDown, Loader, Refresh, Search } from "./Icon";
import type { ErrorStats, RunRow, RunSummary } from "../types";

const when = (at: string | null) => (at ? relativeTime(Date.parse(at)) : "—");

/** Failures per slot of one error code, as thin columns (no axis: a shape to compare rows by). */
function Sparkline({ bars, label }: { bars: Bar[]; label: string }) {
  const max = Math.max(1, ...bars.map((b) => b.failed));
  return (
    <div className="flex h-6 w-20 items-end gap-px" role="img" aria-label={label}>
      {bars.map((b) => (
        <div key={b.at} className="min-w-0 flex-1">
          {b.failed > 0 && <div className="rounded-t-[2px] bg-danger" style={{ height: Math.max(2, (b.failed / max) * 24) }} />}
        </div>
      ))}
    </div>
  );
}

/** Top error codes for the overview: count, share of failures, flows hit. */
export function TopErrorsCard({
  summary,
  onPick,
  onAll,
}: {
  summary: RunSummary | undefined;
  onPick: (code: string) => void;
  onAll: () => void;
}) {
  const top = summary?.errors.slice(0, 5) ?? null;
  const most = Math.max(1, top?.[0]?.failed ?? 1);
  return (
    <div className="card flex min-w-0 flex-col">
      <div className="card-header">
        <h2 className="card-title">Top errors</h2>
        {summary && summary.errors.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={onAll}>
            View all {summary.errors.length.toLocaleString()}
          </button>
        )}
      </div>
      {!top ? (
        <RowsSkeleton />
      ) : top.length === 0 ? (
        <Quiet title="No failures" text="No run failed in this window." />
      ) : (
        <ul className="px-2 py-2">
          {top.map((e) => (
            <li key={e.code}>
              <button className="nav-item nav-item-tall !items-start" onClick={() => onPick(e.code)} title="Show this error">
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${e.code ? "" : "italic text-muted"}`}>{codeLabel(e.code)}</span>
                    <span className="shrink-0 text-[13px] font-medium tabular-nums text-danger">{e.failed.toLocaleString()}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-s3" aria-hidden="true">
                      <span className="block h-full rounded-full bg-danger" style={{ width: `${(e.failed / most) * 100}%` }} />
                    </span>
                    <span className="shrink-0 text-[11px] font-normal tabular-nums text-subtle">
                      {failRate(e.failed, summary!.failed)} of failures · {e.flows.length} flow{e.flows.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Errors tab: every error code in the window, and the picked one's detail. */
export function ErrorsTab({
  connId,
  summary,
  range,
  names,
  picked,
  onPick,
  onFlow,
}: {
  connId: string;
  summary: RunSummary | undefined;
  range: RunRange;
  names: Map<string, string>;
  /** The error code shown; null = the most frequent. */
  picked: string | null;
  onPick: (code: string) => void;
  /** Show a flow's runs (the Flows tab). */
  onFlow: (flowId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const errors = summary?.errors ?? null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (errors ?? []).filter((e) => !q || codeLabel(e.code).toLowerCase().includes(q));
  }, [errors, query]);
  const current = errors?.find((e) => e.code === picked) ?? errors?.[0] ?? null;
  const most = Math.max(1, ...shown.map((e) => e.failed));

  return (
    <div className="grid gap-6 xl:grid-cols-5">
      <div className="card flex min-w-0 flex-col xl:col-span-3">
        <div className="card-header gap-3">
          <h2 className="card-title shrink-0">Error codes</h2>
          <div className="relative min-w-0">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              className="input !h-7 w-44 !pl-7 !text-[12.5px]"
              placeholder="Filter codes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter error codes"
            />
          </div>
        </div>
        <div className="max-h-[640px] min-h-[200px] overflow-y-auto">
          {!errors || !summary ? (
            <RowsSkeleton />
          ) : errors.length === 0 ? (
            <Quiet title="No failures" text={`No run failed in the ${rangeLabel(range).toLowerCase()}.`} />
          ) : shown.length === 0 ? (
            <Quiet title="No codes match" text="Clear the filter above." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Error code</th>
                  <th className="!text-right">Failed</th>
                  <th>Share</th>
                  <th className="!text-right">Flows</th>
                  <th>Per {range === "1h" || range === "24h" ? "hour" : "day"}</th>
                  <th className="whitespace-nowrap">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr
                    key={e.code}
                    className={`row cursor-pointer ${current?.code === e.code ? "!bg-s3" : ""}`}
                    onClick={() => onPick(e.code)}
                    aria-selected={current?.code === e.code}
                  >
                    <td className="max-w-[200px]">
                      <div className={`truncate font-mono text-[12.5px] ${e.code ? "" : "italic text-muted"}`} title={codeLabel(e.code)}>
                        {codeLabel(e.code)}
                      </div>
                    </td>
                    <td className="text-right font-medium tabular-nums text-danger">{e.failed.toLocaleString()}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-s3" aria-hidden="true">
                          <div className="h-full rounded-full bg-danger" style={{ width: `${(e.failed / most) * 100}%` }} />
                        </div>
                        <span className="w-10 text-xs tabular-nums text-muted">{failRate(e.failed, summary.failed)}</span>
                      </div>
                    </td>
                    <td className="text-right tabular-nums text-muted">{e.flows.length.toLocaleString()}</td>
                    <td>
                      <Sparkline bars={toBars(summary, range, e).bars} label={`${codeLabel(e.code)} failures over the window`} />
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted" title={e.lastSeen ? new Date(e.lastSeen).toLocaleString() : undefined}>
                      {when(e.lastSeen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {summary && current ? (
        <ErrorDetail key={current.code} connId={connId} summary={summary} range={range} error={current} names={names} onFlow={onFlow} />
      ) : (
        <div className="card xl:col-span-2">{!summary && <RowsSkeleton />}</div>
      )}
    </div>
  );
}

/** One error code: when it happened, the flows it hit, what its messages say. */
function ErrorDetail({
  connId,
  summary,
  range,
  error,
  names,
  onFlow,
}: {
  connId: string;
  summary: RunSummary;
  range: RunRange;
  error: ErrorStats;
  names: Map<string, string>;
  onFlow: (flowId: string) => void;
}) {
  const navigate = useNavigate();
  const chart = useMemo(() => toBars(summary, range, error), [summary, range, error]);
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(1, ...chart.bars.map((b) => b.failed));
  const slot = (t: number) =>
    chart.unit === "hour"
      ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const tip = hover !== null ? chart.bars[hover] : null;
  const flowMost = Math.max(1, error.flows[0]?.failed ?? 1);

  return (
    <div className="card flex min-w-0 flex-col xl:col-span-2">
      <div className="card-header !items-start">
        <div className="min-w-0">
          <h2 className={`card-title truncate font-mono ${error.code ? "" : "italic"}`} title={codeLabel(error.code)}>
            {codeLabel(error.code)}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            <span className="font-medium text-danger">{error.failed.toLocaleString()} failed run{error.failed === 1 ? "" : "s"}</span> ·{" "}
            {failRate(error.failed, summary.failed)} of failures · {error.flows.length} flow{error.flows.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      <div className="max-h-[640px] space-y-5 overflow-y-auto px-4 py-4">
        <section>
          <div className="mb-1.5 flex items-baseline justify-between text-xs">
            <span className="text-muted">Failures per {chart.unit}</span>
            <span className="tabular-nums text-subtle">
              {tip ? (
                <>
                  {slot(tip.at)}: <span className="text-fg">{tip.failed.toLocaleString()}</span>
                </>
              ) : (
                `first ${when(error.firstSeen)} · last ${when(error.lastSeen)}`
              )}
            </span>
          </div>
          <div
            className="flex h-16 items-end gap-[2px] border-b border-line"
            role="img"
            aria-label={`${codeLabel(error.code)}: ${error.failed} failures, at most ${peak} per ${chart.unit}`}
            onMouseLeave={() => setHover(null)}
          >
            {chart.bars.map((b, i) => (
              <div key={b.at} className="flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
                {b.failed > 0 && (
                  <div
                    className={`rounded-t-[3px] bg-danger ${hover === i ? "" : hover !== null ? "opacity-60" : ""}`}
                    style={{ height: `${Math.max(3, (b.failed / peak) * 100)}%` }}
                  />
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="eyebrow mb-1.5">Flows</h3>
          <ul className="-mx-2">
            {error.flows.map((f) => {
              const name = names.get(f.flowId) ?? null;
              return (
                <li key={f.flowId} className="group flex items-center gap-1">
                  <button className="nav-item min-w-0 flex-1" onClick={() => onFlow(f.flowId)} title="Show this flow's runs">
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {name ?? <span className="font-mono text-subtle">{f.flowId ? `${f.flowId.slice(0, 8)}…` : "(no flow)"}</span>}
                    </span>
                    <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-s3" aria-hidden="true">
                      <span className="block h-full rounded-full bg-danger" style={{ width: `${(f.failed / flowMost) * 100}%` }} />
                    </span>
                    <span className="w-10 shrink-0 text-right text-xs tabular-nums text-danger">{f.failed.toLocaleString()}</span>
                  </button>
                  {name && (
                    <button
                      className="btn btn-ghost btn-icon btn-sm shrink-0"
                      onClick={() => navigate(`${flowRoute(f.flowId)}?tab=runs`)}
                      title="Open its run history in Flows"
                      aria-label={`Open ${name} in Flows`}
                    >
                      <ArrowUpRight size={13} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <Messages connId={connId} summary={summary} error={error} names={names} />
      </div>
    </div>
  );
}

/** The newest failed runs with this code, grouped by what their error message says. */
function Messages({ connId, summary, error, names }: { connId: string; summary: RunSummary; error: ErrorStats; names: Map<string, string> }) {
  const sample = errorSamples.useEntry(connId, sampleKey(summary, error.code));
  const groups = useMemo(() => (sample.data ? messageGroups(sample.data.rows) : null), [sample.data]);
  const [open, setOpen] = useState<string | null>(null);
  const read = sample.data?.rows.length ?? 0;

  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="eyebrow">Messages</h3>
        {sample.data && (
          <span className="text-[11px] tabular-nums text-subtle">
            {sample.data.more ? `newest ${read.toLocaleString()} of ${error.failed.toLocaleString()} runs` : `${read.toLocaleString()} run${read === 1 ? "" : "s"}`}
          </span>
        )}
      </div>
      {sample.error ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={13} className="text-warning" /> Couldn't read the runs
          </div>
          <div className="mt-0.5 break-words text-subtle">{sample.error}</div>
          <button className="btn btn-secondary btn-sm mt-2" onClick={sample.reload}>
            <Refresh size={12} /> Retry
          </button>
        </div>
      ) : !groups ? (
        <div className="flex items-center gap-2 py-3 text-xs text-subtle" role="status">
          <Loader size={13} className="text-brand" /> Reading the newest {Math.min(error.failed, SAMPLE_MAX).toLocaleString()} failed runs…
        </div>
      ) : groups.length === 0 ? (
        <div className="py-3 text-xs text-subtle">These runs are no longer in Dataverse.</div>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => {
            const isOpen = open === g.pattern;
            return (
              <li key={g.pattern} className="rounded-lg border border-line">
                <button
                  className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-s3"
                  onClick={() => setOpen(isOpen ? null : g.pattern)}
                  aria-expanded={isOpen}
                >
                  <ChevronDown size={13} className={`mt-[3px] shrink-0 text-subtle transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`line-clamp-3 break-words text-[12.5px] leading-[18px] ${g.example ? "" : "italic text-muted"}`}>
                      {g.example || "No error message"}
                    </span>
                    <span className="mt-0.5 block text-[11px] tabular-nums text-subtle">
                      {g.runs.length.toLocaleString()} run{g.runs.length === 1 ? "" : "s"}
                      {read > 0 && ` (${failRate(g.runs.length, read)})`} · {g.flows} flow{g.flows === 1 ? "" : "s"} · last {when(g.runs[0].startTime)}
                    </span>
                  </span>
                </button>
                {isOpen && <MessageRuns full={g.full} runs={g.runs} names={names} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function MessageRuns({ full, runs, names }: { full: string | null; runs: RunRow[]; names: Map<string, string> }) {
  const navigate = useNavigate();
  const [limit, setLimit] = useState(10);
  const openInFlows = (r: RunRow) => navigate(`${flowRoute(r.flowId!)}?${new URLSearchParams({ tab: "runs", run: r.id })}`);
  return (
    <div className="fade-in border-t border-line px-2 pb-2 pt-2">
      {full && (
        <pre className="mx-1 mb-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-s2 p-2 font-mono text-[11.5px] leading-[17px] dark:bg-s3">
          {errorText(full)}
        </pre>
      )}
      <ul role="listbox" aria-label="Runs with this message">
        {runs.slice(0, limit).map((r) => {
          const name = (r.flowId && names.get(r.flowId)) || null;
          return (
            <li key={r.id}>
              <RunItem
                row={r}
                selected={false}
                onOpen={() => (name ? openInFlows(r) : undefined)}
                showFlow={name ?? r.flowName}
              />
            </li>
          );
        })}
      </ul>
      {runs.length > limit && (
        <button className="btn btn-ghost btn-sm mt-1 w-full justify-center" onClick={() => setLimit((l) => l + 25)}>
          Show more ({(runs.length - limit).toLocaleString()} left)
        </button>
      )}
    </div>
  );
}

export function RowsSkeleton() {
  return (
    <div className="space-y-3 p-5">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${55 + ((i * 23) % 40)}%` }} />
      ))}
    </div>
  );
}

export function Quiet({ title, text }: { title: string; text: string }) {
  return (
    <div className="px-5 py-12 text-center">
      <div className="empty-icon">
        <Activity size={18} />
      </div>
      <div className="mt-3 text-sm font-medium">{title}</div>
      <div className="mt-1 text-xs text-subtle">{text}</div>
    </div>
  );
}
