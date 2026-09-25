// Dependency checks per connection (Dependencies tool): the last target and
// its results, kept while the app runs.
import { create } from "zustand";
import { api } from "../api";
import { friendlyError } from "./errors";
import type { DependencyReport, FlowMention } from "../types";

export interface DepsState {
  table: string;
  column: string;
  /** Only what blocks deleting it (vs everything that uses it). */
  forDelete: boolean;
  status: "idle" | "loading" | "ready" | "error";
  report: DependencyReport | null;
  error: string | null;
  flows: { status: "idle" | "loading" | "ready" | "error"; list: FlowMention[]; error: string | null; target: string };
}

const EMPTY: DepsState = {
  table: "",
  column: "",
  forDelete: true,
  status: "idle",
  report: null,
  error: null,
  flows: { status: "idle", list: [], error: null, target: "" },
};

interface DepsStore {
  byConn: Record<string, DepsState>;
  set: (connId: string, patch: Partial<DepsState>) => void;
  check: (connId: string) => void;
  searchFlows: (connId: string) => void;
}

export const depsOf = (s: DepsStore, connId: string | null) => (connId && s.byConn[connId]) || EMPTY;

let generation = 0;

export const useDeps = create<DepsStore>((set, get) => {
  const patch = (connId: string, p: Partial<DepsState>) =>
    set((s) => ({ byConn: { ...s.byConn, [connId]: { ...depsOf(s, connId), ...p } } }));
  return {
    byConn: {},
    set: patch,

    check: (connId) => {
      const { table, column, forDelete } = depsOf(get(), connId);
      if (!table.trim()) return;
      const gen = ++generation;
      patch(connId, { status: "loading", error: null, flows: EMPTY.flows });
      api
        .componentDependencies(connId, table.trim(), column.trim() || null, forDelete)
        .then((report) => gen === generation && patch(connId, { status: "ready", report }))
        .catch((e) => gen === generation && patch(connId, { status: "error", error: friendlyError(String(e)), report: null }));
    },

    searchFlows: (connId) => {
      const s = depsOf(get(), connId);
      const report = s.report;
      if (!report) return;
      const [table, column] = report.target.split(".");
      patch(connId, { flows: { status: "loading", list: [], error: null, target: report.target } });
      api
        .flowsMentioning(connId, table, column ?? null)
        .then((list) => patch(connId, { flows: { status: "ready", list, error: null, target: report.target } }))
        .catch((e) => patch(connId, { flows: { status: "error", list: [], error: friendlyError(String(e)), target: report.target } }));
    },
  };
});
