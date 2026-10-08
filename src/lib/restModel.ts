// The REST builder's request: what the user picked in the form, and how it
// becomes a Web API request (method, URL, headers, body). Code samples are
// generated from the built request in `restCode.ts`.
import { parseFetch } from "./fetchXml";
import type { NavProperty, RestColumn, RestTable } from "../types";

export type RestKind =
  | "retrieve"
  | "retrieveMultiple"
  | "fetchXml"
  | "function"
  | "create"
  | "update"
  | "delete"
  | "associate"
  | "disassociate"
  | "action";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export const KINDS: { kind: RestKind; label: string; write: boolean; hint: string }[] = [
  { kind: "retrieve", label: "Retrieve", write: false, hint: "One record by id or alternate key" },
  { kind: "retrieveMultiple", label: "Retrieve multiple", write: false, hint: "Rows of a table with $select, $filter, $orderby, $expand" },
  { kind: "fetchXml", label: "FetchXML", write: false, hint: "A FetchXML query, sent as ?fetchXml=" },
  { kind: "function", label: "Function", write: false, hint: "A Web API function (GET), e.g. WhoAmI" },
  { kind: "create", label: "Create", write: true, hint: "POST a new record" },
  { kind: "update", label: "Update", write: true, hint: "PATCH a record" },
  { kind: "delete", label: "Delete", write: true, hint: "DELETE a record" },
  { kind: "associate", label: "Associate", write: true, hint: "Link two records through a relationship" },
  { kind: "disassociate", label: "Disassociate", write: true, hint: "Unlink two records" },
  { kind: "action", label: "Action", write: true, hint: "A Web API action (POST)" },
];

export const kindInfo = (kind: RestKind) => KINDS.find((k) => k.kind === kind) ?? KINDS[0];
export const isWrite = (kind: RestKind) => kindInfo(kind).write;

export interface Condition {
  id: string;
  column: string;
  operator: string;
  value: string;
}

export interface Sort {
  id: string;
  column: string;
  desc: boolean;
}

export interface Expand {
  id: string;
  /** Navigation property name. */
  nav: string;
  columns: string[];
}

export interface FieldValue {
  id: string;
  column: string;
  value: string;
  /** Lookups that can point at several tables: the one picked. */
  table?: string;
}

export type ParamType = "string" | "number" | "boolean" | "guid" | "datetime" | "enum" | "record" | "json";

export interface Param {
  id: string;
  name: string;
  type: ParamType;
  value: string;
  /** `record`: its table. `enum`: the enum type (`EndpointAccessType`). */
  table?: string;
}

export interface RestRequest {
  kind: RestKind;
  /** Logical name. */
  table: string;
  /** GUID, or an alternate key (`accountnumber='A1'`). */
  id: string;
  columns: string[];
  filterType: "and" | "or";
  conditions: Condition[];
  orderBy: Sort[];
  expand: Expand[];
  top: string;
  count: boolean;
  /** `Prefer: odata.maxpagesize`. */
  pageSize: string;
  /** `Prefer: odata.include-annotations="*"` — choice labels, lookup names. */
  formatted: boolean;
  fetchXml: string;
  /** Function / action name. */
  operation: string;
  /** Function / action bound to nothing, the table (collection) or a record. */
  bound: "none" | "collection" | "record";
  params: Param[];
  /** Create / update. */
  fields: FieldValue[];
  /** Create / update: `Prefer: return=representation`. */
  returnRecord: boolean;
  /** Update: `If-Match: *` so a missing record isn't created (upsert). */
  preventCreate: boolean;
  /** Associate / disassociate: the navigation property. */
  nav: string;
  relatedId: string;
}

export const DEFAULT_FETCH_QUERY = `<fetch top="50">
  <entity name="account">
    <attribute name="name" />
    <attribute name="accountid" />
    <order attribute="name" />
  </entity>
</fetch>
`;

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function blankRequest(kind: RestKind = "retrieveMultiple", table = "account"): RestRequest {
  return {
    kind,
    table,
    id: "",
    columns: [],
    filterType: "and",
    conditions: [],
    orderBy: [],
    expand: [],
    top: kind === "retrieveMultiple" ? "50" : "",
    count: false,
    pageSize: "",
    formatted: true,
    fetchXml: DEFAULT_FETCH_QUERY,
    operation: kind === "function" ? "WhoAmI" : "",
    bound: "none",
    params: [],
    fields: [],
    returnRecord: false,
    preventCreate: true,
    nav: "",
    relatedId: "",
  };
}

