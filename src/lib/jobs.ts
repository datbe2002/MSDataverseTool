// System jobs (`asyncoperation`) per connection (System jobs tool).
import { api } from "../api";
import { createPagedStore, sinceOf, type TimeRange } from "./pagedStore";
import type { JobDetail, JobFilter, JobPage, JobRow, JobStatusFilter } from "../types";

/** What the filter controls hold (text as typed). */
export interface JobFilters {
  range: TimeRange;
  name: string;
  status: "" | JobStatusFilter;
  /** `operationtype` as a string ("" = any). */
  operationType: string;
  entity: string;
  text: string;
  correlationId: string;
  regardingId: string;
  /** Shown on the "one record" chip. */
  regardingName: string;
}

export const DEFAULT_JOB_FILTERS: JobFilters = {
  range: "24h",
  name: "",
  status: "",
  operationType: "",
  entity: "",
  text: "",
  correlationId: "",
  regardingId: "",
  regardingName: "",
};

export const JOB_STATUSES: { key: JobFilters["status"]; label: string }[] = [
  { key: "", label: "Any status" },
  { key: "failed", label: "Failed" },
  { key: "waiting", label: "Waiting" },
  { key: "queued", label: "Waiting for resources" },
  { key: "inprogress", label: "In progress" },
  { key: "succeeded", label: "Succeeded" },
  { key: "canceled", label: "Canceled" },
];

/** The job types people look for most (`operationtype`). */
export const JOB_TYPES: { value: string; label: string }[] = [
  { value: "", label: "Any type" },
  { value: "10", label: "Workflow" },
  { value: "1", label: "System Event (async plug-in)" },
  { value: "54", label: "Execute Async Request" },
  { value: "13", label: "Bulk Delete" },
  { value: "5", label: "Import" },
  { value: "57", label: "Calculate Rollup Field" },
  { value: "58", label: "Mass Calculate Rollup Field" },
  { value: "203", label: "Import Solution" },
  { value: "202", label: "Export Solution" },
  { value: "204", label: "Publish All" },
  { value: "207", label: "Delete And Promote" },
  { value: "90", label: "Cascade Assign" },
  { value: "91", label: "Cascade Delete" },
];

export function toServerFilter(f: JobFilters): JobFilter {
  const text = (s: string) => s.trim() || null;
  return {
    since: sinceOf(f.range),
    name: text(f.name),
    status: f.status || null,
    operationType: f.operationType ? Number(f.operationType) : null,
    entity: text(f.entity)?.toLowerCase() ?? null,
    text: text(f.text),
    correlationId: text(f.correlationId),
    regardingId: text(f.regardingId),
  };
}

const store = createPagedStore<JobFilters, JobRow, JobPage, JobDetail>({
  defaults: DEFAULT_JOB_FILTERS,
  fetchPage: (connId, f, next) => api.systemJobs(connId, next ? {} : toServerFilter(f), next),
  fetchDetail: api.systemJob,
});
export const useJobs = store.useStore;
export const jobFiltersOf = store.filtersOf;

export type JobTone = "danger" | "success" | "warning" | "info" | "neutral";

/** How a status reads at a glance. */
export function jobTone(status: number): JobTone {
  if (status === 31) return "danger";
  if (status === 30) return "success";
  if (status === 10 || status === 0) return "warning";
  if (status >= 20 && status <= 22) return "info";
  return "neutral";
}

export const TONE_DOT: Record<JobTone, string> = {
  danger: "bg-danger",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  neutral: "bg-line-strong",
};

export const TONE_BADGE: Record<JobTone, string> = {
  danger: "badge-danger",
  success: "badge-success",
  warning: "badge-warning",
  info: "badge-info",
  neutral: "badge-neutral",
};

/** Run time: started → completed, or so far while it runs; null before it starts. */
export function jobDuration(job: Pick<JobRow, "startedOn" | "completedOn" | "state">, now = Date.now()): number | null {
  if (!job.startedOn) return null;
  const start = Date.parse(job.startedOn);
  const end = job.completedOn ? Date.parse(job.completedOn) : job.state === 2 ? now : null;
  return end === null ? null : Math.max(0, end - start);
}

/** Dataverse error codes read as hex: -2147220891 → 0x80040265. */
export const hexCode = (code: number) => `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
