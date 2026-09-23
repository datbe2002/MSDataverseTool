// Outline of a flow definition (triggers + nested actions in run order) and a
// map from JSON paths to editor lines, so the outline can jump into the JSON.

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const SEP = "\u0001";
export const pathKey = (path: string[]) => path.join(SEP);

export type OutlineKind = "trigger" | "control" | "connector" | "variable" | "data" | "other" | "branch";

export interface OutlineNode {
  /** `pathKey(path)`; unique in the definition. */
  id: string;
  /** JSON path of the node's key (for branches: the branch's container). */
  path: string[];
  name: string;
  kind: OutlineKind;
  /** Friendly type, e.g. "Apply to each", "Connector". */
  type: string;
  /** e.g. "sharepointonline · GetItems", a variable name, an HTTP method. */
  detail: string | null;
  /** Set when the action doesn't simply run after its predecessors succeed. */
  runAfter: string | null;
  /** "Run a Child Flow": the called flow's `workflow` id (lowercase). */
  childFlowId: string | null;
  /** The step's own name in the definition (`Apply_to_each`); "" for branches. */
  key: string;
  /** Raw `type` of the step (`If`, `Foreach`, `OpenApiConnection`…); "" for branches. */
  actionType: string;
  /** `runAfter`: sibling step name → statuses it waits for. */
  after: Record<string, string[]>;
  /** The step's JSON object (null for branches). */
  raw: Record<string, unknown> | null;
  children: OutlineNode[];
}

/**
 * Line (1-based) of every property key in a JSON text, keyed by `pathKey` of
 * its path (array items use their index). Tolerates text that isn't JSON.
 */
export function keyLines(text: string): Map<string, number> {
  interface Frame {
    path: string[];
    isObject: boolean;
    key: string | null;
    expectKey: boolean;
    index: number;
  }
  const lines = new Map<string, number>();
  const stack: Frame[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === '"') {
      const start = line;
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        else if (text[j] === "\n") line++;
        j++;
      }
      const top = stack[stack.length - 1];
      if (top?.isObject && top.expectKey) {
        let key = text.slice(i + 1, j);
        try {
          key = JSON.parse(`"${key}"`);
        } catch {
          // keep the raw text
        }
        top.key = key;
        top.expectKey = false;
        lines.set(pathKey([...top.path, key]), start);
      }
      i = j + 1;
    } else if (c === "{" || c === "[") {
      const top = stack[stack.length - 1];
      const path = top ? [...top.path, top.isObject ? top.key ?? "" : String(top.index)] : [];
      stack.push({ path, isObject: c === "{", key: null, expectKey: c === "{", index: 0 });
      i++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      i++;
    } else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.isObject) top.expectKey = true;
      else if (top) top.index++;
      i++;
    } else {
      i++;
    }
  }
  return lines;
}

const TYPES: Record<string, [string, OutlineKind]> = {
  If: ["Condition", "control"],
  Foreach: ["Apply to each", "control"],
  Until: ["Do until", "control"],
  Scope: ["Scope", "control"],
  Switch: ["Switch", "control"],
  Terminate: ["Terminate", "control"],
  Wait: ["Delay", "control"],
  OpenApiConnection: ["Connector", "connector"],
  OpenApiConnectionWebhook: ["Connector (webhook)", "connector"],
  OpenApiConnectionNotification: ["Connector (notification)", "connector"],
  ApiConnection: ["Connector", "connector"],
  ApiConnectionWebhook: ["Connector (webhook)", "connector"],
  Http: ["HTTP", "connector"],
  HttpWebhook: ["HTTP webhook", "connector"],
  Workflow: ["Child flow", "connector"],
  Response: ["Response", "connector"],
  InitializeVariable: ["Initialize variable", "variable"],
  SetVariable: ["Set variable", "variable"],
  IncrementVariable: ["Increment variable", "variable"],
  DecrementVariable: ["Decrement variable", "variable"],
  AppendToArrayVariable: ["Append to array", "variable"],
  AppendToStringVariable: ["Append to string", "variable"],
  Compose: ["Compose", "data"],
  ParseJson: ["Parse JSON", "data"],
  Query: ["Filter array", "data"],
  Select: ["Select", "data"],
  Table: ["Create table", "data"],
  Join: ["Join", "data"],
  Expression: ["Expression", "data"],
};

const str = (v: unknown) => (typeof v === "string" ? v : null);
const pretty = (name: string) => name.replace(/_/g, " ");

