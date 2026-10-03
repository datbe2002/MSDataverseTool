// Dialogs of flow tasks: new task (where its folder goes), edit details, add
// flows, and the "Add to task" button on a flow in the Flows tool.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { useStore } from "../store";
import { useFlows } from "../lib/flows";
import { folderName, useFlowTasks } from "../lib/flowTasks";
import { flowTaskRoute } from "../lib/navigation";
import { friendlyError } from "../lib/errors";
import { useDebounced } from "../lib/useDebounced";
import { Modal } from "./Modals";
import { EnvBox, useTarget } from "./WebResourceDialogs";
import { AlertTriangle, Check, ChevronDown, Folder, Loader, Plus, Search } from "./Icon";
import type { FlowMeta, TaskLocation, TaskView } from "../types";

const PARENT_KEY = "cds.flowtasks.parent";

function readParent(): string | null {
  try {
    return localStorage.getItem(PARENT_KEY);
  } catch {
    return null;
  }
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-subtle">{hint}</span>}
    </label>
  );
}

/** New task: name, what it asks for, where its folder goes; optionally with flows to add right away. */
export function NewTaskDialog({
  connId,
  flows,
  onCreated,
  onClose,
}: {
  connId: string;
  /** Flows to check out once the task exists. */
  flows?: { id: string; name: string }[];
  onCreated: (view: TaskView) => void;
  onClose: () => void;
}) {
  const { conn, danger } = useTarget(connId);
  const pushToast = useStore((s) => s.pushToast);
  const [name, setName] = useState("");
  const [ticket, setTicket] = useState("");
  const [description, setDescription] = useState("");
  const [parent, setParent] = useState(readParent() ?? "");
  const [folder, setFolder] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);
  const [git, setGit] = useState(true);
  const [location, setLocation] = useState<TaskLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);
  // First task: suggest %USERPROFILE%\HexaTasks.
  useEffect(() => {
    if (parent) return;
    api
      .flowTaskDefaults()
      .then((d) => setParent((p) => p || d.defaultRoot))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!folderEdited) setFolder(folderName(name));
  }, [name, folderEdited]);

  const where = useDebounced(`${parent}\u0000${folder}`, 250);
  useEffect(() => {
    const [p, f] = where.split("\u0000");
    if (!p.trim() || !f.trim()) {
      setLocation(null);
      return;
    }
    let live = true;
    api
      .flowTaskLocation(p, f)
      .then((l) => live && setLocation(l))
      .catch(() => live && setLocation(null));
    return () => {
      live = false;
    };
  }, [where]);

  const gitBlocked = !location?.gitAvailable ? "Git isn't installed on this computer." : location.insideRepo ? `The folder is inside the git repository ${location.insideRepo}.` : null;
  const problem = !name.trim()
    ? "Give the task a name."
    : location?.problem ?? (location?.notEmpty ? "That folder already has files in it — pick a new one." : null);
  const ready = !problem && !!location && !busy && !!conn;

  const browse = async () => {
    try {
      const picked = await api.pickFolder("Where should the task folder go?", parent || null);
      if (picked) setParent(picked);
    } catch (e) {
      setError(friendlyError(String(e)));
    }
  };

  const create = async () => {
    if (!ready || !conn) return;
    setBusy(true);
    setError(null);
    try {
      let view = await api.createFlowTask({
        parent: parent.trim(),
        folder: folder.trim(),
        name: name.trim(),
        ticket: ticket.trim(),
        description: description.trim(),
        env: { host: conn.host, name: conn.tag ? `${conn.name} (${conn.tag})` : conn.name },
        git: git && !gitBlocked,
      });
      try {
        localStorage.setItem(PARENT_KEY, parent.trim());
      } catch {
        // Only a convenience.
      }
      if (view.warning) pushToast({ tone: "warning", title: "Task created", body: view.warning });
      if (flows?.length) {
        try {
          view = await api.addTaskFlows(conn.id, view.path, flows);
          if (view.warning) pushToast({ tone: "warning", title: "Some flows weren't added", body: view.warning });
        } catch (e) {
          pushToast({ tone: "error", title: "Task created, but the flows weren't added", body: friendlyError(String(e)) });
        }
      }
      onCreated(view);
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };

  return (
    <Modal title="New flow task" icon={<Folder size={16} className="text-brand" />} onClose={() => !busy && onClose()} width="max-w-xl">
      <div className="space-y-4">
        <Field label="Task name">
          <input
            ref={nameRef}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="TASK-482 Fix invoice sync"
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
        </Field>
        <div className="grid grid-cols-[1fr] gap-3">
          <Field label="Ticket or link (optional)">
            <input className="input" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="https://dev.azure.com/… or #482" />
          </Field>
        </div>
        <Field label="What needs to change" hint="Goes into CLAUDE.md in the task folder, so whoever edits the flows knows the task.">
          <textarea
            className="input !h-24 resize-y py-2 leading-relaxed"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Paste the task as you got it."
          />
        </Field>

        <div className="space-y-2">
          <span className="block text-xs font-medium text-muted">Location</span>
          <div className="flex gap-2">
            <input className="input font-mono !text-[12.5px]" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="C:\Users\you\HexaTasks" spellCheck={false} aria-label="Parent folder" />
            <button className="btn btn-secondary shrink-0" onClick={browse} type="button">
              Browse…
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-subtle">Folder</span>
            <input
              className="input font-mono !text-[12.5px]"
              value={folder}
              onChange={(e) => {
                setFolder(e.target.value);
                setFolderEdited(true);
              }}
              spellCheck={false}
              aria-label="Task folder name"
            />
          </div>
          {location && (
            <div className="truncate font-mono text-[11.5px] text-subtle" title={location.path}>
              {location.path}
            </div>
          )}
          {location?.oneDrive && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> This is inside OneDrive. Syncing can lock or damage the files (and git) while they're being edited — a folder outside OneDrive is safer.
            </p>
          )}
        </div>

        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={git && !gitBlocked} disabled={!!gitBlocked} onChange={(e) => setGit(e.target.checked)} />
          <span>
            Keep a git history in the folder
            <span className="block text-xs text-subtle">
              {gitBlocked ?? "A commit when flows are added; no remote is ever set up. Without git, Hexa Studio keeps copies of each edited version itself."}
            </span>
          </span>
        </label>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted">Environment</span>
          <EnvBox conn={conn} />
          {danger && <p className="mt-1.5 text-xs text-warning">Tasks are meant for a development environment. Flows of this one can be compared, never applied.</p>}
        </div>
        {!!flows?.length && (
          <p className="text-xs text-muted">
            Adds {flows.length === 1 ? `“${flows[0].name}”` : `${flows.length} flows`} once the task is created.
          </p>
        )}
        {(error || (problem && name.trim())) && (
          <p className={`break-words text-xs ${error ? "rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-danger" : "text-warning"}`}>{error ?? problem}</p>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} disabled={!ready}>
            {busy && <Loader size={13} />} Create task
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Name, ticket and description of a task (CLAUDE.md is rewritten with them). */
export function EditTaskDialog({ view, onSaved, onClose }: { view: TaskView; onSaved: (v: TaskView) => void; onClose: () => void }) {
  const t = view.task;
  const [name, setName] = useState(t.name);
  const [ticket, setTicket] = useState(t.ticket);
  const [description, setDescription] = useState(t.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateFlowTask(view.path, name, ticket, description, t.status));
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };
  return (
    <Modal title="Task details" icon={<Folder size={16} className="text-brand" />} onClose={() => !busy && onClose()} width="max-w-xl">
      <div className="space-y-4">
        <Field label="Task name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Ticket or link">
          <input className="input" value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </Field>
        <Field label="What needs to change" hint="CLAUDE.md is updated with it; your own notes in that file stay.">
          <textarea className="input !h-32 resize-y py-2 leading-relaxed" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>
            {busy && <Loader size={13} />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Picks flows of the task's environment to check out. */
export function AddFlowsDialog({ connId, view, onAdded, onClose }: { connId: string; view: TaskView; onAdded: (v: TaskView) => void; onClose: () => void }) {
  const list = useFlows((s) => s.lists[connId]);
  const status = useFlows((s) => s.status[connId]);
  const loadFlows = useFlows((s) => s.loadFlows);
  const pushToast = useStore((s) => s.pushToast);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => loadFlows(connId), [connId, loadFlows]);
  const inTask = useMemo(() => new Set(view.task.flows.map((f) => f.id)), [view]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list?.flows ?? []).filter((f) => !q || f.name.toLowerCase().includes(q) || f.id.includes(q) || f.solutions.some((s) => s.toLowerCase().includes(q)));
  }, [list, filter]);

  const toggle = (f: FlowMeta) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(f.id)) next.delete(f.id);
      else next.add(f.id);
      return next;
    });

  const add = async () => {
    const flows = (list?.flows ?? []).filter((f) => picked.has(f.id)).map((f) => ({ id: f.id, name: f.name }));
    if (!flows.length) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api.addTaskFlows(connId, view.path, flows);
      if (v.warning) pushToast({ tone: "warning", title: "Some flows weren't added", body: v.warning });
      onAdded(v);
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add flows to ${view.task.name}`} icon={<Plus size={16} className="text-brand" />} onClose={() => !busy && onClose()} width="max-w-xl">
      <div className="space-y-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input className="input !pl-8" placeholder="Filter by name, solution or id…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
        </div>
        <ul className="h-[min(50vh,420px)] overflow-y-auto rounded-lg border border-line bg-s1 p-1" aria-label="Flows">
          {status === "loading" && !list ? (
            <li className="flex items-center gap-2 px-3 py-6 text-xs text-subtle">
              <Loader size={12} className="text-brand" /> Reading flows…
            </li>
          ) : shown.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-subtle">No flows match.</li>
          ) : (
            shown.map((f) => {
              const already = inTask.has(f.id.toLowerCase());
              const disabled = already || f.managed;
              return (
                <li key={f.id}>
                  <label className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-s3"}`}>
                    <input type="checkbox" className="accent-[var(--brand)]" checked={already || picked.has(f.id)} disabled={disabled} onChange={() => toggle(f)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{f.name || "(no name)"}</span>
                      <span className="block truncate text-xs text-subtle">{f.solutions.join(", ") || "Not in a solution"}</span>
                    </span>
                    {already ? <span className="badge badge-neutral">in task</span> : f.managed ? <span className="badge badge-neutral" title="Managed flows can't be changed in this environment">managed</span> : null}
                  </label>
                </li>
              );
            })
          )}
        </ul>
        <p className="text-xs text-subtle">Each flow is read from the environment now; that copy is the baseline every edit is compared with.</p>
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={add} disabled={busy || picked.size === 0}>
            {busy && <Loader size={13} />} Add {picked.size || ""} {picked.size === 1 ? "flow" : "flows"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** On a flow in the Flows tool: the tasks it's in, and adding it to one. */
export function AddToTask({ connId, flow }: { connId: string; flow: FlowMeta }) {
  const navigate = useNavigate();
  const conn = useStore((s) => s.connections.find((c) => c.id === connId) ?? null);
  const pushToast = useStore((s) => s.pushToast);
  const list = useFlowTasks((s) => s.list);
  const loadList = useFlowTasks((s) => s.loadList);
  const setView = useFlowTasks((s) => s.setView);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!list) void loadList();
  }, [list, loadList]);
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

  const id = flow.id.toLowerCase();
  const here = (list ?? []).filter((t) => !t.missing && t.env?.host === conn?.host.toLowerCase());
  const holding = here.filter((t) => t.flowIds.includes(id));
  const targets = here.filter((t) => t.status === "open" && !t.flowIds.includes(id));

  const add = async (path: string, name: string) => {
    setOpen(false);
    setBusy(true);
    try {
      const v = await api.addTaskFlows(connId, path, [{ id: flow.id, name: flow.name }]);
      setView(v);
      pushToast({ tone: v.warning ? "warning" : "success", title: `Added to ${name}`, body: v.warning ?? undefined });
    } catch (e) {
      pushToast({ tone: "error", title: "Couldn't add the flow", body: friendlyError(String(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {holding.map((t) => (
        <button key={t.path} className="badge badge-brand gap-1 hover:underline" onClick={() => navigate(flowTaskRoute(t.path, id))} title={`Open it in the task (${t.path})`}>
          <Folder size={11} /> {t.name}
        </button>
      ))}
      <div className="relative" ref={ref}>
        <button
          className="btn btn-ghost"
          onClick={() => setOpen((o) => !o)}
          disabled={busy || flow.managed}
          aria-expanded={open}
          title={flow.managed ? "Managed flows can't be changed in this environment" : "Check this flow out into a task folder to edit and compare"}
        >
          {busy ? <Loader size={14} /> : <Folder size={14} />} Add to task <ChevronDown size={12} />
        </button>
        {open && (
          <div className="pop popover absolute right-0 top-full z-50 mt-1.5 w-64 p-1" role="menu">
            {targets.length > 0 && <div className="px-2.5 pb-1 pt-1.5 text-[11.5px] text-subtle">Open tasks in {conn?.name}</div>}
            {targets.map((t) => (
              <button key={t.path} role="menuitem" className="menu-item" onClick={() => void add(t.path, t.name)} title={t.path}>
                <span className="truncate">{t.name}</span>
                <span className="ml-auto text-xs text-subtle">{t.flowIds.length}</span>
              </button>
            ))}
            {holding.length > 0 && targets.length === 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-subtle">
                <Check size={12} /> Already in {holding.length === 1 ? "its task" : "every open task"}
              </div>
            )}
            {(targets.length > 0 || holding.length > 0) && <div className="my-1 border-t border-line" />}
            <button
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
            >
              <Plus size={13} /> New task…
            </button>
          </div>
        )}
      </div>
      {creating && (
        <NewTaskDialog
          connId={connId}
          flows={[{ id: flow.id, name: flow.name }]}
          onCreated={(v) => {
            setView(v);
            navigate(flowTaskRoute(v.path, id));
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
