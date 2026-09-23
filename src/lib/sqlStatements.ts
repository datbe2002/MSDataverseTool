// Splits a SQL script into individual statements — like SSMS, no `;` required.
//
// A new statement begins at a top-level statement keyword
// (SELECT / INSERT / UPDATE / DELETE / WITH), except where that keyword
// continues the current statement:
//   - SELECT after UNION / ALL / INTERSECT / EXCEPT / INTO
//   - the SELECT of an INSERT ... SELECT
//   - the main SELECT after a WITH ... (CTE)
//   - WITH used as a table hint, e.g. `FROM t WITH (NOLOCK)`
// A `;` is always a hard boundary. Strings, [brackets], "quotes", comments
// and parentheses (sub-queries) are skipped so nothing inside them splits.

const START_KEYWORDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "WITH"]);
const SELECT_CONTINUERS = new Set(["UNION", "ALL", "INTERSECT", "EXCEPT", "INTO"]);

type StartKind = "" | "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "WITH";

const isWordStart = (c: string) => /[A-Za-z_]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_]/.test(c);

function nextNonSpace(sql: string, from: number): string {
  let i = from;
  while (i < sql.length && /\s/.test(sql[i])) i++;
  return sql[i] ?? "";
}

function isEmptyStatement(s: string): boolean {
  return (
    s
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .trim().length === 0
  );
}

export function splitStatements(sql: string): string[] {
  const n = sql.length;
  const boundaries = [0];
  let depth = 0;
  let i = 0;

  // Per-statement state.
  let stmtStart: StartKind = "";
  let prevWord = "";
  let hasContent = false;
  let insertSelectSeen = false;
  let withSelectSeen = false;

  const beginStatement = (at: number) => {
    if (at > boundaries[boundaries.length - 1]) boundaries.push(at);
    stmtStart = "";
    prevWord = "";
    hasContent = false;
    insertSelectSeen = false;
    withSelectSeen = false;
  };

  while (i < n) {
    const c = sql[i];

    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      hasContent = true;
      i++;
      continue;
    }
    if (c === "[") {
      while (i < n && sql[i] !== "]") i++;
      hasContent = true;
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && sql[i] !== '"') i++;
      hasContent = true;
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "(") {
      depth++;
      hasContent = true;
      i++;
      continue;
    }
    if (c === ")") {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (c === ";" && depth === 0) {
      i++;
      beginStatement(i);
      continue;
    }

    if (depth === 0 && isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j])) j++;
      const word = sql.slice(i, j).toUpperCase();

      if (START_KEYWORDS.has(word)) {
        let boundary = false;
        if (hasContent) {
          if (word === "SELECT") {
            boundary =
              !SELECT_CONTINUERS.has(prevWord) &&
              !(stmtStart === "INSERT" && !insertSelectSeen) &&
              !(stmtStart === "WITH" && !withSelectSeen);
          } else if (word === "WITH") {
            boundary = nextNonSpace(sql, j) !== "(";
          } else {
            boundary = true; // INSERT / UPDATE / DELETE
          }
        }
        if (boundary) {
          beginStatement(i);
        }
        if (!stmtStart) stmtStart = word as StartKind;
        if (word === "SELECT") {
          if (stmtStart === "INSERT") insertSelectSeen = true;
          if (stmtStart === "WITH") withSelectSeen = true;
        }
      }

      prevWord = word;
      hasContent = true;
      i = j;
      continue;
    }

    if (depth === 0 && !/\s/.test(c)) hasContent = true;
    i++;
  }

  const out: string[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const from = boundaries[b];
    const to = b + 1 < boundaries.length ? boundaries[b + 1] : n;
    const text = sql.slice(from, to).trim();
    if (text.length > 0 && !isEmptyStatement(text)) out.push(text);
  }
  return out;
}

export function isWriteStatement(sql: string): boolean {
  return /^\s*(update|delete|insert)\b/i.test(
    sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")
  );
}
