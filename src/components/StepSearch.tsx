// Step search UI shared by the Designer (search box with a result list) and
// the JSON tab's outline (filter).
import { forwardRef, useEffect, useRef, useState } from "react";
import { highlightParts, type MatchWhere, type StepMatch } from "../lib/flowSearch";
import { StepIcon } from "./StepIcon";
import { ChevronDown, Search, X } from "./Icon";

const WHERE_LABEL: Record<MatchWhere, string | null> = {
  name: null,
  type: "type",
  content: "in settings",
};

export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-warning/25 text-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

/** One search result: icon, name with the terms marked, where it sits. */
export function StepResultRow({
  match,
  terms,
  active,
  onPick,
  id,
}: {
  match: StepMatch;
  terms: string[];
  active: boolean;
  onPick: () => void;
  id?: string;
}) {
  const { step, where, location } = match;
  const whereLabel = WHERE_LABEL[where];
  return (
    <button
      id={id}
      role="option"
      aria-selected={active}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${active ? "bg-brand/12" : "hover:bg-s3"}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <StepIcon step={step} size={24} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px]">
          <Highlight text={step.name} terms={terms} />
        </span>
        <span className="block truncate text-[11px] text-subtle">
          {step.type}
          {location ? ` · in ${location}` : ""}
        </span>
      </span>
      {whereLabel && <span className="badge badge-neutral shrink-0 !text-[10.5px]">{whereLabel}</span>}
    </button>
  );
}

interface BoxProps {
  query: string;
  onQuery: (q: string) => void;
  matches: StepMatch[];
  terms: string[];
  /** Index of the match currently picked in the flow (-1 = none). */
  current: number;
  onPick: (index: number) => void;
}

/**
 * Designer search: type to list matching steps; ↑/↓ + Enter pick one; once
 * the list is closed, Enter / Shift+Enter (or the arrows) step through them.
 */
export const StepSearchBox = forwardRef<HTMLInputElement, BoxProps>(function StepSearchBox(
  { query, onQuery, matches, terms, current, onPick },
  ref
) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const step = (by: number) => {
    if (!matches.length) return;
    onPick((current + by + matches.length) % matches.length);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (open) setOpen(false);
      else onQuery("");
    } else if (open && e.key === "ArrowDown") setActive((a) => Math.min(matches.length - 1, a + 1));
    else if (open && e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter") {
      if (open && matches[active]) {
        onPick(active);
        setOpen(false);
      } else step(e.shiftKey ? -1 : 1);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="relative w-[320px] max-w-full">
      <div className="flex h-8 items-center gap-1 rounded-[7px] border border-line bg-s2 pr-1 shadow-sm focus-within:border-brand">
        <Search size={14} className="ml-2.5 shrink-0 text-subtle" />
        <input
          ref={ref}
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => query && setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder="Search steps (Ctrl+F)"
          aria-label="Search steps"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls="step-search-results"
          aria-activedescendant={open && matches[active] ? `step-result-${active}` : undefined}
          className="min-w-0 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-subtle"
        />
        {query && (
          <>
            <span className="shrink-0 text-[11px] tabular-nums text-subtle" aria-live="polite">
              {matches.length ? `${current >= 0 ? current + 1 : "–"} / ${matches.length}` : "0"}
            </span>
            <button className="btn btn-ghost btn-icon btn-sm !h-6 !w-6" onClick={() => step(-1)} disabled={!matches.length} title="Previous (Shift+Enter)" aria-label="Previous match">
              <ChevronDown size={13} className="rotate-180" />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm !h-6 !w-6" onClick={() => step(1)} disabled={!matches.length} title="Next (Enter)" aria-label="Next match">
              <ChevronDown size={13} />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm !h-6 !w-6" onClick={() => onQuery("")} title="Clear (Esc)" aria-label="Clear search">
              <X size={12} />
            </button>
          </>
        )}
      </div>
      {open && query && (
        <div ref={listRef} id="step-search-results" role="listbox" className="popover absolute left-0 right-0 top-9 z-10 max-h-[340px] overflow-y-auto p-1">
          {matches.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-subtle">No step matches “{query}”</div>
          ) : (
            matches.map((m, i) => (
              <StepResultRow
                key={m.step.id}
                id={`step-result-${i}`}
                match={m}
                terms={terms}
                active={i === active}
                onPick={() => {
                  onPick(i);
                  setOpen(false);
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
});
