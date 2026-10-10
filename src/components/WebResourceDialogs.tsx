// Dialogs of the Web resources tool's writes: review (a diff before every
// save / publish), confirm, conflict, new web resource, delete. Every write names the environment it goes to.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../api";
import { tagStyle } from "../lib/tags";
import { friendlyError } from "../lib/errors";
import { DiffEditor } from "@monaco-editor/react";
import { KINDS, base64ToBytes, decodeText, formatBytes, kindFromName, kindOf, nameProblem } from "../lib/webresources";
import { EDITOR_FONT, EDITOR_THEME } from "../lib/monacoTheme";
import { Modal } from "./Modals";
import { TagBadge } from "./TagBadge";
import { AlertTriangle, Globe, Loader, Plus, Trash, Upload } from "./Icon";
import type { Connection, DependencyItem, PickedFile, WebResourceDetail, WebResourceList } from "../types";
import { SelectFace } from "./FormParts";

/** The environment a write goes to, and whether it's production (red tag). */
export function useTarget(connId: string): { conn: Connection | null; danger: boolean } {
  const conn = useStore((s) => s.connections.find((c) => c.id === connId) ?? null);
  return { conn, danger: !!conn?.tag && tagStyle(conn.color).danger };
}

export function EnvBox({ conn }: { conn: Connection | null }) {
  if (!conn) return null;
  const style = conn.tag ? tagStyle(conn.color) : null;
  return (
    <div className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${style ? `${style.ring} ${style.tint}` : "border-line bg-s2"}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${style ? style.dot : "bg-success"}`} />
      <span className="truncate text-sm font-medium">{conn.name}</span>
      {conn.tag && <TagBadge connection={conn} size="md" />}
      <span className="ml-auto truncate font-mono text-xs text-subtle">{conn.host}</span>
    </div>
  );
}

function Names({ names }: { names: string[] }) {
  const shown = names.slice(0, 8);
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-s1 px-3 py-2 font-mono text-[12px]">
      {shown.map((n) => (
        <li key={n} className="truncate" title={n}>
          {n}
        </li>
      ))}
      {names.length > shown.length && <li className="text-subtle">+ {names.length - shown.length} more</li>}
    </ul>
  );
}

/** Asks before a write to a production environment. */
export function ConfirmWrite({
  connId,
  title,
  message,
  names,
  confirmLabel,
  warning,
  onConfirm,
  onClose,
}: {
  connId: string;
  title: string;
  message: React.ReactNode;
  names: string[];
  confirmLabel: string;
  warning?: string | null;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { conn, danger } = useTarget(connId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} icon={<Globe size={16} className={danger ? "text-danger" : "text-brand"} />} onClose={() => !busy && onClose()}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">{message}</p>
        <Names names={names} />
        <EnvBox conn={conn} />
        {danger && (
          <p className="flex items-center gap-2 text-xs text-danger">
            <AlertTriangle size={13} /> This is a production environment.
          </p>
        )}
        {warning && <p className="text-xs text-warning">{warning}</p>}
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy} autoFocus={danger}>
            Cancel
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={go} disabled={busy} autoFocus={!danger}>
            {busy && <Loader size={13} />} {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Someone saved the web resource after the editor read it. */
export function ConflictDialog({ name, onCompare, onOverwrite, onClose }: { name: string; onCompare: () => void; onOverwrite: () => void; onClose: () => void }) {
  return (
    <Modal title="Changed on the server" icon={<AlertTriangle size={16} className="text-warning" />} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          Someone saved <span className="font-mono text-[12.5px] text-fg">{name}</span> after you started editing it. Saving now would replace their version with
          yours.
        </p>
        <p className="text-xs text-subtle">Compare reads their version and shows it next to yours — your changes stay in the editor.</p>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-secondary" onClick={onOverwrite}>
            Overwrite theirs
          </button>
          <button className="btn btn-primary" onClick={onCompare} autoFocus>
            Compare
          </button>
        </div>
      </div>
    </Modal>
  );
}

const SOLUTION_KEY = "cds.webresources.solution";

function readSolution(): string {
  try {
    return localStorage.getItem(SOLUTION_KEY) ?? "";
  } catch {
    return "";
  }
}

/** New web resource: solution (sets the prefix), name, type, content. */
export function NewWebResourceDialog({
  connId,
  list,
  folder,
  onCreated,
  onClose,
}: {
  connId: string;
  list: WebResourceList;
  /** A folder to start the name in (`scripts/forms`, after `contoso_/`). */
  folder: string;
  onCreated: (id: string, published: boolean) => void;
  onClose: () => void;
}) {
  const { conn, danger } = useTarget(connId);
  const solutions = useMemo(() => list.solutions.filter((s) => !s.managed && !s.microsoft), [list.solutions]);
  const [solution, setSolution] = useState(() => {
    const last = readSolution();
    return solutions.some((s) => s.uniqueName === last) ? last : solutions.find((s) => s.count > 0)?.uniqueName ?? solutions[0]?.uniqueName ?? "";
  });
  const sol = solutions.find((s) => s.uniqueName === solution) ?? null;
  const prefix = sol?.prefix ? `${sol.prefix}_` : "";
  const [rest, setRest] = useState(folder ? `/${folder}/` : "");
  const [kind, setKind] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<PickedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  const name = prefix + rest.trim();
  const effectiveKind = kind ?? kindFromName(name) ?? kindFromName(file?.name ?? "");
  const taken = list.items.some((r) => r.name.toLowerCase() === name.toLowerCase());
  const problem = !rest.trim() ? "Enter a name." : nameProblem(name) ?? (taken ? "A web resource with this name already exists." : null);
  const tooBig = !!file && !!list.maxUploadSize && file.size > list.maxUploadSize;
  const ready = !problem && !!effectiveKind && !tooBig && !busy;

  const pick = async () => {
    try {
      const f = await api.openWebResourceFile();
      if (!f) return;
      setFile(f);
      // An empty name, or only a folder: finish it with the file's name.
      if (!rest.trim() || rest.endsWith("/")) setRest(`${rest}${f.name}`);
    } catch (e) {
      setError(friendlyError(String(e)));
    }
  };

  const create = async (publish: boolean) => {
    if (!ready || !effectiveKind) return;
    setBusy(true);
    setError(null);
    try {
      const id = await api.createWebResource(connId, {
        name,
        displayName: displayName.trim(),
        description: description.trim() || null,
        kind: effectiveKind,
        content: file?.content ?? "",
        solution: sol?.uniqueName ?? null,
      });
      try {
        localStorage.setItem(SOLUTION_KEY, solution);
      } catch {
        // Only a convenience.
      }
      if (publish) await api.publishWebResources(connId, [id]);
      onCreated(id, publish);
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };

  return (
    <Modal title="New web resource" icon={<Plus size={16} className="text-brand" />} onClose={() => !busy && onClose()} width="max-w-xl">
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Solution</span>
          <select className="input" value={solution} onChange={(e) => setSolution(e.target.value)} disabled={!!list.solutionsError}>
            <SelectFace />
            {solutions.map((s) => (
              <option key={s.id} value={s.uniqueName}>
                {s.friendlyName} · {s.prefix}_{s.count ? ` · ${s.count} web resources` : ""}
              </option>
            ))}
            <option value="">No solution (default solution only)</option>
          </select>
          {list.solutionsError && <span className="mt-1 block text-xs text-warning">Solutions couldn't be read; it goes into the default solution only.</span>}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
          <div className="flex items-center">
            {prefix && <span className="flex h-8 items-center rounded-l-md border border-r-0 border-line bg-s2 px-2.5 font-mono text-[12.5px] text-muted">{prefix}</span>}
            <input
              ref={nameRef}
              className={`input font-mono !text-[12.5px] ${prefix ? "!rounded-l-none" : ""}`}
              value={rest}
              onChange={(e) => setRest(e.target.value)}
              placeholder={prefix ? "/scripts/account.js" : "contoso_/scripts/account.js"}
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && void create(false)}
            />
          </div>
          <span className={`mt-1 block text-xs ${problem && rest.trim() ? "text-warning" : "text-subtle"}`}>
            {problem && rest.trim() ? problem : "Folders are part of the name: /scripts/forms/account.js."}
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Type</span>
            <select className="input" value={effectiveKind ?? ""} onChange={(e) => setKind(e.target.value ? Number(e.target.value) : null)}>
              <SelectFace />
              <option value="">Pick a type…</option>
              {Object.entries(KINDS)
                .filter(([k]) => k !== "8")
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Display name</span>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={name.split("/").pop() || "Optional"} maxLength={200} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" maxLength={2000} />
        </label>

        <div className="flex items-center gap-3 rounded-lg border border-line bg-s1 px-3 py-2.5 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {file ? (
              <>
                <span className="font-medium">{file.name}</span> <span className="text-xs text-subtle">· {formatBytes(file.size)}</span>
                {tooBig && <span className="ml-2 text-xs text-danger">larger than the environment allows ({formatBytes(list.maxUploadSize!)})</span>}
              </>
            ) : (
              <span className="text-muted">Empty — write the content after creating it, or start from a file.</span>
            )}
          </span>
          {file && (
            <button className="btn btn-ghost btn-sm" onClick={() => setFile(null)}>
              Clear
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={pick}>
            <Upload size={12} /> From file…
          </button>
        </div>

        <EnvBox conn={conn} />
        {danger && (
          <p className="flex items-center gap-2 text-xs text-danger">
            <AlertTriangle size={13} /> This is a production environment.
          </p>
        )}
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-secondary" onClick={() => create(true)} disabled={!ready} title="Create it and make it live">
            Create &amp; publish
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={() => create(false)} disabled={!ready}>
            {busy && <Loader size={13} />} Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Delete: shows what blocks it first; nothing may block it. */
export function DeleteDialog({ connId, d, onDeleted, onClose }: { connId: string; d: WebResourceDetail; onDeleted: () => void; onClose: () => void }) {
  const { conn, danger } = useTarget(connId);
  const [blockers, setBlockers] = useState<DependencyItem[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .webResourceDependents(connId, d.id, true)
      .then((b) => live && setBlockers(b))
      .catch((e) => live && setCheckError(friendlyError(String(e))));
    return () => {
      live = false;
    };
  }, [connId, d.id]);

  const locked = d.managed ? "Managed web resources are removed by uninstalling their solution." : !d.canBeDeleted ? "This web resource is marked as not deletable." : null;
  const canDelete = !locked && blockers !== null && blockers.length === 0 && !busy;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteWebResource(connId, d.id);
      onDeleted();
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete web resource" icon={<Trash size={16} className="text-danger" />} onClose={() => !busy && onClose()}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          Delete <span className="font-mono text-[12.5px] text-fg">{d.name}</span> ({kindOf(d.kind).label})? This can't be undone — forms or pages that load it by
          name will break.
        </p>
        <EnvBox conn={conn} />
        {locked ? (
          <p className="text-xs text-warning">{locked}</p>
        ) : checkError ? (
          <p className="text-xs text-warning">Couldn't check what uses it: {checkError}</p>
        ) : blockers === null ? (
          <p className="flex items-center gap-2 text-xs text-subtle">
            <Loader size={12} className="text-brand" /> Checking what uses it…
          </p>
        ) : blockers.length ? (
          <div className="space-y-2">
            <p className="text-xs text-warning">Dataverse won't delete it while these use it — remove it from them first:</p>
            <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {blockers.map((b) => (
                <li key={`${b.kind}:${b.id}`} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  <span className="shrink-0 text-xs text-subtle">
                    {b.kindLabel}
                    {b.table ? ` · ${b.table}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-success">Nothing in Dataverse depends on it.</p>
        )}
        {danger && (
          <p className="flex items-center gap-2 text-xs text-danger">
            <AlertTriangle size={13} /> This is a production environment.
          </p>
        )}
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={go} disabled={!canDelete}>
            {busy && <Loader size={13} />} Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A small "⋯" menu. */
