import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { loadHistory, saveHistory, type HistoryEntry } from "./lib/history";
import { splitStatements, isWriteStatement } from "./lib/sqlStatements";
import { getSelectedSql } from "./lib/editor";
import { friendlyError } from "./lib/errors";
import { navigate, ROUTES } from "./lib/navigation";
import {
  MAX_TABS,
  genTabId,
  loadTabsMap,
  saveTabsMap,
  type PersistedTab,
} from "./lib/tabs";
import {
  DEFAULT_KEYS,
  loadKeybindings,
  saveKeybindings,
  type Keybindings,
} from "./lib/keys";
import type {
  Connection,
  DmlPreview,
  DmlProgress,
  DmlResult,
  EngineMode,
  Environment,
  Project,
  QueryPage,
  QueryResult,
  Settings,
} from "./types";

export type Theme = "dark" | "light";

export type OutcomeStatus = "pending" | "running" | "ok" | "error" | "write" | "cancelled";

/** Result of one statement in a batch run. */
export interface StatementOutcome {
  index: number;
  sql: string;
  status: OutcomeStatus;
  result: QueryResult | null;
  dmlResult: DmlResult | null;
  error: string | null;
  ms: number;
}

/** An open query tab. SQL is persisted per connection; results are transient. */
export interface QueryTab {
  id: string;
  /** Live draft. */
  sql: string;
  /** Last saved snapshot; the tab is "unsaved" while `sql !== savedSql`. */
  savedSql: string;
  /** Custom name; when empty the title is derived from the SQL. */
  title?: string;
  outcomes: StatementOutcome[];
  viewIndex: number;
}

/** True when the tab has edits not yet saved. */
export const tabDirty = (t: QueryTab): boolean => t.sql !== t.savedSql;

export type ToastTone = "error" | "success" | "info" | "warning";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  duration?: number;
}

const LAST_ACTIVE_KEY = "cds.activeConnectionId";
const LAST_PROJECT_KEY = "cds.activeProjectId";
const CONN_BY_PROJECT_KEY = "cds.connByProject";
const THEME_KEY = "cds.theme";
/** Settings → "Use TDS endpoint". A new key on purpose: the old per-tab
 *  Auto / TDS / FetchXML choice (`cds.engine`) no longer applies. */
const ENGINE_KEY = "cds.useTds";

function readEngineMode(): EngineMode {
  try {
    return localStorage.getItem(ENGINE_KEY) === "1" ? "tds" : "fetchxml";
  } catch {
    return "fetchxml";
  }
}

