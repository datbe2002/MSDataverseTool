// The Flows and Machines tabs of the Desktop flows tool.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { useStore } from "../store";
import {
  HEALTH_DOT,
  HEALTH_LABEL,
  ago,
  desktopFlowDetailCache,
  desktopFlowsCache,
  machineHealth,
  machinesCache,
  DEFAULT_RUN_FILTERS,
  runDuration,
  runTone,
  useDesktopRuns,
  type DesktopRunFilters,
} from "../lib/desktopFlows";
import { TONE_DOT } from "../lib/jobs";
import { friendlyError } from "../lib/errors";
import { formatDuration, logTime } from "../lib/pagedStore";
import { desktopRoute } from "../lib/navigation";
import { ListSkeleton, Stat } from "./LogParts";
import { Search, Refresh, Copy, AlertTriangle, Monitor, Gauge } from "./Icon";
import type { DesktopFlow, DesktopFlowParam, DesktopRun, DesktopRunFilter, FlowMachine, FlowMachineGroup } from "../types";

/** Shows the runs of one flow / machine / group in the Runs tab. */
export function useOpenRuns(connId: string) {
  const navigate = useNavigate();
  const setFilters = useDesktopRuns((s) => s.setFilters);
  return (patch: Partial<DesktopRunFilters>) => {
    setFilters(connId, { ...DEFAULT_RUN_FILTERS, range: "30d", ...patch });
    navigate(desktopRoute("runs"));
  };
}

