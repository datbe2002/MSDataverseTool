import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useStore } from "../store";
import { api } from "../api";
import {
  GROUPS,
  allFolders,
  base64ToBytes,
  baseName,
  buildTree,
  decodeText,
  dependentsCache,
  detailCache,
  fileNameFor,
  foldersOf,
  formatBytes,
  kindOf,
  listCache,
  matches,
  visibleRows,
  WR_SAVE_EVENT,
  draftContent,
  draftIds,
  draftKey,
  draftSize,
  editDraftText,
  isConflict,
  kindFromName,
  markPending,
  setDraft,
  useWrEdits,
  type DecodedText,
  type Filters,
  type TreeRow,
} from "../lib/webresources";
import { relativeTime } from "../lib/history";
import { flowRoute, pluginRoute } from "../lib/navigation";
import { EDITOR_FONT, EDITOR_THEME } from "../lib/monacoTheme";
import { ensureXrmTypes } from "../lib/xrmTypes";
import { friendlyError } from "../lib/errors";
import { Stat } from "./LogParts";
import { AlertTriangle, ArrowUpRight, ChevronDown, Copy, Folder, Globe, Loader, More, Pencil, Plus, Refresh, Save, Search, Upload } from "./Icon";
import { ConfirmWrite, ConflictDialog, DeleteDialog, Menu, NewWebResourceDialog, ReviewChanges, syncDiffModels, useTarget } from "./WebResourceDialogs";
import type { DependencyItem, WebResource, WebResourceDetail } from "../types";
import { SelectFace } from "./FormParts";

const HIDE_MS_KEY = "cds.webresources.hideMicrosoft";
/** Search results shown at once; the rest are counted. */
const MAX_FLAT = 500;

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Only a convenience.
  }
}

const time = (iso: string) => (iso ? relativeTime(Date.parse(iso)) : "—");

