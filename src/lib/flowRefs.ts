// What a flow step refers to (other steps' outputs, variables) and how to
// show workflow expressions: `@body('Get_items')`, `@{variables('x')}`.
import type { OutlineNode } from "./flowOutline";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Functions whose first argument names another step. */
const STEP_FUNCTIONS = ["body", "outputs", "actions", "items", "result", "actionBody", "actionOutputs", "iterationIndexes"];
const STEP_REF = new RegExp(`\\b(?:${STEP_FUNCTIONS.join("|")})\\(\\s*'((?:[^']|'')+)'`, "g");
const VARIABLE_REF = /\bvariables\(\s*'((?:[^']|'')+)'/g;

/** A step's own settings, without the steps nested in it. */
export function ownPart(step: OutlineNode): unknown {
  if (!step.raw) return null;
  const { actions: _a, else: _e, cases: _c, default: _d, ...own } = step.raw;
  return own;
}

/** Steps that change a variable, and what they do to it. */
export const VARIABLE_WRITES: Record<string, string> = {
  SetVariable: "set",
  IncrementVariable: "increment",
  DecrementVariable: "decrement",
  AppendToArrayVariable: "append",
  AppendToStringVariable: "append",
};

export interface VariableInfo {
  /** Name as declared (variable names are case-insensitive). */
  name: string;
  /** The "Initialize variable" step; null if the flow never declares it. */
  declared: OutlineNode | null;
  type: string | null;
  initial: unknown;
  /** Steps that change it, in flow order. */
  writers: OutlineNode[];
  /** Steps that read it with variables('…'), in flow order. */
  readers: OutlineNode[];
}

export interface FlowIndex {
  /** Step name in the definition → step. */
  byKey: Map<string, OutlineNode>;
  /** Variable name (lowercase) → the "Initialize variable" step that declares it. */
  variables: Map<string, OutlineNode>;
  /** Variable name (lowercase) → where it's declared, changed and read. */
  variableInfo: Map<string, VariableInfo>;
  /** Step name → variables (lowercase) it reads / changes / declares. */
  stepVariables: Map<string, { reads: string[]; writes: string[]; declares: string[] }>;
  /** Step name → names of the steps it reads outputs from. */
  uses: Map<string, string[]>;
  /** Step name → names of the steps that read its outputs. */
  usedBy: Map<string, string[]>;
  /** Step id → the containers and branches around it, outermost first. */
  ancestors: Map<string, OutlineNode[]>;
}

export function indexFlow(outline: OutlineNode[]): FlowIndex {
  const byKey = new Map<string, OutlineNode>();
  const variables = new Map<string, OutlineNode>();
  const variableInfo = new Map<string, VariableInfo>();
  const ancestors = new Map<string, OutlineNode[]>();
  const info = (name: string): VariableInfo => {
    const key = name.toLowerCase();
    let v = variableInfo.get(key);
    if (!v) variableInfo.set(key, (v = { name, declared: null, type: null, initial: undefined, writers: [], readers: [] }));
    return v;
  };

  // Walk in outline order (run order within each block), so lists come out
  // in the order a person reads the flow.
  const walk = (nodes: OutlineNode[], above: OutlineNode[]) => {
    for (const n of nodes) {
      ancestors.set(n.id, above);
      if (n.kind !== "branch") byKey.set(n.key, n);
      if (n.actionType === "InitializeVariable" && isObject(n.raw) && isObject(n.raw.inputs)) {
        const vars = n.raw.inputs.variables;
        if (Array.isArray(vars)) {
          for (const v of vars) {
            if (!isObject(v) || typeof v.name !== "string") continue;
            variables.set(v.name.toLowerCase(), n);
            const i = info(v.name);
            i.name = v.name;
            i.declared = n;
            i.type = typeof v.type === "string" ? v.type : null;
            i.initial = v.value;
          }
        }
      }
      if (VARIABLE_WRITES[n.actionType] && isObject(n.raw) && isObject(n.raw.inputs) && typeof n.raw.inputs.name === "string") {
        info(n.raw.inputs.name).writers.push(n);
      }
      walk(n.children, [...above, n]);
    }
  };
  walk(outline, []);

  const uses = new Map<string, string[]>();
  const usedBy = new Map<string, string[]>();
  const stepVariables = new Map<string, { reads: string[]; writes: string[]; declares: string[] }>();
  for (const [key, step] of byKey) {
    const text = JSON.stringify(ownPart(step) ?? "");
    const found = new Set<string>();
    for (const m of text.matchAll(STEP_REF)) {
      const name = m[1].replace(/''/g, "'");
      if (name !== key && byKey.has(name)) found.add(name);
    }
    uses.set(key, [...found]);
    for (const name of found) usedBy.set(name, [...(usedBy.get(name) ?? []), key]);

    const reads = new Set<string>();
    for (const m of text.matchAll(VARIABLE_REF)) {
      const name = m[1].replace(/''/g, "'");
      reads.add(name.toLowerCase());
      const i = info(name);
      if (!i.readers.includes(step)) i.readers.push(step);
    }
    const inputs = isObject(step.raw) && isObject(step.raw.inputs) ? step.raw.inputs : null;
    const writes = VARIABLE_WRITES[step.actionType] && typeof inputs?.name === "string" ? [inputs.name.toLowerCase()] : [];
    const declares =
      step.actionType === "InitializeVariable" && Array.isArray(inputs?.variables)
        ? inputs!.variables.filter(isObject).map((v) => String(v.name).toLowerCase())
        : [];
    stepVariables.set(key, { reads: [...reads], writes, declares });
  }

  return { byKey, variables, variableInfo, stepVariables, uses, usedBy, ancestors };
}

