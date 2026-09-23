import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  Settings,
  LogIn,
  LogOut,
  Layout,
  Code,
  Table,
  Clock,
  Loader,
  Flow,
  AlertTriangle,
  PanelLeftClose,
  PanelLeftOpen,
} from "./Icon";
import { Logo } from "./Logo";
import { UpdateNotice } from "./UpdateNotice";
import { tagStyle } from "../lib/tags";
import { ROUTES } from "../lib/navigation";
import { useStore, activeProjectOf } from "../store";

interface Props {
  onSettings: () => void;
}

const NAV: { tool: string; items: { to: string; label: string; icon: typeof Layout }[] }[] = [
  {
    tool: "SQL",
    items: [
      { to: ROUTES.overview, label: "Overview", icon: Layout },
      { to: ROUTES.query, label: "Query", icon: Code },
      { to: ROUTES.schema, label: "Schema", icon: Table },
      { to: ROUTES.history, label: "History", icon: Clock },
    ],
  },
  {
    tool: "Power Automate",
    items: [{ to: ROUTES.flows, label: "Flows", icon: Flow }],
  },
];

const COLLAPSED_KEY = "cds.sidebarCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

// Collapsing only animates the width: icons sit at the same x in both states
// (centred in the 56px rail) and labels fade out while the aside clips them.
export function Sidebar({ onSettings }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        // Only a convenience; the toggle still works for this session.
      }
      return !c;
    });

  // Ctrl+B, as in VS Code. Capture phase so the editor doesn't swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const { pathname } = useLocation();
  const navigate = useNavigate();
  const project = useStore(activeProjectOf);
  const signingIn = useStore((s) => s.signingIn);
  const authError = useStore((s) => s.authError);
  const signIn = useStore((s) => s.signIn);
  const cancelSignIn = useStore((s) => s.cancelSignIn);
  const requestSignOut = useStore((s) => s.requestSignOut);
  const historyCount = useStore((s) => s.history.length);

  const username = project?.username ?? null;
  const initials = username
    ?.split(/[@._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

  return (
    <aside className="sidebar flex shrink-0 flex-col border-r border-line bg-s1" data-collapsed={collapsed || undefined}>
      {/* Brand + the one collapse / expand control */}
      <div className="flex h-[49px] shrink-0 items-center gap-2.5 border-b border-line pl-[15px] pr-2">
        {collapsed ? (
          <button
            onClick={toggle}
            className="group relative grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            title="Expand sidebar (Ctrl+B)"
            aria-label="Expand sidebar"
          >
            <Logo size={26} className="rounded-[7px] transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
            <PanelLeftOpen
              size={18}
              className="absolute text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </button>
        ) : (
          <Logo size={26} className="shrink-0 rounded-[7px]" />
        )}
        <div className="sidebar-label min-w-0 leading-tight">
          <div className="text-[14px] font-semibold tracking-tight">Hexa Studio</div>
          <div className="truncate text-[11px] text-subtle">Power Platform toolkit</div>
        </div>
        <button
          onClick={toggle}
          className="sidebar-label btn btn-ghost btn-icon btn-sm ml-auto shrink-0 text-subtle"
          title="Collapse sidebar (Ctrl+B)"
          aria-label="Collapse sidebar"
          tabIndex={collapsed ? -1 : undefined}
          aria-hidden={collapsed || undefined}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Views */}
      <nav className="min-h-0 overflow-y-auto overflow-x-hidden px-2.5 pt-4" aria-label="Views">
        {NAV.map(({ tool, items }, i) => (
          <div key={tool} className="mb-4 space-y-0.5" role="group" aria-label={tool}>
            <div className="eyebrow relative px-2.5 pb-1.5">
              <span className="sidebar-label">{tool}</span>
              {/* Stands in for the heading in the rail. */}
              {i > 0 && <span className="sidebar-rule" aria-hidden="true" />}
            </div>
            {items.map(({ to, label, icon: Icon }) => {
              const count = to === ROUTES.history && historyCount > 0 ? historyCount : null;
              return (
                <button
                  key={to}
                  className="nav-item"
                  aria-current={pathname === to || pathname.startsWith(`${to}/`) ? "page" : undefined}
                  onClick={() => navigate(to)}
                  title={collapsed ? `${tool} · ${label}${count ? ` (${count})` : ""}` : undefined}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="sidebar-label">{label}</span>
                  {count && <span className="sidebar-label ml-auto text-[11px] tabular-nums text-subtle">{count}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex-1" />

      <UpdateNotice collapsed={collapsed} />

      {/* Account of the project in context + settings */}
      <div className="border-t border-line p-2.5">
        {project && (
          <div
            className="mb-1 flex items-center gap-1.5 pl-[15px] pt-1 text-[11px] text-subtle"
            title={collapsed ? project.name : undefined}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tagStyle(project.color).dot}`} />
            <span className="sidebar-label truncate">{project.name}</span>
          </div>
        )}
        {username ? (
          <div className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
            <div
              className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/15 text-[11px] font-semibold text-brand ring-1 ring-inset ring-brand/25"
              title={collapsed ? username : undefined}
            >
              <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-s1 bg-success" aria-hidden="true" />
              {initials || "•"}
            </div>
            <div className="sidebar-label min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium" title={username}>
                {username.split("@")[0]}
              </div>
              <div className="truncate text-[11px] text-subtle">
                {username.split("@")[1] ?? "signed in"}
              </div>
            </div>
            <button
              onClick={() => requestSignOut()}
              title={`Sign out of ${project?.name ?? "this project"}`}
              aria-label="Sign out"
              className="sidebar-label btn btn-ghost btn-icon btn-sm shrink-0"
              tabIndex={collapsed ? -1 : undefined}
              aria-hidden={collapsed || undefined}
            >
              <LogOut size={14} />
            </button>
          </div>
        ) : signingIn && collapsed ? (
          <button
            onClick={cancelSignIn}
            className="btn btn-secondary btn-icon"
            title="Waiting for the browser… Click to cancel."
            aria-label="Cancel sign-in"
          >
            <Loader size={14} className="text-brand" />
          </button>
        ) : signingIn ? (
          <div className="rounded-lg border border-line bg-s2 px-2.5 py-2" role="status">
            <div className="flex items-center gap-2 text-[12.5px] font-medium">
              <Loader size={13} className="shrink-0 text-brand" />
              Waiting for the browser…
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-subtle">
              Finish signing in there. Closed the tab? Cancel and try again.
            </div>
            <button onClick={cancelSignIn} className="btn btn-secondary btn-sm mt-2 w-full justify-center">
              Cancel
            </button>
          </div>
        ) : (
          // Icon anchored left (like the nav items), so it stays put while
          // the label fades as the sidebar narrows.
          <button
            onClick={() => signIn()}
            disabled={!project}
            className="btn btn-primary w-full !justify-start overflow-hidden !px-[9px]"
            title={project ? `Sign in to ${project.name}` : "Create a project first"}
            aria-label="Sign in with Microsoft"
          >
            <LogIn size={16} className="shrink-0" />
            <span className="sidebar-label">Sign in with Microsoft</span>
          </button>
        )}
        {authError &&
          (collapsed ? (
            <span className="grid h-8 w-9 place-items-center text-danger" title={`Sign-in failed: ${authError}`} role="alert">
              <AlertTriangle size={15} />
            </span>
          ) : (
            <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] leading-relaxed text-danger" role="alert">
              <span className="font-medium">Sign-in failed: </span>
              {authError}
            </div>
          ))}
        <button onClick={onSettings} className="nav-item mt-1" title={collapsed ? "Settings" : undefined}>
          <Settings size={16} className="shrink-0" />
          <span className="sidebar-label">Settings</span>
        </button>
      </div>
    </aside>
  );
}
