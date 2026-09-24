// Autocomplete in the FetchXML editor: elements that fit where the cursor
// is, their attributes, and values — tables, the right table's columns,
// operators for the column's type, choice options, join aliases.
import type * as Monaco from "monaco-editor";
import { useStore } from "../store";
import { useSchema } from "./schema";
import { useChoices } from "./flowChoices";
import { CHILDREN, OPERATORS, operatorsFor } from "./fetchModel";
import type { ColumnMeta } from "../types";

interface Open {
  tag: string;
  attrs: Record<string, string>;
}

type Where =
  | { kind: "element"; prefix: string; parent: Open | null; stack: Open[] }
  | { kind: "close"; prefix: string; open: Open | null }
  | { kind: "attribute"; tag: string; prefix: string; attrs: Record<string, string>; stack: Open[] }
  | { kind: "value"; tag: string; attr: string; prefix: string; attrs: Record<string, string>; stack: Open[] }
  | null;

const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(text); m; m = ATTR.exec(text)) out[m[1]] = m[2] ?? m[3] ?? "";
  return out;
}

/** What's being typed at the end of `before` (the text up to the cursor). */
export function whereAt(before: string): Where {
  const stack: Open[] = [];
  let last = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(before); m; m = TAG.exec(before)) {
    last = m.index + m[0].length;
    if (m[2] === undefined) continue;
    if (m[1] === "/") {
      const i = stack.map((o) => o.tag).lastIndexOf(m[2]);
      if (i >= 0) stack.length = i;
    } else if (m[4] !== "/") {
      stack.push({ tag: m[2], attrs: attrsOf(m[3]) });
    }
  }
  const rest = before.slice(last);
  const lt = rest.lastIndexOf("<");
  if (lt === -1) return null;
  const partial = rest.slice(lt);
  if (partial.includes(">")) return null;
  const close = partial.match(/^<\/([\w-]*)$/);
  if (close) return { kind: "close", prefix: close[1], open: stack[stack.length - 1] ?? null };
  const el = partial.match(/^<([\w-]*)$/);
  if (el) return { kind: "element", prefix: el[1], parent: stack[stack.length - 1] ?? null, stack };
  const head = partial.match(/^<([\w-]+)\s/);
  if (!head) return null;
  const tag = head[1];
  const value = partial.match(/([\w-]+)\s*=\s*["']([^"']*)$/);
  // Attributes written so far (the one being typed isn't closed yet).
  const attrs = attrsOf(value ? partial.slice(0, partial.length - value[0].length) : partial);
  if (value) return { kind: "value", tag, attr: value[1], prefix: value[2], attrs, stack };
  const name = partial.match(/\s([\w-]*)$/);
  if (name) return { kind: "attribute", tag, prefix: name[1], attrs, stack };
  return null;
}

/** Snippet for a new element (tab stops where the names go). */
const ELEMENT_SNIPPETS: Record<string, { text: string; doc: string; suggestAfter?: boolean }> = {
  fetch: { text: "fetch top=\"50\">\n\t$0\n</fetch>", doc: "The query" },
  entity: { text: "entity name=\"$1\">\n\t$0\n</entity>", doc: "The table to read", suggestAfter: true },
  attribute: { text: "attribute name=\"$1\" />", doc: "A column", suggestAfter: true },
  "all-attributes": { text: "all-attributes />", doc: "Every column (slow — prefer listing columns)" },
  order: { text: "order attribute=\"$1\" descending=\"false\" />", doc: "Sort", suggestAfter: true },
  filter: { text: "filter type=\"and\">\n\t$0\n</filter>", doc: "A group of conditions (and / or)" },
  condition: { text: "condition attribute=\"$1\" operator=\"$2\" value=\"$3\" />", doc: "A test on a column", suggestAfter: true },
  "link-entity": {
    text: "link-entity name=\"$1\" from=\"$2\" to=\"$3\" alias=\"$4\" link-type=\"outer\">\n\t$0\n</link-entity>",
    doc: "A join to another table",
    suggestAfter: true,
  },
  value: { text: "value>$1</value>", doc: "One value of in / between" },
};

const ATTRIBUTES: Record<string, [string, string][]> = {
  fetch: [
    ["top", "Most rows (up to 5,000)"],
    ["count", "Page size"],
    ["page", "Page number"],
    ["distinct", "Only distinct rows"],
    ["aggregate", "count / sum / group by query"],
    ["no-lock", "Don't wait for locks"],
    ["returntotalrecordcount", "Return the total row count"],
    ["latematerialize", "Join late (performance)"],
  ],
  entity: [["name", "Table"]],
  "link-entity": [
    ["name", "Table to join"],
    ["from", "Column on the joined table"],
    ["to", "Column on the parent table"],
    ["alias", "Name for the join"],
    ["link-type", "inner, outer, exists, …"],
    ["intersect", "Join only, no columns"],
    ["visible", "Show in views"],
  ],
  attribute: [
    ["name", "Column"],
    ["alias", "Name in the result"],
    ["aggregate", "count, sum, avg, min, max"],
    ["groupby", "Group by this column"],
    ["dategrouping", "day, week, month, …"],
    ["distinct", "Count distinct values"],
    ["usertimezone", "Group dates in the user's time zone"],
  ],
  order: [
    ["attribute", "Column"],
    ["alias", "Alias (aggregate queries)"],
    ["descending", "Z → A"],
    ["entityname", "Join to sort by"],
  ],
  filter: [
    ["type", "and / or"],
    ["hint", "Query hint"],
  ],
  condition: [
    ["attribute", "Column"],
    ["operator", "How to compare"],
    ["value", "Value"],
    ["entityname", "Join the column belongs to"],
    ["valueof", "Compare with another column"],
  ],
};

const BOOLEAN_ATTRS = new Set(["distinct", "aggregate", "no-lock", "returntotalrecordcount", "latematerialize", "descending", "groupby", "intersect", "visible", "usertimezone"]);
const ENUMS: Record<string, string[]> = {
  "filter.type": ["and", "or"],
  "link-entity.link-type": ["inner", "outer", "exists", "in", "any", "not any", "all", "not all", "matchfirstrowusingcrossapply"],
  "attribute.aggregate": ["count", "countcolumn", "sum", "avg", "min", "max"],
  "attribute.dategrouping": ["day", "week", "month", "quarter", "year", "fiscal-period", "fiscal-year"],
};

/** The table `tag`'s columns belong to, from the elements around the cursor. */
function tableFor(tag: string, attrs: Record<string, string>, stack: Open[], text: string, attr: string): string | null {
  const owner = (from: Open[]) => [...from].reverse().find((o) => o.tag === "entity" || o.tag === "link-entity")?.attrs.name ?? null;
  if (tag === "link-entity") return attr === "from" ? attrs.name ?? null : owner(stack);
  if ((tag === "condition" || tag === "order") && attrs.entityname) {
    const alias = attrs.entityname;
    for (const m of text.matchAll(/<link-entity\b([^>]*)>/g)) {
      const la = attrsOf(m[1]);
      if ((la.alias || la.name) === alias) return la.name ?? null;
    }
    return null;
  }
  return owner(stack);
}

let registered = false;

/** Once per app: completions for the FetchXML tool's editors (`fetch-*.xml` models only). */
export function registerFetchCompletion(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  const K = monaco.languages.CompletionItemKind;
  const snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const suggestAgain = { id: "editor.action.triggerSuggest", title: "Suggest" };

  monaco.languages.registerCompletionItemProvider("xml", {
    triggerCharacters: ["<", " ", '"', "'", "/"],
    provideCompletionItems: async (model, position) => {
      if (!model.uri.path.includes("/fetch-")) return { suggestions: [] };
      const connId = useStore.getState().activeId;
      const text = model.getValue();
      const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const where = whereAt(before);
      if (!where) return { suggestions: [] };
      const range = (prefix: string) => ({
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - prefix.length,
        endColumn: position.column,
      });

      if (where.kind === "element") {
        const kinds = where.parent ? CHILDREN[where.parent.tag] ?? [] : ["fetch"];
        return {
          suggestions: kinds.map((k, i) => {
            const s = ELEMENT_SNIPPETS[k];
            return {
              label: k,
              kind: K.Module,
              detail: s.doc,
              insertText: s.text,
              insertTextRules: snippet,
              range: range(where.prefix),
              sortText: String(i).padStart(2, "0"),
              command: s.suggestAfter ? suggestAgain : undefined,
            };
          }),
        };
      }
      if (where.kind === "close") {
        return where.open
          ? { suggestions: [{ label: `/${where.open.tag}>`, kind: K.Module, insertText: `${where.open.tag}>`, range: range(where.prefix) }] }
          : { suggestions: [] };
      }
      if (where.kind === "attribute") {
        const list = (ATTRIBUTES[where.tag] ?? []).filter(([n]) => !(n in where.attrs));
        return {
          suggestions: list.map(([n, doc], i) => ({
            label: n,
            kind: K.Property,
            detail: doc,
            insertText: `${n}="$1"`,
            insertTextRules: snippet,
            range: range(where.prefix),
            sortText: String(i).padStart(2, "0"),
            command: suggestAgain,
          })),
        };
      }

      // ---- attribute values ----
      const { tag, attr, attrs, stack, prefix } = where;
      const r = range(prefix);
      const plain = (values: { label: string; detail?: string; doc?: string }[], kind = K.Value) => ({
        suggestions: values.map((v, i) => ({ label: v.label, kind, detail: v.detail, documentation: v.doc, insertText: v.label, range: r, sortText: String(i).padStart(4, "0") })),
      });
      if (BOOLEAN_ATTRS.has(attr)) return plain([{ label: "true" }, { label: "false" }]);
      const enumValues = ENUMS[`${tag}.${attr}`];
      if (enumValues) return plain(enumValues.map((label) => ({ label })));
      if (!connId) return { suggestions: [] };

      if ((tag === "entity" || tag === "link-entity") && attr === "name") {
        const tables = await useSchema.getState().loadTables(connId);
        return plain(tables.map((t) => ({ label: t.logicalName, detail: t.displayName })), K.Class);
      }
      if ((tag === "condition" || tag === "order") && attr === "entityname") {
        const aliases = [...text.matchAll(/<link-entity\b([^>]*)>/g)].map((m) => attrsOf(m[1])).filter((a) => a.alias);
        return plain(aliases.map((a) => ({ label: a.alias, detail: a.name })));
      }

      const columnAttr =
        (tag === "attribute" && attr === "name") ||
        (tag === "order" && attr === "attribute") ||
        (tag === "condition" && (attr === "attribute" || attr === "valueof")) ||
        (tag === "link-entity" && (attr === "from" || attr === "to"));
      const table = tableFor(tag, attrs, stack, text, attr);
      const columns = async (): Promise<ColumnMeta[]> =>
        table && /^[A-Za-z0-9_]+$/.test(table) ? useSchema.getState().loadColumns(connId, table) : [];

      if (columnAttr) {
        const cols = await columns();
        return plain(cols.map((c) => ({ label: c.logicalName, detail: `${c.displayName || ""}${c.displayName ? " · " : ""}${c.attributeType}` })), K.Field);
      }
      if (tag === "condition" && attr === "operator") {
        const type = attrs.attribute ? (await columns()).find((c) => c.logicalName === attrs.attribute.toLowerCase())?.attributeType : undefined;
        return plain(operatorsFor(type).map((o) => ({ label: o, detail: OPERATORS[o]?.label })), K.Operator);
      }
      if (tag === "condition" && attr === "value" && attrs.attribute && table) {
        const type = (await columns()).find((c) => c.logicalName === attrs.attribute.toLowerCase())?.attributeType;
        if (type === "Boolean") return plain([{ label: "1", detail: "Yes" }, { label: "0", detail: "No" }]);
        const key = `${connId}|${table}`;
        const entry = useChoices.getState().tables[key];
        if (!entry) useChoices.getState().load(connId, table);
        const options = entry && typeof entry !== "string" ? entry.columns[attrs.attribute.toLowerCase()] : undefined;
        if (options) return plain(options.map((o) => ({ label: String(o.value), detail: o.label })));
      }
      return { suggestions: [] };
    },
  });
}
