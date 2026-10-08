// Code samples for a REST builder request: Xrm.WebApi, fetch, XMLHttpRequest,
// the raw HTTP request, C# (HttpClient) and the Power Automate Dataverse
// connector. All of them are built from the same `BuiltRequest`.
import {
  isChoice,
  isLookup,
  queryString,
  readablePath,
  typeLabel,
  wireName,
  wirePath,
  paramValue,
  type BuiltRequest,
  type Param,
  type RestRequest,
} from "./restModel";
import type { RestTable } from "../types";

export type CodeTarget = "xrm" | "fetch" | "xhr" | "http" | "csharp" | "flow";

export const TARGETS: { id: CodeTarget; label: string; language: string; hint: string }[] = [
  { id: "xrm", label: "Xrm.WebApi", language: "javascript", hint: "Form scripts and web resources inside a model-driven app" },
  { id: "fetch", label: "fetch", language: "javascript", hint: "JavaScript fetch() against the Web API URL" },
  { id: "xhr", label: "XHR", language: "javascript", hint: "JavaScript XMLHttpRequest" },
  { id: "http", label: "HTTP", language: "http", hint: "The raw request — for Postman, .http files, curl" },
  { id: "csharp", label: "C#", language: "csharp", hint: "HttpClient (.NET)" },
  { id: "flow", label: "Power Automate", language: "plaintext", hint: "The Microsoft Dataverse connector action to use" },
];

export interface CodeContext {
  /** Environment host (`org.crm.dynamics.com`). */
  host: string;
  req: RestRequest;
  built: BuiltRequest;
  meta: RestTable | undefined;
  metaOf: (table: string) => RestTable | undefined;
}

const API = "/api/data/v9.2/";
const CLIENT_URL = "Xrm.Utility.getGlobalContext().getClientUrl()";
const js = (v: unknown) => JSON.stringify(v);
const indent = (text: string, pad: string) => text.replace(/\n/g, `\n${pad}`);
const json = (v: unknown, pad = "") => indent(JSON.stringify(v, null, 2), pad);

/** Read requests that return rows / a record (so field lines are worth listing). */
const returnsRows = (k: RestRequest["kind"]) => k === "retrieve" || k === "retrieveMultiple";

/** FetchXML as JS lines joined at run time, readable in the sample. */
function fetchXmlJs(xml: string): string {
  const lines = xml.replace(/\s+$/, "").split("\n");
  return `[\n${lines.map((l) => `  ${js(l)}`).join(",\n")}\n].join("\\n")`;
}

/** One line per selected column, like `var name = result["name"]; // Text`. */
function fieldLines(ctx: CodeContext, row: string, pad: string, annotations: boolean): string {
  const { req, meta } = ctx;
  if (!returnsRows(req.kind)) return "";
  const cols = req.columns.length ? req.columns : [];
  if (!cols.length) return `${pad}// Every column came back: ${row}["<column>"]\n`;
  const out: string[] = [];
  for (const name of cols) {
    const c = meta?.columns.find((x) => x.logicalName === name);
    const wire = wireName(name, meta);
    const v = name.replace(/[^\w]/g, "_");
    out.push(`${pad}var ${v} = ${row}[${js(wire)}]; // ${c ? typeLabel(c) : "column"}`);
    if (annotations && c && (isLookup(c) || isChoice(c) || c.attributeType === "Boolean" || c.attributeType === "DateTime" || c.attributeType === "Money")) {
      out.push(`${pad}var ${v}_formatted = ${row}[${js(`${wire}@OData.Community.Display.V1.FormattedValue`)}];`);
    }
    if (annotations && isLookup(c)) out.push(`${pad}var ${v}_lookuplogicalname = ${row}[${js(`${wire}@Microsoft.Dynamics.CRM.lookuplogicalname`)}];`);
  }
  return out.join("\n") + "\n";
}

// ---------- Xrm.WebApi ----------

const XRM_TYPES: Record<Param["type"], [string, number]> = {
  string: ["Edm.String", 1],
  number: ["Edm.Int32", 1],
  boolean: ["Edm.Boolean", 1],
  guid: ["Edm.Guid", 1],
  datetime: ["Edm.DateTimeOffset", 1],
  enum: ["", 3],
  record: ["", 5],
  json: ["Edm.String", 1],
};

