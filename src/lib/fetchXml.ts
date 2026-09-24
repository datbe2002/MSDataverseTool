// FetchXML in the webview: checking a query before it runs, the paging
// attributes of the next page, pretty-printing, and turning Web API records
// into grid rows.
import type { Cell, ColumnInfo } from "../types";

export const DEFAULT_FETCH = `<fetch top="50">
  <entity name="account">
    <attribute name="name" />
    <attribute name="accountnumber" />
    <attribute name="primarycontactid" />
    <attribute name="statecode" />
    <attribute name="createdon" />
    <order attribute="name" />
  </entity>
</fetch>
`;

export interface ParsedFetch {
  /** Logical name of the root `<entity>`. */
  entity: string;
  top: number | null;
  /** `count` on `<fetch>`: the page size. */
  count: number | null;
  page: number | null;
  aggregate: boolean;
  /** Column names the result should have, in query order (see `expectedColumns`). */
  columns: string[];
}

export type ParseResult =
  | { ok: true; fetch: ParsedFetch }
  | { ok: false; error: string; line?: number; column?: number };

const LOGICAL_NAME = /^[A-Za-z0-9_]+$/;

function parseDoc(xml: string): { doc: XMLDocument } | { error: string; line?: number; column?: number } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const failed = doc.getElementsByTagName("parsererror")[0];
  if (!failed) return { doc };
  // Chromium: "…error on line 3 at column 12: Opening and ending tag mismatch…"
  const text = failed.textContent ?? "";
  const m = text.match(/error on line (\d+) at column (\d+):\s*([^\n]*)/);
  if (m) return { error: m[3].trim() || "The XML is not valid.", line: Number(m[1]), column: Number(m[2]) };
  return { error: text.split("\n").find((l) => l.trim())?.trim() || "The XML is not valid." };
}

function intAttr(el: Element, name: string): number | null {
  const v = el.getAttribute(name);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Well-formed XML with a `<fetch>` root around one named `<entity>`. */
export function parseFetch(xml: string): ParseResult {
  if (!xml.trim()) return { ok: false, error: "Write a FetchXML query first." };
  const parsed = parseDoc(xml);
  if ("error" in parsed) return { ok: false, ...parsed };
  const root = parsed.doc.documentElement;
  if (root.tagName !== "fetch") {
    return { ok: false, error: `The query must start with <fetch>, not <${root.tagName}>.` };
  }
  const entities = Array.from(root.children).filter((c) => c.tagName === "entity");
  if (entities.length !== 1) {
    return { ok: false, error: "<fetch> must contain exactly one <entity>." };
  }
  const entity = entities[0].getAttribute("name")?.trim() ?? "";
  if (!entity) return { ok: false, error: "<entity> needs a name, e.g. <entity name=\"account\">." };
  if (!LOGICAL_NAME.test(entity)) return { ok: false, error: `"${entity}" is not a table's logical name.` };
  return {
    ok: true,
    fetch: {
      entity: entity.toLowerCase(),
      top: intAttr(root, "top"),
      count: intAttr(root, "count"),
      page: intAttr(root, "page"),
      aggregate: root.getAttribute("aggregate") === "true",
      columns: expectedColumns(entities[0]),
    },
  };
}

/**
 * Columns the query asks for, as the Web API names them: `name` (or the
 * attribute's alias) on the root table, `<link alias>.name` on a joined
 * one. Joins without an alias get a generated one, so their columns are
 * left to the records.
 */
function expectedColumns(entity: Element): string[] {
  const out: string[] = [];
  const walk = (el: Element, prefix: string | null) => {
    for (const child of Array.from(el.children)) {
      if (child.tagName === "attribute") {
        const name = child.getAttribute("name");
        const alias = child.getAttribute("alias");
        if (alias) out.push(alias);
        else if (name && prefix === "") out.push(name);
        else if (name && prefix) out.push(`${prefix}.${name}`);
      } else if (child.tagName === "link-entity") {
        walk(child, child.getAttribute("alias") || null);
      }
    }
  };
  walk(entity, "");
  return [...new Set(out)];
}

/** `xml` with the paging attributes of page `page` on `<fetch>`. */
export function withPage(xml: string, page: number, cookie: string | null, count: number | null): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  root.setAttribute("page", String(page));
  if (cookie) root.setAttribute("paging-cookie", cookie);
  else root.removeAttribute("paging-cookie");
  if (count && !root.hasAttribute("count")) root.setAttribute("count", String(count));
  return new XMLSerializer().serializeToString(doc);
}