export function Menu({ label, icon, items }: { label: string; icon: React.ReactNode; items: ({ label: string; run: () => void; danger?: boolean; disabled?: boolean } | null)[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-ghost btn-icon" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={label} title={label}>
        {icon}
      </button>
      {open && (
        <div className="pop popover absolute right-0 top-full z-50 mt-1.5 w-52 p-1" role="menu">
          {items.map((it, i) =>
            it ? (
              <button
                key={it.label}
                role="menuitem"
                className={`menu-item ${it.danger ? "!text-danger" : ""}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
              >
                {it.label}
              </button>
            ) : (
              <div key={`sep${i}`} className="my-1 border-t border-line" />
            )
          )}
        </div>
      )}
    </div>
  );
}

/** Before a save or publish: what's on Dataverse next to what will be written, then confirm. */
export function ReviewChanges({
  connId,
  name,
  kind,
  before,
  after,
  labels,
  mode,
  requested,
  managed,
  onConfirm,
  onClose,
}: {
  connId: string;
  name: string;
  kind: number;
  /** Base64 on Dataverse now. */
  before: string;
  /** What will be written: text (edited) or base64 (from a file / the unpublished version). */
  after: { text?: string; b64?: string };
  labels: [string, string];
  mode: "save" | "publish";
  /** Save mode: the user asked for Save & publish. */
  requested: boolean;
  managed: boolean;
  /** Resolves when written; the dialog then closes. */
  onConfirm: (publish: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { conn, danger } = useTarget(connId);
  const theme = useStore((s) => s.theme);
  const k = kindOf(kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  const [stats, setStats] = useState<{ added: number; removed: number } | null>(null);

  const text = !k.image || kind === 11;
  const beforeText = useMemo(() => (text ? safeText(before) : ""), [before, text]);
  const afterText = useMemo(() => (text ? after.text ?? safeText(after.b64 ?? "") : ""), [after, text]);
  const afterB64 = after.b64 ?? "";
  const same = text ? beforeText === afterText : before === afterB64;

  const go = async (publish: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(publish);
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };
  // Ctrl+Enter confirms what was asked for.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void goRef.current(mode === "publish" || requested);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, requested]);

  const primaryLabel = mode === "publish" ? "Publish" : requested ? "Save & publish" : "Save";

  return (
    <Modal
      title={mode === "publish" ? "Review before publishing" : "Review changes before saving"}
      icon={<Globe size={16} className={danger ? "text-danger" : "text-brand"} />}
      onClose={() => !busy && onClose()}
      width="max-w-[min(1200px,94vw)]"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={name}>
            {name}
          </span>
          {text && !same && stats && (
            <span className="shrink-0 font-mono text-xs tabular-nums">
              <span className="text-success">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span> <span className="text-subtle">lines</span>
            </span>
          )}
          {text && !same && (
            <div className="seg shrink-0" role="group" aria-label="Layout">
              <button aria-pressed={!inline} onClick={() => setInline(false)}>
                Side by side
              </button>
              <button aria-pressed={inline} onClick={() => setInline(true)}>
                Inline
              </button>
            </div>
          )}
        </div>

        {same ? (
          <div className="rounded-lg border border-line bg-s1 px-4 py-6 text-center text-sm text-muted">No differences — this is already what's on Dataverse.</div>
        ) : text ? (
          <div className="overflow-hidden rounded-lg border border-line">
            {!inline && (
              <div className="grid grid-cols-2 border-b border-line bg-s1 text-[11.5px] text-subtle">
                <span className="px-4 py-1.5">{labels[0]}</span>
                <span className="px-4 py-1.5">{labels[1]}</span>
              </div>
            )}
            <div className="h-[min(56vh,560px)]" style={{ background: "var(--editor-bg)" }}>
              <DiffEditor
                height="100%"
                language={k.language ?? "plaintext"}
                original={beforeText}
                modified={afterText}
                originalModelPath={`review/${name}/before.${k.ext || "txt"}`}
                modifiedModelPath={`review/${name}/after.${k.ext || "txt"}`}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: !inline,
                  fontSize: 12.5,
                  fontFamily: EDITOR_FONT,
                  lineHeight: 19,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 },
                }}
                onMount={(editor) => {
                  // Kept models are reused by path and keep their old text: set it.
                  syncDiffModels(editor, beforeText, afterText);
                  const count = () => {
                    let added = 0;
                    let removed = 0;
                    for (const c of editor.getLineChanges() ?? []) {
                      if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
                      if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
                    }
                    setStats({ added, removed });
                  };
                  editor.onDidUpdateDiff(count);
                }}
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {[
              [labels[0], before],
              [labels[1], afterB64],
            ].map(([label, b64]) => (
              <div key={label} className="overflow-hidden rounded-lg border border-line">
                <div className="border-b border-line bg-s1 px-4 py-1.5 text-[11.5px] text-subtle">
                  {label} · {formatBytes(b64 ? base64ToBytes(b64).length : 0)}
                </div>
                <div className="flex h-56 items-center justify-center p-4" style={{ background: "var(--s1)" }}>
                  {b64 ? <img src={`data:${k.mime};base64,${b64}`} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-subtle">Empty</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        <EnvBox conn={conn} />
        {danger && (
          <p className="flex items-center gap-2 text-xs text-danger">
            <AlertTriangle size={13} /> This is a production environment.
          </p>
        )}
        {managed && mode === "save" && <p className="text-xs text-warning">Managed: saving adds an unmanaged layer on top of the solution's version.</p>}
        <p className="text-xs text-muted">
          {mode === "publish" || requested
            ? "Publishing makes it live for everyone right away."
            : "Saving keeps it unpublished — the environment serves the current version until you publish."}
        </p>
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

        <div className="modal-footer">
          <span className="mr-auto text-[11.5px] text-subtle">
            <kbd className="kbd">Ctrl</kbd> <kbd className="kbd">Enter</kbd> {primaryLabel}
          </span>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy} autoFocus={danger}>
            Cancel
          </button>
          {mode === "save" && (
            <button className="btn btn-secondary" onClick={() => go(!requested)} disabled={busy}>
              {requested ? "Save only" : "Save & publish"}
            </button>
          )}
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={() => go(mode === "publish" || requested)} disabled={busy} autoFocus={!danger}>
            {busy && <Loader size={13} />} {primaryLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function safeText(b64: string): string {
  try {
    return decodeText(b64).text;
  } catch {
    return "";
  }
}

/** A diff editor's models hold `left` / `right` (models reused by path keep old text). */
export function syncDiffModels(editor: { getModel(): { original: { getValue(): string; setValue(v: string): void }; modified: { getValue(): string; setValue(v: string): void } } | null }, left: string, right: string) {
  const m = editor.getModel();
  if (!m) return;
  if (m.original.getValue() !== left) m.original.setValue(left);
  if (m.modified.getValue() !== right) m.modified.setValue(right);
}
