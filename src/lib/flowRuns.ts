// Cloud flow run history (`flowrun`): one flow's runs (Flows › Runs tab),
// the runs the Flow runs monitor lists, and per-environment summaries of a
// time window (runs and failures per flow and per hour).
import { create } from "zustand";
import { api } from "../api";
import { createPagedStore } from "./pagedStore";
import { createEnvCache } from "./envCache";
import type { RunOutcome, RunPage, RunReadDepth, RunRow, RunSummary } from "../types";

export type RunRange = "1h" | "24h" | "7d" | "28d";

/** Dataverse keeps runs 28 days by default, so nothing longer. */
export const RUN_RANGES: { key: RunRange; label: string; short: string; ms: number }[] = [
  { key: "1h", label: "Last hour", short: "1h", ms: 60 * 60_000 },
  { key: "24h", label: "Last 24 hours", short: "24h", ms: 24 * 60 * 60_000 },
  { key: "7d", label: "Last 7 days", short: "7 days", ms: 7 * 24 * 60 * 60_000 },
  { key: "28d", label: "Last 28 days", short: "28 days", ms: 28 * 24 * 60 * 60_000 },
];

export const runSince = (range: RunRange) =>
  new Date(Date.now() - (RUN_RANGES.find((r) => r.key === range)?.ms ?? RUN_RANGES[1].ms)).toISOString();

export const rangeLabel = (range: RunRange) => RUN_RANGES.find((r) => r.key === range)?.label ?? range;

export type RunStatusFilter = "" | Exclude<RunOutcome, "other">;

export const RUN_STATUSES: { key: RunStatusFilter; label: string }[] = [
  { key: "", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "succeeded", label: "Succeeded" },
  { key: "cancelled", label: "Cancelled" },
  { key: "running", label: "Running" },
];

/** What the run list controls hold. */
export interface RunFilters {
  range: RunRange;
  status: RunStatusFilter;
  /** "" = every flow. */
  flowId: string;
}

/**
 * How far this account can read `flowrun` per environment (prvReadflowrun depth).
 * Below "global" Dataverse quietly returns fewer rows (each run belongs to its
 * flow's owner), so 0 runs can mean "not allowed to see them".
 */
export const runReadDepth = createEnvCache<RunReadDepth>((connId) => api.flowRunAccess(connId));

/** Every run of the environment is visible. */
export const seesAllRuns = (depth: RunReadDepth | undefined) => depth === undefined || depth === "global";

/**
 * The environment where this account can't see all runs — App shows a dialog for
 * it. Once per environment per session.
 */
export const useRunAccess = create<{
  denied: { connId: string; depth: RunReadDepth } | null;
  seen: Record<string, true>;
  deny: (connId: string, depth: RunReadDepth) => void;
  dismiss: () => void;
}>((set, get) => ({
  denied: null,
  seen: {},
  deny: (connId, depth) => {
    if (get().seen[connId]) return;
    set((s) => ({ denied: { connId, depth }, seen: { ...s.seen, [connId]: true } }));
  },
  dismiss: () => set({ denied: null }),
}));

/** Reads the depth once and opens the dialog when it's short of "global"; a failed check stays quiet. */
export function checkRunAccess(connId: string) {
  runReadDepth
    .load(connId, "")
    .then((depth) => !seesAllRuns(depth) && useRunAccess.getState().deny(connId, depth))
    .catch(() => {});
}

/** The backend's `flowruns::explain` names the privilege on any 403. */
export const isNoRunAccess = (e: unknown) => String((e as Error)?.message ?? e).includes("prvReadflowrun");

function guarded<T>(connId: string, p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (isNoRunAccess(e)) useRunAccess.getState().deny(connId, "none");
    throw e;
  });
}

function pagedRuns(defaults: RunFilters) {
  return createPagedStore<RunFilters, RunRow, RunPage, never>({
    defaults,
    fetchPage: (connId, f, next) =>
      guarded(connId, api.flowRuns(connId, next ? {} : { since: runSince(f.range), flowId: f.flowId || null, status: f.status || null }, next)),
    fetchDetail: () => Promise.reject(new Error("Runs have no separate detail")),
  });
}

/** One flow's runs (Flows › Runs). */
const flowStore = pagedRuns({ range: "7d", status: "", flowId: "" });
export const useFlowRuns = flowStore.useStore;
export const flowRunFiltersOf = flowStore.filtersOf;

/** The monitor's list: failures of every flow, or the runs of the flow picked there. */
const monitorStore = pagedRuns({ range: "24h", status: "failed", flowId: "" });
export const useMonitorRuns = monitorStore.useStore;
export const monitorRunFiltersOf = monitorStore.filtersOf;

/** Summaries per environment, keyed by range; the window ends when it's read. */
export const runSummaries = createEnvCache<RunSummary>((connId, range) =>
  guarded(connId, api.flowRunSummary(connId, runSince(range as RunRange)))
);

/** A run by its name (a child run's `parentRunId`); null when Dataverse doesn't have it. */
export const runByName = createEnvCache<RunRow | null>((connId, name) =>
  guarded(connId, api.flowRuns(connId, { runName: name }, null)).then((p) => p.rows[0] ?? null)
);

