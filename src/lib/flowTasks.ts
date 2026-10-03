// Flow tasks: the flows of one assigned task checked out into a folder, where
// someone else (another Claude) edits them. The store keeps the task list,
// each open task's files (polled to notice edits) and the flows as they are in
// the environment; the helpers say what changed and what looks broken.
import { create } from "zustand";
import { api } from "../api";
import { buildOutline, pathKey, type OutlineNode } from "./flowOutline";
import { indexFlow, locationOf, ownPart } from "./flowRefs";
import type { FlowMeta, LiveTaskFlow, TaskFlow, TaskFlowFile, TaskSummary, TaskView } from "../types";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** How often an open task's files are read again (they're edited outside the app). */
export const POLL_MS = 2000;

export interface LiveState {
  flows: LiveTaskFlow[];
  /** When it was read (ms). */
  at: number;
}

interface FlowTasksStore {
  list: TaskSummary[] | null;
  listError: string | null;
  /** By task folder path. */
  views: Record<string, TaskView>;
  viewErrors: Record<string, string>;
  live: Record<string, LiveState>;
  liveLoading: Record<string, boolean>;
  liveErrors: Record<string, string>;
  loadList: () => Promise<void>;
  /** Reads the task again; quiet = keep showing the old one on failure. */
  loadView: (path: string) => Promise<void>;
  /** A change returned the task as it is now. */
  setView: (view: TaskView) => void;
  loadLive: (connId: string, path: string) => Promise<void>;
  forgetLocal: (path: string) => void;
}

export const useFlowTasks = create<FlowTasksStore>((set, get) => ({
  list: null,
  listError: null,
  views: {},
  viewErrors: {},
  live: {},
  liveLoading: {},
  liveErrors: {},

  loadList: async () => {
    try {
      const list = await api.flowTasks();
      set({ list, listError: null });
    } catch (e) {
      set({ listError: String(e) });
    }
  },

  loadView: async (path) => {
    try {
      const view = await api.flowTask(path);
      const old = get().views[path];
      // Polled every few seconds: only re-render when something changed.
      if (old && JSON.stringify(old) === JSON.stringify(view)) {
        if (get().viewErrors[path]) set((s) => ({ viewErrors: without(s.viewErrors, path) }));
        return;
      }
      set((s) => ({ views: { ...s.views, [path]: view }, viewErrors: without(s.viewErrors, path) }));
    } catch (e) {
      set((s) => ({ viewErrors: { ...s.viewErrors, [path]: String(e) } }));
    }
  },

  setView: (view) => {
    set((s) => ({ views: { ...s.views, [view.path]: view } }));
    void get().loadList();
  },

  loadLive: async (connId, path) => {
    if (get().liveLoading[path]) return;
    set((s) => ({ liveLoading: { ...s.liveLoading, [path]: true } }));
    try {
      const flows = await api.taskLive(connId, path);
      set((s) => ({ live: { ...s.live, [path]: { flows, at: Date.now() } }, liveErrors: without(s.liveErrors, path) }));
    } catch (e) {
      set((s) => ({ liveErrors: { ...s.liveErrors, [path]: String(e) } }));
    } finally {
      set((s) => ({ liveLoading: without(s.liveLoading, path) }));
    }
  },

  forgetLocal: (path) =>
    set((s) => ({
      views: without(s.views, path),
      viewErrors: without(s.viewErrors, path),
      live: without(s.live, path),
      liveErrors: without(s.liveErrors, path),
    })),
}));

function without<T>(r: Record<string, T>, key: string): Record<string, T> {
  if (!(key in r)) return r;
  const { [key]: _gone, ...rest } = r;
  return rest;
}

// ---------------------------------------------------------------- status

export type FlowStatus = "missing" | "invalid" | "unchanged" | "modified" | "reviewed";

export const STATUS_LABEL: Record<FlowStatus, string> = {
  missing: "File missing",
  invalid: "Invalid JSON",
  unchanged: "Not changed",
  modified: "Modified",
  reviewed: "Reviewed",
};

export const STATUS_BADGE: Record<FlowStatus, string> = {
  missing: "badge-danger",
  invalid: "badge-danger",
  unchanged: "badge-neutral",
  modified: "badge-warning",
  reviewed: "badge-success",
};

