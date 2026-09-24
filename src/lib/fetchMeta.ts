// Metadata the FetchXML builder needs, cached per environment: columns come
// from `useSchema`, choice labels from `useChoices`; relationships live here.
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../api";
import { columnKey, useSchema } from "./schema";
import { useChoices } from "./flowChoices";
import type { ColumnMeta, Relationship, TableChoices } from "../types";

type Entry = Relationship[] | "loading" | "error";

interface RelationshipStore {
  /** keyed by `${connectionId}|${table}` */
  tables: Record<string, Entry>;
  load: (connId: string, table: string) => void;
}

export const useRelationships = create<RelationshipStore>((set, get) => ({
  tables: {},
  load: (connId, table) => {
    const key = `${connId}|${table.toLowerCase()}`;
    if (get().tables[key]) return;
    set((s) => ({ tables: { ...s.tables, [key]: "loading" } }));
    api
      .listRelationships(connId, table)
      .then((r) => set((s) => ({ tables: { ...s.tables, [key]: r } })))
      .catch(() => set((s) => ({ tables: { ...s.tables, [key]: "error" } })));
  },
}));

const NAME = /^[A-Za-z0-9_]+$/;

/** Columns of `table` (loaded on first use); undefined while loading. */
export function useColumns(connId: string, table: string | null): ColumnMeta[] | undefined {
  const valid = !!table && NAME.test(table);
  const cols = useSchema((s) => (valid ? s.columns[columnKey(connId, table!)] : undefined));
  useEffect(() => {
    if (valid) void useSchema.getState().loadColumns(connId, table!);
  }, [connId, table, valid]);
  return cols;
}

/** Relationships of `table`: a list, "loading" or "error". */
export function useTableRelationships(connId: string, table: string | null): Entry | undefined {
  const valid = !!table && NAME.test(table);
  const entry = useRelationships((s) => (valid ? s.tables[`${connId}|${table!.toLowerCase()}`] : undefined));
  useEffect(() => {
    if (valid) useRelationships.getState().load(connId, table!);
  }, [connId, table, valid]);
  return entry;
}

/** Choice options of `table`'s columns, once loaded. */
export function useTableChoices(connId: string, table: string | null): TableChoices | undefined {
  const valid = !!table && NAME.test(table);
  const entry = useChoices((s) => (valid ? s.tables[`${connId}|${table}`] : undefined));
  useEffect(() => {
    if (valid) useChoices.getState().load(connId, table!);
  }, [connId, table, valid]);
  return entry && typeof entry !== "string" ? entry : undefined;
}

/** Tables of the environment (loaded on first use); `loading` is false after a failure too. */
export function useTables(connId: string) {
  const tables = useSchema((s) => s.tables[connId]);
  const loading = useSchema((s) => s.status[connId] === "loading");
  useEffect(() => {
    void useSchema.getState().loadTables(connId);
  }, [connId]);
  return { tables, loading };
}
