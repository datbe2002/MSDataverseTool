// Schema-aware SQL autocomplete for the Monaco editor.
//
//   SELECT c|              -> columns of every table in FROM/JOIN, then tables, keywords
//   SELECT a.|             -> columns of the table aliased `a`
//   FROM |  / JOIN |       -> table names
import type * as Monaco from "monaco-editor";
import { useStore } from "../store";
import { useSchema } from "./schema";
import type { ColumnMeta } from "../types";

const KEYWORDS = [
  "SELECT", "TOP", "DISTINCT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS NULL",
  "IS NOT NULL", "LIKE", "BETWEEN", "EXISTS", "JOIN", "INNER JOIN", "LEFT JOIN",
  "LEFT OUTER JOIN", "RIGHT JOIN", "CROSS JOIN", "ON", "AS", "GROUP BY", "ORDER BY",
  "HAVING", "ASC", "DESC", "COUNT", "SUM", "AVG", "MIN", "MAX", "CASE", "WHEN",
  "THEN", "ELSE", "END", "CAST", "CONVERT", "UNION", "UNION ALL", "WITH", "OFFSET",
  "FETCH NEXT", "ROWS ONLY", "GETDATE()", "GETUTCDATE()", "DATEADD", "DATEDIFF",
  "ISNULL", "COALESCE",
];

// Words that can follow a table name but are never an alias.
const NOT_ALIAS = new Set([
  "where", "join", "inner", "left", "right", "full", "outer", "cross", "on", "order",
  "group", "having", "union", "with", "as", "select", "set", "values", "option", "for",
]);

interface TableRef {
  table: string;
  alias?: string;
}

const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** `[dbo].[contact]` / `dbo.contact` / `contact` -> `contact` */
const unquote = (ident: string) => {
  const parts = ident.split(".");
  return parts[parts.length - 1].replace(/^\[|\]$/g, "");
};

export function parseTableRefs(sql: string): TableRef[] {
  const re =
    /\b(?:from|join)\s+((?:\[[^\]]+\]|\w+)(?:\.(?:\[[^\]]+\]|\w+))*)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi;
  const refs: TableRef[] = [];
  for (const m of stripComments(sql).matchAll(re)) {
    const alias = m[2]?.toLowerCase();
    refs.push({
      table: unquote(m[1]).toLowerCase(),
      alias: alias && !NOT_ALIAS.has(alias) ? alias : undefined,
    });
  }
  return refs;
}

let registered = false;

export function registerSqlCompletion(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;

  const Kind = monaco.languages.CompletionItemKind;

  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: ["."],

    async provideCompletionItems(model, position) {
      const lineBefore = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1);
      if (lineBefore.includes("--")) return { suggestions: [] };

      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const keywordItems = (): Monaco.languages.CompletionItem[] =>
        KEYWORDS.map((k) => ({
          label: k,
          kind: Kind.Keyword,
          insertText: k,
          range,
          sortText: `3_${k}`,
        }));

      const connId = useStore.getState().activeId;
      if (!connId) return { suggestions: keywordItems() };

      const schema = useSchema.getState();
      const tables = await schema.loadTables(connId);
      const known = new Set(tables.map((t) => t.logicalName));

      const tableItems = (): Monaco.languages.CompletionItem[] =>
        tables.map((t) => ({
          label: {
            label: t.logicalName,
            detail: t.displayName ? `  ${t.displayName}` : undefined,
            description: t.isCustom ? "custom table" : "table",
          },
          kind: Kind.Class,
          insertText: t.logicalName,
          filterText: t.logicalName,
          range,
          sortText: `2_${t.logicalName}`,
        }));

      const columnItems = (
        table: string,
        cols: ColumnMeta[]
      ): Monaco.languages.CompletionItem[] =>
        cols.map((c) => ({
          label: {
            label: c.logicalName,
            detail: c.displayName ? `  ${c.displayName}` : undefined,
            description: `${c.attributeType} · ${table}`,
          },
          kind: Kind.Field,
          insertText: c.logicalName,
          filterText: c.logicalName,
          range,
          sortText: `0_${c.logicalName}`,
        }));

      const textBefore = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const refs = parseTableRefs(model.getValue());

      // alias.|  or  table.|
      const qualified = /(\[[^\]]+\]|\w+)\.\w*$/.exec(textBefore);
      if (qualified) {
        const q = unquote(qualified[1]).toLowerCase();
        const table =
          refs.find((r) => r.alias === q)?.table ?? (known.has(q) ? q : undefined);
        if (!table) return { suggestions: [] };
        return {
          suggestions: columnItems(table, await schema.loadColumns(connId, table)),
        };
      }

      // FROM |  JOIN |
      if (/\b(?:from|join|into|update)\s+[\w[\]]*$/i.test(textBefore)) {
        return { suggestions: tableItems() };
      }

      // Anywhere else: columns of the tables used in this query first.
      const inQuery = [...new Set(refs.map((r) => r.table))].filter((t) =>
        known.has(t)
      );
      const columnLists = await Promise.all(
        inQuery.map((t) => schema.loadColumns(connId, t))
      );
      return {
        suggestions: [
          ...inQuery.flatMap((t, i) => columnItems(t, columnLists[i])),
          ...tableItems(),
          ...keywordItems(),
        ],
      };
    },
  });
}
