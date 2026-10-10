// Cloud flow run history (`flowrun`): one flow's runs (Flows › Runs tab),
// the runs the Flow runs monitor lists, and per-environment summaries of a
// time window (runs and failures per flow and per hour).
import { create } from "zustand";
import { api } from "../api";
import { createPagedStore } from "./pagedStore";
import { createEnvCache } from "./envCache";
import type { OutlineNode } from "./flowOutline";
import type { ErrorStats, RunOutcome, RunPage, RunReadDepth, RunRow, RunStep, RunStepContent, RunSteps, RunSummary } from "../types";

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

/** Slots of a chart: an hour each for a day or less, a local day each beyond. */
export const slotUnit = (range: RunRange): "hour" | "day" => (range === "1h" || range === "24h" ? "hour" : "day");

/**
 * The summary's hours as chart bars: a bar per hour for a day or less, per
 * local day beyond (empty slots included, so gaps show). With `error`, only
 * that error code's failures (total = failed).
 */
export function bars(summary: RunSummary, range: RunRange, error?: ErrorStats): { bars: Bar[]; unit: "hour" | "day" } {
  const unit = slotUnit(range);
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
  const hours = error ? error.hours.map((h) => ({ at: h.at, total: h.failed, failed: h.failed })) : summary.hours;
  for (const h of hours) {
    const slot = slots.get(slotOf(Date.parse(h.at)));
    if (!slot) continue;
    slot.total += h.total;
    slot.failed += h.failed;
  }
  return { bars: [...slots.values()], unit };
}

// ---- Failures by error code ----

/** How an error code reads: "" is a failure that came without one. */
export const codeLabel = (code: string) => code || "No error code";

/** Failed runs sampled per error code to read their messages. */
export const SAMPLE_MAX = 300;

export interface ErrorSample {
  rows: RunRow[];
  /** More failed runs with this code than were read. */
  more: boolean;
}

/**
 * The newest failed runs with an error code in a summary's window (key:
 * `since|until|code`), up to SAMPLE_MAX: the summary counts codes, only the
 * runs themselves carry the messages.
 */
export const errorSamples = createEnvCache<ErrorSample>(async (connId, key) => {
  const [since, until, ...rest] = key.split("|");
  const filter = { since, until, status: "failed" as const, errorCode: rest.join("|") };
  const rows: RunRow[] = [];
  let next: string | null = null;
  do {
    const page: RunPage = await guarded(connId, api.flowRuns(connId, next ? {} : filter, next));
    rows.push(...page.rows);
    next = page.next;
  } while (next && rows.length < SAMPLE_MAX);
  return { rows: rows.slice(0, SAMPLE_MAX), more: !!next || rows.length > SAMPLE_MAX };
});

export const sampleKey = (summary: RunSummary, code: string) => `${summary.since}|${summary.until}|${code}`;

export interface MessageGroup {
  /** The message with ids, numbers and times blanked: what the runs share. */
  pattern: string;
  /** One real message of the group (the newest). */
  example: string;
  /** Its full text. */
  full: string | null;
  runs: RunRow[];
  flows: number;
}

