// Designer side panel: what one flow step does, readable — its inputs with
// expressions highlighted, what it runs after, what it reads and who reads it.
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { OutlineNode } from "../lib/flowOutline";
import {
  conditionLines,
  locationOf,
  parallelLoopAround,
  splitExpressions,
  tokenizeExpression,
  VARIABLE_WRITES,
  type FlowIndex,
  type VariableInfo,
} from "../lib/flowRefs";
import {
  choiceLabel,
  comparedHint,
  expressionHints,
  filterHints,
  parameterHint,
  stepTable,
  tablesFor,
  useChoices,
  type ChoiceHint,
  type ChoiceLabel,
  type NumberHint,
} from "../lib/flowChoices";
import { StepIcon } from "./StepIcon";
import { ArrowUpRight, Code, X } from "./Icon";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const pretty = (name: string) => name.replace(/_/g, " ");

interface Ctx {
  index: FlowIndex;
  /** Select another step by its name in the definition. */
  onSelectKey: (key: string) => void;
  /** The step shown, for labels of choice values it compares or writes. */
  step: OutlineNode;
  /** Its Dataverse table (`item/…` parameters, `$filter`). */
  table: string | null;
  choice: ChoiceLabel;
}

export type PanelTab = "parameters" | "settings" | "data";

const PANEL_TABS: [PanelTab, string][] = [
  ["parameters", "Parameters"],
  ["settings", "Settings"],
  ["data", "Data"],
];

interface Props {
  connId: string;
  index: FlowIndex;
  onSelectKey: (key: string) => void;
  step: OutlineNode;
  /** Kept by the designer so the same tab stays open while moving between steps. */
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  flowName: (flowId: string) => string | null;
  onOpenFlow: (flowId: string) => void;
  /** A "Run a Child Flow" step: whether the designer shows the child flow inside it. */
  inlined?: boolean;
  onToggleInline?: () => void;
  onShowInJson: () => void;
  onClose: () => void;
}

const STATUS_TONE: Record<string, string> = {
  Succeeded: "badge-success",
  Failed: "badge-danger",
  TimedOut: "badge-warning",
  Skipped: "badge-warning",
};

/** Keys shown in their own sections, not again under Settings. */
const SHOWN = new Set(["type", "kind", "inputs", "runAfter", "expression", "foreach", "limit", "metadata", "actions", "else", "cases", "default", "recurrence"]);

