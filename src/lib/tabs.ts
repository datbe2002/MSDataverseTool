// Query tabs, persisted per connection so each environment keeps its own set
// of open queries.

export const MAX_TABS = 5;

/** What we persist to localStorage (results are transient and not saved). */
export interface PersistedTab {
  id: string;
  /** live draft (kept across restarts so work is never lost) */
  sql: string;
  /** last explicitly-saved snapshot; when it differs from `sql` the tab is unsaved */
  savedSql?: string;
  /** custom name; when empty the title is derived from the SQL */
  title?: string;
}

const KEY = "cds.tabsByConn";

export function genTabId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A short label for the tab, derived from the first meaningful line of SQL. */
export function tabTitle(sql: string): string {
  const line = sql
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("--"));
  if (!line) return "New query";
  const clean = line.replace(/\s+/g, " ");
  return clean.length > 28 ? clean.slice(0, 28) + "…" : clean;
}

export function loadTabsMap(): Record<string, PersistedTab[]> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, PersistedTab[]>) : {};
  } catch {
    return {};
  }
}

export function saveTabsMap(map: Record<string, PersistedTab[]>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}
