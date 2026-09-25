// Plug-in trace logs per connection (Trace logs tool).
import { api } from "../api";
import { createPagedStore, sinceOf, type TimeRange } from "./pagedStore";
import type { TraceDetail, TraceFilter, TracePage, TraceRow } from "../types";

export { RANGES, detailKey, formatDuration, logTime as traceTime } from "./pagedStore";
export type TraceRange = TimeRange;

/** What the filter controls hold (text as typed). */
export interface TraceFilters {
  range: TraceRange;
  typeName: string;
  message: string;
  entity: string;
  /** "" = any, "0" = synchronous, "1" = asynchronous. */
  mode: "" | "0" | "1";
  exceptionsOnly: boolean;
  correlationId: string;
  text: string;
  /** Minimum duration in ms, as typed. */
  minDuration: string;
}

export const DEFAULT_FILTERS: TraceFilters = {
  range: "24h",
  typeName: "",
  message: "",
  entity: "",
  mode: "",
  exceptionsOnly: false,
  correlationId: "",
  text: "",
  minDuration: "",
};

/** Identifies a set of filters (the time range by name, not its moment). */
export const filterKey = (f: TraceFilters) => JSON.stringify(f);

/** The server-side filter; `since` is worked out now from the range. */
export function toServerFilter(f: TraceFilters): TraceFilter {
  const text = (s: string) => s.trim() || null;
  const min = parseInt(f.minDuration, 10);
  return {
    since: sinceOf(f.range),
    typeName: text(f.typeName),
    message: text(f.message),
    entity: text(f.entity)?.toLowerCase() ?? null,
    mode: f.mode === "" ? null : Number(f.mode),
    exceptionsOnly: f.exceptionsOnly,
    correlationId: text(f.correlationId),
    text: text(f.text),
    minDurationMs: Number.isFinite(min) && min > 0 ? min : null,
  };
}

const store = createPagedStore<TraceFilters, TraceRow, TracePage, TraceDetail>({
  defaults: DEFAULT_FILTERS,
  fetchPage: (connId, f, next) => api.traceLogs(connId, next ? {} : toServerFilter(f), next),
  fetchDetail: api.traceLog,
});
export const useTraces = store.useStore;
export const filtersOf = store.filtersOf;

/** "Contoso.Plugins.AccountCreate" → "AccountCreate"; keeps generic args together. */
export function shortType(typeName: string): string {
  const name = typeName.split(",")[0].trim();
  const cut = name.lastIndexOf(".", name.includes("`") ? name.indexOf("`") : undefined);
  return cut >= 0 ? name.slice(cut + 1) : name;
}
