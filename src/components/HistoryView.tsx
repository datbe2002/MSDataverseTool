import { useState } from "react";
import { useStore } from "../store";
import { formatMs, relativeTime, type HistoryStatus } from "../lib/history";
import { StatusBadge } from "./OverviewView";
import { Clock } from "./Icon";

type Filter = "all" | HistoryStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ok", label: "Succeeded" },
  { key: "write", label: "Writes" },
  { key: "error", label: "Errors" },
];

export function HistoryView() {
  const history = useStore((s) => s.history);
  const loadSql = useStore((s) => s.loadSql);
  const clearHistory = useStore((s) => s.clearHistory);
  const [filter, setFilter] = useState<Filter>("all");

  const rows = history.filter((h) => filter === "all" || h.status === filter);

  return (
    <section className="h-full overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="page-title">Query history</h1>
            <p className="mt-0.5 text-sm text-muted">Everything you ran, kept on this machine only.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="seg" role="group" aria-label="Filter history">
              {FILTERS.map((f) => (
                <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                  <span className="seg-count">
                    {f.key === "all" ? history.length : history.filter((h) => h.status === f.key).length}
                  </span>
                </button>
              ))}
            </div>
            {history.length > 0 && (
              <button className="btn btn-ghost btn-sm ml-2" onClick={clearHistory}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="card mt-5 overflow-hidden">
          {rows.length === 0 ? (
            <div className="fade-in px-6 py-14 text-center">
              <div className="empty-icon">
                <Clock size={20} />
              </div>
              <div className="mt-3 text-sm font-medium">Nothing here yet</div>
              <div className="mt-1 text-sm text-muted">
                {filter === "all"
                  ? "Queries you run will be listed here."
                  : `No ${filter === "error" ? "failed" : filter === "write" ? "write" : "successful"} statements in your history.`}
              </div>
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Statement</th>
                  <th>Connection</th>
                  <th>Result</th>
                  <th className="!text-right">Duration</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.id} className="row group">
                    <td className="w-full max-w-0">
                      <code className="block truncate font-mono text-[12.5px]" title={h.sql}>
                        {h.sql.replace(/\s+/g, " ").trim()}
                      </code>
                      {h.error && (
                        <div className="mt-0.5 truncate text-xs text-danger" title={h.error}>
                          {h.error}
                        </div>
                      )}
                    </td>
                    <td className="text-muted">
                      {/* Long environment names give the statement room. */}
                      <div className="max-w-[11rem] truncate" title={h.connectionName}>
                        {h.connectionName}
                      </div>
                    </td>
                    <td><StatusBadge entry={h} /></td>
                    <td className="text-right tabular-nums text-muted">{formatMs(h.ms)}</td>
                    <td className="whitespace-nowrap text-subtle">{relativeTime(h.at)}</td>
                    <td className="!px-2 text-right">
                      <button className="btn btn-secondary btn-sm opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100" onClick={() => loadSql(h.sql)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