/** Ids, numbers and times differ run to run; blanked, the same failure reads the same. */
export function messagePattern(gist: string): string {
  return gist
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b[0-9A-F]{20,}[A-Z0-9]*\b/g, "<id>")
    .replace(/\d+([.,]\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sampled runs grouped by what their error says, most runs first. */
export function messageGroups(rows: RunRow[]): MessageGroup[] {
  const groups = new Map<string, MessageGroup>();
  for (const r of rows) {
    const gist = errorGist(r.errorMessage) ?? "";
    const pattern = gist ? messagePattern(gist) : "";
    let g = groups.get(pattern);
    if (!g) {
      g = { pattern, example: gist, full: r.errorMessage, runs: [], flows: 0 };
      groups.set(pattern, g);
    }
    g.runs.push(r);
  }
  for (const g of groups.values()) g.flows = new Set(g.runs.map((r) => r.flowId ?? "")).size;
  return [...groups.values()].sort((a, b) => b.runs.length - a.runs.length || a.pattern.localeCompare(b.pattern));
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

// ---- A run's steps (Power Automate API) ----

/** The backend's "this account can't use the Power Automate API" (`flowapi::DENIED`). */
const DENIED = "FLOW_API_DENIED:";

export function deniedReason(e: unknown): string | null {
  const m = String((e as Error)?.message ?? e);
  const i = m.indexOf(DENIED);
  return i < 0 ? null : m.slice(i + DENIED.length).trim();
}

/** Refused before any call: the tenant wouldn't give this app a Power Automate token. */
export const isTokenDenial = (reason: string) => reason.startsWith("Sign-in to Power Automate was refused");

/**
 * Environments where the Power Automate API said no (the reason), and the one
 * App shows a dialog for: once per environment per session.
 */
export const useFlowApiAccess = create<{
  denied: Record<string, string>;
  dialog: { connId: string; reason: string } | null;
  seen: Record<string, true>;
  deny: (connId: string, reason: string) => void;
  allow: (connId: string) => void;
  dismiss: () => void;
}>((set, get) => ({
  denied: {},
  dialog: null,
  seen: {},
  deny: (connId, reason) => {
    const first = !get().seen[connId];
    set((s) => ({
      denied: { ...s.denied, [connId]: reason },
      dialog: first ? { connId, reason } : s.dialog,
      seen: { ...s.seen, [connId]: true },
    }));
  },
  allow: (connId) => {
    if (!(connId in get().denied)) return;
    set((s) => {
      const { [connId]: _, ...rest } = s.denied;
      return { denied: rest };
    });
  },
  dismiss: () => set({ dialog: null }),
}));

/** Records a denial (the error then reads as its reason alone) or that the API answered. */
export function apiGuarded<T>(connId: string, p: Promise<T>): Promise<T> {
  return p.then(
    (v) => {
      useFlowApiAccess.getState().allow(connId);
      return v;
    },
    (e) => {
      const reason = deniedReason(e);
      if (reason === null) throw e;
      useFlowApiAccess.getState().deny(connId, reason);
      throw new Error(reason);
    }
  );
}

const stepKey = (...parts: string[]) => JSON.stringify(parts);

/** A run's trigger and actions; key = `stepsKey(flowId, runName)`. */
export const runSteps = createEnvCache<RunSteps>((connId, key) => {
  const [flowId, runName] = JSON.parse(key) as [string, string];
  return apiGuarded(connId, api.flowRunSteps(connId, flowId, runName));
});
export const stepsKey = (flowId: string, runName: string) => stepKey(flowId, runName);

/** Every repetition of a looped step; key = `repetitionsKey(flowId, runName, step)`. */
export const stepRepetitions = createEnvCache<RunStep[]>((connId, key) => {
  const [flowId, runName, step] = JSON.parse(key) as [string, string, string];
  return apiGuarded(connId, api.flowRunStepRepetitions(connId, flowId, runName, step));
});
export const repetitionsKey = (flowId: string, runName: string, step: string) => stepKey(flowId, runName, step);

/** Inputs / outputs behind a step's link (key = the link). */
export const stepContent = createEnvCache<RunStepContent>((connId, link) => apiGuarded(connId, api.flowRunContent(connId, link)));

export type StepTone = "failed" | "succeeded" | "skipped" | "running" | "cancelled" | "other";

/** Statuses as Logic Apps writes them (Succeeded, Failed, TimedOut, Skipped, Running, Waiting, Cancelled, Aborted…). */
export function stepTone(status: string): StepTone {
  const s = status.toLowerCase();
  if (s === "failed" || s === "timedout" || s === "faulted") return "failed";
  if (s === "succeeded") return "succeeded";
  if (s === "skipped" || s === "ignored") return "skipped";
  if (s === "running" || s === "waiting" || s === "suspended" || s === "paused") return "running";
  if (s === "cancelled" || s === "aborted") return "cancelled";
  return "other";
}

export const STEP_DOT: Record<StepTone, string> = {
  failed: "bg-danger",
  succeeded: "bg-success",
  skipped: "bg-line-strong",
  running: "bg-info",
  cancelled: "bg-warning",
  other: "bg-line-strong",
};

/** Steps that hold other steps: they fail because something inside them did. */
const CONTAINERS = new Set(["scope", "foreach", "if", "switch", "until"]);

/** A line of the steps list: a step that ran (or was skipped), or a branch heading. */
export type StepLine =
  | { kind: "step"; step: RunStep; depth: number; label: string; type: string | null; container: boolean; node: OutlineNode | null }
  | { kind: "branch"; label: string; depth: number };

const pretty = (name: string) => name.replace(/_/g, " ");

/**
 * The run's steps in the definition's order (nested, with branch headings), or in
 * the order the API listed them when there's no definition. Steps the definition
 * doesn't have (it changed since the run) come last.
 */
export function stepLines(steps: RunSteps, outline: OutlineNode[] | null): StepLine[] {
  const byName = new Map(steps.actions.map((a) => [a.name, a]));
  const used = new Set<string>();
  const out: StepLine[] = [];
  const line = (step: RunStep, depth: number, node: OutlineNode | null): StepLine => ({
    kind: "step",
    step,
    depth,
    label: node?.name ?? pretty(step.name),
    type: node?.type ?? null,
    container: CONTAINERS.has((node?.actionType ?? "").toLowerCase()),
    node,
  });

  const walk = (nodes: OutlineNode[], depth: number): StepLine[] => {
    const lines: StepLine[] = [];
    for (const n of nodes) {
      if (n.kind === "branch") {
        const inner = walk(n.children, depth + 1);
        if (inner.length) lines.push({ kind: "branch", label: n.name, depth }, ...inner);
        continue;
      }
      if (n.kind === "trigger") continue;
      const step = byName.get(n.key);
      if (step) {
        used.add(n.key);
        lines.push(line(step, depth, n));
      }
      lines.push(...walk(n.children, step ? depth + 1 : depth));
    }
    return lines;
  };

  if (steps.trigger) {
    const node = outline?.find((n) => n.kind === "trigger" && n.key === steps.trigger!.name) ?? null;
    out.push({ ...(line(steps.trigger, 0, node) as Extract<StepLine, { kind: "step" }>), type: node?.type ?? "Trigger" });
  }
  if (outline) out.push(...walk(outline, 0));
  const rest = steps.actions.filter((a) => !used.has(a.name));
  if (!outline) rest.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  out.push(...rest.map((a) => line(a, 0, null)));
  return out;
}

/** Where to look first: the first failed step that isn't just a container of failures. */
export function firstFailure(lines: StepLine[]): RunStep | null {
  const failed = lines.filter((l): l is Extract<StepLine, { kind: "step" }> => l.kind === "step" && stepTone(l.step.status) === "failed");
  return (failed.find((l) => !l.container) ?? failed[0])?.step ?? null;
}

/** Each step's result by its outline id (`OutlineNode.id`), for the Designer. */
export function runStepsById(steps: RunSteps, outline: OutlineNode[]): Map<string, RunStep> {
  const byName = new Map(steps.actions.map((a) => [a.name, a]));
  const out = new Map<string, RunStep>();
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      const step = n.kind === "trigger" ? (steps.trigger?.name === n.key ? steps.trigger : null) : n.kind === "branch" ? null : byName.get(n.key);
      if (step) out.set(n.id, step);
      walk(n.children);
    }
  };
  walk(outline);
  return out;
}

/** How long a step took; null while it runs or when unknown. */
export function stepDuration(s: Pick<RunStep, "startTime" | "endTime">): number | null {
  if (!s.startTime || !s.endTime) return null;
  return Math.max(0, Date.parse(s.endTime) - Date.parse(s.startTime));
}

/** "1.2 KB" for a content size. */
export function byteSize(n: number | null): string | null {
  if (n === null || n < 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
