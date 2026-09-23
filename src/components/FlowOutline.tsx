import { useEffect, useMemo, useRef, useState } from "react";
import { parentIds, type OutlineKind, type OutlineNode } from "../lib/flowOutline";
import { queryTerms, searchSteps } from "../lib/flowSearch";
import { StepResultRow } from "./StepSearch";
import { ArrowUpRight, ChevronDown, Search, X } from "./Icon";

interface Props {
  nodes: OutlineNode[];
  selectedId: string | null;
  onSelect: (node: OutlineNode) => void;
  /** Name of a flow in this environment, null if there is none with that id. */
  flowName: (flowId: string) => string | null;
  /** Opens a child flow (its own page, so Back returns here). */
  onOpenFlow: (flowId: string) => void;
}

/** Colour of the small square in front of each step, by kind of step. */
const KIND: Record<OutlineKind, string> = {
  trigger: "bg-brand",
  control: "bg-info",
  connector: "bg-success",
  variable: "bg-warning",
  data: "bg-num",
  other: "bg-line-strong",
  branch: "",
};

interface Row {
  node: OutlineNode;
  depth: number;
}

/** The rows currently visible: every node whose ancestors are all expanded. */
function visibleRows(nodes: OutlineNode[], collapsed: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children.length && !collapsed.has(node.id)) visibleRows(node.children, collapsed, depth + 1, out);
  }
  return out;
}

