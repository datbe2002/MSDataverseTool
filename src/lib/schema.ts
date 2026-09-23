// Per-connection cache of table / column metadata used by editor autocomplete.
import { create } from "zustand";
import { api } from "../api";
import type { ColumnMeta, TableMeta } from "../types";

export type SchemaStatus = "loading" | "ready" | "error";

interface SchemaStore {
  tables: Record<string, TableMeta[]>;
  /** keyed by `${connectionId}|${table}` */
  columns: Record<string, ColumnMeta[]>;
  status: Record<string, SchemaStatus>;
  errors: Record<string, string>;
  loadTables: (connId: string) => Promise<TableMeta[]>;
  loadColumns: (connId: string, table: string) => Promise<ColumnMeta[]>;
  reset: (connId: string) => void;
}

// De-duplicates concurrent requests (the editor asks on every keystroke).
const inflight = new Map<string, Promise<any>>();

export const columnKey = (connId: string, table: string) =>
  `${connId}|${table.toLowerCase()}`;

export const useSchema = create<SchemaStore>((set, get) => ({
  tables: {},
  columns: {},
  status: {},
  errors: {},

  loadTables: (connId) => {
    const s = get();
    if (s.tables[connId]) return Promise.resolve(s.tables[connId]);
    // Don't hammer the API after a failure; the toolbar offers a retry.
    if (s.status[connId] === "error") return Promise.resolve([]);
    const key = `tables|${connId}`;
    const pending = inflight.get(key);
    if (pending) return pending;

    set((st) => ({ status: { ...st.status, [connId]: "loading" } }));
    const p = api
      .listTables(connId)
      .then((tables) => {
        set((st) => ({
          tables: { ...st.tables, [connId]: tables },
          status: { ...st.status, [connId]: "ready" },
        }));
        return tables;
      })
      .catch((e) => {
        set((st) => ({
          status: { ...st.status, [connId]: "error" },
          errors: { ...st.errors, [connId]: String(e) },
        }));
        return [] as TableMeta[];
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  },

  loadColumns: (connId, table) => {
    const key = columnKey(connId, table);
    const cached = get().columns[key];
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(key);
    if (pending) return pending;

    const p = api
      .listColumns(connId, table)
      .catch((e) => {
        console.warn(`Failed to load columns for ${table}:`, e);
        return [] as ColumnMeta[];
      })
      .then((cols) => {
        set((st) => ({ columns: { ...st.columns, [key]: cols } }));
        return cols;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  },

  reset: (connId) =>
    set((st) => {
      const prefix = `${connId}|`;
      const columns = Object.fromEntries(
        Object.entries(st.columns).filter(([k]) => !k.startsWith(prefix))
      );
      const { [connId]: _t, ...tables } = st.tables;
      const { [connId]: _s, ...status } = st.status;
      const { [connId]: _e, ...errors } = st.errors;
      return { tables, columns, status, errors };
    }),
}));