/** Last environment used in each project, so switching back returns to it. */
function readConnByProject(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CONN_BY_PROJECT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function rememberConnForProject(projectId: string | null, connId: string | null) {
  if (!projectId) return;
  try {
    const map = readConnByProject();
    if (connId) map[projectId] = connId;
    else delete map[projectId];
    localStorage.setItem(CONN_BY_PROJECT_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

function freshTab(sql = "", savedSql = sql): QueryTab {
  return { id: genTabId(), sql, savedSql, outcomes: [], viewIndex: 0 };
}

/** Restore the saved tabs for a connection, or a single empty tab. */
function tabsForConnection(connId: string | null): QueryTab[] {
  const saved = connId ? loadTabsMap()[connId] : null;
  if (saved && saved.length) {
    return saved.map((t) => ({
      id: t.id,
      sql: t.sql,
      savedSql: t.savedSql ?? t.sql, // legacy entries had no baseline
      title: t.title,
      outcomes: [],
      viewIndex: 0,
    }));
  }
  return [freshTab()];
}

/** Auto-save the given connection's tabs (SQL only) so a restart / return restores them. */
function persistTabs(connId: string | null, tabs: QueryTab[]) {
  if (!connId) return;
  const map = loadTabsMap();
  map[connId] = tabs.map<PersistedTab>((t) => ({
    id: t.id,
    sql: t.sql,
    savedSql: t.savedSql,
    title: t.title,
  }));
  saveTabsMap(map);
}

function removeSavedTabs(connId: string) {
  const map = loadTabsMap();
  delete map[connId];
  saveTabsMap(map);
}

// Resolves the pending write-confirmation dialog inside a batch run.
let confirmResolver: ((proceed: boolean) => void) | null = null;

/** Bumped per sign-in / cancel, so a stale attempt can't reset the UI of a newer one. */
let signInAttempt = 0;

/** Backend error text (`auth::SIGN_IN_CANCELLED`) of a sign-in that was cancelled. */
const SIGN_IN_CANCELLED = "Sign-in was cancelled";

interface AppStore {
  theme: Theme;
  keybindings: Keybindings;
  engineMode: EngineMode;

  projects: Project[];
  activeProjectId: string | null;
  signingIn: boolean;
  authError: string | null;

  environments: Environment[];
  loadingEnvs: boolean;
  envError: string | null;

  /** Every connection across all projects; views filter by `activeProjectId`. */
  connections: Connection[];
  activeId: string | null;
  pendingSwitchId: string | null;
  pendingProjectId: string | null;
  /** Project whose sign-out waits for the user's confirmation. */
  pendingSignOutId: string | null;
  /** Tab with unsaved changes whose closing waits for the user's confirmation. */
  pendingCloseTabId: string | null;

  tabs: QueryTab[];
  activeTabId: string;
  hasSelection: boolean;
  running: boolean;
  error: string | null;

  history: HistoryEntry[];

  pendingDml: DmlPreview | null;
  dmlRunning: boolean;
  dmlProgress: DmlProgress | null;

  toasts: Toast[];

  settings: Settings | null;

  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  toggleTheme: () => void;
  setKeybindings: (k: Keybindings) => void;
  setEngineMode: (mode: EngineMode) => void;
  setHasSelection: (has: boolean) => void;
  init: () => Promise<void>;
  signIn: (projectId?: string) => Promise<void>;
  signOut: (projectId?: string) => Promise<void>;
  /** Stop waiting for the browser (its sign-in tab was closed, …). */
  cancelSignIn: () => void;
  /** Ask before signing out (the active project when none is given). */
  requestSignOut: (projectId?: string) => void;
  cancelSignOut: () => void;
  createProject: (
    name: string,
    tenant: string,
    clientId: string,
    color: string
  ) => Promise<Project | null>;
  updateProject: (
    id: string,
    name: string,
    tenant: string,
    clientId: string,
    color: string
  ) => Promise<boolean>;
  deleteProject: (id: string) => Promise<void>;
  setActiveProject: (id: string) => void;
  requestProjectSwitch: (id: string) => void;
  loadEnvironments: () => Promise<void>;
  saveConnection: (url: string, name: string) => Promise<Connection | null>;
  deleteConnection: (id: string) => Promise<void>;
  updateConnection: (
    id: string,
    name: string,
    tag: string | null,
    color: string | null
  ) => Promise<boolean>;
  setActive: (id: string | null) => void;
  requestSwitch: (id: string) => void;
  confirmSwitchSave: () => void;
  confirmSwitchDiscard: () => void;
  cancelSwitch: () => void;

  setSql: (sql: string) => void;
  loadSql: (sql: string) => void;
  newTab: () => void;
  /** Closes the tab — after a confirmation when it has unsaved changes. */
  requestCloseTab: (id: string) => void;
  cancelCloseTab: () => void;
  /** Closes the tab waiting in `pendingCloseTabId`, dropping its unsaved edits. */
  confirmCloseTab: () => void;
  /** Closes right away, no questions (use `requestCloseTab` from the UI). */
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  saveActiveTab: () => void;
  saveAllTabs: () => void;
  setViewIndex: (i: number) => void;

  run: () => Promise<void>;
  clearHistory: () => void;
  confirmDml: () => void;
  cancelDml: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (clientId: string, tenant: string, workerThreads: number) => Promise<void>;
}

const initialTheme = readTheme();
applyTheme(initialTheme);
const initialProjectId = localStorage.getItem(LAST_PROJECT_KEY);
const initialActiveId = localStorage.getItem(LAST_ACTIVE_KEY);
const initialTabs = tabsForConnection(initialActiveId);

/** The tab the editor/results currently show. */
export const activeTabOf = (s: AppStore): QueryTab =>
  s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0];

/** The project currently in context. */
export const activeProjectOf = (s: AppStore): Project | null =>
  s.projects.find((p) => p.id === s.activeProjectId) ?? null;

export const useStore = create<AppStore>((set, get) => {
  const record = (
    entry: Omit<HistoryEntry, "id" | "at" | "connectionId" | "connectionName" | "host">
  ) => {
    const { connections, activeId, history } = get();
    const conn = connections.find((c) => c.id === activeId);
    if (!conn) return;
    const next: HistoryEntry[] = [
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        connectionId: conn.id,
        connectionName: conn.name,
        host: conn.host,
        ...entry,
      },
      ...history,
    ].slice(0, 300);
    saveHistory(next);
    set({ history: next });
  };

  const toast = (t: Omit<Toast, "id">) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({ toasts: [...s.toasts, { id, ...t }] }));
  };

  const patchActiveTab = (patch: Partial<QueryTab>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, ...patch } : t)) }));

  /** Applies whichever switch (project or environment) was waiting. */
  const applyPendingSwitch = () => {
    const { pendingProjectId, pendingSwitchId } = get();
    set({ pendingProjectId: null, pendingSwitchId: null });
    if (pendingProjectId) get().setActiveProject(pendingProjectId);
    else if (pendingSwitchId) get().setActive(pendingSwitchId);
  };

  return {
    theme: initialTheme,
    keybindings: loadKeybindings(),
    engineMode: readEngineMode(),

    projects: [],
    activeProjectId: initialProjectId,
    signingIn: false,
    authError: null,

    environments: [],
    loadingEnvs: false,
    envError: null,

    connections: [],
    activeId: initialActiveId,
    pendingSwitchId: null,
    pendingProjectId: null,
    pendingSignOutId: null,
    pendingCloseTabId: null,

    tabs: initialTabs,
    activeTabId: initialTabs[0].id,
    hasSelection: false,
    running: false,
    error: null,

    history: loadHistory(),

    pendingDml: null,
    dmlRunning: false,
    dmlProgress: null,

    toasts: [],

    settings: null,

    pushToast: toast,
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    toggleTheme: () => {
      const theme: Theme = get().theme === "dark" ? "light" : "dark";
      applyTheme(theme);
      set({ theme });
    },

    setKeybindings: (keybindings) => {
      saveKeybindings(keybindings);
      set({ keybindings });
    },

    setEngineMode: (engineMode) => {
      try {
        if (engineMode === "tds") localStorage.setItem(ENGINE_KEY, "1");
        else localStorage.removeItem(ENGINE_KEY);
        localStorage.removeItem("cds.engine");
      } catch {
        /* ignore */
      }
      set({ engineMode });
    },

    setHasSelection: (hasSelection) => set({ hasSelection }),

    init: async () => {
      try {
        const [projects, connections] = await Promise.all([
          api.listProjects(),
          api.listConnections(),
        ]);
        const storedProject = get().activeProjectId;
        const activeProjectId =
          storedProject && projects.some((p) => p.id === storedProject)
            ? storedProject
            : projects[0]?.id ?? null;

        const inProject = connections.filter((c) => c.projectId === activeProjectId);
        const current = get().activeId;
        const activeId =
          current && inProject.some((c) => c.id === current)
            ? current
            : inProject.find((c) => c.id === readConnByProject()[activeProjectId ?? ""])?.id ??
              inProject[0]?.id ??
              null;

        const patch: Partial<AppStore> = { projects, connections, activeProjectId, activeId };
        if (activeId !== current) {
          const tabs = tabsForConnection(activeId);
          patch.tabs = tabs;
          patch.activeTabId = tabs[0].id;
        }
        set(patch);
        if (activeProjectId) localStorage.setItem(LAST_PROJECT_KEY, activeProjectId);
        rememberConnForProject(activeProjectId, activeId);
      } catch (e) {
        set({ error: String(e) });
      }
    },

    signIn: async (projectId) => {
      const id = projectId ?? get().activeProjectId;
      if (!id) {
        toast({
          tone: "warning",
          title: "No project selected",
          body: "Create a project first, then sign in to it.",
        });
        return;
      }
      const attempt = ++signInAttempt;
      set({ signingIn: true, authError: null });
      try {
        const project = await api.signIn(id);
        set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
        if (id === get().activeProjectId) await get().loadEnvironments();
      } catch (e) {
        // Cancelling (or a newer attempt replacing this one) isn't a failure.
        const cancelled = String(e).includes(SIGN_IN_CANCELLED);
        if (!cancelled && attempt === signInAttempt) set({ authError: friendlyError(String(e)) });
      } finally {
        if (attempt === signInAttempt) set({ signingIn: false });
      }
    },

    cancelSignIn: () => {
      // Free the button right away; the backend stops waiting within ~0.25s.
      signInAttempt++;
      set({ signingIn: false, authError: null });
      api.cancelSignIn().catch(() => {});
    },

    signOut: async (projectId) => {
      const id = projectId ?? get().activeProjectId;
      if (!id) return;
      try {
        await api.signOut(id);
      } catch {
        /* ignore */
      }
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, username: null } : p)),
        environments: id === s.activeProjectId ? [] : s.environments,
        pendingSignOutId: s.pendingSignOutId === id ? null : s.pendingSignOutId,
      }));
    },

    requestSignOut: (projectId) => {
      const id = projectId ?? get().activeProjectId;
      if (id) set({ pendingSignOutId: id });
    },

    cancelSignOut: () => set({ pendingSignOutId: null }),

    createProject: async (name, tenant, clientId, color) => {
      try {
        const project = await api.createProject(name, tenant || null, clientId || null, color || null);
        set((s) => ({ projects: [...s.projects, project] }));
        get().setActiveProject(project.id);
        return project;
      } catch (e) {
        toast({ tone: "error", title: "Could not create project", body: friendlyError(String(e)) });
        return null;
      }
    },

    updateProject: async (id, name, tenant, clientId, color) => {
      try {
        const project = await api.updateProject(id, name, tenant || null, clientId || null, color || null);
        set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
        return true;
      } catch (e) {
        toast({ tone: "error", title: "Could not save project", body: friendlyError(String(e)) });
        return false;
      }
    },

    deleteProject: async (id) => {
      try {
        const removedConnections = await api.deleteProject(id);
        removedConnections.forEach(removeSavedTabs);
        rememberConnForProject(id, null);
        const projects = get().projects.filter((p) => p.id !== id);
        const connections = get().connections.filter((c) => c.projectId !== id);
        set({ projects, connections });
        if (get().activeProjectId === id) {
          const next = projects[0]?.id ?? null;
          if (next) get().setActiveProject(next);
          else {
            localStorage.removeItem(LAST_PROJECT_KEY);
            set({ activeProjectId: null, environments: [] });
            get().setActive(null);
          }
        }
      } catch (e) {
        toast({ tone: "error", title: "Could not delete project", body: friendlyError(String(e)) });
      }
    },

    setActiveProject: (id) => {
      const { connections, activeProjectId } = get();
      if (id === activeProjectId) return;
      const inProject = connections.filter((c) => c.projectId === id);
      const remembered = readConnByProject()[id];
      const nextConn =
        inProject.find((c) => c.id === remembered)?.id ?? inProject[0]?.id ?? null;
      localStorage.setItem(LAST_PROJECT_KEY, id);
      set({ activeProjectId: id, environments: [], envError: null, authError: null });
      get().setActive(nextConn);
    },

    requestProjectSwitch: (id) => {
      if (id === get().activeProjectId) return;
      // A project switch also changes the environment queries run against,
      // so always confirm — unless nothing is open yet to leave.
      if (get().activeId === null && !get().tabs.some(tabDirty)) {
        get().setActiveProject(id);
        return;
      }
      set({ pendingProjectId: id, pendingSwitchId: null });
    },

    loadEnvironments: async () => {
      const projectId = get().activeProjectId;
      if (!projectId) return;
      set({ loadingEnvs: true, envError: null });
      try {
        const environments = await api.listEnvironments(projectId);
        set({ environments });
      } catch (e) {
        set({ envError: friendlyError(String(e)) });
      } finally {
        set({ loadingEnvs: false });
      }
    },

    saveConnection: async (url, name) => {
      const projectId = get().activeProjectId;
      if (!projectId) {
        toast({
          tone: "warning",
          title: "No project selected",
          body: "Create a project before adding environments.",
        });
        return null;
      }
      try {
        const conn = await api.saveConnection(projectId, url, name);
        const connections = await api.listConnections();
        set({ connections });
        get().setActive(conn.id);
        return conn;
      } catch (e) {
        set({ error: String(e) });
        return null;
      }
    },

    deleteConnection: async (id) => {
      try {
        await api.deleteConnection(id);
        removeSavedTabs(id);
        const connections = await api.listConnections();
        set({ connections });
        if (get().activeId === id) get().setActive(connections[0]?.id ?? null);
      } catch (e) {
        set({ error: String(e) });
      }
    },

    updateConnection: async (id, name, tag, color) => {
      try {
        const updated = await api.updateConnection(id, name, tag, color);
        set({ connections: get().connections.map((c) => (c.id === id ? updated : c)) });
        return true;
      } catch (e) {
        set({ error: String(e) });
        return false;
      }
    },

    setActive: (id) => {
      const tabs = tabsForConnection(id);
      set({ activeId: id, tabs, activeTabId: tabs[0].id, hasSelection: false });
      if (id) localStorage.setItem(LAST_ACTIVE_KEY, id);
      else localStorage.removeItem(LAST_ACTIVE_KEY);
      rememberConnForProject(get().activeProjectId, id);
    },

    requestSwitch: (id) => {
      const current = get().activeId;
      if (id === current) return;
      // Always confirm, so the next query can't silently hit another
      // environment (e.g. PROD). Picking the first one needs no question.
      if (current === null) {
        get().setActive(id);
        return;
      }
      set({ pendingSwitchId: id, pendingProjectId: null });
    },

    confirmSwitchSave: () => {
      get().saveAllTabs();
      applyPendingSwitch();
    },

    confirmSwitchDiscard: () => {
      // Drop unsaved edits: revert every tab to its saved snapshot.
      set((s) => ({ tabs: s.tabs.map((t) => ({ ...t, sql: t.savedSql })) }));
      persistTabs(get().activeId, get().tabs);
      applyPendingSwitch();
    },

    cancelSwitch: () => set({ pendingSwitchId: null, pendingProjectId: null }),

    setSql: (sql) => {
      patchActiveTab({ sql });
      persistTabs(get().activeId, get().tabs);
    },

    loadSql: (sql) => {
      const { tabs } = get();
      if (tabs.length < MAX_TABS) {
        const tab = freshTab(sql); // loaded query starts as a clean baseline
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      } else {
        patchActiveTab({ sql, savedSql: sql, outcomes: [], viewIndex: 0 });
      }
      navigate(ROUTES.query);
      persistTabs(get().activeId, get().tabs);
    },

    newTab: () => {
      if (get().tabs.length >= MAX_TABS) {
        toast({
          tone: "warning",
          title: "Tab limit reached",
          body: `You can open up to ${MAX_TABS} query tabs.`,
        });
        return;
      }
      const tab = freshTab();
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, hasSelection: false }));
      persistTabs(get().activeId, get().tabs);
    },

    requestCloseTab: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab && tabDirty(tab)) set({ pendingCloseTabId: id });
      else get().closeTab(id);
    },

    cancelCloseTab: () => set({ pendingCloseTabId: null }),

    confirmCloseTab: () => {
      const id = get().pendingCloseTabId;
      set({ pendingCloseTabId: null });
      if (id) get().closeTab(id);
    },

    closeTab: (id) => {
      const { tabs, activeTabId } = get();
      if (tabs.length <= 1) {
        const fresh = freshTab();
        set({ tabs: [fresh], activeTabId: fresh.id });
        persistTabs(get().activeId, get().tabs);
        return;
      }
      const idx = tabs.findIndex((t) => t.id === id);
      const next = tabs.filter((t) => t.id !== id);
      let nextActive = activeTabId;
      if (activeTabId === id) nextActive = (next[idx] ?? next[idx - 1] ?? next[0]).id;
      set({ tabs: next, activeTabId: nextActive });
      persistTabs(get().activeId, get().tabs);
    },

    setActiveTab: (id) => set({ activeTabId: id, hasSelection: false }),

    renameTab: (id, title) => {
      const name = title.trim();
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, title: name || undefined } : t)),
      }));
      persistTabs(get().activeId, get().tabs);
    },

    saveActiveTab: () => {
      const id = get().activeTabId;
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, savedSql: t.sql } : t)) }));
      persistTabs(get().activeId, get().tabs);
    },

    saveAllTabs: () => {
      set((s) => ({ tabs: s.tabs.map((t) => ({ ...t, savedSql: t.sql })) }));
      persistTabs(get().activeId, get().tabs);
    },

    setViewIndex: (viewIndex) => patchActiveTab({ viewIndex }),

    run: async () => {
      const startState = get();
      if (startState.running) return;
      const connectionId = startState.activeId;
      if (!connectionId) {
        navigate(ROUTES.query);
        toast({ tone: "warning", title: "No connection selected", body: "Pick a connection on the left first." });
        return;
      }

      const tab = activeTabOf(startState);
      const tabId = tab.id;
      const selection = getSelectedSql();
      const source = selection.trim() ? selection : tab.sql;
      const statements = splitStatements(source);
      if (statements.length === 0) return;

      const patchTab = (patch: Partial<QueryTab>) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) }));
      const patchOutcome = (i: number, patch: Partial<StatementOutcome>) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? { ...t, outcomes: t.outcomes.map((o) => (o.index === i ? { ...o, ...patch } : o)) }
              : t
          ),
        }));

      patchTab({
        outcomes: statements.map((sql, index) => ({
          index,
          sql,
          status: "pending" as OutcomeStatus,
          result: null,
          dmlResult: null,
          error: null,
          ms: 0,
        })),
        viewIndex: 0,
      });
      set({ running: true, error: null });
      navigate(ROUTES.query);

      let stopped = false;
      let firstError = -1;

      for (let i = 0; i < statements.length && !stopped; i++) {
        const stmt = statements[i];
        patchOutcome(i, { status: "running" });
        patchTab({ viewIndex: i });
        const started = performance.now();

        try {
          if (isWriteStatement(stmt)) {
            const preview = await api.prepareDml(connectionId, stmt);
            const proceed = await new Promise<boolean>((resolve) => {
              confirmResolver = resolve;
              set({ pendingDml: preview });
            });
            confirmResolver = null;
            if (!proceed) {
              set({ pendingDml: null });
              patchOutcome(i, { status: "cancelled", ms: Math.round(performance.now() - started) });
              stopped = true;
              break;
            }
            const unlisten = await listen<DmlProgress>("dml-progress", (e) =>
              set({ dmlProgress: e.payload })
            );
            set({ dmlRunning: true, dmlProgress: { done: 0, total: preview.count, threads: 1, paused: 0 } });
            try {
              const dmlResult = await api.executeDml(preview.planId);
              const failed = dmlResult.failed > 0 && dmlResult.succeeded === 0;
              patchOutcome(i, {
                status: failed ? "error" : "write",
                dmlResult,
                ms: dmlResult.elapsedMs,
              });
              if (failed) {
                if (firstError < 0) firstError = i;
                toast({
                  tone: "error",
                  title: `${preview.kind.toUpperCase()} failed`,
                  body: dmlResult.errors[0]
                    ? friendlyError(dmlResult.errors[0])
                    : "No records were changed.",
                });
              }
              record({
                sql: stmt,
                status: failed ? "error" : "write",
                rows: dmlResult.succeeded,
                ms: dmlResult.elapsedMs,
                error: dmlResult.errors[0],
              });
            } finally {
              unlisten();
              set({ dmlRunning: false, dmlProgress: null, pendingDml: null });
            }
          } else {
            // Rows stream in page by page; the grid shows them while the
            // rest is still downloading.
            const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const live: { r: QueryResult | null } = { r: null };
            const unlisten = await listen<QueryPage>("query-page", (e) => {
              const p = e.payload;
              if (p.requestId !== requestId) return;
              // A fallback to another engine starts the result over.
              let r = live.r;
              if (!r || r.engine !== p.engine) {
                r = { columns: p.columns, rows: [], rowCount: 0, elapsedMs: 0, truncated: false, engine: p.engine };
              }
              r = { ...r, rows: r.rows.concat(p.rows), rowCount: r.rowCount + p.rows.length };
              live.r = r;
              patchOutcome(i, { result: r });
            });
            let result: QueryResult;
            try {
              result = await api.runQuery(connectionId, stmt, 50000, startState.engineMode, requestId);
            } finally {
              unlisten();
            }
            if (result.streamed) {
              const rows = live.r && live.r.engine === result.engine ? live.r.rows : [];
              result = { ...result, rows, rowCount: rows.length, requestId };
            }
            const ms = Math.round(performance.now() - started);
            patchOutcome(i, { status: "ok", result, ms });
            record({ sql: stmt, status: "ok", rows: result.rowCount, ms });
          }
        } catch (e) {
          const ms = Math.round(performance.now() - started);
          const message = friendlyError(String(e));
          patchOutcome(i, { status: "error", error: message, ms });
          record({ sql: stmt, status: "error", error: message, ms });
          toast({
            tone: "error",
            title: statements.length > 1 ? `Statement #${i + 1} failed` : "Query failed",
            body: message,
          });
          if (firstError < 0) firstError = i;
          stopped = true;
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    outcomes: t.outcomes.map((o) =>
                      o.index > i && o.status === "pending" ? { ...o, status: "cancelled" } : o
                    ),
                  }
                : t
            ),
          }));
        }
      }

      set({ running: false });
      patchTab({ viewIndex: firstError >= 0 ? firstError : Math.max(0, statements.length - 1) });
    },

    clearHistory: () => {
      saveHistory([]);
      set({ history: [] });
    },

    confirmDml: () => {
      const resolve = confirmResolver;
      confirmResolver = null;
      resolve?.(true);
    },

    cancelDml: async () => {
      const { pendingDml } = get();
      const resolve = confirmResolver;
      confirmResolver = null;
      set({ pendingDml: null });
      resolve?.(false);
      if (pendingDml) {
        try {
          await api.discardDml(pendingDml.planId);
        } catch {
          /* plan already gone */
        }
      }
    },

    loadSettings: async () => {
      try {
        const settings = await api.getSettings();
        set({ settings });
      } catch {
        /* ignore */
      }
    },

    saveSettings: async (clientId, tenant, workerThreads) => {
      try {
        const settings = await api.setSettings(clientId, tenant, workerThreads);
        set({ settings });
      } catch (e) {
        set({ error: String(e) });
      }
    },
  };
});

export function activeConnection(): Connection | null {
  const { connections, activeId } = useStore.getState();
  return connections.find((c) => c.id === activeId) ?? null;
}

/** Connections belonging to the project in context. */
export function projectConnections(s: AppStore): Connection[] {
  return s.connections.filter((c) => c.projectId === s.activeProjectId);
}

export { DEFAULT_KEYS };
