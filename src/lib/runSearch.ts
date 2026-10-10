// Runs › Find in run data: which runs of a flow had a value (a PO number…) in
// their steps' inputs or outputs. Power Automate can't search them, so every
// run in the window is read: its runs come from Dataverse (`flowrun`), each
// one is searched by the backend (`flowapi::search_run`), a few at a time.
import { create } from "zustand";
import { api } from "../api";
import { apiGuarded, deniedReason, useFlowApiAccess, type RunStatusFilter } from "./flowRuns";
import type { RunRow, RunSearchHit, RunSearchScope } from "../types";

/** Runs read per batch: "Search more" reads the next ones. */
export const MAX_RUNS = 1000;
/** Runs searched at the same time. */
const WORKERS = 4;

/** The runs a search reads: started in [since, until), with this status. */
export interface SearchWindow {
  since: string;
  until: string | null;
  status: RunStatusFilter;
  label: string;
  widenable: boolean;
}

export interface RunMatch {
  run: RunRow;
  hits: RunSearchHit[];
}

export interface RunSearch {
  needle: string;
  scope: RunSearchScope;
  /** What `scope` covers, for the summary ("Parse JSON", "every step"). */
  scopeLabel: string;
  /** The time window searched, for the summary ("last 7 days", "Oct 8, 09:00 – 18:00"). */
  windowLabel: string;
  /** The window can be widened (it isn't already the longest one kept). */
  widenable: boolean;
  status: "running" | "done" | "stopped" | "error";
  /** Runs found so far in the window (grows while Dataverse is paged). */
  total: number;
  /** The window has more runs than were searched: `more` reads the next batch. */
  capped: boolean;
  /** All runs of the window are known. */
  listed: boolean;
  scanned: number;
  matches: RunMatch[];
  /** Runs that couldn't be searched, and bodies that couldn't be read. */
  failed: number;
  skipped: number;
  error: string | null;
}

const keyOf = (connId: string, flowId: string) => `${connId}|${flowId}`;

interface Token {
  id: string;
  cancelled: boolean;
}

/** Searches still going, by key: Stop flips its flag. */
const live = new Map<string, Token>();
/** Search ids are unique across reloads too: the backend keeps the stopped ones. */
let searches = 0;

/** Stops a search here and in the backend (which would finish the runs it's reading). */
function cancel(token: Token) {
  token.cancelled = true;
  api.flowRunSearchStop(token.id).catch(() => {});
}

/** Where the next batch of a capped search starts: rows of the last page not taken, then `next`. */
interface Cursor {
  rest: RunRow[];
  next: string | null;
}
const cursors = new Map<string, Cursor>();