function describe(type: string, inputs: unknown): string | null {
  if (!isObject(inputs)) return null;
  if (isObject(inputs.host)) {
    const host = inputs.host;
    const api = str(host.apiId)?.split("/").pop() ?? str(host.connectionName) ?? str(host.connection);
    const op = str(host.operationId);
    const parts = [api?.replace(/^shared_/, ""), op].filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  if (type === "Http" || type === "HttpWebhook") return str(inputs.method)?.toUpperCase() ?? null;
  if (type === "InitializeVariable" && Array.isArray(inputs.variables)) {
    const v = inputs.variables[0];
    return isObject(v) ? str(v.name) : null;
  }
  if (type.endsWith("Variable")) return str(inputs.name);
  return null;
}

const RUN_AFTER: Record<string, string> = {
  Succeeded: "succeeds",
  Failed: "fails",
  Skipped: "is skipped",
  TimedOut: "times out",
};

/** e.g. "runs if Try fails or times out"; null for the usual "after success". */
function runAfterNote(runAfter: unknown): string | null {
  if (!isObject(runAfter)) return null;
  const notes: string[] = [];
  let unusual = false;
  for (const [dep, statuses] of Object.entries(runAfter)) {
    const list = Array.isArray(statuses) ? statuses.filter((s): s is string => typeof s === "string") : [];
    if (list.some((s) => s !== "Succeeded")) unusual = true;
    notes.push(`${pretty(dep)} ${list.map((s) => RUN_AFTER[s] ?? s.toLowerCase()).join(" or ")}`);
  }
  return unusual ? `runs if ${notes.join(", and ")}` : null;
}

/** Actions of one container in run order (by `runAfter`), ties in written order. */
function inRunOrder(actions: Json): [string, Json][] {
  const entries = Object.entries(actions).filter((e): e is [string, Json] => isObject(e[1]));
  const names = new Set(entries.map(([n]) => n));
  const deps = new Map(
    entries.map(([name, a]) => [
      name,
      new Set(isObject(a.runAfter) ? Object.keys(a.runAfter).filter((d) => names.has(d)) : []),
    ])
  );
  const out: [string, Json][] = [];
  const done = new Set<string>();
  while (out.length < entries.length) {
    const next =
      entries.find(([n]) => !done.has(n) && [...deps.get(n)!].every((d) => done.has(d))) ??
      // A cycle (invalid flow): keep going in written order.
      entries.find(([n]) => !done.has(n))!;
    done.add(next[0]);
    out.push(next);
  }
  return out;
}

function actionNodes(actions: unknown, parent: string[]): OutlineNode[] {
  if (!isObject(actions)) return [];
  return inRunOrder(actions).map(([name, action]) => {
    const path = [...parent, name];
    const type = str(action.type) ?? "";
    const [label, kind] = TYPES[type] ?? [type || "Action", "other" as const];
    return {
      id: pathKey(path),
      path,
      name: pretty(name),
      kind,
      type: label,
      detail: describe(type, action.inputs),
      runAfter: runAfterNote(action.runAfter),
      childFlowId: type === "Workflow" ? childFlowId(action.inputs) : null,
      key: name,
      actionType: type,
      after: runAfterMap(action.runAfter),
      raw: action,
      children: childNodes(type, action, path),
    };
  });
}

function runAfterMap(runAfter: unknown): Record<string, string[]> {
  if (!isObject(runAfter)) return {};
  return Object.fromEntries(
    Object.entries(runAfter).map(([dep, statuses]) => [
      dep,
      Array.isArray(statuses) ? statuses.filter((s): s is string => typeof s === "string") : [],
    ])
  );
}

function childFlowId(inputs: unknown): string | null {
  const host = isObject(inputs) && isObject(inputs.host) ? inputs.host : null;
  return str(host?.workflowReferenceName)?.toLowerCase() ?? null;
}

function branch(name: string, path: string[], children: OutlineNode[]): OutlineNode {
  return {
    id: pathKey(path),
    path,
    name,
    kind: "branch",
    type: "",
    detail: null,
    runAfter: null,
    childFlowId: null,
    key: "",
    actionType: "",
    after: {},
    raw: null,
    children,
  };
}

function childNodes(type: string, action: Json, path: string[]): OutlineNode[] {
  if (type === "If") {
    const out = [branch("If yes", [...path, "actions"], actionNodes(action.actions, [...path, "actions"]))];
    if (isObject(action.else)) {
      out.push(branch("If no", [...path, "else"], actionNodes(action.else.actions, [...path, "else", "actions"])));
    }
    return out;
  }
  if (type === "Switch") {
    const out: OutlineNode[] = [];
    if (isObject(action.cases)) {
      for (const [name, c] of Object.entries(action.cases)) {
        if (!isObject(c)) continue;
        const casePath = [...path, "cases", name];
        const value = c.case === undefined ? pretty(name) : JSON.stringify(c.case);
        out.push(branch(`Case ${value}`, casePath, actionNodes(c.actions, [...casePath, "actions"])));
      }
    }
    if (isObject(action.default)) {
      const p = [...path, "default"];
      out.push(branch("Default", p, actionNodes(action.default.actions, [...p, "actions"])));
    }
    return out;
  }
  return actionNodes(action.actions, [...path, "actions"]);
}

/** Triggers then actions of a flow definition; null if it isn't a flow. */
export function buildOutline(definitionJson: string): OutlineNode[] | null {
  let root: unknown;
  try {
    root = JSON.parse(definitionJson);
  } catch {
    return null;
  }
  const props = isObject(root) && isObject(root.properties) ? root.properties : null;
  const def = props && isObject(props.definition) ? props.definition : null;
  if (!def) return null;
  const base = ["properties", "definition"];

  const triggers: OutlineNode[] = isObject(def.triggers)
    ? Object.entries(def.triggers).map(([name, t]) => {
        const path = [...base, "triggers", name];
        const trigger = isObject(t) ? t : {};
        const raw = str(trigger.type) ?? "";
        const type = [TYPES[raw]?.[0] ?? raw, str(trigger.kind)].filter(Boolean).join(" · ");
        return {
          id: pathKey(path),
          path,
          name: pretty(name),
          kind: "trigger",
          type: type || "Trigger",
          detail: describe(raw, trigger.inputs),
          runAfter: null,
          childFlowId: null,
          key: name,
          actionType: raw,
          after: {},
          raw: trigger,
          children: [],
        };
      })
    : [];

  return [...triggers, ...actionNodes(def.actions, [...base, "actions"])];
}

/** The distinct child flows a flow runs, in outline order. */
export function childFlowIds(nodes: OutlineNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.childFlowId && !out.includes(n.childFlowId)) out.push(n.childFlowId);
    childFlowIds(n.children, out);
  }
  return out;
}

/** Ids of every node that has children (for "expand all"). */
export function parentIds(nodes: OutlineNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length) {
      out.push(n.id);
      parentIds(n.children, out);
    }
  }
  return out;
}
