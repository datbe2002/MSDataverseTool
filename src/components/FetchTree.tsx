import { useEffect, useMemo, useRef, useState } from "react";
import { CHILDREN, canMove, nodeLabel, type NodeKind, type TreeNode } from "../lib/fetchModel";
import { ChevronDown, Plus, Trash } from "./Icon";

export type TreeAction = { type: "add"; tag: NodeKind } | { type: "remove" } | { type: "move"; dir: -1 | 1 };

/** Short tag + colour per element kind (no logos, like StepIcon). */
const KIND: Record<string, { tag: string; className: string; name: string }> = {
  fetch: { tag: "fx", className: "text-brand", name: "Fetch" },
  entity: { tag: "tbl", className: "text-info", name: "Table" },
  "link-entity": { tag: "join", className: "text-info", name: "Join (link-entity)" },
  attribute: { tag: "col", className: "text-success", name: "Column" },
  "all-attributes": { tag: "*", className: "text-success", name: "All columns" },
  order: { tag: "sort", className: "text-warning", name: "Sort" },
  filter: { tag: "flt", className: "text-brand", name: "Filter" },
  condition: { tag: "if", className: "text-brand", name: "Condition" },
  value: { tag: "val", className: "text-muted", name: "Value" },
};

export const kindName = (tag: string) => KIND[tag]?.name ?? tag;

interface Row {
  node: TreeNode;
  parent: TreeNode | null;
}

function visibleRows(root: TreeNode, collapsed: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (node: TreeNode, parent: TreeNode | null) => {
    out.push({ node, parent });
    if (!collapsed.has(node.path)) node.children.forEach((c) => walk(c, node));
  };
  walk(root, null);
  return out;
}