export function FlowStepPanel({
  connId,
  step,
  tab,
  onTab,
  index,
  onSelectKey,
  flowName,
  onOpenFlow,
  inlined,
  onToggleInline,
  onShowInJson,
  onClose,
}: Props) {
  // Labels next to choice values: load the options of the tables this step touches.
  const choiceTables = useChoices((s) => s.tables);
  const loadChoices = useChoices((s) => s.load);
  const tables = useMemo(() => tablesFor(step, index), [step, index]);
  useEffect(() => {
    for (const t of tables) loadChoices(connId, t);
  }, [connId, tables, loadChoices]);
  const table = useMemo(() => stepTable(step, index), [step, index]);
  const choice = useMemo(() => choiceLabel(choiceTables, connId), [choiceTables, connId]);
  const ctx: Ctx = { index, onSelectKey, step, table, choice };
  const raw = step.raw ?? {};
  const inputs = isObject(raw.inputs) ? raw.inputs : raw.inputs;
  const host = isObject(inputs) && isObject(inputs.host) ? inputs.host : null;
  const parameters = isObject(inputs) && host ? inputs.parameters : undefined;
  const otherInputs =
    isObject(inputs) && host
      ? Object.fromEntries(Object.entries(inputs).filter(([k]) => k !== "host" && k !== "parameters"))
      : inputs;
  const settings = Object.fromEntries(Object.entries(raw).filter(([k]) => !SHOWN.has(k)));
  const uses = index.uses.get(step.key) ?? [];
  const usedBy = index.usedBy.get(step.key) ?? [];
  const childName = step.childFlowId ? flowName(step.childFlowId) : null;
  const touched = index.stepVariables.get(step.key);
  // Declared here first, then changed here, then only read here.
  const variableNames = touched ? [...new Set([...touched.declares, ...touched.writes, ...touched.reads])] : [];
  const dataCount = variableNames.length + uses.length + usedBy.length;
  const hasOtherInputs = otherInputs !== undefined && !(isObject(otherInputs) && Object.keys(otherInputs).length === 0);
  const hasParameters =
    !!step.childFlowId ||
    raw.expression !== undefined ||
    raw.foreach !== undefined ||
    raw.recurrence !== undefined ||
    raw.limit !== undefined ||
    !!host ||
    parameters !== undefined ||
    hasOtherInputs;

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onTabKey = (e: KeyboardEvent) => {
    const at = PANEL_TABS.findIndex(([k]) => k === tab);
    const next =
      e.key === "ArrowRight" ? (at + 1) % PANEL_TABS.length
      : e.key === "ArrowLeft" ? (at + PANEL_TABS.length - 1) % PANEL_TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? PANEL_TABS.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    onTab(PANEL_TABS[next][0]);
    document.getElementById(`step-tab-${PANEL_TABS[next][0]}`)?.focus();
  };

  return (
    <aside className="flex h-full min-h-0 w-[400px] shrink-0 flex-col border-l border-line bg-s1" aria-label={`Step ${step.name}`}>
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
        <StepIcon step={step} size={34} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-snug break-words">{step.name}</div>
          <div className="mt-0.5 truncate text-xs text-subtle">
            {[step.type, step.childFlowId ? childName : step.detail].filter(Boolean).join(" · ")}
          </div>
        </div>
        <button
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onShowInJson}
          title={step.origin ? "Open the child flow at this step, in the JSON" : "Show this step in the JSON"}
          aria-label="Show in JSON"
        >
          <Code size={14} />
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="flex h-9 shrink-0 items-end gap-1 border-b border-line px-3" role="tablist" aria-label="Step details" onKeyDown={onTabKey}>
        {PANEL_TABS.map(([key, label]) => (
          <button
            key={key}
            id={`step-tab-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls="step-tabpanel"
            tabIndex={tab === key ? 0 : -1}
            className="tab h-9"
            onClick={() => onTab(key)}
          >
            {label}
            {key === "data" && dataCount > 0 && <span className="seg-count text-[11px]">{dataCount}</span>}
          </button>
        ))}
      </div>

      <div id="step-tabpanel" role="tabpanel" aria-labelledby={`step-tab-${tab}`} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {tab === "parameters" && (
          <>
            {step.childFlowId && (
              <Section title="Runs child flow">
                {childName ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className="badge badge-brand gap-1 hover:underline"
                      onClick={() => onOpenFlow(step.childFlowId!)}
                      title={`Open “${childName}” (Back returns here)`}
                    >
                      {childName}
                      <ArrowUpRight size={11} />
                    </button>
                    {onToggleInline && inlined !== undefined && (
                      <button className="btn btn-ghost btn-sm" onClick={onToggleInline}>
                        {inlined ? "Hide its steps" : "Show its steps here"}
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="font-mono text-xs text-subtle">{step.childFlowId} (not in this environment)</span>
                )}
              </Section>
            )}

            {step.actionType === "If" && raw.expression !== undefined && (
              <Section title="Condition">
                <Box>
                  <Condition expr={raw.expression} ctx={ctx} />
                </Box>
              </Section>
            )}
            {step.actionType === "Until" && raw.expression !== undefined && (
              <Section title="Until">
                <Box>
                  <Condition expr={raw.expression} ctx={ctx} />
                </Box>
              </Section>
            )}
            {step.actionType === "Switch" && (
              <Section title="Switch on">
                <Field value={raw.expression} ctx={ctx} />
                {isObject(raw.cases) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.values(raw.cases).map((c, i) =>
                      isObject(c) ? (
                        <span key={i} className="badge badge-neutral font-mono">
                          {JSON.stringify(c.case)}
                          <ChoiceChip hint={comparedHint(raw.expression, c.case, step, index, choice)} />
                        </span>
                      ) : null
                    )}
                  </div>
                )}
              </Section>
            )}
            {step.actionType === "Foreach" && (
              <Section title="For each item in">
                <Field value={raw.foreach} ctx={ctx} />
              </Section>
            )}
            {raw.recurrence !== undefined && (
              <Section title="Recurrence">
                <Field value={raw.recurrence} ctx={ctx} />
              </Section>
            )}
            {raw.limit !== undefined && (
              <Section title="Limit">
                <Field value={raw.limit} ctx={ctx} />
              </Section>
            )}

            {host && (
              <Section title="Operation">
                <Field
                  value={Object.fromEntries(
                    Object.entries(host).filter(([, v]) => typeof v === "string" && v !== "")
                  )}
                  ctx={ctx}
                />
              </Section>
            )}
            {parameters !== undefined && (
              <Section title="Parameters">
                <Field value={parameters} ctx={ctx} />
              </Section>
            )}
            {hasOtherInputs && (
              <Section title={step.childFlowId ? "Inputs to the child flow" : "Inputs"}>
                <Field value={step.childFlowId && isObject(otherInputs) ? otherInputs.body ?? otherInputs : otherInputs} ctx={ctx} />
              </Section>
            )}

            {!hasParameters && <Empty>This step takes no parameters.</Empty>}
          </>
        )}

        {tab === "settings" && (
          <>
            {step.kind !== "trigger" && (
              <Section title="Runs after">
                {Object.keys(step.after).length === 0 ? (
                  <span className="text-xs text-subtle">Nothing — runs first in its block</span>
                ) : (
                  <div className="space-y-1.5">
                    {Object.entries(step.after).map(([dep, statuses]) => (
                      <div key={dep} className="flex flex-wrap items-center gap-1.5">
                        <StepLink name={dep} ctx={ctx} />
                        {statuses.map((s) => (
                          <span key={s} className={`badge ${STATUS_TONE[s] ?? "badge-neutral"}`}>
                            {s.toLowerCase()}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {Object.keys(settings).length > 0 ? (
              <Section title="Settings">
                <Field value={settings} ctx={ctx} />
              </Section>
            ) : (
              <Empty>No other settings — this step uses the defaults.</Empty>
            )}
          </>
        )}

        {tab === "data" && (
          <>
            {variableNames.length > 0 && (
              <Section title="Variables">
                <div className="space-y-2.5">
                  {variableNames.map((name) => (
                    <VariableCard
                      key={name}
                      info={index.variableInfo.get(name)}
                      step={step}
                      roles={{
                        declares: touched!.declares.includes(name),
                        writes: touched!.writes.includes(name),
                        reads: touched!.reads.includes(name),
                      }}
                      ctx={ctx}
                    />
                  ))}
                </div>
              </Section>
            )}

            {uses.length > 0 && (
              <Section title="Reads">
                <div className="flex flex-wrap items-center gap-1.5">
                  {uses.map((k) => (
                    <StepLink key={k} name={k} ctx={ctx} />
                  ))}
                </div>
              </Section>
            )}
            {usedBy.length > 0 && (
              <Section title="Read by">
                <div className="flex flex-wrap items-center gap-1.5">
                  {usedBy.map((k) => (
                    <StepLink key={k} name={k} ctx={ctx} />
                  ))}
                </div>
              </Section>
            )}

            {dataCount === 0 && <Empty>No variables here, and no step's output is read here or reads this one.</Empty>}
          </>
        )}
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="eyebrow mb-2">{title}</h3>
      {children}
    </section>
  );
}

const SHOW_STEPS = 5;

/** One variable this step touches: where it's declared, changed and read. */
function VariableCard({
  info,
  step,
  roles,
  ctx,
}: {
  info: VariableInfo | undefined;
  step: OutlineNode;
  roles: { declares: boolean; writes: boolean; reads: boolean };
  ctx: Ctx;
}) {
  if (!info) return null;
  return (
    <div className="rounded-lg border border-line bg-s2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[12.5px] font-semibold text-warning">{info.name}</span>
        {info.type && <span className="badge badge-neutral font-mono !text-[10.5px]">{info.type}</span>}
        <span className="flex-1" />
        {roles.declares && <span className="badge badge-brand">declared here</span>}
        {roles.writes && <span className="badge badge-warning">{VARIABLE_WRITES[step.actionType] ?? "changed"} here</span>}
        {roles.reads && <span className="badge badge-info">read here</span>}
      </div>

      <div className="mt-2 space-y-2">
        <div>
          <div className="mb-1 text-[11px] font-medium text-subtle">Declared</div>
          {info.declared ? (
            <>
              <StepRow target={info.declared} current={step} ctx={ctx} />
              <div className="mt-1 flex items-baseline gap-2 pl-2 text-[12px]">
                <span className="shrink-0 text-subtle">initial value</span>
                {info.initial === undefined || info.initial === "" ? (
                  <span className="text-subtle italic">empty</span>
                ) : (
                  <Value value={info.initial} ctx={ctx} />
                )}
              </div>
            </>
          ) : (
            <span className="text-xs text-warning">Not declared in this flow</span>
          )}
        </div>

        <StepList
          title="Changed by"
          steps={info.writers}
          current={step}
          ctx={ctx}
          empty="Never changed after it's declared"
          badge={(w) => {
            const loop = parallelLoopAround(ctx.index, w);
            return (
              <>
                <span className="badge badge-neutral">{VARIABLE_WRITES[w.actionType] ?? "changes"}</span>
                {loop && (
                  <span
                    className="badge badge-warning"
                    title={`Inside “${loop.name}”, whose iterations run in parallel: the order of changes isn't predictable${
                      w.actionType === "SetVariable" ? ", and one iteration's value can overwrite another's" : ""
                    }.`}
                  >
                    parallel loop
                  </span>
                )}
              </>
            );
          }}
        />
        <StepList title="Read by" steps={info.readers} current={step} ctx={ctx} empty="Not read anywhere" />
      </div>
    </div>
  );
}

function StepList({
  title,
  steps,
  current,
  ctx,
  empty,
  badge,
}: {
  title: string;
  steps: OutlineNode[];
  current: OutlineNode;
  ctx: Ctx;
  empty: string;
  badge?: (step: OutlineNode) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? steps : steps.slice(0, SHOW_STEPS);
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-subtle">
        {title}
        {steps.length > 0 && <span className="ml-1 tabular-nums">({steps.length})</span>}
      </div>
      {steps.length === 0 ? (
        <span className="text-xs text-subtle">{empty}</span>
      ) : (
        <div className="space-y-0.5">
          {shown.map((s) => (
            <StepRow key={s.id} target={s} current={current} ctx={ctx} badge={badge?.(s)} />
          ))}
          {steps.length > SHOW_STEPS && (
            <button className="pl-2 text-xs text-brand hover:underline" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show ${steps.length - SHOW_STEPS} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A step elsewhere in the flow, with where it sits; picks it on click. */
function StepRow({ target, current, ctx, badge }: { target: OutlineNode; current: OutlineNode; ctx: Ctx; badge?: ReactNode }) {
  const here = target.id === current.id;
  const where = locationOf(ctx.index, target);
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${here ? "cursor-default bg-brand/10" : "hover:bg-s3"}`}
      onClick={() => !here && ctx.onSelectKey(target.key)}
      disabled={here}
      title={here ? "This step" : `Go to ${target.name}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px]">
          {target.name}
          {here && <span className="ml-1.5 text-[11px] text-brand">(this step)</span>}
        </span>
        <span className="block truncate text-[11px] text-subtle">{where ? `in ${where}` : "top level"}</span>
      </span>
      {badge && <span className="flex shrink-0 gap-1">{badge}</span>}
    </button>
  );
}

function StepLink({ name, ctx }: { name: string; ctx: Ctx }) {
  const known = ctx.index.byKey.has(name);
  return known ? (
    <button className="badge badge-neutral max-w-full hover:text-fg hover:underline" onClick={() => ctx.onSelectKey(name)} title={`Go to ${pretty(name)}`}>
      <span className="truncate">{pretty(name)}</span>
    </button>
  ) : (
    <span className="badge badge-neutral max-w-full opacity-70" title={pretty(name)}>
      <span className="truncate">{pretty(name)}</span>
    </span>
  );
}

function Condition({ expr, ctx }: { expr: unknown; ctx: Ctx }) {
  const lines = conditionLines(expr);
  if (lines.length === 0) return <Value value={expr} ctx={ctx} />;
  return (
    <div className="space-y-1.5 text-[12.5px]">
      {lines.map((l, i) => (
        <div key={i} style={{ paddingLeft: l.depth * 14 }} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          {l.group ? (
            <span className="badge badge-brand">{l.group}</span>
          ) : (
            <>
              <Text value={l.left ?? ""} ctx={ctx} />
              <ChoiceChip hint={comparedHint(l.right, l.left, ctx.step, ctx.index, ctx.choice)} />
              {l.op && <span className="text-subtle">{l.op}</span>}
              {l.right !== undefined && <Text value={l.right} ctx={ctx} />}
              <ChoiceChip hint={comparedHint(l.left, l.right, ctx.step, ctx.index, ctx.choice)} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Any JSON value, as key/value rows; strings get expression highlighting. */
function Value({ value, ctx, depth = 0, field }: { value: unknown; ctx: Ctx; depth?: number; field?: string }) {
  if (value === undefined) return <span className="text-xs text-subtle">—</span>;
  if (value === null) return <span className="font-mono text-[12px] text-subtle">null</span>;
  if (value === "") return <span className="text-xs text-subtle italic">empty</span>;
  // A choice column written by a Dataverse step: `item/statuscode` = 2.
  const written = field ? parameterHint(field, value, ctx.table, ctx.choice) : null;
  if (typeof value === "string") {
    return (
      <>
        <Text value={value} ctx={ctx} filter={field === "$filter"} />
        <ChoiceChip hint={written} />
      </>
    );
  }
  if (typeof value === "number") {
    return (
      <>
        <span className="font-mono text-[12px] text-num">{value}</span>
        <ChoiceChip hint={written} />
      </>
    );
  }
  if (typeof value === "boolean") return <span className="font-mono text-[12px] text-bool">{String(value)}</span>;
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i + 1), v])
    : Object.entries(value as Json);
  if (entries.length === 0) {
    return <span className="font-mono text-[12px] text-subtle">{Array.isArray(value) ? "[ ]" : "{ }"}</span>;
  }
  // Each key is a label with its value in a box under it, like a read-only form field;
  // nested objects indent their own fields.
  return (
    <div className={`space-y-3 ${depth > 0 ? "border-l border-line pl-3" : ""}`}>
      {entries.map(([k, v]) => {
        const nested = typeof v === "object" && v !== null && Object.keys(v).length > 0;
        return (
          <div key={k}>
            <div className="mb-1 font-mono text-[11.5px] text-subtle [overflow-wrap:anywhere]">{Array.isArray(value) ? `#${k}` : k}</div>
            {nested ? <Value value={v} ctx={ctx} depth={depth + 1} /> : <Box><Value value={v} ctx={ctx} depth={depth + 1} field={Array.isArray(value) ? undefined : k} /></Box>}
          </div>
        );
      })}
    </div>
  );
}