export function WebResourcesView() {
  const activeId = useStore((s) => s.activeId);
  const list = listCache.useEntry(activeId);
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const [filters, setFilters] = useState<Filters>(() => ({ q: "", group: "all", solution: "", hideMicrosoft: readFlag(HIDE_MS_KEY, true) }));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  // A folder can have the keyboard focus without being selected (the URL holds files only).
  const focusKey = useRef<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [publishingAll, setPublishingAll] = useState(false);
  const drafts = useWrEdits((s) => s.drafts);
  const pending = useWrEdits((s) => (activeId ? s.pending[activeId] : undefined)) ?? [];
  const pushToast = useStore((s) => s.pushToast);

  // Another environment's solutions and folders mean nothing here.
  useEffect(() => {
    setFilters((f) => ({ ...f, solution: "" }));
    setOpen(new Set());
  }, [activeId]);

  const patch = (p: Partial<Filters>) => {
    if (p.hideMicrosoft !== undefined) writeFlag(HIDE_MS_KEY, p.hideMicrosoft);
    setFilters((f) => ({ ...f, ...p }));
  };
  const select = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set("id", id);
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const data = list.data;
  const shown = useMemo(() => (data ? data.items.filter((r) => matches(r, filters)) : []), [data, filters]);
  const hiddenMs = useMemo(() => (data && filters.hideMicrosoft ? data.items.filter((r) => r.microsoft).length : 0), [data, filters.hideMicrosoft]);
  const searching = filters.q.trim().length > 0;
  const tree = useMemo(() => buildTree(shown), [shown]);
  const rows: TreeRow[] = useMemo(
    () => (searching ? shown.slice(0, MAX_FLAT).map((item) => ({ type: "file" as const, key: item.id, item, depth: 0 })) : visibleRows(tree, open)),
    [searching, shown, tree, open]
  );
  const row = useMemo(() => (selected && data ? data.items.find((r) => r.id === selected.toLowerCase()) ?? null : null), [selected, data]);

  // Everything under one prefix folder (`contoso_/…`, the usual layout): open it.
  useEffect(() => {
    if (tree.folders.length === 1) {
      const key = `dir:${tree.folders[0].path}`;
      setOpen((s) => (s.size ? s : new Set([key])));
    }
  }, [tree]);

  // Opened from elsewhere (palette, Dependencies): open the folders down to it.
  useEffect(() => {
    if (!row) return;
    const keys = foldersOf(row.name);
    setOpen((s) => (keys.every((k) => s.has(k)) ? s : new Set([...s, ...keys])));
  }, [row]);

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

  const onKey = (e: React.KeyboardEvent) => {
    const current = rows.some((r) => r.key === focusKey.current) ? focusKey.current : selected?.toLowerCase();
    const i = rows.findIndex((r) => r.key === current);
    const r = rows[i];
    const move = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!next) return;
      focusKey.current = next.key;
      if (next.type === "file") select(next.item.id);
      else setFocus(next.key);
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === "ArrowRight" && r?.type === "folder") {
      if (!r.open) toggle(r.key);
      else move(i + 1);
    } else if (e.key === "ArrowLeft" && r) {
      if (r.type === "folder" && r.open) toggle(r.key);
      else {
        const parent = rows.slice(0, i).reverse().find((x) => x.depth < r.depth);
        if (parent) move(rows.indexOf(parent));
      }
    } else if (e.key === "Enter" && r?.type === "folder") toggle(r.key);
    else return;
    e.preventDefault();
  };
  if (!activeId) {
    return <div className="flex h-full items-center justify-center text-sm text-subtle">Select an environment to see its web resources.</div>;
  }

  const refresh = () => {
    detailCache.forget(activeId);
    dependentsCache.forget(activeId);
    list.reload();
  };
  const unsaved = draftIds(drafts, activeId);
  const nameOf = (id: string) => data?.items.find((r) => r.id === id)?.name ?? id;
  const clearSelection = () => {
    const next = new URLSearchParams(params);
    next.delete("id");
    setParams(next, { replace: true });
  };
  // New web resources start in the folder of the selected one (after `contoso_/`).
  const startFolder = (() => {
    const parts = row?.name.split("/") ?? [];
    return parts.length > 2 && parts[0].endsWith("_") ? parts.slice(1, -1).join("/") : "";
  })();
  const publishAll = async () => {
    const ids = pending;
    await api.publishWebResources(activeId, ids);
    markPending(activeId, ids, false);
    for (const i of ids) if (detailCache.useStore.getState().data[`${activeId}|${i}`]) detailCache.load(activeId, i, true).catch(() => {});
    pushToast({ tone: "success", title: `Published ${ids.length} web resource${ids.length === 1 ? "" : "s"}` });
  };
  const anyFolderOpen = open.size > 0;

  return (
    <div className="grid h-full grid-cols-[clamp(320px,32vw,440px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              className="input !pl-8"
              placeholder="Filter by name, display name or id…"
              value={filters.q}
              onChange={(e) => patch({ q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape" && filters.q) {
                  e.stopPropagation();
                  patch({ q: "" });
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  listRef.current?.focus();
                  const first = rows.find((r) => r.type === "file");
                  const shownNow = rows.some((r) => r.key === selected?.toLowerCase());
                  if (!shownNow && first?.type === "file") {
                    focusKey.current = first.key;
                    select(first.item.id);
                  }
                }
              }}
              aria-label="Filter web resources"
            />
          </div>
          <button className="btn btn-ghost btn-icon" onClick={refresh} disabled={list.loading} title="Read the web resources again" aria-label="Refresh">
            <Refresh size={14} className={list.loading ? "animate-spin" : ""} />
          </button>
          <button className="btn btn-secondary btn-icon" onClick={() => setCreating(true)} disabled={!data} title="New web resource" aria-label="New web resource">
            <Plus size={14} />
          </button>
        </div>
        {(unsaved.length > 0 || pending.length > 0) && (
          <div className="mx-3 mt-2.5 flex items-center gap-2 rounded-lg border border-line bg-s2 px-2.5 py-1.5 text-[12px]">
            <span className="min-w-0 flex-1 truncate text-muted">
              {unsaved.length > 0 && (
                <span className="text-brand" title={unsaved.map(nameOf).join("\n")}>
                  {unsaved.length} unsaved
                </span>
              )}
              {unsaved.length > 0 && pending.length > 0 && " · "}
              {pending.length > 0 && <span title={pending.map(nameOf).join("\n")}>{pending.length} saved, not published</span>}
            </span>
            {pending.length > 0 && (
              <button className="btn btn-secondary btn-sm shrink-0" onClick={() => setPublishingAll(true)} title="Publish everything you saved here">
                Publish all
              </button>
            )}
          </div>
        )}

        <div className="seg mx-3 mt-2.5 !flex" role="group" aria-label="Type">
          {GROUPS.map((g) => (
            <button key={g.id} className="flex-1 !px-1.5" aria-pressed={filters.group === g.id} onClick={() => patch({ group: g.id })}>
              {g.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 px-3 pt-2.5 text-[12px] text-muted">
          <select
            className="input !h-7 min-w-0 flex-1 !py-0 !text-[12px]"
            value={filters.solution}
            onChange={(e) => patch({ solution: e.target.value })}
            disabled={!data || !!data.solutionsError}
            aria-label="Solution"
            title={data?.solutionsError ?? "Only web resources in this solution"}
          >
            <SelectFace />
            <option value="">{data?.solutionsError ? "Solutions unavailable" : "Any solution"}</option>
            {data?.solutions
              .filter((s) => !filters.hideMicrosoft || !s.microsoft)
              .map((s) => (
                <option key={s.id} value={s.friendlyName}>
                  {s.friendlyName}
                  {s.managed ? " (managed)" : ""}
                </option>
              ))}
          </select>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5" title="Web resources shipped by Microsoft (Dynamics 365 apps, the platform)">
            <input type="checkbox" checked={filters.hideMicrosoft} onChange={(e) => patch({ hideMicrosoft: e.target.checked })} />
            Hide Microsoft
          </label>
        </div>

        <div className="flex items-center gap-2 px-4 pb-1 pt-2 text-[11.5px] text-subtle">
          <span className="min-w-0 flex-1 truncate">
            {data ? (
              <>
                {shown.length.toLocaleString()} of {data.items.length.toLocaleString()} web resource{data.items.length === 1 ? "" : "s"}
                {hiddenMs > 0 && <span title="Shipped by Microsoft"> · {hiddenMs.toLocaleString()} Microsoft hidden</span>}
              </>
            ) : (
              " "
            )}
          </span>
          {!searching && data && (
            <button className="btn btn-ghost btn-sm shrink-0" onClick={() => setOpen(anyFolderOpen ? new Set() : new Set(allFolders(tree)))} disabled={!tree.folders.length}>
              {anyFolderOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 outline-none"
          role="tree"
          aria-label="Web resources"
          tabIndex={0}
          onKeyDown={onKey}
        >
          {list.error ? (
            <div className="px-3 py-8 text-center text-xs text-subtle">
              <div className="text-warning">Couldn't read the web resources.</div>
              <div className="mt-1 break-words">{list.error}</div>
              <button className="btn btn-secondary btn-sm mt-3" onClick={list.reload}>
                <Refresh size={12} /> Retry
              </button>
            </div>
          ) : !data ? (
            Array.from({ length: 12 }, (_, i) => <div key={i} className="skeleton mx-2 my-2.5 h-3" style={{ width: `${40 + ((i * 29) % 45)}%` }} />)
          ) : rows.length === 0 ? (
            <div className="fade-in px-3 py-10 text-center">
              <div className="empty-icon">
                <Globe size={18} />
              </div>
              <div className="mt-3 text-sm font-medium">{data.items.length ? "No web resource matches" : "No web resources"}</div>
              <div className="mt-1 text-xs text-subtle">
                {data.items.length
                  ? filters.hideMicrosoft && hiddenMs
                    ? "Clear the filters, or untick “Hide Microsoft”."
                    : "Clear the filters to see them all."
                  : "This environment has no visible web resources."}
              </div>
            </div>
          ) : (
            <>
              {rows.map((r) =>
                r.type === "folder" ? (
                  <div
                    key={r.key}
                    role="treeitem"
                    aria-expanded={r.open}
                    aria-level={r.depth + 1}
                    data-focused={focus === r.key || undefined}
                    className={`outline-row flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 ${focus === r.key ? "bg-s3" : ""}`}
                    style={{ paddingLeft: 6 + r.depth * 16 }}
                    onClick={() => {
                      focusKey.current = r.key;
                      setFocus(r.key);
                      toggle(r.key);
                    }}
                    title={r.folder.path}
                  >
                    <ChevronDown size={12} className={`shrink-0 text-subtle transition-transform ${r.open ? "" : "-rotate-90"}`} />
                    <Folder size={13} className="shrink-0 text-brand" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{r.folder.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-subtle">{r.folder.count}</span>
                  </div>
                ) : (
                  <FileRow
                    key={r.key}
                    item={r.item}
                    dirty={!!drafts[draftKey(activeId, r.item.id)]}
                    depth={r.depth}
                    flat={searching}
                    selected={r.item.id === selected?.toLowerCase()}
                    onSelect={() => {
                      focusKey.current = r.key;
                      setFocus(null);
                      select(r.item.id);
                    }}
                  />
                )
              )}
              {searching && shown.length > MAX_FLAT && (
                <div className="px-3 py-2 text-[11.5px] text-subtle">
                  {(shown.length - MAX_FLAT).toLocaleString()} more — type more to narrow it down.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {creating && data && (
        <NewWebResourceDialog
          connId={activeId}
          list={data}
          folder={startFolder}
          onClose={() => setCreating(false)}
          onCreated={(id, published) => {
            if (!published) markPending(activeId, [id], true);
            pushToast({ tone: "success", title: published ? "Created and published" : "Created", body: published ? undefined : "Not live yet — publish to make it live." });
            patch({ q: "" });
            void listCache.load(activeId, "", true).then(() => select(id)).catch(() => select(id));
          }}
        />
      )}
      {publishingAll && (
        <ConfirmWrite
          connId={activeId}
          title="Publish web resources"
          message={`Publish the ${pending.length} web resource${pending.length === 1 ? "" : "s"} you saved? They go live right away.`}
          names={pending.map(nameOf)}
          confirmLabel="Publish"
          onConfirm={publishAll}
          onClose={() => setPublishingAll(false)}
        />
      )}

      <div className="min-h-0">
        {selected ? (
          <Detail
            key={selected}
            connId={activeId}
            id={selected}
            row={row}
            maxUpload={data?.maxUploadSize ?? null}
            onSelect={select}
            onDeleted={() => {
              clearSelection();
              list.reload();
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="empty-icon">
              <Globe size={20} />
            </div>
            <div>
              <div className="text-sm font-medium">Nothing selected</div>
              <div className="mt-0.5 max-w-sm text-xs text-subtle">
                Pick a web resource on the left to see its content — scripts, pages and styles in the editor, images as a preview.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({
  item,
  dirty,
  depth,
  flat,
  selected,
  onSelect,
}: {
  item: WebResource;
  dirty: boolean;
  depth: number;
  flat: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const k = kindOf(item.kind);
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-level={depth + 1}
      className="outline-row flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2"
      style={{ paddingLeft: flat ? 8 : 22 + depth * 16 }}
      onClick={onSelect}
      title={`${item.name}${item.displayName && item.displayName !== item.name ? `\n${item.displayName}` : ""}`}
    >
      <span className={`w-[26px] shrink-0 font-mono text-[11px] ${TAG_COLOR[k.group]}`}>{k.tag}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {flat ? item.name : baseName(item.name)}
        {flat && item.displayName && item.displayName !== item.name && <span className="ml-2 text-[11.5px] text-subtle">{item.displayName}</span>}
      </span>
      {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" title="Unsaved changes" />}
      {item.managed && <span className="shrink-0 text-[11px] text-subtle" title="Managed">M</span>}
    </div>
  );
}

const TAG_COLOR: Record<string, string> = {
  script: "text-warning",
  page: "text-brand",
  style: "text-info",
  image: "text-success",
  data: "text-muted",
  other: "text-subtle",
};

/* ---------- detail ---------- */

type Tab = "content" | "details" | "usage";
type Version = "published" | "unpublished";

const EDITOR_OPTIONS = {
  fontSize: 13,
  fontFamily: EDITOR_FONT,
  fontLigatures: false,
  lineHeight: 20,
  lineNumbersMinChars: 4,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 12 },
  automaticLayout: true,
  wordWrap: "off" as const,
  bracketPairColorization: { enabled: false },
};

/** A save or publish waiting in the review dialog. */
interface Review {
  mode: "save" | "publish";
  /** Save mode: Save & publish was asked for. */
  publish: boolean;
  /** Skip the "someone saved meanwhile" check (Overwrite theirs). */
  force: boolean;
}

function Detail({
  connId,
  id,
  row,
  maxUpload,
  onSelect,
  onDeleted,
}: {
  connId: string;
  id: string;
  row: WebResource | null;
  maxUpload: number | null;
  onSelect: (id: string) => void;
  onDeleted: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const key = id.toLowerCase();
  const entry = detailCache.useEntry(connId, key);
  const d = entry.data;
  const draft = useWrEdits((s) => s.drafts[draftKey(connId, key)]);
  const { danger } = useTarget(connId);
  const [tab, setTab] = useState<Tab>("content");
  const [version, setVersion] = useState<Version | null>(null);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [conflict, setConflict] = useState<{ publish: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  // Viewing by default; Edit turns the editor on. Unsaved changes keep it on.
  const [editing, setEditing] = useState(false);

  const k = kindOf((d ?? row)?.kind ?? 0);
  const editable = !!d && d.customizable && d.kind !== 8;
  /** Why this web resource can't be changed here, if it can't. */
  const lockReason = !d
    ? null
    : !d.customizable
    ? "It's marked not customizable in this environment (the solution that installed it locked it). You can still view, compare and download it."
    : d.kind === 8
    ? "Silverlight (XAP) web resources can't be edited — Silverlight is no longer supported."
    : null;
  const latestVersion: Version = d?.unpublished ? "unpublished" : "published";
  // Unpublished changes are what the next Publish makes live — show them first.
  const shownVersion: Version = version ?? latestVersion;
  const onLatest = shownVersion === latestVersion;
  const serverContent = d ? (shownVersion === "unpublished" && d.unpublished !== null ? d.unpublished : d.content) : null;
  const latestServer = d ? d.unpublished ?? d.content : null;

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));

  const reload = () => detailCache.load(connId, key, true).catch(() => {});

  // A second Ctrl+S before the first save returns must not send it twice.
  const writing = useRef(false);
  const doSave = async (publish: boolean, force: boolean) => {
    if (!draft || !d || writing.current) return;
    writing.current = true;
    setBusy(publish ? "Saving and publishing…" : "Saving…");
    try {
      await api.saveWebResource(connId, key, draftContent(draft), force ? null : draft.baseHash);
      setDraft(connId, key, null);
      setCompare(false);
      setEditing(false);
      if (publish) {
        await api.publishWebResources(connId, [key]);
        markPending(connId, [key], false);
      } else markPending(connId, [key], true);
      pushToast({
        tone: "success",
        title: publish ? `Saved and published ${baseName(d.name)}` : `Saved ${baseName(d.name)}`,
        body: publish ? "It's live." : "Not live yet — publish to make it live.",
      });
      await reload();
    } catch (e) {
      if (isConflict(e)) setConflict({ publish });
      throw e;
    } finally {
      writing.current = false;
      setBusy(null);
    }
  };

  const save = (publish: boolean, force = false) => {
    if (!draft || !d || busy) return;
    if (maxUpload && draftSize(draft) > maxUpload) {
      pushToast({ tone: "error", title: "Too large", body: `This environment takes files up to ${formatBytes(maxUpload)}.` });
      return;
    }
    // Nothing is written until the diff has been looked at and confirmed.
    setReview({ mode: "save", publish, force });
  };

  const publish = () => {
    if (!d || busy) return;
    setReview({ mode: "publish", publish: true, force: false });
  };

  const doPublish = async () => {
    if (!d) return;
    setBusy("Publishing…");
    try {
      await api.publishWebResources(connId, [key]);
      markPending(connId, [key], false);
      pushToast({ tone: "success", title: `Published ${baseName(d.name)}` });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  // Ctrl+S / Ctrl+Shift+S (App turns them into this event on this tool).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onSave = (e: Event) => saveRef.current(!!(e as CustomEvent<{ publish: boolean }>).detail?.publish);
    window.addEventListener(WR_SAVE_EVENT, onSave);
    return () => window.removeEventListener(WR_SAVE_EVENT, onSave);
  }, []);

  const replaceFromFile = async () => {
    if (!d) return;
    try {
      const f = await api.openWebResourceFile();
      if (!f) return;
      if (maxUpload && f.size > maxUpload) {
        pushToast({ tone: "error", title: "Too large", body: `${f.name} is ${formatBytes(f.size)}; this environment takes up to ${formatBytes(maxUpload)}.` });
        return;
      }
      const fileKind = kindFromName(f.name);
      const baseHash = draft?.baseHash ?? d.latestHash;
      if (k.language && !k.image) {
        const t = decodeText(f.content);
        setDraft(connId, key, { text: t.text, bom: t.bom, baseHash, fileName: f.name });
      } else {
        setDraft(connId, key, { b64: f.content, bom: false, baseHash, fileName: f.name });
      }
      setVersion(null);
      setTab("content");
      setEditing(true);
      pushToast({
        tone: fileKind && fileKind !== d.kind ? "warning" : "info",
        title: `Replaced with ${f.name}`,
        body: fileKind && fileKind !== d.kind ? `That looks like ${kindOf(fileKind).label}, not ${k.label}. Save only if that's right.` : "Save to upload it.",
      });
    } catch (e) {
      pushToast({ tone: "error", title: "Couldn't read the file", body: friendlyError(String(e)) });
    }
  };

  const download = () => {
    if (!d) return;
    const content = onLatest && draft ? draftContent(draft) : serverContent;
    if (!content) return;
    api
      .saveWebResourceFile(content, fileNameFor(d))
      .then((f) => f && pushToast({ tone: "success", title: `Saved ${f.name}`, body: f.path }))
      .catch((e) => pushToast({ tone: "error", title: "Couldn't save the file", body: friendlyError(String(e)) }));
  };

  const head = d ?? row;
  if (!head) {
    return entry.error ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
        <AlertTriangle size={18} className="text-warning" />
        <div className="font-medium">Couldn't read this web resource</div>
        <div className="max-w-xl break-words text-xs text-subtle">{entry.error}</div>
        <button className="btn btn-secondary btn-sm mt-2" onClick={entry.reload}>
          <Refresh size={12} /> Retry
        </button>
      </div>
    ) : (
      <div className="space-y-3 p-8">
        <div className="skeleton h-5 w-1/3" />
        <div className="skeleton h-3 w-1/2" />
        <div className="skeleton mt-6 h-16" />
      </div>
    );
  }

  const dirty = !!draft;
  const isEditing = editable && (editing || dirty);
  const startEditing = () => {
    if (!editable) return;
    setVersion(null);
    setTab("content");
    setCompare(false);
    if (k.image && d?.kind !== 11) void replaceFromFile();
    else setEditing(true);
  };
  const stopEditing = () => {
    if (dirty) setAskDiscard(true);
    else setEditing(false);
  };
  const size = d ? (onLatest && draft ? draftSize(draft) : shownVersion === "unpublished" && d.unpublishedSize !== null ? d.unpublishedSize : d.size) : null;
  const canCompare = !!d && (dirty || !!d.unpublished) && !!k.language;
  const openInBrowser = () =>
    api.openWebResource(connId, head.name).catch((e) => pushToast({ tone: "error", title: "Couldn't open the browser", body: friendlyError(String(e)) }));

  return (
    <div className="fade-in flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pb-4 pt-6 xl:px-8 short:pb-3 short:pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={head.displayName || head.name}>
                {head.displayName || baseName(head.name)}
              </h2>
              <span className="badge badge-neutral">{k.label}</span>
              <span className="badge badge-neutral">{head.managed ? "managed" : "unmanaged"}</span>
              {dirty && <span className="badge badge-brand">Unsaved changes</span>}
              {d?.unpublished && (
                <span className="badge badge-warning" title="Saved but not published: the environment still serves the published version">
                  Unpublished changes
                </span>
              )}
              {row?.microsoft && <span className="badge badge-neutral">Microsoft</span>}
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-subtle" title={head.name}>
              {head.name}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {busy ? (
              <span className="flex h-8 items-center gap-2 px-2 text-xs text-muted">
                <Loader size={13} className="text-brand" /> {busy}
              </span>
            ) : askDiscard ? (
              <>
                <span className="text-xs text-muted">Throw away your changes?</span>
                <button className="btn btn-ghost" onClick={() => setAskDiscard(false)} autoFocus>
                  Keep editing
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setDraft(connId, key, null);
                    setAskDiscard(false);
                    setCompare(false);
                    setEditing(false);
                  }}
                >
                  Discard
                </button>
              </>
            ) : isEditing ? (
              <>
                <button className="btn btn-ghost" onClick={stopEditing} title={dirty ? "Throw away your changes and stop editing" : "Stop editing"}>
                  {dirty ? "Discard" : "Done"}
                </button>
                <button className="btn btn-secondary" onClick={() => save(false)} disabled={!dirty} title={dirty ? "Review, then save — not live yet (Ctrl+S)" : "No changes yet"}>
                  <Save size={14} /> Save
                </button>
                <button
                  className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
                  onClick={() => save(true)}
                  disabled={!dirty}
                  title={dirty ? "Review, then save and make it live (Ctrl+Shift+S)" : "No changes yet"}
                >
                  Save &amp; publish
                </button>
              </>
            ) : (
              <>
                {d?.unpublished && editable && (
                  <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={publish} title="Review, then make the saved version live">
                    Publish
                  </button>
                )}
                <button
                  className={`btn ${!editable || d?.unpublished ? "btn-secondary" : "btn-primary"}`}
                  onClick={startEditing}
                  disabled={!editable}
                  title={lockReason ?? (k.image && d?.kind !== 11 ? "Replace the image with a file" : "Edit this file")}
                >
                  {k.image && d?.kind !== 11 ? (
                    <>
                      <Upload size={14} /> Replace file…
                    </>
                  ) : (
                    <>
                      <Pencil size={14} /> Edit
                    </>
                  )}
                </button>
                <button className="btn btn-ghost" onClick={openInBrowser} title="Open the published version in the browser (/WebResources/…)">
                  <ArrowUpRight size={14} /> Open in browser
                </button>
              </>
            )}
            <Menu
              label="More actions"
              icon={<More size={16} />}
              items={[
                { label: "Replace from file…", run: () => void replaceFromFile(), disabled: !editable || !!busy },
                { label: "Download", run: download, disabled: !d },
                ...(isEditing ? [{ label: "Open in browser", run: openInBrowser }] : []),
                null,
                { label: "Copy name", run: () => copy(head.name, "name") },
                { label: "Copy id", run: () => copy(head.id, "id") },
                null,
                { label: "Delete…", run: () => setDeleting(true), danger: true, disabled: !d || !!busy },
              ]}
            />
          </div>
        </div>

        {lockReason && (
          <div role="note" className="mt-3 flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs">
            <AlertTriangle size={14} className="mt-px shrink-0 text-warning" />
            <span>
              <span className="font-semibold text-warning">Can't be edited.</span> <span className="text-fg">{lockReason}</span>
            </span>
          </div>
        )}
        {!lockReason && d?.managed && (
          <div role="note" className="mt-3 flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs">
            <AlertTriangle size={14} className="mt-px shrink-0 text-warning" />
            <span>
              <span className="font-semibold text-warning">{row?.microsoft ? "Microsoft's web resource." : "Managed web resource."}</span>{" "}
              <span className="text-fg">
                Editing adds an unmanaged layer on top of the solution's version: later updates of the solution won't show until that layer is removed (Solution
                layers → Remove active customizations).{row?.microsoft ? " Changing it can break Dynamics 365 features." : ""}
              </span>
            </span>
          </div>
        )}

        <div className="card mt-4 grid grid-cols-4 divide-x divide-line">
          <Stat label="Type">{k.label}</Stat>
          <Stat label="Size">
            <span className="tabular-nums">{size === null ? "…" : formatBytes(size)}</span>
            {maxUpload && size !== null && size > maxUpload && <span className="ml-1.5 text-xs text-danger">over {formatBytes(maxUpload)}</span>}
          </Stat>
          <Stat label="Modified">
            <span className="shrink-0 tabular-nums" title={head.modifiedOn}>
              {time(head.modifiedOn)}
            </span>
            {head.modifiedBy && <span className="ml-1.5 truncate text-xs text-subtle">{head.modifiedBy}</span>}
          </Stat>
          <Stat label="Solutions">
            <span className="truncate" title={row?.solutions.join("\n")}>
              {row ? (row.solutions.length ? row.solutions.join(", ") : "—") : "…"}
            </span>
          </Stat>
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-end gap-1 border-b border-t border-line bg-s1 px-4" role="tablist" aria-label="Web resource">
        {(
          [
            ["content", dirty ? "Content •" : "Content"],
            ["details", "Details"],
            ["usage", "Where used"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className="tab h-9" onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
        {tab === "content" && d && (
          <div className="mb-1 ml-auto flex items-center gap-2">
            {canCompare && (
              <button
                className={`btn btn-sm ${compare ? "btn-secondary" : "btn-ghost"}`}
                aria-pressed={compare}
                onClick={() => {
                  setCompare((c) => !c);
                  setVersion(null);
                }}
                title={dirty ? "Your changes next to the latest saved version" : "Unpublished next to published"}
              >
                Compare
              </button>
            )}
            {d.unpublished && !compare && !isEditing && (
              <div className="seg" role="group" aria-label="Version">
                <button aria-pressed={shownVersion === "unpublished"} onClick={() => setVersion("unpublished")} title="Saved, not live yet">
                  Unpublished
                </button>
                <button aria-pressed={shownVersion === "published"} onClick={() => setVersion("published")} title="What the environment serves now">
                  Published
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {tab === "content" && isEditing && (
        <div className="flex shrink-0 items-center gap-2 border-b border-brand/30 bg-brand/10 px-4 py-1.5 text-xs">
          <Pencil size={12} className="shrink-0 text-brand" />
          <span className="font-medium">Editing</span>
          <span className="min-w-0 truncate text-muted">
            — nothing is written to Dataverse until you Save (<kbd className="kbd">Ctrl</kbd> <kbd className="kbd">S</kbd>); you'll review the changes first.
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1" style={tab === "content" ? { background: "var(--editor-bg)" } : undefined}>
        {tab === "content" ? (
          !d || serverContent === null || latestServer === null ? (
            entry.error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
                <div className="text-warning">Couldn't read the content.</div>
                <div className="max-w-xl break-words text-xs text-subtle">{entry.error}</div>
                <button className="btn btn-secondary btn-sm mt-1" onClick={entry.reload}>
                  <Refresh size={12} /> Retry
                </button>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-subtle">
                <Loader size={12} className="text-brand" /> Reading the content…
              </div>
            )
          ) : compare && canCompare ? (
            <Compare
              d={d}
              original={dirty ? latestServer : d.content}
              modifiedText={dirty ? draft?.text ?? null : null}
              modifiedB64={dirty ? null : d.unpublished}
              labels={dirty ? ["Latest saved", "Your changes"] : ["Published", "Unpublished"]}
              editable={isEditing && dirty && !busy}
              onEdit={(text) => editDraftText(connId, key, text, "\u0000", { bom: false, baseHash: d.latestHash })}
            />
          ) : (
            <Content
              d={d}
              content={onLatest && draft?.b64 !== undefined ? draft.b64 : serverContent}
              draftText={onLatest ? draft?.text : undefined}
              version={shownVersion}
              editable={isEditing && onLatest && !busy}
              readOnlyHint={!onLatest ? "Published version · read only" : null}
              readOnlyMessage={
                lockReason
                  ? "This web resource can't be edited here."
                  : !onLatest
                  ? "This is the published version. Switch to **Unpublished** to edit."
                  : "Click **Edit** (top right) to change this file."
              }
              onEdit={(text, original) => editDraftText(connId, key, text, original.text, { bom: original.bom, baseHash: d.latestHash })}
              onCopy={copy}
              onReplace={isEditing ? () => void replaceFromFile() : undefined}
            />
          )
        ) : tab === "details" ? (
          <DetailsTab head={head} d={d} row={row} onCopy={copy} />
        ) : (
          <UsageTab connId={connId} id={key} onSelect={onSelect} />
        )}
      </div>

      {review && d && (review.mode === "publish" ? d.unpublished !== null : !!draft) && (
        <ReviewChanges
          connId={connId}
          name={d.name}
          kind={d.kind}
          mode={review.mode}
          requested={review.publish}
          managed={d.managed}
          before={review.mode === "publish" ? d.content : d.unpublished ?? d.content}
          after={
            review.mode === "publish"
              ? { b64: d.unpublished ?? "" }
              : draft!.text !== undefined
              ? { text: draft!.text }
              : { b64: draft!.b64 ?? "" }
          }
          labels={
            review.mode === "publish"
              ? ["Live now (published)", "After publishing (saved version)"]
              : [review.force ? "Their version, on Dataverse now" : `On Dataverse now (${d.unpublished ? "saved, unpublished" : "published"})`, "Your changes"]
          }
          onClose={() => setReview(null)}
          onConfirm={async (publish) => {
            if (review.mode === "publish") return doPublish();
            try {
              await doSave(publish, review.force);
            } catch (e) {
              // The conflict dialog takes over.
              if (isConflict(e)) setReview(null);
              else throw e;
            }
          }}
        />
      )}
      {conflict && d && (
        <ConflictDialog
          name={d.name}
          onClose={() => setConflict(null)}
          onOverwrite={async () => {
            const publish = conflict.publish;
            setConflict(null);
            // Review against their version: that's what gets replaced.
            await detailCache.load(connId, key, true).catch(() => null);
            save(publish, true);
          }}
          onCompare={async () => {
            setConflict(null);
            // Their version becomes the base: the next Save replaces it knowingly.
            const fresh = await detailCache.load(connId, key, true).catch(() => null);
            if (fresh && draft) setDraft(connId, key, { ...draft, baseHash: fresh.latestHash });
            setVersion(null);
            setCompare(true);
            pushToast({ tone: "info", title: "Their version is on the left", body: "Save again to replace it with yours." });
          }}
        />
      )}
      {deleting && d && (
        <DeleteDialog
          connId={connId}
          d={d}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDraft(connId, key, null);
            markPending(connId, [key], false);
            detailCache.forget(connId);
            pushToast({ tone: "success", title: `Deleted ${baseName(d.name)}` });
            onDeleted();
          }}
        />
      )}
    </div>
  );
}

function Content({
  d,
  content,
  draftText,
  version,
  editable,
  readOnlyHint,
  readOnlyMessage,
  onEdit,
  onCopy,
  onReplace,
}: {
  d: WebResourceDetail;
  /** Base64 shown when there's no text draft. */
  content: string;
  draftText: string | undefined;
  version: Version;
  editable: boolean;
  readOnlyHint: string | null;
  /** Shown (Markdown) when someone types while it's read only. */
  readOnlyMessage: string;
  onEdit: (text: string, original: DecodedText) => void;
  onCopy: (text: string, what: string) => void;
  onReplace?: () => void;
}) {
  const theme = useStore((s) => s.theme);
  const k = kindOf(d.kind);
  const [svgCode, setSvgCode] = useState(false);
  const editorRef = useRef<{ focus(): void } | null>(null);
  // Edit puts the cursor in the editor.
  useEffect(() => {
    if (editable) editorRef.current?.focus();
  }, [editable]);
  const original = useMemo<DecodedText | null>(() => {
    if (!k.language) return null;
    try {
      return decodeText(content);
    } catch {
      return null;
    }
  }, [content, k.language]);

  // SVG is text: editing it shows the code.
  if (k.image && !(d.kind === 11 && (svgCode || editable))) {
    return content ? (
      <ImagePreview content={content} mime={k.mime} svg={d.kind === 11} onCode={() => setSvgCode(true)} onReplace={onReplace} />
    ) : (
      <Empty version={version} onReplace={onReplace} />
    );
  }
  if (!original) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-sm text-subtle">
        <div>{d.kind === 8 ? "Silverlight (XAP) packages can't be shown." : "This content can't be shown as text."}</div>
        <div className="text-xs">Download it to open it elsewhere.</div>
      </div>
    );
  }
  const text = draftText ?? original.text;
  if (!text && !editable) return <Empty version={version} onReplace={onReplace} />;
  return (
    <div className="relative h-full">
      <div className="absolute right-5 top-2 z-10 flex items-center gap-1.5">
        {readOnlyHint && <span className="rounded-md bg-s2 px-2 py-1 text-[11.5px] text-subtle">{readOnlyHint}</span>}
        {d.kind === 11 && (
          <button className="btn btn-secondary btn-sm" onClick={() => setSvgCode(false)}>
            Preview
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => onCopy(text, "content")}>
          <Copy size={12} /> Copy
        </button>
      </div>
      <Editor
        height="100%"
        language={k.language ?? "plaintext"}
        path={`webresource/${d.id}/${version}.${k.ext || "txt"}`}
        value={text}
        theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
        beforeMount={(monaco) => {
          if (k.language === "javascript") ensureXrmTypes(monaco);
        }}
        onChange={(v) => editable && onEdit(v ?? "", original)}
        onMount={(editor) => {
          editorRef.current = editor;
          if (editable) editor.focus();
        }}
        options={{
          ...EDITOR_OPTIONS,
          readOnly: !editable,
          readOnlyMessage: { value: readOnlyMessage },
          renderLineHighlight: editable ? "line" : "none",
        }}
      />
    </div>
  );
}

function Empty({ version, onReplace }: { version: Version; onReplace?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-subtle">
      <div>This web resource has no {version} content.</div>
      {onReplace && (
        <button className="btn btn-secondary btn-sm" onClick={onReplace}>
          <Upload size={12} /> Replace from file…
        </button>
      )}
    </div>
  );
}

/** Side by side: the saved version (left, read only) and the changes (right). */
function Compare({
  d,
  original,
  modifiedText,
  modifiedB64,
  labels,
  editable,
  onEdit,
}: {
  d: WebResourceDetail;
  original: string;
  modifiedText: string | null;
  modifiedB64: string | null;
  labels: [string, string];
  editable: boolean;
  onEdit: (text: string) => void;
}) {
  const theme = useStore((s) => s.theme);
  const k = kindOf(d.kind);
  const left = useMemo(() => decodeText(original).text, [original]);
  const right = useMemo(() => modifiedText ?? (modifiedB64 ? decodeText(modifiedB64).text : ""), [modifiedText, modifiedB64]);
  const editRef = useRef(onEdit);
  editRef.current = onEdit;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  return (
    <div className="flex h-full flex-col">
      <div className="grid shrink-0 grid-cols-2 border-b border-line text-[11.5px] text-subtle">
        <span className="px-5 py-1.5">{labels[0]}</span>
        <span className="px-5 py-1.5">{labels[1]}</span>
      </div>
      <div className="min-h-0 flex-1">
        <DiffEditor
          height="100%"
          language={k.language ?? "plaintext"}
          original={left}
          modified={right}
          originalModelPath={`webresource/${d.id}/compare-left.${k.ext || "txt"}`}
          modifiedModelPath={`webresource/${d.id}/compare-right.${k.ext || "txt"}`}
          // Disposing the models on unmount races the widget ("TextModel got disposed
          // before DiffEditorWidget model got reset"); they're reused by path instead.
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
          beforeMount={(monaco) => {
            if (k.language === "javascript") ensureXrmTypes(monaco);
          }}
          options={{ ...EDITOR_OPTIONS, readOnly: !editable, originalEditable: false, renderSideBySide: true }}
          onMount={(editor) => {
            syncDiffModels(editor, left, right);
            const modified = editor.getModifiedEditor();
            modified.onDidChangeModelContent(() => editableRef.current && editRef.current(modified.getValue()));
          }}
        />
      </div>
    </div>
  );
}

function ImagePreview({ content, mime, svg, onCode, onReplace }: { content: string; mime: string; svg: boolean; onCode: () => void; onReplace?: () => void }) {
  const [dims, setDims] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // A blob URL instead of a data URL: no size limit, no re-parsing on every render.
  // Made in the effect so the cleanup that revokes it always pairs with it.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    try {
      u = URL.createObjectURL(new Blob([base64ToBytes(content)], { type: mime }));
    } catch {
      setFailed(true);
    }
    setUrl(u);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [content, mime]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 px-5 py-2 text-xs text-subtle">
        <span>{failed ? "The image couldn't be decoded." : dims ?? " "}</span>
        <span className="ml-auto flex gap-1.5">
          {onReplace && (
            <button className="btn btn-secondary btn-sm" onClick={onReplace}>
              <Upload size={12} /> Replace…
            </button>
          )}
          {svg && (
            <button className="btn btn-secondary btn-sm" onClick={onCode}>
              View code
            </button>
          )}
        </span>
      </div>
      <div
        className="m-5 mt-0 flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-line p-6"
        style={{
          backgroundColor: "var(--s1)",
          backgroundImage: "linear-gradient(45deg, var(--s3) 25%, transparent 25%, transparent 75%, var(--s3) 75%), linear-gradient(45deg, var(--s3) 25%, transparent 25%, transparent 75%, var(--s3) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 8px 8px",
        }}
      >
        {url && !failed && (
          <img
            src={url}
            alt=""
            className="max-h-full max-w-full object-contain"
            style={{ imageRendering: "auto" }}
            onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight} px`)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

function DetailsTab({ head, d, row, onCopy }: { head: WebResource | WebResourceDetail; d: WebResourceDetail | undefined; row: WebResource | null; onCopy: (text: string, what: string) => void }) {
  const when = (iso: string | undefined, by: string | null | undefined) =>
    iso ? (
      <>
        {new Date(iso).toLocaleString()} <span className="text-subtle">· {relativeTime(Date.parse(iso))}</span>
        {by && <span className="text-subtle"> · {by}</span>}
      </>
    ) : (
      "—"
    );
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] space-y-2.5 px-6 py-6 xl:px-8">
        <Field label="Name">
          <span className="font-mono text-[12.5px]">{head.name}</span>
        </Field>
        <Field label="Display name">{head.displayName || "—"}</Field>
        <Field label="Description">{head.description ?? <span className="text-subtle">—</span>}</Field>
        <Field label="Type">{kindOf(head.kind).label}</Field>
        <Field label="Solutions">{row ? (row.solutions.length ? row.solutions.join(", ") : <span className="text-subtle">None besides the default solution</span>) : "—"}</Field>
        <Field label="Managed">{head.managed ? "Yes" : "No"}</Field>
        {d && (
          <>
            <Field label="Customizable">{d.customizable ? "Yes" : <span className="text-warning">No — can't be changed in this environment</span>}</Field>
            <Field label="Can be deleted">{d.canBeDeleted ? "Yes" : "No"}</Field>
            <Field label="Language">{d.language ?? "—"}</Field>
            <Field label="Introduced in">{d.introducedVersion ?? "—"}</Field>
            <Field label="Created">{when(d.createdOn, d.createdBy)}</Field>
          </>
        )}
        <Field label="Modified">{when(head.modifiedOn, head.modifiedBy)}</Field>
        {d?.unpublishedError && (
          <Field label="Unpublished">
            <span className="text-warning">Couldn't read the unpublished version: {d.unpublishedError}</span>
          </Field>
        )}
        <Field label="Id">
          <button className="font-mono text-[12.5px] text-muted hover:text-fg hover:underline" onClick={() => onCopy(head.id, "id")} title="Copy">
            {head.id}
          </button>
        </Field>
      </div>
    </div>
  );
}

function UsageTab({ connId, id, onSelect }: { connId: string; id: string; onSelect: (id: string) => void }) {
  const navigate = useNavigate();
  const entry = dependentsCache.useEntry(connId, id);
  const groups = useMemo(() => {
    const map = new Map<string, DependencyItem[]>();
    for (const i of entry.data ?? []) (map.get(i.kindLabel) ?? map.set(i.kindLabel, []).get(i.kindLabel)!).push(i);
    return [...map.entries()];
  }, [entry.data]);

  if (entry.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
        <div className="text-warning">Couldn't read what uses it.</div>
        <div className="max-w-xl break-words text-xs text-subtle">{entry.error}</div>
        <button className="btn btn-secondary btn-sm mt-1" onClick={entry.reload}>
          <Refresh size={12} /> Retry
        </button>
      </div>
    );
  }
  if (!entry.data) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-subtle">
        <Loader size={12} className="text-brand" /> Reading dependencies…
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] space-y-4 px-6 py-6 xl:px-8">
        <p className="text-xs text-subtle">
          What Dataverse tracks as using this web resource: forms (libraries and event handlers), ribbons, site maps, other web resources… Script that loads it by
          name at run time isn't tracked.
        </p>
        {groups.length === 0 ? (
          <div className="rounded-lg border border-line px-4 py-3 text-sm">Nothing in Dataverse depends on this web resource.</div>
        ) : (
          groups.map(([label, items]) => (
            <section key={label} className="card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <h3 className="text-[13.5px] font-semibold">{label}</h3>
                <span className="text-xs tabular-nums text-subtle">{items.length}</span>
              </div>
              <ul className="divide-y divide-line">
                {items.map((i) => {
                  const open =
                    i.kind === 61
                      ? () => onSelect(i.id)
                      : i.kind === 29 && /flow/i.test(i.detail ?? "")
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
          ))
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 text-[13px]">
      <span className="eyebrow w-36 shrink-0 leading-5">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

