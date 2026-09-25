import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { comboFromEvent, formatCombo, isValidBinding, DEFAULT_KEYS } from "../lib/keys";
import { useUpdater } from "../lib/updater";
import { tagStyle } from "../lib/tags";
import { Logo } from "./Logo";
import { TOGGLE_SIDEBAR_EVENT } from "./Sidebar";
import { X, Loader, Check, Settings, Keyboard, Database, Key, Info, Minus, Plus, LogIn, LogOut } from "./Icon";
import type { Theme } from "../store";

export type SettingsSection = "general" | "keyboard" | "engine" | "signin" | "about";

const SECTIONS: { key: SettingsSection; label: string; icon: typeof Settings; description: string; group: string }[] = [
  { key: "general", label: "General", icon: Settings, group: "Preferences", description: "How Hexa Studio looks." },
  { key: "keyboard", label: "Keyboard", icon: Keyboard, group: "Preferences", description: "Shortcuts for running queries, and the ones built in." },
  { key: "engine", label: "Query engine", icon: Database, group: "Workspace", description: "Where SELECT runs, and how many requests go out at once." },
  { key: "signin", label: "Sign-in", icon: Key, group: "Workspace", description: "Your accounts, and the app registration used to sign in." },
  { key: "about", label: "About", icon: Info, group: "App", description: "Version and updates." },
];

/** The section Settings last showed, while the app runs. */
let lastSection: SettingsSection = "general";

/**
 * Settings, laid out like a SaaS settings page: sections on the left, cards
 * of settings on the right. Switches apply at once; typed values have a Save
 * button on their card.
 */
export function SettingsModal({ onClose, section }: { onClose: () => void; section?: SettingsSection }) {
  const [current, setCurrent] = useState<SettingsSection>(section ?? lastSection);
  const overlayRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const show = (s: SettingsSection) => {
    lastSection = s;
    setCurrent(s);
    bodyRef.current?.scrollTo({ top: 0 });
  };

  // Esc closes — only when this is the top dialog (a sign-out confirm can stack on it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const open = document.querySelectorAll('[aria-modal="true"]');
      if (open[open.length - 1] !== overlayRef.current) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);

  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = SECTIONS.findIndex((s) => s.key === current);
    const next = SECTIONS[(i + (e.key === "ArrowDown" ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
    show(next.key);
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  const meta = SECTIONS.find((s) => s.key === current)!;
  let lastGroup = "";

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]"
      style={{ background: "var(--overlay)" }}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div
        className="modal-in popover relative grid h-[min(660px,calc(100vh-32px))] w-[min(940px,calc(100vw-32px))] grid-cols-[208px_minmax(0,1fr)] overflow-hidden !rounded-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Sections */}
        <div className="flex min-h-0 flex-col border-r border-line bg-s1">
          <div className="px-5 pb-2 pt-5 text-[15px] font-semibold tracking-tight">Settings</div>
          <div
            ref={navRef}
            className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={onNavKey}
          >
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const heading = s.group !== lastGroup ? (lastGroup = s.group) : null;
              return (
                <div key={s.key}>
                  {heading && <div className="eyebrow px-2.5 pb-1.5 pt-4">{heading}</div>}
                  <button
                    role="tab"
                    id={`settings-tab-${s.key}`}
                    aria-selected={current === s.key}
                    aria-controls="settings-panel"
                    aria-current={current === s.key ? "page" : undefined}
                    tabIndex={current === s.key ? 0 : -1}
                    className="nav-item"
                    onClick={() => show(s.key)}
                  >
                    <Icon size={15} className="shrink-0" />
                    {s.label}
                  </button>
                </div>
              );
            })}
          </div>
          <AppVersion />
        </div>

        {/* Section */}
        <div className="flex min-h-0 flex-col bg-bg">
          <button onClick={onClose} className="btn btn-ghost btn-icon btn-sm absolute right-3 top-3 z-10" aria-label="Close settings">
            <X size={15} />
          </button>
          <div
            ref={bodyRef}
            id="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${current}`}
            className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          >
            <div key={current} className="fade-in mx-auto max-w-[640px] px-8 pb-10 pt-7">
              <header className="mb-6 pr-8">
                <h2 className="text-[19px] font-semibold tracking-tight">{meta.label}</h2>
                <p className="mt-1 text-[13px] text-muted">{meta.description}</p>
              </header>
              <div className="space-y-6">
                {current === "general" && <GeneralSection />}
                {current === "keyboard" && <KeyboardSection />}
                {current === "engine" && <EngineSection />}
                {current === "signin" && <SignInSection />}
                {current === "about" && <AboutSection />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- building blocks ---------- */

function Card({
  title,
  description,
  children,
  footer,
}: {
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      {title && (
        <div className="px-5 pt-4">
          <h3 className="text-[14px] font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-subtle">{description}</p>}
        </div>
      )}
      <div className="divide-y divide-line px-5">{children}</div>
      {footer && (
        <div className="flex min-h-[48px] items-center justify-between gap-3 border-t border-line bg-s2 px-5 py-2.5 text-[12px] text-subtle dark:bg-s1">
          {footer}
        </div>
      )}
    </section>
  );
}

