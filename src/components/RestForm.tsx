// The REST builder's form: one section per part of the request (table,
// record, columns, filter, order, expand, values, parameters…), shown by the
// request kind. Every change goes straight into the tab's request.
import { useMemo, useState } from "react";
import { Check, Combo, Field, Select, TextField, type Option } from "./FormParts";
import { Plus, Search, X } from "./Icon";
import { useTableChoices, useTables } from "../lib/meta";
import { restTables } from "../lib/restStore";
import {
  OPERATIONS,
  OPERATORS,
  cleanId,
  isChoice,
  isLookup,
  isMultiChoice,
  newId,
  operatorsFor,
  recordIdFrom,
  selectable,
  typeLabel,
  type Condition,
  type Expand,
  type FieldValue,
  type Param,
  type ParamType,
  type RestRequest,
} from "../lib/restModel";
import type { RestColumn, RestTable } from "../types";

type Update = (patch: Partial<RestRequest>) => void;

interface FormProps {
  connId: string;
  req: RestRequest;
  update: Update;
  meta: RestTable | undefined;
  metaLoading: boolean;
  metaError: string | undefined;
}

/** A section of the form: a heading with an optional action, then its fields. */
function Section({ title, action, children, hint }: { title: string; action?: React.ReactNode; children: React.ReactNode; hint?: string }) {
  return (
    <section className="border-b border-line px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[12px] font-semibold text-fg">{title}</h3>
        {hint && <span className="truncate text-[11px] text-subtle">{hint}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

const RemoveButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" className="btn btn-ghost btn-sm btn-icon shrink-0" aria-label={label} title={label} onClick={onClick}>
    <X size={12} />
  </button>
);

const AddButton = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
  <button type="button" className="btn btn-ghost btn-sm" onClick={onClick}>
    <Plus size={12} /> {children}
  </button>
);

const columnOptions = (cols: RestColumn[] | undefined, keep: (c: RestColumn) => boolean = selectable): Option[] | undefined =>
  cols?.filter(keep).map((c) => ({ value: c.logicalName, label: c.displayName || undefined, hint: typeLabel(c) }));

/** Tables the Web API can read, for the table pickers. */
function useTableOptions(connId: string): { options: Option[] | undefined; loading: boolean } {
  const { tables, loading } = useTables(connId);
  const options = useMemo(
    () => tables?.filter((t) => t.entitySetName).map((t) => ({ value: t.logicalName, label: t.displayName || undefined, hint: t.entitySetName })),
    [tables]
  );
  return { options, loading };
}

export function TableField({ connId, value, onChange, label = "Table", hint }: { connId: string; value: string; onChange: (v: string) => void; label?: string; hint?: string }) {
  const { options, loading } = useTableOptions(connId);
  return (
    <Field label={label} hint={hint}>
      <Combo value={value} onCommit={(v) => onChange(v.trim().toLowerCase())} options={options} loading={loading} placeholder="account" />
    </Field>
  );
}

function IdField({ value, onChange, label = "Record id", keys = true }: { value: string; onChange: (v: string) => void; label?: string; keys?: boolean }) {
  return (
    <Field label={label} hint={keys ? "A GUID, a record link, or an alternate key: accountnumber='A1'" : "A GUID or a record link"}>
      <TextField value={value} onCommit={(v) => onChange(keys ? recordIdFrom(v) : cleanId(v))} placeholder="00000000-0000-0000-0000-000000000000" />
    </Field>
  );
}

// ---------- columns ----------

/** Searchable checklist of a table's columns. */
export function ColumnPicker({
  columns,
  selected,
  onChange,
  keep = selectable,
  compact,
}: {
  columns: RestColumn[] | undefined;
  selected: string[];
  onChange: (next: string[]) => void;
  keep?: (c: RestColumn) => boolean;
  compact?: boolean;
}) {
  const [q, setQ] = useState("");
  const [pickedOnly, setPickedOnly] = useState(false);
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (c: RestColumn) => words.every((w) => c.logicalName.includes(w) || c.displayName.toLowerCase().includes(w));
    // A stable order: ticking a column doesn't move the list under the pointer.
    return (columns ?? []).filter((c) => keep(c) && hit(c) && (!pickedOnly || selected.includes(c.logicalName)));
  }, [columns, keep, q, pickedOnly, selected]);
  const toggle = (name: string, on: boolean) => onChange(on ? [...selected, name] : selected.filter((s) => s !== name));
  if (!columns) return <p className="text-xs text-subtle">Loading columns…</p>;
  return (
    <div className="rounded-md border border-line bg-s1">
      <div className="flex items-center gap-1.5 border-b border-line px-2">
        <Search size={12} className="shrink-0 text-subtle" />
        <input
          className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-subtle"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${columns.filter(keep).length} columns`}
          aria-label="Search columns"
          spellCheck={false}
        />
        {selected.length > 0 && (
          <>
            <button
              type="button"
              aria-pressed={pickedOnly}
              className={`shrink-0 text-[11px] hover:text-fg ${pickedOnly ? "text-brand" : "text-subtle"}`}
              onClick={() => setPickedOnly((v) => !v)}
              title="Show only the picked columns"
            >
              {selected.length} picked
            </button>
            <button
              type="button"
              className="shrink-0 text-[11px] text-subtle hover:text-fg"
              onClick={() => {
                onChange([]);
                setPickedOnly(false);
              }}
            >
              Clear
            </button>
          </>
        )}
      </div>
      <ul className={`${compact ? "max-h-40" : "max-h-64"} overflow-auto py-0.5`}>
        {list.map((c) => (
          <li key={c.logicalName}>
            <label className="flex items-center gap-2 px-2 py-[3px] text-[12px] hover:bg-s3" title={c.displayName ? `${c.logicalName} · ${c.displayName}` : c.logicalName}>
              <input type="checkbox" checked={selected.includes(c.logicalName)} onChange={(e) => toggle(c.logicalName, e.target.checked)} />
              <span className="truncate font-mono text-fg">{c.logicalName}</span>
              <span className="min-w-0 flex-1 truncate text-subtle">{c.displayName}</span>
              <span className="shrink-0 text-[10.5px] text-subtle">{typeLabel(c)}</span>
            </label>
          </li>
        ))}
        {list.length === 0 && <li className="px-2 py-1.5 text-[12px] text-subtle">{pickedOnly ? "No picked column matches." : "No column matches."}</li>}
      </ul>
    </div>
  );
}

