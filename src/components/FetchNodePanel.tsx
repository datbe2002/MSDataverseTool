import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  OPERATORS,
  applyRelationship,
  arityOf,
  conditionValues,
  isAggregate,
  linkAliases,
  operatorsFor,
  ownerTable,
  setAttr,
  setConditionValues,
  setOperator,
  setTable,
  tableOf,
  toggleColumn,
  addChild,
} from "../lib/fetchModel";
import { useColumns, useTableChoices, useTableRelationships, useTables } from "../lib/fetchMeta";
import { useStore } from "../store";
import { kindName } from "./FetchTree";
import { Loader, Plus, Search, X } from "./Icon";
import type { ColumnMeta, Relationship } from "../types";

/** Changes the selected element; `merge` = part of typing (no separate undo step). */
export type Mutate = (fn: (el: Element, doc: XMLDocument) => Element | null | void, merge?: boolean) => void;

interface Option {
  value: string;
  label?: string;
  hint?: string;
}

// ---------- small controls ----------

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  // A div, not a label: some fields hold lists of checkboxes (labels can't nest).
  return (
    <div role="group" aria-label={label} className="min-w-0">
      <span className="mb-1 block text-[11px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-subtle">{hint}</span>}
    </div>
  );
}

/** Text input that writes on Enter / leaving the field (the XML doesn't change per keystroke). */
function TextField({
  value,
  onCommit,
  placeholder,
  mono = true,
  type = "text",
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: "text" | "number";
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft.trim());
  return (
    <input
      className={`input h-8 text-[12.5px] ${mono ? "font-mono" : ""}`}
      value={draft}
      type={type}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(value);
      }}
      spellCheck={false}
    />
  );
}

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-center gap-2 text-[12.5px] text-fg" title={hint}>
      <input type="checkbox" className="accent-[var(--brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Option[] }) {
  return (
    <select className="input h-8 font-mono text-[12.5px]" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label ?? o.value}
        </option>
      ))}
    </select>
  );
}

/** Narrowest the suggestion list gets: wide enough for a long logical name and its display name. */
const LIST_MIN_W = 420;
const LIST_MAX_H = 320;