export const STATUS_DOT: Record<FlowStatus, string> = {
  missing: "bg-danger",
  invalid: "bg-danger",
  unchanged: "bg-line-strong",
  modified: "bg-warning",
  reviewed: "bg-success",
};

export function flowStatus(flow: TaskFlow, file: TaskFlowFile | undefined): FlowStatus {
  if (!file || (!file.workingHash && file.error?.includes("missing"))) return "missing";
  if (!file.workingHash) return "invalid";
  if (file.workingHash === flow.baselineHash) return "unchanged";
  return flow.reviewedHash === file.workingHash ? "reviewed" : "modified";
}

/** The flow changed in the environment since it was added; null = not read yet. */
export function drifted(flow: TaskFlow, live: LiveState | undefined): boolean | null {
  const l = live?.flows.find((f) => f.id === flow.id);
  if (!l || !l.hash) return null;
  return l.hash !== flow.baselineHash;
}

/** A folder name from a task name: letters, digits, `-` and `_`. */
export function folderName(name: string): string {
  const out = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .replace(/[^A-Za-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return out;
}

// ---------------------------------------------------------------- text for diffs

/** The designer rewrites these on every save; they say nothing about the flow. */
function stripDesignerMetadata(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDesignerMetadata);
  if (!isObject(v)) return v;
  const out: Json = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === "metadata" && isObject(val)) {
      const { operationMetadataId: _id, ...rest } = val;
      const cleaned = stripDesignerMetadata(rest) as Json;
      if (Object.keys(cleaned).length) out[k] = cleaned;
      continue;
    }
    out[k] = stripDesignerMetadata(val);
  }
  return out;
}

/** The text a diff shows: re-indented, without designer ids when asked; text that isn't JSON as is. */
export function diffText(text: string, ignoreMetadata: boolean): string {
  try {
    const v = JSON.parse(text.replace(/^﻿/, ""));
    return JSON.stringify(ignoreMetadata ? stripDesignerMetadata(v) : v, null, 2) + "\n";
  } catch {
    return text;
  }
}

/** JSON with sorted keys, for comparing values. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

// ---------------------------------------------------------------- what changed

export type ChangeKind = "added" | "removed" | "changed" | "renamed" | "moved" | "trigger" | "connection" | "settings";

export interface FlowChange {
  kind: ChangeKind;
  /** Step / trigger / connection reference name, as people read it. */
  name: string;
  /** e.g. "inputs, runs after"; "from Scope › Try"; "was Get items". */
  detail: string;
  /** Where to show it: the side that has it, and its JSON path there. */
  side: "left" | "right";
  path: string[];
  /** Friendly step type, when it's a step. */
  type?: string;
  /** The same step / trigger on the other side (changed, moved, renamed). */
  other?: string[];
}

interface StepInfo {
  node: OutlineNode;
  /** Path of the container the step sits in. */
  scope: string;
  /** Its own settings without `runAfter`, comparable. */
  own: string;
  ownFields: Json;
  runAfter: string;
}

function steps(outline: OutlineNode[]): Map<string, StepInfo> {
  const map = new Map<string, StepInfo>();
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      if (n.kind !== "branch" && n.kind !== "trigger") {
        const own = (stripDesignerMetadata(ownPart(n)) ?? {}) as Json;
        const { runAfter: _runAfter, ...rest } = own;
        map.set(n.key, { node: n, scope: n.path.slice(0, -1).join("\u0001"), own: stable(rest), ownFields: rest, runAfter: stable(n.after) });
      }
      walk(n.children);
    }
  };
  walk(outline);
  return map;
}

/** "runs after Compose 1", "runs first". */
function runsAfter(n: OutlineNode): string {
  const deps = Object.keys(n.after);
  return deps.length ? `runs after ${deps.map((d) => d.replace(/_/g, " ")).join(", ")}` : "runs first";
}

function changedFields(a: Json, b: Json): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => stable(a[k]) !== stable(b[k]));
}