// ---------- values ----------

/** An input for one value of a column: Yes/No and choices as lists, the rest typed. */
function ValueInput({
  column,
  choices,
  value,
  onChange,
  placeholder,
}: {
  column: RestColumn | undefined;
  choices: { value: number; label: string }[] | undefined;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  if (column?.attributeType === "Boolean") {
    return <Select value={value} onChange={onChange} options={[{ value: "", label: "(pick)" }, { value: "true", label: "Yes · true" }, { value: "false", label: "No · false" }]} />;
  }
  if (choices && !isMultiChoice(column)) {
    const opts = choices.map((o) => ({ value: String(o.value), label: `${o.value} · ${o.label}` }));
    if (value && !opts.some((o) => o.value === value)) opts.unshift({ value, label: value });
    return <Select value={value} onChange={onChange} options={[{ value: "", label: "(pick a value)" }, ...opts]} />;
  }
  const hint =
    placeholder ??
    (isMultiChoice(column)
      ? "100000000,100000001"
      : isLookup(column) || column?.attributeType === "Uniqueidentifier"
      ? "GUID"
      : column?.attributeType === "DateTime"
      ? "2026-10-05"
      : "value");
  return <TextField value={value} onCommit={onChange} placeholder={hint} />;
}

// ---------- filter / order / expand ----------

function FilterSection({ connId, req, update, meta }: FormProps) {
  const choices = useTableChoices(connId, req.table || null);
  const set = (id: string, patch: Partial<Condition>) => update({ conditions: req.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  return (
    <Section
      title="Filter"
      hint="$filter"
      action={
        <>
          {req.conditions.length > 1 && (
            <div className="seg" role="group" aria-label="Match">
              <button aria-pressed={req.filterType === "and"} onClick={() => update({ filterType: "and" })} title="Every condition">
                And
              </button>
              <button aria-pressed={req.filterType === "or"} onClick={() => update({ filterType: "or" })} title="Any condition">
                Or
              </button>
            </div>
          )}
          <AddButton onClick={() => update({ conditions: [...req.conditions, { id: newId(), column: "", operator: "eq", value: "" }] })}>Condition</AddButton>
        </>
      }
    >
      {req.conditions.length === 0 && <p className="text-xs text-subtle">Every row. Add a condition to narrow it down.</p>}
      {req.conditions.map((cond) => {
        const col = meta?.columns.find((c) => c.logicalName === cond.column);
        const ops = operatorsFor(col);
        const op = OPERATORS[cond.operator] ?? OPERATORS.eq;
        const opts = col && isChoice(col) ? choices?.columns[cond.column] : undefined;
        return (
          <div key={cond.id} className="space-y-1.5 rounded-md border border-line p-2">
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <Combo
                  value={cond.column}
                  options={columnOptions(meta?.columns, (c) => selectable(c) && c.typeName !== "ImageType" && c.typeName !== "FileType")}
                  onCommit={(v) => {
                    const next = meta?.columns.find((c) => c.logicalName === v);
                    set(cond.id, { column: v, operator: operatorsFor(next).includes(cond.operator) ? cond.operator : "eq", value: next?.attributeType === col?.attributeType ? cond.value : "" });
                  }}
                  placeholder="column"
                />
              </div>
              <RemoveButton label="Remove condition" onClick={() => update({ conditions: req.conditions.filter((c) => c.id !== cond.id) })} />
            </div>
            <Select
              value={cond.operator}
              onChange={(v) => set(cond.id, { operator: v })}
              options={(ops.includes(cond.operator) ? ops : [cond.operator, ...ops]).map((o) => ({ value: o, label: OPERATORS[o]?.label ?? o }))}
            />
            {op.arity === "one" && <ValueInput column={col} choices={opts} value={cond.value} onChange={(v) => set(cond.id, { value: v })} />}
            {op.arity === "number" && <TextField type="number" value={cond.value} onCommit={(v) => set(cond.id, { value: v })} placeholder="7" />}
            {op.arity === "list" &&
              (opts ? (
                <ul className="max-h-40 overflow-auto rounded-md border border-line bg-s1 py-0.5">
                  {opts.map((o) => {
                    const values = cond.value.split(",").map((x) => x.trim()).filter(Boolean);
                    const on = values.includes(String(o.value));
                    return (
                      <li key={o.value}>
                        <label className="flex items-center gap-2 px-2 py-[3px] text-[12px] hover:bg-s3">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => set(cond.id, { value: (e.target.checked ? [...values, String(o.value)] : values.filter((x) => x !== String(o.value))).join(",") })}
                          />
                          <span className="font-mono tabular-nums text-subtle">{o.value}</span>
                          <span className="truncate text-fg">{o.label}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <TextField value={cond.value} onCommit={(v) => set(cond.id, { value: v })} placeholder="value1, value2" />
              ))}
          </div>
        );
      })}
    </Section>
  );
}

function OrderSection({ req, update, meta }: FormProps) {
  return (
    <Section title="Order" hint="$orderby" action={<AddButton onClick={() => update({ orderBy: [...req.orderBy, { id: newId(), column: "", desc: false }] })}>Sort</AddButton>}>
      {req.orderBy.length === 0 && <p className="text-xs text-subtle">The server's order.</p>}
      {req.orderBy.map((o) => (
        <div key={o.id} className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <Combo
              value={o.column}
              options={columnOptions(meta?.columns, (c) => selectable(c) && !isMultiChoice(c) && c.attributeType !== "Virtual" && c.attributeType !== "Memo")}
              onCommit={(v) => update({ orderBy: req.orderBy.map((x) => (x.id === o.id ? { ...x, column: v } : x)) })}
              placeholder="column"
            />
          </div>
          <div className="seg shrink-0" role="group" aria-label="Direction">
            <button aria-pressed={!o.desc} onClick={() => update({ orderBy: req.orderBy.map((x) => (x.id === o.id ? { ...x, desc: false } : x)) })}>
              Asc
            </button>
            <button aria-pressed={o.desc} onClick={() => update({ orderBy: req.orderBy.map((x) => (x.id === o.id ? { ...x, desc: true } : x)) })}>
              Desc
            </button>
          </div>
          <RemoveButton label="Remove sort" onClick={() => update({ orderBy: req.orderBy.filter((x) => x.id !== o.id) })} />
        </div>
      ))}
    </Section>
  );
}

const REL: Record<string, string> = { manyToOne: "N:1", oneToMany: "1:N", manyToMany: "N:N" };

function ExpandRow({ connId, exp, meta, onChange, onRemove }: { connId: string; exp: Expand; meta: RestTable | undefined; onChange: (e: Expand) => void; onRemove: () => void }) {
  const nav = meta?.navigation.find((n) => n.name === exp.nav);
  const target = restTables.useEntry(nav ? connId : null, nav?.table.toLowerCase() ?? "");
  const options = meta?.navigation.map((n) => ({ value: n.name, label: `${REL[n.relationship]} → ${n.table}`, hint: n.kind === "single" ? "lookup" : "list" }));
  return (
    <div className="space-y-1.5 rounded-md border border-line p-2">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <Combo value={exp.nav} options={options} onCommit={(v) => onChange({ ...exp, nav: v, columns: v === exp.nav ? exp.columns : [] })} placeholder="navigation property" />
        </div>
        <RemoveButton label="Remove expand" onClick={onRemove} />
      </div>
      {nav && (target.error ? <p className="text-xs text-danger">{target.error}</p> : <ColumnPicker compact columns={target.data?.columns} selected={exp.columns} onChange={(columns) => onChange({ ...exp, columns })} />)}
    </div>
  );
}

function ExpandSection({ connId, req, update, meta }: FormProps) {
  return (
    <Section title="Related tables" hint="$expand" action={<AddButton onClick={() => update({ expand: [...req.expand, { id: newId(), nav: "", columns: [] }] })}>Expand</AddButton>}>
      {req.expand.length === 0 && <p className="text-xs text-subtle">Bring columns of a related record (a lookup) or list (1:N, N:N) along.</p>}
      {req.expand.map((e) => (
        <ExpandRow
          key={e.id}
          connId={connId}
          exp={e}
          meta={meta}
          onChange={(next) => update({ expand: req.expand.map((x) => (x.id === e.id ? next : x)) })}
          onRemove={() => update({ expand: req.expand.filter((x) => x.id !== e.id) })}
        />
      ))}
    </Section>
  );
}

// ---------- create / update ----------

function FieldsSection({ connId, req, update, meta }: FormProps) {
  const choices = useTableChoices(connId, req.table || null);
  const writable = (c: RestColumn) => (req.kind === "create" ? c.creatable : c.updatable) && !c.attributeOf;
  const set = (id: string, patch: Partial<FieldValue>) => update({ fields: req.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  return (
    <Section title="Values" hint="request body" action={<AddButton onClick={() => update({ fields: [...req.fields, { id: newId(), column: "", value: "" }] })}>Column</AddButton>}>
      {req.fields.length === 0 && <p className="text-xs text-subtle">Add the columns to {req.kind === "create" ? "set on the new record" : "change"}. Type null to clear a value.</p>}
      {req.fields.map((f) => {
        const col = meta?.columns.find((c) => c.logicalName === f.column);
        const targets = col?.targets ?? [];
        return (
          <div key={f.id} className="space-y-1.5 rounded-md border border-line p-2">
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <Combo value={f.column} options={columnOptions(meta?.columns, writable)} onCommit={(v) => set(f.id, { column: v, table: undefined, value: v === f.column ? f.value : "" })} placeholder="column" />
              </div>
              <RemoveButton label="Remove column" onClick={() => update({ fields: req.fields.filter((x) => x.id !== f.id) })} />
            </div>
            {isLookup(col) && targets.length > 1 && (
              <Select value={f.table ?? targets[0]} onChange={(v) => set(f.id, { table: v })} options={targets.map((t) => ({ value: t, label: `→ ${t}` }))} />
            )}
            <ValueInput column={col} choices={col && isChoice(col) ? choices?.columns[f.column] : undefined} value={f.value} onChange={(v) => set(f.id, { value: v })} />
          </div>
        );
      })}
    </Section>
  );
}

// ---------- functions / actions ----------

const PARAM_TYPES: { value: ParamType; label: string }[] = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes/No" },
  { value: "guid", label: "GUID" },
  { value: "datetime", label: "Date" },
  { value: "enum", label: "Enum" },
  { value: "record", label: "Record" },
  { value: "json", label: "JSON / list" },
];

function OperationSection({ connId, req, update }: FormProps) {
  const templates = OPERATIONS.filter((o) => o.kind === req.kind);
  const pick = (name: string) => {
    const t = templates.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (!t) return update({ operation: name });
    update({
      operation: t.name,
      bound: t.bound?.scope ?? "none",
      table: t.bound?.table ?? req.table,
      params: t.params.map((p) => ({ ...p, id: newId() })),
    });
  };
  const set = (id: string, patch: Partial<Param>) => update({ params: req.params.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  return (
    <>
      <Section title={req.kind === "function" ? "Function" : "Action"}>
        <Field label="Name" hint="Pick a common one or type any name (custom APIs too).">
          <Combo value={req.operation} options={templates.map((t) => ({ value: t.name, label: t.description, hint: t.bound ? `bound · ${t.bound.table}` : undefined }))} onCommit={pick} placeholder={req.kind === "function" ? "WhoAmI" : "PublishAllXml"} />
        </Field>
        <Field label="Bound to">
          <div className="seg" role="group" aria-label="Bound to">
            {(["none", "collection", "record"] as const).map((b) => (
              <button key={b} aria-pressed={req.bound === b} onClick={() => update({ bound: b })}>
                {b === "none" ? "Nothing" : b === "collection" ? "A table" : "A record"}
              </button>
            ))}
          </div>
        </Field>
        {req.bound !== "none" && <TableField connId={connId} value={req.table} onChange={(table) => update({ table })} />}
        {req.bound === "record" && <IdField value={req.id} onChange={(id) => update({ id })} />}
      </Section>
      <Section title="Parameters" action={<AddButton onClick={() => update({ params: [...req.params, { id: newId(), name: "", type: "string", value: "" }] })}>Parameter</AddButton>}>
        {req.params.length === 0 && <p className="text-xs text-subtle">No parameters.</p>}
        {req.params.map((p) => (
          <div key={p.id} className="space-y-1.5 rounded-md border border-line p-2">
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <TextField value={p.name} onCommit={(v) => set(p.id, { name: v })} placeholder="Name" />
              </div>
              <div className="w-28 shrink-0">
                <Select value={p.type} onChange={(v) => set(p.id, { type: v as ParamType })} options={PARAM_TYPES} />
              </div>
              <RemoveButton label="Remove parameter" onClick={() => update({ params: req.params.filter((x) => x.id !== p.id) })} />
            </div>
            {p.type === "record" && <TableField connId={connId} label="Its table" value={p.table ?? ""} onChange={(table) => set(p.id, { table })} />}
            {p.type === "enum" && (
              <Field label="Enum type">
                <TextField value={p.table ?? ""} onCommit={(v) => set(p.id, { table: v })} placeholder="EndpointAccessType" />
              </Field>
            )}
            {p.type === "boolean" ? (
              <Select value={p.value} onChange={(v) => set(p.id, { value: v })} options={[{ value: "true", label: "true" }, { value: "false", label: "false" }]} />
            ) : (
              <TextField
                value={p.value}
                onCommit={(v) => set(p.id, { value: p.type === "record" || p.type === "guid" ? cleanId(v) : v })}
                placeholder={p.type === "record" || p.type === "guid" ? "GUID" : p.type === "json" ? "['a','b'] or {…}" : p.type === "enum" ? "Default" : "value"}
              />
            )}
          </div>
        ))}
      </Section>
    </>
  );
}

// ---------- associate / disassociate ----------

function RelationSection({ req, update, meta }: FormProps) {
  const nav = meta?.navigation.find((n) => n.name === req.nav);
  const options = meta?.navigation.map((n) => ({ value: n.name, label: `${REL[n.relationship]} → ${n.table} · ${n.schemaName}`, hint: n.kind === "single" ? "lookup" : "list" }));
  return (
    <Section title="Relationship">
      <Field label="Navigation property" hint={nav ? `Links ${req.table || "the record"} to ${nav.table} (${REL[nav.relationship]}).` : undefined}>
        <Combo value={req.nav} options={options} onCommit={(v) => update({ nav: v })} placeholder="contact_customer_accounts" />
      </Field>
      {!(req.kind === "disassociate" && nav?.kind === "single") && (
        <IdField label={`Related record id${nav ? ` (${nav.table})` : ""}`} value={req.relatedId} onChange={(relatedId) => update({ relatedId })} keys={false} />
      )}
      {nav?.kind === "single" && <p className="text-xs text-subtle">A lookup: {req.kind === "associate" ? "sets it (PUT $ref)" : "clears it (DELETE $ref)"}.</p>}
    </Section>
  );
}

// ---------- the form ----------

function OptionsSection({ req, update }: FormProps) {
  return (
    <Section title="Options">
      {req.kind === "retrieveMultiple" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Top" hint="$top">
            <TextField type="number" value={req.top} onCommit={(top) => update({ top })} placeholder="All" />
          </Field>
          <Field label="Page size" hint="Prefer: odata.maxpagesize">
            <TextField type="number" value={req.pageSize} onCommit={(pageSize) => update({ pageSize })} placeholder="5000" />
          </Field>
        </div>
      )}
      {req.kind === "retrieveMultiple" && <Check label="Count the rows ($count, up to 5,000)" checked={req.count} onChange={(count) => update({ count })} />}
      {(req.kind === "create" || req.kind === "update") && (
        <Check label="Return the record (Prefer: return=representation)" checked={req.returnRecord} onChange={(returnRecord) => update({ returnRecord })} />
      )}
      {req.kind === "update" && <Check label="Don't create it when it's missing (If-Match: *)" checked={req.preventCreate} onChange={(preventCreate) => update({ preventCreate })} />}
      <Check
        label="Formatted values (choice labels, lookup names)"
        hint='Prefer: odata.include-annotations="*"'
        checked={req.formatted}
        onChange={(formatted) => update({ formatted })}
      />
    </Section>
  );
}

export function RestForm(props: FormProps) {
  const { connId, req, update, meta, metaLoading, metaError } = props;
  const k = req.kind;
  const tableNeeded = k !== "function" && k !== "action";
  return (
    <div className="pb-6">
      {tableNeeded && (
        <Section title={k === "retrieveMultiple" ? "Table" : "Record"}>
          <TableField
            connId={connId}
            value={req.table}
            onChange={(table) =>
              table !== req.table &&
              // Another table: its columns, filter and expands don't carry over.
              update({ table, columns: [], conditions: [], orderBy: [], expand: [], fields: [], nav: "", relatedId: "" })
            }
            hint={meta ? `Web API collection: ${meta.entitySet}` : undefined}
          />
          {metaError && <p className="text-xs text-danger">{metaError}</p>}
          {metaLoading && <p className="text-xs text-subtle">Reading the table's columns…</p>}
          {k !== "retrieveMultiple" && k !== "create" && <IdField value={req.id} onChange={(id) => update({ id })} />}
        </Section>
      )}
      {(k === "function" || k === "action") && <OperationSection {...props} />}
      {(k === "retrieve" || k === "retrieveMultiple" || ((k === "create" || k === "update") && req.returnRecord)) && (
        <Section title="Columns" hint="$select" action={req.columns.length ? undefined : <span className="text-[11px] text-subtle">All columns</span>}>
          <ColumnPicker columns={meta?.columns} selected={req.columns} onChange={(columns) => update({ columns })} />
        </Section>
      )}
      {k === "retrieveMultiple" && <FilterSection {...props} />}
      {k === "retrieveMultiple" && <OrderSection {...props} />}
      {(k === "retrieve" || k === "retrieveMultiple") && <ExpandSection {...props} />}
      {(k === "create" || k === "update") && <FieldsSection {...props} />}
      {(k === "associate" || k === "disassociate") && <RelationSection {...props} />}
      {k !== "delete" && k !== "associate" && k !== "disassociate" && k !== "action" && <OptionsSection {...props} />}
    </div>
  );
}
