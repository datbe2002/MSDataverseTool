// The REST builder's state: request tabs per environment (each with its
// request and latest run), running read requests and reading more pages.
// Writes (create, update, delete, associate, action) only produce code for now.
import { create } from "zustand";
import { api } from "../api";
import { useStore } from "../store";
import { friendlyError } from "./errors";
import { createEnvCache } from "./envCache";
import { useSchema } from "./schema";
import { flatten, parseFetch, withPage, type FlatResult } from "./fetchXml";
import { blankRequest, buildRequest, isWrite, kindInfo, newId, readablePath, readPrefer, type RestKind, type RestRequest } from "./restModel";
import type { RestTable } from "../types";

/** Most rows "Load all" reads, like the SQL tool's cap. */
export const ROW_CAP = 50_000;

/** Most tabs per environment. */
export const MAX_TABS = 10;

const TABS_KEY = "cds.rest.tabs";
const FORMATTED_KEY = "cds.rest.formatted";
/** The FetchXML tool's tabs, turned into FetchXML requests the first time. */
const OLD_FETCH_TABS = "cds.fetchxml.tabs";
const OLD_FETCH_KEYS = [OLD_FETCH_TABS, "cds.fetchxml.recent", "cds.fetchxml.builder", "cds.fetchxml.paneWidths", "cds.fetchxml.formatted"];

/** Table metadata for the builder, read once per environment + table. */
export const restTables = createEnvCache<RestTable>((connId, table) => api.restTable(connId, table));

export interface RestRun {
  status: "running" | "ok" | "error";
  kind: RestKind;
  error?: string;
  /** XML error position (FetchXML). */
  line?: number;
  column?: number;
  /** HTTP status of the last answer. */
  httpStatus?: number;
  /** The request as sent (readable). */
  path: string;
  /** Single record / function result / error body. */
  body: unknown;
  /** Rows (Retrieve multiple, FetchXML; Retrieve = the one record). */
  records: Record<string, unknown>[] | null;
  expected: string[];
  flat: FlatResult;
  /** `@odata.count`, when asked for. */
  total?: number;
  /** Retrieve multiple: the next page's link. */
  next: string | null;
  /** FetchXML paging. */
  fetch?: { xml: string; entity: string; page: number; cookie: string | null; count: number | null };
  more: boolean;
  loadingMore: boolean;
  capped: boolean;
  ms: number;
  requests: number;
  bytes: number;
  throttled: number;
}

export interface RestTab {
  id: string;
  /** Name the user gave the tab. */
  title?: string;
  request: RestRequest;
}

