// Metadata hooks for pickers, cached per environment: tables and columns
// come from `useSchema`, choice labels from `useChoices`.
import { useEffect } from "react";
import { columnKey, useSchema } from "./schema";
import { useChoices } from "./flowChoices";
import type { ColumnMeta, TableChoices } from "../types";

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