/** One run in a list (the Runs tab, a flow's or machine's recent runs). */
export function RunItem({ row, selected, onOpen, showFlow = true }: { row: DesktopRun; selected: boolean; onOpen: () => void; showFlow?: boolean }) {
  const tone = runTone(row.status);
  const duration = runDuration(row);
  const title = showFlow ? row.flowName || row.name || "(unknown flow)" : row.machineName || row.groupName || row.runModeLabel || row.statusLabel;
  return (
    <button
      role="option"
      aria-selected={selected}
      aria-current={selected ? "page" : undefined}
      tabIndex={selected ? 0 : -1}
      className="nav-item nav-item-tall !items-start"
      onClick={onOpen}
      title={title}
    >
      <span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]} ${tone === "info" ? "animate-pulse" : ""}`} aria-label={row.statusLabel} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-subtle">{logTime(row.createdOn)}</span>
        </span>
        <span className="block truncate text-xs font-normal text-subtle">
          {[
            row.statusLabel,
            row.test ? "test" : null,
            row.runModeLabel,
            showFlow ? row.machineName || row.groupName : null,
            duration !== null ? formatDuration(duration) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {row.error && <span className="block truncate text-xs font-normal text-danger">{row.error}</span>}
      </span>
    </button>
  );
}

const STATE_BADGE: Record<number, string> = { 0: "badge-neutral", 1: "badge-success", 2: "badge-danger" };

/** A list column: search box, refresh, count line and rows. */
function ListColumn({
  query,
  onQuery,
  placeholder,
  onRefresh,
  loading,
  count,
  children,
  label,
}: {
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  onRefresh: () => void;
  loading: boolean;
  count: string;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex min-h-0 flex-col border-r border-line bg-s1">
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input className="input !pl-8" placeholder={placeholder} value={query} onChange={(e) => onQuery(e.target.value)} aria-label={placeholder} />
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onRefresh} disabled={loading} title="Read them again" aria-label="Refresh">
          <Refresh size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="px-4 pb-1.5 pt-3 text-[11.5px] text-subtle">{count}</div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label={label}>
        {children}
      </ul>
    </div>
  );
}

function ErrorItem({ title, error, onRetry }: { title: string; error: string; onRetry: () => void }) {
  return (
    <li className="px-3 py-8 text-center text-xs text-subtle">
      <div className="text-warning">{title}</div>
      <div className="mt-1 break-words">{error}</div>
      <button className="btn btn-secondary btn-sm mt-3" onClick={onRetry}>
        <Refresh size={12} /> Retry
      </button>
    </li>
  );
}

function EmptyPane({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="empty-icon">
        <Monitor size={20} />
      </div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 max-w-sm text-xs text-subtle">{body}</div>
      </div>
    </div>
  );
}

function useCopy() {
  const pushToast = useStore((s) => s.pushToast);
  return (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));
}

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

/* ---------- Flows ---------- */

export function FlowsTab({ connId, selected }: { connId: string; selected: string | null }) {
  const flows = desktopFlowsCache.useEntry(connId);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const all = flows.data ?? [];
  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((f) => f.name.toLowerCase().includes(q) || f.owner.toLowerCase().includes(q)) : all;
  const flow = all.find((f) => f.id === selected) ?? null;
  const drafts = all.filter((f) => f.state === 0).length;

  return (
    <div className="grid h-full grid-cols-[clamp(300px,28vw,380px)_minmax(0,1fr)]">
      <ListColumn
        query={query}
        onQuery={setQuery}
        placeholder="Flow name or owner…"
        onRefresh={flows.reload}
        loading={flows.loading}
        count={flows.data ? `${shown.length} of ${all.length} desktop flow${all.length === 1 ? "" : "s"}${drafts ? ` · ${drafts} draft${drafts === 1 ? "" : "s"}` : ""}` : " "}
        label="Desktop flows"
      >
        {flows.error && !flows.data ? (
          <ErrorItem title="Couldn't read the desktop flows." error={flows.error} onRetry={flows.reload} />
        ) : !flows.data ? (
          <ListSkeleton />
        ) : shown.length === 0 ? (
          <li className="px-3 py-10 text-center text-xs text-subtle">
            {all.length ? "No desktop flow matches." : "This environment has no desktop flows (or this account can't see them)."}
          </li>
        ) : (
          shown.map((f) => (
            <li key={f.id}>
              <button
                role="option"
                aria-selected={f.id === selected}
                aria-current={f.id === selected ? "page" : undefined}
                className="nav-item nav-item-tall !items-start"
                onClick={() => navigate(desktopRoute("flows", f.id), { replace: !!selected })}
                title={f.name}
              >
                <Monitor size={14} className="mt-[2px] shrink-0 text-subtle" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{f.name || "(no name)"}</span>
                    {f.state !== 1 && <span className={`badge ${STATE_BADGE[f.state] ?? "badge-neutral"} !text-[10.5px]`}>{f.stateLabel}</span>}
                  </span>
                  <span className="block truncate text-xs font-normal text-subtle">
                    {[f.owner || null, `modified ${logTime(f.modifiedOn)}`].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          ))
        )}
      </ListColumn>

      <div className="min-h-0 overflow-y-auto">
        {flow ? (
          <FlowDetailPane key={flow.id} connId={connId} flow={flow} />
        ) : selected && !flows.data ? (
          <div className="space-y-3 p-8">
            <div className="skeleton h-5 w-1/3" />
            <div className="skeleton h-3 w-1/2" />
          </div>
        ) : (
          <EmptyPane
            title={selected ? "Flow not found" : "No flow selected"}
            body={selected ? "It may have been deleted, or this account can't see it." : "Pick a desktop flow on the left to see its inputs, outputs and latest runs."}
          />
        )}
      </div>
    </div>
  );
}

function FlowDetailPane({ connId, flow }: { connId: string; flow: DesktopFlow }) {
  const detail = desktopFlowDetailCache.useEntry(connId, flow.id);
  const openRuns = useOpenRuns(connId);
  const copy = useCopy();

  return (
    <div className="fade-in px-6 pb-8 pt-7 xl:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={flow.name}>
              {flow.name || "(no name)"}
            </h2>
            <span className={`badge badge-dot ${STATE_BADGE[flow.state] ?? "badge-neutral"}`}>{flow.stateLabel}</span>
            {flow.kind && <span className="badge badge-neutral">{flow.kind}</span>}
            {flow.managed && <span className="badge badge-neutral">Managed</span>}
          </div>
          {flow.description && <p className="mt-1 max-w-3xl text-sm text-muted">{flow.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => openRuns({ flowId: flow.id })} title="Every run of this flow in the last 30 days">
            <Gauge size={14} /> All runs
          </button>
          <button className="btn btn-ghost" onClick={() => copy(flow.id, "flow id")} title={flow.id}>
            <Copy size={14} /> Copy id
          </button>
        </div>
      </div>

      <div className="card mt-4 grid grid-cols-3 divide-x divide-line">
        <Stat label="Owner">
          <span className="truncate">{flow.owner || "—"}</span>
        </Stat>
        <Stat label="Modified">
          <span className="truncate" title={flow.modifiedBy ? `by ${flow.modifiedBy}` : undefined}>
            {shortDate(flow.modifiedOn)}
            {flow.modifiedBy && <span className="text-subtle"> · {flow.modifiedBy}</span>}
          </span>
        </Stat>
        <Stat label="Created">
          <span className="truncate">{shortDate(flow.createdOn)}</span>
        </Stat>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <ParamTable title="Inputs" params={detail.data?.inputs} loading={detail.loading} error={detail.error ?? detail.data?.schemaError ?? null} />
        <ParamTable title="Outputs" params={detail.data?.outputs} loading={detail.loading} error={detail.error ?? detail.data?.schemaError ?? null} />
      </div>

      <RecentRuns connId={connId} filter={{ flowId: flow.id }} showFlow={false} onAll={() => openRuns({ flowId: flow.id })} />
    </div>
  );
}

function ParamTable({ title, params, loading, error }: { title: string; params: DesktopFlowParam[] | undefined; loading: boolean; error: string | null }) {
  return (
    <section>
      <div className="eyebrow mb-2">
        {title}
        {params && params.length > 0 && <span className="ml-1.5 font-normal normal-case tracking-normal">({params.length})</span>}
      </div>
      {loading && !params ? (
        <div className="skeleton h-16" />
      ) : error && !params?.length ? (
        <p className="text-xs text-warning">Couldn't read the {title.toLowerCase()}: {error}</p>
      ) : !params?.length ? (
        <p className="text-xs text-subtle">No {title.toLowerCase()}.</p>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-s2 text-subtle">
              <tr>
                <th className="px-3 py-1.5 font-medium">Name</th>
                <th className="px-3 py-1.5 font-medium">Type</th>
                <th className="px-3 py-1.5 font-medium">Default / description</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => (
                <tr key={p.name} className="border-t border-line align-top">
                  <td className="px-3 py-1.5 font-mono">
                    {p.name}
                    {p.sensitive && <span className="badge badge-warning ml-1.5 !text-[10px]">sensitive</span>}
                  </td>
                  <td className="px-3 py-1.5 text-muted">{p.kind || "—"}</td>
                  <td className="px-3 py-1.5 text-muted">
                    {p.default !== null && <span className="font-mono">{p.default}</span>}
                    {p.default !== null && p.description && " · "}
                    {p.description}
                    {p.default === null && !p.description && "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The newest runs of a flow / machine / group (read on its own, not through the Runs list). */
function RecentRuns({ connId, filter, showFlow, onAll }: { connId: string; filter: DesktopRunFilter; showFlow: boolean; onAll: () => void }) {
  const navigate = useNavigate();
  const key = JSON.stringify(filter);
  const [state, setState] = useState<{ rows: DesktopRun[] | null; error: string | null }>({ rows: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ rows: s.rows, error: null }));
    api
      .desktopFlowRuns(connId, { ...JSON.parse(key), top: 10 }, null)
      .then((p) => live && setState({ rows: p.rows, error: null }))
      .catch((e) => live && setState({ rows: [], error: friendlyError(String(e)) }));
    return () => {
      live = false;
    };
  }, [connId, key, tick]);

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <span className="eyebrow">Latest runs</span>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setTick((t) => t + 1)} aria-label="Refresh latest runs" title="Read them again">
          <Refresh size={12} />
        </button>
        <button className="btn btn-ghost btn-sm ml-auto" onClick={onAll}>
          All runs →
        </button>
      </div>
      {state.error ? (
        <p className="text-xs text-warning">{state.error}</p>
      ) : !state.rows ? (
        <div className="space-y-2">
          <div className="skeleton h-9" />
          <div className="skeleton h-9" />
        </div>
      ) : state.rows.length === 0 ? (
        <p className="text-xs text-subtle">No runs kept in Dataverse.</p>
      ) : (
        <ul className="card max-w-3xl p-1" role="listbox" aria-label="Latest runs">
          {state.rows.map((r) => (
            <li key={r.id}>
              <RunItem row={r} selected={false} showFlow={showFlow} onOpen={() => navigate(desktopRoute("runs", r.id))} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- Machines ---------- */

export function MachinesTab({ connId, selected }: { connId: string; selected: string | null }) {
  const entry = machinesCache.useEntry(connId);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const machines = entry.data?.machines ?? [];
  const groups = useMemo(() => (entry.data?.groups ?? []).filter((g) => !g.implicit), [entry.data]);
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);

  // Groups people made, each with its machines; then machines on their own.
  const sections = useMemo(() => {
    const ids = new Set(groups.map((g) => g.id));
    const out: { group: FlowMachineGroup | null; machines: FlowMachine[] }[] = groups.map((g) => ({
      group: g,
      machines: machines.filter((m) => m.groupId === g.id),
    }));
    out.push({ group: null, machines: machines.filter((m) => !m.groupId || !ids.has(m.groupId)) });
    return out;
  }, [groups, machines]);
  const online = machines.filter((m) => machineHealth(m) === "online").length;

  const machine = machines.find((m) => m.id === selected) ?? null;
  const group = groups.find((g) => g.id === selected) ?? null;
  const open = (id: string) => navigate(desktopRoute("machines", id), { replace: !!selected });

  return (
    <div className="grid h-full grid-cols-[clamp(300px,28vw,380px)_minmax(0,1fr)]">
      <ListColumn
        query={query}
        onQuery={setQuery}
        placeholder="Machine or group name…"
        onRefresh={entry.reload}
        loading={entry.loading}
        count={
          entry.data
            ? `${machines.length} machine${machines.length === 1 ? "" : "s"} · ${groups.length} group${groups.length === 1 ? "" : "s"} · ${online} seen recently`
            : " "
        }
        label="Machines"
      >
        {entry.error && !entry.data ? (
          <ErrorItem title="Couldn't read the machines." error={entry.error} onRetry={entry.reload} />
        ) : !entry.data ? (
          <ListSkeleton />
        ) : machines.length === 0 && groups.length === 0 ? (
          <li className="px-3 py-10 text-center text-xs text-subtle">
            No machines registered in this environment (or this account can't see them). Register one from Power Automate for desktop → Machine settings.
          </li>
        ) : (
          <>
            {entry.data.groupsError && <li className="px-3 pb-2 text-xs text-warning">{entry.data.groupsError}</li>}
            {sections.map(({ group: g, machines: ms }) => {
              const shownMachines = ms.filter((m) => match(m.name) || (g && match(g.name)));
              if (g ? !match(g.name) && shownMachines.length === 0 : shownMachines.length === 0) return null;
              return (
                <li key={g?.id ?? "standalone"} className="mt-1">
                  {g ? (
                    <button role="option" aria-selected={g.id === selected} aria-current={g.id === selected ? "page" : undefined} className="nav-item" onClick={() => open(g.id)} title={g.name}>
                      <span className="eyebrow min-w-0 flex-1 truncate">{g.name}</span>
                      <span className="text-[11px] font-normal text-subtle">{ms.length}</span>
                    </button>
                  ) : (
                    groups.length > 0 && <div className="eyebrow px-2.5 py-1.5">Standalone machines</div>
                  )}
                  <ul>
                    {shownMachines.map((m) => (
                      <li key={m.id}>
                        <MachineItem machine={m} selected={m.id === selected} indent={!!g} onOpen={() => open(m.id)} />
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </>
        )}
      </ListColumn>

      <div className="min-h-0 overflow-y-auto">
        {machine ? (
          <MachineDetailPane key={machine.id} connId={connId} machine={machine} group={groups.find((g) => g.id === machine.groupId) ?? null} />
        ) : group ? (
          <GroupDetailPane key={group.id} connId={connId} group={group} machines={machines.filter((m) => m.groupId === group.id)} onOpen={open} />
        ) : selected && !entry.data ? (
          <div className="space-y-3 p-8">
            <div className="skeleton h-5 w-1/3" />
            <div className="skeleton h-3 w-1/2" />
          </div>
        ) : (
          <EmptyPane
            title={selected ? "Machine not found" : "No machine selected"}
            body={selected ? "It may have been removed, or this account can't see it." : "Pick a machine or machine group on the left to see its state and the runs it took."}
          />
        )}
      </div>
    </div>
  );
}

function MachineItem({ machine: m, selected, indent, onOpen }: { machine: FlowMachine; selected: boolean; indent: boolean; onOpen: () => void }) {
  const health = machineHealth(m);
  return (
    <button role="option" aria-selected={selected} aria-current={selected ? "page" : undefined} className={`nav-item nav-item-tall !items-start ${indent ? "!pl-5" : ""}`} onClick={onOpen} title={m.name}>
      <span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${HEALTH_DOT[health]}`} aria-label={HEALTH_LABEL[health]} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{m.name || "(no name)"}</span>
        <span className="block truncate text-xs font-normal text-subtle">
          {[m.statusLabel, `seen ${ago(m.lastHeartbeat)}`, m.hosting && m.hosting !== "Customer" ? m.hosting : null].filter(Boolean).join(" · ")}
        </span>
      </span>
    </button>
  );
}

