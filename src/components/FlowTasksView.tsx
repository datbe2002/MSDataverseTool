// Flow tasks (route /flowtasks?task=<folder>&flow=<id>&l=&r=): the flows of an
// assigned task checked out into a folder. Someone else edits them there; this
// view notices each save, shows what changed against the original and the
// cloud, and flags what looks broken.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { useStore } from "../store";
import { useFlows } from "../lib/flows";
import { POLL_MS, STATUS_BADGE, STATUS_DOT, STATUS_LABEL, checkFlow, drifted, flowChanges, flowStatus, useFlowTasks } from "../lib/flowTasks";
import { ROUTES, flowRoute, flowTaskRoute } from "../lib/navigation";
import { relativeTime } from "../lib/history";
import { friendlyError } from "../lib/errors";
import { Modal } from "./Modals";
import { Menu } from "./WebResourceDialogs";
import { TagBadge } from "./TagBadge";
import { AddFlowsDialog, EditTaskDialog, NewTaskDialog } from "./FlowTaskDialogs";
import { FlowTaskCompare } from "./FlowTaskCompare";
import { AlertTriangle, ArrowLeft, ArrowUpRight, Check, Copy, Folder, Loader, More, Plus, Refresh, Upload } from "./Icon";
import type { Connection, FlowMeta, TaskSummary, TaskVersion, TaskView } from "../types";
import { SelectFace } from "./FormParts";

const time = (iso: string | null | undefined) => (iso ? relativeTime(Date.parse(iso)) : "—");

type ListFilter = "open" | "done" | "all";

export function FlowTasksView() {
  const [params] = useSearchParams();
  const path = params.get("task");
  const loadList = useFlowTasks((s) => s.loadList);
  useEffect(() => void loadList(), [loadList]);
  return path ? <TaskPane key={path} path={path} /> : <TaskList />;
}

/** The connection to a task's environment: the active one when it matches. */
function useTaskConnection(host: string | undefined): Connection | null {
  return useStore((s) => {
    if (!host) return null;
    const matching = s.connections.filter((c) => c.host.toLowerCase() === host);
    return matching.find((c) => c.id === s.activeId) ?? matching[0] ?? null;
  });
}

function useCopy() {
  const pushToast = useStore((s) => s.pushToast);
  return (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ tone: "success", title: `Copied ${what}` }))
      .catch(() => pushToast({ tone: "error", title: `Couldn't copy ${what}` }));
}

// ---------------------------------------------------------------- task list

