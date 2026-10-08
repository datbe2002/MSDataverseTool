// FetchXML structure for the REST builder's FetchXML editor (autocomplete and
// checks): which elements go where, which table an element's columns belong
// to, the condition operators by column type, and where each element sits
// in the XML text (for squiggles).

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

