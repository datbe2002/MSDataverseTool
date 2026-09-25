import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, activeProjectOf } from "../store";
import { useSchema } from "../lib/schema";
import { useFlows } from "../lib/flows";
import { useFetchXml } from "../lib/fetchXmlStore";
import { ROUTES, flowRoute, navigate } from "../lib/navigation";
import { rank, type PaletteItem } from "../lib/palette";
import { tabTitle } from "../lib/tabs";
import { relativeTime } from "../lib/history";
import { tagStyle } from "../lib/tags";
import { NAV, TOGGLE_SIDEBAR_EVENT } from "./Sidebar";
import type { SettingsSection } from "./SettingsDialog";
import {
  Search,
  Code,
  Table,
  Flow,
  Clock,
  Settings,
  Compass,
  Plus,
  Sun,
  Moon,
  Database,
  Folder,
  LogIn,
  LogOut,
  FileCode,
  PanelLeftClose,
  CornerDownLeft,
} from "./Icon";

/** Everything the palette opens that lives in RootLayout. */
export interface PaletteOpeners {
  openSettings: (section?: SettingsSection) => void;
  openDiscover: () => void;
  openAdd: () => void;
}

/** Ctrl+K (outside the editor, where Ctrl+K starts Monaco's chords), Ctrl+P and Ctrl+Shift+P toggle the palette. */
export function usePaletteShortcut(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const inEditor = e.target instanceof Element && !!e.target.closest(".monaco-editor");
      const hit = k === "p" || (k === "k" && !e.shiftKey && !inEditor);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [toggle]);
}

const tableSql = (table: string) => `SELECT TOP 100 *\nFROM ${table}`;
const tableFetch = (table: string) => `<fetch top="50">\n  <entity name="${table}">\n    <all-attributes />\n  </entity>\n</fetch>`;

/** First meaningful line of a query, for a one-line label. */
function oneLine(sql: string): string {
  const line = sql
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("--"));
  return (line ?? sql).replace(/\s+/g, " ").slice(0, 120);
}

