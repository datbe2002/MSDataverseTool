// JSON shown as a tree: keys and values coloured by type, objects and arrays
// that open and close, and JSON kept inside a string (an HTTP body, a
// Compose of a stringified object) opened as JSON too.
import { useState } from "react";
import { ChevronDown } from "./Icon";

/** The value of a JSON text (a leading BOM and spaces ignored); undefined when it isn't JSON. */
export function parseJson(text: string): unknown | undefined {
  const t = text.replace(/^﻿/, "").trim();
  if (!t || !/^[[{"]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** A string that holds an object or array as JSON. */
function innerJson(s: string): object | undefined {
  const t = s.trim();
  if (t.length < 2 || !((t[0] === "{" && t.endsWith("}")) || (t[0] === "[" && t.endsWith("]")))) return undefined;
  const v = parseJson(t);
  return v !== null && typeof v === "object" ? (v as object) : undefined;
}

/** Children shown at first; more on demand (a 2 MB output can hold thousands). */
const PAGE = 200;
/** Characters of a long string shown before "show all". */
const LONG = 600;

export function JsonView({ value, depth = 2 }: { value: unknown; depth?: number }) {
  return (
    <div className="font-mono text-[12px] leading-5" role="tree">
      <JsonNode name={null} value={value} level={0} open={depth} last />
    </div>
  );
}

function JsonNode({
  name,
  value,
  level,
  open: openTo,
  last,
  fromString,
}: {
  /** Key in its object, index in its array; null for the root. */
  name: string | number | null;
  value: unknown;
  level: number;
  /** Levels opened at first. */
  open: number;
  last: boolean;
  /** An object or array that was a JSON string. */
  fromString?: boolean;
}) {
  const [open, setOpen] = useState(level < openTo);
  const [shown, setShown] = useState(PAGE);
  const nested = typeof value === "string" ? innerJson(value) : undefined;
  if (nested) return <JsonNode name={name} value={nested} level={level} open={openTo} last={last} fromString />;

  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === "object";
  const indent = { paddingLeft: level * 16 };
  const comma = last ? "" : ",";

  const key =
    name === null ? null : (
      <>
        <span className={typeof name === "number" ? "text-subtle" : "text-[var(--brand)]"}>{typeof name === "number" ? name : JSON.stringify(name)}</span>
        <span className="text-subtle">: </span>
      </>
    );

  if (!isObject) {
    return (
      <div className="flex" style={indent} role="treeitem">
        <span className="w-4 shrink-0" />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
          {key}
          <Primitive value={value} />
          <span className="text-subtle">{comma}</span>
        </span>
      </div>
    );
  }

  const entries: [string | number, unknown][] = isArray ? (value as unknown[]).map((v, i) => [i, v]) : Object.entries(value as object);
  const [openBrace, closeBrace] = isArray ? ["[", "]"] : ["{", "}"];
  const count = `${entries.length} ${isArray ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}`;
  const tag = fromString && (
    <span className="ml-1.5 rounded bg-s3 px-1 py-px font-sans text-[10px] font-medium text-subtle" title="This value is a string holding JSON">
      JSON string
    </span>
  );

  if (!entries.length) {
    return (
      <div className="flex" style={indent} role="treeitem">
        <span className="w-4 shrink-0" />
        <span>
          {key}
          <span className="text-subtle">
            {openBrace}
            {closeBrace}
            {comma}
          </span>
          {tag}
        </span>
      </div>
    );
  }

  return (
    <div role="treeitem" aria-expanded={open}>
      <button
        className="flex w-full items-start rounded-sm text-left hover:bg-s3/60"
        style={indent}
        onClick={() => setOpen((o) => !o)}
        title={open ? "Collapse" : "Expand"}
      >
        <ChevronDown size={12} className={`mt-1 w-4 shrink-0 text-subtle transition-transform duration-150 ${open ? "" : "-rotate-90"}`} />
        <span className="min-w-0">
          {key}
          <span className="text-subtle">{openBrace}</span>
          {!open && (
            <>
              <span className="mx-1 rounded bg-s3 px-1 font-sans text-[10.5px] text-subtle">{count}</span>
              <span className="text-subtle">
                {closeBrace}
                {comma}
              </span>
            </>
          )}
          {tag}
        </span>
      </button>
      {open && (
        <>
          <div role="group">
            {entries.slice(0, shown).map(([k, v], i) => (
              <JsonNode key={k} name={isArray ? i : k} value={v} level={level + 1} open={openTo} last={i === entries.length - 1} />
            ))}
            {entries.length > shown && (
              <div style={{ paddingLeft: (level + 1) * 16 + 16 }}>
                <button className="font-sans text-[11.5px] text-brand hover:underline" onClick={() => setShown((n) => n + PAGE * 5)}>
                  Show {Math.min(PAGE * 5, entries.length - shown)} more of {entries.length - shown}
                </button>
              </div>
            )}
          </div>
          <div style={{ paddingLeft: level * 16 + 16 }} className="text-subtle">
            {closeBrace}
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

function Primitive({ value }: { value: unknown }) {
  const [all, setAll] = useState(false);
  if (value === null) return <span className="text-subtle italic">null</span>;
  if (typeof value === "boolean") return <span className="text-[var(--warning)]">{String(value)}</span>;
  if (typeof value === "number") return <span className="text-[var(--info)]">{value}</span>;
  const s = String(value);
  const long = s.length > LONG && !all;
  return (
    <>
      {/* Shown as read (line breaks as lines), not escaped: Copy gives the JSON. */}
      <span className="whitespace-pre-wrap text-[var(--success)]">"{long ? s.slice(0, LONG) : s}"</span>
      {long && (
        <button className="ml-1 font-sans text-[11px] text-brand hover:underline" onClick={() => setAll(true)}>
          +{(s.length - LONG).toLocaleString()} characters
        </button>
      )}
    </>
  );
}
