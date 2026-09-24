// The FetchXML builder's model: the query's elements as a tree, edits to it
// (always made on a parsed copy and written back as formatted XML, so the
// XML stays the single source of truth), operators by column type, and
// where each element sits in the XML text.
import { formatFetchXml } from "./fetchXml";
import type { Relationship } from "../types";

export type NodeKind =
  | "fetch"
  | "entity"
  | "link-entity"
  | "attribute"
  | "all-attributes"
  | "order"
  | "filter"
  | "condition"
  | "value";

/** Elements each element can contain, in the order they're usually written. */
export const CHILDREN: Partial<Record<string, NodeKind[]>> = {
  fetch: ["entity"],
  entity: ["attribute", "all-attributes", "order", "filter", "link-entity"],
  "link-entity": ["attribute", "all-attributes", "order", "filter", "link-entity"],
  filter: ["condition", "filter"],
  condition: ["value"],
};

export interface TreeNode {
  /** Position among all elements in document order (`getElementsByTagName("*")`). */
  id: number;
  tag: string;
  attrs: Record<string, string>;
  /** Text content of leaf elements (`<value>`). */
  text: string;
  children: TreeNode[];
  /** Child indexes from the root, e.g. "0.3.1" — stays put when attributes change. */
  path: string;
  depth: number;
}

export function parseXml(xml: string): XMLDocument | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return doc.getElementsByTagName("parsererror").length ? null : doc;
}

export function buildTree(doc: XMLDocument): TreeNode {
  let next = 0;
  const walk = (el: Element, path: string, depth: number): TreeNode => {
    const id = next++;
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    const kids = Array.from(el.children);
    return {
      id,
      tag: el.tagName,
      attrs,
      text: kids.length ? "" : (el.textContent ?? "").trim(),
      children: kids.map((c, i) => walk(c, `${path}.${i}`, depth + 1)),
      path,
      depth,
    };
  };
  return walk(doc.documentElement, "0", 0);
}

export function elements(doc: XMLDocument): Element[] {
  return Array.from(doc.getElementsByTagName("*"));
}

/**
 * Runs `mutate` on a parsed copy of `xml` (the element with id `target` is
 * handed in) and returns the formatted result, plus the id of the element
 * to select afterwards (what `mutate` returned, else the target).
 */
export function edit(
  xml: string,
  target: number,
  mutate: (el: Element, doc: XMLDocument) => Element | null | void
): { xml: string; select: number | null } | null {
  const doc = parseXml(xml);
  const el = doc ? elements(doc)[target] : undefined;
  if (!doc || !el) return null;
  const picked = mutate(el, doc);
  const keep = picked === undefined ? el : picked;
  const all = elements(doc);
  const select = keep && keep.isConnected ? all.indexOf(keep) : null;
  const out = formatFetchXml(new XMLSerializer().serializeToString(doc));
  return out ? { xml: out, select: select === -1 ? null : select } : null;
}

// ---- element edits ----

export function setAttr(el: Element, name: string, value: string | null | undefined) {
  if (value === null || value === undefined || value === "") el.removeAttribute(name);
  else el.setAttribute(name, value);
}

const rank = (parent: string, tag: string) => {
  const order = CHILDREN[parent] ?? [];
  const i = order.indexOf(tag as NodeKind);
  return i === -1 ? order.length : i;
};

/** Adds `<tag>` to `parent` after its other children of the same kind. */
export function addChild(parent: Element, tag: NodeKind, attrs: Record<string, string> = {}): Element {
  const doc = parent.ownerDocument;
  const child = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
  const mine = rank(parent.tagName, tag);
  const before = Array.from(parent.children).find((c) => rank(parent.tagName, c.tagName) > mine);
  parent.insertBefore(child, before ?? null);
  return child;
}

/** The names conditions / sorts use for a join and the joins inside it (`entityname` = alias, else table). */
function joinNames(link: Element): string[] {
  return [link, ...Array.from(link.getElementsByTagName("link-entity"))]
    .map((l) => l.getAttribute("alias") || l.getAttribute("name") || "")
    .filter(Boolean);
}

