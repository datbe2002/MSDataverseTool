// Per-connection cache of cloud flows and their definitions (Flows tool).
import { create } from "zustand";
import { api } from "../api";
import type { FlowCall, FlowList } from "../types";

export type FlowsStatus = "loading" | "ready" | "error";

interface FlowsStore {
  lists: Record<string, FlowList>;
  status: Record<string, FlowsStatus>;
  errors: Record<string, string>;
  /** keyed by `${connectionId}|${flowId}` */
  definitions: Record<string, string>;
  definitionErrors: Record<string, string>;
  /** Child flow calls per connection; read on demand (it loads every definition). */
  calls: Record<string, FlowCall[]>;
  callsStatus: Record<string, FlowsStatus>;
  callsErrors: Record<string, string>;
  /** `force` re-reads the environment (the Refresh button). */
  loadFlows: (connId: string, force?: boolean) => void;
  loadDefinition: (connId: string, flowId: string) => void;
  loadCalls: (connId: string) => void;
}

export const definitionKey = (connId: string, flowId: string) => `${connId}|${flowId}`;

const inflight = new Set<string>();

export const useFlows = create<FlowsStore>((set, get) => ({
  lists: {},
  status: {},
  errors: {},
  definitions: {},
  definitionErrors: {},
  calls: {},
  callsStatus: {},
  callsErrors: {},

  loadFlows: (connId, force = false) => {
    const s = get();
    if (!force && (s.lists[connId] || s.status[connId] === "error")) return;
    const key = `list|${connId}`;
    if (inflight.has(key)) return;
    inflight.add(key);

    set((st) => ({ status: { ...st.status, [connId]: "loading" } }));
    api
      .listFlows(connId)
      .then((list) =>
        set((st) => {
          // Definitions may have changed too; drop this environment's.
          const prefix = `${connId}|`;
          const keep = <T,>(r: Record<string, T>) =>
            force ? Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith(prefix))) : r;
          const { [connId]: _calls, ...calls } = st.calls;
          const { [connId]: _callsStatus, ...callsStatus } = st.callsStatus;
          return {
            lists: { ...st.lists, [connId]: list },
            status: { ...st.status, [connId]: "ready" },
            definitions: keep(st.definitions),
            definitionErrors: keep(st.definitionErrors),
            ...(force ? { calls, callsStatus } : {}),
          };
        })
      )
      .catch((e) =>
        set((st) => ({
          status: { ...st.status, [connId]: "error" },
          errors: { ...st.errors, [connId]: String(e) },
        }))
      )
      .finally(() => inflight.delete(key));
  },

  loadDefinition: (connId, flowId) => {
    const key = definitionKey(connId, flowId);
    const s = get();
    if (s.definitions[key] !== undefined || s.definitionErrors[key] || inflight.has(key)) return;
    inflight.add(key);
    api
      .flowDefinition(connId, flowId)
      .then((json) => set((st) => ({ definitions: { ...st.definitions, [key]: json } })))
      .catch((e) =>
        set((st) => ({ definitionErrors: { ...st.definitionErrors, [key]: String(e) } }))
      )
      .finally(() => inflight.delete(key));
  },

  loadCalls: (connId) => {
    const key = `calls|${connId}`;
    if (get().calls[connId] || inflight.has(key)) return;
    inflight.add(key);
    set((st) => ({ callsStatus: { ...st.callsStatus, [connId]: "loading" } }));
    api
      .flowCalls(connId)
      .then((calls) =>
        set((st) => ({
          calls: { ...st.calls, [connId]: calls },
          callsStatus: { ...st.callsStatus, [connId]: "ready" },
        }))
      )
      .catch((e) =>
        set((st) => ({
          callsStatus: { ...st.callsStatus, [connId]: "error" },
          callsErrors: { ...st.callsErrors, [connId]: String(e) },
        }))
      )
      .finally(() => inflight.delete(key));
  },
}));

export interface FlowSummary {
  triggers: { name: string; type: string }[];
  /** Every action, including the ones nested in scopes, conditions and loops. */
  actionCount: number;
  /** Connector names, e.g. "shared_sharepointonline" → "sharepointonline". */
  connectors: string[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function countActions(actions: unknown): number {
  if (!isObject(actions)) return 0;
  let n = 0;
  for (const action of Object.values(actions)) {
    if (!isObject(action)) continue;
    n += 1;
    n += countActions(action.actions);
    if (isObject(action.else)) n += countActions(action.else.actions);
    if (isObject(action.cases)) {
      for (const c of Object.values(action.cases)) if (isObject(c)) n += countActions(c.actions);
    }
    if (isObject(action.default)) n += countActions(action.default.actions);
  }
  return n;
}

/** Reads the parts worth a glance out of a definition; null if it isn't a flow. */
export function summarize(definitionJson: string): FlowSummary | null {
  let root: unknown;
  try {
    root = JSON.parse(definitionJson);
  } catch {
    return null;
  }
  const props = isObject(root) && isObject(root.properties) ? root.properties : null;
  const def = props && isObject(props.definition) ? props.definition : null;
  if (!def) return null;

  const triggers = isObject(def.triggers)
    ? Object.entries(def.triggers).map(([name, t]) => {
        const type = isObject(t) ? [t.type, t.kind].filter((x) => typeof x === "string").join(" · ") : "";
        return { name: name.replace(/_/g, " "), type };
      })
    : [];

  const refs = props && isObject(props.connectionReferences) ? props.connectionReferences : {};
  const connectors = [
    ...new Set(
      Object.entries(refs).map(([key, ref]) => {
        const api = isObject(ref) && isObject(ref.api) && typeof ref.api.name === "string" ? ref.api.name : key;
        return api.replace(/^shared_/, "");
      })
    ),
  ].sort();

  return { triggers, actionCount: countActions(def.actions), connectors };
}
