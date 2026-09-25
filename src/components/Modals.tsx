import { useEffect, useRef, useState } from "react";
import { useStore, activeProjectOf } from "../store";
import { X, Compass, Loader, Plus, Database, AlertTriangle, Pencil, Check, Folder, Trash, LogIn, LogOut } from "./Icon";
import { TAG_COLORS, TAG_PRESETS, tagStyle } from "../lib/tags";
import { TagBadge } from "./TagBadge";
import { useReauth } from "../lib/reauth";
import { tabTitle } from "../lib/tabs";
import type { Connection, Project } from "../types";

/* ---------- shared shell ---------- */

export function Modal({
  title,
  icon,
  onClose,
  children,
  width = "max-w-lg",
}: {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // With stacked dialogs (a confirm over Edit project), only the top one closes.
      const open = document.querySelectorAll('[aria-modal="true"]');
      if (open[open.length - 1] !== overlayRef.current) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]"
      style={{ background: "var(--overlay)" }}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`modal-in popover flex max-h-full w-full ${width} flex-col overflow-hidden !rounded-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
          {icon && (
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-s3 ring-1 ring-inset ring-line">
              {icon}
            </span>
          )}
          <h2 className="flex-1 text-[15px] font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} className="btn btn-ghost btn-icon btn-sm" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        {/* Taller than the window: the body scrolls, the footer (.modal-footer) stays at the bottom. */}
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <input {...props} className="input" />
    </label>
  );
}

/* ---------- Add by URL ---------- */

export function AddConnectionModal({ onClose }: { onClose: () => void }) {
  const saveConnection = useStore((s) => s.saveConnection);
  const [url, setUrl] = useState("https://");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    const conn = await saveConnection(url.trim(), name.trim());
    setBusy(false);
    if (conn) onClose();
  };

  return (
    <Modal title="Add connection" icon={<Plus size={16} className="text-brand" />} onClose={onClose}>
      <div className="space-y-4">
        <Field
          label="Environment URL"
          placeholder="https://org12345.crm.dynamics.com"
          value={url}
          autoFocus
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Field
          label="Display name (optional)"
          placeholder="e.g. Sales DEV"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <p className="text-xs text-subtle">
          You'll be asked to sign in with Microsoft the first time you run a query against this
          environment.
        </p>
        <div className="modal-footer">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={submit} disabled={busy || !url.trim()} className="btn btn-primary">
            {busy && <Loader size={14} />}
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Edit connection (name, tag, colour) ---------- */

export function EditConnectionModal({
  connection,
  onClose,
}: {
  connection: Connection;
  onClose: () => void;
}) {
  const updateConnection = useStore((s) => s.updateConnection);
  const deleteConnection = useStore((s) => s.deleteConnection);
  const [name, setName] = useState(connection.name);
  const [tag, setTag] = useState(connection.tag ?? "");
  const [color, setColor] = useState(connection.color ?? "slate");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const preview = { tag: tag.trim().toUpperCase() || null, color };

  const submit = async () => {
    setBusy(true);
    const ok = await updateConnection(
      connection.id,
      name.trim(),
      preview.tag,
      preview.tag ? color : null
    );
    setBusy(false);
    if (ok) onClose();
  };

  const remove = async () => {
    setBusy(true);
    await deleteConnection(connection.id);
    setBusy(false);
    onClose();
  };

  return (
    <Modal
      title="Edit environment"
      icon={<Pencil size={15} className="text-brand" />}
      onClose={onClose}
    >
      <div className="space-y-5">
        <Field
          label="Display name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted">Environment tag</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {TAG_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setTag(p);
                  // Sensible default colours for the presets.
                  setColor(
                    { PROD: "red", UAT: "amber", DEV: "green", TEST: "blue", SIT: "violet" }[p] ??
                      color
                  );
                }}
                className={`btn btn-secondary btn-sm ${
                  tag.trim().toUpperCase() === p ? "!border-brand/50 !bg-brand/15" : ""
                }`}
              >
                {p}
              </button>
            ))}
            <input
              className="input !w-28 !py-1 text-sm uppercase"
              placeholder="Custom…"
              maxLength={12}
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              aria-label="Custom tag"
            />
            {tag && (
              <button className="btn btn-ghost btn-sm" onClick={() => setTag("")}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted">Colour</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tag colour">
            {TAG_COLORS.map((c) => {
              const s = tagStyle(c);
              const selected = color === c;
              return (
                <button
                  key={c}
                  role="radio"
                  aria-checked={selected}
                  title={c}
                  onClick={() => setColor(c)}
                  className={`grid h-7 w-7 place-items-center rounded-full ${s.dot} transition hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-s1 ${
                    selected ? "ring-2 ring-fg/70 ring-offset-2 ring-offset-s1" : ""
                  }`}
                >
                  {selected && <Check size={13} className="text-white" strokeWidth={3} />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-line bg-s2 px-3 py-2">
          <span className="text-xs text-subtle">Preview</span>
          <span className={`h-2 w-2 rounded-full ${preview.tag ? tagStyle(color).dot : "bg-subtle/60"}`} />
          <span className="text-sm font-medium">{name.trim() || connection.name}</span>
          <TagBadge connection={preview} size="md" />
          <span className="ml-auto truncate font-mono text-xs text-subtle">{connection.host}</span>
        </div>

        {confirmRemove && (
          <p className="text-xs text-subtle">
            Only this saved connection and its query tabs go away. Nothing in Dataverse is deleted.
          </p>
        )}
        <div className="modal-footer">
          {!confirmRemove ? (
            <button
              onClick={() => setConfirmRemove(true)}
              className="btn btn-ghost mr-auto text-danger"
              title="Remove this environment from the project"
            >
              <Trash size={14} /> Remove
            </button>
          ) : (
            <div className="mr-auto flex items-center gap-2">
              <span className="text-xs text-danger">Remove from this project?</span>
              <button onClick={remove} disabled={busy} className="btn btn-danger btn-sm">
                {busy && <Loader size={13} />} Remove
              </button>
              <button onClick={() => setConfirmRemove(false)} className="btn btn-ghost btn-sm">
                Keep
              </button>
            </div>
          )}
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn btn-primary">
            {busy && <Loader size={14} />}
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Discover environments ---------- */

export function EnvironmentPickerModal({ onClose }: { onClose: () => void }) {
  const project = useStore(activeProjectOf);
  const signIn = useStore((s) => s.signIn);
  const signingIn = useStore((s) => s.signingIn);
  const cancelSignIn = useStore((s) => s.cancelSignIn);
  const environments = useStore((s) => s.environments);
  const loadingEnvs = useStore((s) => s.loadingEnvs);
  const envError = useStore((s) => s.envError);
  const loadEnvironments = useStore((s) => s.loadEnvironments);
  const saveConnection = useStore((s) => s.saveConnection);

  useEffect(() => {
    if (project?.username && environments.length === 0) loadEnvironments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.username]);

  const pick = async (url: string, name: string) => {
    const conn = await saveConnection(url, name);
    if (conn) onClose();
  };

  return (
    <Modal
      title="Discover environments"
      icon={<Compass size={16} className="text-brand" />}
      onClose={onClose}
      width="max-w-xl"
    >
      {!project ? (
        <div className="py-10 text-center text-sm text-subtle">
          Create a project first — each project holds one account and its environments.
        </div>
      ) : !project.username ? (
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <p className="text-sm text-muted">
            Sign in to <span className="font-medium text-fg">{project.name}</span> to list the Power
            Platform environments that account can reach.
          </p>
          {signingIn ? (
            <div className="flex flex-col items-center gap-2" role="status">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Loader size={14} className="text-brand" /> Waiting for the browser…
              </div>
              <p className="text-xs text-subtle">Finish signing in there. Closed the tab? Cancel and try again.</p>
              <button onClick={cancelSignIn} className="btn btn-secondary btn-sm">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => signIn()} className="btn btn-primary">
              Sign in with Microsoft
            </button>
          )}
        </div>
      ) : loadingEnvs ? (
        <ul className="space-y-1">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
              <div className="skeleton h-4 w-4" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3 w-1/3" />
                <div className="skeleton h-2.5 w-1/2" />
              </div>
            </li>
          ))}
        </ul>
      ) : envError ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          {envError}
          <button onClick={loadEnvironments} className="ml-2 underline">Retry</button>
        </div>
      ) : environments.length === 0 ? (
        <div className="py-10 text-center text-sm text-subtle">
          No environments found for {project.username}.
        </div>
      ) : (
        <ul className="max-h-[55vh] space-y-1 overflow-y-auto">
          {environments.map((env) => (
            <li key={env.id}>
              <button
                onClick={() => pick(env.url, env.friendlyName)}
                className="flex w-full items-center gap-3 rounded-lg border border-line bg-s2 px-3 py-2.5 text-left transition hover:border-brand/50 hover:bg-brand/8"
              >
                <Database size={16} className="shrink-0 text-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{env.friendlyName || env.urlName}</div>
                  <div className="truncate font-mono text-xs text-subtle">{env.host}</div>
                </div>
                {env.state && env.state !== "Ready" && (
                  <span className="badge badge-neutral">{env.state}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/* ---------- Project: create / edit / delete ---------- */

export function ProjectModal({
  project,
  onClose,
}: {
  project: Project | null;
  onClose: () => void;
}) {
  const createProject = useStore((s) => s.createProject);
  const updateProject = useStore((s) => s.updateProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const requestSignOut = useStore((s) => s.requestSignOut);
  const connections = useStore((s) => s.connections);
  // Live, not the snapshot the modal opened with (it changes on sign-out).
  const username = useStore((s) => (project ? s.projects.find((p) => p.id === project.id)?.username : null));

  const [name, setName] = useState(project?.name ?? "");
  const [tenant, setTenant] = useState(project?.tenant ?? "");
  const [clientId, setClientId] = useState(project?.clientId ?? "");
  const [color, setColor] = useState(project?.color ?? "violet");
  const [advanced, setAdvanced] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const envCount = project ? connections.filter((c) => c.projectId === project.id).length : 0;

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const ok = project
      ? await updateProject(project.id, name.trim(), tenant.trim(), clientId.trim(), color)
      : !!(await createProject(name.trim(), tenant.trim(), clientId.trim(), color));
    setBusy(false);
    if (ok) onClose();
  };

  const remove = async () => {
    if (!project) return;
    setBusy(true);
    await deleteProject(project.id);
    setBusy(false);
    onClose();
  };

  return (
    <Modal
      title={project ? "Edit project" : "New project"}
      icon={<Folder size={16} className={tagStyle(color).text} />}
      onClose={onClose}
    >
      <div className="space-y-5">
        <Field
          label="Project name"
          placeholder="e.g. Contoso, Fabrikam, Internal"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted">Colour</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Project colour">
            {TAG_COLORS.map((c) => {
              const s = tagStyle(c);
              const selected = color === c;
              return (
                <button
                  key={c}
                  role="radio"
                  aria-checked={selected}
                  title={c}
                  onClick={() => setColor(c)}
                  className={`grid h-7 w-7 place-items-center rounded-full ${s.dot} transition hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-s1 ${
                    selected ? "ring-2 ring-fg/70 ring-offset-2 ring-offset-s1" : ""
                  }`}
                >
                  {selected && <Check size={13} className="text-white" strokeWidth={3} />}
                </button>
              );
            })}
          </div>
        </div>

        {project && username && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-s2 px-3 py-2 text-sm">
            <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
            <span className="min-w-0 truncate text-muted">
              Signed in as <span className="font-medium text-fg">{username}</span>
            </span>
            <button
              onClick={() => requestSignOut(project.id)}
              className="btn btn-ghost btn-sm ml-auto shrink-0"
              title="Sign out of this project"
            >
              <LogOut size={13} /> Sign out
            </button>
          </div>
        )}

        <div>
          <button
            onClick={() => setAdvanced((a) => !a)}
            className="text-xs font-medium text-muted underline-offset-2 hover:underline"
          >
            {advanced ? "Hide" : "Show"} sign-in options
          </button>
          {advanced && (
            <div className="mt-3 space-y-4">
              <Field
                label="Tenant (optional)"
                placeholder="organizations · or a tenant GUID / domain"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
              />
              <Field
                label="Client ID (optional)"
                placeholder="Your own public client registration"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <p className="text-xs leading-relaxed text-subtle">
                Leave both empty to use the app defaults. Pin a tenant when an account belongs to
                several directories and you want this project to always land in one of them.
              </p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {project && !confirmDelete && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="btn btn-ghost mr-auto text-danger"
              title="Delete this project, its environments and its sign-in"
            >
              <Trash size={14} /> Delete project
            </button>
          )}
          {project && confirmDelete && (
            <div className="mr-auto flex items-center gap-2">
              <span className="text-xs text-danger">
                Delete “{project.name}” and its {envCount} environment
                {envCount === 1 ? "" : "s"}?
              </span>
              <button onClick={remove} disabled={busy} className="btn btn-danger btn-sm">
                {busy && <Loader size={13} />} Delete
              </button>
              <button onClick={() => setConfirmDelete(false)} className="btn btn-ghost btn-sm">
                Keep
              </button>
            </div>
          )}
          <button onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !name.trim()} className="btn btn-primary">
            {busy && <Loader size={14} />}
            {project ? "Save" : "Create project"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Confirm environment / project switch ---------- */

export function SwitchConfirmModal() {
  const pendingSwitchId = useStore((s) => s.pendingSwitchId);
  const pendingProjectId = useStore((s) => s.pendingProjectId);
  const connections = useStore((s) => s.connections);
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const tabs = useStore((s) => s.tabs);
  const confirmSwitchSave = useStore((s) => s.confirmSwitchSave);
  const confirmSwitchDiscard = useStore((s) => s.confirmSwitchDiscard);
  const cancelSwitch = useStore((s) => s.cancelSwitch);

  const targetProject = pendingProjectId
    ? projects.find((p) => p.id === pendingProjectId) ?? null
    : null;
  const targetConn = pendingSwitchId
    ? connections.find((c) => c.id === pendingSwitchId) ?? null
    : null;
  if (!targetProject && !targetConn) return null;

  const isProject = !!targetProject;
  const currentName = isProject
    ? projects.find((p) => p.id === activeProjectId)?.name ?? "this project"
    : connections.find((c) => c.id === activeId)?.name ?? "this environment";
  const targetName = targetProject?.name ?? targetConn?.name ?? "";
  const style = targetProject
    ? tagStyle(targetProject.color)
    : targetConn?.tag
    ? tagStyle(targetConn.color)
    : null;
  const danger = !isProject && !!style?.danger;
  const envCount = targetProject
    ? connections.filter((c) => c.projectId === targetProject.id).length
    : 0;

  // Every switch asks; with unsaved changes it also offers to save them.
  const dirtyTabs = tabs.filter((t) => t.sql !== t.savedSql).length;
  const hasWork = dirtyTabs > 0;

  return (
    <Modal
      title={isProject ? "Switch project" : "Switch environment"}
      icon={
        isProject ? (
          <Folder size={16} className={style?.text ?? "text-brand"} />
        ) : (
          <Database size={16} className={danger ? "text-danger" : "text-brand"} />
        )
      }
      onClose={cancelSwitch}
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          {hasWork ? (
            <>
              You have <span className="font-medium text-fg">unsaved changes</span> in {dirtyTabs}{" "}
              tab{dirtyTabs === 1 ? "" : "s"} on{" "}
              <span className="font-medium text-fg">{currentName}</span>. Save before switching to{" "}
              <span className="font-medium text-fg">{targetName}</span>?
            </>
          ) : (
            <>
              Switch from <span className="font-medium text-fg">{currentName}</span> to{" "}
              <span className="font-medium text-fg">{targetName}</span>? Queries will run there from
              now on. Your tabs here are kept for when you come back.
            </>
          )}
        </p>

        <div
          className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${
            style ? `${style.ring} ${style.tint}` : "border-line bg-s2"
          }`}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${style ? style.dot : "bg-success"}`} />
          <span className="truncate text-sm font-medium">{targetName}</span>
          {targetConn && <TagBadge connection={targetConn} size="md" />}
          <span className="ml-auto truncate font-mono text-xs text-subtle">
            {targetProject
              ? `${targetProject.username ?? "not signed in"} · ${envCount} env${
                  envCount === 1 ? "" : "s"
                }`
              : targetConn?.host}
          </span>
        </div>

        {danger && (
          <p className="flex items-center gap-2 text-xs text-danger">
            <AlertTriangle size={13} /> This is a production environment.
          </p>
        )}

        {hasWork && (
          <p className="text-xs text-subtle">
            Discarding reverts the tabs to their last saved version — your saved queries are kept.
          </p>
        )}

        <div className="modal-footer">
          <button onClick={cancelSwitch} className="btn btn-ghost" autoFocus={danger}>
            Cancel
          </button>
          {hasWork ? (
            <>
              <button onClick={confirmSwitchDiscard} className="btn btn-secondary">
                Discard changes
              </button>
              <button
                onClick={confirmSwitchSave}
                className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
                autoFocus={!danger}
              >
                Save &amp; switch
              </button>
            </>
          ) : (
            <button
              onClick={confirmSwitchDiscard}
              className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
              autoFocus={!danger}
            >
              Switch
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Confirm closing a tab with unsaved changes ---------- */

export function CloseTabConfirmModal() {
  const pendingCloseTabId = useStore((s) => s.pendingCloseTabId);
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.pendingCloseTabId) ?? null);
  const cancelCloseTab = useStore((s) => s.cancelCloseTab);
  const confirmCloseTab = useStore((s) => s.confirmCloseTab);

  if (!pendingCloseTabId || !tab) return null;
  const name = tab.title?.trim() ? tab.title : tabTitle(tab.sql);

  return (
    <Modal
      title="Close tab"
      icon={<AlertTriangle size={15} className="text-warning" />}
      onClose={cancelCloseTab}
      width="max-w-md"
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          <span className="font-medium text-fg">{name}</span> has unsaved changes. Closing the tab
          discards the query.
        </p>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-s2 px-3 py-2 font-mono text-xs leading-relaxed text-muted">
          {tab.sql.trim() || "(empty query)"}
        </pre>
        <div className="modal-footer">
          <button onClick={cancelCloseTab} className="btn btn-ghost" autoFocus>
            Cancel
          </button>
          <button onClick={confirmCloseTab} className="btn btn-danger">
            Close without saving
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Confirm sign out ---------- */

export function SignOutConfirmModal() {
  const pendingSignOutId = useStore((s) => s.pendingSignOutId);
  const projects = useStore((s) => s.projects);
  const connections = useStore((s) => s.connections);
  const signOut = useStore((s) => s.signOut);
  const cancelSignOut = useStore((s) => s.cancelSignOut);
  const [busy, setBusy] = useState(false);

  const project = pendingSignOutId ? projects.find((p) => p.id === pendingSignOutId) ?? null : null;
  if (!project) return null;

  const style = tagStyle(project.color);
  const envCount = connections.filter((c) => c.projectId === project.id).length;

  const confirm = async () => {
    setBusy(true);
    await signOut(project.id);
    setBusy(false);
  };

  return (
    <Modal
      title="Sign out"
      icon={<LogOut size={15} className="text-danger" />}
      onClose={() => !busy && cancelSignOut()}
      width="max-w-md"
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          Sign out of <span className="font-medium text-fg">{project.name}</span>? Queries on its
          environments will ask you to sign in with Microsoft again.
        </p>

        <div className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${style.ring} ${style.tint}`}>
          <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
          <span className="truncate text-sm font-medium">{project.username ?? "Signed in"}</span>
          <span className="ml-auto shrink-0 text-xs text-muted">
            {envCount} environment{envCount === 1 ? "" : "s"}
          </span>
        </div>

        <p className="text-xs text-subtle">
          The stored sign-in is removed from this computer. Environments, saved queries and history
          stay as they are.
        </p>

        <div className="modal-footer">
          <button onClick={cancelSignOut} disabled={busy} className="btn btn-ghost" autoFocus>
            Cancel
          </button>
          <button onClick={confirm} disabled={busy} className="btn btn-danger">
            {busy ? <Loader size={14} /> : <LogOut size={14} />}
            Sign out
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Sign in again (expired sign-in) ---------- */