export function CommandPalette({ onClose, openers }: { onClose: () => void; openers: PaletteOpeners }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeId = useStore((s) => s.activeId);
  const connections = useStore((s) => s.connections);
  const projects = useStore((s) => s.projects);
  const project = useStore(activeProjectOf);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const history = useStore((s) => s.history);
  const theme = useStore((s) => s.theme);
  const tables = useSchema((s) => (activeId ? s.tables[activeId] : undefined));
  const flows = useFlows((s) => (activeId ? s.lists[activeId]?.flows : undefined));

  // Tables and flows are cached per environment; read them if they aren't yet.
  useEffect(() => {
    if (!activeId) return;
    void useSchema.getState().loadTables(activeId);
    useFlows.getState().loadFlows(activeId);
  }, [activeId]);

  // Focus trap lite: the input keeps focus, the list is driven from it.
  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo<PaletteItem[]>(() => {
    const s = useStore.getState();
    const out: PaletteItem[] = [];

    for (const { tool, items: views } of NAV) {
      for (const v of views) {
        const Icon = v.icon;
        out.push({
          id: `nav:${v.to}`,
          group: "Go to",
          label: `${tool} · ${v.label}`,
          icon: <Icon size={15} />,
          run: () => navigate(v.to),
        });
      }
    }

    const act = (id: string, label: string, icon: React.ReactNode, run: () => void, hint?: string, keywords?: string) =>
      out.push({ id: `act:${id}`, group: "Actions", label, icon, run, hint, keywords });
    act("new-sql", "New SQL query tab", <Code size={15} />, () => {
      s.newTab();
      navigate(ROUTES.query);
    });
    if (activeId) {
      act("new-fetch", "New FetchXML query", <FileCode size={15} />, () => {
        if (!useFetchXml.getState().newTab(activeId)) {
          s.pushToast({ tone: "warning", title: "Tab limit reached", body: "Close a FetchXML tab first." });
        }
        navigate(ROUTES.fetchxml);
      });
    }
    act(
      "theme",
      theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      theme === "dark" ? <Sun size={15} /> : <Moon size={15} />,
      s.toggleTheme,
      undefined,
      "theme dark light mode"
    );
    act("sidebar", "Collapse or expand sidebar", <PanelLeftClose size={15} />, () => window.dispatchEvent(new Event(TOGGLE_SIDEBAR_EVENT)), "Ctrl+B");
    act("settings", "Settings…", <Settings size={15} />, () => openers.openSettings(), undefined, "preferences");
    act("settings-keyboard", "Settings: Keyboard shortcuts", <Settings size={15} />, () => openers.openSettings("keyboard"), undefined, "keybindings run hotkey");
    act("settings-engine", "Settings: Query engine", <Settings size={15} />, () => openers.openSettings("engine"), undefined, "tds endpoint worker threads parallel");
    act("settings-signin", "Settings: Sign-in and accounts", <Settings size={15} />, () => openers.openSettings("signin"), undefined, "client id tenant app registration");
    act("about", "Settings: About and updates", <Settings size={15} />, () => openers.openSettings("about"), undefined, "version check for updates");
    act("discover", "Discover environments…", <Compass size={15} />, openers.openDiscover, undefined, "add environment connection");
    act("add", "Add environment by URL…", <Plus size={15} />, openers.openAdd, undefined, "connection");
    if (project && !project.username) {
      act("sign-in", `Sign in to ${project.name}`, <LogIn size={15} />, () => void s.signIn(), undefined, "microsoft login account");
    } else if (project?.username) {
      act("sign-out", `Sign out of ${project.name}…`, <LogOut size={15} />, () => s.requestSignOut(), project.username, "logout account");
    }

    if (tabs.length > 1) {
      for (const t of tabs) {
        if (t.id === activeTabId) continue;
        out.push({
          id: `tab:${t.id}`,
          group: "SQL tabs",
          label: t.title || tabTitle(t.sql),
          hint: t.sql !== t.savedSql ? "unsaved" : undefined,
          keywords: t.sql.slice(0, 500),
          icon: <Code size={15} />,
          run: () => {
            s.setActiveTab(t.id);
            navigate(ROUTES.query);
          },
        });
      }
    }

    for (const c of connections) {
      if (c.projectId !== project?.id || c.id === activeId) continue;
      out.push({
        id: `env:${c.id}`,
        group: "Environments",
        label: c.name,
        hint: c.tag ?? c.host,
        keywords: `switch environment ${c.host} ${c.friendlyName}`,
        icon: (
          <span className="grid h-[15px] w-[15px] place-items-center">
            <span className={`h-2 w-2 rounded-full ${tagStyle(c.color).dot}`} />
          </span>
        ),
        run: () => s.requestSwitch(c.id),
      });
    }
    for (const p of projects) {
      if (p.id === project?.id) continue;
      out.push({
        id: `project:${p.id}`,
        group: "Projects",
        label: p.name,
        hint: p.username ?? "not signed in",
        keywords: "switch project tenant",
        icon: <Folder size={15} />,
        run: () => s.requestProjectSwitch(p.id),
      });
    }

    for (const t of tables ?? []) {
      out.push({
        id: `table:${t.logicalName}`,
        group: "Tables",
        label: t.logicalName,
        hint: t.displayName,
        icon: <Table size={15} />,
        searchOnly: true,
        run: () => navigate(`${ROUTES.schema}?table=${encodeURIComponent(t.logicalName)}`),
        alts: [
          { key: "shift", label: "query in SQL", run: () => s.loadSql(tableSql(t.logicalName)) },
          ...(activeId
            ? [
                {
                  key: "alt" as const,
                  label: "open in FetchXML",
                  run: () => {
                    if (!useFetchXml.getState().newTab(activeId, tableFetch(t.logicalName))) {
                      s.pushToast({ tone: "warning", title: "Tab limit reached", body: "Close a FetchXML tab first." });
                    }
                    navigate(ROUTES.fetchxml);
                  },
                },
              ]
            : []),
        ],
      });
    }

    for (const f of flows ?? []) {
      out.push({
        id: `flow:${f.id}`,
        group: "Flows",
        label: f.name || "(no name)",
        hint: f.state === 1 ? "On" : f.stateLabel,
        keywords: `${f.owner} ${f.solutions.join(" ")}`,
        icon: <Flow size={15} />,
        searchOnly: true,
        run: () => navigate(flowRoute(f.id)),
      });
    }

    const seen = new Set<string>();
    for (const h of history) {
      if (h.connectionId !== activeId || seen.has(h.sql) || seen.size >= 30) continue;
      seen.add(h.sql);
      out.push({
        id: `history:${h.id}`,
        group: "Recent queries",
        label: oneLine(h.sql),
        hint: relativeTime(h.at),
        keywords: h.sql.slice(0, 500),
        icon: <Clock size={15} />,
        searchOnly: true,
        run: () => s.loadSql(h.sql),
      });
    }
    return out;
  }, [activeId, connections, projects, project, tabs, activeTabId, history, theme, tables, flows, openers]);

  const groups = useMemo(() => rank(items, query), [items, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = flat[Math.min(active, flat.length - 1)] ?? null;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, flat]);

  const runItem = (item: PaletteItem, mod: "shift" | "alt" | null) => {
    const action = mod ? item.alts?.find((a) => a.key === mod)?.run : item.run;
    if (!action) return;
    // Close first: what it opens (a dialog, another view) takes over.
    onClose();
    action();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = (to: number) => {
      e.preventDefault();
      if (flat.length) setActive((to + flat.length) % flat.length);
    };
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "PageDown") move(Math.min(flat.length - 1, active + 8));
    else if (e.key === "PageUp") move(Math.max(0, active - 8));
    else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      runItem(current, e.shiftKey ? "shift" : e.altKey ? "alt" : null);
    }
  };

  let index = -1;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-center px-4 pt-[12vh] backdrop-blur-[2px]"
      style={{ background: "var(--overlay)" }}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="modal-in popover flex max-h-[min(560px,76vh)] w-full max-w-xl flex-col self-start overflow-hidden !rounded-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-subtle" />
          <input
            ref={inputRef}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-subtle"
            placeholder={activeId ? "Search views, actions, tables, flows, queries…" : "Search views and actions…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={current ? `palette-${current.id}` : undefined}
            aria-label="Search commands"
            spellCheck={false}
          />
          <span className="kbd shrink-0">Esc</span>
        </div>

        <ul id="palette-list" ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Results">
          {flat.length === 0 ? (
            <li className="px-3 py-10 text-center text-sm text-subtle">
              {query.trim() ? (
                <>
                  Nothing matches “{query.trim()}”.
                  {!activeId && <div className="mt-1 text-xs">Pick an environment to search its tables and flows.</div>}
                </>
              ) : (
                "Type to search."
              )}
            </li>
          ) : (
            groups.map((g) => (
              <li key={g.group} role="presentation">
                <div className="eyebrow px-2.5 pb-1 pt-2.5">{g.group}</div>
                <ul role="group" aria-label={g.group}>
                  {g.items.map((item) => {
                    index += 1;
                    const i = index;
                    const selected = current?.id === item.id;
                    return (
                      <li
                        key={item.id}
                        id={`palette-${item.id}`}
                        role="option"
                        aria-selected={selected}
                        className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] ${
                          selected ? "bg-brand/12 text-fg" : "text-muted"
                        }`}
                        onMouseMove={() => i !== active && setActive(i)}
                        onClick={(e) => runItem(item, e.shiftKey ? "shift" : e.altKey ? "alt" : null)}
                      >
                        <span className={`shrink-0 ${selected ? "text-brand" : "text-subtle"}`}>{item.icon ?? <Database size={15} />}</span>
                        <span className={`min-w-0 flex-1 truncate ${item.group === "Tables" ? "font-mono text-[12.5px]" : ""}`}>{item.label}</span>
                        {item.hint && <span className="max-w-[45%] shrink-0 truncate text-xs text-subtle">{item.hint}</span>}
                        {selected && <CornerDownLeft size={13} className="shrink-0 text-subtle" />}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>

        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-s1 px-4 py-2 text-[11.5px] text-subtle">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> move
          </span>
          <span>
            <span className="kbd">Enter</span> {current?.group === "Tables" ? "open in Schema" : "open"}
          </span>
          {current?.alts?.map((a) => (
            <span key={a.key}>
              <span className="kbd">{a.key === "shift" ? "Shift+Enter" : "Alt+Enter"}</span> {a.label}
            </span>
          ))}
          {!query.trim() && activeId && <span className="ml-auto">Type to find tables, flows and past queries</span>}
        </div>
      </div>
    </div>
  );
}