function xrm(ctx: CodeContext): string {
  const { req, built } = ctx;
  const table = built.table ?? req.table;
  const id = req.id.trim();
  const options = queryString(built);
  const fail = `function (error) {\n  console.log(error.message);\n}`;
  const then = (body: string) => `.then(\n  function success(result) {\n${body}  },\n  ${indent(fail, "  ")}\n);`;
  switch (req.kind) {
    case "retrieve":
      return `Xrm.WebApi.retrieveRecord(${js(table)}, ${js(id)}${options ? `, ${js(options)}` : ""})${then(fieldLines(ctx, "result", "    ", true))}`;
    case "retrieveMultiple": {
      const size = parseInt(req.pageSize, 10);
      // Xrm.WebApi takes $select, $filter, $orderby, $expand and $top only.
      const xrmOptions = queryString({ ...built, query: built.query.filter(([k]) => k !== "$count") });
      return (
        (req.count ? "// Xrm.WebApi doesn't return @odata.count; use the fetch sample for the total.\n" : "") +
        `Xrm.WebApi.retrieveMultipleRecords(${js(table)}${xrmOptions || size > 0 ? `, ${js(xrmOptions)}` : ""}${size > 0 ? `, ${size}` : ""})` +
        then(
          `    for (var i = 0; i < result.entities.length; i++) {\n      var row = result.entities[i];\n${fieldLines(ctx, "row", "      ", true)}    }\n` +
            `    // More rows: result.nextLink (pass it as the options of the next call)\n`
        )
      );
    }
    case "fetchXml":
      return (
        `var fetchXml = ${fetchXmlJs(built.fetchXml ?? "")};\n\n` +
        `Xrm.WebApi.retrieveMultipleRecords(${js(table)}, "?fetchXml=" + encodeURIComponent(fetchXml))` +
        then(`    for (var i = 0; i < result.entities.length; i++) {\n      var row = result.entities[i];\n      console.log(row);\n    }\n`)
      );
    case "create":
      return `var record = ${json(built.body)};\n\nXrm.WebApi.createRecord(${js(table)}, record)${then(`    var newId = result.id;\n    console.log(newId);\n`)}`;
    case "update":
      return (
        `var record = ${json(built.body)};\n\n` +
        (req.preventCreate ? "" : "// Xrm.WebApi.updateRecord never creates the record (no upsert).\n") +
        `Xrm.WebApi.updateRecord(${js(table)}, ${js(id)}, record)${then(`    console.log("Updated " + result.id);\n`)}`
      );
    case "delete":
      return `Xrm.WebApi.deleteRecord(${js(table)}, ${js(id)})${then(`    console.log("Deleted " + result.id);\n`)}`;
    case "associate":
    case "disassociate": {
      const nav = ctx.meta?.navigation.find((n) => n.name === req.nav);
      const related = req.relatedId.trim();
      const fields =
        req.kind === "associate"
          ? `  relatedEntities: [{ entityType: ${js(nav?.table ?? "table")}, id: ${js(related)} }],\n`
          : nav?.kind === "single"
          ? ""
          : `  relatedEntityId: ${js(related)},\n`;
      return (
        `var request = {\n  target: { entityType: ${js(table)}, id: ${js(id)} },\n${fields}  relationship: ${js(nav?.schemaName ?? req.nav)},\n` +
        `  getMetadata: function () {\n    return { boundParameter: null, parameterTypes: {}, operationType: 2, operationName: ${js(req.kind === "associate" ? "Associate" : "Disassociate")} };\n  }\n};\n\n` +
        `Xrm.WebApi.online.execute(request).then(\n  function success(response) {\n    if (response.ok) console.log("Done");\n  },\n  ${indent(fail, "  ")}\n);`
      );
    }
    case "function":
    case "action": {
      if (req.bound === "collection") {
        return `// Xrm.WebApi.online.execute can't call a ${req.kind} bound to a whole table.\n// Use the fetch sample instead.`;
      }
      const params = req.params.filter((p) => p.name.trim());
      const lines: string[] = [];
      const types: string[] = [];
      if (req.bound === "record") {
        lines.push(`  entity: { entityType: ${js(table)}, id: ${js(id)} },`);
        types.push(`        entity: { typeName: ${js(`mscrm.${table}`)}, structuralProperty: 5 },`);
      }
      const primaryIdOf = (t: string) => ctx.metaOf(t)?.primaryId ?? `${t}id`;
      for (const p of params) {
        const name = p.name.trim();
        let [typeName, structural] = XRM_TYPES[p.type];
        const value = p.type === "json" ? safeJson(p.value) : paramValue(p, primaryIdOf);
        lines.push(`  ${safeKey(name)}: ${js(value)},`);
        // A list is a collection; an object a complex type (often named like the parameter).
        if (p.type === "json" && Array.isArray(value)) [typeName, structural] = ["Collection(Edm.String)", 4];
        else if (p.type === "json" && value && typeof value === "object") [typeName, structural] = [`mscrm.${name}`, 2];
        const tn = p.type === "enum" ? `mscrm.${p.table || "Enum"}` : p.type === "record" ? `mscrm.${p.table}` : typeName;
        types.push(`        ${safeKey(name)}: { typeName: ${js(tn)}, structuralProperty: ${structural} },`);
      }
      return (
        `var request = {\n${lines.join("\n")}${lines.length ? "\n" : ""}` +
        `  getMetadata: function () {\n    return {\n      boundParameter: ${req.bound === "record" ? '"entity"' : "null"},\n      parameterTypes: {\n${types.join("\n")}${types.length ? "\n" : ""}      },\n` +
        `      operationType: ${req.kind === "function" ? 1 : 0},\n      operationName: ${js(req.operation.trim())}\n    };\n  }\n};\n\n` +
        `Xrm.WebApi.online.execute(request).then(\n  function success(response) {\n    if (response.ok) return response.status === 204 ? null : response.json();\n  }\n).then(\n  function (result) {\n    console.log(result);\n  },\n  ${indent(fail, "  ")}\n);`
      );
    }
  }
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v.replace(/'/g, '"'));
  } catch {
    return v;
  }
}

