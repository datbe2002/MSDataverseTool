// Icon of a flow step in the Designer: a glyph for built-in steps, the
// connector's initials for connector steps (the app ships no connector logos).
import type { OutlineNode } from "../lib/flowOutline";

/** Tone per kind of step; each is a design token (see styles.css). */
const TONES = ["brand", "info", "success", "warning", "danger", "num", "bool"] as const;
type Tone = (typeof TONES)[number];

const CONNECTOR_INITIALS: Record<string, string> = {
  sharepointonline: "SP",
  office365: "OL",
  office365users: "OU",
  office365groups: "OG",
  commondataserviceforapps: "DV",
  commondataservice: "DV",
  teams: "TM",
  onedriveforbusiness: "OD",
  onedrive: "OD",
  keyvault: "KV",
  excelonlinebusiness: "XL",
  approvals: "AP",
  sql: "SQ",
  azureblob: "AB",
  webcontents: "WC",
  flowpush: "FP",
  powerbi: "BI",
  outlook: "OL",
  wordonlinebusiness: "WD",
  planner: "PL",
  azureopenai: "AI",
  aibuilder: "AI",
  sendmail: "SM",
  conversionservice: "CV",
  rss: "RS",
};

/** Connector name of a step ("sharepointonline"), from its `detail`. */
export function connectorOf(step: OutlineNode): string | null {
  if (step.kind !== "connector" && step.kind !== "trigger") return null;
  if (!step.detail || step.actionType === "Http" || step.actionType === "HttpWebhook") return null;
  const name = step.detail.split(" · ")[0];
  return /^[a-z0-9_]+$/i.test(name) ? name.toLowerCase() : null;
}

function toneOf(name: string): Tone {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

const GLYPHS: Record<string, string> = {
  If: "M12 3.5 20.5 12 12 20.5 3.5 12Z",
  Switch: "M4 12h5M9 12l4-6h7M9 12l4 6h7",
  Foreach: "M17 3l3 3-3 3M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M7 21l-3-3 3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4",
  Until: "M17 3l3 3-3 3M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M7 21l-3-3 3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4",
  Scope: "M8 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21H8M16 3h1.5A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5H16",
  Compose: "M8 3a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2M16 3a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2",
  Http: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z",
  Response: "M9 14 4 9l5-5M4 9h10.5A5.5 5.5 0 0 1 20 14.5V20",
  Workflow: "M3 3h6v6H3zM15 15h6v6h-6zM9 6h5a3 3 0 0 1 3 3v6",
  Wait: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2",
  Terminate: "M7 7h10v10H7z",
  Recurrence: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2",
  Trigger: "M13 2 4 14h7l-1 8 9-12h-7Z",
  Query: "M4 5h16l-6 7v6l-4 2v-8Z",
  Select: "M4 6h16M4 12h10M4 18h6",
  Table: "M4 4h16v16H4zM4 10h16M10 4v16",
  Join: "M6 6h12M6 12h12M6 18h12",
  ParseJson: "M8 3a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2M16 3a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2M10 12h4",
};

const BUILT_IN_TONE: Record<string, Tone> = {
  trigger: "brand",
  control: "info",
  variable: "warning",
  data: "num",
  connector: "success",
  other: "bool",
};

export function StepIcon({ step, size = 32 }: { step: OutlineNode; size?: number }) {
  const connector = connectorOf(step);
  const glyph =
    !connector &&
    (step.kind === "trigger" && !GLYPHS[step.actionType]
      ? GLYPHS.Trigger
      : GLYPHS[step.actionType] ?? (step.kind === "variable" ? null : GLYPHS.Compose));
  const tone: Tone = connector ? toneOf(connector) : BUILT_IN_TONE[step.kind] ?? "bool";
  const style = {
    width: size,
    height: size,
    color: `var(--${tone})`,
    background: `color-mix(in oklab, var(--${tone}) 15%, transparent)`,
  };
  return (
    <span className="grid shrink-0 place-items-center rounded-lg" style={style} aria-hidden="true">
      {connector ? (
        <span className="font-mono text-[11px] font-semibold tracking-tight">
          {CONNECTOR_INITIALS[connector] ?? connector.slice(0, 2).toUpperCase()}
        </span>
      ) : glyph ? (
        <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d={glyph} />
        </svg>
      ) : (
        <span className="font-mono text-[12px] font-semibold">{"{x}"}</span>
      )}
    </span>
  );
}