/** The child flow runs a run started (first page, newest first). */
export const childRuns = createEnvCache<RunRow[]>((connId, name) =>
  guarded(connId, api.flowRuns(connId, { parentRun: name }, null)).then((p) => p.rows)
);

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  failed: "Failed",
  succeeded: "Succeeded",
  cancelled: "Cancelled",
  running: "Running",
  other: "Other",
};

export const OUTCOME_DOT: Record<RunOutcome, string> = {
  failed: "bg-danger",
  succeeded: "bg-success",
  cancelled: "bg-warning",
  running: "bg-info",
  other: "bg-line-strong",
};

export const OUTCOME_BADGE: Record<RunOutcome, string> = {
  failed: "badge-danger",
  succeeded: "badge-success",
  cancelled: "badge-warning",
  running: "badge-info",
  other: "badge-neutral",
};

/** How long a run took (so far, while it runs); null when unknown. */
export function runDuration(r: Pick<RunRow, "durationMs" | "startTime" | "endTime" | "outcome">, now = Date.now()): number | null {
  if (r.durationMs !== null && r.durationMs >= 0) return r.durationMs;
  if (!r.startTime) return null;
  const start = Date.parse(r.startTime);
  const end = r.endTime ? Date.parse(r.endTime) : r.outcome === "running" ? now : null;
  return end === null ? null : Math.max(0, end - start);
}

/** The error message as JSON, when it is (Terminate actions, connector errors often are). */
function errorJson(message: string): unknown {
  const t = message.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** The first human sentence in an error JSON: a `message`-like field, however deep. */
function messageIn(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  const entries = Array.isArray(value) ? value.map((v) => ["", v] as const) : Object.entries(value);
  for (const [k, v] of entries) {
    if (typeof v === "string" && v.trim() && /^(message|errormessage|error|detail|details|reason)$/i.test(k)) {
      // A message that is JSON again (wrapped errors): look inside it.
      const inner = errorJson(v);
      return (inner !== undefined && messageIn(inner, depth + 1)) || v.trim();
    }
  }
  for (const [, v] of entries) {
    const found = messageIn(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** One line of an error message, for lists: the sentence inside a JSON error, else its first line. */
export function errorGist(message: string | null): string | null {
  if (!message) return null;
  const json = errorJson(message);
  const text = json !== undefined ? messageIn(json) : message;
  // A line with words in it: a lone "{" (JSON cut short) says nothing.
  const line = (text ?? "").split(/\r?\n/).find((l) => /[\p{L}\p{N}]/u.test(l))?.trim() ?? "";
  return line.length > 240 ? `${line.slice(0, 240)}…` : line || null;
}

/** The full error message to read: JSON pretty-printed, anything else as it came. */
export function errorText(message: string): string {
  const json = errorJson(message);
  return json !== undefined ? JSON.stringify(json, null, 2) : message;
}

/** Failed share as "12.5%" (one decimal under 10%). */
export function failRate(failed: number, total: number): string {
  if (!total) return "—";
  const p = (failed / total) * 100;
  return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export interface Bar {
  /** Start of the slot. */
  at: number;
  total: number;
  failed: number;
}

/**
 * The summary's hours as chart bars: a bar per hour for a day or less, per
 * local day beyond (empty slots included, so gaps show).
 */
export function bars(summary: RunSummary, range: RunRange): { bars: Bar[]; unit: "hour" | "day" } {
  const unit = range === "1h" || range === "24h" ? "hour" : "day";
  const since = Date.parse(summary.since);
  const until = Date.parse(summary.until);
  const slotOf = (t: number) => {
    const d = new Date(t);
    if (unit === "hour") d.setMinutes(0, 0, 0);
    else d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const next = (t: number) => {
    const d = new Date(t);
    if (unit === "hour") d.setHours(d.getHours() + 1);
    else d.setDate(d.getDate() + 1);
    return d.getTime();
  };
  const slots = new Map<number, Bar>();
  for (let t = slotOf(since); t <= until; t = next(t)) slots.set(t, { at: t, total: 0, failed: 0 });
  for (const h of summary.hours) {
    const slot = slots.get(slotOf(Date.parse(h.at)));
    if (!slot) continue;
    slot.total += h.total;
    slot.failed += h.failed;
  }
  return { bars: [...slots.values()], unit };
}

const RANGE_KEY = "cds.flowruns.range";

function readRange(): RunRange {
  try {
    const r = localStorage.getItem(RANGE_KEY);
    return RUN_RANGES.some((x) => x.key === r) ? (r as RunRange) : "24h";
  } catch {
    return "24h";
  }
}

/** The monitor's window; the Flows list shows failure counts for the same one. */
export const useMonitorRange = create<{ range: RunRange; setRange: (r: RunRange) => void }>((set) => ({
  range: readRange(),
  setRange: (range) => {
    try {
      localStorage.setItem(RANGE_KEY, range);
    } catch {
      // Only a convenience.
    }
    set({ range });
  },
}));

/** "28 days" from seconds. */
export function retentionLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds <= 0) return "not kept";
  const days = seconds / 86_400;
  return days >= 1 ? `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}` : `${Math.round(seconds / 3600)} h`;
}