/** A setting: what it is on the left, its control on the right. */
function Row({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[13.5px] font-medium">
          {label}
        </label>
        {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-subtle">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, id, label }: { checked: boolean; onChange: (on: boolean) => void; id?: string; label: string }) {
  return <button id={id} role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

/** Save for a card of typed values: enabled once something changed. */
function SaveBar({ dirty, busy, onSave, onReset, hint }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void; hint: React.ReactNode }) {
  return (
    <>
      <span className="min-w-0">{dirty ? <span className="text-warning">Unsaved changes</span> : hint}</span>
      <div className="flex shrink-0 gap-2">
        {dirty && (
          <button className="btn btn-ghost btn-sm" onClick={onReset} disabled={busy}>
            Discard
          </button>
        )}
        <button className="btn btn-primary btn-sm" onClick={onSave} disabled={!dirty || busy}>
          {busy && <Loader size={12} />}
          Save
        </button>
      </div>
    </>
  );
}

/** Writes the backend settings (client id, tenant, worker threads); only the given ones change. */
function useSaveSettings() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<{ clientId: string; tenant: string; workerThreads: number }>) => {
    setBusy(true);
    const ok = await saveSettings(
      patch.clientId ?? settings?.clientId ?? "",
      patch.tenant ?? settings?.tenant ?? "",
      patch.workerThreads ?? settings?.workerThreads ?? 0
    );
    setBusy(false);
    pushToast(ok ? { tone: "success", title: "Settings saved" } : { tone: "error", title: "Couldn't save the settings" });
    return ok;
  };
  return { settings, save, busy };
}

function AppVersion() {
  const version = useUpdater().currentVersion;
  return (
    <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-[11.5px] text-subtle">
      <Logo size={16} className="rounded-[4px]" />
      Hexa Studio{version ? <span className="font-mono">v{version}</span> : null}
    </div>
  );
}

/* ---------- General ---------- */

function ThemePreview({ theme }: { theme: Theme }) {
  // Re-scopes the design tokens, so the picture uses that theme's real colours.
  return (
    <div className={`${theme === "dark" ? "dark" : "theme-light"} pointer-events-none flex h-[92px] overflow-hidden rounded-md border border-line bg-bg`} aria-hidden="true">
      <div className="w-[26%] space-y-1.5 border-r border-line bg-s1 p-2">
        <div className="h-1.5 w-3/4 rounded-full bg-brand" />
        <div className="h-1.5 w-full rounded-full bg-s3" />
        <div className="h-1.5 w-2/3 rounded-full bg-s3" />
      </div>
      <div className="flex-1 space-y-1.5 p-2">
        <div className="flex gap-1.5">
          <div className="h-2 w-1/3 rounded-full bg-fg/70" />
          <div className="ml-auto h-2 w-6 rounded-full bg-brand-solid" />
        </div>
        <div className="space-y-1 rounded border border-line bg-s2 p-1.5">
          <div className="h-1.5 w-full rounded-full bg-s3" />
          <div className="h-1.5 w-4/5 rounded-full bg-s3" />
          <div className="h-1.5 w-3/5 rounded-full bg-s3" />
        </div>
      </div>
    </div>
  );
}

const SIDEBAR_KEY = "cds.sidebarCollapsed";