/** Where a step sits: "Switch › Case "classify" › Apply to each"; "" at the top. */
export function locationOf(index: FlowIndex, step: OutlineNode): string {
  return (index.ancestors.get(step.id) ?? []).map((a) => a.name).join(" › ");
}

/** A loop around the step whose iterations run in parallel (races on variables). */
export function parallelLoopAround(index: FlowIndex, step: OutlineNode): OutlineNode | null {
  for (const a of index.ancestors.get(step.id) ?? []) {
    if (a.actionType !== "Foreach" || !isObject(a.raw)) continue;
    const rc = a.raw.runtimeConfiguration;
    const n = isObject(rc) && isObject(rc.concurrency) ? rc.concurrency.repetitions : undefined;
    if (typeof n === "number" && n > 1) return a;
  }
  return null;
}

export type ExprPart =
  | { kind: "text"; text: string }
  | { kind: "expr"; text: string };

/**
 * Splits a workflow string into literal text and expressions: a string
 * starting with `@` is one expression (`@@` escapes it); otherwise each
 * `@{...}` inside it is one.
 */
export function splitExpressions(value: string): ExprPart[] {
  if (value.startsWith("@") && !value.startsWith("@@") && !value.startsWith("@{")) {
    return [{ kind: "expr", text: value }];
  }
  const parts: ExprPart[] = [];
  let last = 0;
  let i = value.indexOf("@{");
  while (i !== -1) {
    // Find the matching brace, skipping quoted strings.
    let depth = 0;
    let j = i + 1;
    let quoted = false;
    for (; j < value.length; j++) {
      const c = value[j];
      if (c === "'") quoted = !quoted;
      else if (!quoted && c === "{") depth++;
      else if (!quoted && c === "}" && --depth === 0) break;
    }
    if (j >= value.length) break;
    if (i > last) parts.push({ kind: "text", text: value.slice(last, i) });
    parts.push({ kind: "expr", text: value.slice(i, j + 1) });
    last = j + 1;
    i = value.indexOf("@{", last);
  }
  if (last < value.length) parts.push({ kind: "text", text: value.slice(last) });
  return parts;
}

export type ExprToken =
  | { kind: "plain"; text: string }
  | { kind: "fn"; text: string }
  | { kind: "string"; text: string }
  | { kind: "step"; text: string; name: string }
  | { kind: "variable"; text: string; name: string };

/** Tokens of one expression, with references to steps and variables marked. */
export function tokenizeExpression(expr: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  const re = /('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_]*)(?=\s*\()/g;
  let last = 0;
  let prevFn = "";
  for (const m of expr.matchAll(re)) {
    const at = m.index!;
    if (at > last) tokens.push({ kind: "plain", text: expr.slice(last, at) });
    if (m[1]) {
      const name = m[1].slice(1, -1).replace(/''/g, "'");
      const between = expr.slice(last, at);
      // A quoted first argument of body('…'), variables('…') … names something.
      const isFirstArg = /\(\s*$/.test(between);
      if (isFirstArg && STEP_FUNCTIONS.includes(prevFn)) tokens.push({ kind: "step", text: m[1], name });
      else if (isFirstArg && prevFn === "variables") tokens.push({ kind: "variable", text: m[1], name });
      else tokens.push({ kind: "string", text: m[1] });
    } else {
      tokens.push({ kind: "fn", text: m[2] });
      prevFn = m[2];
    }
    last = at + m[0].length;
  }
  if (last < expr.length) tokens.push({ kind: "plain", text: expr.slice(last) });
  return tokens;
}

const OPERATORS: Record<string, string> = {
  equals: "is equal to",
  greater: "is greater than",
  greaterOrEquals: "is greater than or equal to",
  less: "is less than",
  lessOrEquals: "is less than or equal to",
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
};

const operand = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * A Condition's `expression` as lines a person reads: `and` / `or` groups,
 * `not`, and comparisons ("@x" is equal to "y"). Strings are expressions or
 * literals, rendered by the caller.
 */
export interface ConditionLine {
  depth: number;
  /** "AND" / "OR" / "NOT" heading, or a comparison. */
  group?: string;
  left?: string;
  op?: string;
  right?: string;
}

export function conditionLines(expr: unknown, depth = 0, out: ConditionLine[] = []): ConditionLine[] {
  if (typeof expr === "string") {
    out.push({ depth, left: expr });
    return out;
  }
  if (!isObject(expr)) return out;
  for (const [key, value] of Object.entries(expr)) {
    if ((key === "and" || key === "or") && Array.isArray(value)) {
      out.push({ depth, group: key.toUpperCase() });
      for (const v of value) conditionLines(v, depth + 1, out);
    } else if (key === "not") {
      out.push({ depth, group: "NOT" });
      conditionLines(value, depth + 1, out);
    } else if (Array.isArray(value)) {
      out.push({ depth, left: operand(value[0]), op: OPERATORS[key] ?? key, right: operand(value[1]) });
    } else {
      out.push({ depth, left: `${key}: ${operand(value)}` });
    }
  }
  return out;
}
