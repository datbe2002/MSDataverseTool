// Runs › Find in run data: which runs of a flow had a value (a PO number…) in
// their steps' inputs or outputs. Power Automate can't search them, so every
// run in the window is read: its runs come from Dataverse (`flowrun`), each
// one is searched by the backend (`flowapi::search_run`), a few at a time.
import { create } from "zustand";
import { api } from "../api";
import { apiGuarded, deniedReason, useFlowApiAccess, type RunStatusFilter } from "./flowRuns";
import type { RunRow, RunSearchHit, RunSearchScope } from "../types";

/** Runs read at most per search. */
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
  /** The window has more runs than `MAX_RUNS`: the newest ones were searched. */
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

/** Searches still going, by key: Stop flips its flag. */
const live = new Map<string, { cancelled: boolean }>();

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
  stop: (connId: string, flowId: string) => void;
  clear: (connId: string, flowId: string) => void;
}>((set, get) => {
  const update = (key: string, f: (s: RunSearch) => Partial<RunSearch>) =>
    set((st) => (st.searches[key] ? { searches: { ...st.searches, [key]: { ...st.searches[key], ...f(st.searches[key]) } } } : st));

  return {
    searches: {},

    start: (connId, flowId, needle, scope, scopeLabel, window) => {
      const key = keyOf(connId, flowId);
      const previous = live.get(key);
      if (previous) previous.cancelled = true;
      const token = { cancelled: false };
      live.set(key, token);
      set((st) => ({
        searches: {
          ...st.searches,
          [key]: {
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

      const queue: RunRow[] = [];
      let listed = false;
      const fail = (message: string) => {
        token.cancelled = true;
        update(key, () => ({ status: "error", error: message }));
      };

      // The window's runs, newest first, a page at a time.
      const list = async () => {
        let next: string | null = null;
        let count = 0;
        do {
          const page = await api.flowRuns(
            connId,
            next ? {} : { since: window.since, until: window.until, flowId, status: window.status || null },
            next
          );
          if (token.cancelled) return;
          const room = MAX_RUNS - count;
          const rows = page.rows.slice(0, room);
          queue.push(...rows);
          count += rows.length;
          next = page.next;
          const capped = count >= MAX_RUNS && (!!next || page.rows.length > rows.length);
          update(key, () => ({ total: count, capped }));
          if (capped) break;
        } while (next);
        listed = true;
        update(key, () => ({ listed: true }));
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
            const result = await apiGuarded(connId, api.flowRunSearch(connId, flowId, run.runName, needle, scope));
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
    },

    stop: (connId, flowId) => {
      const key = keyOf(connId, flowId);
      const token = live.get(key);
      if (token) token.cancelled = true;
      live.delete(key);
      if (get().searches[key]?.status === "running") update(key, () => ({ status: "stopped" }));
    },

    clear: (connId, flowId) => {
      get().stop(connId, flowId);
      set((st) => {
        const { [keyOf(connId, flowId)]: _, ...rest } = st.searches;
        return { searches: rest };
      });
    },
  };
});

export const searchOf = (searches: Record<string, RunSearch>, connId: string, flowId: string) => searches[keyOf(connId, flowId)];
