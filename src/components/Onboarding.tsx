import { useEffect, useMemo, useState } from "react";
import { useStore, activeProjectOf } from "../store";
import { ROUTES } from "../lib/navigation";
import { guessTag, PRESET_COLORS, TAG_COLORS, TAG_PRESETS, tagStyle } from "../lib/tags";
import { Logo } from "./Logo";
import { TagBadge } from "./TagBadge";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bug,
  Check,
  Code,
  Database,
  Send,
  Flow,
  Folder,
  Globe,
  Link,
  Loader,
  LogIn,
  Moon,
  Plus,
  Search,
  Shield,
  Sun,
} from "./Icon";
import type { Connection, Environment } from "../types";

/** Set once the setup guide was finished or skipped; it then only opens from the palette. */
const DONE_KEY = "cds.onboarded";

/** Show the guide on start: never finished/skipped and no environment saved yet. */
export function shouldOnboard(connections: Connection[]): boolean {
  try {
    if (localStorage.getItem(DONE_KEY) === "1") return false;
  } catch {
    // Storage unavailable: fall back to "has anything been set up?".
  }
  return connections.length === 0;
}

/** Before `init` finishes: likely a first start (nothing remembered), so hold the app back. */
export function maybeFirstStart(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) !== "1" && !localStorage.getItem("cds.activeConnectionId");
  } catch {
    return false;
  }
}

function markDone() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    // Only means the guide shows again next start.
  }
}

const STEPS = ["Welcome", "Project", "Sign in", "Environments", "Ready"] as const;
type Step = 0 | 1 | 2 | 3 | 4;

const TOOLS = [
  { icon: Code, name: "SQL", text: "Query tables with SQL. Writes show a preview before anything changes." },
  { icon: Send, name: "Web API", text: "Build Web API requests (OData, FetchXML, functions) and copy them as code." },
  { icon: Flow, name: "Power Automate", text: "Read cloud flows as a diagram, check them out and review edits." },
  { icon: Bug, name: "Monitoring", text: "Plug-in trace logs, system jobs and failed flow runs in one place." },
  { icon: Shield, name: "Configuration", text: "Plug-in steps, dependencies and security roles, read-only." },
  { icon: Globe, name: "Customization", text: "Edit, compare and publish web resources." },
];

/**
 * First-run setup, full window: project → Microsoft sign-in → environments.
 * Each step drives the same store actions as the regular dialogs, so leaving
 * half-way keeps whatever was already set up.
 */
export function Onboarding({ onClose }: { onClose: (route?: string) => void }) {
  const project = useStore(activeProjectOf);
  const allConnections = useStore((s) => s.connections);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const connections = useMemo(
    () => allConnections.filter((c) => c.projectId === project?.id),
    [allConnections, project?.id]
  );

  const [step, setStep] = useState<Step>(0);
  const signedIn = !!project?.username;
  // Furthest step the current setup allows (later steps need the earlier ones).
  const reachable: Step = !project ? 1 : !signedIn ? 2 : connections.length === 0 ? 3 : 4;

  const finish = (route?: string) => {
    markDone();
    onClose(route);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex bg-bg text-fg"
      role="dialog"
      aria-modal="true"
      aria-label="Set up Hexa Studio"
    >
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-s1 px-5 py-6">
        <div className="flex items-center gap-2.5">
          <Logo size={30} />
          <span className="text-[15px] font-semibold tracking-tight">Hexa Studio</span>
        </div>

        <ol className="mt-10 space-y-1" aria-label="Setup steps">
          {STEPS.map((label, i) => {
            const current = i === step;
            const done = i < reachable && !current;
            const enabled = i <= reachable;
            return (
              <li key={label}>
                <button
                  onClick={() => setStep(i as Step)}
                  disabled={!enabled}
                  aria-current={current ? "step" : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${
                    current
                      ? "bg-brand/10 font-semibold text-fg"
                      : enabled
                        ? "text-muted hover:bg-s3 hover:text-fg"
                        : "cursor-default text-subtle"
                  }`}
                >
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums ${
                      current
                        ? "bg-brand-solid text-white"
                        : done
                          ? "bg-success/15 text-success"
                          : "bg-s3 text-subtle ring-1 ring-inset ring-line"
                    }`}
                  >
                    {done ? <Check size={12} strokeWidth={3} /> : i + 1}
                  </span>
                  {label}
                </button>
              </li>
            );
          })}
        </ol>

        <div className="mt-auto space-y-3">
          <p className="text-xs leading-relaxed text-subtle">
            Everything stays on this PC. Sign-ins are kept in Windows Credential Manager.
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleTheme}
              className="btn btn-ghost btn-sm btn-icon"
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button onClick={() => finish()} className="btn btn-ghost btn-sm ml-auto">
              {reachable === 4 ? "Close" : "Skip for now"}
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div key={step} className="fade-in mx-auto flex min-h-full max-w-[640px] flex-col justify-center px-10 py-10">
          {step === 0 && <WelcomeStep onNext={() => setStep(reachable === 4 ? 1 : reachable)} />}
          {step === 1 && <ProjectStep onBack={() => setStep(0)} onNext={() => setStep(2)} />}
          {step === 2 && <SignInStep onBack={() => setStep(1)} onNext={() => setStep(3)} />}
          {step === 3 && <EnvironmentsStep onBack={() => setStep(2)} onNext={() => setStep(4)} />}
          {step === 4 && <ReadyStep onBack={() => setStep(3)} onFinish={finish} />}
        </div>
      </main>
    </div>
  );
}

