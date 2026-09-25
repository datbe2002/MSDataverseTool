// Plug-in registrations (Plug-in steps tool), loaded in layers:
// - the overview (assemblies, types, endpoints, a slim step index) opens the tool
//   and gives every count;
// - a handler's or a table's steps load when its node is opened;
// - one step's images and configuration load when it's picked.
import { api } from "../api";
import { createEnvCache } from "./envCache";
import { shortType } from "./traces";
import type { PluginOverview, PluginStep, PluginStepDetail, StepQuery } from "../types";

/** Key "hide" leaves out Microsoft's assemblies; "all" doesn't. */
export const overviewCache = createEnvCache<PluginOverview>((c, key) => api.pluginOverview(c, key !== "all"));

/** Keys: "handler:<id>", "table:<logical name>", "search:<text>". */
export const stepsCache = createEnvCache<PluginStep[]>((c, key) => api.pluginSteps(c, queryOf(key)));

export const stepCache = createEnvCache<PluginStepDetail>((c, id) => api.pluginStep(c, id));

function queryOf(key: string): StepQuery {
  const i = key.indexOf(":");
  const [kind, value] = [key.slice(0, i), key.slice(i + 1)];
  return kind === "handler" ? { handler: value } : kind === "table" ? { table: value } : { search: value };
}

export interface Counts {
  total: number;
  disabled: number;
}

export interface Index {
  byHandler: Map<string, Counts>;
  byTable: Map<string, Counts>;
  /** Steps whose handler isn't shown (Microsoft's, or outside the custom assemblies). */
  hidden: number;
  /** Handlers the tree shows (custom plug-in types and endpoints). */
  visible: Set<string>;
}

/** Counts per handler and per table from the step index; tables count only shown handlers. */
export function indexOf(o: PluginOverview): Index {
  const visible = new Set([...o.types.map((t) => t.id), ...o.endpoints.map((e) => e.id)]);
  const byHandler = new Map<string, Counts>();
  const byTable = new Map<string, Counts>();
  let hidden = 0;
  const add = (map: Map<string, Counts>, key: string, enabled: boolean) => {
    const c = map.get(key) ?? map.set(key, { total: 0, disabled: 0 }).get(key)!;
    c.total += 1;
    if (!enabled) c.disabled += 1;
  };
  for (const s of o.steps) {
    if (s.handler) add(byHandler, s.handler, s.enabled);
    if (!s.handler || !visible.has(s.handler)) {
      hidden += 1;
      continue;
    }
    add(byTable, s.table, s.enabled);
  }
  return { byHandler, byTable, hidden, visible };
}

export type NodeKind = "assembly" | "type" | "endpoints" | "endpoint" | "table" | "message" | "step";

export interface TreeNode {
  /** Unique in the tree: "<kind>:<id>" (a message: "message:<table>|<message>"). */
  key: string;
  kind: NodeKind;
  label: string;
  sub?: string;
  /** Shown faded (a disabled step). */
  dim?: boolean;
  tag?: string;
  count?: Counts;
  /** Known children… */
  children?: TreeNode[];
  /** …or the steps cache key they load from when the node opens. */
  lazy?: string;
}

const byLabel = (a: TreeNode, b: TreeNode) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

export const stepSub = (s: PluginStep) => [s.stageLabel, `#${s.rank}`, s.mode === 1 ? "async" : null].filter(Boolean).join(" · ");

export function stepNode(s: PluginStep, label: string): TreeNode {
  return { key: `step:${s.id}`, kind: "step", label, sub: stepSub(s), dim: !s.enabled, tag: s.enabled ? undefined : "off" };
}

/** Assembly → plug-in type → (loaded) steps; service endpoints in their own group. */
export function treeByAssembly(o: PluginOverview, ix: Index): TreeNode[] {
  const assemblies: TreeNode[] = o.assemblies.map((a) => {
    const types: TreeNode[] = o.types
      .filter((t) => t.assemblyId === a.id)
      .map((t) => ({
        key: `type:${t.id}`,
        kind: "type" as const,
        label: shortType(t.typeName),
        sub: t.typeName,
        tag: t.isWorkflowActivity ? "activity" : undefined,
        count: ix.byHandler.get(t.id),
        lazy: ix.byHandler.has(t.id) ? `handler:${t.id}` : undefined,
        children: ix.byHandler.has(t.id) ? undefined : [],
      }))
      .sort(byLabel);
    const count = types.reduce<Counts>((c, t) => ({ total: c.total + (t.count?.total ?? 0), disabled: c.disabled + (t.count?.disabled ?? 0) }), {
      total: 0,
      disabled: 0,
    });
    return {
      key: `assembly:${a.id}`,
      kind: "assembly" as const,
      label: a.name,
      sub: [a.version, a.isolation === "Sandbox" ? null : `isolation: ${a.isolation}`].filter(Boolean).join(" · "),
      tag: a.managed ? "managed" : undefined,
      count,
      children: types,
    };
  });
  if (o.endpoints.length) {
    assemblies.push({
      key: "endpoints:all",
      kind: "endpoints",
      label: "Service endpoints & webhooks",
      children: o.endpoints.map((e) => ({
        key: `endpoint:${e.id}`,
        kind: "endpoint" as const,
        label: e.name,
        sub: e.contract,
        count: ix.byHandler.get(e.id),
        lazy: ix.byHandler.has(e.id) ? `handler:${e.id}` : undefined,
        children: ix.byHandler.has(e.id) ? undefined : [],
      })),
    });
  }
  return assemblies;
}