/** Removes conditions / sorts that point at these joins (but not those inside `except`); returns how many. */
function dropReferences(doc: XMLDocument, names: string[], except?: Element): number {
  if (!names.length) return 0;
  let n = 0;
  for (const el of Array.from(doc.querySelectorAll("condition[entityname], order[entityname]"))) {
    if (names.includes(el.getAttribute("entityname") ?? "") && !except?.contains(el)) {
      let parent: Element | null = el.parentElement;
      el.remove();
      n++;
      // A filter left with nothing in it goes too.
      while (parent && parent.tagName === "filter" && parent.children.length === 0 && !except?.contains(parent)) {
        const up: Element | null = parent.parentElement;
        parent.remove();
        n++;
        parent = up;
      }
    }
  }
  return n;
}

/** Removes `el` (and, for a join, what points at it); returns the element to select next (a sibling, else the parent). */
export function removeNode(el: Element): Element | null {
  const next = el.nextElementSibling ?? el.previousElementSibling ?? el.parentElement;
  if (el.tagName === "link-entity") {
    const names = joinNames(el);
    el.remove();
    dropReferences(next?.ownerDocument ?? el.ownerDocument, names);
  } else {
    el.remove();
  }
  return next;
}

/**
 * Points an `<entity>` / `<link-entity>` at another table. What belonged to
 * the old one goes: its columns, sorts, filters and joins (`<all-attributes>`
 * stays), the join's `from` and alias (a new one is picked), and conditions /
 * sorts elsewhere that pointed at the join. Returns how many elements went.
 */
export function setTable(el: Element, name: string): number {
  const old = el.getAttribute("name") ?? "";
  name = name.trim().toLowerCase();
  if (!name || old === name) return 0;
  const doc = el.ownerDocument;
  let removed = 0;
  if (el.tagName === "link-entity") {
    // Inside the join they go with its children below.
    removed += dropReferences(doc, joinNames(el), el);
  }
  for (const c of Array.from(el.children)) {
    if (c.tagName === "all-attributes") continue;
    removed += 1 + c.getElementsByTagName("*").length;
    c.remove();
  }
  el.setAttribute("name", name);
  if (el.tagName === "link-entity") {
    el.removeAttribute("from");
    el.removeAttribute("intersect");
    if (el.hasAttribute("alias")) {
      el.removeAttribute("alias");
      el.setAttribute("alias", freeAlias(doc, name));
    }
    tidyJoin(el);
  }
  return removed;
}


/** Moves `el` one place among its element siblings. */
export function moveNode(el: Element, dir: -1 | 1): Element {
  const parent = el.parentElement;
  if (!parent) return el;
  if (dir === -1 && el.previousElementSibling) parent.insertBefore(el, el.previousElementSibling);
  if (dir === 1 && el.nextElementSibling) parent.insertBefore(el.nextElementSibling, el);
  return el;
}

export function canMove(node: TreeNode, parent: TreeNode | null, dir: -1 | 1): boolean {
  if (!parent) return false;
  const i = parent.children.findIndex((c) => c.id === node.id);
  return dir === -1 ? i > 0 : i >= 0 && i < parent.children.length - 1;
}

/** The table an element's columns belong to: the nearest `<entity>` / `<link-entity>`
 *  (for a condition with `entityname`, the join with that alias). */
export function tableOf(el: Element): string | null {
  if (el.tagName === "condition" || el.tagName === "value") {
    const cond = el.tagName === "value" ? el.parentElement : el;
    const alias = cond?.getAttribute("entityname");
    if (alias) {
      const link = Array.from(el.ownerDocument.getElementsByTagName("link-entity")).find(
        (l) => (l.getAttribute("alias") || l.getAttribute("name")) === alias
      );
      return link?.getAttribute("name") ?? null;
    }
  }
  for (let p: Element | null = el; p; p = p.parentElement) {
    if (p.tagName === "entity" || p.tagName === "link-entity") return p.getAttribute("name") || null;
  }
  return null;
}

/** The `<entity>` / `<link-entity>` an element belongs to (itself for those). */
export function ownerTable(el: Element): Element | null {
  for (let p: Element | null = el; p; p = p.parentElement) {
    if (p.tagName === "entity" || p.tagName === "link-entity") return p;
  }
  return null;
}

