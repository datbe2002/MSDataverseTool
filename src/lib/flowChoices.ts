// Labels for Dataverse choice values in a flow: a step that compares
// `outputs('Get_a_row')?['body/statuscode']` to 100000001 shows "Approved"
// next to the number. Which table a column belongs to comes from the
// Dataverse step (or trigger) the value is read from.
import { create } from "zustand";
import { api } from "../api";
import type { TableChoices } from "../types";
import type { OutlineNode } from "./flowOutline";
import type { FlowIndex } from "./flowRefs";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const NAME = /^[A-Za-z0-9_]+$/;
const INTEGER = /^-?\d+$/;

// ---- options per table, cached per connection ----

type Entry = TableChoices | "loading" | "error";

interface ChoicesStore {
  /** keyed by `${connectionId}|${table as the flow names it}` */
  tables: Record<string, Entry>;
  load: (connId: string, table: string) => void;
}

export const useChoices = create<ChoicesStore>((set, get) => ({
  tables: {},
  load: (connId, table) => {
    const key = `${connId}|${table}`;
    if (get().tables[key]) return;
    set((s) => ({ tables: { ...s.tables, [key]: "loading" } }));
    api
      .tableChoices(connId, table)
      .then((t) => set((s) => ({ tables: { ...s.tables, [key]: t } })))
      // No labels is fine: the numbers still show. Not retried until the app restarts.
      .catch(() => set((s) => ({ tables: { ...s.tables, [key]: "error" } })));
  },
}));

/** A choice column: the table as the flow names it (logical or entity set name). */
export interface ChoiceColumn {
  table: string;
  column: string;
}

export interface ChoiceHint {
  label: string;
  /** e.g. "statuscode = 100000001 (account)" */
  title: string;
}

export type ChoiceLabel = (col: ChoiceColumn, value: number) => ChoiceHint | null;

/** Looks labels up in what `useChoices` has loaded for the connection. */
export function choiceLabel(tables: Record<string, Entry>, connId: string): ChoiceLabel {
  return ({ table, column }, value) => {
    const t = tables[`${connId}|${table}`];
    if (!t || typeof t === "string") return null;
    const option = t.columns[column.toLowerCase()]?.find((o) => o.value === value);
    if (!option || !option.label) return null;
    return { label: option.label, title: `${column} = ${value} (${t.table})` };
  };
}

// ---- which table a step's output rows come from ----

const firstStepRef = (text: string) => /\b(?:body|outputs|items)\(\s*'((?:[^']|'')+)'/.exec(text)?.[1].replace(/''/g, "'") ?? null;

/**
 * The Dataverse table a step works on: its `entityName` (List rows, Get a
 * row, Update a row…) or `subscriptionRequest/entityname` (the trigger); a
 * loop, the table of the rows it goes over; a Filter array / Select, the
 * table of its `from`.
 */
export function stepTable(step: OutlineNode | undefined, index: FlowIndex, seen = new Set<string>()): string | null {
  if (!step || !isObject(step.raw) || seen.has(step.key)) return null;
  seen.add(step.key);
  const raw = step.raw;
  const inputs = raw.inputs;
  const source =
    step.actionType === "Foreach" && typeof raw.foreach === "string" ? firstStepRef(raw.foreach)
    : (step.actionType === "Query" || step.actionType === "Select") && isObject(inputs) && typeof inputs.from === "string" ? firstStepRef(inputs.from)
    : null;
  if (source) return stepTable(index.byKey.get(source), index, seen);

  if (!isObject(inputs) || !isObject(inputs.host) || !/commondataservice/i.test(JSON.stringify(inputs.host))) return null;
  const p = inputs.parameters;
  if (!isObject(p)) return null;
  const t = p.entityName ?? p["subscriptionRequest/entityname"];
  return typeof t === "string" && NAME.test(t) ? t : null;
}

export function triggerOf(index: FlowIndex): OutlineNode | undefined {
  for (const n of index.byKey.values()) if (n.kind === "trigger") return n;
  return undefined;
}

/** Tables whose options a step may need: its own, its trigger's, and those of the steps it reads. */
export function tablesFor(step: OutlineNode, index: FlowIndex): string[] {
  const steps = [step, triggerOf(index), ...(index.uses.get(step.key) ?? []).map((k) => index.byKey.get(k))];
  const out = new Set<string>();
  for (const s of steps) {
    const t = stepTable(s, index);
    if (t) out.add(t);
  }
  return [...out];
}

// ---- column references in an expression ----

