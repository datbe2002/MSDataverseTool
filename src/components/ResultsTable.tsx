import { useLayoutEffect, useRef, useState } from "react";
import { useStore, activeTabOf } from "../store";
import { Table, AlertTriangle, Check, Loader, Copy } from "./Icon";
import type { Cell, QueryResult } from "../types";
import type { StatementOutcome } from "../store";

export function ErrorState({ message, title = "Query failed" }: { message: string | null; title?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-danger/12 text-danger ring-1 ring-inset ring-danger/25">
        <AlertTriangle size={20} />
      </div>
      <div className="max-w-md">
        <div className="text-sm font-medium text-danger">{title}</div>
        {message && (
          <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-s1 px-3 py-2 text-left font-mono text-xs leading-relaxed text-muted">
            {message}
          </div>
        )}
      </div>
      {message && (
        <button
          onClick={() => navigator.clipboard.writeText(message).catch(() => {})}
          className="btn btn-ghost btn-sm"
        >
          <Copy size={12} /> Copy
        </button>
      )}
    </div>
  );
}

const ROW_H = 30;
const COL_W = 200;
const COL_MIN = 60;
const COL_MAX = 2000;
/** Widest a double-click auto-fit makes a column (long text stays truncated). */
const FIT_MAX = 600;
/** Rows sampled when auto-fitting a column. */
const FIT_SAMPLE = 500;

/** Column widths the user set, by column name — kept while the app runs, so
 *  re-running a query (or another one with the same columns) keeps them. */
const savedWidths = new Map<string, number>();

const clampWidth = (w: number) => Math.round(Math.min(COL_MAX, Math.max(COL_MIN, w)));

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 7.5;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Width that shows the header and the sampled cells of column `i` in full. */
function fitWidth(el: HTMLElement | null, name: string, dataType: string, rows: Cell[][], i: number): number {
  const style = el ? getComputedStyle(el) : null;
  const mono = style ? `${style.fontSize} ${style.fontFamily}` : "12.5px monospace";
  const sans = `600 12px ${el ? getComputedStyle(document.body).fontFamily : "sans-serif"}`;
  // header: name + gap + data type label + padding
  let widest = textWidth(name, sans) + 6 + textWidth(dataType, "10.5px monospace");
  for (let r = 0; r < Math.min(rows.length, FIT_SAMPLE); r++) {
    const v = rows[r][i];
    const s = v === null || v === undefined ? "NULL" : String(v);
    widest = Math.max(widest, textWidth(s.length > 300 ? s.slice(0, 300) : s, mono));
  }
  return clampWidth(Math.min(FIT_MAX, widest + 24 + 2));
}

function renderCell(v: Cell) {
  if (v === null || v === undefined) return <span className="italic text-subtle">NULL</span>;
  if (typeof v === "boolean") return <span className="text-bool">{v ? "true" : "false"}</span>;
  if (typeof v === "number") return <span className="text-num">{v}</span>;
  return <span>{String(v)}</span>;
}

/** The backend cuts long text at 1,000 characters (+ "…") for the grid. */
const CLIPPED_AT = 1000;

function cellTitle(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  if (typeof v === "string" && s.length > CLIPPED_AT && s.endsWith("…")) {
    return `${s}\n\n(shortened for the grid — Copy CSV / JSON gives the full text)`;
  }
  return s;
}

