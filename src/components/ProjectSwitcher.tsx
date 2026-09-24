import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { tagStyle } from "../lib/tags";
import { ChevronDown, Folder, Plus, Pencil, Check, LogIn } from "./Icon";
import type { Project } from "../types";

interface Props {
  onAdd: () => void;
  onEdit: (p: Project) => void;
}

/** Picks the tenant/customer workspace whose environments are in context. */
export function ProjectSwitcher({ onAdd, onEdit }: Props) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const connections = useStore((s) => s.connections);
  const requestProjectSwitch = useStore((s) => s.requestProjectSwitch);
  const signIn = useStore((s) => s.signIn);
  const signingIn = useStore((s) => s.signingIn);

  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of connections) map[c.projectId] = (map[c.projectId] ?? 0) + 1;
    return map;
  }, [connections]);

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

  return (
    // Gives way before the connection name when the bar is narrow.
    <div className="relative min-w-0 shrink-[3]" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md px-2 transition hover:bg-s3"
        title="Switch project"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Folder size={15} className={`shrink-0 ${active ? tagStyle(active.color).text : "text-subtle"}`} />
        <span className="truncate text-sm font-medium text-muted">
          {active ? active.name : "No project"}
        </span>
        <ChevronDown size={14} className="shrink-0 text-subtle" />
      </button>

      {open && (
        <div className="pop popover absolute left-0 top-full z-50 mt-1.5 w-72 overflow-hidden">
          <div className="max-h-80 overflow-y-auto p-1" role="listbox">
            {projects.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-subtle">No projects yet.</div>
            ) : (
              projects.map((p) => {
                const isActive = p.id === activeProjectId;
                const style = tagStyle(p.color);
                const n = counts[p.id] ?? 0;
                return (
                  <div
                    key={p.id}
                    role="option"
                    aria-selected={isActive}
                    className={`group flex items-center gap-1 rounded-lg pr-1 ${
                      isActive ? "bg-brand/10" : "hover:bg-s3"
                    }`}
                  >
                    <button
                      onClick={() => {
                        setOpen(false);
                        requestProjectSwitch(p.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{p.name}</span>
                        <span className="block truncate text-[11px] text-subtle">
                          {p.username ?? "not signed in"}
                          {n > 0 ? ` · ${n} env${n === 1 ? "" : "s"}` : ""}
                        </span>
                      </span>
                      {isActive && <Check size={14} className="shrink-0 text-brand" />}
                    </button>
                    <button
                      onClick={() => {
                        onEdit(p);
                        setOpen(false);
                      }}
                      title={`Edit or delete ${p.name}`}
                      aria-label={`Edit or delete ${p.name}`}
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
            {active && !active.username && (
              <button
                onClick={() => {
                  setOpen(false);
                  signIn(active.id);
                }}
                disabled={signingIn}
                className="nav-item"
              >
                <LogIn size={15} />
                Sign in to {active.name}
              </button>
            )}
            <button
              onClick={() => {
                onAdd();
                setOpen(false);
              }}
              className="nav-item"
            >
              <Plus size={15} />
              New project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
