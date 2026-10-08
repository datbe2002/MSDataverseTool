// Small form controls shared by the tools' side panels: a labelled field,
// a text input that writes on Enter / blur, a checkbox, a select, and a
// searchable combo box that also takes any typed value.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader } from "./Icon";

export interface Option {
  value: string;
  label?: string;
  hint?: string;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
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
export function TextField({
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

export function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-center gap-2 text-[12.5px] text-fg" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Option[] }) {
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