export function Skeleton() {
  return (
    <div className="p-4">
      <div className="flex gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="skeleton h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: 8 }, (_, r) => (
        <div key={r} className="mt-3 flex gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Grid({ result }: { result: Pick<QueryResult, "columns" | "rows"> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [result]);

  const { columns, rows } = result;
  // One width per column; the grid is keyed by its column names, so a result
  // with other columns starts from the remembered / default widths again.
  const [widths, setWidths] = useState<number[]>(() => columns.map((c) => savedWidths.get(c.name) ?? COL_W));
  const setWidth = (i: number, w: number) => {
    const next = clampWidth(w);
    savedWidths.set(columns[i].name, next);
    setWidths((ws) => ws.map((old, j) => (j === i ? next : old)));
  };

  const startResize = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[i] ?? COL_W;
    const onMove = (ev: PointerEvent) => setWidth(i, startW + ev.clientX - startX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onResizeKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") setWidth(i, (widths[i] ?? COL_W) - step);
    else if (e.key === "ArrowRight") setWidth(i, (widths[i] ?? COL_W) + step);
    else if (e.key === "Enter") setWidth(i, fitWidth(scrollRef.current, columns[i].name, columns[i].dataType, rows, i));
    else return;
    e.preventDefault();
  };

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        Command completed — no result set returned.
      </div>
    );
  }

  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + 8);
  const visible = rows.slice(start, end);
  const colW = (i: number) => widths[i] ?? COL_W;
  const width = widths.reduce((a, w) => a + w, 0) + 64;

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="fade-in h-full overflow-auto font-mono text-[12.5px]"
      style={{ background: "var(--editor-bg)" }}
    >
      <div style={{ width, position: "relative" }}>
        <div className="sticky top-0 z-10 flex border-b border-line-strong bg-s1 font-sans" style={{ height: ROW_H }}>
          <div className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-line bg-s1 px-2 font-mono text-subtle" style={{ width: 64 }}>
            #
          </div>
          {columns.map((c, i) => (
            <div
              key={i}
              className="relative flex shrink-0 items-center gap-1.5 truncate border-r border-line px-3 text-xs font-semibold text-fg"
              style={{ width: colW(i) }}
              title={`${c.name} · ${c.dataType}`}
            >
              <span className="truncate">{c.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[10.5px] font-normal text-subtle">{c.dataType}</span>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize column ${c.name}`}
                aria-valuenow={colW(i)}
                aria-valuemin={COL_MIN}
                aria-valuemax={COL_MAX}
                tabIndex={0}
                title="Drag to resize · double-click to fit"
                onPointerDown={(e) => startResize(e, i)}
                onDoubleClick={() => setWidth(i, fitWidth(scrollRef.current, c.name, c.dataType, rows, i))}
                onKeyDown={(e) => onResizeKey(e, i)}
                className="col-resizer"
              />
            </div>
          ))}
        </div>

        <div style={{ height: total * ROW_H, position: "relative" }}>
          <div style={{ transform: `translateY(${start * ROW_H}px)` }}>
            {visible.map((row, ri) => {
              const absolute = start + ri;
              return (
                <div
                  key={absolute}
                  className={`row flex border-b border-line/50 ${absolute % 2 ? "row-alt" : ""}`}
                  style={{ height: ROW_H }}
                >
                  <div className="sticky left-0 flex shrink-0 items-center justify-end border-r border-line bg-s1 px-2 text-[11.5px] text-subtle" style={{ width: 64 }}>
                    {absolute + 1}
                  </div>
                  {row.map((cell, ci) => (
                    <div
                      key={ci}
                      className="flex shrink-0 items-center truncate border-r border-line/50 px-3"
                      style={{ width: colW(ci) }}
                      title={cellTitle(cell)}
                    >
                      <span className="truncate">{renderCell(cell)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ResultsTable() {
  const outcomes = useStore((s) => activeTabOf(s).outcomes);
  const viewIndex = useStore((s) => activeTabOf(s).viewIndex);
  const outcome = outcomes[viewIndex] ?? null;

  if (!outcome) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="empty-icon">
          <Table size={20} />
        </div>
        <div>
          <div className="text-sm font-medium">No results yet</div>
          <div className="mt-0.5 text-xs text-subtle">Run a query to see its rows here.</div>
        </div>
      </div>
    );
  }

  // While running, show whatever pages have streamed in so far.
  if (outcome.status === "pending" || (outcome.status === "running" && !outcome.result)) return <Skeleton />;

  if (outcome.status === "cancelled") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-subtle">
        Statement not run.
      </div>
    );
  }

  if (outcome.status === "error") return <ErrorState message={outcome.error} />;

  if (outcome.status === "write" && outcome.dmlResult) {
    const d = outcome.dmlResult;
    const past = { update: "Updated", delete: "Deleted", insert: "Inserted" }[d.kind];
    const allOk = d.failed === 0;
    return (
      <div className="flex h-full items-start justify-center overflow-auto p-6">
        <div
          className={`fade-in w-full max-w-2xl rounded-xl border p-4 ${
            allOk ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10"
          }`}
        >
          <div className={`flex items-center gap-2 font-medium ${allOk ? "text-success" : "text-warning"}`}>
            {allOk ? <Check size={16} /> : <AlertTriangle size={16} />}
            {past} {d.succeeded.toLocaleString()} of {d.total.toLocaleString()} record
            {d.total === 1 ? "" : "s"} in {d.table}
          </div>
          <div className="mt-1 text-xs text-muted">
            {(d.elapsedMs / 1000).toFixed(1)} s
            {d.maxThreads > 1 && ` · up to ${d.maxThreads} threads`}
            {d.throttled > 0 && ` · throttled ${d.throttled}×`}
            {d.failed > 0 && ` · ${d.failed.toLocaleString()} failed`}
          </div>
          {d.errors.length > 0 && (
            <ul className="mt-3 max-h-64 space-y-1 overflow-auto font-mono text-xs text-warning">
              {d.errors.map((e, i) => (
                <li key={i} className="break-words">{e}</li>
              ))}
            </ul>
          )}
          {d.failed > d.errors.length && (
            <div className="mt-2 text-xs text-subtle">Showing the first {d.errors.length} errors.</div>
          )}
        </div>
      </div>
    );
  }

  if (outcome.result) {
    // New set of columns → fresh column widths (streamed pages keep the same key).
    const key = outcome.result.columns.map((c) => c.name).join("\u0001");
    return <Grid key={key} result={outcome.result} />;
  }

  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-subtle">
      <Loader size={14} /> …
    </div>
  );
}