function readRoot(text: string): Json | null {
  try {
    const v = JSON.parse(text.replace(/^﻿/, ""));
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

function connectionRefs(root: Json | null): Json {
  const props = root && isObject(root.properties) ? root.properties : null;
  return props && isObject(props.connectionReferences) ? props.connectionReferences : {};
}

/** Everything but triggers, actions and connection references. */
function otherSettings(root: Json | null): string {
  if (!root) return "";
  const copy = JSON.parse(JSON.stringify(stripDesignerMetadata(root))) as Json;
  const props = isObject(copy.properties) ? copy.properties : null;
  if (props) {
    delete props.connectionReferences;
    if (isObject(props.definition)) {
      delete props.definition.triggers;
      delete props.definition.actions;
    }
  }
  return stable(copy);
}

/**
 * What changed between two versions of a flow, step by step, in the order of
 * the newer one. Designer metadata is ignored. Empty when either isn't a flow.
 */
export function flowChanges(before: string, after: string): FlowChange[] {
  const left = buildOutline(before);
  const right = buildOutline(after);
  if (!left || !right) return [];
  const out: FlowChange[] = [];

  // Triggers
  const triggers = (o: OutlineNode[]) => new Map(o.filter((n) => n.kind === "trigger").map((n) => [n.key, n]));
  const lt = triggers(left);
  const rt = triggers(right);
  for (const [key, n] of rt) {
    const old = lt.get(key);
    if (!old) out.push({ kind: "trigger", name: n.name, detail: "new trigger", side: "right", path: n.path, type: n.type });
    else {
      const fields = changedFields((stripDesignerMetadata(old.raw) ?? {}) as Json, (stripDesignerMetadata(n.raw) ?? {}) as Json);
      if (fields.length) out.push({ kind: "trigger", name: n.name, detail: fields.join(", "), side: "right", path: n.path, type: n.type, other: old.path });
    }
  }
  for (const [key, n] of lt) {
    if (!rt.has(key)) out.push({ kind: "trigger", name: n.name, detail: "trigger removed", side: "left", path: n.path, type: n.type });
  }

  // Steps
  const ls = steps(left);
  const rs = steps(right);
  const lIndex = indexFlow(left);
  const rIndex = indexFlow(right);
  const added = [...rs.keys()].filter((k) => !ls.has(k));
  const removed = [...ls.keys()].filter((k) => !rs.has(k));
  const renamedFrom = new Map<string, string>();
  for (const a of added) {
    const match = removed.find((r) => !renamedFrom.has(a) && ![...renamedFrom.values()].includes(r) && ls.get(r)!.own === rs.get(a)!.own);
    if (match) renamedFrom.set(a, match);
  }
  const renamedOld = new Set(renamedFrom.values());

  for (const [key, info] of rs) {
    const n = info.node;
    const from = renamedFrom.get(key);
    if (from) {
      out.push({ kind: "renamed", name: n.name, detail: `was ${ls.get(from)!.node.name}`, side: "right", path: n.path, type: n.type, other: ls.get(from)!.node.path });
      continue;
    }
    const old = ls.get(key);
    if (!old) {
      const where = locationOf(rIndex, n);
      out.push({ kind: "added", name: n.name, detail: where ? `in ${where}` : "", side: "right", path: n.path, type: n.type });
      continue;
    }
    if (old.scope !== info.scope) {
      const was = locationOf(lIndex, old.node) || "the top level";
      const now = locationOf(rIndex, n) || "the top level";
      out.push({ kind: "moved", name: n.name, detail: `from ${was} to ${now}`, side: "right", path: n.path, type: n.type, other: old.node.path });
    }
    const fields = changedFields(old.ownFields, info.ownFields);
    const reordered = old.runAfter !== info.runAfter;
    if (reordered && !fields.length && old.scope === info.scope) {
      // Only when it runs changed: a step put before or after it.
      out.push({ kind: "moved", name: n.name, detail: `now ${runsAfter(info.node)} (was ${runsAfter(old.node)})`, side: "right", path: n.path, type: n.type, other: old.node.path });
      continue;
    }
    if (reordered) fields.push("runs after");
    if (fields.length) out.push({ kind: "changed", name: n.name, detail: fields.join(", "), side: "right", path: n.path, type: n.type, other: old.node.path });
  }
  for (const [key, info] of ls) {
    if (rs.has(key) || renamedOld.has(key)) continue;
    const where = locationOf(lIndex, info.node);
    out.push({ kind: "removed", name: info.node.name, detail: where ? `from ${where}` : "", side: "left", path: info.node.path, type: info.node.type });
  }

  // Connection references
  const lroot = readRoot(before);
  const rroot = readRoot(after);
  const lc = connectionRefs(lroot);
  const rc = connectionRefs(rroot);
  const refPath = (key: string) => ["properties", "connectionReferences", key];
  for (const key of Object.keys(rc)) {
    if (!(key in lc)) out.push({ kind: "connection", name: key, detail: "new connection reference", side: "right", path: refPath(key) });
    else if (stable(lc[key]) !== stable(rc[key])) out.push({ kind: "connection", name: key, detail: "changed", side: "right", path: refPath(key) });
  }
  for (const key of Object.keys(lc)) {
    if (!(key in rc)) out.push({ kind: "connection", name: key, detail: "removed", side: "left", path: refPath(key) });
  }

  if (otherSettings(lroot) !== otherSettings(rroot)) {
    out.push({ kind: "settings", name: "Flow settings", detail: "parameters, outputs or other settings", side: "right", path: ["properties"] });
  }
  return out;
}

// ---------------------------------------------------------------- marks for the designer

/** How a step is drawn when two versions are compared. */
export type DiffMark = "added" | "removed" | "changed" | "moved" | "renamed";

export interface DiffMarks {
  /** Step id (`pathKey(path)`) → marks, on each side. */
  left: Map<string, DiffMark[]>;
  right: Map<string, DiffMark[]>;
}

const MARK_ORDER: DiffMark[] = ["added", "removed", "renamed", "changed", "moved"];

/** The changes as marks on the steps of each side. */
export function diffMarks(changes: FlowChange[]): DiffMarks {
  const left = new Map<string, DiffMark[]>();
  const right = new Map<string, DiffMark[]>();
  const add = (map: Map<string, DiffMark[]>, path: string[] | undefined, mark: DiffMark) => {
    if (!path) return;
    const id = pathKey(path);
    const list = map.get(id) ?? [];
    if (!list.includes(mark)) list.push(mark);
    list.sort((a, b) => MARK_ORDER.indexOf(a) - MARK_ORDER.indexOf(b));
    map.set(id, list);
  };
  for (const c of changes) {
    if (c.kind === "connection" || c.kind === "settings") continue;
    if (c.kind === "added" || (c.kind === "trigger" && c.side === "right" && !c.other)) add(right, c.path, "added");
    else if (c.kind === "removed" || (c.kind === "trigger" && c.side === "left")) add(left, c.path, "removed");
    else {
      const mark: DiffMark = c.kind === "trigger" ? "changed" : c.kind;
      add(right, c.path, mark);
      add(left, c.other, mark);
    }
  }
  return { left, right };
}

/** Step ids of the same step on both sides: by name, and renamed ones. */
export function stepPairs(left: OutlineNode[], right: OutlineNode[], changes: FlowChange[]) {
  const toRight = new Map<string, string>();
  const toLeft = new Map<string, string>();
  const l = indexFlow(left).byKey;
  const r = indexFlow(right).byKey;
  for (const [key, node] of l) {
    const other = r.get(key);
    if (other) {
      toRight.set(node.id, other.id);
      toLeft.set(other.id, node.id);
    }
  }
  for (const c of changes) {
    if (c.kind === "renamed" && c.other) {
      toRight.set(pathKey(c.other), pathKey(c.path));
      toLeft.set(pathKey(c.path), pathKey(c.other));
    }
  }
  return { toRight, toLeft };
}

// ---------------------------------------------------------------- one step, field by field

export interface FieldChange {
  /** e.g. ["inputs", "parameters", "$filter"]. */
  path: string[];
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

/** Leaves of a value: objects and arrays of objects are walked, anything else is one value. */
function leaves(v: unknown, path: string[], out: Map<string, { path: string[]; value: unknown }>) {
  const walk = isObject(v) ? Object.entries(v) : Array.isArray(v) && v.some((x) => isObject(x) || Array.isArray(x)) ? v.map((x, i) => [String(i), x] as const) : null;
  if (walk && walk.length) {
    for (const [k, x] of walk) leaves(x, [...path, k], out);
  } else {
    out.set(path.join("\u0001"), { path, value: v });
  }
  return out;
}

/**
 * What differs between two versions of one step (its own settings, not the
 * steps inside it; designer ids left out), value by value. A step on one
 * side only: all of it, as added or removed.
 */
export function stepFieldChanges(before: OutlineNode | null, after: OutlineNode | null): FieldChange[] {
  const own = (n: OutlineNode | null) => (n ? stripDesignerMetadata(n.kind === "trigger" ? n.raw : ownPart(n)) ?? {} : {});
  const a = leaves(own(before), [], new Map());
  const b = leaves(own(after), [], new Map());
  const out: FieldChange[] = [];
  for (const [key, { path, value }] of b) {
    const old = a.get(key);
    if (!old) out.push({ path, kind: "added", after: value });
    else if (stable(old.value) !== stable(value)) out.push({ path, kind: "changed", before: old.value, after: value });
  }
  for (const [key, { path, value }] of a) if (!b.has(key)) out.push({ path, kind: "removed", before: value });
  return out.filter((c) => c.path.length > 0);
}

// ---------------------------------------------------------------- checks

export interface FlowProblem {
  level: "error" | "warning";
  message: string;
  /** Where to show it in the working version. */
  path?: string[];
}

/** Functions whose first argument names another step. */
const STEP_FUNCTIONS = ["body", "outputs", "actions", "items", "result", "actionBody", "actionOutputs", "iterationIndexes"];
const STEP_REF = new RegExp(`\\b(${STEP_FUNCTIONS.join("|")})\\(\\s*'((?:[^']|'')+)'`, "g");
const VARIABLE_REF = /\bvariables\(\s*'((?:[^']|'')+)'/g;
const RUN_AFTER_STATUSES = new Set(["Succeeded", "Failed", "Skipped", "TimedOut"]);
const VARIABLE_WRITERS = new Set(["SetVariable", "IncrementVariable", "DecrementVariable", "AppendToArrayVariable", "AppendToStringVariable"]);

export interface CheckContext {
  /** The baseline, to tell new connection references apart. */
  baseline?: string | null;
  /** Flows of the environment, to check child flows. */
  flows?: FlowMeta[] | null;
}

/** What would stop the flow from saving or running, and what deserves a second look. */
export function checkFlow(text: string, ctx: CheckContext = {}): FlowProblem[] {
  const problems: FlowProblem[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return [{ level: "error", message: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` }];
  }
  const props = isObject(root) && isObject(root.properties) ? root.properties : null;
  const def = props && isObject(props.definition) ? props.definition : null;
  if (!def) return [{ level: "error", message: "properties.definition is missing — this isn't a cloud flow definition." }];
  const outline = buildOutline(text) ?? [];

  const triggers = outline.filter((n) => n.kind === "trigger");
  if (triggers.length === 0) problems.push({ level: "error", message: "The flow has no trigger." });
  if (triggers.length > 1) problems.push({ level: "error", message: `A flow has one trigger; this one has ${triggers.length}.`, path: triggers[1].path });
  if (!isObject(def.actions)) problems.push({ level: "error", message: "properties.definition.actions is missing." });

  // Every step, with the steps beside it.
  const all: { node: OutlineNode; siblings: OutlineNode[]; topLevel: boolean }[] = [];
  const walk = (nodes: OutlineNode[], topLevel: boolean) => {
    const siblings = nodes.filter((n) => n.kind !== "branch" && n.kind !== "trigger");
    for (const n of nodes) {
      if (n.kind === "branch") walk(n.children, false);
      else if (n.kind !== "trigger") {
        all.push({ node: n, siblings, topLevel });
        walk(n.children, false);
      }
    }
  };
  walk(outline, true);

  const names = new Map<string, number>();
  for (const { node } of all) names.set(node.key, (names.get(node.key) ?? 0) + 1);
  for (const [name, count] of names) {
    if (count > 1) {
      const first = all.find((s) => s.node.key === name)!.node;
      problems.push({ level: "error", message: `${count} actions are named “${name}” — action names must be unique in the whole flow.`, path: first.path });
    }
  }
  const known = new Set([...names.keys(), ...triggers.map((t) => t.key)]);

  for (const { node, siblings } of all) {
    const here = new Set(siblings.map((s) => s.key));
    for (const [dep, statuses] of Object.entries(node.after)) {
      if (!known.has(dep)) problems.push({ level: "error", message: `“${node.name}” runs after “${dep}”, which doesn't exist.`, path: node.path });
      else if (!here.has(dep)) problems.push({ level: "error", message: `“${node.name}” runs after “${dep}”, which isn't in the same scope.`, path: node.path });
      const bad = statuses.filter((s) => !RUN_AFTER_STATUSES.has(s));
      if (bad.length) problems.push({ level: "error", message: `“${node.name}” waits for an unknown status: ${bad.join(", ")}.`, path: node.path });
    }
  }
  // runAfter cycles, per scope
  const scopes = new Map<string, OutlineNode[]>();
  for (const { siblings } of all) scopes.set(siblings.map((s) => s.id).join("|"), siblings);
  for (const siblings of scopes.values()) {
    const keys = new Set(siblings.map((s) => s.key));
    const done = new Set<string>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const s of siblings) {
        if (done.has(s.key)) continue;
        if (Object.keys(s.after).every((d) => !keys.has(d) || done.has(d))) {
          done.add(s.key);
          progress = true;
        }
      }
    }
    const stuck = siblings.filter((s) => !done.has(s.key));
    if (stuck.length) problems.push({ level: "error", message: `These actions wait for each other (a runAfter loop): ${stuck.map((s) => s.name).join(", ")}.`, path: stuck[0].path });
  }

  // Expressions naming steps and variables
  const declared = new Map<string, OutlineNode>();
  for (const { node, topLevel } of all) {
    if (node.actionType !== "InitializeVariable") continue;
    if (!topLevel) problems.push({ level: "error", message: `“${node.name}” initializes a variable inside a scope, condition or loop — that's only allowed at the top level.`, path: node.path });
    const inputs = isObject(node.raw) && isObject(node.raw.inputs) ? node.raw.inputs : null;
    if (inputs && Array.isArray(inputs.variables)) {
      for (const v of inputs.variables) if (isObject(v) && typeof v.name === "string") declared.set(v.name.toLowerCase(), node);
    }
  }
  const reported = new Set<string>();
  for (const step of [...triggers, ...all.map((s) => s.node)]) {
    const textOf = JSON.stringify(step.kind === "trigger" ? step.raw : ownPart(step)) ?? "";
    for (const m of textOf.matchAll(STEP_REF)) {
      const ref = m[2].replace(/''/g, "'");
      if (!known.has(ref) && !reported.has(`${step.id}|${ref}`)) {
        reported.add(`${step.id}|${ref}`);
        problems.push({ level: "error", message: `“${step.name}” uses ${m[1]}('${ref}'), but there's no action named “${ref}”.`, path: step.path });
      }
    }
    for (const m of textOf.matchAll(VARIABLE_REF)) {
      const name = m[1].replace(/''/g, "'");
      if (!declared.has(name.toLowerCase()) && !reported.has(`${step.id}|var|${name}`)) {
        reported.add(`${step.id}|var|${name}`);
        problems.push({ level: "error", message: `“${step.name}” reads variable “${name}”, which no “Initialize variable” declares.`, path: step.path });
      }
    }
    if (VARIABLE_WRITERS.has(step.actionType) && isObject(step.raw) && isObject(step.raw.inputs) && typeof step.raw.inputs.name === "string") {
      const name = step.raw.inputs.name;
      if (!declared.has(name.toLowerCase())) problems.push({ level: "error", message: `“${step.name}” changes variable “${name}”, which isn't declared.`, path: step.path });
    }
  }

  // Connection references
  const refs = props && isObject(props.connectionReferences) ? props.connectionReferences : {};
  const baseRefs = ctx.baseline ? connectionRefs(readRoot(ctx.baseline)) : null;
  for (const step of [...triggers, ...all.map((s) => s.node)]) {
    const inputs = isObject(step.raw) && isObject(step.raw.inputs) ? step.raw.inputs : null;
    const host = inputs && isObject(inputs.host) ? inputs.host : null;
    const ref = host && typeof host.connectionName === "string" ? host.connectionName : null;
    if (ref && !(ref in refs)) problems.push({ level: "error", message: `“${step.name}” uses connection “${ref}”, which isn't in connectionReferences.`, path: step.path });
  }
  if (baseRefs) {
    for (const key of Object.keys(refs)) {
      if (!(key in baseRefs)) {
        problems.push({
          level: "warning",
          message: `New connection reference “${key}” — it has to exist in the environment, or the flow won't save.`,
          path: ["properties", "connectionReferences", key],
        });
      }
    }
  }

  // Child flows
  if (ctx.flows) {
    const ids = new Set(ctx.flows.map((f) => f.id.toLowerCase()));
    for (const { node } of all) {
      if (node.childFlowId && !ids.has(node.childFlowId)) {
        problems.push({ level: "warning", message: `“${node.name}” runs child flow ${node.childFlowId}, which isn't in this environment.`, path: node.path });
      }
    }
  }

  return problems.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}
