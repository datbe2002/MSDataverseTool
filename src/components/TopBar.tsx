import { useMatch } from "react-router";
import { useStore, activeTabOf } from "../store";
import { tagStyle } from "../lib/tags";
import { ROUTES } from "../lib/navigation";
import { splitStatements } from "../lib/sqlStatements";
import { ConnectionSwitcher } from "./ConnectionSwitcher";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { Play, Loader, Sun, Moon } from "./Icon";
import type { Connection, Project } from "../types";

interface Props {
  onEdit: (c: Connection) => void;
  onAdd: () => void;
  onDiscover: () => void;
  onAddProject: () => void;
  onEditProject: (p: Project) => void;
}

export function TopBar({ onEdit, onAdd, onDiscover, onAddProject, onEditProject }: Props) {
  const isQuery = useMatch(ROUTES.query) !== null;
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const run = useStore((s) => s.run);
  const running = useStore((s) => s.running);
  const sql = useStore((s) => activeTabOf(s).sql);
  const hasSelection = useStore((s) => s.hasSelection);
  const connections = useStore((s) => s.connections);
  const activeId = useStore((s) => s.activeId);
  const active = connections.find((c) => c.id === activeId) ?? null;
  const style = active?.tag ? tagStyle(active.color) : null;
  const runKey = useStore((s) => s.keybindings.run[0]);

  const runLabel = running
    ? "Running…"
    : hasSelection
    ? "Run selection"
    : splitStatements(sql).length > 1
    ? "Run all"
    : "Run";

  return (
    <header className="relative shrink-0 border-b border-line bg-s1">
      {/* Environment accent stripe */}
      {style && <div className={`absolute inset-x-0 top-0 h-[2px] ${style.stripe}`} aria-hidden="true" />}
      <div className={`flex h-12 items-center gap-2 px-3 ${style ? style.tint : ""}`}>
        <ProjectSwitcher onAdd={onAddProject} onEdit={onEditProject} />
        <span className="text-line-strong" aria-hidden="true">/</span>
        <ConnectionSwitcher onEdit={onEdit} onAdd={onAdd} onDiscover={onDiscover} />

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="btn btn-ghost btn-icon"
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          {isQuery && (
            <button
              onClick={() => run()}
              disabled={running || !active}
              className="btn btn-primary"
              title={active ? "Run (selection if any, else the whole script)" : "Select a connection first"}
            >
              {running ? <Loader size={14} /> : <Play size={12} />}
              {runLabel}
              {!running && runKey && <span className="-mr-1 ml-1 rounded bg-white/15 px-1.5 py-px font-mono text-[10.5px] font-normal">{runKey}</span>}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