/** Asked for by lib/reauth when a command's sign-in has expired; the command reruns after. */
export function ReauthModal() {
  const request = useReauth((s) => s.request);
  const settle = useReauth((s) => s.settle);
  const project = useStore((s) => (request ? s.projects.find((p) => p.id === request.projectId) ?? null : null));
  const signIn = useStore((s) => s.signIn);
  const signingIn = useStore((s) => s.signingIn);
  const cancelSignIn = useStore((s) => s.cancelSignIn);
  const authError = useStore((s) => s.authError);
  if (!request) return null;
  // No stored sign-in at all (signed out, or never signed in) rather than an expired one.
  const signedOut = request.reason === "Not signed in" || !project?.username;

  const start = async () => {
    if (await signIn(request.projectId)) settle(true);
  };
  const giveUp = () => {
    if (signingIn) cancelSignIn();
    settle(false);
  };

  return (
    <Modal title="Sign in again" icon={<LogIn size={15} className="text-brand" />} onClose={giveUp} width="max-w-md">
      <div className="space-y-4">
        {signedOut ? (
          <p className="text-sm leading-relaxed text-muted">
            You're not signed in to <span className="font-medium text-fg">{project?.name ?? "this project"}</span>. Sign in
            to carry on — what you were doing continues right after.
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            Your sign-in to <span className="font-medium text-fg">{project?.name ?? "this project"}</span>
            {project?.username && <> as <span className="font-medium text-fg">{project.username}</span></>} has expired.
            Sign in again to carry on — what you were doing continues right after.
          </p>
        )}
        {request.reason && !signedOut && (
          <p className="rounded-lg border border-line bg-s2 px-3 py-2 text-xs text-subtle [overflow-wrap:anywhere]">{request.reason}</p>
        )}
        {signingIn && (
          <div className="flex items-center gap-2 text-sm" role="status">
            <Loader size={14} className="text-brand" /> Finish signing in in your browser…
          </div>
        )}
        {authError && !signingIn && (
          <p className="text-xs text-danger" role="alert">
            {authError}
          </p>
        )}

        <div className="modal-footer">
          <button onClick={giveUp} className="btn btn-ghost">
            {signingIn ? "Cancel" : "Not now"}
          </button>
          <button onClick={start} disabled={signingIn} className="btn btn-primary" autoFocus>
            {signingIn ? <Loader size={14} /> : <LogIn size={14} />}
            Sign in with Microsoft
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Confirm INSERT / UPDATE / DELETE ---------- */

const VERB = { update: "Update", delete: "Delete", insert: "Insert" } as const;

export function DmlConfirmModal() {
  const preview = useStore((s) => s.pendingDml);
  const running = useStore((s) => s.dmlRunning);
  const progress = useStore((s) => s.dmlProgress);
  const confirm = useStore((s) => s.confirmDml);
  const cancel = useStore((s) => s.cancelDml);
  const connections = useStore((s) => s.connections);
  const activeId = useStore((s) => s.activeId);

  if (!preview) return null;

  const env = connections.find((c) => c.id === activeId) ?? null;
  const envStyle = env?.tag ? tagStyle(env.color) : null;
  const verb = VERB[preview.kind];
  const danger = preview.kind === "delete" || !!envStyle?.danger;
  const n = preview.count;
  const records = `${n.toLocaleString()} record${n === 1 ? "" : "s"}`;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Modal
      title={`Confirm ${verb.toUpperCase()}`}
      icon={<AlertTriangle size={16} className={danger ? "text-danger" : "text-warning"} />}
      onClose={() => {
        if (!running) cancel();
      }}
    >
      {n === 0 ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            No records in <code className="rounded bg-s3 px-1.5 py-0.5 font-mono text-fg">{preview.table}</code>{" "}
            match this statement — nothing to change.
          </p>
          <div className="modal-footer">
            <button onClick={cancel} className="btn btn-ghost">Close</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted">
            This will{" "}
            <span className={`font-semibold ${danger ? "text-danger" : "text-warning"}`}>
              {verb.toLowerCase()} {records}
            </span>{" "}
            in <code className="rounded bg-s3 px-1.5 py-0.5 font-mono text-fg">{preview.table}</code>{" "}
            through the Dataverse Web API. Plugins and workflows run as usual.
          </p>

          {env && (
            <div
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                envStyle?.danger
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : "border-line bg-s2 text-muted"
              }`}
            >
              {envStyle?.danger ? <AlertTriangle size={15} /> : <Database size={15} />}
              <span className="min-w-0 truncate">
                {envStyle?.danger ? "You are writing to " : "Target: "}
                <span className="font-medium text-fg">{env.name}</span>
              </span>
              <TagBadge connection={env} size="md" className="ml-auto" />
            </div>
          )}

          {preview.columns.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {preview.columns.map((c) => (
                <span key={c} className="badge badge-neutral font-mono">{c}</span>
              ))}
            </div>
          )}

          {danger && <p className="text-xs text-danger">Deleted records can't be restored from here.</p>}

          {running && progress && (
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted">
                <span>
                  {progress.paused > 0 && progress.paused >= progress.threads
                    ? "Waiting — the server asked us to slow down…"
                    : "Working…"}
                  {progress.threads > 1 && (
                    <span className="text-subtle">
                      {" "}· {progress.threads} threads
                      {progress.paused > 0 && `, ${progress.paused} paused`}
                    </span>
                  )}
                </span>
                <span>{progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-s3">
                <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          <div className="modal-footer">
            <button onClick={cancel} disabled={running} className="btn btn-ghost">Cancel</button>
            <button
              onClick={confirm}
              disabled={running}
              className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            >
              {running && <Loader size={14} />}
              {verb} {records}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
