// Checks a FetchXML query before it runs: tables and columns that don't
// exist, operators that don't fit a column, missing values, aggregate rules,
// attributes that can't go together. Problems point at an element id (its
// position in document order), like the builder's tree.
import { CHILDREN, OPERATORS, arityOf, conditionValues, operatorsFor, tableOf } from "./fetchModel";
import type { ColumnMeta } from "../types";

export type Severity = "error" | "warning" | "info";

export interface Problem {
  id: number;
  severity: Severity;
  message: string;
}

export interface LintMeta {
  /** Logical names of the environment's tables; undefined until loaded. */
  tables?: Set<string>;
  /** Columns of a table; undefined until loaded (checks needing them are skipped). */
  columns: (table: string) => ColumnMeta[] | undefined;
}

const KNOWN = new Set(["fetch", "entity", "link-entity", "attribute", "all-attributes", "order", "filter", "condition", "value"]);
const LINK_TYPES = new Set(["inner", "outer", "any", "not any", "all", "not all", "exists", "in", "matchfirstrowusingcrossapply"]);
const AGGREGATES = new Set(["count", "countcolumn", "sum", "avg", "min", "max"]);
const DATE_GROUPING = new Set(["day", "week", "month", "quarter", "year", "fiscal-period", "fiscal-year"]);

/** Tables the query names (for loading their columns). */
export function queryTables(doc: XMLDocument): string[] {
  return [
    ...new Set(
      Array.from(doc.querySelectorAll("entity, link-entity"))
        .map((e) => e.getAttribute("name")?.toLowerCase() ?? "")
        .filter((n) => /^[a-z0-9_]+$/.test(n))
    ),
  ];
}

export function lintFetch(doc: XMLDocument, meta: LintMeta): Problem[] {
  const out: Problem[] = [];
  const all = Array.from(doc.getElementsByTagName("*"));
  const idOf = (el: Element) => all.indexOf(el);
  const add = (el: Element, severity: Severity, message: string) => out.push({ id: idOf(el), severity, message });

  const root = doc.documentElement;
  const aggregate = root.getAttribute("aggregate") === "true";
  const column = (table: string | null, name: string) =>
    table ? meta.columns(table.toLowerCase())?.find((c) => c.logicalName === name.toLowerCase()) : undefined;
  /** False only when the table's columns are loaded and `name` isn't one of them. */
  const columnExists = (table: string | null, name: string) => {
    const cols = table ? meta.columns(table.toLowerCase()) : undefined;
    return !cols || cols.some((c) => c.logicalName === name.toLowerCase());
  };

  // ---- the <fetch> element ----
  if (root.tagName === "fetch") {
    if (root.hasAttribute("top") && (root.hasAttribute("count") || root.hasAttribute("page"))) {
      add(root, "error", "top can't be used together with count / page — keep one of them.");
    }
    const top = root.getAttribute("top");
    if (top !== null && !(Number.isInteger(Number(top)) && Number(top) > 0)) add(root, "error", `top must be a whole number above 0, not "${top}".`);
    if (top !== null && Number(top) > 5000) add(root, "error", "top can be at most 5,000. Use count (page size) and paging for more rows.");
    const count = root.getAttribute("count");
    if (count !== null && !(Number.isInteger(Number(count)) && Number(count) > 0 && Number(count) <= 5000)) {
      add(root, "error", "count (page size) must be a whole number from 1 to 5,000.");
    }
    if (root.getAttribute("distinct") === "true" && doc.getElementsByTagName("order").length === 0) {
      add(root, "info", "Distinct results without a sort can come back in a different order on each page. Add a sort.");
    }
  }

  // ---- aliases must be unique ----
  const seen = new Map<string, Element>();
  for (const el of all) {
    if (el.tagName !== "link-entity" && el.tagName !== "attribute") continue;
    const alias = el.getAttribute("alias");
    if (!alias) continue;
    const key = `${el.tagName === "link-entity" ? "join" : "col"}:${alias.toLowerCase()}`;
    if (seen.has(key)) add(el, "error", `The alias "${alias}" is used twice.`);
    else seen.set(key, el);
  }
  const joinNames = new Set(
    Array.from(doc.getElementsByTagName("link-entity")).map((l) => (l.getAttribute("alias") || l.getAttribute("name") || "").toLowerCase())
  );

  for (const el of all) {
    const tag = el.tagName;
    const parent = el.parentElement;
    if (!KNOWN.has(tag)) {
      add(el, "warning", `<${tag}> isn't a FetchXML element.`);
      continue;
    }
    if (parent && KNOWN.has(parent.tagName) && !(CHILDREN[parent.tagName] ?? []).includes(tag as never)) {
      add(el, "error", `<${tag}> can't go inside <${parent.tagName}>.`);
    }
    const a = (n: string) => el.getAttribute(n);

    switch (tag) {
      case "entity":
      case "link-entity": {
        const name = a("name");
        if (!name) {
          add(el, "error", tag === "entity" ? "The query needs a table: <entity name=\"…\">." : "This join has no table (name).");
          break;
        }
        if (meta.tables && !meta.tables.has(name.toLowerCase())) add(el, "error", `There's no table named "${name}" in this environment.`);
        if (tag === "link-entity") {
          const parentTable = parent ? tableOf(parent) : null;
          if (!a("from") || !a("to")) add(el, "warning", "A join needs both from (its column) and to (the parent's column).");
          if (a("from") && !columnExists(name, a("from")!)) add(el, "error", `${name} has no column "${a("from")}" (from).`);
          if (a("to") && !columnExists(parentTable, a("to")!)) add(el, "error", `${parentTable} has no column "${a("to")}" (to).`);
          const type = a("link-type");
          if (type && !LINK_TYPES.has(type)) add(el, "error", `"${type}" isn't a join type (inner, outer, exists, in, …).`);
        }
        break;
      }
      case "attribute": {
        const name = a("name");
        const table = tableOf(el);
        if (!name) {
          add(el, "error", "This column has no name.");
          break;
        }
        if (!columnExists(table, name)) add(el, "error", `${table} has no column "${name}".`);
        const agg = a("aggregate");
        if (agg && !AGGREGATES.has(agg)) add(el, "error", `"${agg}" isn't an aggregate (count, countcolumn, sum, avg, min, max).`);
        if (!aggregate && (agg || a("groupby") === "true")) {
          add(el, "error", "aggregate / groupby only work when the query is an aggregate query (<fetch aggregate=\"true\">).");
        }
        if (aggregate) {
          if (!a("alias")) add(el, "error", "In an aggregate query every column needs an alias.");
          if (!agg && a("groupby") !== "true") add(el, "error", "In an aggregate query a column needs an aggregate (count, sum, …) or groupby=\"true\".");
        }
        const dg = a("dategrouping");
        if (dg && !DATE_GROUPING.has(dg)) add(el, "error", `"${dg}" isn't a date grouping (day, week, month, quarter, year, …).`);
        if (dg && a("groupby") !== "true") add(el, "warning", "dategrouping only applies to a groupby column.");
        break;
      }
      case "all-attributes":
        if (aggregate) add(el, "error", "An aggregate query can't use all columns — list the columns with an aggregate or groupby.");
        break;
      case "order": {
        const table = tableOf(el);
        if (aggregate) {
          if (!a("alias")) add(el, "error", "An aggregate query sorts by an attribute's alias (order alias=\"…\").");
        } else if (!a("attribute")) {
          add(el, "error", "This sort has no column.");
        } else if (!a("entityname") && !columnExists(table, a("attribute")!)) {
          add(el, "error", `${table} has no column "${a("attribute")}" to sort by.`);
        }
        break;
      }
      case "filter": {
        const type = a("type");
        if (type && type !== "and" && type !== "or") add(el, "error", `A filter's type is "and" or "or", not "${type}".`);
        if (el.children.length === 0) add(el, "info", "This filter is empty — it does nothing.");
        break;
      }
      case "condition":
        lintCondition(el, add, column, columnExists, joinNames);
        break;
    }
  }
  return out;
}