function GeneralSection() {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });

  return (
    <>
      <Card title="Appearance" description="Pick a theme. The editor and grids follow it.">
        <div className="grid grid-cols-2 gap-3 py-4" role="radiogroup" aria-label="Theme">
          {(["light", "dark"] as const).map((t) => {
            const selected = theme === t;
            return (
              <button
                key={t}
                role="radio"
                aria-checked={selected}
                onClick={() => !selected && toggleTheme()}
                className={`group rounded-lg border p-2 text-left transition ${
                  selected ? "border-brand ring-2 ring-brand/25" : "border-line hover:border-line-strong"
                }`}
              >
                <ThemePreview theme={t} />
                <div className="flex items-center gap-2 px-1 pb-0.5 pt-2 text-[13px] font-medium">
                  <span
                    className={`grid h-4 w-4 place-items-center rounded-full border ${selected ? "border-brand bg-brand-solid text-white" : "border-line-strong"}`}
                  >
                    {selected && <Check size={10} strokeWidth={3} />}
                  </span>
                  {t === "light" ? "Light" : "Dark"}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Layout">
        <Row label="Collapse the sidebar" description="Show only icons in the sidebar, to give the tools more room." htmlFor="set-sidebar">
          <span className="kbd">Ctrl B</span>
          <Switch
            id="set-sidebar"
            label="Collapse the sidebar"
            checked={collapsed}
            onChange={(on) => {
              setCollapsed(on);
              window.dispatchEvent(new Event(TOGGLE_SIDEBAR_EVENT));
            }}
          />
        </Row>
      </Card>
    </>
  );
}

/* ---------- Keyboard ---------- */

/** Shortcuts built into the app (not configurable), for reference. */
const BUILT_IN: { label: string; keys: string[]; where?: string }[] = [
  { label: "Command palette", keys: ["Ctrl K", "Ctrl P"] },
  { label: "Collapse or expand the sidebar", keys: ["Ctrl B"] },
  { label: "Save the query", keys: ["Ctrl S"], where: "SQL, FetchXML" },
  { label: "Save as…", keys: ["Ctrl Shift S"], where: "FetchXML" },
  { label: "Open a file", keys: ["Ctrl O"], where: "FetchXML" },
  { label: "Format the XML", keys: ["Shift Alt F"], where: "FetchXML" },
  { label: "Find a step", keys: ["Ctrl F"], where: "Flows designer" },
];

function KeyboardSection() {
  const bindings = useStore((s) => s.keybindings.run);
  const setKeybindings = useStore((s) => s.setKeybindings);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      const combo = comboFromEvent(e);
      if (combo === null) return; // waiting for a non-modifier key
      e.preventDefault();
      e.stopPropagation();
      if (combo === "Escape") {
        setRecording(false);
        setErr(null);
        return;
      }
      if (!isValidBinding(combo)) {
        setErr("Use a function key (F1–F12) or combine with Ctrl / Alt / Shift.");
        return;
      }
      if (!bindings.includes(combo)) setKeybindings({ run: [...bindings, combo] });
      setRecording(false);
      setErr(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording, bindings, setKeybindings]);

  const isDefault = bindings.length === DEFAULT_KEYS.run.length && bindings.every((b) => DEFAULT_KEYS.run.includes(b));

  return (
    <>
      <Card
        title="Run query"
        description="Runs the selected text, or the whole script statement by statement. Also runs the FetchXML query in the FetchXML tool."
        footer={
          <>
            <span className={err ? "text-warning" : undefined} role={err ? "alert" : undefined}>
              {err ?? (recording ? "Press the keys now · Esc cancels" : "Changes apply right away.")}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => setKeybindings(DEFAULT_KEYS)} disabled={isDefault} title="Back to F5 and Ctrl+Enter">
              Reset to defaults
            </button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 py-4">
          {bindings.map((c) => (
            <span key={c} className="kbd !h-7 gap-1.5 !pl-2.5 pr-1 !text-[12px]">
              {formatCombo(c)}
              <button
                onClick={() => setKeybindings({ run: bindings.filter((b) => b !== c) })}
                className="grid h-5 w-5 place-items-center rounded text-subtle transition hover:bg-danger/15 hover:text-danger"
                aria-label={`Remove ${formatCombo(c)}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {bindings.length === 0 && <span className="text-[12.5px] text-subtle">No shortcut: use the Run button.</span>}
          <button
            onClick={() => {
              setErr(null);
              setRecording((r) => !r);
            }}
            className={`btn btn-secondary btn-sm ${recording ? "!border-brand/60 !bg-brand/15 !text-fg" : ""}`}
            aria-pressed={recording}
          >
            {recording ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Recording…
              </>
            ) : (
              <>
                <Plus size={12} /> Add shortcut
              </>
            )}
          </button>
        </div>
      </Card>

      <Card title="Built-in shortcuts">
        {BUILT_IN.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-4 py-2.5">
            <span className="text-[13px]">
              {s.label}
              {s.where && <span className="ml-2 text-[12px] text-subtle">{s.where}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {s.keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-[11px] text-subtle">or</span>}
                  <span className="kbd">{k}</span>
                </span>
              ))}
            </span>
          </div>
        ))}
      </Card>
    </>
  );
}

/* ---------- Query engine ---------- */

const MAX_WORKERS = 32;

function EngineSection() {
  const engineMode = useStore((s) => s.engineMode);
  const setEngineMode = useStore((s) => s.setEngineMode);
  const { settings, save, busy } = useSaveSettings();
  const saved = settings?.workerThreads ?? 0;
  const [workers, setWorkers] = useState(saved);
  useEffect(() => setWorkers(saved), [saved]);
  const auto = workers === 0;
  const clamp = (n: number) => Math.min(MAX_WORKERS, Math.max(1, n));

  return (
    <>
      <Card title="SQL endpoint">
        <Row
          label="Use the TDS endpoint"
          htmlFor="set-tds"
          description={
            <>
              Run SELECT on the environment's SQL (TDS) endpoint instead of the FetchXML engine. Faster for COUNT, GROUP BY
              and JOIN over big tables, but it can't read virtual tables and stops after 2 minutes on trial environments.
              <span className="mt-1 block">Off: queries the FetchXML engine can't run still go to TDS on their own.</span>
            </>
          }
        >
          <Switch id="set-tds" label="Use the TDS endpoint" checked={engineMode === "tds"} onChange={(on) => setEngineMode(on ? "tds" : "fetchxml")} />
        </Row>
      </Card>

      <Card
        title="Parallel requests"
        description="Worker threads for big FetchXML reads and for INSERT / UPDATE / DELETE."
        footer={
          <SaveBar
            dirty={workers !== saved}
            busy={busy}
            onSave={() => void save({ workerThreads: workers })}
            onReset={() => setWorkers(saved)}
            hint={auto ? "Auto follows the server's x-ms-dop-hint." : `Up to ${workers} request${workers === 1 ? "" : "s"} at once.`}
          />
        }
      >
        <Row label="Threads" description="Auto lets the server decide. 1 reads page by page.">
          <div className="seg" role="group" aria-label="Thread count">
            <button aria-pressed={auto} onClick={() => setWorkers(0)}>
              Auto
            </button>
            <button aria-pressed={!auto} onClick={() => auto && setWorkers(8)}>
              Custom
            </button>
          </div>
        </Row>
        {!auto && (
          <Row label="Number of threads" description={`Between 1 and ${MAX_WORKERS}.`} htmlFor="set-workers">
            <div className="flex items-center rounded-lg border border-line bg-s2">
              <button className="btn btn-ghost btn-icon btn-sm !rounded-r-none" onClick={() => setWorkers((w) => clamp(w - 1))} disabled={workers <= 1} aria-label="Fewer threads">
                <Minus size={13} />
              </button>
              <input
                id="set-workers"
                className="h-[26px] w-12 border-x border-line bg-transparent text-center font-mono text-[13px] tabular-nums outline-none focus:bg-s3"
                inputMode="numeric"
                value={workers}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                  setWorkers(Number.isFinite(n) ? clamp(n) : 1);
                }}
              />
              <button className="btn btn-ghost btn-icon btn-sm !rounded-l-none" onClick={() => setWorkers((w) => clamp(w + 1))} disabled={workers >= MAX_WORKERS} aria-label="More threads">
                <Plus size={13} />
              </button>
            </div>
          </Row>
        )}
        <p className="py-3.5 text-[12.5px] leading-relaxed text-subtle">
          Big reads list the matching keys first, then download key ranges on this many requests at once. Writes start with
          one thread and add one per second while requests succeed. When the server throttles (429), both wait the time it
          asks for; writes also drop a thread for the rest of the run.
        </p>
      </Card>
    </>
  );
}

/* ---------- Sign-in ---------- */

function SignInSection() {
  const projects = useStore((s) => s.projects);
  const signIn = useStore((s) => s.signIn);
  const signingIn = useStore((s) => s.signingIn);
  const requestSignOut = useStore((s) => s.requestSignOut);
  const { settings, save, busy } = useSaveSettings();
  const [clientId, setClientId] = useState(settings?.clientId ?? "");
  const [tenant, setTenant] = useState(settings?.tenant ?? "");
  useEffect(() => {
    setClientId(settings?.clientId ?? "");
    setTenant(settings?.tenant ?? "");
  }, [settings]);
  const dirty = clientId.trim() !== (settings?.clientId ?? "") || tenant.trim() !== (settings?.tenant ?? "");

  return (
    <>
      <Card title="Accounts" description="Each project signs in on its own. Signing out keeps its environments, queries and history.">
        {projects.length === 0 ? (
          <div className="py-4 text-[12.5px] text-subtle">No projects yet.</div>
        ) : (
          projects.map((p) => (
            <div key={p.id} className="flex items-center gap-3 py-3">
              <span
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px] font-semibold ${tagStyle(p.color).badge}`}
                aria-hidden="true"
              >
                {p.name.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{p.name}</span>
                  {p.username ? (
                    <span className="badge badge-dot badge-success shrink-0">Signed in</span>
                  ) : (
                    <span className="badge badge-neutral shrink-0">Signed out</span>
                  )}
                </div>
                <div className="truncate text-[12px] text-subtle">{p.username ?? "Sign in to use its environments"}</div>
              </div>
              {p.username ? (
                <button className="btn btn-ghost btn-sm" onClick={() => requestSignOut(p.id)}>
                  <LogOut size={12} /> Sign out
                </button>
              ) : (
                <button className="btn btn-secondary btn-sm" onClick={() => void signIn(p.id)} disabled={signingIn}>
                  <LogIn size={12} /> Sign in
                </button>
              )}
            </div>
          ))
        )}
      </Card>

      <Card
        title="App registration"
        description="Used by every project that doesn't set its own (Edit project → sign-in options)."
        footer={
          <SaveBar
            dirty={dirty}
            busy={busy}
            onSave={() => void save({ clientId: clientId.trim(), tenant: tenant.trim() })}
            onReset={() => {
              setClientId(settings?.clientId ?? "");
              setTenant(settings?.tenant ?? "");
            }}
            hint="Takes effect at the next sign-in."
          />
        }
      >
        <div className="space-y-4 py-4">
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-muted">Application (client) ID</span>
            <input
              className="input font-mono !text-[12.5px]"
              placeholder="Public client / native app registration"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-muted">Tenant</span>
            <input
              className="input font-mono !text-[12.5px]"
              placeholder="common · organizations · or a tenant GUID / domain"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="text-[12.5px] leading-relaxed text-subtle">
            The default client ID is a well-known public client that supports the loopback sign-in. If your tenant blocks
            it, register your own public client with redirect URI <code className="font-mono text-muted">http://localhost</code> and
            paste its ID here.
          </p>
        </div>
      </Card>
    </>
  );
}

/* ---------- About ---------- */

function AboutSection() {
  const u = useUpdater();
  const busy = u.status === "checking" || u.status === "downloading" || u.status === "installing";
  const line =
    u.status === "checking" ? "Checking for updates…"
    : u.status === "downloading" ? `Downloading ${u.version}${u.progress != null ? ` · ${Math.round(u.progress * 100)}%` : "…"}`
    : u.status === "ready" ? `Version ${u.version} is ready to install.`
    : u.status === "installing" ? "Restarting to update…"
    : u.status === "upToDate" ? "You're on the latest version."
    : u.status === "error" ? `Couldn't check for updates: ${u.error}`
    : u.checkedAt ? "You're on the latest version." : "Not checked yet in this session.";

  return (
    <>
      <Card>
        <div className="flex items-center gap-4 py-5">
          <Logo size={44} className="shrink-0 rounded-[10px]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold">Hexa Studio</span>
              {u.currentVersion && <span className="font-mono text-[12.5px] text-muted">v{u.currentVersion}</span>}
            </div>
            <div className="text-[12.5px] text-subtle">A desktop toolkit for Power Platform and Dataverse.</div>
          </div>
        </div>
      </Card>

      <Card title="Updates" description="Checked in the background when the app starts and every 4 hours.">
        <Row
          label={u.status === "ready" ? "Update ready" : "Current version"}
          description={
            <span className={`break-words ${u.status === "error" ? "text-danger" : ""}`} role="status">
              {line}
            </span>
          }
        >
          {u.status === "ready" ? (
            <button onClick={u.install} className="btn btn-primary btn-sm">
              Restart to update
            </button>
          ) : (
            <button onClick={u.checkNow} disabled={busy} className="btn btn-secondary btn-sm">
              {busy && <Loader size={12} />}
              Check for updates
            </button>
          )}
        </Row>
      </Card>
    </>
  );
}