const safeKey = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : js(k));

// ---------- fetch / XMLHttpRequest ----------

/** The JS expression for the request URL. */
function jsUrl(ctx: CodeContext): string {
  const { built } = ctx;
  if (built.fetchXml !== undefined) return `${CLIENT_URL} + ${js(API + built.resource + "?fetchXml=")} + encodeURIComponent(fetchXml)`;
  return `${CLIENT_URL} + ${js(API + readablePath(built))}`;
}

/** The JS body: the record / parameters, or the `$ref` link with the client URL. */
function jsBody(ctx: CodeContext): string | null {
  const { built } = ctx;
  if (built.body === undefined) return null;
  if (built.refTarget) return `{ "@odata.id": ${CLIENT_URL} + ${js(API + built.refTarget)} }`;
  return json(built.body);
}

const isWriteNoContent = (ctx: CodeContext) =>
  ctx.req.kind === "delete" || ctx.req.kind === "associate" || ctx.req.kind === "disassociate" || ((ctx.req.kind === "create" || ctx.req.kind === "update") && !ctx.req.returnRecord);

function resultLines(ctx: CodeContext, pad: string): string {
  const { req } = ctx;
  if (req.kind === "retrieveMultiple" || req.kind === "fetchXml") {
    return (
      `${pad}for (var i = 0; i < result.value.length; i++) {\n${pad}  var row = result.value[i];\n` +
      (req.kind === "fetchXml" ? `${pad}  console.log(row);\n` : fieldLines(ctx, "row", `${pad}  `, req.formatted)) +
      `${pad}}\n` +
      (req.kind === "fetchXml"
        ? `${pad}// More rows: result["@Microsoft.Dynamics.CRM.morerecords"] and its paging cookie\n`
        : `${pad}// More rows: result["@odata.nextLink"]\n`)
    );
  }
  if (req.kind === "retrieve") return fieldLines(ctx, "result", pad, req.formatted);
  return `${pad}console.log(result);\n`;
}

function fetchJs(ctx: CodeContext): string {
  const { built, req } = ctx;
  const pre = built.fetchXml !== undefined ? `var fetchXml = ${fetchXmlJs(built.fetchXml)};\n\n` : "";
  const body = jsBody(ctx);
  const headers = built.headers.map(([k, v]) => `    ${js(k)}: ${js(v)}`).join(",\n");
  const call = `fetch(${jsUrl(ctx)}, {\n  method: ${js(built.method)},\n  headers: {\n${headers}\n  }${body ? `,\n  body: JSON.stringify(${indent(body, "  ")})` : ""}\n})`;
  if (isWriteNoContent(ctx)) {
    const created =
      req.kind === "create"
        ? `    var uri = response.headers.get("OData-EntityId");\n    var newId = uri.substring(uri.lastIndexOf("(") + 1, uri.length - 1);\n    console.log(newId);\n`
        : `    console.log("Done");\n`;
    return (
      pre +
      `${call}.then(function (response) {\n  if (response.ok) {\n${created}  } else {\n    return response.json().then(function (json) { throw json.error; });\n  }\n})` +
      `.catch(function (error) {\n  console.log(error.message);\n});`
    );
  }
  return (
    pre +
    `${call}.then(function (response) {\n  if (response.status === 204) return null;\n  return response.json().then(function (json) {\n    if (response.ok) return json;\n    throw json.error;\n  });\n})` +
    `.then(function (result) {\n${resultLines(ctx, "  ")}})` +
    `.catch(function (error) {\n  console.log(error.message);\n});`
  );
}