/** A section's value: objects become labelled fields, a single value gets one box. */
function Field({ value, ctx }: { value: unknown; ctx: Ctx }) {
  const nested = typeof value === "object" && value !== null && Object.keys(value).length > 0;
  return nested ? <Value value={value} ctx={ctx} /> : <Box><Value value={value} ctx={ctx} /></Box>;
}

/** The read-only "input" a value sits in. */
function Box({ children }: { children: ReactNode }) {
  return <div className="min-h-[32px] rounded-md border border-line bg-s2 px-2.5 py-1.5 [overflow-wrap:anywhere]">{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-xs text-subtle">{children}</div>;
}

const LONG = 360;

/** A choice value's label, after the number. */
function ChoiceChip({ hint }: { hint: ChoiceHint | null }) {
  if (!hint) return null;
  return (
    <span className="ml-1 rounded border border-line bg-s1 px-1 font-sans text-[11px] font-medium text-fg" title={hint.title}>
      {hint.label}
    </span>
  );
}

/** `text` (starting at `at` in its string) with a label after each hinted number. */
function withHints(text: string, at: number, hints: NumberHint[]): ReactNode {
  const inside = hints.filter((h) => h.at >= at && h.at + h.length <= at + text.length);
  if (inside.length === 0) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const h of inside) {
    const end = h.at - at + h.length;
    out.push(text.slice(last, end), <ChoiceChip key={h.at} hint={h} />);
    last = end;
  }
  out.push(text.slice(last));
  return out;
}

