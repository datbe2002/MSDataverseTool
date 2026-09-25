import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useStore } from "../store";
import { useTables } from "../lib/fetchMeta";
import {
  childrenFrom,
  filterTree,
  indexOf,
  overviewCache,
  runOrder,
  stepCache,
  stepsCache,
  treeByAssembly,
  treeByTable,
  visibleRows,
  type Index,
  type Resolved,
  type TreeNode,
} from "../lib/plugins";
import { DEFAULT_FILTERS as DEFAULT_TRACE_FILTERS, shortType, useTraces } from "../lib/traces";
import { DEFAULT_JOB_FILTERS, useJobs } from "../lib/jobs";
import { useDebounced } from "../lib/useDebounced";
import { relativeTime } from "../lib/history";
import { ROUTES } from "../lib/navigation";
import { Stat } from "./LogParts";
import { Search, Refresh, Plug, ChevronDown, Bug, Activity, Copy, Loader } from "./Icon";
import type { PluginOverview, PluginStep } from "../types";

type View = "assembly" | "table";
const VIEW_KEY = "cds.plugins.view";
const HIDE_MS_KEY = "cds.plugins.hideMicrosoft";

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only a convenience.
  }
}

const time = (iso: string) => (iso ? relativeTime(Date.parse(iso)) : "—");

