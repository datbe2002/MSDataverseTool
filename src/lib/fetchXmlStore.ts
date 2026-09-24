// The FetchXML tool's state: query tabs per environment (each with its
// query, where it came from, and its latest run), and how to read the
// next page of a run.
import { create } from "zustand";
import { api } from "../api";
import { useStore } from "../store";
import { friendlyError } from "./errors";
import { DEFAULT_FETCH, flatten, parseFetch, withPage, type FlatResult } from "./fetchXml";
import { aggregateCountQuery, keyOnlyQuery, tooManyToAggregate } from "./fetchCount";

/** Most rows "Load all" reads, like the SQL tool's cap. */
export const FETCH_ROW_CAP = 50_000;

/** Most tabs per environment. */
export const MAX_FETCH_TABS = 10;

const TABS_KEY = "cds.fetchxml.tabs";
/** Before tabs: one query and source per environment (migrated into a first tab). */
const OLD_DRAFTS_KEY = "cds.fetchxml.drafts";
const OLD_SOURCES_KEY = "cds.fetchxml.sources";
const RECENT_KEY = "cds.fetchxml.recent";
const FORMATTED_KEY = "cds.fetchxml.formatted";
const RECENT_MAX = 30;

export interface FetchRun {
  status: "running" | "ok" | "error";
  error?: string;
  /** Where the XML error is, when the query didn't parse. */
  line?: number;
  column?: number;
  /** The query as it ran (page 1). */
  xml: string;
  entity: string;
  expected: string[];
  records: Record<string, unknown>[];
  flat: FlatResult;
  /** Last page read. */
  page: number;
  /** Page size for the next pages (the query's `count`, else the first page's size). */
  count: number | null;
  cookie: string | null;
  more: boolean;
  /** `top` and aggregate queries come back in one piece. */
  pageable: boolean;
  /** Reading more pages right now. */
  loadingMore: boolean;
  /** Stopped at FETCH_ROW_CAP. */
  capped: boolean;
  ms: number;
  requests: number;
  bytes: number;
  throttled: number;
}

/** Counting a tab's rows ("Count rows"). */
export interface FetchCount {
  status: "running" | "done" | "error" | "stopped";
  /** Rows counted (so far, while paging). */
  value: number;
  /** One aggregate request, or paging through the rows' keys (more than 50,000 rows / distinct). */
  method: "aggregate" | "pages";
  /** The query counted: the count is shown only while the tab still has it. */
  xml: string;
  error?: string;
  ms: number;
}

/** Where a tab's query came from; `saved` = the query as opened / last saved. */
export type FetchSource =
  | { kind: "view"; name: string; personal: boolean; table: string; saved: string }
  | { kind: "file"; name: string; path: string; saved: string };

export interface FetchTab {
  id: string;
  xml: string;
  /** Name the user gave the tab; else it's named after its source or table. */
  title?: string;
  source?: FetchSource;
}

export interface Workspace {
  tabs: FetchTab[];
  active: string;
}