function xhr(ctx: CodeContext): string {
  const { built, req } = ctx;
  const pre = built.fetchXml !== undefined ? `var fetchXml = ${fetchXmlJs(built.fetchXml)};\n\n` : "";
  const body = jsBody(ctx);
  const headers = built.headers.map(([k, v]) => `req.setRequestHeader(${js(k)}, ${js(v)});`).join("\n");
  const success = isWriteNoContent(ctx)
    ? req.kind === "create"
      ? `      var uri = req.getResponseHeader("OData-EntityId");\n      var newId = uri.substring(uri.lastIndexOf("(") + 1, uri.length - 1);\n      console.log(newId);\n`
      : `      console.log("Done");\n`
    : `      var result = this.status === 204 ? null : JSON.parse(this.response);\n${resultLines(ctx, "      ")}`;
  return (
    pre +
    `var req = new XMLHttpRequest();\nreq.open(${js(built.method)}, ${jsUrl(ctx)}, true);\n${headers}\n` +
    `req.onreadystatechange = function () {\n  if (this.readyState === 4) {\n    req.onreadystatechange = null;\n    if (this.status >= 200 && this.status < 300) {\n${success}    } else {\n      var error = JSON.parse(this.response).error;\n      console.log(error.message);\n    }\n  }\n};\n` +
    `req.send(${body ? `JSON.stringify(${body})` : ""});`
  );
}

// ---------- HTTP ----------

function http(ctx: CodeContext): string {
  const { built, host } = ctx;
  const base = `https://${host}${API}`;
  const lines = [`${built.method} ${base}${wirePath(built)} HTTP/1.1`, "Authorization: Bearer <access token>", ...built.headers.map(([k, v]) => `${k}: ${v}`)];
  let body = "";
  if (built.refTarget) body = json({ "@odata.id": base + built.refTarget });
  else if (built.body !== undefined) body = json(built.body);
  return lines.join("\n") + (body ? `\n\n${body}` : "") + "\n";
}

// ---------- C# ----------

const cs = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function csharp(ctx: CodeContext): string {
  const { built, host } = ctx;
  const method = { GET: "HttpMethod.Get", POST: "HttpMethod.Post", PUT: "HttpMethod.Put", DELETE: "HttpMethod.Delete", PATCH: 'new HttpMethod("PATCH")' }[built.method];
  const out: string[] = [
    "// using System.Linq; using System.Net.Http; using System.Text;",
    `// client: an HttpClient with BaseAddress = new Uri("https://${host}${API}")`,
    "//         and an Authorization: Bearer <token> default header.",
  ];
  if (built.fetchXml !== undefined) {
    out.push(`var fetchXml = @"${built.fetchXml.replace(/"/g, '""').replace(/\s+$/, "")}";`);
    out.push(`var request = new HttpRequestMessage(${method}, ${cs(built.resource + "?fetchXml=")} + Uri.EscapeDataString(fetchXml));`);
  } else {
    out.push(`var request = new HttpRequestMessage(${method}, ${cs(readablePath(built))});`);
  }
  for (const [k, v] of built.headers) {
    if (k === "Content-Type" || k === "Accept") continue;
    out.push(`request.Headers.TryAddWithoutValidation(${cs(k)}, ${cs(v)});`);
  }
  out.push(`request.Headers.Accept.ParseAdd("application/json");`);
  let body: string | null = null;
  if (built.refTarget) body = JSON.stringify({ "@odata.id": `https://${host}${API}${built.refTarget}` }, null, 2);
  else if (built.body !== undefined) body = JSON.stringify(built.body, null, 2);
  if (body !== null) out.push(`request.Content = new StringContent(@"${body.replace(/"/g, '""')}", Encoding.UTF8, "application/json");`);
  out.push(
    "",
    "using var response = await client.SendAsync(request);",
    "var json = await response.Content.ReadAsStringAsync();",
    "if (!response.IsSuccessStatusCode) throw new Exception(json);"
  );
  if (ctx.req.kind === "create" && !ctx.req.returnRecord) out.push('var newRecordUri = response.Headers.GetValues("OData-EntityId").First();');
  else if (!isWriteNoContent(ctx)) out.push("using var doc = System.Text.Json.JsonDocument.Parse(json);");
  return out.join("\n") + "\n";
}

// ---------- Power Automate ----------

