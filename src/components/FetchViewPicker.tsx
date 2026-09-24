import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { formatFetchXml } from "../lib/fetchXml";
import { friendlyError } from "../lib/errors";
import { useTables } from "../lib/fetchMeta";
import { Modal } from "./Modals";
import { Combo } from "./FetchNodePanel";
import { AlertTriangle, Folder, Loader, Search } from "./Icon";
import type { SavedView, ViewList } from "../types";

type Kind = "all" | "system" | "personal";

/** Views per `${connId}|${table}` while the app runs (Refresh reads them again). */
const cache = new Map<string, ViewList>();

/**
 * Lists a table's system and personal views; opening one puts its FetchXML
 * in the editor. Views are only read, never changed.
 */
export function FetchViewPicker({
  connId,
  initialTable,
  onOpen,
  onClose,
}: {
  connId: string;
  initialTable: string;
  onOpen: (view: SavedView, table: string) => void;
  onClose: () => void;
}) {
  const { tables, loading: tablesLoading } = useTables(connId);
  const tableOptions = useMemo(() => tables?.map((t) => ({ value: t.logicalName, label: t.displayName || undefined })), [tables]);
  const [table, setTable] = useState(initialTable);
  const [list, setList] = useState<ViewList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!table) return;
    const key = `${connId}|${table}`;
    const cached = cache.get(key);
    setError(null);
    if (cached) {
      setList(cached);
      return;
    }
    let live = true;
    setLoading(true);
    setList(null);
    api
      .listViews(connId, table)
      .then((l) => {
        cache.set(key, l);
        if (live) setList(l);
      })
      .catch((e) => live && setError(friendlyError(String(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [connId, table, reload]);

  const needle = q.trim().toLowerCase();
  const views = useMemo(
    () =>
      (list?.views ?? []).filter(
        (v) =>
          (kind === "all" || (kind === "personal") === v.personal) &&
          (!needle || v.name.toLowerCase().includes(needle) || v.typeLabel.toLowerCase().includes(needle))
      ),
    [list, kind, needle]
  );
  const counts = useMemo(() => {
    const all = list?.views ?? [];
    return { all: all.length, system: all.filter((v) => !v.personal).length, personal: all.filter((v) => v.personal).length };
  }, [list]);

  // Keep a view picked: the first one after a new list or filter.
  useEffect(() => {
    if (!views.some((v) => v.id === picked)) setPicked(views[0]?.id ?? null);
  }, [views, picked]);

  const current = views.find((v) => v.id === picked) ?? null;
  const preview = useMemo(() => (current ? formatFetchXml(current.fetchXml) ?? current.fetchXml : ""), [current]);

  const open = (v: SavedView | null) => v && onOpen(v, table);

  const onListKey = (e: React.KeyboardEvent) => {
    const i = views.findIndex((v) => v.id === picked);
    if (e.key === "ArrowDown") setPicked(views[Math.min(views.length - 1, i + 1)]?.id ?? null);
    else if (e.key === "ArrowUp") setPicked(views[Math.max(0, i - 1)]?.id ?? null);
    else if (e.key === "Enter") open(current);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-id="${picked}"]`)?.scrollIntoView({ block: "nearest" });
  }, [picked]);

  return (
    <Modal title="Open a view" icon={<Folder size={15} />} onClose={onClose} width="max-w-5xl">
      <div className="grid h-[min(560px,68vh)] grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-4">
        <div className="flex min-h-0 flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
            <Combo value={table} options={tableOptions} loading={tablesLoading} placeholder="Table, e.g. account" onCommit={(v) => setTable(v.toLowerCase())} />
            <button className="btn btn-ghost btn-sm h-8" onClick={() => {
                cache.delete(`${connId}|${table}`);
                setReload((n) => n + 1);
              }} disabled={!table || loading} title="Read the views again">
              Refresh
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
              <input
                className="input h-8 !pl-8 text-[13px]"
                placeholder="Find a view…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onListKey}
                aria-label="Find a view"
              />
            </div>
            <div className="seg shrink-0" role="group" aria-label="View kind">
              {(["all", "system", "personal"] as Kind[]).map((k) => (
                <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === "all" ? "All" : k === "system" ? "System" : "Personal"}{" "}
                  <span className="seg-count">{counts[k]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-s1">
            {!table ? (
              <p className="p-4 text-xs text-subtle">Pick a table to see its views.</p>
            ) : loading ? (
              <div className="flex items-center gap-2 p-4 text-xs text-subtle">
                <Loader size={13} /> Reading the views of {table}…
              </div>
            ) : error ? (
              <div className="flex gap-2 p-4 text-xs text-danger">
                <AlertTriangle size={14} className="shrink-0" /> {error}
              </div>
            ) : (
              <ul ref={listRef} className="h-full overflow-y-auto p-1" role="listbox" aria-label="Views" tabIndex={0} onKeyDown={onListKey}>
                {views.map((v) => (
                  <li
                    key={`${v.personal}|${v.id}`}
                    data-id={v.id}
                    role="option"
                    aria-selected={v.id === picked}
                    onClick={() => setPicked(v.id)}
                    onDoubleClick={() => open(v)}
                    className={`flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] ${
                      v.id === picked ? "bg-brand/12 text-fg" : "text-muted hover:bg-s3 hover:text-fg"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{v.name || "(no name)"}</span>
                    {v.isDefault && <span className="badge badge-brand shrink-0">Default</span>}
                    <span className={`badge shrink-0 ${v.personal ? "badge-info" : "badge-neutral"}`}>{v.typeLabel}</span>
                  </li>
                ))}
                {list && views.length === 0 && <li className="p-3 text-xs text-subtle">No views match.</li>}
              </ul>
            )}
          </div>
          {list?.personalError && (
            <p className="text-xs text-warning" title={list.personalError}>
              Personal views couldn't be read — only system views are listed.
            </p>
          )}
        </div>

        <div className="flex min-h-0 flex-col gap-2">
          {current ? (
            <>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{current.name}</div>
                  <div className="text-xs text-subtle">
                    {current.personal ? "Personal view" : "System view"} · {current.typeLabel}
                    {current.description ? ` · ${current.description}` : ""}
                  </div>
                </div>
                <button className="btn btn-primary btn-sm shrink-0" onClick={() => open(current)} title="Put this view's FetchXML in the editor (Enter)">
                  Open in editor
                </button>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-line p-3 font-mono text-[12px] leading-relaxed text-fg" style={{ background: "var(--editor-bg)" }}>
                {preview}
              </pre>
              <p className="text-[11px] text-subtle">The view isn't changed — you get a copy of its query. Ctrl+Z in the editor brings back what was there.</p>
            </>
          ) : (
            <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-line text-xs text-subtle">
              {table ? "Pick a view to preview its FetchXML." : ""}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