export const isAggregate = (doc: XMLDocument) => doc.documentElement.getAttribute("aggregate") === "true";

/** Aliases a condition's `entityname` can point at. */
export function linkAliases(doc: XMLDocument): { alias: string; table: string }[] {
  return Array.from(doc.getElementsByTagName("link-entity"))
    .map((l) => ({ alias: l.getAttribute("alias") || "", table: l.getAttribute("name") || "" }))
    .filter((l) => l.alias);
}

/** Column `name` shown on the entity / link-entity as an `<attribute>`: on or off. */
export function toggleColumn(table: Element, name: string, on: boolean) {
  const existing = Array.from(table.children).filter(
    (c) => c.tagName === "attribute" && c.getAttribute("name") === name
  );
  if (on && existing.length === 0) addChild(table, "attribute", { name });
  if (!on) existing.forEach((c) => c.remove());
}

/** Writes a join's attributes in the usual order (name, from, to, alias, …), the rest after. */
function tidyJoin(link: Element) {
  const order = ["name", "from", "to", "alias", "link-type", "intersect", "visible"];
  const attrs = Array.from(link.attributes).map((a) => [a.name, a.value] as const);
  attrs.sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  for (const [n] of attrs) link.removeAttribute(n);
  for (const [n, v] of attrs) link.setAttribute(n, v);
}

/**
 * Fills a `<link-entity>` from a relationship; N:N adds the second join
 * inside it. Another table than before clears what belonged to the old one
 * (see `setTable`); the same table keeps its columns and alias. Returns the
 * join to select; `report.removed` = how many elements went.
 */
export function applyRelationship(link: Element, rel: Relationship, report?: { removed: number }): Element {
  const doc = link.ownerDocument;
  const nn = rel.kind === "manyToMany" && !!rel.intersect && !!rel.intersectFrom && !!rel.intersectTo;
  const target = nn ? rel.intersect! : rel.table;
  let removed = 0;
  if ((link.getAttribute("name") ?? "") !== target) {
    const hadAlias = link.hasAttribute("alias");
    removed += setTable(link, target);
    if (!hadAlias) link.removeAttribute("alias");
  }
  if (nn) {
    link.setAttribute("from", rel.intersectFrom!);
    link.setAttribute("to", rel.to);
    link.setAttribute("intersect", "true");
    link.removeAttribute("alias");
    let inner = Array.from(link.children).find((c) => c.tagName === "link-entity" && c.getAttribute("name") === rel.table);
    for (const c of Array.from(link.children)) {
      if (c.tagName !== "link-entity" || c === inner) continue;
      removed += 1 + c.getElementsByTagName("*").length + dropReferences(doc, joinNames(c));
      c.remove();
    }
    inner ??= addChild(link, "link-entity", { name: rel.table });
    inner.setAttribute("from", rel.from);
    inner.setAttribute("to", rel.intersectTo!);
    if (!inner.getAttribute("alias")) inner.setAttribute("alias", freeAlias(doc, rel.table));
    tidyJoin(link);
    tidyJoin(inner);
    if (report) report.removed = removed;
    return inner;
  }
  link.setAttribute("from", rel.from);
  link.setAttribute("to", rel.to);
  link.removeAttribute("intersect");
  if (!link.getAttribute("alias")) link.setAttribute("alias", freeAlias(doc, rel.table));
  tidyJoin(link);
  if (report) report.removed = removed;
  return link;
}