// ---- pretty-printing ----

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

function formatNode(node: Node, depth: number, out: string[]) {
  const pad = "  ".repeat(depth);
  if (node.nodeType === Node.COMMENT_NODE) {
    out.push(`${pad}<!--${(node as Comment).data}-->`);
    return;
  }
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    const text = node.textContent?.trim();
    if (text) out.push(pad + escText(text));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const attrs = Array.from(el.attributes)
    .map((a) => ` ${a.name}="${escAttr(a.value)}"`)
    .join("");
  const children = Array.from(el.childNodes).filter(
    (c) => !(c.nodeType === Node.TEXT_NODE && !c.textContent?.trim())
  );
  if (children.length === 0) {
    out.push(`${pad}<${el.tagName}${attrs} />`);
  } else if (children.every((c) => c.nodeType === Node.TEXT_NODE || c.nodeType === Node.CDATA_SECTION_NODE)) {
    // <value>…</value> stays on one line; its text is kept as written.
    out.push(`${pad}<${el.tagName}${attrs}>${escText(el.textContent ?? "")}</${el.tagName}>`);
  } else {
    out.push(`${pad}<${el.tagName}${attrs}>`);
    for (const c of children) formatNode(c, depth + 1, out);
    out.push(`${pad}</${el.tagName}>`);
  }
}

/** Indented XML, or null when `xml` isn't well-formed. */
export function formatFetchXml(xml: string): string | null {
  const parsed = parseDoc(xml);
  if ("error" in parsed) return null;
  const out: string[] = [];
  for (const node of Array.from(parsed.doc.childNodes)) formatNode(node, 0, out);
  return out.join("\n") + "\n";
}

// ---- records → grid ----

const FORMATTED = "OData.Community.Display.V1.FormattedValue";
const LOOKUP_TABLE = "Microsoft.Dynamics.CRM.lookuplogicalname";

/** The grid's name for a record key: `_ownerid_value` → `ownerid`, `a_x002e_name` → `a.name`. */
export function columnName(key: string): string {
  const name = key.replace(/_x002e_/g, ".");
  const lookup = name.match(/^((?:[^.]+\.)?)_(.+)_value$/);
  return lookup ? lookup[1] + lookup[2] : name;
}

export interface FlatResult {
  columns: ColumnInfo[];
  /** Values as stored: GUIDs, option numbers, ISO dates. */
  raw: Cell[][];
  /** Formatted values where Dataverse gave one (lookup names, choice labels), else the raw value. */
  display: Cell[][];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}|$)/;

function typeOf(v: unknown): string {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return GUID.test(v) ? "guid" : ISO_DATE.test(v) ? "datetime" : "text";
  return "json";
}

function toCell(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

/** Records as grid rows: `expected` columns first (in query order), then any others the records have. */
export function flatten(records: Record<string, unknown>[], expected: string[]): FlatResult {
  const index = new Map<string, number>();
  const names: string[] = [];
  const types: (string | null)[] = [];
  const lookups = new Set<number>();
  const col = (name: string) => {
    let i = index.get(name);
    if (i === undefined) {
      i = names.length;
      index.set(name, i);
      names.push(name);
      types.push(null);
    }
    return i;
  };
  expected.forEach(col);

  const rawRows: Cell[][] = [];
  const formattedRows: (Cell | undefined)[][] = [];
  for (const record of records) {
    const raw: Cell[] = [];
    const formatted: (Cell | undefined)[] = [];
    for (const [key, value] of Object.entries(record)) {
      const at = key.indexOf("@");
      if (at === 0) continue; // @odata.etag
      if (at > 0) {
        const i = col(columnName(key.slice(0, at)));
        const annotation = key.slice(at + 1);
        if (annotation === FORMATTED) formatted[i] = toCell(value);
        else if (annotation === LOOKUP_TABLE) lookups.add(i);
        continue;
      }
      const i = col(columnName(key));
      raw[i] = toCell(value);
      if (types[i] === null && value !== null && value !== undefined) types[i] = typeOf(value);
    }
    rawRows.push(raw);
    formattedRows.push(formatted);
  }
  const width = names.length;
  const pad = (row: Cell[]) => Array.from({ length: width }, (_, i) => row[i] ?? null);
  return {
    columns: names.map((name, i) => ({ name, dataType: lookups.has(i) ? "lookup" : types[i] ?? "" })),
    raw: rawRows.map(pad),
    display: formattedRows.map((row, r) => Array.from({ length: width }, (_, i) => row[i] ?? rawRows[r][i] ?? null)),
  };
}