function MachineDetailPane({ connId, machine: m, group }: { connId: string; machine: FlowMachine; group: FlowMachineGroup | null }) {
  const navigate = useNavigate();
  const openRuns = useOpenRuns(connId);
  const copy = useCopy();
  const health = machineHealth(m);
  const runs: Partial<DesktopRunFilters> = { target: `m:${m.id}` };

  return (
    <div className="fade-in px-6 pb-8 pt-7 xl:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={m.name}>
              {m.name || "(no name)"}
            </h2>
            <span className={`badge badge-dot ${health === "online" ? "badge-success" : health === "inactive" ? "badge-warning" : "badge-neutral"}`}>{HEALTH_LABEL[health]}</span>
            <span className="badge badge-neutral">{m.statusLabel}</span>
            {m.hosting && <span className="badge badge-neutral">{m.hosting === "Customer" ? "Registered machine" : m.hosting}</span>}
          </div>
          {m.description && <p className="mt-1 max-w-3xl text-sm text-muted">{m.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => openRuns(runs)} title="Every run on this machine in the last 30 days">
            <Gauge size={14} /> All runs
          </button>
          <button className="btn btn-ghost" onClick={() => copy(m.id, "machine id")} title={m.id}>
            <Copy size={14} /> Copy id
          </button>
        </div>
      </div>

      <div className="card mt-4 grid grid-cols-4 divide-x divide-line">
        <Stat label="Last heartbeat">
          <span className="truncate" title={m.lastHeartbeat ? new Date(m.lastHeartbeat).toLocaleString() : undefined}>
            {ago(m.lastHeartbeat)}
          </span>
        </Stat>
        <Stat label="Agent version">
          <span className="truncate font-mono text-[13px]">{m.agentVersion || "—"}</span>
        </Stat>
        <Stat label="Sessions">
          <span className="tabular-nums">{m.sessionCapacity ?? "—"}</span>
        </Stat>
        <Stat label="Group">
          {group ? (
            <button className="min-w-0 truncate text-left hover:text-brand hover:underline" onClick={() => navigate(desktopRoute("machines", group.id))}>
              {group.name}
            </button>
          ) : (
            <span className="text-subtle">Standalone</span>
          )}
        </Stat>
      </div>
      <dl className="mt-3 grid max-w-xl grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <dt className="eyebrow leading-5">Owner</dt>
        <dd className="truncate leading-5 text-muted">{m.owner || "—"}</dd>
        <dt className="eyebrow leading-5">Registered</dt>
        <dd className="truncate leading-5 text-muted">{shortDate(m.createdOn)}</dd>
      </dl>
      {health === "offline" && (
        <p className="mt-4 max-w-3xl rounded-lg border border-line bg-s2 px-3 py-2 text-xs text-muted">
          <AlertTriangle size={12} className="mr-1.5 inline text-warning" />
          No heartbeat in the last 15 minutes: the machine may be off, asleep or signed out of Power Automate for desktop.
        </p>
      )}

      <RecentRuns connId={connId} filter={{ machineId: m.id }} showFlow onAll={() => openRuns(runs)} />
    </div>
  );
}

function GroupDetailPane({ connId, group: g, machines, onOpen }: { connId: string; group: FlowMachineGroup; machines: FlowMachine[]; onOpen: (id: string) => void }) {
  const openRuns = useOpenRuns(connId);
  const copy = useCopy();
  const runs: Partial<DesktopRunFilters> = { target: `g:${g.id}` };
  const online = machines.filter((m) => machineHealth(m) === "online").length;

  return (
    <div className="fade-in px-6 pb-8 pt-7 xl:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight">{g.name || "(no name)"}</h2>
            <span className="badge badge-neutral">Machine group</span>
            {g.statusLabel && <span className={`badge badge-dot ${g.state === 0 ? "badge-success" : "badge-warning"}`}>{g.statusLabel}</span>}
          </div>
          {g.description && <p className="mt-1 max-w-3xl text-sm text-muted">{g.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => openRuns(runs)} title="Every run in this group in the last 30 days">
            <Gauge size={14} /> All runs
          </button>
          <button className="btn btn-ghost" onClick={() => copy(g.id, "group id")} title={g.id}>
            <Copy size={14} /> Copy id
          </button>
        </div>
      </div>

      <div className="card mt-4 grid grid-cols-3 divide-x divide-line">
        <Stat label="Machines">
          <span className="tabular-nums">
            {machines.length}
            <span className="text-subtle"> · {online} seen recently</span>
          </span>
        </Stat>
        <Stat label="Last run">
          <span className="truncate">{g.lastRun ? ago(g.lastRun) : "—"}</span>
        </Stat>
        <Stat label="Owner">
          <span className="truncate">{g.owner || "—"}</span>
        </Stat>
      </div>

      <section className="mt-6">
        <div className="eyebrow mb-2">Machines</div>
        {machines.length === 0 ? (
          <p className="text-xs text-subtle">No machines in this group (or none this account can see).</p>
        ) : (
          <ul className="card max-w-3xl p-1">
            {machines.map((m) => (
              <li key={m.id}>
                <MachineItem machine={m} selected={false} indent={false} onOpen={() => onOpen(m.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <RecentRuns connId={connId} filter={{ groupId: g.id }} showFlow onAll={() => openRuns(runs)} />
    </div>
  );
}

