import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useStore, activeProjectOf } from "../store";
import { ROUTES } from "../lib/navigation";
import { useSchema } from "../lib/schema";
import { dailyCounts, formatMs, isToday, relativeTime, type HistoryEntry } from "../lib/history";
import { Compass, Plus, Check, AlertTriangle, Pencil, Table, Code } from "./Icon";
import { tagStyle } from "../lib/tags";
import { TagBadge } from "./TagBadge";
import type { Connection } from "../types";

interface Props {
  onDiscover: () => void;
  onAdd: () => void;
  onEdit: (c: Connection) => void;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function StatusBadge({ entry }: { entry: HistoryEntry }) {
  if (entry.status === "ok")
    return (
      <span className="badge badge-success">
        {(entry.rows ?? 0).toLocaleString()} rows
      </span>
    );
  if (entry.status === "write")
    return (
      <span className="badge badge-info">
        {(entry.rows ?? 0).toLocaleString()} written
      </span>
    );
  return <span className="badge badge-danger">Failed</span>;
}

export function OverviewView({ onDiscover, onAdd, onEdit }: Props) {
  const project = useStore(activeProjectOf);
  const allConnections = useStore((s) => s.connections);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const connections = useMemo(
    () => allConnections.filter((c) => c.projectId === activeProjectId),
    [allConnections, activeProjectId]
  );
  const activeId = useStore((s) => s.activeId);
  const requestSwitch = useStore((s) => s.requestSwitch);
  const navigate = useNavigate();
  const loadSql = useStore((s) => s.loadSql);
  const history = useStore((s) => s.history);
  const schemaTables = useSchema((s) => s.tables);

  const stats = useMemo(() => {
    const today = history.filter((h) => isToday(h.at));
    const week = history.filter((h) => Date.now() - h.at < 7 * 86_400_000);
    const okWeek = week.filter((h) => h.status === "ok");
    const avg = okWeek.length
      ? Math.round(okWeek.reduce((a, h) => a + h.ms, 0) / okWeek.length)
      : null;
    const writesWeek = week.filter((h) => h.status === "write");
    return {
      today: today.length,
      todayFailed: today.filter((h) => h.status === "error").length,
      avg,
      rowsToday: today.filter((h) => h.status === "ok").reduce((a, h) => a + (h.rows ?? 0), 0),
      writes: writesWeek.length,
      written: writesWeek.reduce((a, h) => a + (h.rows ?? 0), 0),
    };
  }, [history]);

  const spark = useMemo(() => dailyCounts(history, 14), [history]);
  const max = Math.max(1, ...spark);
  const W = 280, H = 72, step = W / (spark.length - 1);
  const pt = (v: number, i: number) =>
    `${(i * step).toFixed(1)},${(H - 6 - (v / max) * (H - 12)).toFixed(1)}`;
  const path = spark.map((v, i) => `${i ? "L" : "M"}${pt(v, i)}`).join(" ");
  const from = new Date(Date.now() - 13 * 86_400_000);

  const name = project?.username?.split("@")[0].split(/[._-]/)[0];
  const tiles = [
    {
      label: "Queries today",
      value: stats.today.toLocaleString(),
      sub: stats.todayFailed ? `${stats.todayFailed} failed` : "no failures",
      tone: stats.todayFailed ? "text-danger" : "text-success",
    },
    {
      label: "Avg latency · 7 days",
      value: stats.avg === null ? "—" : formatMs(stats.avg),
      sub: "successful SELECTs",
      tone: "text-subtle",
    },
    {
      label: "Rows fetched today",
      value: stats.rowsToday.toLocaleString(),
      sub: "across all connections",
      tone: "text-subtle",
    },
    {
      label: "Writes · 7 days",
      value: stats.writes.toLocaleString(),
      sub: `${stats.written.toLocaleString()} records changed`,
      tone: "text-info",
    },
  ];

  return (
    <section className="h-full overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="page-title">
              {greeting()}
              {name ? `, ${name.charAt(0).toUpperCase()}${name.slice(1)}` : ""}
            </h1>
            <p className="mt-0.5 text-sm text-muted">
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "short",
              })}
              {project ? ` · ${project.name}` : ""}
              {" · "}
              {connections.length} environment{connections.length === 1 ? "" : "s"}
              {project?.username ? "" : " · not signed in"}
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => navigate(ROUTES.schema)}>
              <Table size={14} /> Browse schema
            </button>
            <button className="btn btn-primary" onClick={() => navigate(ROUTES.query)}>
              <Code size={14} /> New query
            </button>
          </div>
        </div>

        <div className="card grid grid-cols-2 gap-px overflow-hidden !bg-line xl:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="bg-s1 px-5 py-4 dark:bg-s2">
              <div className="eyebrow">{t.label}</div>
              <div className="mt-2 text-[28px] leading-8 font-semibold tabular-nums tracking-tight">{t.value}</div>
              <div className={`mt-1 text-xs ${t.tone}`}>{t.sub}</div>
            </div>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="card min-w-0 lg:col-span-2">
            <div className="card-header">
              <h2 className="card-title">Recent queries</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => navigate(ROUTES.history)}>
                View all
              </button>
            </div>
            {history.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <div className="empty-icon"><Code size={20} /></div>
                <div className="mt-3 text-sm font-medium">Nothing run yet</div>
                <div className="mt-0.5 text-xs text-subtle">Queries you execute will show up here.</div>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {history.slice(0, 6).map((h) => (
                  <li
                    key={h.id}
                    tabIndex={0}
                    onClick={() => loadSql(h.sql)}
                    onKeyDown={(e) => e.key === "Enter" && loadSql(h.sql)}
                    className="row flex cursor-pointer items-center gap-4 px-4 py-2.5"
                    title="Open in editor"
                  >
                    <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                      {h.sql.replace(/\s+/g, " ").trim()}
                    </code>
                    <span className="hidden max-w-[35%] shrink-0 truncate text-xs text-subtle sm:inline">{h.connectionName}</span>
                    <StatusBadge entry={h} />
                    <span className="w-14 text-right text-xs tabular-nums text-subtle">
                      {formatMs(h.ms)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 space-y-6">
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Environments</h2>
                {project && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-subtle">
                    <span className={`h-1.5 w-1.5 rounded-full ${tagStyle(project.color).dot}`} />
                    {project.name}
                  </span>
                )}
              </div>
              {connections.length === 0 ? (
                <div className="m-4 rounded-lg border border-dashed border-line-strong p-4 text-center text-xs text-subtle">
                  No environments in this project yet.
                  <div className="mt-3 flex justify-center gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={onDiscover}>
                      <Compass size={13} /> Discover
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={onAdd}>
                      <Plus size={13} /> Add URL
                    </button>
                  </div>
                </div>
              ) : (
                <ul className="space-y-1 p-2">
                  {connections.map((c) => {
                    const tables = schemaTables[c.id]?.length;
                    const active = c.id === activeId;
                    const failed = history.find((h) => h.connectionId === c.id)?.status === "error";
                    const style = c.tag ? tagStyle(c.color) : null;
                    return (
                      <li key={c.id} className="group relative">
                        <button
                          onClick={() => requestSwitch(c.id)}
                          className={`flex w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition hover:bg-s3 ${
                            active
                              ? style
                                ? `${style.ring} ${style.tint}`
                                : "border-brand/40 bg-brand/10"
                              : "border-transparent"
                          }`}
                        >
                          <div
                            className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                              failed ? "bg-warning/15 text-warning" : "bg-success/15 text-success"
                            }`}
                          >
                            {failed ? <AlertTriangle size={14} /> : <Check size={14} />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-sm font-medium">
                              <span className="truncate">{c.name}</span>
                              <TagBadge connection={c} />
                            </div>
                            <div className="truncate font-mono text-[11px] text-subtle">
                              {tables ? `${tables.toLocaleString()} tables · ` : ""}
                              {c.lastUsed ? `used ${relativeTime(Date.parse(c.lastUsed))}` : "never used"}
                            </div>
                          </div>
                          {active && <span className="badge badge-brand mr-7">active</span>}
                        </button>
                        <button
                          onClick={() => onEdit(c)}
                          title={`Edit or remove ${c.name}`}
                          aria-label={`Edit or remove ${c.name}`}
                          className="btn btn-ghost btn-icon absolute right-2 top-1/2 -translate-y-1/2 text-subtle opacity-0 transition hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <Pencil size={13} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Queries · last 14 days</h2>
                <span className="text-xs tabular-nums text-subtle">peak {Math.max(...spark)}</span>
              </div>
              <div className="px-4 pb-3 pt-4">
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Queries per day">
                <defs>
                  <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="var(--brand)" stopOpacity=".28" />
                    <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={`${path} L${W},${H} L0,${H} Z`} fill="url(#spark-fill)" />
                <path d={path} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinejoin="round" />
                {spark.map((v, i) => (
                  <circle key={i} cx={pt(v, i).split(",")[0]} cy={pt(v, i).split(",")[1]} r={i === spark.length - 1 ? 3.5 : 0} fill="var(--brand)">
                    <title>{v} queries</title>
                  </circle>
                ))}
              </svg>
              <div className="mt-1 flex justify-between text-xs text-subtle">
                <span>{from.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                <span>Today</span>
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
