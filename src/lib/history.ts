// Local query history (persisted in localStorage, newest first).

export type HistoryStatus = "ok" | "write" | "error";

export interface HistoryEntry {
  id: string;
  sql: string;
  connectionId: string;
  connectionName: string;
  host: string;
  status: HistoryStatus;
  /** rows returned (ok) or records written (write) */
  rows?: number;
  ms: number;
  at: number;
  error?: string;
}

const KEY = "cds.history";
const MAX = 300;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch {
    /* quota / private mode */
  }
}

export function relativeTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString();
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Query counts per day for the last `days` days (oldest first). */
export function dailyCounts(entries: HistoryEntry[], days: number): number[] {
  const today = startOfDay(Date.now());
  const counts = new Array<number>(days).fill(0);
  for (const e of entries) {
    const diff = Math.round((today - startOfDay(e.at)) / 86_400_000);
    if (diff >= 0 && diff < days) counts[days - 1 - diff]++;
  }
  return counts;
}

export function isToday(at: number) {
  return startOfDay(at) === startOfDay(Date.now());
}
