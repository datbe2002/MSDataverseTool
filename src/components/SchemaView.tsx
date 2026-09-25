import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useStore } from "../store";
import { columnKey, useSchema } from "../lib/schema";
import { Search, Refresh, Copy, Table } from "./Icon";

export function SchemaView() {
  const activeId = useStore((s) => s.activeId);
  const loadSql = useStore((s) => s.loadSql);
  const tables = useSchema((s) => (activeId ? s.tables[activeId] : undefined));
  const status = useSchema((s) => (activeId ? s.status[activeId] : undefined));
  const error = useSchema((s) => (activeId ? s.errors[activeId] : undefined));
  const loadTables = useSchema((s) => s.loadTables);
  const loadColumns = useSchema((s) => s.loadColumns);

  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "standard" | "custom">("all");
  // The picked table lives in the URL (?table=), so the command palette can open one.
  const [params, setParams] = useSearchParams();
  const selected = params.get("table")?.toLowerCase() || null;
  const setSelected = (table: string) => setParams({ table }, { replace: true });
  const listRef = useRef<HTMLUListElement>(null);
  const columns = useSchema((s) =>
    activeId && selected ? s.columns[columnKey(activeId, selected)] : undefined
  );

  useEffect(() => {
    if (activeId) loadTables(activeId);
  }, [activeId, loadTables]);

  useEffect(() => {
    if (activeId && selected) loadColumns(activeId, selected);
  }, [activeId, selected, loadColumns]);

  const counts = useMemo(() => {
    const all = tables ?? [];
    const custom = all.filter((t) => t.isCustom).length;
    return { all: all.length, custom, standard: all.length - custom };
  }, [tables]);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (tables ?? []).filter((t) => {
      if (kind === "custom" && !t.isCustom) return false;
      if (kind === "standard" && t.isCustom) return false;
      return !q || t.logicalName.includes(q) || t.displayName.toLowerCase().includes(q);
    });
  }, [tables, filter, kind]);

  const table = tables?.find((t) => t.logicalName === selected);

  // Opened at a table (from the palette): it may be far down the list.
  useEffect(() => {
    listRef.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, tables]);

  const reload = () => {
    if (!activeId) return;
    const s = useSchema.getState();
    s.reset(activeId);
    s.loadTables(activeId);
  };

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        Select a connection to browse its tables.
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[288px_minmax(0,1fr)]">
      {/* Table list */}
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="px-3 pt-3">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              className="input !pl-8"
              placeholder={tables ? `Filter ${tables.length.toLocaleString()} tables…` : "Filter tables…"}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter tables"
            />
          </div>
        </div>
        <div className="seg mx-3 my-2.5 !flex" role="group" aria-label="Filter by table kind">
          {(
            [
              ["all", "All", counts.all],
              ["standard", "Standard", counts.standard],
              ["custom", "Custom", counts.custom],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setKind(key)}
              aria-pressed={kind === key}
              className="flex-1"
            >
              {label}
              {tables && (
                <span className="seg-count">{count}</span>
              )}
            </button>
          ))}
        </div>
        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label="Tables">
          {status === "loading" || !tables ? (
            status === "error" ? (
              <li className="px-3 py-8 text-center text-xs text-subtle">
                <div className="text-warning">Couldn't load tables.</div>
                <div className="mt-1 break-words">{error}</div>
                <button className="btn btn-secondary btn-sm mt-3" onClick={reload}>
                  <Refresh size={12} /> Retry
                </button>
              </li>
            ) : (
              Array.from({ length: 10 }, (_, i) => (
                <li key={i} className="flex items-center gap-2.5 px-2.5 py-2">
                  <div className="skeleton h-5 w-5 rounded" />
                  <div className="flex-1 space-y-1.5">
                    <div className="skeleton h-3 w-2/3" />
                    <div className="skeleton h-2.5 w-1/2" />
                  </div>
                </li>
              ))
            )
          ) : list.length === 0 ? (
            <li className="fade-in px-3 py-10 text-center">
              <div className="empty-icon">
                <Search size={18} />
              </div>
              <div className="mt-3 text-sm font-medium">
                {filter.trim() ? `No tables match “${filter}”` : `No ${kind} tables`}
              </div>
              <div className="mt-1 text-xs text-subtle">
                {filter.trim() ? (
                  <>
                    Try the logical name, e.g. <span className="font-mono">new_</span>
                  </>
                ) : (
                  "Switch the filter above to see other tables."
                )}
              </div>
            </li>
          ) : (
            list.map((t) => (
              <li key={t.logicalName}>
                <button
                  role="option"
                  aria-selected={t.logicalName === selected}
                  aria-current={t.logicalName === selected ? "page" : undefined}
                  className="nav-item nav-item-tall"
                  onClick={() => setSelected(t.logicalName)}
                >
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${
                      t.isCustom ? "bg-warning/12 text-warning" : "bg-info/12 text-info"
                    }`}
                    aria-hidden="true"
                  >
                    <Table size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px]">{t.logicalName}</span>
                    <span className="block truncate text-xs font-normal text-subtle">
                      {t.displayName}
                      {t.isCustom ? " · custom" : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      {/* Columns */}
      <div className="min-h-0 overflow-y-auto">
        {!table ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="empty-icon"><Table size={20} /></div>
            <div>
              <div className="text-sm font-medium">No table selected</div>
              <div className="mt-0.5 text-xs text-subtle">Pick a table on the left to see its columns.</div>
            </div>
          </div>
        ) : (
          <div className="fade-in px-8 py-7" key={table.logicalName}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="min-w-0 font-mono text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{table.logicalName}</h2>
                  <span className={`badge ${table.isCustom ? "badge-warning" : "badge-neutral"}`}>
                    {table.isCustom ? "custom" : "system"}
                  </span>
                </div>
                <p className="text-sm text-muted [overflow-wrap:anywhere]">
                  {table.displayName}
                  {columns ? ` · ${columns.length} columns` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn btn-secondary"
                  disabled={!columns}
                  onClick={() =>
                    loadSql(
                      `SELECT TOP 100\n    ${(columns ?? [])
                        .slice(0, 8)
                        .map((c) => c.logicalName)
                        .join(",\n    ")}\nFROM ${table.logicalName}`
                    )
                  }
                >
                  SELECT TOP 100
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => navigator.clipboard.writeText(table.logicalName).catch(() => {})}
                >
                  <Copy size={14} /> Copy name
                </button>
              </div>
            </div>

            <div className="card mt-5 overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Logical name</th>
                    <th>Display name</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {!columns
                    ? Array.from({ length: 8 }, (_, i) => (
                        <tr key={i}>
                          <td><div className="skeleton h-3 w-32" /></td>
                          <td><div className="skeleton h-3 w-24" /></td>
                          <td><div className="skeleton h-3 w-16" /></td>
                        </tr>
                      ))
                    : columns.map((c) => (
                        <tr key={c.logicalName} className="row">
                          <td className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{c.logicalName}</td>
                          <td>{c.displayName}</td>
                          <td>
                            <span className="badge badge-neutral font-mono !text-[11px]">{c.attributeType}</span>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