// ---------- columns ----------

const LOOKUP_TYPES = new Set(["Lookup", "Customer", "Owner"]);
export const CHOICE_TYPES = new Set(["Picklist", "State", "Status"]);
const NUMBER_TYPES = new Set(["Integer", "BigInt", "Decimal", "Double", "Money"]);
const TEXT_TYPES = new Set(["String", "Memo", "EntityName"]);

export const isLookup = (c: RestColumn | undefined) => !!c && LOOKUP_TYPES.has(c.attributeType);
export const isMultiChoice = (c: RestColumn | undefined) => c?.typeName === "MultiSelectPicklistType";
export const isChoice = (c: RestColumn | undefined) => !!c && (CHOICE_TYPES.has(c.attributeType) || isMultiChoice(c));

/** Columns `$select` can name: readable, not a helper of another column (`owneridname`). */
export function selectable(c: RestColumn): boolean {
  if (!c.readable || c.attributeOf) return false;
  if (c.attributeType === "Virtual") return ["MultiSelectPicklistType", "ImageType", "FileType"].includes(c.typeName);
  return c.attributeType !== "PartyList";
}

/** The name a column has in `$select` / `$filter` / `$orderby`: lookups are `_x_value`. */
export function wireName(column: string, meta: RestTable | undefined): string {
  const c = meta?.columns.find((x) => x.logicalName === column);
  return isLookup(c) ? `_${column}_value` : column;
}

/** A short type tag for lists ("Text", "Lookup"…). */
export function typeLabel(c: RestColumn): string {
  if (isMultiChoice(c)) return "Choices";
  if (c.typeName === "ImageType") return "Image";
  if (c.typeName === "FileType") return "File";
  const map: Record<string, string> = {
    String: "Text",
    Memo: "Multiline",
    Picklist: "Choice",
    State: "Status",
    Status: "Status reason",
    Uniqueidentifier: "Unique id",
    DateTime: "Date",
    Boolean: "Yes/No",
    EntityName: "Table name",
  };
  return map[c.attributeType] ?? c.attributeType;
}

// ---------- values ----------

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const isGuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

/** The GUID inside `s` (a record link, `{...}`), else `s` trimmed. */
export function cleanId(s: string): string {
  const m = s.match(GUID);
  return m ? m[0].toLowerCase() : s.trim();
}