function findRow(root: TreeNode, id: number | null): Row | null {
  if (id === null) return null;
  const walk = (node: TreeNode, parent: TreeNode | null): Row | null => {
    if (node.id === id) return { node, parent };
    for (const c of node.children) {
      const hit = walk(c, node);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, null);
}

/** What can be added under `node` (a `<fetch>` holds one `<entity>` only). */
export function addable(node: TreeNode): NodeKind[] {
  const kinds = CHILDREN[node.tag] ?? [];
  if (node.tag === "fetch" && node.children.some((c) => c.tag === "entity")) return [];
  if (node.tag === "condition") return [];
  return kinds;
}

export function FetchTree({
  root,
  selected,
  onSelect,
  onAction,
  readOnly,
  marks,
}: {
  root: TreeNode;
  selected: number | null;
  onSelect: (id: number) => void;
  onAction: (a: TreeAction) => void;
  readOnly: boolean;
  /** Worst problem per element id (from the checks). */
  marks?: Record<number, "error" | "warning" | "info">;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => visibleRows(root, collapsed), [root, collapsed]);
  const current = useMemo(() => findRow(root, selected), [root, selected]);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Keep the selected row in view (also when it was picked in the XML).
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-id="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  useEffect(() => {
    if (!menu && !addOpen) return;
    const close = () => {
      setMenu(null);
      setAddOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu, addOpen]);

  const toggle = (path: string, open?: boolean) =>
    setCollapsed((s) => {
      const next = new Set(s);
      const isOpen = !next.has(path);
      if (open ?? !isOpen) next.delete(path);
      else next.add(path);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.node.id === selected);
    const row = rows[i];
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (!readOnly && row && canMove(row.node, row.parent, e.key === "ArrowUp" ? -1 : 1)) {
        onAction({ type: "move", dir: e.key === "ArrowUp" ? -1 : 1 });
      }
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        onSelect(rows[Math.min(rows.length - 1, i + 1)]?.node.id ?? rows[0].node.id);
        break;
      case "ArrowUp":
        onSelect(rows[Math.max(0, i - 1)]?.node.id ?? rows[0].node.id);
        break;
      case "Home":
        onSelect(rows[0].node.id);
        break;
      case "End":
        onSelect(rows[rows.length - 1].node.id);
        break;
      case "ArrowRight":
        if (!row) break;
        if (row.node.children.length && collapsed.has(row.node.path)) toggle(row.node.path, true);
        else if (row.node.children.length) onSelect(row.node.children[0].id);
        break;
      case "ArrowLeft":
        if (!row) break;
        if (row.node.children.length && !collapsed.has(row.node.path)) toggle(row.node.path, false);
        else if (row.parent) onSelect(row.parent.id);
        break;
      case "Delete":
        if (!readOnly && row?.parent) onAction({ type: "remove" });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const adds = current && !readOnly ? addable(current.node) : [];

  const menuItems = (close: () => void) => (
    <>
      {adds.map((k) => (
        <button
          key={k}
          className="menu-item"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            close();
            onAction({ type: "add", tag: k });
          }}
        >
          <span className={`w-8 shrink-0 font-mono text-[10.5px] ${KIND[k].className}`}>{KIND[k].tag}</span>
          Add {KIND[k].name.toLowerCase()}
        </button>
      ))}
      {menu && current?.parent && !readOnly && (
        <>
          {adds.length > 0 && <div className="my-1 border-t border-line" />}
          <button
            className="menu-item"
            disabled={!canMove(current.node, current.parent, -1)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              close();
              onAction({ type: "move", dir: -1 });
            }}
          >
            Move up <span className="ml-auto text-subtle">Alt+↑</span>
          </button>
          <button
            className="menu-item"
            disabled={!canMove(current.node, current.parent, 1)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              close();
              onAction({ type: "move", dir: 1 });
            }}
          >
            Move down <span className="ml-auto text-subtle">Alt+↓</span>
          </button>
          <button
            className="menu-item text-danger"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              close();
              onAction({ type: "remove" });
            }}
          >
            Delete <span className="ml-auto text-subtle">Del</span>
          </button>
        </>
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">Query</span>
        <div className="relative ml-auto">
          <button
            className="btn btn-ghost btn-sm"
            disabled={adds.length === 0}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setAddOpen((o) => !o)}
            aria-expanded={addOpen}
            title={adds.length ? "Add inside the selected element" : "Nothing can be added here"}
          >
            <Plus size={13} /> Add <ChevronDown size={12} />
          </button>
          {addOpen && (
            <div className="pop popover absolute right-0 top-full z-50 mt-1 w-52 p-1" onMouseDown={(e) => e.stopPropagation()}>
              {menuItems(() => setAddOpen(false))}
            </div>
          )}
        </div>
        <button
          className="btn btn-ghost btn-sm btn-icon"
          disabled={readOnly || !current?.parent}
          onClick={() => onAction({ type: "remove" })}
          aria-label="Delete the selected element"
          title="Delete (Del)"
        >
          <Trash size={13} />
        </button>
      </div>
      <div
        ref={listRef}
        role="tree"
        aria-label="FetchXML elements"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand/60"
      >
        {rows.map(({ node }) => {
          const { text, detail } = nodeLabel(node);
          const kind = KIND[node.tag];
          const open = !collapsed.has(node.path);
          const isSel = node.id === selected;
          return (
            <div
              key={node.path}
              data-id={node.id}
              role="treeitem"
              aria-selected={isSel}
              aria-expanded={node.children.length ? open : undefined}
              onClick={() => onSelect(node.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(node.id);
                setMenu({ x: e.clientX, y: e.clientY });
              }}
              className={`flex h-7 cursor-default items-center gap-1 whitespace-nowrap pr-2 text-[12.5px] ${
                isSel ? "bg-brand/12 text-fg" : "text-muted hover:bg-s3/60 hover:text-fg"
              }`}
              style={{ paddingLeft: 6 + node.depth * 14 }}
              title={detail ? `${text} · ${detail}` : text}
            >
              <button
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(node.path);
                }}
                className={`grid h-4 w-4 shrink-0 place-items-center rounded text-subtle hover:text-fg ${
                  node.children.length ? "" : "invisible"
                }`}
                aria-label={open ? "Collapse" : "Expand"}
              >
                <ChevronDown size={12} className={open ? "" : "-rotate-90"} />
              </button>
              <span className={`w-7 shrink-0 font-mono text-[10.5px] ${kind?.className ?? "text-subtle"}`}>
                {kind?.tag ?? "<>"}
              </span>
              <span className={`min-w-0 truncate font-mono ${node.tag === "entity" || node.tag === "link-entity" ? "font-semibold text-fg" : ""}`}>
                {text}
              </span>
              {detail && <span className="min-w-0 shrink-[4] truncate text-[11px] text-subtle">{detail}</span>}
              {marks?.[node.id] && (
                <span
                  className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${
                    marks[node.id] === "error" ? "bg-danger" : marks[node.id] === "warning" ? "bg-warning" : "bg-subtle"
                  }`}
                  aria-label={`Has a ${marks[node.id]}`}
                />
              )}
            </div>
          );
        })}
      </div>
      {menu && (current || readOnly) && (
        <div
          className="pop popover fixed z-50 w-52 p-1"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 260) }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          {readOnly ? (
            <div className="px-2 py-1.5 text-xs text-subtle">Fix the XML error to edit the tree.</div>
          ) : adds.length === 0 && !current?.parent ? (
            <div className="px-2 py-1.5 text-xs text-subtle">Nothing can be added here.</div>
          ) : (
            menuItems(() => setMenu(null))
          )}
        </div>
      )}
    </div>
  );
}