/** An alias not used by another join yet: `contact` → `c`, `c2`, … */
export function freeAlias(doc: XMLDocument, table: string): string {
  const used = new Set(linkAliases(doc).map((l) => l.alias));
  const base = (table.replace(/^[a-z]+_/, "")[0] ?? "l").toLowerCase();
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

// ---- condition operators ----

export type Arity = "none" | "one" | "number" | "two" | "many";

interface OperatorInfo {
  label: string;
  arity: Arity;
}

export const OPERATORS: Record<string, OperatorInfo> = {
  eq: { label: "Equals", arity: "one" },
  ne: { label: "Does not equal", arity: "one" },
  null: { label: "Does not contain data", arity: "none" },
  "not-null": { label: "Contains data", arity: "none" },
  in: { label: "Is one of", arity: "many" },
  "not-in": { label: "Is not one of", arity: "many" },
  like: { label: "Like (use %)", arity: "one" },
  "not-like": { label: "Not like", arity: "one" },
  "begins-with": { label: "Begins with", arity: "one" },
  "not-begin-with": { label: "Does not begin with", arity: "one" },
  "ends-with": { label: "Ends with", arity: "one" },
  "not-end-with": { label: "Does not end with", arity: "one" },
  gt: { label: "Greater than", arity: "one" },
  ge: { label: "Greater or equal", arity: "one" },
  lt: { label: "Less than", arity: "one" },
  le: { label: "Less or equal", arity: "one" },
  between: { label: "Between", arity: "two" },
  "not-between": { label: "Not between", arity: "two" },
  on: { label: "On", arity: "one" },
  "on-or-before": { label: "On or before", arity: "one" },
  "on-or-after": { label: "On or after", arity: "one" },
  yesterday: { label: "Yesterday", arity: "none" },
  today: { label: "Today", arity: "none" },
  tomorrow: { label: "Tomorrow", arity: "none" },
  "last-seven-days": { label: "Last 7 days", arity: "none" },
  "next-seven-days": { label: "Next 7 days", arity: "none" },
  "last-week": { label: "Last week", arity: "none" },
  "this-week": { label: "This week", arity: "none" },
  "next-week": { label: "Next week", arity: "none" },
  "last-month": { label: "Last month", arity: "none" },
  "this-month": { label: "This month", arity: "none" },
  "next-month": { label: "Next month", arity: "none" },
  "last-year": { label: "Last year", arity: "none" },
  "this-year": { label: "This year", arity: "none" },
  "next-year": { label: "Next year", arity: "none" },
  "last-x-hours": { label: "Last X hours", arity: "number" },
  "next-x-hours": { label: "Next X hours", arity: "number" },
  "last-x-days": { label: "Last X days", arity: "number" },
  "next-x-days": { label: "Next X days", arity: "number" },
  "last-x-weeks": { label: "Last X weeks", arity: "number" },
  "next-x-weeks": { label: "Next X weeks", arity: "number" },
  "last-x-months": { label: "Last X months", arity: "number" },
  "next-x-months": { label: "Next X months", arity: "number" },
  "last-x-years": { label: "Last X years", arity: "number" },
  "next-x-years": { label: "Next X years", arity: "number" },
  "olderthan-x-minutes": { label: "Older than X minutes", arity: "number" },
  "olderthan-x-hours": { label: "Older than X hours", arity: "number" },
  "olderthan-x-days": { label: "Older than X days", arity: "number" },
  "olderthan-x-weeks": { label: "Older than X weeks", arity: "number" },
  "olderthan-x-months": { label: "Older than X months", arity: "number" },
  "olderthan-x-years": { label: "Older than X years", arity: "number" },
  "this-fiscal-year": { label: "This fiscal year", arity: "none" },
  "this-fiscal-period": { label: "This fiscal period", arity: "none" },
  "last-fiscal-year": { label: "Last fiscal year", arity: "none" },
  "last-fiscal-period": { label: "Last fiscal period", arity: "none" },
  "next-fiscal-year": { label: "Next fiscal year", arity: "none" },
  "next-fiscal-period": { label: "Next fiscal period", arity: "none" },
  "last-x-fiscal-years": { label: "Last X fiscal years", arity: "number" },
  "last-x-fiscal-periods": { label: "Last X fiscal periods", arity: "number" },
  "next-x-fiscal-years": { label: "Next X fiscal years", arity: "number" },
  "next-x-fiscal-periods": { label: "Next X fiscal periods", arity: "number" },
  "in-fiscal-year": { label: "In fiscal year", arity: "number" },
  "in-fiscal-period": { label: "In fiscal period", arity: "number" },
  "eq-userid": { label: "Equals current user", arity: "none" },
  "ne-userid": { label: "Does not equal current user", arity: "none" },
  "eq-userteams": { label: "Current user's teams", arity: "none" },
  "eq-useroruserteams": { label: "Current user or their teams", arity: "none" },
  "eq-useroruserhierarchy": { label: "Current user or their reports", arity: "none" },
  "eq-useroruserhierarchyandteams": { label: "Current user, reports or teams", arity: "none" },
  "eq-businessid": { label: "Equals current business unit", arity: "none" },
  "ne-businessid": { label: "Does not equal current business unit", arity: "none" },
  "eq-userlanguage": { label: "Equals user language", arity: "none" },
  under: { label: "Under (hierarchy)", arity: "one" },
  "eq-or-under": { label: "Equals or under", arity: "one" },
  "not-under": { label: "Not under", arity: "one" },
  above: { label: "Above (hierarchy)", arity: "one" },
  "eq-or-above": { label: "Equals or above", arity: "one" },
  "contain-values": { label: "Contains values", arity: "many" },
  "not-contain-values": { label: "Does not contain values", arity: "many" },
};

const BASIC = ["eq", "ne", "null", "not-null", "in", "not-in"];
const TEXT = [...BASIC, "like", "not-like", "begins-with", "not-begin-with", "ends-with", "not-end-with"];
const NUMBER = [...BASIC, "gt", "ge", "lt", "le", "between", "not-between"];
const DATE = [
  "on", "on-or-before", "on-or-after", "gt", "ge", "lt", "le", "between", "not-between", "null", "not-null",
  "yesterday", "today", "tomorrow", "last-seven-days", "next-seven-days",
  "last-week", "this-week", "next-week", "last-month", "this-month", "next-month", "last-year", "this-year", "next-year",
  "last-x-hours", "next-x-hours", "last-x-days", "next-x-days", "last-x-weeks", "next-x-weeks",
  "last-x-months", "next-x-months", "last-x-years", "next-x-years",
  "olderthan-x-minutes", "olderthan-x-hours", "olderthan-x-days", "olderthan-x-weeks", "olderthan-x-months", "olderthan-x-years",
  "this-fiscal-year", "this-fiscal-period", "last-fiscal-year", "last-fiscal-period", "next-fiscal-year", "next-fiscal-period",
  "last-x-fiscal-years", "last-x-fiscal-periods", "next-x-fiscal-years", "next-x-fiscal-periods", "in-fiscal-year", "in-fiscal-period",
];
const LOOKUP = [
  ...BASIC, "eq-userid", "ne-userid", "eq-userteams", "eq-useroruserteams", "eq-useroruserhierarchy",
  "eq-useroruserhierarchyandteams", "eq-businessid", "ne-businessid", "under", "eq-or-under", "not-under", "above", "eq-or-above",
];

/** Operators that make sense for a Dataverse `AttributeType` (all of them when unknown). */
export function operatorsFor(attributeType: string | undefined): string[] {
  switch (attributeType) {
    case "String":
    case "Memo":
    case "EntityName":
      return TEXT;
    case "Integer":
    case "BigInt":
    case "Decimal":
    case "Double":
    case "Money":
      return NUMBER;
    case "DateTime":
      return DATE;
    case "Lookup":
    case "Customer":
    case "Owner":
    case "Uniqueidentifier":
      return LOOKUP;
    case "Picklist":
    case "State":
    case "Status":
    case "Boolean":
      return BASIC;
    case "Virtual":
      // Multi-select choices report as Virtual.
      return ["contain-values", "not-contain-values", ...BASIC];
    default:
      return Object.keys(OPERATORS);
  }
}

export const arityOf = (op: string | null): Arity => OPERATORS[op ?? "eq"]?.arity ?? "one";

/** Current values of a condition: the `value` attribute or its `<value>` children. */
export function conditionValues(cond: Element): string[] {
  const kids = Array.from(cond.children).filter((c) => c.tagName === "value");
  if (kids.length) return kids.map((c) => c.textContent ?? "");
  const v = cond.getAttribute("value");
  return v === null ? [] : [v];
}

/** Writes `values` the way `operator` expects them (attribute, or `<value>` children). */
export function setConditionValues(cond: Element, values: string[]) {
  const arity = arityOf(cond.getAttribute("operator"));
  for (const c of Array.from(cond.children)) if (c.tagName === "value") c.remove();
  cond.removeAttribute("value");
  if (arity === "none") return;
  if (arity === "one" || arity === "number") {
    if (values[0] !== undefined && values[0] !== "") cond.setAttribute("value", values[0]);
    return;
  }
  const list = arity === "two" ? [values[0] ?? "", values[1] ?? ""] : values;
  for (const v of list) {
    const el = cond.ownerDocument.createElement("value");
    el.textContent = v;
    cond.appendChild(el);
  }
}

/** Changes the operator, keeping the values that still fit (a count of days isn't a date). */
export function setOperator(cond: Element, op: string) {
  const before = arityOf(cond.getAttribute("operator"));
  const after = arityOf(op);
  const values = (before === "number") === (after === "number") ? conditionValues(cond) : [];
  cond.setAttribute("operator", op);
  setConditionValues(cond, values);
}

// ---- labels ----

const opText: Record<string, string> = { eq: "=", ne: "≠", gt: ">", ge: "≥", lt: "<", le: "≤" };

/** One line for the tree: main text and a dimmer detail. */
export function nodeLabel(node: TreeNode): { text: string; detail?: string } {
  const a = node.attrs;
  switch (node.tag) {
    case "fetch": {
      const bits = [
        a.top && `top ${a.top}`,
        a.count && `count ${a.count}`,
        a.distinct === "true" && "distinct",
        a.aggregate === "true" && "aggregate",
        a["no-lock"] === "true" && "no-lock",
      ].filter(Boolean);
      return { text: "fetch", detail: bits.join(" · ") || undefined };
    }
    case "entity":
      return { text: a.name || "(no table)" };
    case "link-entity": {
      const bits = [a.from && a.to ? `${a.from} = ${a.to}` : "", a["link-type"] && a["link-type"] !== "inner" ? a["link-type"] : "", a.intersect === "true" ? "intersect" : ""];
      return { text: `${a.name || "(no table)"}${a.alias ? ` as ${a.alias}` : ""}`, detail: bits.filter(Boolean).join(" · ") || undefined };
    }
    case "attribute": {
      const name = a.name || "(no column)";
      const text = a.aggregate ? `${a.aggregate}(${name})` : name;
      const bits = [a.alias && `as ${a.alias}`, a.groupby === "true" && "group by", a.dategrouping].filter(Boolean);
      return { text, detail: bits.join(" · ") || undefined };
    }
    case "all-attributes":
      return { text: "all columns" };
    case "order":
      return { text: `${a.attribute || a.alias || "(no column)"} ${a.descending === "true" ? "↓" : "↑"}`, detail: a.descending === "true" ? "descending" : "ascending" };
    case "filter":
      return { text: (a.type || "and").toUpperCase() };
    case "condition": {
      const col = `${a.entityname ? `${a.entityname}.` : ""}${a.attribute || "(no column)"}`;
      const op = a.operator || "eq";
      const values = node.children.filter((c) => c.tag === "value").map((c) => c.text);
      const value = a.value ?? (values.length ? values.join(", ") : "");
      return { text: `${col} ${opText[op] ?? op}${value !== "" ? ` ${value}` : ""}` };
    }
    case "value":
      return { text: node.text || "(empty)" };
    default:
      return { text: node.tag };
  }
}

// ---- where elements are in the XML text ----

export interface ElementRange {
  /** Offset of `<` of the start tag. */
  start: number;
  /** Offset just past the end tag (or the self-closing start tag). */
  end: number;
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

/** Ranges of every element, in document order (same order as `elements()`). */
export function elementRanges(xml: string): ElementRange[] {
  const out: ElementRange[] = [];
  const open: number[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(xml); m; m = TOKEN.exec(xml)) {
    if (m[2] === undefined) continue; // comment, CDATA, declaration
    const end = m.index + m[0].length;
    if (m[1] === "/") {
      const i = open.pop();
      if (i !== undefined) out[i].end = end;
    } else {
      out.push({ start: m.index, end });
      if (m[4] !== "/") open.push(out.length - 1);
    }
  }
  return out;
}

/** The innermost element containing `offset`, as an element id. */
export function elementAt(ranges: ElementRange[], offset: number): number | null {
  let best: number | null = null;
  ranges.forEach((r, i) => {
    if (r.start <= offset && offset <= r.end) best = i; // later = deeper
  });
  return best;
}