/** A clickable name inside an expression. A span, not a <button>: buttons lay out as
 *  inline-block, so a long step name could not wrap and ran out of the box. */
function InlineLink({ className, onClick, title, children }: { className: string; onClick: () => void; title: string; children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={`cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${className}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={title}
    >
      {children}
    </span>
  );
}

/** A string value: literal text plus highlighted `@…` / `@{…}` expressions. */
function Text({ value, ctx, filter }: { value: string; ctx: Ctx; filter?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = value.length > LONG;
  const parts = splitExpressions(long && !open ? value.slice(0, LONG) : value);
  // Choice labels: numbers compared to a column in an expression; in `$filter` text, `statecode eq 0`.
  const hints = parts.map((p) =>
    p.kind === "expr" ? expressionHints(p.text, ctx.step, ctx.index, ctx.choice) : filter ? filterHints(p.text, ctx.table, ctx.choice) : []
  );
  return (
    <span className="text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{withHints(p.text, 0, hints[i])}</span>
        ) : (
          <code key={i} className="box-decoration-clone rounded bg-brand/10 px-1 py-px font-mono text-[11.5px]">
            {tokenizeExpression(p.text).map((t, j, all) => {
              if (t.kind === "fn") return <span key={j} className="text-brand">{t.text}</span>;
              if (t.kind === "string") return <span key={j} className="text-success">{t.text}</span>;
              if (t.kind === "step" && ctx.index.byKey.has(t.name)) {
                return (
                  <InlineLink key={j} className="text-info" onClick={() => ctx.onSelectKey(t.name)} title={`Go to ${pretty(t.name)}`}>
                    {t.text}
                  </InlineLink>
                );
              }
              if (t.kind === "variable" && ctx.index.variables.has(t.name.toLowerCase())) {
                const decl = ctx.index.variables.get(t.name.toLowerCase())!;
                return (
                  <InlineLink key={j} className="text-warning" onClick={() => ctx.onSelectKey(decl.key)} title={`Declared in ${decl.name}`}>
                    {t.text}
                  </InlineLink>
                );
              }
              const at = all.slice(0, j).reduce((n, x) => n + x.text.length, 0);
              return <span key={j}>{withHints(t.text, at, hints[i])}</span>;
            })}
          </code>
        )
      )}
      {long && (
        <>
          {!open && "…"}{" "}
          <button className="text-xs text-brand hover:underline" onClick={() => setOpen(!open)}>
            {open ? "Show less" : `Show all (${value.length.toLocaleString()} chars)`}
          </button>
        </>
      )}
    </span>
  );
}