interface ListBox {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** Where the list goes: under the input (above when there's no room), at least LIST_MIN_W wide, inside the window. */
function placeList(input: HTMLElement): ListBox {
  const r = input.getBoundingClientRect();
  const margin = 8;
  const width = Math.min(Math.max(r.width, LIST_MIN_W), window.innerWidth - margin * 2);
  const left = Math.min(Math.max(margin, r.left), window.innerWidth - margin - width);
  const below = window.innerHeight - r.bottom - margin;
  const above = r.top - margin;
  if (below >= Math.min(LIST_MAX_H, 200) || below >= above) {
    return { left, width, top: r.bottom + 4, maxHeight: Math.min(LIST_MAX_H, below - 4) };
  }
  return { left, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(LIST_MAX_H, above - 4) };
}

/**
 * Searchable picker that also takes any typed value (a column the metadata
 * doesn't list still works). Writes on pick / Enter / leaving the field.
 */
export function Combo({
  value,
  onCommit,
  options,
  placeholder,
  loading,
  hintSpace,
}: {
  value: string;
  onCommit: (v: string) => void;
  options: Option[] | undefined;
  placeholder?: string;
  loading?: boolean;
  /** Always keep the line under the input (for the picked option's label), so the field's height never changes — for forms with fields side by side. */
  hintSpace?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState<ListBox | null>(null);
  useEffect(() => setDraft(value), [value]);

  // The list floats over the page (panels are narrow), following the input when things scroll or resize.
  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    const update = () => inputRef.current && setBox(placeList(inputRef.current));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  const q = draft.trim().toLowerCase();
  const filtered = useMemo(() => {
    const all = options ?? [];
    if (!open || !q || q === value.toLowerCase()) return all.slice(0, 300);
    return all
      .filter((o) => o.value.toLowerCase().includes(q) || o.label?.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.value.toLowerCase().startsWith(q)) - Number(!b.value.toLowerCase().startsWith(q)))
      .slice(0, 300);
  }, [options, q, open, value]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (v: string) => {
    setDraft(v);
    setOpen(false);
    if (v !== value) onCommit(v);
  };
  const current = options?.find((o) => o.value === value);

  return (
    <div>
      <div className="relative">
        <input
          ref={inputRef}
          className="input h-8 pr-7 font-mono text-[12.5px]"
          value={draft}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onBlur={() => {
            // A click in the list lands first (onMouseDown below).
            setOpen(false);
            if (draft.trim() !== value) onCommit(draft.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              setOpen(true);
              setActive((a) => Math.min(filtered.length - 1, a + 1));
            } else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
            else if (e.key === "Enter") {
              e.preventDefault();
              pick(open && filtered[active] && q !== value.toLowerCase() ? filtered[active].value : draft.trim());
            } else if (e.key === "Escape") {
              setDraft(value);
              setOpen(false);
            } else return;
            e.preventDefault();
          }}
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
        />
        {loading && <Loader size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle" />}
      </div>
      {hintSpace ? (
        <span className="mt-1 block h-4 truncate text-[11px] leading-4 text-subtle">{current?.label ?? ""}</span>
      ) : (
        !open && current?.label && <span className="mt-1 block truncate text-[11px] text-subtle">{current.label}</span>
      )}
      {open &&
        box &&
        filtered.length > 0 &&
        createPortal(
          <ul
            ref={listRef}
            className="popover fixed z-[60] overflow-auto p-1"
            style={{ left: box.left, width: box.width, top: box.top, bottom: box.bottom, maxHeight: box.maxHeight }}
            role="listbox"
          >
            {filtered.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o.value);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 ${i === active ? "bg-brand/12" : ""}`}
                title={o.label ? `${o.value} · ${o.label}` : o.value}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px] text-fg">{o.value}</span>
                  {o.label && <span className="block truncate text-[11.5px] text-subtle">{o.label}</span>}
                </span>
                {o.hint && <span className="shrink-0 text-[11px] text-subtle">{o.hint}</span>}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </div>
  );
}

const columnOptions = (cols: ColumnMeta[] | undefined): Option[] | undefined =>
  cols?.map((c) => ({ value: c.logicalName, label: c.displayName || undefined, hint: c.attributeType }));

// ---------- panel ----------

export function FetchNodePanel({
  connId,
  doc,
  selected,
  onEdit,
  readOnly,
}: {
  connId: string;
  doc: XMLDocument;
  selected: number | null;
  onEdit: Mutate;
  readOnly: boolean;
}) {
  const el = selected === null ? null : doc.getElementsByTagName("*")[selected] ?? null;
  if (!el) {
    return <div className="p-4 text-xs text-subtle">Select an element in the tree to edit it.</div>;
  }
  const body = (() => {
    switch (el.tagName) {
      case "fetch":
        return <FetchProps el={el} onEdit={onEdit} />;
      case "entity":
        return <EntityProps connId={connId} el={el} onEdit={onEdit} />;
      case "link-entity":
        return <LinkProps connId={connId} el={el} onEdit={onEdit} />;
      case "attribute":
        return <AttributeProps connId={connId} el={el} onEdit={onEdit} />;
      case "order":
        return <OrderProps connId={connId} el={el} onEdit={onEdit} />;
      case "filter":
        return <FilterProps el={el} onEdit={onEdit} />;
      case "condition":
        return <ConditionProps connId={connId} el={el} onEdit={onEdit} />;
      case "value":
        return (
          <Field label="Value">
            <TextField value={el.textContent ?? ""} onCommit={(v) => onEdit((e) => void (e.textContent = v))} />
          </Field>
        );
      case "all-attributes":
        return <p className="text-xs text-subtle">Returns every column of the table. Pick the columns you need instead when you can — it's faster.</p>;
      default:
        return <p className="text-xs text-subtle">No settings for &lt;{el.tagName}&gt;.</p>;
    }
  })();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">{kindName(el.tagName)}</span>
        <span className="truncate font-mono text-[11px] text-subtle">&lt;{el.tagName}&gt;</span>
      </div>
      <fieldset key={selected} disabled={readOnly} className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto p-3 disabled:opacity-60">
        {readOnly && <p className="text-xs text-warning">Fix the XML error to edit here.</p>}
        {body}
      </fieldset>
    </div>
  );
}

type Props = { el: Element; onEdit: Mutate; connId: string };

/** Changes an entity's / join's table; says what went with the old one. */
function useChangeTable(el: Element, onEdit: Mutate) {
  const pushToast = useStore((s) => s.pushToast);
  return (value: string) => {
    const old = el.getAttribute("name") ?? "";
    if (!value.trim()) return; // an emptied box keeps the table
    let removed = 0;
    onEdit((e) => {
      removed = setTable(e, value);
    });
    if (removed > 0) {
      pushToast({
        tone: "info",
        title: `Removed ${removed} element${removed === 1 ? "" : "s"} of ${old}`,
        body: "Columns, sorts, filters and joins of the old table don't fit the new one. Ctrl+Z in the XML brings them back.",
      });
    }
  };
}

function FetchProps({ el, onEdit }: Omit<Props, "connId">) {
  const a = (n: string) => el.getAttribute(n) ?? "";
  const flag = (n: string) => el.getAttribute(n) === "true";
  const both = a("top") && (a("count") || a("page"));
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Top (rows)">
          <TextField type="number" value={a("top")} placeholder="all" onCommit={(v) => onEdit((e) => setAttr(e, "top", v))} />
        </Field>
        <Field label="Page size (count)">
          <TextField type="number" value={a("count")} placeholder="5000" onCommit={(v) => onEdit((e) => setAttr(e, "count", v))} />
        </Field>
      </div>
      {both && <p className="text-xs text-warning">Top can't be used with count / page — remove one of them.</p>}
      <div className="space-y-2">
        <Check label="Distinct rows" checked={flag("distinct")} onChange={(v) => onEdit((e) => setAttr(e, "distinct", v ? "true" : null))} />
        <Check
          label="Aggregate (count, sum, group by…)"
          checked={flag("aggregate")}
          onChange={(v) => onEdit((e) => setAttr(e, "aggregate", v ? "true" : null))}
        />
        <Check
          label="No lock"
          hint="Read without waiting for locks (no-lock)"
          checked={flag("no-lock")}
          onChange={(v) => onEdit((e) => setAttr(e, "no-lock", v ? "true" : null))}
        />
      </div>
    </>
  );
}

/** Columns of a table as checkboxes: checked = the table has that `<attribute>`. */
function ColumnChecklist({ connId, el, onEdit }: Props) {
  const table = el.getAttribute("name");
  const cols = useColumns(connId, table);
  const [q, setQ] = useState("");
  const [onlyPicked, setOnlyPicked] = useState(false);
  const picked = new Set(
    Array.from(el.children)
      .filter((c) => c.tagName === "attribute")
      .map((c) => c.getAttribute("name") ?? "")
  );
  const all = Array.from(el.children).some((c) => c.tagName === "all-attributes");
  if (!table) return null;
  const needle = q.trim().toLowerCase();
  const list = (cols ?? []).filter(
    (c) =>
      (!onlyPicked || picked.has(c.logicalName)) &&
      (!needle || c.logicalName.toLowerCase().includes(needle) || c.displayName.toLowerCase().includes(needle))
  );
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted">Columns</span>
        <span className="text-[11px] tabular-nums text-subtle">{all ? "all" : `${picked.size} picked`}</span>
      </div>
      <div className="mb-1 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input className="input h-7 !pl-7 text-[12px]" placeholder="Find a column…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-subtle" title="Show only the columns in the query">
          <input type="checkbox" className="accent-[var(--brand)]" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} />
          Picked
        </label>
      </div>
      {!cols ? (
        <div className="flex items-center gap-1.5 py-2 text-xs text-subtle">
          <Loader size={12} /> Loading columns…
        </div>
      ) : (
        <ul className="max-h-80 overflow-auto rounded-md border border-line bg-s1 py-0.5">
          {list.map((c) => (
            <li key={c.logicalName}>
              <label
                className="flex cursor-default items-start gap-2 px-2 py-1.5 hover:bg-s3"
                title={`${c.logicalName}${c.displayName ? ` · ${c.displayName}` : ""} · ${c.attributeType}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0 accent-[var(--brand)]"
                  checked={picked.has(c.logicalName)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    onEdit((t) => {
                      toggleColumn(t, c.logicalName, on);
                    });
                  }}
                />
                {/* Name on its own line; display name and type under it. */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px] text-fg">{c.logicalName}</span>
                  <span className="flex gap-2 text-[11px] text-subtle">
                    <span className="min-w-0 flex-1 truncate">{c.displayName}</span>
                    <span className="shrink-0">{c.attributeType}</span>
                  </span>
                </span>
              </label>
            </li>
          ))}
          {list.length === 0 && <li className="px-2 py-2 text-xs text-subtle">No columns match.</li>}
        </ul>
      )}
    </div>
  );
}

