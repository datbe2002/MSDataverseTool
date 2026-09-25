import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useStore } from "../store";
import { useColumns, useTables } from "../lib/fetchMeta";
import { depsOf, useDeps } from "../lib/deps";
import { flowRoute, pluginRoute } from "../lib/navigation";
import { Combo } from "./FetchNodePanel";
import { Link, Loader, Search, Check, AlertTriangle, ArrowUpRight, Flow, Plug } from "./Icon";
import type { DependencyItem } from "../types";

export function DependenciesView() {
  const activeId = useStore((s) => s.activeId);
  const st = useDeps((s) => depsOf(s, activeId));
  const setState = useDeps((s) => s.set);
  const check = useDeps((s) => s.check);
  const searchFlows = useDeps((s) => s.searchFlows);
  const navigate = useNavigate();
  const { tables, loading: tablesLoading } = useTables(activeId ?? "");
  const columns = useColumns(activeId ?? "", st.table || null);

  const tableOptions = useMemo(() => tables?.map((t) => ({ value: t.logicalName, label: t.displayName || undefined })), [tables]);
  const columnOptions = useMemo(() => columns?.map((c) => ({ value: c.logicalName, label: c.displayName || undefined })), [columns]);
  const groups = useMemo(() => {
    const map = new Map<string, DependencyItem[]>();
    for (const i of st.report?.items ?? []) (map.get(i.kindLabel) ?? map.set(i.kindLabel, []).get(i.kindLabel)!).push(i);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [st.report]);

  if (!activeId) {
    return <div className="flex h-full items-center justify-center text-sm text-subtle">Select an environment to check dependencies.</div>;
  }

  const set = (p: Parameters<typeof setState>[1]) => setState(activeId, p);
  const r = st.report;
  const nothing = r && r.items.length === 0 && r.steps.length === 0;
  const loading = st.status === "loading";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1040px] px-6 pb-12 pt-7 xl:px-8">
        <h1 className="page-title">Dependencies</h1>
        <p className="mt-1 text-sm text-muted">What uses a table or a column — before you delete or change it.</p>

        <form
          className="card mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-start gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            check(activeId);
          }}
        >
          <label className="block min-w-0">
            <span className="mb-1.5 block truncate text-xs font-medium text-muted">Table</span>
            <Combo value={st.table} onCommit={(v) => set({ table: v.trim().toLowerCase(), column: "" })} options={tableOptions} loading={tablesLoading} placeholder="account" hintSpace />
          </label>
          <label className="block min-w-0">
            <span className="mb-1.5 block truncate text-xs font-medium text-muted">Column (optional)</span>
            <Combo value={st.column} onCommit={(v) => set({ column: v.trim().toLowerCase() })} options={columnOptions} placeholder={st.table ? "Whole table" : "Pick a table first"} hintSpace />
          </label>
          <div>
            <span className="mb-1.5 block truncate text-xs font-medium text-muted">Show</span>
            <div className="seg" role="group" aria-label="What to show">
              <button type="button" aria-pressed={st.forDelete} onClick={() => set({ forDelete: true })} title="RetrieveDependenciesForDelete">
                Blocks deleting
              </button>
              <button type="button" aria-pressed={!st.forDelete} onClick={() => set({ forDelete: false })} title="RetrieveDependentComponents">
                Everything using it
              </button>
            </div>
          </div>
          <div>
            {/* Lines the button up with the inputs, under their labels. */}
            <span className="invisible mb-1.5 block text-xs font-medium" aria-hidden="true">
              Check
            </span>
            <button type="submit" className="btn btn-primary" disabled={!st.table || loading}>
              {loading ? <Loader size={14} /> : <Search size={14} />}
              Check
            </button>
          </div>
        </form>

        {st.status === "error" && (
          <div className="mt-5 flex gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm" role="alert">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
            <span>{st.error}</span>
          </div>
        )}

        {st.status === "idle" && (
          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <div className="empty-icon">
              <Link size={20} />
            </div>
            <div className="max-w-md text-xs text-subtle">
              Pick a table (and a column) and press Check. Dataverse's dependency tracking covers forms, views, charts, processes,
              relationships and apps; this also looks for plug-in steps that use it, and can search cloud flow definitions.
            </div>
          </div>
        )}

        {loading && (
          <div className="mt-6 space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="card space-y-2 p-4">
                <div className="skeleton h-3.5 w-40" />
                <div className="skeleton h-3 w-2/3" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            ))}
          </div>
        )}

        {r && st.status === "ready" && (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold">
                <span className="font-mono">{r.target}</span>
              </h2>
              <span className="text-sm text-muted">
                · {r.items.length} tracked component{r.items.length === 1 ? "" : "s"}
                {r.steps.length > 0 && ` · ${r.steps.length} plug-in step${r.steps.length === 1 ? "" : "s"}`}
              </span>
            </div>

            {nothing && (
              <div className="flex gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm">
                <Check size={16} className="mt-0.5 shrink-0 text-success" />
                <div>
                  <div className="font-medium">
                    {st.forDelete ? `Nothing in Dataverse blocks deleting ${r.target}.` : `Nothing in Dataverse depends on ${r.target}.`}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    Code outside Dataverse (flows, integrations, reports, JavaScript that builds names) isn't tracked — search the flows below.
                  </div>
                </div>
              </div>
            )}

            {groups.map(([label, items]) => (
              <section key={label} className="card overflow-hidden">
                <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                  <h3 className="text-[13.5px] font-semibold">{label}</h3>
                  <span className="text-xs tabular-nums text-subtle">{items.length}</span>
                </div>
                <ul className="divide-y divide-line">
                  {items.map((i) => {
                    const open =
                      i.kind === 29 && /flow/i.test(i.detail ?? "")
                        ? () => navigate(flowRoute(i.id))
                        : i.kind === 92
                        ? () => navigate(pluginRoute(`step:${i.id}`))
                        : null;
                    return (
                      <li key={`${i.kind}:${i.id}`} className="flex items-center gap-3 px-4 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]" title={i.name}>
                            {i.name}
                          </span>
                          {i.name === i.id && <span className="block text-[11.5px] text-subtle">Name not readable with this account</span>}
                        </span>
                        {i.detail && <span className="badge badge-neutral shrink-0">{i.detail}</span>}
                        {i.dependencyType === 4 && <span className="badge badge-warning shrink-0">unpublished</span>}
                        {i.table && <span className="shrink-0 font-mono text-[12px] text-subtle">{i.table}</span>}
                        {open && (
                          <button className="btn btn-ghost btn-sm shrink-0" onClick={open}>
                            Open <ArrowUpRight size={11} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            <section className="card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <Plug size={14} className="text-subtle" />
                <h3 className="text-[13.5px] font-semibold">Plug-in steps</h3>
                <span className="text-xs text-subtle">not tracked by Dataverse · {r.target.includes(".") ? "filtering columns and images" : "steps on the table"}</span>
              </div>
              {r.stepsError ? (
                <div className="px-4 py-3 text-xs text-warning">Couldn't read the plug-in steps: {r.stepsError}</div>
              ) : r.steps.length === 0 ? (
                <div className="px-4 py-3 text-xs text-subtle">No custom plug-in step uses it.</div>
              ) : (
                <ul className="divide-y divide-line">
                  {r.steps.map((s) => (
                    <li key={s.stepId} className="flex items-center gap-3 px-4 py-2">
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[13px] ${s.enabled ? "" : "text-subtle line-through"}`}>{s.stepName}</span>
                        <span className="block text-[11.5px] text-subtle">
                          {s.message} · {s.stageLabel} · {s.how}
                        </span>
                      </span>
                      <button className="btn btn-ghost btn-sm shrink-0" onClick={() => navigate(pluginRoute(`step:${s.stepId}`))}>
                        Open <ArrowUpRight size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <Flow size={14} className="text-subtle" />
                <h3 className="text-[13.5px] font-semibold">Cloud flows</h3>
                <span className="text-xs text-subtle">not tracked by Dataverse · a text search of flow definitions</span>
                {st.flows.status !== "loading" && (
                  <button className="btn btn-secondary btn-sm ml-auto" onClick={() => searchFlows(activeId)}>
                    <Search size={12} /> {st.flows.status === "ready" ? "Search again" : "Search flow definitions"}
                  </button>
                )}
              </div>
              {st.flows.status === "loading" ? (
                <div className="flex items-center gap-2 px-4 py-3 text-xs text-subtle" role="status">
                  <Loader size={12} className="text-brand" /> Reading every flow definition…
                </div>
              ) : st.flows.status === "error" ? (
                <div className="px-4 py-3 text-xs text-warning">{st.flows.error}</div>
              ) : st.flows.status === "ready" ? (
                st.flows.list.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-subtle">No flow definition names {st.flows.target}.</div>
                ) : (
                  <ul className="divide-y divide-line">
                    {st.flows.list.map((f) => (
                      <li key={f.id} className="flex items-center gap-3 px-4 py-2">
                        <span className="min-w-0 flex-1 truncate text-[13px]">{f.name || "(no name)"}</span>
                        <span className="shrink-0 text-[12px] tabular-nums text-subtle">
                          {f.hits} mention{f.hits === 1 ? "" : "s"}
                        </span>
                        <button className="btn btn-ghost btn-sm shrink-0" onClick={() => navigate(flowRoute(f.id))}>
                          Open <ArrowUpRight size={11} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <div className="px-4 py-3 text-xs text-subtle">
                  Finds flows whose definition names the table (logical or entity set name){r.target.includes(".") ? " and the column" : ""}. It can miss names built at run time.
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
