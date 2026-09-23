import type { Cell, QueryResult } from "../types";

function cellToString(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv(result: QueryResult): string {
  const header = result.columns.map((c) => csvEscape(c.name)).join(",");
  const lines = result.rows.map((row) =>
    row.map((cell) => csvEscape(cellToString(cell))).join(",")
  );
  return [header, ...lines].join("\r\n");
}

export function toJson(result: QueryResult): string {
  const names = result.columns.map((c) => c.name);
  const objs = result.rows.map((row) => {
    const o: Record<string, Cell> = {};
    names.forEach((n, i) => {
      o[n] = row[i] ?? null;
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}