function EntityProps({ connId, el, onEdit }: Props) {
  const { tables, loading } = useTables(connId);
  const changeTable = useChangeTable(el, onEdit);
  const options = useMemo(
    () => tables?.map((t) => ({ value: t.logicalName, label: t.displayName || undefined, hint: t.isCustom ? "custom" : undefined })),
    [tables]
  );
  return (
    <>
      <Field label="Table">
        <Combo
          value={el.getAttribute("name") ?? ""}
          options={options}
          loading={loading}
          placeholder="account"
          onCommit={(v) => changeTable(v)}
        />
      </Field>
      <ColumnChecklist connId={connId} el={el} onEdit={onEdit} />
    </>
  );
}

const REL_KIND: Record<Relationship["kind"], string> = { manyToOne: "N:1", oneToMany: "1:N", manyToMany: "N:N" };

function LinkProps({ connId, el, onEdit }: Props) {
  const a = (n: string) => el.getAttribute(n) ?? "";
  const parent = el.parentElement ? ownerTable(el.parentElement) : null;
  const parentTable = parent?.getAttribute("name") ?? null;
  const rels = useTableRelationships(connId, parentTable);
  const { tables, loading: tablesLoading } = useTables(connId);
  const tableOptions = useMemo(() => tables?.map((t) => ({ value: t.logicalName, label: t.displayName || undefined })), [tables]);
  const fromCols = columnOptions(useColumns(connId, a("name") || null));
  const toCols = columnOptions(useColumns(connId, parentTable));
  const [q, setQ] = useState("");
  const [showRels, setShowRels] = useState(!a("name"));
  const changeTable = useChangeTable(el, onEdit);
  const pushToast = useStore((s) => s.pushToast);

  const needle = q.trim().toLowerCase();
  const relList = Array.isArray(rels)
    ? rels.filter((r) => !needle || `${r.table} ${r.from} ${r.to} ${r.schemaName}`.toLowerCase().includes(needle))
    : [];

  const pickRel = (r: Relationship) => {
    const old = a("name");
    const report = { removed: 0 };
    onEdit((e) => applyRelationship(e, r, report));
    if (report.removed > 0) {
      pushToast({
        tone: "info",
        title: `Removed ${report.removed} element${report.removed === 1 ? "" : "s"} of ${old}`,
        body: "They belonged to the table joined before. Ctrl+Z in the XML brings them back.",
      });
    }
  };

  return (
    <>
      <div>
        <button className="mb-1 flex w-full items-center gap-2 text-left" onClick={() => setShowRels((s) => !s)} type="button">
          <span className="text-[11px] font-medium text-muted">Relationship</span>
          <span className="text-[11px] text-subtle">{parentTable ? `from ${parentTable}` : ""}</span>
          <span className="ml-auto text-[11px] text-brand">{showRels ? "Hide" : "Pick…"}</span>
        </button>
        {showRels && (
          <>
            <div className="relative mb-1">
              <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
              <input className="input h-7 !pl-7 text-[12px]" placeholder="Find a relationship…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {rels === "loading" || (!rels && parentTable) ? (
              <div className="flex items-center gap-1.5 py-2 text-xs text-subtle">
                <Loader size={12} /> Loading relationships…
              </div>
            ) : rels === "error" ? (
              <p className="text-xs text-warning">Couldn't read the relationships of {parentTable}. Fill in the fields below.</p>
            ) : (
              <ul className="max-h-56 overflow-auto rounded-md border border-line bg-s1 py-0.5">
                {relList.slice(0, 400).map((r) => (
                  <li key={`${r.schemaName}|${r.kind}|${r.from}|${r.to}`}>
                    <button
                      type="button"
                      onClick={() => pickRel(r)}
                      className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-s3"
                      title={`${r.schemaName}\n${r.table}: ${r.kind === "manyToMany" ? `via ${r.intersect}` : `${r.from} = ${r.to}`}`}
                    >
                      <span className="mt-px w-7 shrink-0 font-mono text-[10.5px] text-subtle">{REL_KIND[r.kind]}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[12.5px] text-fg">{r.table}</span>
                        <span className="block truncate font-mono text-[11px] text-subtle">
                          {r.kind === "manyToMany" ? `via ${r.intersect}` : `${r.from} = ${r.to}`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {relList.length === 0 && <li className="px-2 py-2 text-xs text-subtle">No relationships match.</li>}
              </ul>
            )}
          </>
        )}
      </div>
      <Field label="Table (name)">
        <Combo value={a("name")} options={tableOptions} loading={tablesLoading} onCommit={(v) => changeTable(v)} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`From (${a("name") || "joined"})`}>
          <Combo value={a("from")} options={fromCols} onCommit={(v) => onEdit((e) => setAttr(e, "from", v))} />
        </Field>
        <Field label={`To (${parentTable ?? "parent"})`}>
          <Combo value={a("to")} options={toCols} onCommit={(v) => onEdit((e) => setAttr(e, "to", v))} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Alias">
          <TextField value={a("alias")} placeholder="none" onCommit={(v) => onEdit((e) => setAttr(e, "alias", v))} />
        </Field>
        <Field label="Join type">
          <Select
            value={a("link-type") || "inner"}
            onChange={(v) => onEdit((e) => setAttr(e, "link-type", v === "inner" ? null : v))}
            options={["inner", "outer", "any", "not any", "all", "not all", "exists", "in", "matchfirstrowusingcrossapply"].map((v) => ({ value: v }))}
          />
        </Field>
      </div>
      <Check
        label="Intersect (join only, no columns)"
        checked={a("intersect") === "true"}
        onChange={(v) => onEdit((e) => setAttr(e, "intersect", v ? "true" : null))}
      />
      {a("name") && <ColumnChecklist connId={connId} el={el} onEdit={onEdit} />}
    </>
  );
}

const AGGREGATES = ["", "count", "countcolumn", "sum", "avg", "min", "max"];
const DATE_GROUPING = ["", "day", "week", "month", "quarter", "year", "fiscal-period", "fiscal-year"];

function AttributeProps({ connId, el, onEdit }: Props) {
  const a = (n: string) => el.getAttribute(n) ?? "";
  const cols = useColumns(connId, tableOf(el));
  const aggregate = isAggregate(el.ownerDocument);
  const type = cols?.find((c) => c.logicalName === a("name"))?.attributeType;
  return (
    <>
      <Field label={`Column${tableOf(el) ? ` of ${tableOf(el)}` : ""}`}>
        <Combo value={a("name")} options={columnOptions(cols)} loading={!cols && !!tableOf(el)} onCommit={(v) => onEdit((e) => setAttr(e, "name", v))} />
      </Field>
      <Field label="Alias" hint={aggregate ? "Aggregate columns need an alias." : undefined}>
        <TextField value={a("alias")} placeholder="none" onCommit={(v) => onEdit((e) => setAttr(e, "alias", v))} />
      </Field>
      {aggregate && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Aggregate">
              <Select
                value={a("aggregate")}
                onChange={(v) => onEdit((e) => setAttr(e, "aggregate", v))}
                options={AGGREGATES.map((v) => ({ value: v, label: v || "(none)" }))}
              />
            </Field>
            {(a("groupby") === "true" || type === "DateTime") && (
              <Field label="Date grouping">
                <Select
                  value={a("dategrouping")}
                  onChange={(v) => onEdit((e) => setAttr(e, "dategrouping", v))}
                  options={DATE_GROUPING.map((v) => ({ value: v, label: v || "(none)" }))}
                />
              </Field>
            )}
          </div>
          <Check label="Group by" checked={a("groupby") === "true"} onChange={(v) => onEdit((e) => setAttr(e, "groupby", v ? "true" : null))} />
          {a("aggregate") === "countcolumn" && (
            <Check label="Count distinct values" checked={a("distinct") === "true"} onChange={(v) => onEdit((e) => setAttr(e, "distinct", v ? "true" : null))} />
          )}
        </>
      )}
    </>
  );
}