/** Trigger + actions of a flow as a tree; picking a step reveals it in the JSON. */
export function FlowOutline({ nodes, selectedId, onSelect, flowName, onOpenFlow }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => visibleRows(nodes, collapsed), [nodes, collapsed]);
  const allParents = useMemo(() => parentIds(nodes), [nodes]);
  const treeRef = useRef<HTMLUListElement>(null);

  // Filter: while there's a query the tree gives way to a flat result list.
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const terms = useMemo(() => queryTerms(query), [query]);
  const matches = useMemo(
    () => searchSteps(nodes, query, (st) => (st.childFlowId ? flowName(st.childFlowId) : null)),
    [nodes, query, flowName]
  );
  useEffect(() => setActive(0), [query]);
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(matches.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter" && matches[active]) onSelect(matches[active].step);
    else if (e.key === "Escape") setQuery("");
    else return;
    e.preventDefault();
  };

  const toggle = (id: string, open?: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const isOpen = !next.has(id);
      if (open ?? !isOpen) next.delete(id);
      else next.add(id);
      return next;
    });

  // Keep the picked step in view (also when it was picked from outside).
  useEffect(() => {
    treeRef.current
      ?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const { node } = rows[index];
    const focusRow = (i: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!target) return;
      onSelect(target.node);
      treeRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(target.node.id)}"]`)?.focus();
    };
    if (e.key === "ArrowDown") focusRow(index + 1);
    else if (e.key === "ArrowUp") focusRow(index - 1);
    else if (e.key === "Home") focusRow(0);
    else if (e.key === "End") focusRow(rows.length - 1);
    else if (e.key === "Enter" && node.childFlowId && flowName(node.childFlowId)) onOpenFlow(node.childFlowId);
    else if (e.key === "ArrowRight" && node.children.length) {
      if (collapsed.has(node.id)) toggle(node.id, true);
      else focusRow(index + 1);
    } else if (e.key === "ArrowLeft") {
      if (node.children.length && !collapsed.has(node.id)) toggle(node.id, false);
      else {
        // Up to the parent row: the nearest row above with a smaller depth.
        const depth = rows[index].depth;
        for (let i = index - 1; i >= 0; i--) if (rows[i].depth < depth) return focusRow(i);
      }
    } else return;
    e.preventDefault();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line pl-3 pr-1.5">
        <span className="eyebrow flex-1">Outline</span>
        <button className="btn btn-ghost btn-sm" onClick={() => setCollapsed(new Set())} title="Expand every step">
          Expand
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setCollapsed(new Set(allParents))} title="Collapse every step">
          Collapse
        </button>
      </div>
      <div className="shrink-0 border-b border-line px-2 py-1.5">
        <div className="flex h-7 items-center gap-1 rounded-md border border-line bg-s2 pr-0.5 focus-within:border-brand">
          <Search size={13} className="ml-2 shrink-0 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search steps…"
            aria-label="Search steps"
            className="min-w-0 flex-1 bg-transparent px-1 text-[12.5px] outline-none placeholder:text-subtle"
          />
          {query && (
            <>
              <span className="shrink-0 text-[11px] tabular-nums text-subtle">{matches.length}</span>
              <button className="btn btn-ghost btn-icon btn-sm !h-6 !w-6" onClick={() => setQuery("")} title="Clear (Esc)" aria-label="Clear search">
                <X size={12} />
              </button>
            </>
          )}
        </div>
      </div>
      {query.trim() ? (
        <div role="listbox" aria-label="Matching steps" className="min-h-0 flex-1 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-subtle">No step matches “{query}”</div>
          ) : (
            matches.map((m, i) => (
              <StepResultRow
                key={m.step.id}
                match={m}
                terms={terms}
                active={i === active}
                onPick={() => {
                  setActive(i);
                  onSelect(m.step);
                }}
              />
            ))
          )}
        </div>
      ) : (
        <ul ref={treeRef} role="tree" aria-label="Flow steps" className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {rows.map(({ node, depth }, index) => {
            const hasChildren = node.children.length > 0;
            const open = hasChildren && !collapsed.has(node.id);
            const selected = node.id === selectedId;
            const indent = 8 + depth * 14;
            const child = node.childFlowId;
            const childName = child ? flowName(child) : null;
            // For a child flow the called flow is the detail worth reading.
            const detail = child ? childName ?? "flow not in this environment" : node.detail;
            return (
              <li key={node.id} role="none">
                <div
                  role="treeitem"
                  data-id={node.id}
                  aria-level={depth + 1}
                  aria-selected={selected}
                  aria-expanded={hasChildren ? open : undefined}
                  tabIndex={selected || (!selectedId && index === 0) ? 0 : -1}
                  onClick={() => onSelect(node)}
                  onKeyDown={(e) => onKeyDown(e, index)}
                  title={[node.name, node.type, detail, node.runAfter].filter(Boolean).join("\n")}
                  className={`outline-row ${node.kind === "branch" ? "outline-branch" : ""}`}
                  style={{ paddingLeft: indent }}
                >
                  {hasChildren ? (
                    <button
                      tabIndex={-1}
                      aria-label={open ? "Collapse" : "Expand"}
                      className="grid h-4 w-4 shrink-0 place-items-center rounded text-subtle hover:text-fg"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(node.id);
                      }}
                    >
                      <ChevronDown size={12} className={open ? "" : "-rotate-90"} />
                    </button>
                  ) : (
                    <span className="w-4 shrink-0" />
                  )}
                  {node.kind === "branch" ? (
                    <span className="truncate">{node.name}</span>
                  ) : (
                    <>
                      <span className={`mt-[5px] h-2 w-2 shrink-0 self-start rounded-[2px] ${KIND[node.kind]}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{node.name}</span>
                        <span className="block truncate text-[11.5px] text-subtle">
                          {node.type.toLowerCase() === node.name.toLowerCase() ? "" : node.type}
                          {detail && (node.type.toLowerCase() === node.name.toLowerCase() ? "" : " · ")}
                          {detail && <span className={child && childName ? "text-brand" : ""}>{detail}</span>}
                        </span>
                        {node.runAfter && (
                          <span className="block truncate text-[11.5px] text-warning">{node.runAfter}</span>
                        )}
                      </span>
                      {child && childName && (
                        <button
                          tabIndex={-1}
                          className="btn btn-ghost btn-icon btn-sm -my-1 shrink-0"
                          title={`Open child flow “${childName}” (Enter)`}
                          aria-label={`Open child flow ${childName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenFlow(child);
                          }}
                        >
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