export interface RecentFetch {
  id: string;
  xml: string;
  entity: string;
  connectionName: string;
  rows: number;
  at: number;
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

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function loadWorkspaces(): Record<string, Workspace> {
  const saved = load<Record<string, Workspace> | null>(TABS_KEY, null);
  if (saved) return saved;
  // One query per environment → a first tab each.
  const drafts = load<Record<string, string>>(OLD_DRAFTS_KEY, {});
  const sources = load<Record<string, FetchSource | undefined>>(OLD_SOURCES_KEY, {});
  const out: Record<string, Workspace> = {};
  for (const [connId, xml] of Object.entries(drafts)) {
    const id = newId();
    const source = sources[connId];
    out[connId] = {
      // Views had no `saved` before; a file's is kept.
      tabs: [{ id, xml, source: source ? ({ ...source, saved: (source as { saved?: string }).saved ?? xml } as FetchSource) : undefined }],
      active: id,
    };
  }
  if (Object.keys(out).length) save(TABS_KEY, out);
  try {
    localStorage.removeItem(OLD_DRAFTS_KEY);
    localStorage.removeItem(OLD_SOURCES_KEY);
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
    ws = { tabs: [{ id, xml: DEFAULT_FETCH }], active: id };
    fresh.set(connId, ws);
  }
  return ws;
}

const EMPTY: FlatResult = { columns: [], raw: [], display: [] };

interface FetchXmlState {
  workspaces: Record<string, Workspace>;
  /** Latest run by tab id (kept while the app runs). */
  runs: Record<string, FetchRun | undefined>;
  /** Latest row count by tab id. */
  counts: Record<string, FetchCount | undefined>;
  recent: RecentFetch[];
  /** Show formatted values (lookup names, choice labels) instead of raw ones. */
  formatted: boolean;
  setDraft: (connId: string, tabId: string, xml: string) => void;
  setSource: (connId: string, tabId: string, source: FetchSource | null) => void;
  /** Opens a tab (the sample query unless `xml` is given); null when there are MAX_FETCH_TABS already. */
  newTab: (connId: string, xml?: string, source?: FetchSource) => string | null;
  closeTab: (connId: string, tabId: string) => void;
  selectTab: (connId: string, tabId: string) => void;
  renameTab: (connId: string, tabId: string, title: string) => void;
  /** Writes the active tab's query to its file (asks where when it has none, or with `as`). */
  save: (as?: boolean) => Promise<void>;
  setFormatted: (on: boolean) => void;
  /** Runs the active tab's query. */
  run: () => Promise<void>;
  /** Next page, or every page up to FETCH_ROW_CAP. */
  loadMore: (all: boolean) => Promise<void>;
  /** Stops "Load all" after the page in flight. */
  stop: () => void;
  /** Counts the rows the active tab's query matches. */
  countRows: () => Promise<void>;
  stopCount: () => void;
}

export const workspaceOf = (s: FetchXmlState, connId: string): Workspace => s.workspaces[connId] ?? freshWorkspace(connId);

export const activeTabOf = (s: FetchXmlState, connId: string): FetchTab => {
  const ws = workspaceOf(s, connId);
  return ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
};

/** The active tab's latest run in the environment. */
export const activeRunOf = (s: FetchXmlState, connId: string | null): FetchRun | undefined =>
  connId ? s.runs[activeTabOf(s, connId).id] : undefined;

/** The query differs from the file / view it came from. */
export const sourceChanged = (tab: FetchTab) => !!tab.source && tab.source.saved !== tab.xml;

/** Closing the tab would lose work: edits to a file / view, or a query of its own. */
export const tabHasWork = (tab: FetchTab) =>
  tab.source ? sourceChanged(tab) : tab.xml.trim() !== "" && tab.xml.trim() !== DEFAULT_FETCH.trim();

/** A tab nothing would be lost from by putting another query in it. */
export const tabIsBlank = (tab: FetchTab) => !tab.source && !tabHasWork(tab);

/** The tab's name: given, else its file / view, else its table. */
export function tabLabel(tab: FetchTab): string {
  if (tab.title?.trim()) return tab.title.trim();
  if (tab.source) return tab.source.kind === "file" ? tab.source.name.replace(/\.xml$/i, "") : tab.source.name;
  const entity = tab.xml.match(/<entity\s[^>]*name\s*=\s*["']([^"']+)["']/)?.[1];
  return entity ? entity : "New query";
}

/** Per tab, bumped by every run / stop so an older read stops writing. */
const generations: Record<string, number> = {};
const bump = (tabId: string) => (generations[tabId] = (generations[tabId] ?? 0) + 1);
const current = (tabId: string, gen: number) => generations[tabId] === gen;

export const useFetchXml = create<FetchXmlState>((set, get) => {
  const patchRun = (tabId: string, patch: Partial<FetchRun>) =>
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

  const patchTab = (connId: string, tabId: string, patch: Partial<FetchTab>) => {
    const ws = workspaceOf(get(), connId);
    if (!ws.tabs.some((t) => t.id === tabId)) return;
    writeWorkspace(connId, { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) });
  };

  /** The active environment and tab, for the actions that run from anywhere (keys, TopBar). */
  const activeContext = () => {
    const connId = useStore.getState().activeId;
    return connId ? { connId, tab: activeTabOf(get(), connId) } : null;
  };

  return {
    workspaces: loadWorkspaces(),
    runs: {},
    counts: {},
    recent: load<RecentFetch[]>(RECENT_KEY, []),
    formatted: load<boolean>(FORMATTED_KEY, true),

    setDraft: (connId, tabId, xml) => patchTab(connId, tabId, { xml }),

    setSource: (connId, tabId, source) => patchTab(connId, tabId, { source: source ?? undefined }),

    newTab: (connId, xml = DEFAULT_FETCH, source) => {
      const ws = workspaceOf(get(), connId);
      if (ws.tabs.length >= MAX_FETCH_TABS) return null;
      const tab: FetchTab = { id: newId(), xml, source };
      writeWorkspace(connId, { tabs: [...ws.tabs, tab], active: tab.id });
      return tab.id;
    },

    closeTab: (connId, tabId) => {
      const ws = workspaceOf(get(), connId);
      const i = ws.tabs.findIndex((t) => t.id === tabId);
      if (i === -1) return;
      bump(tabId); // a read still in flight stops writing
      const tabs = ws.tabs.filter((t) => t.id !== tabId);
      if (tabs.length === 0) tabs.push({ id: newId(), xml: DEFAULT_FETCH });
      const active = ws.active === tabId ? tabs[Math.min(i, tabs.length - 1)].id : ws.active;
      writeWorkspace(connId, { tabs, active });
      bump(`count:${tabId}`);
      set((s) => {
        const { [tabId]: _gone, ...runs } = s.runs;
        const { [tabId]: _count, ...counts } = s.counts;
        return { runs, counts };
      });
    },

    selectTab: (connId, tabId) => {
      const ws = workspaceOf(get(), connId);
      if (ws.active !== tabId && ws.tabs.some((t) => t.id === tabId)) writeWorkspace(connId, { ...ws, active: tabId });
    },

    renameTab: (connId, tabId, title) => patchTab(connId, tabId, { title: title.trim() || undefined }),

    save: async (as = false) => {
      const ctx = activeContext();
      if (!ctx) return;
      const { connId, tab } = ctx;
      const app = useStore.getState();
      const source = tab.source;
      const path = !as && source?.kind === "file" ? source.path : null;
      const suggested = `${tabLabel(tab).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").trim() || "query"}.xml`;
      try {
        const file = await api.saveXmlFile(tab.xml, path, suggested);
        if (!file) return; // dialog cancelled
        get().setSource(connId, tab.id, { kind: "file", name: file.name, path: file.path, saved: tab.xml });
        app.pushToast({ tone: "success", title: `Saved ${file.name}`, body: file.path });
      } catch (e) {
        app.pushToast({ tone: "error", title: "Could not save the file", body: friendlyError(String(e)) });
      }
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
      const tabId = tab.id;
      const prev = get().runs[tabId];
      if (prev?.status === "running" || prev?.loadingMore) return;
      const xml = tab.xml;
      const base: FetchRun = {
        status: "running",
        xml,
        entity: "",
        expected: [],
        records: [],
        flat: EMPTY,
        page: 1,
        count: null,
        cookie: null,
        more: false,
        pageable: false,
        loadingMore: false,
        capped: false,
        ms: 0,
        requests: 0,
        bytes: 0,
        throttled: 0,
      };
      const parsed = parseFetch(xml);
      if (!parsed.ok) {
        set((s) => ({
          runs: { ...s.runs, [tabId]: { ...base, status: "error", error: parsed.error, line: parsed.line, column: parsed.column } },
        }));
        return;
      }
      const { fetch } = parsed;
      const gen = bump(tabId);
      set((s) => ({ runs: { ...s.runs, [tabId]: { ...base, entity: fetch.entity, expected: fetch.columns } } }));
      const started = performance.now();
      try {
        const page = await api.runFetchXml(connId, fetch.entity, xml);
        if (!current(tabId, gen)) return;
        const pageable = fetch.top === null && !fetch.aggregate;
        patchRun(tabId, {
          status: "ok",
          records: page.records,
          flat: flatten(page.records, fetch.columns),
          page: fetch.page ?? 1,
          count: fetch.count ?? (page.moreRecords ? page.records.length : null),
          cookie: page.pagingCookie,
          more: pageable && page.moreRecords,
          pageable,
          ms: performance.now() - started,
          requests: 1,
          bytes: page.bytes,
          throttled: page.throttled,
        });
        const conn = app.connections.find((c) => c.id === connId);
        const entry: RecentFetch = {
          id: newId(),
          xml,
          entity: fetch.entity,
          connectionName: conn?.name ?? conn?.friendlyName ?? "",
          rows: page.records.length,
          at: Date.now(),
        };
        // The same query again moves to the top instead of repeating.
        const recent = [entry, ...get().recent.filter((r) => r.xml.trim() !== xml.trim())].slice(0, RECENT_MAX);
        set({ recent });
        save(RECENT_KEY, recent);
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
      try {
        for (;;) {
          const run = get().runs[tabId];
          if (!run || !current(tabId, gen)) return;
          const xml = withPage(run.xml, run.page + 1, run.cookie, run.count);
          const started = performance.now();
          const page = await api.runFetchXml(connId, run.entity, xml);
          if (!current(tabId, gen)) return;
          const records = run.records.concat(page.records);
          const capped = records.length >= FETCH_ROW_CAP && page.moreRecords;
          patchRun(tabId, {
            records,
            flat: flatten(records, run.expected),
            page: run.page + 1,
            cookie: page.pagingCookie,
            more: page.moreRecords,
            capped,
            ms: run.ms + (performance.now() - started),
            requests: run.requests + 1,
            bytes: run.bytes + page.bytes,
            throttled: run.throttled + page.throttled,
          });
          if (!all || !page.moreRecords || capped) break;
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

    countRows: async () => {
      const ctx = activeContext();
      if (!ctx) return;
      const { connId, tab } = ctx;
      const key = `count:${tab.id}`;
      if (get().counts[tab.id]?.status === "running") return;
      const xml = tab.xml;
      const started = performance.now();
      const put = (c: Partial<FetchCount>) =>
        set((s) => ({
          counts: {
            ...s.counts,
            [tab.id]: { status: "running", value: 0, method: "aggregate", xml, ms: performance.now() - started, ...s.counts[tab.id], ...c },
          },
        }));
      const parsed = parseFetch(xml);
      if (!parsed.ok) {
        set((s) => ({ counts: { ...s.counts, [tab.id]: { status: "error", value: 0, method: "aggregate", xml, error: parsed.error, ms: 0 } } }));
        return;
      }
      const { fetch } = parsed;
      const gen = bump(key);
      set((s) => ({ counts: { ...s.counts, [tab.id]: { status: "running", value: 0, method: "aggregate", xml, ms: 0 } } }));
      const capTop = (n: number) => (fetch.top !== null ? Math.min(n, fetch.top) : n);
      try {
        if (fetch.aggregate) {
          // Already an aggregate: its rows are the groups.
          const page = await api.runFetchXml(connId, fetch.entity, xml);
          if (!current(key, gen)) return;
          put({ status: "done", value: capTop(page.records.length), method: "aggregate" });
          return;
        }
        const keys = await api.tableKeys(connId, fetch.entity);
        if (!current(key, gen)) return;
        const distinct = /\bdistinct\s*=\s*["']true["']/.test(xml.slice(0, xml.indexOf("<entity")));
        let paging = distinct;
        if (!distinct) {
          const agg = aggregateCountQuery(xml, keys.primaryId);
          if (!agg) throw new Error("This query can't be counted.");
          try {
            const page = await api.runFetchXml(connId, fetch.entity, agg);
            if (!current(key, gen)) return;
            const n = Number(page.records[0]?.rowcount ?? 0);
            put({ status: "done", value: capTop(Number.isFinite(n) ? n : 0), method: "aggregate" });
            return;
          } catch (e) {
            if (!tooManyToAggregate(String(e))) throw e;
            paging = true;
          }
        }
        if (!paging || !current(key, gen)) return;
        // Distinct rows depend on the columns picked, so those page through the query itself.
        const base = keyOnlyQuery(xml, keys.primaryId) ?? withPage(xml.replace(/\stop\s*=\s*["']\d+["']/, ""), 1, null, 5000);
        put({ method: "pages" });
        let pageNo = 1;
        let cookie: string | null = null;
        let total = 0;
        for (;;) {
          const page = await api.runFetchXml(connId, fetch.entity, withPage(base, pageNo, cookie, 5000));
          if (!current(key, gen)) return;
          total += page.records.length;
          if (fetch.top !== null && total >= fetch.top) {
            put({ status: "done", value: fetch.top, method: "pages" });
            return;
          }
          if (!page.moreRecords) {
            put({ status: "done", value: total, method: "pages" });
            return;
          }
          put({ value: total });
          pageNo += 1;
          cookie = page.pagingCookie;
        }
      } catch (e) {
        if (!current(key, gen)) return;
        put({ status: "error", error: friendlyError(String(e)) });
      }
    },

    stopCount: () => {
      const ctx = activeContext();
      if (!ctx || get().counts[ctx.tab.id]?.status !== "running") return;
      bump(`count:${ctx.tab.id}`);
      set((s) => {
        const c = s.counts[ctx.tab.id];
        return c ? { counts: { ...s.counts, [ctx.tab.id]: { ...c, status: "stopped" } } } : {};
      });
    },
  };
});