function OrderProps({ connId, el, onEdit }: Props) {
  const a = (n: string) => el.getAttribute(n) ?? "";
  const cols = useColumns(connId, tableOf(el));
  const aggregate = isAggregate(el.ownerDocument);
  const aliases = aggregate
    ? Array.from(el.ownerDocument.getElementsByTagName("attribute"))
        .map((x) => x.getAttribute("alias"))
        .filter((x): x is string => !!x)
    : [];
  return (
    <>
      {aggregate ? (
        <Field label="Alias to sort by" hint="Aggregate queries sort by an attribute's alias.">
          <Combo value={a("alias")} options={aliases.map((v) => ({ value: v }))} onCommit={(v) => onEdit((e) => setAttr(e, "alias", v))} />
        </Field>
      ) : (
        <Field label={`Column${tableOf(el) ? ` of ${tableOf(el)}` : ""}`}>
          <Combo value={a("attribute")} options={columnOptions(cols)} loading={!cols && !!tableOf(el)} onCommit={(v) => onEdit((e) => setAttr(e, "attribute", v))} />
        </Field>
      )}
      <Check label="Descending" checked={a("descending") === "true"} onChange={(v) => onEdit((e) => setAttr(e, "descending", v ? "true" : null))} />
    </>
  );
}

function FilterProps({ el, onEdit }: Omit<Props, "connId">) {
  const type = el.getAttribute("type") === "or" ? "or" : "and";
  return (
    <>
      <Field label="Match">
        <div className="seg" role="group" aria-label="Filter type">
          <button type="button" aria-pressed={type === "and"} onClick={() => onEdit((e) => setAttr(e, "type", "and"))}>
            All (AND)
          </button>
          <button type="button" aria-pressed={type === "or"} onClick={() => onEdit((e) => setAttr(e, "type", "or"))}>
            Any (OR)
          </button>
        </div>
      </Field>
      <div className="flex gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit((e) => addChild(e, "condition", { operator: "eq" }))}>
          <Plus size={12} /> Condition
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit((e) => addChild(e, "filter", { type: type === "and" ? "or" : "and" }))}>
          <Plus size={12} /> Nested filter
        </button>
      </div>
    </>
  );
}