// outputs('X')?['body/col'], body('X')?['col'], items('Loop')?['col'],
// triggerOutputs()?['body/col'], triggerBody()?['col'], item()?['col']
const COLUMN_REF =
  /\b(?:(outputs|body|items)\(\s*'((?:[^']|'')+)'\s*\)|(triggerOutputs|triggerBody|item)\(\s*\))((?:\s*\??\s*\[\s*'[^']*'\s*\])+)/g;

interface Ref {
  start: number;
  end: number;
  col: ChoiceColumn;
}

function columnRefs(expr: string, step: OutlineNode, index: FlowIndex): Ref[] {
  const refs: Ref[] = [];
  for (const m of expr.matchAll(COLUMN_REF)) {
    const fn = m[1] ?? m[3];
    const segments = [...m[4].matchAll(/'([^']*)'/g)].flatMap((s) => s[1].split("/"));
    if ((fn === "outputs" || fn === "triggerOutputs") && segments[0] === "body") segments.shift();
    if (segments.length !== 1 || !NAME.test(segments[0])) continue;

    const from =
      fn === "triggerOutputs" || fn === "triggerBody" ? triggerOf(index)
      : fn === "item" ? step
      : index.byKey.get(m[2].replace(/''/g, "'"));
    const table = stepTable(from, index);
    if (table) refs.push({ start: m.index!, end: m.index! + m[0].length, col: { table, column: segments[0] } });
  }
  return refs;
}

/** Matching `(`…`)` pairs and integer literals, outside quoted strings. */
function scan(expr: string) {
  const close = new Map<number, number>();
  const numbers: { at: number; text: string; open: number | undefined }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") {
      i = expr.indexOf("'", i + 1);
      while (i !== -1 && expr[i + 1] === "'") i = expr.indexOf("'", i + 2);
      if (i === -1) break;
    } else if (c === "(") stack.push(i);
    else if (c === ")") {
      const open = stack.pop();
      if (open !== undefined) close.set(open, i);
    } else if (/[\d-]/.test(c) && !/[\w.]/.test(expr[i - 1] ?? "")) {
      const m = /^-?\d+(?![\w.])/.exec(expr.slice(i));
      if (m) {
        numbers.push({ at: i, text: m[0], open: stack[stack.length - 1] });
        i += m[0].length - 1;
      }
    }
  }
  return { close, numbers };
}

export interface NumberHint extends ChoiceHint {
  /** Where the number starts in the text, and how long it is. */
  at: number;
  length: number;
}

/**
 * Integers in an expression that are options of a choice column read in
 * the same call: `equals(outputs('Get_a_row')?['body/statuscode'], 100000001)`.
 */
export function expressionHints(expr: string, step: OutlineNode, index: FlowIndex, label: ChoiceLabel): NumberHint[] {
  const refs = columnRefs(expr, step, index);
  if (refs.length === 0) return [];
  const { close, numbers } = scan(expr);
  const hints: NumberHint[] = [];
  for (const n of numbers) {
    if (n.open === undefined) continue;
    const end = close.get(n.open) ?? expr.length;
    for (const r of refs) {
      if (r.start < n.open || r.end > end) continue;
      const hint = label(r.col, Number(n.text));
      if (hint) {
        hints.push({ ...hint, at: n.at, length: n.text.length });
        break;
      }
    }
  }
  return hints;
}

/** A comparison's value (Condition, Switch case) against the column read by `other`. */
export function comparedHint(other: unknown, value: unknown, step: OutlineNode, index: FlowIndex, label: ChoiceLabel): ChoiceHint | null {
  if (typeof other !== "string" || !other.startsWith("@")) return null;
  const n = typeof value === "number" ? value : typeof value === "string" && INTEGER.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n)) return null;
  for (const r of columnRefs(other, step, index)) {
    const hint = label(r.col, n);
    if (hint) return hint;
  }
  return null;
}

/** A value written to a column of the step's table: parameter `item/statuscode` = 2. */
export function parameterHint(key: string, value: unknown, table: string | null, label: ChoiceLabel): ChoiceHint | null {
  const column = /^item\/([A-Za-z0-9_]+)$/.exec(key)?.[1];
  if (!table || !column) return null;
  const n = typeof value === "number" ? value : typeof value === "string" && INTEGER.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) ? label({ table, column }, n) : null;
}

/** An OData filter on the step's table: `statecode eq 0 and new_type ne 100000002`. */
export function filterHints(text: string, table: string | null, label: ChoiceLabel): NumberHint[] {
  if (!table) return [];
  const hints: NumberHint[] = [];
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:eq|ne|gt|ge|lt|le)\s+(-?\d+)\b/g)) {
    const hint = label({ table, column: m[1] }, Number(m[2]));
    if (hint) hints.push({ ...hint, at: m.index! + m[0].length - m[2].length, length: m[2].length });
  }
  return hints;
}