export interface Workspace {
  tabs: RestTab[];
  active: string;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

/** A request saved by an older version: fields added since get their defaults. */
const withDefaults = (r: Partial<RestRequest>): RestRequest => ({ ...blankRequest(r.kind ?? "retrieveMultiple", r.table ?? "account"), ...r });

function loadWorkspaces(): Record<string, Workspace> {
  const saved = load<Record<string, Workspace> | null>(TABS_KEY, null);
  if (saved) {
    for (const ws of Object.values(saved)) ws.tabs = ws.tabs.map((t) => ({ ...t, request: withDefaults(t.request) }));
    return saved;
  }
  // The FetchXML tool's tabs carry over as FetchXML requests.
  const old = load<Record<string, { tabs: { id: string; xml: string; title?: string }[]; active: string }>>(OLD_FETCH_TABS, {});
  const out: Record<string, Workspace> = {};
  for (const [connId, ws] of Object.entries(old)) {
    const tabs = (ws.tabs ?? [])
      .filter((t) => typeof t.xml === "string" && t.xml.trim())
      .slice(0, MAX_TABS)
      .map((t) => {
        const entity = t.xml.match(/<entity\s[^>]*name\s*=\s*["']([^"']+)["']/)?.[1] ?? "account";
        return { id: t.id, title: t.title, request: { ...blankRequest("fetchXml", entity), fetchXml: t.xml } };
      });
    if (tabs.length) out[connId] = { tabs, active: tabs.some((t) => t.id === ws.active) ? ws.active : tabs[0].id };
  }
  if (Object.keys(out).length) save(TABS_KEY, out);
  try {
    for (const k of OLD_FETCH_KEYS) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  return out;
}

/** An environment's tabs before it has any: the same object every call, so selectors stay stable. */
const fresh = new Map<string, Workspace>();
function freshWorkspace(connId: string): Workspace {
  let ws = fresh.get(connId);
  if (!ws) {
    const id = newId();
    ws = { tabs: [{ id, request: blankRequest() }], active: id };
    fresh.set(connId, ws);
  }
  return ws;
}

const EMPTY: FlatResult = { columns: [], raw: [], display: [] };

interface RestState {
  workspaces: Record<string, Workspace>;
  /** Latest run by tab id (kept while the app runs). */
  runs: Record<string, RestRun | undefined>;
  /** Grid shows formatted values (lookup names, choice labels) instead of raw ones. */
  formatted: boolean;
  /** Changes the tab's request. */
  update: (connId: string, tabId: string, patch: Partial<RestRequest>) => void;
  /** Opens a tab (a blank Retrieve multiple unless `request` is given); null at MAX_TABS. */
  newTab: (connId: string, request?: RestRequest) => string | null;
  closeTab: (connId: string, tabId: string) => void;
  selectTab: (connId: string, tabId: string) => void;
  renameTab: (connId: string, tabId: string, title: string) => void;
  setFormatted: (on: boolean) => void;
  /** Sends the active tab's request (reads only). */
  run: () => Promise<void>;
  /** Next page, or every page up to ROW_CAP. */
  loadMore: (all: boolean) => Promise<void>;
  /** Stops "Load all" after the page in flight. */
  stop: () => void;
}

export const workspaceOf = (s: RestState, connId: string): Workspace => s.workspaces[connId] ?? freshWorkspace(connId);

export const activeTabOf = (s: RestState, connId: string): RestTab => {
  const ws = workspaceOf(s, connId);
  return ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
};

export const activeRunOf = (s: RestState, connId: string | null): RestRun | undefined => (connId ? s.runs[activeTabOf(s, connId).id] : undefined);

/** The tab's name: given, else the kind and table / operation. */
export function tabLabel(tab: RestTab): string {
  if (tab.title?.trim()) return tab.title.trim();
  const r = tab.request;
  const what =
    r.kind === "function" || r.kind === "action"
      ? r.operation.trim()
      : r.kind === "fetchXml"
      ? r.fetchXml.match(/<entity\s[^>]*name\s*=\s*["']([^"']+)["']/)?.[1] ?? ""
      : r.table.trim();
  return what ? `${kindInfo(r.kind).label} · ${what}` : kindInfo(r.kind).label;
}

/** Per tab, bumped by every run / stop so an older read stops writing. */
const generations: Record<string, number> = {};
const bump = (tabId: string) => (generations[tabId] = (generations[tabId] ?? 0) + 1);
const current = (tabId: string, gen: number) => generations[tabId] === gen;

/** The error text of a Web API error body (the status shows next to it). */
function errorMessage(body: unknown, text: string | undefined): string {
  const msg = (body as { error?: { message?: string } } | null)?.error?.message;
  return msg ?? text ?? "The request failed.";
}

/** The metadata the builder has for the request (loaded by the view), for building it outside React. */
export function buildContext(connId: string, table: string) {
  const data = restTables.useStore.getState().data;
  const metaOf = (t: string) => data[`${connId}|${t.toLowerCase()}`];
  const tables = useSchema.getState().tables[connId];
  return {
    meta: table ? metaOf(table) : undefined,
    metaOf,
    entitySetOf: (t: string) => metaOf(t)?.entitySet || tables?.find((x) => x.logicalName === t.toLowerCase())?.entitySetName || undefined,
  };
}

export const useRest = create<RestState>((set, get) => {
  const patchRun = (tabId: string, patch: Partial<RestRun>) =>
    set((s) => {
      const existing = s.runs[tabId];
      return existing ? { runs: { ...s.runs, [tabId]: { ...existing, ...patch } } } : {};
    });

  const writeWorkspace = (connId: string, ws: Workspace) => {
    const workspaces = { ...get().workspaces, [connId]: ws };
    fresh.delete(connId);
    set({ workspaces });
    save(TABS_KEY, workspaces);
  };

  const activeContext = () => {
    const connId = useStore.getState().activeId;
    return connId ? { connId, tab: activeTabOf(get(), connId) } : null;
  };

  /** Reads the table's metadata when the request needs it and it isn't loaded yet. */
  const ensureMeta = async (connId: string, req: RestRequest) => {
    const tables = new Set<string>();
    if (req.table.trim() && req.kind !== "fetchXml") tables.add(req.table.trim().toLowerCase());
    for (const p of req.params) if (p.type === "record" && p.table) tables.add(p.table.toLowerCase());
    await useSchema.getState().loadTables(connId);
    await Promise.all([...tables].map((t) => restTables.load(connId, t).catch(() => undefined)));
  };

  return {
    workspaces: loadWorkspaces(),
    runs: {},
    formatted: load<boolean>(FORMATTED_KEY, true),

    update: (connId, tabId, patch) => {
      const ws = workspaceOf(get(), connId);
      if (!ws.tabs.some((t) => t.id === tabId)) return;
      writeWorkspace(connId, { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, request: { ...t.request, ...patch } } : t)) });
    },

    newTab: (connId, request) => {
      const ws = workspaceOf(get(), connId);
      if (ws.tabs.length >= MAX_TABS) return null;
      const active = activeTabOf(get(), connId).request;
      const tab: RestTab = { id: newId(), request: request ?? blankRequest("retrieveMultiple", active.table || "account") };
      writeWorkspace(connId, { tabs: [...ws.tabs, tab], active: tab.id });
      return tab.id;
    },

    closeTab: (connId, tabId) => {
      const ws = workspaceOf(get(), connId);
      const i = ws.tabs.findIndex((t) => t.id === tabId);
      if (i === -1) return;
      bump(tabId);
      const tabs = ws.tabs.filter((t) => t.id !== tabId);
      if (tabs.length === 0) tabs.push({ id: newId(), request: blankRequest() });
      const active = ws.active === tabId ? tabs[Math.min(i, tabs.length - 1)].id : ws.active;
      writeWorkspace(connId, { tabs, active });
      set((s) => {
        const { [tabId]: _gone, ...runs } = s.runs;
        return { runs };
      });
    },

    selectTab: (connId, tabId) => {
      const ws = workspaceOf(get(), connId);
      if (ws.active !== tabId && ws.tabs.some((t) => t.id === tabId)) writeWorkspace(connId, { ...ws, active: tabId });
    },

    renameTab: (connId, tabId, title) => {
      const ws = workspaceOf(get(), connId);
      writeWorkspace(connId, { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, title: title.trim() || undefined } : t)) });
    },

    setFormatted: (formatted) => {
      set({ formatted });
      save(FORMATTED_KEY, formatted);
    },

    run: async () => {
      const app = useStore.getState();
      const ctx = activeContext();
      if (!ctx) {
        app.pushToast({ tone: "warning", title: "No environment selected", body: "Pick an environment at the top first." });
        return;
      }
      const { connId, tab } = ctx;
      const req = tab.request;
      const tabId = tab.id;
      if (isWrite(req.kind)) {
        app.pushToast({ tone: "info", title: `${kindInfo(req.kind).label} isn't sent from here yet`, body: "Copy the code and run it where you need it." });
        return;
      }
      const prev = get().runs[tabId];
      if (prev?.status === "running" || prev?.loadingMore) return;
      const gen = bump(tabId);
      const base: RestRun = {
        status: "running",
        kind: req.kind,
        path: "",
        body: null,
        records: null,
        expected: [],
        flat: EMPTY,
        next: null,
        more: false,
        loadingMore: false,
        capped: false,
        ms: 0,
        requests: 0,
        bytes: 0,
        throttled: 0,
      };
      set((s) => ({ runs: { ...s.runs, [tabId]: base } }));
      const started = performance.now();
      try {
        if (req.kind === "fetchXml") {
          const parsed = parseFetch(req.fetchXml);
          if (!parsed.ok) {
            patchRun(tabId, { status: "error", error: parsed.error, line: parsed.line, column: parsed.column });
            return;
          }
          const { fetch } = parsed;
          const page = await api.runFetchXml(connId, fetch.entity, req.fetchXml);
          if (!current(tabId, gen)) return;
          const pageable = fetch.top === null && !fetch.aggregate;
          patchRun(tabId, {
            status: "ok",
            httpStatus: 200,
            path: `${fetch.entity} (FetchXML)`,
            records: page.records,
            expected: fetch.columns,
            flat: flatten(page.records, fetch.columns),
            fetch: { xml: req.fetchXml, entity: fetch.entity, page: fetch.page ?? 1, cookie: page.pagingCookie, count: fetch.count ?? (page.moreRecords ? page.records.length : null) },
            more: pageable && page.moreRecords,
            ms: performance.now() - started,
            requests: 1,
            bytes: page.bytes,
            throttled: page.throttled,
          });
          return;
        }
        await ensureMeta(connId, req);
        if (!current(tabId, gen)) return;
        const built = buildRequest(req, buildContext(connId, req.table));
        if (built.problems.length) {
          patchRun(tabId, { status: "error", error: built.problems.join(" "), ms: 0 });
          return;
        }
        const path = readablePath(built);
        const resp = await api.webApiGet(connId, path, readPrefer(req));
        if (!current(tabId, gen)) return;
        const timing = { ms: performance.now() - started, requests: 1, bytes: resp.bytes, throttled: resp.throttled, httpStatus: resp.status, path };
        if (!resp.ok) {
          patchRun(tabId, { status: "error", error: errorMessage(resp.body, resp.text), body: resp.body ?? resp.text ?? null, ...timing });
          return;
        }
        const body = resp.body as Record<string, unknown> | null;
        if (req.kind === "retrieveMultiple") {
          const records = (Array.isArray(body?.value) ? body!.value : []) as Record<string, unknown>[];
          const next = typeof body?.["@odata.nextLink"] === "string" ? (body["@odata.nextLink"] as string) : null;
          const total = typeof body?.["@odata.count"] === "number" ? (body["@odata.count"] as number) : undefined;
          patchRun(tabId, { status: "ok", body, records, expected: req.columns, flat: flatten(records, req.columns), next, more: !!next, total, ...timing });
        } else if (req.kind === "retrieve" && body) {
          const records = [body];
          patchRun(tabId, { status: "ok", body, records, expected: req.columns, flat: flatten(records, req.columns), ...timing });
        } else {
          patchRun(tabId, { status: "ok", body, ...timing });
        }
      } catch (e) {
        if (!current(tabId, gen)) return;
        patchRun(tabId, { status: "error", error: friendlyError(String(e)), ms: performance.now() - started });
      }
    },

    loadMore: async (all) => {
      const ctx = activeContext();
      if (!ctx) return;
      const { connId } = ctx;
      const tabId = ctx.tab.id;
      const first = get().runs[tabId];
      if (!first || first.status !== "ok" || !first.more || first.loadingMore) return;
      const gen = bump(tabId);
      patchRun(tabId, { loadingMore: true });
      const prefer = readPrefer(ctx.tab.request);
      try {
        for (;;) {
          const run = get().runs[tabId];
          if (!run || !current(tabId, gen)) return;
          const started = performance.now();
          let records: Record<string, unknown>[];
          let more: boolean;
          const patch: Partial<RestRun> = {};
          if (run.fetch) {
            const xml = withPage(run.fetch.xml, run.fetch.page + 1, run.fetch.cookie, run.fetch.count);
            const page = await api.runFetchXml(connId, run.fetch.entity, xml);
            if (!current(tabId, gen)) return;
            records = page.records;
            more = page.moreRecords;
            patch.fetch = { ...run.fetch, page: run.fetch.page + 1, cookie: page.pagingCookie };
            patch.bytes = run.bytes + page.bytes;
            patch.throttled = run.throttled + page.throttled;
          } else {
            if (!run.next) return;
            const resp = await api.webApiGet(connId, run.next, prefer);
            if (!current(tabId, gen)) return;
            if (!resp.ok) throw new Error(`${resp.status}: ${errorMessage(resp.body, resp.text)}`);
            const body = resp.body as Record<string, unknown> | null;
            records = (Array.isArray(body?.value) ? body!.value : []) as Record<string, unknown>[];
            patch.next = typeof body?.["@odata.nextLink"] === "string" ? (body["@odata.nextLink"] as string) : null;
            more = !!patch.next;
            patch.bytes = run.bytes + resp.bytes;
            patch.throttled = run.throttled + resp.throttled;
          }
          const all_ = (run.records ?? []).concat(records);
          const capped = all_.length >= ROW_CAP && more;
          patchRun(tabId, {
            ...patch,
            records: all_,
            flat: flatten(all_, run.expected),
            more,
            capped,
            ms: run.ms + (performance.now() - started),
            requests: run.requests + 1,
          });
          if (!all || !more || capped) break;
        }
      } catch (e) {
        if (!current(tabId, gen)) return;
        useStore.getState().pushToast({ tone: "error", title: "Could not read the next page", body: friendlyError(String(e)) });
      } finally {
        if (current(tabId, gen)) patchRun(tabId, { loadingMore: false });
      }
    },

    stop: () => {
      const ctx = activeContext();
      if (!ctx || !get().runs[ctx.tab.id]?.loadingMore) return;
      bump(ctx.tab.id);
      patchRun(ctx.tab.id, { loadingMore: false });
    },
  };
});
