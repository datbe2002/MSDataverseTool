// Desktop flows (RPA) per connection: the flows, their runs (`flowsession`)
// and the machines that run them (Desktop flows tool, read only).
import { api } from "../api";
import { createEnvCache } from "./envCache";
import { createPagedStore, sinceOf, type TimeRange } from "./pagedStore";
import type { DesktopRun, DesktopRunDetail, DesktopRunFilter, DesktopRunPage, DesktopRunStatusFilter, FlowMachine } from "../types";

export type DesktopTab = "runs" | "flows" | "machines";
export const DESKTOP_TABS: { key: DesktopTab; label: string }[] = [
  { key: "runs", label: "Runs" },
  { key: "flows", label: "Flows" },
  { key: "machines", label: "Machines" },
];

export const desktopFlowsCache = createEnvCache((connId) => api.desktopFlows(connId));
export const desktopFlowDetailCache = createEnvCache((connId, id) => api.desktopFlow(connId, id));
export const machinesCache = createEnvCache((connId) => api.flowMachines(connId));

/** What the run filter controls hold. */
export interface DesktopRunFilters {
  range: TimeRange;
  status: "" | DesktopRunStatusFilter;
  flowId: string;
  /** `m:<machine id>` or `g:<group id>`; "" = any. */
  target: string;
  /** `runmode` as a string ("" = any). */
  runMode: string;
  text: string;
}

export const DEFAULT_RUN_FILTERS: DesktopRunFilters = { range: "7d", status: "", flowId: "", target: "", runMode: "", text: "" };

export const RUN_STATUSES: { key: DesktopRunFilters["status"]; label: string }[] = [
  { key: "", label: "Any status" },
  { key: "failed", label: "Failed" },
  { key: "running", label: "Running" },
  { key: "waiting", label: "Queued / waiting" },
  { key: "succeeded", label: "Succeeded" },
  { key: "canceled", label: "Cancelled" },
];

export const RUN_MODES: { value: string; label: string }[] = [
  { value: "", label: "Any mode" },
  { value: "1", label: "Attended" },
  { value: "2", label: "Unattended" },
  { value: "0", label: "Local (from the console)" },
];

export function toServerFilter(f: DesktopRunFilters): DesktopRunFilter {
  return {
    since: sinceOf(f.range),
    status: f.status || null,
    flowId: f.flowId || null,
    machineId: f.target.startsWith("m:") ? f.target.slice(2) : null,
    groupId: f.target.startsWith("g:") ? f.target.slice(2) : null,
    runMode: f.runMode ? Number(f.runMode) : null,
    text: f.text.trim() || null,
  };
}

const store = createPagedStore<DesktopRunFilters, DesktopRun, DesktopRunPage, DesktopRunDetail>({
  defaults: DEFAULT_RUN_FILTERS,
  fetchPage: (connId, f, next) => api.desktopFlowRuns(connId, next ? {} : toServerFilter(f), next),
  fetchDetail: api.desktopFlowRun,
});
export const useDesktopRuns = store.useStore;
export const desktopRunFiltersOf = store.filtersOf;

export type RunTone = "danger" | "success" | "warning" | "info" | "neutral";

/** How a run status reads at a glance. */
export function runTone(status: number): RunTone {
  if (status >= 8 && status <= 10) return "danger";
  if (status === 4) return "success";
  if (status === 1 || status === 3 || status === 6) return "warning";
  if (status === 2) return "info";
  return "neutral";
}

export const isRunning = (r: Pick<DesktopRun, "status">) => r.status === 2;

/** Run time: started → completed, or so far while it runs; null before it starts. */
export function runDuration(r: Pick<DesktopRun, "startedOn" | "completedOn" | "status">, now = Date.now()): number | null {
  if (!r.startedOn) return null;
  const start = Date.parse(r.startedOn);
  const end = r.completedOn ? Date.parse(r.completedOn) : isRunning(r) ? now : null;
  return end === null ? null : Math.max(0, end - start);
}

/** A machine that sent a heartbeat this recently counts as connected. */
const ONLINE_MS = 15 * 60_000;

export type MachineHealth = "online" | "offline" | "inactive";

export function machineHealth(m: FlowMachine, now = Date.now()): MachineHealth {
  if (m.state !== 0) return "inactive";
  return m.lastHeartbeat && now - Date.parse(m.lastHeartbeat) < ONLINE_MS ? "online" : "offline";
}

export const HEALTH_LABEL: Record<MachineHealth, string> = {
  online: "Seen recently",
  offline: "Not seen recently",
  inactive: "Inactive / maintenance",
};

export const HEALTH_DOT: Record<MachineHealth, string> = {
  online: "bg-success",
  offline: "bg-line-strong",
  inactive: "bg-warning",
};

/** "3 min ago", "2 h ago", "4 days ago". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  const days = Math.floor(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