/* ---------- shared bits ---------- */

function StepHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="mb-7">
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="mt-1.5 text-[26px] font-semibold leading-8 tracking-tight">{title}</h1>
      {children && <p className="mt-2 text-[14px] leading-relaxed text-muted">{children}</p>}
    </header>
  );
}

function Footer({
  onBack,
  children,
}: {
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-8 flex items-center gap-2">
      {onBack && (
        <button onClick={onBack} className="btn btn-ghost">
          <ArrowLeft size={14} /> Back
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/* ---------- 1. Welcome ---------- */

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <Logo size={56} className="mb-6 drop-shadow-lg" />
      <StepHeader eyebrow="Welcome" title="Your toolbox for Dataverse and Power Platform">
        Query data, read flows, chase plug-in errors and ship web resources — against any
        environment you can sign in to. Setup takes about a minute.
      </StepHeader>

      <ul className="grid grid-cols-2 gap-2.5">
        {TOOLS.map(({ icon: Icon, name, text }) => (
          <li key={name} className="card flex gap-3 p-3.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
              <Icon size={16} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">{name}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{text}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-line bg-s2 px-3.5 py-3 text-xs leading-relaxed text-muted">
        <Shield size={14} className="mt-0.5 shrink-0 text-subtle" />
        <span>
          You'll need a Microsoft work account with access to at least one Power Platform environment.
          Hexa Studio only does what your account is already allowed to do.
        </span>
      </div>

      <Footer>
        <button onClick={onNext} className="btn btn-primary" autoFocus>
          Get started
        </button>
      </Footer>
    </>
  );
}

/* ---------- 2. Project ---------- */

function ProjectStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const createProject = useStore((s) => s.createProject);
  const requestProjectSwitch = useStore((s) => s.requestProjectSwitch);

  const [creating, setCreating] = useState(projects.length === 0);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("violet");
  const [advanced, setAdvanced] = useState(false);
  const [tenant, setTenant] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const created = await createProject(name.trim(), tenant.trim(), clientId.trim(), color);
    setBusy(false);
    if (created) onNext();
  };

  return (
    <>
      <StepHeader eyebrow="Step 1 of 3" title="Create a project">
        A project holds one Microsoft account and the environments it reaches — make one per
        customer or tenant. You can add more later from the top bar.
      </StepHeader>

      {projects.length > 0 && (
        <div className="mb-6">
          <div className="mb-2 text-xs font-medium text-muted">Continue with a project you have</div>
          <ul className="space-y-1.5">
            {projects.map((p) => {
              const active = p.id === activeProjectId && !creating;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      setCreating(false);
                      requestProjectSwitch(p.id);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                      active ? "border-brand/60 bg-brand/8" : "border-line bg-s2 hover:border-line-strong hover:bg-s3"
                    }`}
                  >
                    <Folder size={16} className={tagStyle(p.color).text} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{p.name}</span>
                      <span className="block truncate text-xs text-subtle">{p.username ?? "Not signed in"}</span>
                    </span>
                    {active && <Check size={15} className="text-brand" strokeWidth={2.5} />}
                  </button>
                </li>
              );
            })}
          </ul>
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand underline-offset-2 hover:underline"
            >
              <Plus size={13} /> New project instead
            </button>
          )}
        </div>
      )}

      {creating && (
        <div className="card space-y-5 p-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Project name</span>
            <input
              className="input"
              placeholder="e.g. Contoso, Fabrikam, Internal"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </label>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Colour</span>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Project colour">
              {TAG_COLORS.map((c) => {
                const selected = color === c;
                return (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={selected}
                    title={c}
                    onClick={() => setColor(c)}
                    className={`grid h-7 w-7 place-items-center rounded-full ${tagStyle(c).dot} transition hover:scale-110 ${
                      selected ? "ring-2 ring-fg/70 ring-offset-2 ring-offset-s1" : ""
                    }`}
                  >
                    {selected && <Check size={13} className="text-white" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <button
              onClick={() => setAdvanced((a) => !a)}
              className="text-xs font-medium text-muted underline-offset-2 hover:underline"
              aria-expanded={advanced}
            >
              {advanced ? "Hide" : "Show"} sign-in options
            </button>
            {advanced && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted">Tenant (optional)</span>
                  <input
                    className="input"
                    placeholder="Tenant GUID or domain"
                    value={tenant}
                    onChange={(e) => setTenant(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted">Client ID (optional)</span>
                  <input
                    className="input"
                    placeholder="Your own app registration"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                </label>
                <p className="col-span-2 text-xs leading-relaxed text-subtle">
                  Leave both empty to use the defaults. Pin a tenant when the account belongs to
                  several directories.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <Footer onBack={onBack}>
        {creating ? (
          <button onClick={create} disabled={busy || !name.trim()} className="btn btn-primary">
            {busy && <Loader size={14} />} Create project
          </button>
        ) : (
          <button onClick={onNext} disabled={!activeProjectId} className="btn btn-primary">
            Continue
          </button>
        )}
      </Footer>
    </>
  );
}

/* ---------- 3. Sign in ---------- */

function SignInStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const project = useStore(activeProjectOf);
  const signIn = useStore((s) => s.signIn);
  const signingIn = useStore((s) => s.signingIn);
  const cancelSignIn = useStore((s) => s.cancelSignIn);
  const authError = useStore((s) => s.authError);

  if (!project) return null;
  const tag = tagStyle(project.color);

  const start = async () => {
    if (await signIn(project.id)) onNext();
  };

  return (
    <>
      <StepHeader eyebrow="Step 2 of 3" title={`Sign in to ${project.name}`}>
        Your browser opens the Microsoft sign-in page. Use the account that can reach this
        customer's environments.
      </StepHeader>

      <div className="card flex flex-col items-center px-6 py-9 text-center">
        <span className={`grid h-12 w-12 place-items-center rounded-xl bg-s3 ring-1 ring-inset ring-line ${tag.text}`}>
          <Folder size={22} />
        </span>
        <div className="mt-3 text-[15px] font-semibold">{project.name}</div>

        {project.username ? (
          <>
            <span className="badge badge-success badge-dot mt-3">Signed in as {project.username}</span>
          </>
        ) : signingIn ? (
          <div className="mt-5 flex flex-col items-center gap-2" role="status">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Loader size={14} className="text-brand" /> Waiting for the browser…
            </div>
            <p className="text-xs text-subtle">Finish signing in there. Closed the tab? Cancel and try again.</p>
            <button onClick={cancelSignIn} className="btn btn-secondary btn-sm mt-1">
              Cancel
            </button>
          </div>
        ) : (
          <>
            <p className="mt-1 text-xs text-subtle">Not signed in yet</p>
            <button onClick={start} className="btn btn-primary mt-5" autoFocus>
              <LogIn size={14} /> Sign in with Microsoft
            </button>
          </>
        )}

        {authError && !signingIn && !project.username && (
          <div className="mt-5 flex w-full items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-left text-xs text-danger">
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{authError}</span>
          </div>
        )}
      </div>

      <Footer onBack={onBack}>
        <button onClick={onNext} disabled={!project.username} className="btn btn-primary">
          Continue
        </button>
      </Footer>
    </>
  );
}

/* ---------- 4. Environments ---------- */

function EnvironmentsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const project = useStore(activeProjectOf);
  const environments = useStore((s) => s.environments);
  const loadingEnvs = useStore((s) => s.loadingEnvs);
  const envError = useStore((s) => s.envError);
  const loadEnvironments = useStore((s) => s.loadEnvironments);
  const saveConnection = useStore((s) => s.saveConnection);
  const updateConnection = useStore((s) => s.updateConnection);
  const setActive = useStore((s) => s.setActive);
  const allConnections = useStore((s) => s.connections);

  const added = useMemo(
    () => new Set(allConnections.filter((c) => c.projectId === project?.id).map((c) => c.host.toLowerCase())),
    [allConnections, project?.id]
  );

  // Environment id → tag ("" = none). Present = selected.
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [query, setQuery] = useState("");
  const [byUrl, setByUrl] = useState(false);
  const [url, setUrl] = useState("https://");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    if (project?.username && environments.length === 0 && !loadingEnvs) void loadEnvironments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.username]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return environments.filter((e) => {
      const hay = `${e.friendlyName} ${e.urlName} ${e.host}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [environments, query]);

  const toggle = (env: Environment) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(env.id)) next.delete(env.id);
      else next.set(env.id, guessTag(`${env.friendlyName} ${env.urlName}`) ?? "");
      return next;
    });

  const setTag = (id: string, tag: string) =>
    setPicked((m) => new Map(m).set(id, tag));

  const add = async () => {
    setBusy(true);
    setFailed([]);
    const misses: string[] = [];
    let first: string | null = null;
    const targets: { url: string; name: string; tag: string }[] = byUrl
      ? [{ url: url.trim(), name: "", tag: "" }]
      : environments
          .filter((e) => picked.has(e.id))
          .map((e) => ({ url: e.url, name: e.friendlyName, tag: picked.get(e.id) ?? "" }));
    for (const t of targets) {
      const conn = await saveConnection(t.url, t.name);
      if (!conn) {
        misses.push(t.name || t.url);
        continue;
      }
      first ??= conn.id;
      if (t.tag) await updateConnection(conn.id, conn.name, t.tag, PRESET_COLORS[t.tag] ?? "slate");
    }
    // Each save switches to the new environment; land on the first one picked.
    if (first) setActive(first);
    setBusy(false);
    if (misses.length) setFailed(misses);
    else onNext();
  };

  const count = byUrl ? (/^https:\/\/[^/\s]+\.\S+/.test(url.trim()) ? 1 : 0) : picked.size;
  const hasSome = added.size > 0;

  return (
    <>
      <StepHeader eyebrow="Step 3 of 3" title="Pick your environments">
        These are the environments <span className="font-medium text-fg">{project?.username}</span> can
        reach. Tag production ones PROD so Hexa Studio warns you before writing to them.
      </StepHeader>

      {byUrl ? (
        <div className="card space-y-3 p-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Environment URL</span>
            <input
              className="input font-mono"
              placeholder="https://org12345.crm.dynamics.com"
              value={url}
              autoFocus
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && count && add()}
            />
          </label>
          <p className="text-xs text-subtle">Use this when an environment doesn't show up in the list.</p>
        </div>
      ) : loadingEnvs ? (
        <ul className="space-y-1.5" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 rounded-lg border border-line px-3 py-3">
              <div className="skeleton h-4 w-4" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3 w-1/3" />
                <div className="skeleton h-2.5 w-1/2" />
              </div>
            </li>
          ))}
        </ul>
      ) : envError ? (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span className="flex-1">{envError}</span>
          <button onClick={loadEnvironments} className="shrink-0 font-medium underline">
            Retry
          </button>
        </div>
      ) : environments.length === 0 ? (
        <div className="card px-6 py-10 text-center">
          <div className="empty-icon">
            <Database size={20} />
          </div>
          <p className="mt-3 text-sm text-muted">No environments found for this account.</p>
          <p className="mt-1 text-xs text-subtle">Try another account, or add one by its URL.</p>
        </div>
      ) : (
        <>
          {environments.length > 6 && (
            <div className="relative mb-2.5">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
              <input
                className="input !pl-8"
                placeholder={`Filter ${environments.length} environments`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter environments"
              />
            </div>
          )}
          <ul className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">
            {shown.map((env) => {
              const isAdded = added.has(env.host.toLowerCase());
              const selected = picked.has(env.id);
              const tag = picked.get(env.id) ?? "";
              return (
                <li
                  key={env.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
                    selected ? "border-brand/50 bg-brand/8" : "border-line bg-s2"
                  } ${isAdded ? "opacity-70" : ""}`}
                >
                  <label className={`flex min-w-0 flex-1 items-center gap-3 ${isAdded ? "" : "cursor-pointer"}`}>
                    <input
                      type="checkbox"
                      checked={selected || isAdded}
                      disabled={isAdded}
                      onChange={() => toggle(env)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{env.friendlyName || env.urlName}</span>
                      <span className="block truncate font-mono text-xs text-subtle">{env.host}</span>
                    </span>
                  </label>
                  {env.state && env.state !== "Ready" && <span className="badge badge-neutral">{env.state}</span>}
                  {isAdded ? (
                    <span className="badge badge-success">Added</span>
                  ) : (
                    selected && (
                      <span className="flex shrink-0 items-center gap-1.5">
                        {tag && <TagBadge connection={{ tag, color: PRESET_COLORS[tag] ?? "slate" }} />}
                        <select
                          className="input !h-7 !w-[92px] !py-0 !text-xs"
                          value={tag}
                          onChange={(e) => setTag(env.id, e.target.value)}
                          aria-label={`Tag for ${env.friendlyName}`}
                        >
                          <option value="">No tag</option>
                          {TAG_PRESETS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </span>
                    )
                  )}
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="py-6 text-center text-sm text-subtle">Nothing matches “{query}”.</li>
            )}
          </ul>
        </>
      )}

      {failed.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span>Couldn't add {failed.join(", ")}. Check the URL and that this account can open it.</span>
        </div>
      )}

      <button
        onClick={() => {
          setByUrl((b) => !b);
          setFailed([]);
        }}
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-brand underline-offset-2 hover:underline"
      >
        {byUrl ? (
          <>
            <Link size={13} /> Pick from the list instead
          </>
        ) : (
          <>
            <Plus size={13} /> Add by URL instead
          </>
        )}
      </button>

      <Footer onBack={onBack}>
        {hasSome && count === 0 ? (
          <button onClick={onNext} className="btn btn-primary">
            Continue
          </button>
        ) : (
          <button onClick={add} disabled={busy || count === 0} className="btn btn-primary">
            {busy && <Loader size={14} />}
            {count > 1 ? `Add ${count} environments` : "Add environment"}
          </button>
        )}
      </Footer>
    </>
  );
}

/* ---------- 5. Ready ---------- */

function ReadyStep({ onBack, onFinish }: { onBack: () => void; onFinish: (route?: string) => void }) {
  const project = useStore(activeProjectOf);
  const activeId = useStore((s) => s.activeId);
  const allConnections = useStore((s) => s.connections);
  const runKey = useStore((s) => s.keybindings.run[0]);
  const connections = allConnections.filter((c) => c.projectId === project?.id);

  const jumps = [
    { icon: Code, label: "Write a SQL query", route: ROUTES.query },
    { icon: Send, label: "Build a Web API request", route: ROUTES.rest },
    { icon: Flow, label: "Browse cloud flows", route: ROUTES.flows },
    { icon: Activity, label: "Check failed jobs", route: ROUTES.jobs },
  ];

  return (
    <>
      <span className="mb-5 grid h-12 w-12 place-items-center rounded-full bg-success/15 text-success">
        <Check size={24} strokeWidth={2.5} />
      </span>
      <StepHeader eyebrow="All set" title="You're ready to go">
        Queries run against the environment shown in the top bar. Switching always asks first.
      </StepHeader>

      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Folder size={16} className={tagStyle(project?.color).text} />
          <span className="text-sm font-semibold">{project?.name}</span>
          <span className="ml-auto truncate text-xs text-subtle">{project?.username}</span>
        </div>
        <ul className="divide-y divide-line">
          {connections.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <Database size={14} className="shrink-0 text-subtle" />
              <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
              <TagBadge connection={c} />
              {c.id === activeId && <span className="badge badge-brand">Opens first</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2">
        {jumps.map(({ icon: Icon, label, route }) => (
          <button
            key={route}
            onClick={() => onFinish(route)}
            className="flex items-center gap-3 rounded-lg border border-line bg-s2 px-3.5 py-3 text-left text-sm font-medium transition hover:border-brand/50 hover:bg-brand/8"
          >
            <Icon size={16} className="shrink-0 text-brand" />
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="kbd">Ctrl</span>
          <span className="kbd">K</span> Search anything
        </span>
        {runKey && (
          <span className="flex items-center gap-1.5">
            {runKey.split("+").map((k) => (
              <span key={k} className="kbd">
                {k}
              </span>
            ))}{" "}
            Run query
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="kbd">Ctrl</span>
          <span className="kbd">B</span> Toggle sidebar
        </span>
      </div>

      <Footer onBack={onBack}>
        <button onClick={() => onFinish(ROUTES.overview)} className="btn btn-primary" autoFocus>
          Open Hexa Studio
        </button>
      </Footer>
    </>
  );
}