/** What the user pasted as a record id: an alternate key as is, a record link's `id=`, else the GUID in it. */
export function recordIdFrom(s: string): string {
  const v = s.trim();
  if (/^[A-Za-z_]\w*\s*=/.test(v)) return v;
  const m = v.match(/[?&]id=(?:%7b|\{)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : cleanId(v);
}

/** An OData string literal. */
export const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Characters that would break a query string, encoded; the rest stays readable. */
export const lightEncode = (s: string) => s.replace(/[%&#+]/g, (c) => encodeURIComponent(c));

const truthy = (v: string) => /^(1|true|yes|y)$/i.test(v.trim());

/** A value as an OData literal for `$filter`, by the column's type. */
export function literal(value: string, c: RestColumn | undefined): string {
  const v = value.trim();
  if (!c) {
    if (/^-?\d+(\.\d+)?$/.test(v) || isGuid(v) || /^(true|false|null)$/i.test(v)) return v;
    return quote(value);
  }
  if (c.attributeType === "Boolean") return truthy(v) ? "true" : "false";
  if (isLookup(c) || c.attributeType === "Uniqueidentifier") return cleanId(v);
  if (NUMBER_TYPES.has(c.attributeType) || CHOICE_TYPES.has(c.attributeType)) return v || "0";
  if (c.attributeType === "DateTime") return v;
  return quote(value);
}

// ---------- filter operators ----------

/** How many values an operator takes: none, one, a number of days…, a list. */
export type Arity = "none" | "one" | "number" | "list";

interface OpInfo {
  label: string;
  arity: Arity;
  /** For which column types (undefined = every type). */
  types?: (c: RestColumn | undefined) => boolean;
  /** A `Microsoft.Dynamics.CRM.*` query function (names the column by its logical name). */
  custom?: boolean;
  build: (name: string, values: string, c: RestColumn | undefined) => string;
}

const crm = (fn: string, name: string, extra?: string) =>
  `Microsoft.Dynamics.CRM.${fn}(PropertyName=${quote(name)}${extra !== undefined ? `,${extra}` : ""})`;
const listOf = (values: string, c: RestColumn | undefined) =>
  values
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => quote(c && (isLookup(c) || c.attributeType === "Uniqueidentifier") ? cleanId(v) : v));
const isDate = (c: RestColumn | undefined) => c?.attributeType === "DateTime";
const isText = (c: RestColumn | undefined) => !c || TEXT_TYPES.has(c.attributeType);
const notMulti = (c: RestColumn | undefined) => !isMultiChoice(c);

export const OPERATORS: Record<string, OpInfo> = {
  eq: { label: "Equals", arity: "one", types: notMulti, build: (n, v, c) => `${n} eq ${literal(v, c)}` },
  ne: { label: "Does not equal", arity: "one", types: notMulti, build: (n, v, c) => `${n} ne ${literal(v, c)}` },
  gt: { label: "Greater than", arity: "one", types: (c) => !c || !isText(c), build: (n, v, c) => `${n} gt ${literal(v, c)}` },
  ge: { label: "Greater or equal", arity: "one", types: (c) => !c || !isText(c), build: (n, v, c) => `${n} ge ${literal(v, c)}` },
  lt: { label: "Less than", arity: "one", types: (c) => !c || !isText(c), build: (n, v, c) => `${n} lt ${literal(v, c)}` },
  le: { label: "Less or equal", arity: "one", types: (c) => !c || !isText(c), build: (n, v, c) => `${n} le ${literal(v, c)}` },
  contains: { label: "Contains", arity: "one", types: isText, build: (n, v) => `contains(${n},${quote(v)})` },
  notcontains: { label: "Does not contain", arity: "one", types: isText, build: (n, v) => `not contains(${n},${quote(v)})` },
  startswith: { label: "Begins with", arity: "one", types: isText, build: (n, v) => `startswith(${n},${quote(v)})` },
  endswith: { label: "Ends with", arity: "one", types: isText, build: (n, v) => `endswith(${n},${quote(v)})` },
  null: { label: "Does not contain data", arity: "none", build: (n) => `${n} eq null` },
  notnull: { label: "Contains data", arity: "none", build: (n) => `${n} ne null` },
  in: { label: "Is one of", custom: true, arity: "list", types: notMulti, build: (n, v, c) => crm("In", n, `PropertyValues=[${listOf(v, c).join(",")}]`) },
  notin: { label: "Is not one of", custom: true, arity: "list", types: notMulti, build: (n, v, c) => crm("NotIn", n, `PropertyValues=[${listOf(v, c).join(",")}]`) },
  containvalues: { label: "Contains values", custom: true, arity: "list", types: isMultiChoice, build: (n, v, c) => crm("ContainValues", n, `PropertyValues=[${listOf(v, c).join(",")}]`) },
  notcontainvalues: { label: "Does not contain values", custom: true, arity: "list", types: isMultiChoice, build: (n, v, c) => crm("DoesNotContainValues", n, `PropertyValues=[${listOf(v, c).join(",")}]`) },
  equserid: { label: "Equals current user", custom: true, arity: "none", types: (c) => c?.attributeType === "Owner" || c?.attributeType === "Lookup", build: (n) => crm("EqualUserId", n) },
  today: { label: "Today", custom: true, arity: "none", types: isDate, build: (n) => crm("Today", n) },
  yesterday: { label: "Yesterday", custom: true, arity: "none", types: isDate, build: (n) => crm("Yesterday", n) },
  thisweek: { label: "This week", custom: true, arity: "none", types: isDate, build: (n) => crm("ThisWeek", n) },
  thismonth: { label: "This month", custom: true, arity: "none", types: isDate, build: (n) => crm("ThisMonth", n) },
  lastmonth: { label: "Last month", custom: true, arity: "none", types: isDate, build: (n) => crm("LastMonth", n) },
  thisyear: { label: "This year", custom: true, arity: "none", types: isDate, build: (n) => crm("ThisYear", n) },
  lastxdays: { label: "Last X days", custom: true, arity: "number", types: isDate, build: (n, v) => crm("LastXDays", n, `PropertyValue=${parseInt(v, 10) || 0}`) },
  nextxdays: { label: "Next X days", custom: true, arity: "number", types: isDate, build: (n, v) => crm("NextXDays", n, `PropertyValue=${parseInt(v, 10) || 0}`) },
  olderxdays: { label: "Older than X days", custom: true, arity: "number", types: isDate, build: (n, v) => crm("OlderThanXDays", n, `PropertyValue=${parseInt(v, 10) || 0}`) },
  on: { label: "On", custom: true, arity: "one", types: isDate, build: (n, v) => crm("On", n, `PropertyValue=${quote(v.trim())}`) },
  onorafter: { label: "On or after", custom: true, arity: "one", types: isDate, build: (n, v) => crm("OnOrAfter", n, `PropertyValue=${quote(v.trim())}`) },
  onorbefore: { label: "On or before", custom: true, arity: "one", types: isDate, build: (n, v) => crm("OnOrBefore", n, `PropertyValue=${quote(v.trim())}`) },
};

export const operatorsFor = (c: RestColumn | undefined) =>
  Object.entries(OPERATORS)
    .filter(([, o]) => !o.types || o.types(c))
    .map(([k]) => k);

/** One condition as `$filter` text; null while it's incomplete. */
export function conditionText(cond: Condition, meta: RestTable | undefined): string | null {
  const op = OPERATORS[cond.operator] ?? OPERATORS.eq;
  if (!cond.column.trim()) return null;
  const c = meta?.columns.find((x) => x.logicalName === cond.column);
  const empty = !cond.value.trim();
  if (empty && (op.arity === "number" || op.arity === "list" || (op.arity === "one" && !isText(c)))) return null;
  // Query functions (`Microsoft.Dynamics.CRM.In`) take the logical name; operators take `_x_value` for lookups.
  return op.build(op.custom ? cond.column : wireName(cond.column, meta), cond.value, c);
}

// ---------- functions / actions ----------

export interface OperationTemplate {
  name: string;
  kind: "function" | "action";
  bound?: { scope: "record" | "collection"; table: string };
  params: Omit<Param, "id">[];
  description: string;
}

/** Common operations, to start from (any other name works too). */
export const OPERATIONS: OperationTemplate[] = [
  { name: "WhoAmI", kind: "function", params: [], description: "The calling user, business unit and organization ids" },
  { name: "RetrieveVersion", kind: "function", params: [], description: "The Dataverse version" },
  {
    name: "RetrieveCurrentOrganization",
    kind: "function",
    params: [{ name: "AccessType", type: "enum", table: "EndpointAccessType", value: "Default" }],
    description: "Organization details and endpoints",
  },
  {
    name: "RetrieveTotalRecordCount",
    kind: "function",
    params: [{ name: "EntityNames", type: "json", value: "['account','contact']" }],
    description: "Approximate row counts (from the last snapshot)",
  },
  {
    name: "RetrieveUserPrivileges",
    kind: "function",
    bound: { scope: "record", table: "systemuser" },
    params: [],
    description: "Every privilege of a user",
  },
  {
    name: "RetrievePrincipalAccess",
    kind: "function",
    bound: { scope: "record", table: "systemuser" },
    params: [{ name: "Target", type: "record", table: "account", value: "" }],
    description: "A user's access rights to a record",
  },
  {
    name: "CalculateRollupField",
    kind: "function",
    params: [
      { name: "Target", type: "record", table: "account", value: "" },
      { name: "FieldName", type: "string", value: "" },
    ],
    description: "Recalculates a rollup column now",
  },
  {
    name: "InitializeFrom",
    kind: "function",
    params: [
      { name: "EntityMoniker", type: "record", table: "account", value: "" },
      { name: "TargetEntityName", type: "string", value: "contact" },
      { name: "TargetFieldType", type: "enum", table: "TargetFieldType", value: "All" },
    ],
    description: "A new record's values mapped from another record",
  },
  { name: "PublishAllXml", kind: "action", params: [], description: "Publishes all customizations" },
  {
    name: "PublishXml",
    kind: "action",
    params: [{ name: "ParameterXml", type: "string", value: "<importexportxml><entities><entity>account</entity></entities></importexportxml>" }],
    description: "Publishes some customizations",
  },
  {
    name: "ExecuteWorkflow",
    kind: "action",
    bound: { scope: "record", table: "workflow" },
    params: [{ name: "EntityId", type: "guid", value: "" }],
    description: "Runs an on-demand classic workflow on a record",
  },
  {
    name: "SendEmail",
    kind: "action",
    bound: { scope: "record", table: "email" },
    params: [{ name: "IssueSend", type: "boolean", value: "true" }],
    description: "Sends an email activity",
  },
  {
    name: "GrantAccess",
    kind: "action",
    params: [
      { name: "Target", type: "record", table: "account", value: "" },
      { name: "PrincipalAccess", type: "json", value: '{"Principal":{"@odata.type":"Microsoft.Dynamics.CRM.systemuser","systemuserid":""},"AccessMask":"ReadAccess"}' },
    ],
    description: "Shares a record with a user or team",
  },
];

/** A parameter as a URL literal (function parameters go in the URL as aliases). */
function paramLiteral(p: Param, entitySetOf: (t: string) => string | undefined): string {
  const v = p.value.trim();
  switch (p.type) {
    case "string":
      return quote(p.value);
    case "number":
      return v || "0";
    case "boolean":
      return truthy(v) ? "true" : "false";
    case "guid":
    case "datetime":
      return p.type === "guid" ? cleanId(v) : v;
    case "enum":
      return `Microsoft.Dynamics.CRM.${p.table || "Enum"}'${v}'`;
    case "record":
      return `{'@odata.id':'${entitySetOf(p.table ?? "") ?? `${p.table}s`}(${cleanId(v)})'}`;
    case "json":
      return v || "null";
  }
}

/** A parameter as a JSON body value (actions). */
export function paramValue(p: Param, primaryIdOf: (t: string) => string): unknown {
  const v = p.value.trim();
  switch (p.type) {
    case "string":
      return p.value;
    case "number":
      return Number(v) || 0;
    case "boolean":
      return truthy(v);
    case "guid":
      return cleanId(v);
    case "datetime":
    case "enum":
      return v;
    case "record":
      return { "@odata.type": `Microsoft.Dynamics.CRM.${p.table}`, [primaryIdOf(p.table ?? "")]: cleanId(v) };
    case "json":
      try {
        return JSON.parse(v || "null");
      } catch {
        return v;
      }
  }
}

// ---------- create / update values ----------

/** The navigation property a lookup sets for `target` (`parentcustomerid_account`). */
export function lookupNav(column: string, target: string | undefined, meta: RestTable | undefined): NavProperty | undefined {
  const navs = meta?.navigation.filter((n) => n.kind === "single" && n.column === column) ?? [];
  return navs.find((n) => n.table === target) ?? (navs.length === 1 ? navs[0] : undefined);
}

/** Create / update body: `{ name: "A", "primarycontactid@odata.bind": "/contacts(…)" }`. */
export function recordBody(
  fields: FieldValue[],
  meta: RestTable | undefined,
  entitySetOf: (t: string) => string | undefined,
  problems: string[]
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    const name = f.column.trim();
    if (!name) continue;
    const c = meta?.columns.find((x) => x.logicalName === name);
    const v = f.value.trim();
    const isNull = /^null$/i.test(v);
    // Blank text is a value (""); anything else blank is a value not typed yet.
    if (!v && !(c && TEXT_TYPES.has(c.attributeType))) {
      problems.push(`Enter a value for ${name} (null clears it).`);
      continue;
    }
    if (isLookup(c)) {
      const target = f.table || c?.targets?.[0];
      const nav = lookupNav(name, target, meta);
      const key = `${nav?.name ?? name}@odata.bind`;
      if (!nav) problems.push(`No navigation property found for the lookup ${name}${target ? ` → ${target}` : ""}.`);
      if (isNull) body[key] = null;
      else {
        const set = target ? entitySetOf(target) : undefined;
        if (!set) problems.push(`Pick the table ${name} points at.`);
        body[key] = `/${set ?? target ?? "table"}(${cleanId(v)})`;
      }
      continue;
    }
    if (isNull) body[name] = null;
    else if (!c) body[name] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : /^(true|false)$/i.test(v) ? v.toLowerCase() === "true" : f.value;
    else if (c.attributeType === "Boolean") body[name] = truthy(v);
    else if (NUMBER_TYPES.has(c.attributeType) || CHOICE_TYPES.has(c.attributeType)) body[name] = Number(v) || 0;
    else if (isMultiChoice(c)) body[name] = v.split(",").map((x) => x.trim()).filter(Boolean).join(",");
    else if (c.attributeType === "Uniqueidentifier") body[name] = cleanId(v);
    else body[name] = f.value;
  }
  return body;
}

// ---------- the request ----------

export interface BuiltRequest {
  method: Method;
  /** `accounts`, `accounts(id)`, `WhoAmI()`, `accounts(id)/contact_customer_accounts/$ref`… */
  resource: string;
  /** Query options with readable values (`["$select", "name,accountid"]`). */
  query: [string, string][];
  headers: [string, string][];
  body?: unknown;
  /** Associate: the record linked to, relative to the Web API root (`contacts(id)`). */
  refTarget?: string;
  /** FetchXML: the query (sent URL-encoded as `?fetchXml=`). */
  fetchXml?: string;
  /** The table the request is about (its logical name), when there is one. */
  table?: string;
  entitySet?: string;
  /** Why it can't be sent yet. */
  problems: string[];
}

export interface BuildContext {
  /** The request's table. */
  meta: RestTable | undefined;
  /** Other tables (expand targets, a lookup's table) once loaded. */
  metaOf: (table: string) => RestTable | undefined;
  /** Entity set of any table (from the table list). */
  entitySetOf: (table: string) => string | undefined;
}

export const BASE_HEADERS: [string, string][] = [
  ["OData-MaxVersion", "4.0"],
  ["OData-Version", "4.0"],
  ["Accept", "application/json"],
];

/** `Prefer` for a read: labels and lookup names, page size. */
export function readPrefer(req: RestRequest): string | null {
  const parts: string[] = [];
  if (req.formatted) parts.push('odata.include-annotations="*"');
  const size = parseInt(req.pageSize, 10);
  if (req.kind === "retrieveMultiple" && size > 0) parts.push(`odata.maxpagesize=${size}`);
  return parts.length ? parts.join(",") : null;
}

/** `name1,name2` for `$select`, lookups as `_x_value`. */
const selectList = (columns: string[], meta: RestTable | undefined) => columns.map((c) => wireName(c, meta)).join(",");

/** The record part of a URL: `(guid)` or `(key='value')`. */
function recordKey(id: string, problems: string[]): string {
  const v = id.trim();
  if (!v) {
    problems.push("Enter the record's id.");
    return "(id)";
  }
  const g = cleanId(v);
  if (isGuid(g)) return `(${g})`;
  // An alternate key: `accountnumber='A1'` (several: `a='1',b=2`).
  if (/^[A-Za-z_][\w]*\s*=/.test(v)) return `(${v})`;
  problems.push("The id isn't a GUID or an alternate key (name='value').");
  return `(${v})`;
}

function expandList(req: RestRequest, ctx: BuildContext): string {
  return req.expand
    .filter((e) => e.nav.trim())
    .map((e) => {
      const nav = ctx.meta?.navigation.find((n) => n.name === e.nav);
      const target = nav ? ctx.metaOf(nav.table) : undefined;
      return e.columns.length ? `${e.nav}($select=${selectList(e.columns, target)})` : e.nav;
    })
    .join(",");
}

export function buildRequest(req: RestRequest, ctx: BuildContext): BuiltRequest {
  const problems: string[] = [];
  const headers: [string, string][] = [...BASE_HEADERS];
  const query: [string, string][] = [];
  const table = req.table.trim().toLowerCase();
  const entitySet = (table && (ctx.meta?.logicalName === table ? ctx.meta.entitySet : ctx.entitySetOf(table))) || undefined;
  const needsTable = req.kind !== "fetchXml" && !((req.kind === "function" || req.kind === "action") && req.bound === "none");
  if (needsTable && !table) problems.push("Pick a table.");
  else if (needsTable && !entitySet) problems.push(`Table ${table} has no Web API collection (entity set).`);
  const set = entitySet ?? (table ? `${table}s` : "table");
  const out = (method: Method, resource: string, extra: Partial<BuiltRequest> = {}): BuiltRequest => ({
    method,
    resource,
    query,
    headers,
    problems,
    table: table || undefined,
    entitySet,
    ...extra,
  });
  const prefer = readPrefer(req);

  switch (req.kind) {
    case "retrieve": {
      const key = recordKey(req.id, problems);
      if (req.columns.length) query.push(["$select", selectList(req.columns, ctx.meta)]);
      const expand = expandList(req, ctx);
      if (expand) query.push(["$expand", expand]);
      if (prefer) headers.push(["Prefer", prefer]);
      return out("GET", `${set}${key}`);
    }
    case "retrieveMultiple": {
      if (req.columns.length) query.push(["$select", selectList(req.columns, ctx.meta)]);
      const expand = expandList(req, ctx);
      if (expand) query.push(["$expand", expand]);
      const parts = req.conditions.map((c) => conditionText(c, ctx.meta)).filter((x): x is string => !!x);
      if (parts.length) query.push(["$filter", parts.join(` ${req.filterType} `)]);
      const order = req.orderBy.filter((o) => o.column.trim()).map((o) => `${wireName(o.column, ctx.meta)} ${o.desc ? "desc" : "asc"}`);
      if (order.length) query.push(["$orderby", order.join(",")]);
      const top = parseInt(req.top, 10);
      if (req.top.trim() && !(top > 0)) problems.push("Top must be a positive number.");
      if (top > 0) query.push(["$top", String(top)]);
      if (req.count) query.push(["$count", "true"]);
      if (prefer) headers.push(["Prefer", prefer]);
      return out("GET", set);
    }
    case "fetchXml": {
      const parsed = parseFetch(req.fetchXml);
      if (!parsed.ok) {
        problems.push(parsed.line ? `XML error, line ${parsed.line}: ${parsed.error}` : parsed.error);
        return out("GET", "table", { fetchXml: req.fetchXml });
      }
      const fetchTable = parsed.fetch.entity;
      const fetchSet = ctx.meta?.logicalName === fetchTable ? ctx.meta.entitySet : ctx.entitySetOf(fetchTable);
      if (!fetchSet) problems.push(`Table ${fetchTable} has no Web API collection (entity set).`);
      if (req.formatted) headers.push(["Prefer", 'odata.include-annotations="*"']);
      return { ...out("GET", fetchSet ?? `${fetchTable}s`, { fetchXml: req.fetchXml }), table: fetchTable, entitySet: fetchSet };
    }
    case "function":
    case "action": {
      const name = req.operation.trim();
      if (!name) problems.push(`Enter the ${req.kind}'s name.`);
      else if (!/^[A-Za-z_][\w.]*$/.test(name)) problems.push(`"${name}" isn't a valid ${req.kind} name.`);
      const qualified = req.bound === "none" ? name : `Microsoft.Dynamics.CRM.${name}`;
      const prefix = req.bound === "record" ? `${set}${recordKey(req.id, problems)}/` : req.bound === "collection" ? `${set}/` : "";
      const params = req.params.filter((p) => p.name.trim());
      if (req.kind === "function") {
        const args = params.map((p, i) => `${p.name.trim()}=@p${i + 1}`).join(",");
        params.forEach((p, i) => {
          if (p.type === "record" && !p.table) problems.push(`Pick the table of ${p.name}.`);
          query.push([`@p${i + 1}`, paramLiteral(p, ctx.entitySetOf)]);
        });
        if (prefer) headers.push(["Prefer", prefer]);
        return out("GET", `${prefix}${qualified || "Function"}(${args})`);
      }
      const primaryIdOf = (t: string) => ctx.metaOf(t)?.primaryId ?? `${t}id`;
      const body = Object.fromEntries(params.map((p) => [p.name.trim(), paramValue(p, primaryIdOf)]));
      headers.push(["Content-Type", "application/json; charset=utf-8"]);
      return out("POST", `${prefix}${qualified || "Action"}`, { body });
    }
    case "create":
    case "update": {
      const body = recordBody(req.fields, ctx.meta, (t) => (ctx.metaOf(t)?.entitySet ?? ctx.entitySetOf(t)), problems);
      if (!Object.keys(body).length) problems.push("Add at least one column value.");
      headers.push(["Content-Type", "application/json; charset=utf-8"]);
      if (req.kind === "update" && req.preventCreate) headers.push(["If-Match", "*"]);
      if (req.returnRecord) {
        headers.push(["Prefer", req.formatted ? 'return=representation,odata.include-annotations="*"' : "return=representation"]);
        if (req.columns.length) query.push(["$select", selectList(req.columns, ctx.meta)]);
      }
      return req.kind === "create" ? out("POST", set, { body }) : out("PATCH", `${set}${recordKey(req.id, problems)}`, { body });
    }
    case "delete":
      return out("DELETE", `${set}${recordKey(req.id, problems)}`);
    case "associate":
    case "disassociate": {
      const key = recordKey(req.id, problems);
      const nav = ctx.meta?.navigation.find((n) => n.name === req.nav);
      if (!req.nav.trim()) problems.push("Pick the relationship (navigation property).");
      const relatedSet = nav ? ctx.metaOf(nav.table)?.entitySet ?? ctx.entitySetOf(nav.table) : undefined;
      const related = req.relatedId.trim() ? cleanId(req.relatedId) : "";
      const single = nav?.kind === "single";
      if (req.kind === "associate") {
        if (!related) problems.push("Enter the related record's id.");
        if (nav && !relatedSet) problems.push(`Table ${nav.table} has no Web API collection (entity set).`);
        headers.push(["Content-Type", "application/json; charset=utf-8"]);
        const refTarget = `${relatedSet ?? "table"}(${related || "id"})`;
        return out(single ? "PUT" : "POST", `${set}${key}/${req.nav || "nav"}/$ref`, { body: { "@odata.id": refTarget }, refTarget });
      }
      if (!single && !related) problems.push("Enter the related record's id.");
      return out("DELETE", single ? `${set}${key}/${req.nav || "nav"}/$ref` : `${set}${key}/${req.nav || "nav"}(${related || "id"})/$ref`);
    }
  }
}

/** `?$select=…&$filter=…` with readable values. */
export const queryString = (b: BuiltRequest) => (b.query.length ? `?${b.query.map(([k, v]) => `${k}=${lightEncode(v)}`).join("&")}` : "");

/** The request's path under the Web API root, readable. */
export function readablePath(b: BuiltRequest): string {
  if (b.fetchXml !== undefined) return `${b.resource}?fetchXml=${b.fetchXml.replace(/\s*\n\s*/g, "").trim()}`;
  return b.resource + queryString(b);
}

/** Like the backend: characters outside the URL-safe set percent-encoded. */
export function wireEncode(s: string): string {
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9\-._~!$&'()*+,;=:@/?%[\]]/.test(ch)) out += ch;
    else out += Array.from(new TextEncoder().encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  }
  return out;
}

/** The path as sent: FetchXML fully encoded, other values encoded where needed. */
export function wirePath(b: BuiltRequest): string {
  if (b.fetchXml !== undefined) return `${b.resource}?fetchXml=${encodeURIComponent(b.fetchXml)}`;
  return wireEncode(b.resource + queryString(b));
}

/** The grid columns a read asks for, in order (`_x_value` → `x`, as `flatten` names them). */
export function expectedColumns(req: RestRequest): string[] {
  return req.columns.slice();
}