function flow(ctx: CodeContext): string {
  const { req, built, meta, host } = ctx;
  const tableName = meta?.collectionDisplayName || meta?.displayName || built.table || req.table;
  const select = built.query.find(([k]) => k === "$select")?.[1];
  const q = (k: string) => built.query.find(([n]) => n === k)?.[1];
  const lines: string[] = [];
  const add = (label: string, value: string | undefined | null) => value && lines.push(`${label}: ${value}`);
  const colLabel = (name: string) => {
    const c = meta?.columns.find((x) => x.logicalName === name.replace(/@odata\.bind$/, "").replace(/_[a-z]+$/, "")) ?? meta?.columns.find((x) => x.logicalName === name);
    return c?.displayName ? `${c.displayName} (${name})` : name;
  };
  switch (req.kind) {
    case "retrieve":
      lines.push("Action: Get a row by ID (Microsoft Dataverse)");
      add("Table name", tableName);
      add("Row ID", req.id.trim());
      add("Select columns", select);
      add("Expand Query", q("$expand"));
      break;
    case "retrieveMultiple":
      lines.push("Action: List rows (Microsoft Dataverse)");
      add("Table name", tableName);
      add("Select columns", select);
      add("Filter rows", q("$filter"));
      add("Sort By", q("$orderby"));
      add("Expand Query", q("$expand"));
      add("Row count", q("$top"));
      if (req.pageSize.trim()) lines.push("# Paging: Settings → Pagination on, with a threshold");
      break;
    case "fetchXml":
      lines.push("Action: List rows (Microsoft Dataverse)");
      add("Table name", tableName);
      lines.push("Fetch Xml Query:", (built.fetchXml ?? "").replace(/\s+$/, ""));
      break;
    case "create":
    case "update":
      lines.push(req.kind === "create" ? "Action: Add a new row (Microsoft Dataverse)" : "Action: Update a row (Microsoft Dataverse)");
      add("Table name", tableName);
      if (req.kind === "update") add("Row ID", req.id.trim());
      for (const [k, v] of Object.entries((built.body ?? {}) as Record<string, unknown>)) {
        // Lookups take the entity set and id, like /contacts(…) → "contacts(…)".
        const value = typeof v === "string" && k.endsWith("@odata.bind") ? v.replace(/^\//, "") : v === null ? "null" : typeof v === "string" ? v : JSON.stringify(v);
        lines.push(`${colLabel(k.replace(/@odata\.bind$/, ""))}: ${value}`);
      }
      if (req.kind === "update" && !req.preventCreate) lines.push("# Update a row creates the row when it doesn't exist (upsert).");
      break;
    case "delete":
      lines.push("Action: Delete a row (Microsoft Dataverse)");
      add("Table name", tableName);
      add("Row ID", req.id.trim());
      break;
    case "associate":
    case "disassociate": {
      const nav = meta?.navigation.find((n) => n.name === req.nav);
      lines.push(req.kind === "associate" ? "Action: Relate rows (Microsoft Dataverse)" : "Action: Unrelate rows (Microsoft Dataverse)");
      add("Table name", tableName);
      add("Row ID", req.id.trim());
      add("Relationship", nav ? `${nav.schemaName} (${nav.name})` : req.nav);
      const set = built.refTarget?.replace(/\(.*$/, "") ?? (nav ? ctx.metaOf(nav.table)?.entitySet : undefined) ?? "table";
      add(req.kind === "associate" ? "Relate with" : "Unrelate with", `https://${host}${API}${set}(${req.relatedId.trim()})`);
      break;
    }
    case "function":
      lines.push(
        "# The Dataverse connector can't call functions.",
        "# Use 'Invoke an HTTP request' (HTTP with Microsoft Entra ID, preauthorized) with:",
        `Method: GET`,
        `Url of the request: https://${host}${API}${readablePath(built)}`
      );
      break;
    case "action":
      lines.push(req.bound === "none" ? "Action: Perform an unbound action (Microsoft Dataverse)" : "Action: Perform a bound action (Microsoft Dataverse)");
      if (req.bound !== "none") add("Table name", tableName);
      add("Action Name", req.bound === "none" ? req.operation.trim() : `Microsoft.Dynamics.CRM.${req.operation.trim()}`);
      if (req.bound === "record") add("Row ID", req.id.trim());
      for (const [k, v] of Object.entries((built.body ?? {}) as Record<string, unknown>)) lines.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
      break;
  }
  return lines.join("\n") + "\n";
}

export function generateCode(target: CodeTarget, ctx: CodeContext): string {
  switch (target) {
    case "xrm":
      return xrm(ctx);
    case "fetch":
      return fetchJs(ctx);
    case "xhr":
      return xhr(ctx);
    case "http":
      return http(ctx);
    case "csharp":
      return csharp(ctx);
    case "flow":
      return flow(ctx);
  }
}