function TaskList() {
  const navigate = useNavigate();
  const activeId = useStore((s) => s.activeId);
  const pushToast = useStore((s) => s.pushToast);
  const list = useFlowTasks((s) => s.list);
  const listError = useFlowTasks((s) => s.listError);
  const loadList = useFlowTasks((s) => s.loadList);
  const setView = useFlowTasks((s) => s.setView);
  const [filter, setFilter] = useState<ListFilter>("open");
  const [creating, setCreating] = useState(false);
  const [missing, setMissing] = useState<TaskSummary | null>(null);

  const counts = useMemo(
    () => ({
      open: (list ?? []).filter((t) => t.status === "open").length,
      done: (list ?? []).filter((t) => t.status === "done").length,
      all: list?.length ?? 0,
    }),
    [list]
  );
  const shown = (list ?? []).filter((t) => filter === "all" || t.status === filter);

  const openExisting = async () => {
    try {
      const picked = await api.pickFolder("Open a task folder", null);
      if (!picked) return;
      const v = await api.openFlowTask(picked);
      setView(v);
      navigate(flowTaskRoute(v.path));
    } catch (e) {
      pushToast({ tone: "error", title: "Couldn't open the task", body: friendlyError(String(e)) });
    }
  };

  return (
    <div className="grid h-full grid-cols-[clamp(300px,28vw,340px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="flex items-center gap-2 px-3 pt-3">
          <button className="btn btn-primary flex-1" onClick={() => setCreating(true)} disabled={!activeId} title={activeId ? "Create a task for the environment you're on" : "Pick an environment first"}>
            <Plus size={14} /> New task
          </button>
          <button className="btn btn-secondary" onClick={openExisting} title="Add a task folder that's already on disk">
            <Folder size={14} /> Open…
          </button>
        </div>
        <div className="seg mx-3 my-2.5 !flex" role="group" aria-label="Filter tasks">
          {(
            [
              ["open", "Open"],
              ["done", "Done"],
              ["all", "All"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className="flex-1">
              {label}
              {list && <span className="seg-count">{counts[key]}</span>}
            </button>
          ))}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label="Tasks">
          {listError ? (
            <li className="px-3 py-8 text-center text-xs text-subtle">
              <div className="text-warning">Couldn't read the task list.</div>
              <div className="mt-1 break-words">{listError}</div>
              <button className="btn btn-secondary btn-sm mt-3" onClick={() => void loadList()}>
                <Refresh size={12} /> Retry
              </button>
            </li>
          ) : !list ? (
            Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="space-y-1.5 px-2.5 py-2">
                <div className="skeleton h-3 w-2/3" />
                <div className="skeleton h-2.5 w-1/2" />
              </li>
            ))
          ) : shown.length === 0 ? (
            <li className="px-3 py-10 text-center">
              <div className="empty-icon">
                <Folder size={18} />
              </div>
              <div className="mt-3 text-sm font-medium">{list.length === 0 ? "No tasks yet" : `No ${filter} tasks`}</div>
              <div className="mt-1 text-xs text-subtle">{list.length === 0 ? "Create one for the flows you were asked to change." : "Switch the filter above."}</div>
            </li>
          ) : (
            shown.map((t) => (
              <li key={t.path}>
                <button
                  role="option"
                  aria-selected={false}
                  className="nav-item nav-item-tall"
                  onClick={() => (t.missing ? setMissing(t) : navigate(flowTaskRoute(t.path)))}
                  title={t.path}
                >
                  {t.missing ? <AlertTriangle size={14} className="shrink-0 text-warning" /> : <Folder size={14} className="shrink-0 text-subtle" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{t.name || "(no name)"}</span>
                    <span className="block truncate text-xs font-normal text-subtle">
                      {t.missing ? "Folder not found" : `${t.env?.name ?? "?"} · ${t.flowIds.length} ${t.flowIds.length === 1 ? "flow" : "flows"} · ${time(t.lastOpened)}`}
                    </span>
                  </span>
                  {t.status === "done" && <span className="badge badge-success shrink-0">done</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      <div className="flex min-h-0 items-center justify-center overflow-y-auto p-8">
        <div className="max-w-lg">
          <div className="empty-icon">
            <Folder size={20} />
          </div>
          <h2 className="mt-4 text-lg font-semibold tracking-tight">Flow tasks</h2>
          <p className="mt-1 text-sm text-muted">Check out only the flows of a task into a folder of their own, let Claude edit them there, and see exactly what changed before anything goes back.</p>
          <ol className="mt-5 space-y-3 text-sm">
            {[
              ["New task", "Pick where its folder goes. Add flows here or from Flows › Add to task — each one is read from the environment as its baseline."],
              ["Hand the folder to Claude", "Open it in Claude Code. CLAUDE.md in the folder says what the task is and how to edit flows/*/definition.json."],
              ["Review", "Edits show up here within seconds: the diff against the baseline, step by step changes, broken references, and whether the cloud changed meanwhile."],
            ].map(([title, body], i) => (
              <li key={title} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-s3 text-xs font-medium tabular-nums">{i + 1}</span>
                <span>
                  <span className="font-medium">{title}</span>
                  <span className="block text-muted">{body}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {creating && activeId && <NewTaskDialog connId={activeId} onCreated={(v) => navigate(flowTaskRoute(v.path))} onClose={() => setCreating(false)} />}
      {missing && <MissingTask task={missing} onClose={() => setMissing(null)} />}
    </div>
  );
}

function MissingTask({ task, onClose }: { task: TaskSummary; onClose: () => void }) {
  const navigate = useNavigate();
  const loadList = useFlowTasks((s) => s.loadList);
  const setView = useFlowTasks((s) => s.setView);
  const [error, setError] = useState<string | null>(null);
  const locate = async () => {
    try {
      const picked = await api.pickFolder(`Where is “${task.name}” now?`, null);
      if (!picked) return;
      const v = await api.openFlowTask(picked);
      await api.forgetFlowTask(task.path);
      setView(v);
      onClose();
      navigate(flowTaskRoute(v.path));
    } catch (e) {
      setError(friendlyError(String(e)));
    }
  };
  const forget = async () => {
    try {
      await api.forgetFlowTask(task.path);
      await loadList();
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
    }
  };
  return (
    <Modal title="Task folder not found" icon={<AlertTriangle size={16} className="text-warning" />} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          <span className="break-all font-mono text-[12.5px] text-fg">{task.path}</span> is gone, or has no task.json. If you moved the folder, point to its new place.
        </p>
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={forget}>
            Remove from the list
          </button>
          <button className="btn btn-primary" onClick={locate} autoFocus>
            Locate…
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- one task

function TaskPane({ path }: { path: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const flowId = params.get("flow");
  const copy = useCopy();
  const pushToast = useStore((s) => s.pushToast);
  const view = useFlowTasks((s) => s.views[path]);
  const viewError = useFlowTasks((s) => s.viewErrors[path]);
  const loadView = useFlowTasks((s) => s.loadView);
  const setView = useFlowTasks((s) => s.setView);
  const loadList = useFlowTasks((s) => s.loadList);
  const forgetLocal = useFlowTasks((s) => s.forgetLocal);
  const live = useFlowTasks((s) => s.live[path]);
  const liveLoading = useFlowTasks((s) => !!s.liveLoading[path]);
  const liveError = useFlowTasks((s) => s.liveErrors[path] ?? null);
  const loadLive = useFlowTasks((s) => s.loadLive);
  const conn = useTaskConnection(view?.task.env.host);
  const envList = useFlows((s) => (conn ? s.lists[conn.id] : undefined));
  const loadFlows = useFlows((s) => s.loadFlows);
  const [dialog, setDialog] = useState<null | "add" | "edit" | "forget" | { remove: string }>(null);
  const [errorsByFlow, setErrorsByFlow] = useState<Record<string, number>>({});

  // The files are edited outside the app: look again every few seconds.
  useEffect(() => {
    void loadView(path);
    const t = setInterval(() => document.visibilityState === "visible" && void loadView(path), POLL_MS);
    return () => clearInterval(t);
  }, [path, loadView]);
  useEffect(() => {
    if (conn) loadFlows(conn.id);
  }, [conn, loadFlows]);
  // Whether the cloud changed since the flows were added: once per visit, then on demand.
  const flowCount = view?.task.flows.length ?? 0;
  useEffect(() => {
    if (conn && flowCount > 0 && !live && !liveError) void loadLive(conn.id, path);
  }, [conn, flowCount]);

  if (!view) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        {viewError ? (
          <>
            <AlertTriangle size={20} className="text-warning" />
            <div className="text-sm font-medium">Couldn't open the task</div>
            <div className="max-w-md break-words text-xs text-subtle">{friendlyError(viewError)}</div>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate(ROUTES.flowtasks)}>
              <ArrowLeft size={12} /> All tasks
            </button>
          </>
        ) : (
          <Loader size={18} className="text-brand" />
        )}
      </div>
    );
  }

  const task = view.task;
  const flow = task.flows.find((f) => f.id === flowId?.toLowerCase()) ?? null;
  const fileOf = (id: string) => view.flows.find((f) => f.id === id);
  const checkCloud = conn ? () => void loadLive(conn.id, path) : null;
  const pick = (id: string | null) => {
    const next = new URLSearchParams({ task: path });
    if (id) next.set("flow", id);
    setParams(next, { replace: true });
  };

  const setStatus = async (status: "open" | "done") => {
    try {
      setView(await api.updateFlowTask(path, task.name, task.ticket, task.description, status));
    } catch (e) {
      pushToast({ tone: "error", title: "Couldn't update the task", body: friendlyError(String(e)) });
    }
  };
  const reveal = () => api.revealFlowTask(path).catch((e) => pushToast({ tone: "error", title: "Couldn't open the folder", body: friendlyError(String(e)) }));

  return (
    <div className="grid h-full grid-cols-[clamp(280px,26vw,320px)_minmax(0,1fr)]">
      {/* Task and its flows */}
      <div className="flex min-h-0 flex-col border-r border-line bg-s1">
        <div className="shrink-0 px-3 pt-3">
          <button className="btn btn-ghost btn-sm -ml-1" onClick={() => navigate(ROUTES.flowtasks)}>
            <ArrowLeft size={13} /> All tasks
          </button>
          <div className="mt-2 flex items-start gap-2 px-1">
            <div className="min-w-0 flex-1">
              <h2 className="line-clamp-2 text-[15px] font-semibold tracking-tight [overflow-wrap:anywhere]" title={task.name}>
                {task.name}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <EnvTag conn={conn} name={task.env.name} />
                {task.status === "done" && <span className="badge badge-success">done</span>}
                <span className="badge badge-neutral" title={view.git.repo ? "The folder is a git repository" : view.git.available ? "Not a git repository: Hexa Studio keeps copies of edited versions in .hexa" : "Git isn't installed: Hexa Studio keeps copies of edited versions in .hexa"}>
                  {view.git.repo ? "git" : "no git"}
                </span>
              </div>
            </div>
            <Menu
              label="Task actions"
              icon={<More size={15} />}
              items={[
                { label: "Edit details…", run: () => setDialog("edit") },
                { label: "Open folder", run: () => void reveal() },
                { label: "Copy folder path", run: () => copy(path, "folder path") },
                null,
                task.status === "open" ? { label: "Mark task done", run: () => void setStatus("done") } : { label: "Reopen task", run: () => void setStatus("open") },
                { label: "Remove from the list…", run: () => setDialog("forget") },
              ]}
            />
          </div>
          <button className="mt-2 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left font-mono text-[11.5px] text-subtle hover:text-fg" onClick={() => copy(path, "folder path")} title={`${path} — click to copy`}>
            <span className="min-w-0 flex-1 truncate">{path}</span>
            <Copy size={11} className="shrink-0" />
          </button>
        </div>

        <div className="mt-3 flex shrink-0 items-center justify-between border-t border-line px-4 pb-1 pt-3">
          <span className="text-[12.5px] font-medium">
            Flows <span className="tabular-nums text-subtle">{task.flows.length}</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setDialog("add")} disabled={!conn || task.status === "done"} title={!conn ? `Add a connection to ${task.env.host} first` : "Add flows of this environment"}>
            <Plus size={12} /> Add
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="listbox" aria-label="Flows in the task">
          <li>
            <button role="option" aria-selected={!flow} className="nav-item" onClick={() => pick(null)}>
              <span className="min-w-0 flex-1 truncate text-[13px]">Overview</span>
            </button>
          </li>
          {task.flows.map((f) => {
            const status = flowStatus(f, fileOf(f.id));
            const drift = drifted(f, live);
            return (
              <li key={f.id}>
                <button role="option" aria-selected={f.id === flow?.id} className="nav-item nav-item-tall" onClick={() => pick(f.id)} title={f.name}>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{f.name}</span>
                    <span className="block truncate text-xs font-normal text-subtle">
                      {STATUS_LABEL[status]}
                      {status !== "unchanged" && fileOf(f.id)?.modifiedAt && ` · ${time(fileOf(f.id)?.modifiedAt)}`}
                    </span>
                  </span>
                  {drift && (
                    <span title="Changed in the cloud since it was added">
                      <AlertTriangle size={13} className="shrink-0 text-warning" />
                    </span>
                  )}
                  {(errorsByFlow[f.id] ?? 0) > 0 && <span className="badge badge-danger shrink-0 tabular-nums" title="Errors in the edited file">{errorsByFlow[f.id]}</span>}
                </button>
              </li>
            );
          })}
          {task.flows.length === 0 && <li className="px-3 py-6 text-center text-xs text-subtle">No flows yet. Add the ones this task changes.</li>}
        </ul>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5 text-xs text-subtle">
          {!conn ? (
            <span className="text-warning">No connection to {task.env.host} — the cloud can't be checked.</span>
          ) : liveError ? (
            <span className="min-w-0 flex-1 truncate text-warning" title={liveError}>
              Couldn't read the cloud
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{liveLoading ? "Reading the cloud…" : live ? `Cloud checked ${relativeTime(live.at)}` : "Cloud not checked yet"}</span>
          )}
          {conn && (
            <button className="btn btn-ghost btn-sm ml-auto" onClick={checkCloud!} disabled={liveLoading || flowCount === 0} title={`Read the task's flows from ${task.env.name} again`}>
              <Refresh size={12} className={liveLoading ? "animate-spin" : ""} /> Check
            </button>
          )}
        </div>
      </div>

      {/* A flow, or the task */}
      <div className="min-h-0 overflow-hidden">
        {flow ? (
          <FlowPane
            key={flow.id}
            view={view}
            flowId={flow.id}
            conn={conn}
            onRemove={() => setDialog({ remove: flow.id })}
            onErrors={(n) => setErrorsByFlow((s) => (s[flow.id] === n ? s : { ...s, [flow.id]: n }))}
          />
        ) : (
          <TaskOverview view={view} conn={conn} onPick={pick} onAdd={() => setDialog("add")} />
        )}
      </div>

      {dialog === "add" && conn && <AddFlowsDialog connId={conn.id} view={view} onAdded={setView} onClose={() => setDialog(null)} />}
      {dialog === "edit" && <EditTaskDialog view={view} onSaved={setView} onClose={() => setDialog(null)} />}
      {dialog === "forget" && (
        <ConfirmDialog
          title="Remove the task from the list?"
          body={
            <>
              The folder stays where it is, untouched: <span className="break-all font-mono text-[12.5px] text-fg">{path}</span>. Open it again any time with Open….
            </>
          }
          confirm="Remove from list"
          onConfirm={async () => {
            await api.forgetFlowTask(path);
            forgetLocal(path);
            await loadList();
            navigate(ROUTES.flowtasks);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {typeof dialog === "object" && dialog && "remove" in dialog && (
        <ConfirmDialog
          title="Remove the flow from the task?"
          body={
            <>
              “{task.flows.find((f) => f.id === dialog.remove)?.name}” leaves the task. Its folder, with any edits, moves to <span className="font-mono text-[12.5px]">.hexa/removed</span>. Nothing changes in the cloud.
            </>
          }
          confirm="Remove flow"
          onConfirm={async () => {
            setView(await api.removeTaskFlow(path, dialog.remove));
            pick(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function EnvTag({ conn, name }: { conn: Connection | null; name: string }) {
  if (conn?.tag) return <TagBadge connection={conn} />;
  return <span className="badge badge-neutral">{name}</span>;
}

function ConfirmDialog({ title, body, confirm, onConfirm, onClose }: { title: string; body: React.ReactNode; confirm: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">{body}</p>
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={go} disabled={busy} autoFocus>
            {busy && <Loader size={13} />} {confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TaskOverview({ view, conn, onPick, onAdd }: { view: TaskView; conn: Connection | null; onPick: (id: string) => void; onAdd: () => void }) {
  const copy = useCopy();
  const live = useFlowTasks((s) => s.live[view.path]);
  const task = view.task;
  const command = `cd "${view.path}"; claude`;
  const counts = task.flows.reduce<Record<string, number>>((acc, f) => {
    const s = flowStatus(f, view.flows.find((x) => x.id === f.id));
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const drifting = task.flows.filter((f) => drifted(f, live));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-8 py-7">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{task.name}</h1>
          <p className="mt-0.5 text-sm text-muted">
            {task.env.name} · created {time(task.createdOn)}
            {task.ticket && (
              <>
                {" · "}
                <button className="hover:text-fg hover:underline" onClick={() => copy(task.ticket, "ticket")} title="Copy">
                  {task.ticket}
                </button>
              </>
            )}
          </p>
        </div>

        {drifting.length > 0 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>
              {drifting.length === 1 ? `“${drifting[0].name}” was` : `${drifting.length} flows were`} changed in {task.env.name} after being added to the task. Look at what changed in the cloud before
              taking the edited version further.
            </span>
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <span className="card-title">What needs to change</span>
          </div>
          <div className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed">{task.description || <span className="text-subtle">No description — add one with Edit details so it lands in CLAUDE.md.</span>}</div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Hand it to Claude</span>
          </div>
          <div className="space-y-3 px-4 py-3 text-sm">
            <p className="text-muted">Open the folder in Claude Code (PowerShell). CLAUDE.md there explains the task and the rules for editing the flows.</p>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-s1 px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={command}>
                {command}
              </code>
              <button className="btn btn-ghost btn-sm" onClick={() => copy(command, "command")}>
                <Copy size={12} /> Copy
              </button>
            </div>
            <p className="text-xs text-subtle">Saved edits show up here within a few seconds. Nothing in this folder is sent to the cloud.</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Flows</span>
            <span className="ml-auto flex gap-1.5">
              {(["modified", "reviewed", "invalid", "missing"] as const)
                .filter((s) => counts[s])
                .map((s) => (
                  <span key={s} className={`badge ${STATUS_BADGE[s]}`}>
                    {counts[s]} {STATUS_LABEL[s].toLowerCase()}
                  </span>
                ))}
            </span>
          </div>
          {task.flows.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-subtle">
              No flows yet.{" "}
              <button className="text-brand hover:underline disabled:opacity-50" onClick={onAdd} disabled={!conn}>
                Add the ones this task changes
              </button>
              , or use Add to task on a flow in Flows.
            </div>
          ) : (
            <table className="tbl w-full">
              <thead>
                <tr>
                  <th className="text-left">Flow</th>
                  <th className="text-left">Status</th>
                  <th className="text-left">Edited</th>
                  <th className="text-left">Added</th>
                </tr>
              </thead>
              <tbody>
                {task.flows.map((f) => {
                  const file = view.flows.find((x) => x.id === f.id);
                  const s = flowStatus(f, file);
                  return (
                    <tr key={f.id} className="row cursor-pointer" onClick={() => onPick(f.id)}>
                      <td className="max-w-[280px] truncate" title={f.name}>
                        {f.name}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[s]}`}>{STATUS_LABEL[s]}</span>
                        {drifted(f, live) && <span className="badge badge-warning ml-1.5">changed in cloud</span>}
                      </td>
                      <td className="text-subtle">{s === "unchanged" ? "—" : time(file?.modifiedAt)}</td>
                      <td className="text-subtle">{time(f.addedOn)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function FlowPane({ view, flowId, conn, onRemove, onErrors }: { view: TaskView; flowId: string; conn: Connection | null; onRemove: () => void; onErrors: (n: number) => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const copy = useCopy();
  const pushToast = useStore((s) => s.pushToast);
  const activeId = useStore((s) => s.activeId);
  const setView = useFlowTasks((s) => s.setView);
  const live = useFlowTasks((s) => s.live[view.path]);
  const liveLoading = useFlowTasks((s) => !!s.liveLoading[view.path]);
  const liveError = useFlowTasks((s) => s.liveErrors[view.path] ?? null);
  const loadLive = useFlowTasks((s) => s.loadLive);
  const envFlows = useFlows((s) => (conn ? s.lists[conn.id]?.flows ?? null : null));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(0);
  const [rebasing, setRebasing] = useState(false);
  const [deploying, setDeploying] = useState<"reviewed" | "version" | null>(null);

  const flow = view.task.flows.find((f) => f.id === flowId)!;
  const file = view.flows.find((f) => f.id === flowId);
  const status = flowStatus(flow, file);
  const liveFlow = live?.flows.find((f) => f.id === flowId);
  const drift = drifted(flow, live);
  const left = params.get("l") ?? "baseline";
  const right = params.get("r") ?? "working";
  const setSides = (l: string, r: string) => {
    const next = new URLSearchParams(params);
    next.set("l", l);
    next.set("r", r);
    setParams(next, { replace: true });
  };

  useEffect(() => onErrors(errors), [errors]);

  const review = async (on: boolean) => {
    setBusy(true);
    try {
      setView(await api.setTaskFlowReviewed(view.path, flowId, on ? file?.workingHash ?? null : null));
    } catch (e) {
      pushToast({ tone: "error", title: "Couldn't update the flow", body: friendlyError(String(e)) });
    } finally {
      setBusy(false);
    }
  };
  const canReview = (status === "modified" || status === "reviewed") && errors === 0;
  const sameEnvActive = !!conn && conn.id === activeId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pb-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="line-clamp-2 min-w-0 text-lg font-semibold tracking-tight [overflow-wrap:anywhere]" title={flow.name}>
                {flow.name}
              </h2>
              <span className={`badge badge-dot ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>
              {drift && <span className="badge badge-warning">changed in cloud</span>}
            </div>
            <button className="mt-0.5 flex max-w-full items-center gap-1.5 font-mono text-[12px] text-subtle hover:text-fg" onClick={() => copy(`${view.path}\\${(file?.file ?? "").replace(/\//g, "\\")}`, "file path")} title="Copy the full path">
              <span className="truncate">{file?.file}</span>
              <Copy size={11} className="shrink-0" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            {status === "reviewed" ? (
              <button className="btn btn-secondary" onClick={() => void review(false)} disabled={busy} title="Mark it as not reviewed">
                <Check size={14} className="text-success" /> Reviewed
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void review(true)}
                disabled={busy || !canReview}
                title={status === "unchanged" ? "Nothing changed yet" : errors > 0 ? "Fix the errors first" : "You've looked at this version; editing the file again clears it"}
              >
                <Check size={14} /> Mark reviewed
              </button>
            )}
            {status === "reviewed" && (
              <button
                className="btn btn-primary"
                onClick={() => setDeploying("reviewed")}
                disabled={!conn || !!drift}
                title={!conn ? `Add ${view.task.env.name} as a connection first` : drift ? "The cloud changed since the baseline: update the baseline first" : `Write the reviewed version to ${view.task.env.name}`}
              >
                <Upload size={14} /> Deploy
              </button>
            )}
            <button
              className="btn btn-ghost"
              onClick={() => navigate(flowRoute(flowId))}
              disabled={!sameEnvActive}
              title={sameEnvActive ? "Open the flow as it is in the cloud" : `Switch to ${view.task.env.name} to open it in Flows`}
            >
              <ArrowUpRight size={14} /> Open in Flows
            </button>
            <Menu
              label="Flow actions"
              icon={<More size={15} />}
              items={[
                { label: "Update baseline from cloud…", run: () => setRebasing(true), disabled: !conn },
                { label: "Deploy an earlier version…", run: () => setDeploying("version"), disabled: !conn },
                { label: "Copy flow id", run: () => copy(flowId, "flow id") },
                null,
                { label: "Remove from task…", run: onRemove, danger: true },
              ]}
            />
          </div>
        </div>
        {drift && liveFlow && (
          <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-sm">
            <AlertTriangle size={14} className="shrink-0 text-warning" />
            <span className="min-w-0 flex-1">
              Changed in {view.task.env.name} since it was added
              {liveFlow.modifiedOn && ` — ${time(liveFlow.modifiedOn)}`}
              {liveFlow.modifiedBy && ` by ${liveFlow.modifiedBy}`}. The working copy doesn't have those changes.
            </span>
            {!(left === "baseline" && right === "live") && (
              <button className="btn btn-secondary btn-sm" onClick={() => setSides("baseline", "live")}>
                See what changed in the cloud
              </button>
            )}
            {conn && (
              <button className="btn btn-secondary btn-sm" onClick={() => setRebasing(true)} title="Make the cloud version the new baseline">
                Update baseline…
              </button>
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 border-t border-line">
        <FlowTaskCompare
          path={view.path}
          connId={conn?.id ?? null}
          envName={view.task.env.name}
          flow={flow}
          file={file}
          live={liveFlow}
          liveLoading={liveLoading}
          liveError={liveError}
          onCheckCloud={conn ? () => void loadLive(conn.id, view.path) : null}
          envFlows={envFlows}
          left={left}
          right={right}
          onPick={setSides}
          onErrors={setErrors}
        />
      </div>
      {deploying && conn && (
        <DeployDialog
          view={view}
          flowId={flowId}
          conn={conn}
          envFlows={envFlows}
          revert={deploying === "version"}
          onDone={(v) => {
            setView(v);
            void loadLive(conn.id, view.path);
            pushToast({ tone: v.warning ? "warning" : "success", title: `Deployed to ${view.task.env.name}`, body: v.warning ?? undefined });
          }}
          onClose={() => setDeploying(null)}
        />
      )}
      {rebasing && conn && (
        <UpdateBaselineDialog
          view={view}
          flowId={flowId}
          conn={conn}
          onDone={(v) => {
            setView(v);
            void loadLive(conn.id, view.path);
            pushToast({ tone: v.warning ? "warning" : "success", title: "Baseline updated", body: v.warning ?? undefined });
          }}
          onClose={() => setRebasing(false)}
        />
      )}
    </div>
  );
}

/**
 * Writes the reviewed working copy, or an earlier version (a revert), to the
 * task's environment. The backend also refuses a connection not tagged DEV, a
 * managed flow, one in no solution, and a cloud that moved on from the baseline.
 */
function DeployDialog({
  view,
  flowId,
  conn,
  envFlows,
  revert,
  onDone,
  onClose,
}: {
  view: TaskView;
  flowId: string;
  conn: Connection;
  envFlows: FlowMeta[] | null;
  revert: boolean;
  onDone: (v: TaskView) => void;
  onClose: () => void;
}) {
  const flow = view.task.flows.find((f) => f.id === flowId)!;
  const [versions, setVersions] = useState<TaskVersion[] | null>(null);
  const [version, setVersion] = useState(revert ? "" : "working");
  const [text, setText] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.taskFlowText(view.path, flowId, "baseline").then(setBaseline, () => setBaseline(null));
    if (!revert) return;
    api
      .taskFlowVersions(view.path, flowId)
      .then((v) => {
        setVersions(v);
        setVersion((cur) => cur || (v[0]?.id ?? ""));
      })
      .catch((e) => setError(friendlyError(String(e))));
  }, [view.path, flowId, revert]);
  useEffect(() => {
    if (!version) return;
    let alive = true;
    setText(null);
    api.taskFlowText(view.path, flowId, version).then(
      (t) => alive && setText(t),
      (e) => alive && setError(friendlyError(String(e)))
    );
    return () => {
      alive = false;
    };
  }, [view.path, flowId, version]);

  const problems = useMemo(() => (text === null ? null : checkFlow(text, { baseline, flows: envFlows })), [text, baseline, envFlows]);
  const errors = problems?.filter((p) => p.level === "error").length ?? 0;
  const changed = useMemo(() => (text !== null && baseline !== null ? flowChanges(baseline, text).length : null), [text, baseline]);
  const meta = envFlows?.find((f) => f.id.toLowerCase() === flowId);
  const isDev = conn.tag?.trim().toUpperCase() === "DEV";
  const blocked = !isDev
    ? `${conn.name} isn't tagged DEV. Flows are only deployed to DEV environments; set the tag in the connection's settings.`
    : errors > 0
      ? `This version has ${errors} ${errors === 1 ? "error" : "errors"}; it wouldn't save in Power Automate.`
      : null;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.deployTaskFlow(conn.id, view.path, flowId, version));
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };

  return (
    <Modal title={revert ? "Deploy an earlier version" : "Deploy the reviewed version"} icon={<Upload size={16} className="text-brand" />} onClose={() => !busy && onClose()}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          Replaces “{flow.name}” in <span className="font-medium text-fg">{view.task.env.name}</span> with{" "}
          {revert ? "the version you pick" : "the working copy as you reviewed it"}. What's there now is kept as an “Earlier baseline”, so this can be undone
          the same way.
        </p>
        {revert && (
          <label className="block space-y-1">
            <span className="block text-xs font-medium text-muted">Version</span>
            <select className="input" value={version} onChange={(e) => setVersion(e.target.value)} disabled={!versions?.length}>
              <SelectFace />
              {versions === null && <option>Loading…</option>}
              {versions?.length === 0 && <option>No earlier versions</option>}
              {versions?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label || "Version"} · {time(v.at)}
                </option>
              ))}
            </select>
          </label>
        )}
        <ul className="space-y-1 text-xs text-muted">
          <li>
            {changed === null
              ? "Comparing with the baseline…"
              : changed === 0
                ? "Same steps as the baseline."
                : `${changed} ${changed === 1 ? "step differs" : "steps differ"} from the baseline.`}
          </li>
          {meta && (
            <li>
              It's {meta.state === 1 ? "on" : "off"} in {view.task.env.name} and stays {meta.state === 1 ? "on" : "off"}.
            </li>
          )}
        </ul>
        {blocked && <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">{blocked}</p>}
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={go} disabled={busy || !!blocked || text === null || !version} autoFocus>
            {busy && <Loader size={13} />} Deploy to {view.task.env.name}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Reads the flow from the cloud again as its baseline; with edits, keep them or take the cloud version. */
function UpdateBaselineDialog({
  view,
  flowId,
  conn,
  onDone,
  onClose,
}: {
  view: TaskView;
  flowId: string;
  conn: Connection;
  onDone: (v: TaskView) => void;
  onClose: () => void;
}) {
  const live = useFlowTasks((s) => s.live[view.path]?.flows.find((f) => f.id === flowId));
  const flow = view.task.flows.find((f) => f.id === flowId)!;
  const status = flowStatus(flow, view.flows.find((f) => f.id === flowId));
  const edited = status !== "unchanged";
  const upToDate = !!live?.hash && live.hash === flow.baselineHash;
  const [mode, setMode] = useState<"keep" | "take">("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.updateTaskBaseline(conn.id, view.path, flowId, edited ? mode : "keep"));
      onClose();
    } catch (e) {
      setError(friendlyError(String(e)));
      setBusy(false);
    }
  };

  const option = (value: "keep" | "take", title: string, body: string) => (
    <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 ${mode === value ? "border-brand bg-s2" : "border-line"}`}>
      <input type="radio" name="baseline-mode" className="mt-1 accent-[var(--brand)]" checked={mode === value} onChange={() => setMode(value)} />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-relaxed text-muted">{body}</span>
      </span>
    </label>
  );

  return (
    <Modal title="Update baseline from cloud" icon={<Refresh size={16} className="text-brand" />} onClose={() => !busy && onClose()}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          Reads “{flow.name}” from {view.task.env.name} now and makes it the baseline everything is compared with. The current baseline stays available as “Earlier baseline”.
        </p>
        {live && !live.error && (
          <p className="text-xs text-subtle">
            {upToDate ? "The cloud still matches the baseline." : `In the cloud: modified ${time(live.modifiedOn)}${live.modifiedBy ? ` by ${live.modifiedBy}` : ""}.`}
          </p>
        )}
        {edited ? (
          <div className="space-y-2">
            <span className="block text-xs font-medium text-muted">The working copy has edits</span>
            {option("keep", "Keep my edits", "Only the baseline changes. The diff then shows your edits against the newest cloud version — including anything of theirs your copy would undo.")}
            {option("take", "Take the cloud version", `The file becomes the cloud version. Your edits are kept in the history (${view.git.repo ? "a git commit" : "a saved copy"}) but leave the file.`)}
          </div>
        ) : (
          <p className="text-xs text-muted">The working copy has no edits, so it follows the cloud too.</p>
        )}
        {status === "reviewed" && <p className="text-xs text-warning">The “Reviewed” mark is cleared — the comparison changes.</p>}
        {error && <p className="break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={go} disabled={busy} autoFocus>
            {busy && <Loader size={13} />} {edited && mode === "take" ? "Take cloud version" : "Update baseline"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
