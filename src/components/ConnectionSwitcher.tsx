import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { tagStyle } from "../lib/tags";
import { TagBadge } from "./TagBadge";
import { ChevronDown, Compass, Plus, Pencil, Check } from "./Icon";
import type { Connection } from "../types";

interface Props {
  onEdit: (c: Connection) => void;
  onAdd: () => void;
  onDiscover: () => void;
}

export function ConnectionSwitcher({ onEdit, onAdd, onDiscover }: Props) {
  const allConnections = useStore((s) => s.connections);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeId = useStore((s) => s.activeId);
  const requestSwitch = useStore((s) => s.requestSwitch);
  // Only the environments of the project in context.
  const connections = useMemo(
    () => allConnections.filter((c) => c.projectId === activeProjectId),
    [allConnections, activeProjectId]
  );
  const active = connections.find((c) => c.id === activeId) ?? null;

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    setOpen(false);
    requestSwitch(id);
  };

  const activeDot = active
    ? active.tag
      ? tagStyle(active.color).dot
      : "bg-success"
    : "bg-subtle/50";

  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md px-2 transition hover:bg-s3"
        title="Switch connection"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${activeDot}`} />
        {active ? (
          <>
            <span className="truncate text-sm font-semibold">{active.name}</span>
            <TagBadge connection={active} size="md" />
            <span className="hidden min-w-0 truncate font-mono text-xs text-subtle lg:inline">
              {active.host}
            </span>
          </>
        ) : (
          <span className="text-sm text-subtle">Select environment</span>
        )}
        <ChevronDown size={15} className="shrink-0 text-subtle" />
      </button>

      {open && (
        <div className="pop popover absolute left-0 top-full z-50 mt-1.5 w-80 overflow-hidden">
          <div className="max-h-80 overflow-y-auto p-1" role="listbox">
            {connections.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-subtle">
                No environments in this project yet.
              </div>
            ) : (
              connections.map((c) => {
                const isActive = c.id === activeId;
                const style = c.tag ? tagStyle(c.color) : null;
                return (
                  <div
                    key={c.id}
                    role="option"
                    aria-selected={isActive}
                    className={`group flex items-center gap-1 rounded-lg pr-1 ${
                      isActive ? "bg-brand/10" : "hover:bg-s3"
                    }`}
                  >
                    <button
                      onClick={() => pick(c.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          style ? style.dot : isActive ? "bg-brand" : "bg-subtle/50"
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{c.name}</span>
                          <TagBadge connection={c} />
                        </span>
                        <span className="block truncate font-mono text-[11px] text-subtle">
                          {c.host}
                        </span>
                      </span>
                      {isActive && <Check size={14} className="shrink-0 text-brand" />}
                    </button>
                    <button
                      onClick={() => {
                        onEdit(c);
                        setOpen(false);
                      }}
                      title={`Edit or remove ${c.name}`}
                      aria-label={`Edit or remove ${c.name}`}
                      className="btn btn-ghost btn-icon shrink-0 text-subtle opacity-70 transition hover:text-fg group-hover:opacity-100"
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t border-line p-1">
            <button
              onClick={() => {
                onDiscover();
                setOpen(false);
              }}
              className="nav-item"
            >
              <Compass size={15} />
              Discover environments
            </button>
            <button
              onClick={() => {
                onAdd();
                setOpen(false);
              }}
              className="nav-item"
            >
              <Plus size={15} />
              Add environment by URL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