const CHOICE_TYPES = new Set(["Picklist", "State", "Status", "Virtual"]);

function ConditionProps({ connId, el, onEdit }: Props) {
  const a = (n: string) => el.getAttribute(n) ?? "";
  const table = tableOf(el);
  const cols = useColumns(connId, table);
  const choices = useTableChoices(connId, table);
  const column = cols?.find((c) => c.logicalName === a("attribute"));
  const op = a("operator") || "eq";
  const ops = operatorsFor(column?.attributeType);
  const opList = ops.includes(op) ? ops : [op, ...ops];
  const arity = arityOf(op);
  const values = conditionValues(el);
  const options = CHOICE_TYPES.has(column?.attributeType ?? "") ? choices?.columns[a("attribute").toLowerCase()] : undefined;
  const isBool = column?.attributeType === "Boolean";
  const aliases = linkAliases(el.ownerDocument);
  // Only conditions directly under the root table's filters can point at a join.
  const onRoot = ownerTable(el)?.tagName === "entity";

  const writeValues = (next: string[]) => onEdit((e) => setConditionValues(e, next));

  /** Another column: values of another type (or another choice's options) don't carry over, nor an operator it can't take. */
  const changeColumn = (v: string) => {
    const before = column?.attributeType;
    const after = cols?.find((c) => c.logicalName === v)?.attributeType;
    onEdit((e) => {
      setAttr(e, "attribute", v);
      if (before && after && (before !== after || CHOICE_TYPES.has(after) || after === "Boolean")) setConditionValues(e, []);
      if (after && !operatorsFor(after).includes(e.getAttribute("operator") || "eq")) setOperator(e, "eq");
    });
  };

  const single = (v: string, onChange: (v: string) => void, placeholder?: string) =>
    options ? (
      <Select value={v} onChange={onChange} options={[{ value: "", label: "(pick a value)" }, ...options.map((o) => ({ value: String(o.value), label: `${o.value} · ${o.label}` }))]} />
    ) : isBool ? (
      <Select value={v} onChange={onChange} options={[{ value: "", label: "(pick)" }, { value: "1", label: "1 · Yes" }, { value: "0", label: "0 · No" }]} />
    ) : (
      <TextField value={v} onCommit={onChange} placeholder={placeholder ?? (column?.attributeType === "DateTime" ? "2026-09-24" : "value")} />
    );

  return (
    <>
      {onRoot && aliases.length > 0 && (
        <Field label="Table" hint="A condition can test a joined table's column (entityname).">
          <Select
            value={a("entityname")}
            onChange={(v) =>
              onEdit((e) => {
                if ((e.getAttribute("entityname") ?? "") === v) return;
                // Another table: the column and values were the old one's.
                setAttr(e, "entityname", v);
                e.removeAttribute("attribute");
                setConditionValues(e, []);
              })
            }
            options={[{ value: "", label: `(this table)` }, ...aliases.map((l) => ({ value: l.alias, label: `${l.alias} · ${l.table}` }))]}
          />
        </Field>
      )}
      <Field label={`Column${table ? ` of ${table}` : ""}`}>
        <Combo value={a("attribute")} options={columnOptions(cols)} loading={!cols && !!table} onCommit={changeColumn} />
      </Field>
      <Field label="Operator">
        <Select value={op} onChange={(v) => onEdit((e) => setOperator(e, v))} options={opList.map((o) => ({ value: o, label: `${o} — ${OPERATORS[o]?.label ?? o}` }))} />
      </Field>
      {arity === "one" && <Field label="Value">{single(values[0] ?? "", (v) => writeValues([v]))}</Field>}
      {arity === "number" && (
        <Field label="X">
          <TextField type="number" value={values[0] ?? ""} placeholder="7" onCommit={(v) => writeValues([v])} />
        </Field>
      )}
      {arity === "two" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">{single(values[0] ?? "", (v) => writeValues([v, values[1] ?? ""]))}</Field>
          <Field label="To">{single(values[1] ?? "", (v) => writeValues([values[0] ?? "", v]))}</Field>
        </div>
      )}
      {arity === "many" &&
        (options ? (
          <Field label="Values">
            <ul className="max-h-56 overflow-auto rounded-md border border-line bg-s1 py-0.5">
              {options.map((o) => (
                <li key={o.value}>
                  <label className="flex items-center gap-2 px-2 py-1 text-[12px] hover:bg-s3">
                    <input
                      type="checkbox"
                      className="accent-[var(--brand)]"
                      checked={values.includes(String(o.value))}
                      onChange={(ev) =>
                        writeValues(ev.target.checked ? [...values, String(o.value)] : values.filter((v) => v !== String(o.value)))
                      }
                    />
                    <span className="font-mono tabular-nums text-subtle">{o.value}</span>
                    <span className="truncate text-fg">{o.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          </Field>
        ) : (
          <Field label="Values">
            <div className="space-y-1.5">
              {values.map((v, i) => (
                <div key={i} className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <TextField value={v} onCommit={(nv) => writeValues(values.map((x, j) => (j === i ? nv : x)))} />
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-icon"
                    aria-label="Remove value"
                    onClick={() => writeValues(values.filter((_, j) => j !== i))}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => writeValues([...values, ""])}>
                <Plus size={12} /> Value
              </button>
            </div>
          </Field>
        ))}
      {arity === "none" && <p className="text-xs text-subtle">This operator takes no value.</p>}
    </>
  );
}
