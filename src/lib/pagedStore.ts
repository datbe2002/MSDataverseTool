// A per-connection, newest-first log read a page at a time (trace logs,
// system jobs): the filters as typed, the loaded pages, and the rows opened
// in full. Kept while the app runs, so leaving a tool and coming back shows
// the same list.
import { create } from "zustand";
import { friendlyError } from "./errors";

export interface Page<Row> {
  rows: Row[];
  /** Link for the next page. */
  next: string | null;
}

export interface PagedList<Row, P extends Page<Row>> {
  /** `JSON.stringify` of the filters these rows are for. */
  key: string;
  rows: Row[];
  next: string | null;
  /** The first page as the server sent it (for extras like the trace log setting). */
  first: P | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  loadingMore: boolean;
  /** When the first page was read. */
  at: number;
}

export interface PagedStore<F, Row, P extends Page<Row>, D> {
  filters: Record<string, F>;
  lists: Record<string, PagedList<Row, P>>;
  details: Record<string, D>;
  detailErrors: Record<string, string>;
  setFilters: (connId: string, patch: Partial<F>) => void;
  /** Reads the first page for the current filters (unless it's there already, or `force`). */
  load: (connId: string, force?: boolean) => void;
  loadMore: (connId: string) => void;
  loadDetail: (connId: string, id: string) => void;
}

export const detailKey = (connId: string, id: string) => `${connId}|${id.toLowerCase()}`;

export function createPagedStore<F, Row extends { id: string }, P extends Page<Row>, D>(opts: {
  defaults: F;
  /** The first page for `filters`, or the page at `next`. */
  fetchPage: (connId: string, filters: F, next: string | null) => Promise<P>;
  fetchDetail: (connId: string, id: string) => Promise<D>;
}) {
  // A newer load of the same connection makes older answers stale.
  const generation: Record<string, number> = {};
  const inflight = new Set<string>();
  const filtersOf = (s: PagedStore<F, Row, P, D>, connId: string | null): F => (connId && s.filters[connId]) || opts.defaults;

  const useStore = create<PagedStore<F, Row, P, D>>((set, get) => {
    const patch = (connId: string, p: Partial<PagedList<Row, P>>) =>
      set((s) => ({ lists: { ...s.lists, [connId]: { ...s.lists[connId], ...p } } }));
    return {
      filters: {},
      lists: {},
      details: {},
      detailErrors: {},

      setFilters: (connId, p) => set((s) => ({ filters: { ...s.filters, [connId]: { ...filtersOf(s, connId), ...p } } })),

      load: (connId, force = false) => {
        const filters = filtersOf(get(), connId);
        const key = JSON.stringify(filters);
        const current = get().lists[connId];
        if (!force && current?.key === key && current.status !== "error") return;

        const gen = (generation[connId] = (generation[connId] ?? 0) + 1);
        set((s) => ({
          lists: {
            ...s.lists,
            [connId]: {
              key,
              // Same filters (Refresh): keep the rows on screen while reading.
              rows: current?.key === key ? current.rows : [],
              next: null,
              first: current?.first ?? null,
              status: "loading",
              error: null,
              loadingMore: false,
              at: Date.now(),
            },
          },
        }));
        opts
          .fetchPage(connId, filters, null)
          .then((page) => {
            if (generation[connId] === gen) patch(connId, { rows: page.rows, next: page.next, first: page, status: "ready", at: Date.now() });
          })
          .catch((e) => {
            if (generation[connId] === gen) patch(connId, { rows: [], status: "error", error: friendlyError(String(e)) });
          });
      },

      loadMore: (connId) => {
        const list = get().lists[connId];
        if (!list?.next || list.loadingMore || list.status !== "ready") return;
        const gen = generation[connId];
        patch(connId, { loadingMore: true });
        opts
          .fetchPage(connId, filtersOf(get(), connId), list.next)
          .then((page) => {
            if (generation[connId] !== gen) return;
            const rows = get().lists[connId].rows;
            const seen = new Set(rows.map((r) => r.id));
            patch(connId, { rows: [...rows, ...page.rows.filter((r) => !seen.has(r.id))], next: page.next, loadingMore: false });
          })
          .catch((e) => {
            if (generation[connId] === gen) patch(connId, { loadingMore: false, error: friendlyError(String(e)) });
          });
      },

      loadDetail: (connId, id) => {
        const key = detailKey(connId, id);
        const s = get();
        if (s.details[key] || s.detailErrors[key] || inflight.has(key)) return;
        inflight.add(key);
        opts
          .fetchDetail(connId, id)
          .then((d) => set((st) => ({ details: { ...st.details, [key]: d } })))
          .catch((e) => set((st) => ({ detailErrors: { ...st.detailErrors, [key]: friendlyError(String(e)) } })))
          .finally(() => inflight.delete(key));
      },
    };
  });

  return { useStore, filtersOf };
}

export type TimeRange = "15m" | "1h" | "24h" | "7d" | "30d" | "all";

export const RANGES: { key: TimeRange; label: string; ms: number | null }[] = [
  { key: "15m", label: "Last 15 minutes", ms: 15 * 60_000 },
  { key: "1h", label: "Last hour", ms: 60 * 60_000 },
  { key: "24h", label: "Last 24 hours", ms: 24 * 60 * 60_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60_000 },
  { key: "all", label: "Any time", ms: null },
];

/** The start of a time range, worked out now (ISO); null for "Any time". */
export function sinceOf(range: TimeRange): string | null {
  const ms = RANGES.find((r) => r.key === range)?.ms ?? null;
  return ms === null ? null : new Date(Date.now() - ms).toISOString();
}

/** Duration as people read it: 812 ms, 3.4 s, 2 min 5 s, 3 h 10 min. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  return `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min`;
}

/** A log time: just the clock today, with the date otherwise. */
export function logTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