export const useRunSearch = create<{
  searches: Record<string, RunSearch>;
  start: (
    connId: string,
    flowId: string,
    needle: string,
    scope: RunSearchScope,
    scopeLabel: string,
    window: SearchWindow
  ) => void;
  /** Searches the next `MAX_RUNS` runs of a capped search's window. */
  more: (connId: string, flowId: string) => void;
  stop: (connId: string, flowId: string) => void;
  clear: (connId: string, flowId: string) => void;
}>((set, get) => {
  const update = (key: string, f: (s: RunSearch) => Partial<RunSearch>) =>
    set((st) => (st.searches[key] ? { searches: { ...st.searches, [key]: { ...st.searches[key], ...f(st.searches[key]) } } } : st));

  /** Searches up to `MAX_RUNS` runs: the window's first page on, or from `from`. */
  const batch = (connId: string, flowId: string, window: SearchWindow | null, from: Cursor | null) => {
    const key = keyOf(connId, flowId);
    const search = get().searches[key];
    if (!search) return;
    const { needle, scope } = search;
    const previous = live.get(key);
    if (previous) cancel(previous);
    const token: Token = { id: `${Date.now()}-${++searches}`, cancelled: false };
    live.set(key, token);
    cursors.delete(key);

    const queue: RunRow[] = [];
    let listed = false;
    const fail = (message: string) => {
      cancel(token);
      update(key, () => ({ status: "error", error: message }));
    };

    // The window's runs, newest first, a page at a time.
    const list = async () => {
      let count = 0;
      let next = from?.next ?? null;
      const take = (rows: RunRow[]) => {
        const taken = rows.slice(0, MAX_RUNS - count);
        queue.push(...taken);
        count += taken.length;
        update(key, (s) => ({ total: s.total + taken.length }));
        return rows.slice(taken.length);
      };
      let rest = from ? take(from.rest) : [];
      let first = !from;
      while (count < MAX_RUNS && !rest.length && (first || next)) {
        const page = await api.flowRuns(
          connId,
          next || !window ? {} : { since: window.since, until: window.until, flowId, status: window.status || null },
          next
        );
        if (token.cancelled) return;
        first = false;
        // An empty page ends the window, whatever continuation it carries (elastic tables can).
        next = page.rows.length ? page.next : null;
        rest = take(page.rows);
      }
      const capped = rest.length > 0 || !!next;
      if (capped) cursors.set(key, { rest, next });
      listed = true;
      update(key, () => ({ capped, listed: true }));
    };

    const work = async () => {
      while (!token.cancelled) {
        const run = queue.shift();
        if (!run) {
          if (listed) return;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        try {
          const result = await apiGuarded(connId, api.flowRunSearch(connId, flowId, run.runName, needle, scope, token.id));
          if (token.cancelled) return;
          update(key, (s) => ({
            scanned: s.scanned + 1,
            skipped: s.skipped + result.skipped,
            matches: result.hits.length ? [...s.matches, { run, hits: result.hits }] : s.matches,
          }));
        } catch (e) {
          if (token.cancelled) return;
          // No access stops the whole search (the dialog explains it).
          if (deniedReason(e) !== null || useFlowApiAccess.getState().denied[connId]) return fail(String((e as Error)?.message ?? e));
          update(key, (s) => ({ scanned: s.scanned + 1, failed: s.failed + 1 }));
        }
      }
    };

    void (async () => {
      try {
        await Promise.all([list(), ...Array.from({ length: WORKERS }, work)]);
      } catch (e) {
        if (!token.cancelled) fail(String((e as Error)?.message ?? e));
        return;
      }
      if (live.get(key) === token) live.delete(key);
      if (!token.cancelled) update(key, () => ({ status: "done" }));
    })();
  };

  return {
    searches: {},

    start: (connId, flowId, needle, scope, scopeLabel, window) => {
      set((st) => ({
        searches: {
          ...st.searches,
          [keyOf(connId, flowId)]: {
            needle,
            scope,
            scopeLabel,
            windowLabel: window.label,
            widenable: window.widenable,
            status: "running",
            total: 0,
            capped: false,
            listed: false,
            scanned: 0,
            matches: [],
            failed: 0,
            skipped: 0,
            error: null,
          },
        },
      }));
      batch(connId, flowId, window, null);
    },

    more: (connId, flowId) => {
      const key = keyOf(connId, flowId);
      const cursor = cursors.get(key);
      if (!cursor || get().searches[key]?.status !== "done") return;
      update(key, () => ({ status: "running", capped: false, listed: false }));
      batch(connId, flowId, null, cursor);
    },

    stop: (connId, flowId) => {
      const key = keyOf(connId, flowId);
      const token = live.get(key);
      if (token) cancel(token);
      live.delete(key);
      if (get().searches[key]?.status === "running") update(key, () => ({ status: "stopped" }));
    },

    clear: (connId, flowId) => {
      get().stop(connId, flowId);
      cursors.delete(keyOf(connId, flowId));
      set((st) => {
        const { [keyOf(connId, flowId)]: _, ...rest } = st.searches;
        return { searches: rest };
      });
    },
  };
});

export const searchOf = (searches: Record<string, RunSearch>, connId: string, flowId: string) => searches[keyOf(connId, flowId)];