export function PluginsView() {
  const activeId = useStore((s) => s.activeId);
  const [hideMs, setHideMsState] = useState(() => read(HIDE_MS_KEY, "1") === "1");
  const overview = overviewCache.useEntry(activeId, hideMs ? "hide" : "all");
  const stepsData = stepsCache.useStore((s) => s.data);
  const stepsErrors = stepsCache.useStore((s) => s.errors);
  const { tables } = useTables(activeId ?? "");
  const [params, setParams] = useSearchParams();
  const selected = params.get("node");
  const view: View = params.get("view") === "table" || params.get("view") === "assembly" ? (params.get("view") as View) : (read(VIEW_KEY, "assembly") as View);
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 350);
  const [hideDisabled, setHideDisabled] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const setHideMs = (on: boolean) => {
    write(HIDE_MS_KEY, on ? "1" : "0");
    setHideMsState(on);
  };
  const setView = (v: View) => {
    write(VIEW_KEY, v);
    const next = new URLSearchParams(params);
    next.set("view", v);
    setParams(next, { replace: true });
  };
  const select = useCallback(
    (key: string) => {
      const next = new URLSearchParams(params);
      next.set("node", key);
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const tableLabel = useMemo(() => {
    const map = new Map((tables ?? []).map((t) => [t.logicalName, t.displayName]));
    return (t: string) => map.get(t);
  }, [tables]);
  const o = overview.data;
  const ix = useMemo(() => (o ? indexOf(o) : null), [o]);
  const tree = useMemo(() => (!o || !ix ? [] : view === "table" ? treeByTable(ix, tableLabel) : treeByAssembly(o, ix)), [o, ix, view, tableLabel]);
  const shown = useMemo(() => filterTree(tree, q), [tree, q]);

  const resolve = useCallback(
    (node: TreeNode): Resolved => {
      if (node.children) return { status: "ready", nodes: node.children };
      const k = `${activeId}|${node.lazy}`;
      const steps = stepsData[k];
      if (steps && ix) return { status: "ready", nodes: childrenFrom(node, steps, ix, hideDisabled) };
      if (stepsErrors[k]) return { status: "error", error: stepsErrors[k] };
      return { status: "loading" };
    },
    [activeId, stepsData, stepsErrors, ix, hideDisabled]
  );
  const rows = useMemo(() => visibleRows(shown, open, resolve), [shown, open, resolve]);
  const nodeRows = useMemo(() => rows.filter((r) => r.type === "node"), [rows]);

  // Open lazy nodes load their steps (once; a failed one waits for Retry).
  useEffect(() => {
    if (!activeId) return;
    for (const r of rows) {
      if (r.type === "loading" && r.parent.lazy) stepsCache.load(activeId, r.parent.lazy).catch(() => {});
    }
  }, [rows, activeId]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, rows.length]);

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const reveal = useCallback((keys: string[]) => setOpen((s) => (keys.every((k) => s.has(k)) ? s : new Set([...s, ...keys]))), []);

  const onKey = (e: React.KeyboardEvent) => {
    const i = nodeRows.findIndex((r) => r.type === "node" && r.node.key === selected);
    const row = nodeRows[i];
    const move = (to: number) => {
      const r = nodeRows[Math.max(0, Math.min(nodeRows.length - 1, to))];
      if (r?.type === "node") select(r.node.key);
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "ArrowRight" && row?.type === "node" && row.expandable) {
      if (!row.open) toggle(row.node.key);
      else move(i + 1);
    } else if (e.key === "ArrowLeft" && row?.type === "node") {
      if (row.open) toggle(row.node.key);
      else {
        const parent = nodeRows.slice(0, i).reverse().find((r) => r.depth < row.depth);
        if (parent?.type === "node") select(parent.node.key);
      }
    } else return;
    e.preventDefault();
  };

  if (!activeId) {
    return <div className="flex h-full items-center justify-center text-sm text-subtle">Select an environment to see its plug-in registrations.</div>;
  }

  const refresh = () => {
    // Everything read for this environment goes; open nodes and the detail read again.
    stepsCache.forget(activeId);
    stepCache.forget(activeId);
    overview.reload();
  };
  const searching = dq.length >= 3;
  const shownSteps = ix ? [...ix.byTable.values()].reduce((n, c) => n + c.total, 0) : 0;
  const disabledSteps = ix ? [...ix.byTable.values()].reduce((n, c) => n + c.disabled, 0) : 0;

  return (
    <div className="grid h-full grid-cols-[clamp(340px,34vw,460px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input className="input !pl-8" placeholder="Filter assemblies, classes · search steps…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the tree and search steps" />
          </div>
          <button className="btn btn-ghost btn-icon" onClick={refresh} disabled={overview.loading} title="Read the registrations again" aria-label="Refresh">
            <Refresh size={14} className={overview.loading ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="seg mx-3 mt-2.5 !flex" role="group" aria-label="Group by">
          <button className="flex-1" aria-pressed={view === "assembly"} onClick={() => setView("assembly")}>
            By assembly
          </button>
          <button className="flex-1" aria-pressed={view === "table"} onClick={() => setView("table")}>
            By table · run order
          </button>
        </div>
        <div className="flex items-center gap-4 px-4 pt-2.5 text-[12px] text-muted">
          <label className="flex cursor-pointer items-center gap-1.5" title="Microsoft.* assemblies (Dynamics 365 apps) — thousands of steps">
            <input type="checkbox" checked={hideMs} onChange={(e) => setHideMs(e.target.checked)} className="accent-[var(--brand)]" />
            Hide Microsoft
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={hideDisabled} onChange={(e) => setHideDisabled(e.target.checked)} className="accent-[var(--brand)]" />
            Hide disabled
          </label>
          <button className="btn btn-ghost btn-sm ml-auto" onClick={() => setOpen(new Set())} disabled={!open.size}>
            Collapse all
          </button>
        </div>
        <div className="px-4 pb-1.5 pt-2 text-[11.5px] text-subtle">
          {o && ix ? (
            <>
              {o.assemblies.length} assembl{o.assemblies.length === 1 ? "y" : "ies"} · {shownSteps} step{shownSteps === 1 ? "" : "s"}
              {disabledSteps > 0 && ` · ${disabledSteps} disabled`}
              {ix.hidden > 0 && <span title="Steps of Microsoft's assemblies or other handlers"> · {ix.hidden} hidden</span>}
            </>
          ) : (
            " "
          )}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="tree" aria-label="Plug-in registrations" tabIndex={0} onKeyDown={onKey}>
          {searching && <StepSearch connId={activeId} q={dq} ix={ix} selected={selected} onSelect={select} />}
          {overview.error ? (
            <div className="px-3 py-8 text-center text-xs text-subtle">
              <div className="text-warning">Couldn't read the plug-in registrations.</div>
              <div className="mt-1 break-words">{overview.error}</div>
              <button className="btn btn-secondary btn-sm mt-3" onClick={overview.reload}>
                <Refresh size={12} /> Retry
              </button>
            </div>
          ) : !o ? (
            Array.from({ length: 10 }, (_, i) => <div key={i} className="skeleton mx-2 my-2.5 h-3" style={{ width: `${40 + ((i * 29) % 45)}%` }} />)
          ) : rows.length === 0 ? (
            !searching && (
              <div className="fade-in px-3 py-10 text-center">
                <div className="empty-icon">
                  <Plug size={18} />
                </div>
                <div className="mt-3 text-sm font-medium">{q.trim() ? "No assembly or class matches" : "No custom plug-ins"}</div>
                <div className="mt-1 text-xs text-subtle">
                  {q.trim() ? "Type 3 letters or more to search step names too." : hideMs ? "Untick “Hide Microsoft” to see Microsoft's assemblies." : "This environment has no custom plug-in or webhook steps."}
                </div>
              </div>
            )
          ) : (
            <>
              {searching && <div className="eyebrow px-2.5 pb-1 pt-3">Assemblies &amp; classes</div>}
              {rows.map((r) =>
                r.type === "node" ? (
                  <TreeRow
                    key={r.node.key}
                    node={r.node}
                    depth={r.depth}
                    open={r.open}
                    expandable={r.expandable}
                    selected={r.node.key === selected}
                    onSelect={() => select(r.node.key)}
                    onToggle={() => toggle(r.node.key)}
                  />
                ) : (
                  <div key={r.key} className="flex items-center gap-2 py-1 text-[12px] text-subtle" style={{ paddingLeft: 30 + r.depth * 16 }}>
                    {r.type === "loading" ? (
                      <>
                        <Loader size={12} className="text-brand" /> Loading steps…
                      </>
                    ) : r.type === "empty" ? (
                      hideDisabled ? "No enabled steps" : "No steps"
                    ) : (
                      <>
                        <span className="truncate text-warning" title={r.error}>
                          Couldn't load: {r.error}
                        </span>
                        {r.parent.lazy && (
                          <button className="btn btn-ghost btn-sm" onClick={() => stepsCache.load(activeId, r.parent.lazy!, true).catch(() => {})}>
                            Retry
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )
              )}
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto">
        {o && ix && selected ? (
          <Detail key={selected} connId={activeId} o={o} ix={ix} nodeKey={selected} view={view} onSelect={select} onReveal={reveal} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="empty-icon">
              <Plug size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">Nothing selected</div>
              <div className="mt-0.5 max-w-sm text-xs text-subtle">
                Pick an assembly, class or step on the left. “By table” shows the steps of each message in the order they run.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  open,
  expandable,
  selected,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  open: boolean;
  expandable: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={expandable ? open : undefined}
      aria-level={depth + 1}
      className="outline-row flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2"
      style={{ paddingLeft: 6 + depth * 16 }}
      onClick={onSelect}
      onDoubleClick={() => expandable && onToggle()}
      title={node.sub ? `${node.label}\n${node.sub}` : node.label}
    >
      <button
        className={`grid h-4 w-4 shrink-0 place-items-center text-subtle ${expandable ? "" : "invisible"}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        tabIndex={-1}
        aria-label={open ? "Collapse" : "Expand"}
      >
        <ChevronDown size={12} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      <KindTag kind={node.kind} />
      <span className={`min-w-0 flex-1 truncate text-[13px] ${node.dim ? "text-subtle line-through decoration-line-strong" : ""}`}>
        {node.label}
        {node.sub && node.kind !== "type" && <span className="ml-2 text-[11.5px] text-subtle">{node.sub}</span>}
      </span>
      {node.tag && <span className="badge badge-neutral shrink-0 !text-[10.5px]">{node.tag}</span>}
      {node.count && node.count.total > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-subtle" title={`${node.count.total} steps${node.count.disabled ? `, ${node.count.disabled} disabled` : ""}`}>
          {node.count.total}
        </span>
      )}
    </div>
  );
}

const KIND_TAGS: Record<TreeNode["kind"], [string, string]> = {
  assembly: ["asm", "text-brand"],
  type: ["cls", "text-info"],
  step: ["stp", "text-success"],
  endpoints: ["ext", "text-warning"],
  endpoint: ["ext", "text-warning"],
  table: ["tbl", "text-brand"],
  message: ["msg", "text-info"],
};

function KindTag({ kind }: { kind: TreeNode["kind"] }) {
  const [label, color] = KIND_TAGS[kind];
  return <span className={`w-[26px] shrink-0 font-mono text-[10.5px] ${color}`}>{label}</span>;
}

/** Steps whose name contains the search, read from the server. */
function StepSearch({ connId, q, ix, selected, onSelect }: { connId: string; q: string; ix: Index | null; selected: string | null; onSelect: (key: string) => void }) {
  const found = stepsCache.useEntry(connId, `search:${q}`);
  const steps = (found.data ?? []).filter((s) => !ix || !s.handlerId || ix.visible.has(s.handlerId));
  return (
    <div className="pb-1">
      <div className="eyebrow flex items-center gap-2 px-2.5 pb-1 pt-2">
        Steps named “{q}”
        {found.loading && <Loader size={11} className="text-brand" />}
        {found.data && <span className="font-normal normal-case tracking-normal">{steps.length}{found.data.length >= 500 ? "+" : ""}</span>}
      </div>
      {found.error ? (
        <div className="px-2.5 py-1 text-xs text-warning">{found.error}</div>
      ) : found.data && steps.length === 0 ? (
        <div className="px-2.5 py-1 text-xs text-subtle">No step name contains it.</div>
      ) : (
        steps.map((s) => (
          <div
            key={s.id}
            role="treeitem"
            aria-selected={`step:${s.id}` === selected}
            className="outline-row flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2 pr-2"
            onClick={() => onSelect(`step:${s.id}`)}
            title={s.name}
          >
            <KindTag kind="step" />
            <span className={`min-w-0 flex-1 truncate text-[13px] ${s.enabled ? "" : "text-subtle line-through"}`}>{s.name}</span>
            <span className="shrink-0 text-[11px] text-subtle">{s.stageLabel}</span>
          </div>
        ))
      )}
    </div>
  );
}

/* ---------- details ---------- */

function Detail({
  connId,
  o,
  ix,
  nodeKey,
  view,
  onSelect,
  onReveal,
}: {
  connId: string;
  o: PluginOverview;
  ix: Index;
  nodeKey: string;
  view: View;
  onSelect: (key: string) => void;
  onReveal: (keys: string[]) => void;
}) {
  const i = nodeKey.indexOf(":");
  const [kind, id] = [nodeKey.slice(0, i), nodeKey.slice(i + 1)];

  if (kind === "step") return <StepDetail connId={connId} o={o} id={id} view={view} onSelect={onSelect} onReveal={onReveal} />;
  if (kind === "assembly") {
    const a = o.assemblies.find((x) => x.id === id);
    if (!a) return <Missing what="assembly" />;
    const types = o.types.filter((t) => t.assemblyId === a.id);
    const counts = types.map((t) => ix.byHandler.get(t.id));
    return (
      <Page title={a.name} sub={`Version ${a.version}`} badges={[a.isolation === "Sandbox" ? "Sandbox" : `Isolation: ${a.isolation}`, a.managed ? "managed" : "unmanaged"]}>
        <div className="card grid grid-cols-4 divide-x divide-line">
          <Stat label="Classes">{types.length}</Stat>
          <Stat label="Steps">{counts.reduce((n, c) => n + (c?.total ?? 0), 0)}</Stat>
          <Stat label="Disabled">{counts.reduce((n, c) => n + (c?.disabled ?? 0), 0)}</Stat>
          <Stat label="Modified">{time(a.modifiedOn)}</Stat>
        </div>
        {a.description && <Field label="Description">{a.description}</Field>}
        <Section title="Classes">
          {types.map((t) => (
            <LinkRow
              key={t.id}
              onClick={() => onSelect(`type:${t.id}`)}
              label={t.typeName}
              hint={`${ix.byHandler.get(t.id)?.total ?? 0} steps${t.isWorkflowActivity ? " · workflow activity" : ""}`}
            />
          ))}
        </Section>
      </Page>
    );
  }
  if (kind === "type" || kind === "endpoint") {
    const t = kind === "type" ? o.types.find((x) => x.id === id) : null;
    const e = kind === "endpoint" ? o.endpoints.find((x) => x.id === id) : null;
    if (!t && !e) return <Missing what={kind === "type" ? "class" : "endpoint"} />;
    const a = t && o.assemblies.find((x) => x.id === t.assemblyId);
    return (
      <Page title={t ? shortType(t.typeName) : e!.name} sub={t?.typeName ?? e!.contract} badges={[t ? (t.isWorkflowActivity ? "Workflow activity" : "Plug-in") : "Service endpoint"]}>
        {a && (
          <Field label="Assembly">
            <button className="hover:text-brand hover:underline" onClick={() => onSelect(`assembly:${a.id}`)}>
              {a.name}
            </button>{" "}
            <span className="text-subtle">{a.version}</span>
          </Field>
        )}
        <LoadedSteps connId={connId} cacheKey={`handler:${id}`} title="Steps" onSelect={onSelect} empty="No step runs it." />
      </Page>
    );
  }
  if (kind === "table" || kind === "message") {
    const [table, message] = kind === "message" ? id.split("|") : [id, null];
    return (
      <Page title={message ? `${message} on ${table}` : table === "none" ? "(no table)" : table} sub={message ? undefined : `${ix.byTable.get(table)?.total ?? 0} steps`} badges={[]}>
        <LoadedSteps connId={connId} cacheKey={`table:${table}`} title="Steps in the order they run" onSelect={onSelect} message={message} ordered empty="No steps." />
      </Page>
    );
  }
  if (kind === "endpoints") {
    return (
      <Page title="Service endpoints & webhooks" badges={[]}>
        <Section title="Endpoints">
          {o.endpoints.map((e) => (
            <LinkRow key={e.id} onClick={() => onSelect(`endpoint:${e.id}`)} label={e.name} hint={`${e.contract} · ${ix.byHandler.get(e.id)?.total ?? 0} steps`} />
          ))}
        </Section>
      </Page>
    );
  }
  return <Missing what="item" />;
}

/** Steps from the steps cache (a handler's or a table's), optionally one message's. */
function LoadedSteps({
  connId,
  cacheKey,
  title,
  onSelect,
  message,
  ordered,
  current,
  empty,
}: {
  connId: string;
  cacheKey: string;
  title: string;
  onSelect: (key: string) => void;
  message?: string | null;
  ordered?: boolean;
  current?: string;
  empty: string;
}) {
  const entry = stepsCache.useEntry(connId, cacheKey);
  if (entry.error) {
    return (
      <Section title={title}>
        <div className="text-[12.5px] text-warning">Couldn't load the steps: {entry.error}</div>
      </Section>
    );
  }
  if (!entry.data) {
    return (
      <Section title={title}>
        <div className="flex items-center gap-2 text-[12.5px] text-subtle">
          <Loader size={12} className="text-brand" /> Loading steps…
        </div>
      </Section>
    );
  }
  const list = message ? entry.data.filter((s) => s.message === message) : entry.data;
  return <StepList title={`${title} (${list.length})`} steps={ordered ? runOrder(list) : list} onSelect={onSelect} ordered={ordered} current={current} empty={empty} />;
}

function StepDetail({
  connId,
  o,
  id,
  view,
  onSelect,
  onReveal,
}: {
  connId: string;
  o: PluginOverview;
  id: string;
  view: View;
  onSelect: (key: string) => void;
  onReveal: (keys: string[]) => void;
}) {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.pushToast);
  const entry = stepCache.useEntry(connId, id);
  const step = entry.data?.step;

  // Opened from elsewhere (a trace, a dependency, a search): open the tree down to it.
  useEffect(() => {
    if (!entry.data) return;
    const { step: s, assemblyId } = entry.data;
    if (view === "table") onReveal([`table:${s.table}`, `message:${s.table}|${s.message}`]);
    else if (s.handlerKind === "serviceendpoint") onReveal(["endpoints:all", `endpoint:${s.handlerId}`]);
    else if (assemblyId && s.handlerId) onReveal([`assembly:${assemblyId}`, `type:${s.handlerId}`]);
  }, [entry.data, view, onReveal]);

  if (entry.error) return <Missing what="step" detail={entry.error} />;
  if (!step || !entry.data) {
    return (
      <div className="space-y-3 p-8">
        <div className="skeleton h-5 w-1/2" />
        <div className="skeleton h-3 w-1/3" />
        <div className="skeleton mt-6 h-16" />
      </div>
    );
  }
  const images = entry.data.images;
  const handlerType = o.types.find((t) => t.id === step.handlerId);

  const openTraces = () => {
    useTraces.getState().setFilters(connId, {
      ...DEFAULT_TRACE_FILTERS,
      typeName: handlerType?.typeName ?? step.handlerName ?? "",
      message: step.message,
      entity: step.table === "none" ? "" : step.table,
    });
    navigate(ROUTES.traces);
  };
  const openJobs = () => {
    useJobs.getState().setFilters(connId, { ...DEFAULT_JOB_FILTERS, name: step.name, range: "7d" });
    navigate(ROUTES.jobs);
  };
  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));

  return (
    <Page
      title={step.name || "(no name)"}
      sub={step.description ?? undefined}
      badges={[step.enabled ? "Enabled" : "Disabled", step.mode === 1 ? "Asynchronous" : "Synchronous", step.managed ? "managed" : "unmanaged"]}
      tone={step.enabled ? undefined : "warning"}
      actions={
        <>
          <button className="btn btn-secondary" onClick={openTraces} title="Plug-in trace logs of this class on this message and table">
            <Bug size={14} /> Trace logs
          </button>
          {step.mode === 1 && (
            <button className="btn btn-ghost" onClick={openJobs} title="System jobs this asynchronous step created (last 7 days)">
              <Activity size={14} /> System jobs
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => copy(step.id, "step id")} title={step.id}>
            <Copy size={14} /> Copy id
          </button>
        </>
      }
    >
      <div className="card grid grid-cols-4 divide-x divide-line">
        <Stat label="Message">{step.message}</Stat>
        <Stat label="Table">
          <span className="truncate font-mono text-[13px]">{step.table === "none" ? "—" : step.table}</span>
          {step.secondaryTable && <span className="ml-1.5 text-xs text-subtle">+ {step.secondaryTable}</span>}
        </Stat>
        <Stat label="Stage">{step.stageLabel}</Stat>
        <Stat label="Order">#{step.rank}</Stat>
      </div>

      <Field label="Handler">
        {handlerType ? (
          <button className="hover:text-brand hover:underline" onClick={() => onSelect(`type:${handlerType.id}`)}>
            {handlerType.typeName}
          </button>
        ) : step.handlerKind === "serviceendpoint" && step.handlerId ? (
          <button className="hover:text-brand hover:underline" onClick={() => onSelect(`endpoint:${step.handlerId}`)}>
            {step.handlerName} <span className="text-subtle">(service endpoint / webhook)</span>
          </button>
        ) : (
          step.handlerName ?? "—"
        )}
      </Field>
      <Field label="Runs as">{step.runAs ?? "Calling user"}</Field>
      <Field label="Deployment">{step.deployment}</Field>
      {step.mode === 1 && <Field label="Delete job when done">{step.asyncAutoDelete ? "Yes" : "No"}</Field>}
      <Field label="Modified">{time(step.modifiedOn)}</Field>

      <Section title="Filtering columns">
        <Chips
          items={step.filteringAttributes}
          empty={step.message === "Update" ? "Any column — the step runs on every update (consider filtering columns)" : "Not used for this message"}
          warn={step.message === "Update" && !step.filteringAttributes.length}
        />
      </Section>

      <Section title={`Images (${images.length})`}>
        {images.length === 0 ? (
          <div className="text-[12.5px] text-subtle">No images.</div>
        ) : (
          images.map((img) => (
            <div key={img.id} className="rounded-md px-2 py-1.5">
              <span className="text-[13px] font-medium">{img.alias || img.name}</span>
              <span className="ml-2 text-[12px] text-subtle">
                {["Pre-image", "Post-image", "Pre & post image"][img.imageType]} · {img.messageProperty}
              </span>
              <span className={`mt-0.5 block truncate font-mono text-[11.5px] ${img.attributes.length ? "text-muted" : "text-warning"}`}>
                {img.attributes.length ? img.attributes.join(", ") : "every column (heavier than it needs to be)"}
              </span>
            </div>
          ))
        )}
      </Section>

      {step.configuration && (
        <Section title="Unsecure configuration">
          <pre className="max-h-48 overflow-auto rounded-md border border-line bg-s2 p-3 font-mono text-[12px] whitespace-pre-wrap break-all">{step.configuration}</pre>
        </Section>
      )}

      <LoadedSteps
        connId={connId}
        cacheKey={`table:${step.table}`}
        title={`Order on ${step.message}${step.table === "none" ? "" : ` of ${step.table}`}`}
        message={step.message}
        onSelect={onSelect}
        ordered
        current={step.id}
        empty="No other steps."
      />
    </Page>
  );
}

function StepList({
  title,
  steps,
  onSelect,
  ordered,
  current,
  empty,
}: {
  title: string;
  steps: PluginStep[];
  onSelect: (key: string) => void;
  ordered?: boolean;
  current?: string;
  empty?: string;
}) {
  let lastStage = -1;
  return (
    <Section title={title}>
      {steps.length === 0 ? (
        <div className="text-[12.5px] text-subtle">{empty}</div>
      ) : (
        steps.map((s) => {
          const heading = ordered && s.stage !== lastStage ? ((lastStage = s.stage), s.stageLabel) : null;
          return (
            <div key={s.id}>
              {heading && <div className="eyebrow px-2 pb-1 pt-2.5">{heading}</div>}
              <button
                className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-s3 ${s.id === current ? "bg-brand/10" : ""}`}
                onClick={() => onSelect(`step:${s.id}`)}
              >
                {ordered && <span className="w-7 shrink-0 font-mono text-[12px] text-subtle">#{s.rank}</span>}
                <span className={`min-w-0 flex-1 truncate text-[13px] ${s.enabled ? "" : "text-subtle line-through"}`}>{s.name}</span>
                <span className="shrink-0 text-[12px] text-subtle">
                  {[ordered ? null : `${s.message} · ${s.table === "none" ? "any" : s.table}`, ordered ? null : s.stageLabel, s.mode === 1 ? "async" : null, s.enabled ? null : "off", s.id === current ? "this step" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            </div>
          );
        })
      )}
    </Section>
  );
}

function Page({
  title,
  sub,
  badges,
  tone,
  actions,
  children,
}: {
  title: string;
  sub?: string;
  badges: string[];
  tone?: "warning";
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="fade-in mx-auto max-w-[980px] px-6 pb-10 pt-7 xl:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-lg font-semibold tracking-tight">{title}</h2>
            {badges.filter(Boolean).map((b, i) => (
              <span key={b} className={`badge ${i === 0 && tone === "warning" ? "badge-warning" : i === 0 && b === "Enabled" ? "badge-success" : "badge-neutral"}`}>
                {b}
              </span>
            ))}
          </div>
          {sub && <p className="mt-0.5 break-words text-sm text-muted">{sub}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="mt-5 space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 text-[13px]">
      <span className="eyebrow w-40 shrink-0 leading-5">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card px-4 py-3">
      <h3 className="mb-2 text-[13.5px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Chips({ items, empty, warn }: { items: string[]; empty: string; warn?: boolean }) {
  if (!items.length) return <div className={`text-[12.5px] ${warn ? "text-warning" : "text-subtle"}`}>{empty}</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((a) => (
        <span key={a} className="badge badge-neutral font-mono">
          {a}
        </span>
      ))}
    </div>
  );
}

function LinkRow({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-s3" onClick={onClick}>
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      {hint && <span className="shrink-0 text-[12px] text-subtle">{hint}</span>}
    </button>
  );
}

function Missing({ what, detail }: { what: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center text-sm text-subtle">
      <div>Couldn't show this {what}.</div>
      {detail ? <div className="max-w-lg break-words text-xs">{detail}</div> : <div className="text-xs">It may be hidden (Microsoft) or gone. Refresh the list.</div>}
    </div>
  );
}