/** Table → (loaded) messages → steps in the order they run. */
export function treeByTable(ix: Index, tableLabel: (t: string) => string | undefined): TreeNode[] {
  return [...ix.byTable.entries()]
    .map(([table, count]) => ({
      key: `table:${table}`,
      kind: "table" as const,
      label: table === "none" ? "(no table)" : table,
      sub: table === "none" ? "Messages that don't run on a table" : tableLabel(table),
      count,
      lazy: `table:${table}`,
    }))
    .sort((a, b) => (a.label === "(no table)" ? 1 : b.label === "(no table)" ? -1 : byLabel(a, b)));
}

/** Children of a lazy node from its loaded steps (hidden handlers and, if asked, disabled steps left out). */
export function childrenFrom(node: TreeNode, steps: PluginStep[], ix: Index, hideDisabled: boolean): TreeNode[] {
  const shown = steps.filter((s) => (!hideDisabled || s.enabled) && (!s.handlerId || ix.visible.has(s.handlerId)));
  if (node.kind !== "table") {
    return shown.map((s) => stepNode(s, `${s.message} · ${s.table === "none" ? "any table" : s.table}`));
  }
  const byMessage = new Map<string, PluginStep[]>();
  for (const s of shown) (byMessage.get(s.message) ?? byMessage.set(s.message, []).get(s.message)!).push(s);
  const table = node.key.slice("table:".length);
  return [...byMessage.entries()]
    .map(([message, list]) => ({
      key: `message:${table}|${message}`,
      kind: "message" as const,
      label: message,
      count: { total: list.length, disabled: list.filter((s) => !s.enabled).length },
      children: runOrder(list).map((s) => stepNode(s, shortType(s.handlerName ?? s.name))),
    }))
    .sort(byLabel);
}

/** Steps in the order they run: stage, then rank. */
export function runOrder(steps: PluginStep[]): PluginStep[] {
  return [...steps].sort((a, b) => a.stage - b.stage || a.rank - b.rank || a.name.localeCompare(b.name));
}

export type Resolved = { status: "ready"; nodes: TreeNode[] } | { status: "loading" } | { status: "error"; error: string };

export type Row =
  | { type: "node"; node: TreeNode; depth: number; open: boolean; expandable: boolean }
  | { type: "loading" | "error" | "empty"; key: string; depth: number; error?: string; parent: TreeNode };

/** The rows on screen: open nodes show their children, lazy ones once loaded. */
export function visibleRows(nodes: TreeNode[], open: Set<string>, resolve: (n: TreeNode) => Resolved): Row[] {
  const out: Row[] = [];
  const walk = (list: TreeNode[], depth: number) => {
    for (const node of list) {
      const expandable = node.kind !== "step" && (!!node.lazy || (node.children?.length ?? 0) > 0);
      const isOpen = expandable && open.has(node.key);
      out.push({ type: "node", node, depth, open: isOpen, expandable });
      if (!isOpen) continue;
      const r = resolve(node);
      if (r.status === "ready") {
        if (r.nodes.length) walk(r.nodes, depth + 1);
        else out.push({ type: "empty", key: `${node.key}#empty`, depth: depth + 1, parent: node });
      } else out.push({ type: r.status, key: `${node.key}#${r.status}`, depth: depth + 1, error: r.status === "error" ? r.error : undefined, parent: node });
    }
  };
  walk(nodes, 0);
  return out;
}

/** The nodes (not loaded steps) whose label matches every word of `q`, with their ancestors. */
export function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return nodes;
  const hit = (n: TreeNode) => words.every((w) => `${n.label} ${n.sub ?? ""}`.toLowerCase().includes(w));
  const walk = (list: TreeNode[]): TreeNode[] =>
    list.flatMap((n) => {
      if (hit(n)) return [n];
      const children = walk(n.children ?? []);
      return children.length ? [{ ...n, children, lazy: undefined }] : [];
    });
  return walk(nodes);
}