function lintCondition(
  el: Element,
  add: (el: Element, s: Severity, m: string) => void,
  column: (table: string | null, name: string) => ColumnMeta | undefined,
  columnExists: (table: string | null, name: string) => boolean,
  joinNames: Set<string>
) {
  const a = (n: string) => el.getAttribute(n);
  const entityname = a("entityname");
  if (entityname && !joinNames.has(entityname.toLowerCase())) add(el, "error", `No join is named "${entityname}" (entityname).`);
  const table = tableOf(el);
  const name = a("attribute");
  if (!name) {
    add(el, "error", "This condition has no column.");
    return;
  }
  if (!columnExists(table, name)) {
    add(el, "error", `${table} has no column "${name}".`);
    return;
  }
  const op = a("operator");
  if (!op) {
    add(el, "error", "This condition has no operator.");
    return;
  }
  if (!OPERATORS[op]) {
    add(el, "error", `"${op}" isn't a FetchXML operator.`);
    return;
  }
  const type = column(table, name)?.attributeType;
  if (type && !operatorsFor(type).includes(op)) add(el, "warning", `${op} doesn't fit a ${type} column (${name}).`);
  if (a("valueof")) return; // compares with another column
  const values = conditionValues(el);
  const filled = values.filter((v) => v.trim() !== "");
  switch (arityOf(op)) {
    case "none":
      if (filled.length) add(el, "warning", `${op} takes no value — the value is ignored.`);
      break;
    case "one":
      if (!filled.length) add(el, "error", `${op} needs a value.`);
      break;
    case "number":
      if (!filled.length) add(el, "error", `${op} needs a number.`);
      else if (!/^\d+$/.test(filled[0].trim())) add(el, "error", `${op} needs a whole number, not "${filled[0]}".`);
      break;
    case "two":
      if (filled.length !== 2) add(el, "error", `${op} needs two values (from and to).`);
      break;
    case "many":
      if (!filled.length) add(el, "error", `${op} needs at least one value.`);
      break;
  }
  if (filled.length && type && ["Integer", "BigInt", "Decimal", "Double", "Money", "Picklist", "State", "Status"].includes(type)) {
    const bad = filled.find((v) => Number.isNaN(Number(v)));
    if (bad !== undefined) add(el, "error", `${name} holds numbers; "${bad}" isn't one.`);
  }
  if (filled.length && type && ["Lookup", "Customer", "Owner", "Uniqueidentifier"].includes(type) && !["like", "not-like"].includes(op)) {
    const bad = filled.find((v) => !/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(v.trim()));
    if (bad !== undefined) add(el, "error", `${name} holds record ids (GUIDs); "${bad}" isn't one.`);
  }
}
