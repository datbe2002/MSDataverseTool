// Designer side panel: what one flow step does, readable — its inputs with
// expressions highlighted, what it runs after, what it reads and who reads it.
import { useState, type ReactNode } from "react";
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
import { StepIcon } from "./StepIcon";
import { ArrowUpRight, Code, X } from "./Icon";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const pretty = (name: string) => name.replace(/_/g, " ");

interface Ctx {
  index: FlowIndex;
  /** Select another step by its name in the definition. */
  onSelectKey: (key: string) => void;
}

interface Props extends Ctx {
  step: OutlineNode;
  flowName: (flowId: string) => string | null;
  onOpenFlow: (flowId: string) => void;
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

export function FlowStepPanel({ step, index, onSelectKey, flowName, onOpenFlow, onShowInJson, onClose }: Props) {
  const ctx: Ctx = { index, onSelectKey };
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
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onShowInJson} title="Show this step in the JSON" aria-label="Show in JSON">
          <Code size={14} />
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {step.childFlowId && (
          <Section title="Runs child flow">
            {childName ? (
              <button className="badge badge-brand gap-1 hover:underline" onClick={() => onOpenFlow(step.childFlowId!)}>
                {childName}
                <ArrowUpRight size={11} />
              </button>
            ) : (
              <span className="font-mono text-xs text-subtle">{step.childFlowId} (not in this environment)</span>
            )}
          </Section>
        )}

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

        {step.actionType === "If" && raw.expression !== undefined && (
          <Section title="Condition">
            <Condition expr={raw.expression} ctx={ctx} />
          </Section>
        )}
        {step.actionType === "Until" && raw.expression !== undefined && (
          <Section title="Until">
            <Condition expr={raw.expression} ctx={ctx} />
          </Section>
        )}
        {step.actionType === "Switch" && (
          <Section title="Switch on">
            <Value value={raw.expression} ctx={ctx} />
            {isObject(raw.cases) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.values(raw.cases).map((c, i) =>
                  isObject(c) ? (
                    <span key={i} className="badge badge-neutral font-mono">
                      {JSON.stringify(c.case)}
                    </span>
                  ) : null
                )}
              </div>
            )}
          </Section>
        )}
        {step.actionType === "Foreach" && (
          <Section title="For each item in">
            <Value value={raw.foreach} ctx={ctx} />
          </Section>
        )}
        {raw.recurrence !== undefined && (
          <Section title="Recurrence">
            <Value value={raw.recurrence} ctx={ctx} />
          </Section>
        )}
        {raw.limit !== undefined && (
          <Section title="Limit">
            <Value value={raw.limit} ctx={ctx} />
          </Section>
        )}

        {host && (
          <Section title="Operation">
            <Value
              value={Object.fromEntries(
                Object.entries(host).filter(([, v]) => typeof v === "string" && v !== "")
              )}
              ctx={ctx}
            />
          </Section>
        )}
        {parameters !== undefined && (
          <Section title="Parameters">
            <Value value={parameters} ctx={ctx} />
          </Section>
        )}
        {otherInputs !== undefined && !(isObject(otherInputs) && Object.keys(otherInputs).length === 0) && (
          <Section title={step.childFlowId ? "Inputs to the child flow" : "Inputs"}>
            <Value value={step.childFlowId && isObject(otherInputs) ? otherInputs.body ?? otherInputs : otherInputs} ctx={ctx} />
          </Section>
        )}

        {Object.keys(settings).length > 0 && (
          <Section title="Settings">
            <Value value={settings} ctx={ctx} />
          </Section>
        )}

        {(uses.length > 0 || usedBy.length > 0) && (
          <Section title="Data">
            {uses.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-16 shrink-0 text-xs text-subtle">Reads</span>
                {uses.map((k) => (
                  <StepLink key={k} name={k} ctx={ctx} />
                ))}
              </div>
            )}
            {usedBy.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="w-16 shrink-0 text-xs text-subtle">Read by</span>
                {usedBy.map((k) => (
                  <StepLink key={k} name={k} ctx={ctx} />
                ))}
              </div>
            )}
          </Section>
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
    <button className="badge badge-neutral hover:text-fg hover:underline" onClick={() => ctx.onSelectKey(name)} title={`Go to ${pretty(name)}`}>
      {pretty(name)}
    </button>
  ) : (
    <span className="badge badge-neutral opacity-70">{pretty(name)}</span>
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
              {l.op && <span className="text-subtle">{l.op}</span>}
              {l.right !== undefined && <Text value={l.right} ctx={ctx} />}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Any JSON value, as key/value rows; strings get expression highlighting. */
function Value({ value, ctx, depth = 0 }: { value: unknown; ctx: Ctx; depth?: number }) {
  if (value === undefined) return <span className="text-xs text-subtle">—</span>;
  if (value === null) return <span className="font-mono text-[12px] text-subtle">null</span>;
  if (typeof value === "string") return <Text value={value} ctx={ctx} />;
  if (typeof value === "number") return <span className="font-mono text-[12px] text-num">{value}</span>;
  if (typeof value === "boolean") return <span className="font-mono text-[12px] text-bool">{String(value)}</span>;
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i + 1), v])
    : Object.entries(value as Json);
  if (entries.length === 0) {
    return <span className="font-mono text-[12px] text-subtle">{Array.isArray(value) ? "[ ]" : "{ }"}</span>;
  }
  return (
    <div className={`space-y-1.5 ${depth > 0 ? "border-l border-line pl-2.5" : ""}`}>
      {entries.map(([k, v]) => {
        const nested = typeof v === "object" && v !== null && Object.keys(v).length > 0;
        return (
          <div key={k} className={nested ? "" : "grid grid-cols-[minmax(72px,max-content)_1fr] gap-x-3"}>
            <div className="truncate pt-px font-mono text-[11.5px] text-subtle" title={k}>
              {Array.isArray(value) ? `#${k}` : k}
            </div>
            <div className={`min-w-0 ${nested ? "mt-1" : ""}`}>
              <Value value={v} ctx={ctx} depth={depth + 1} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const LONG = 360;

/** A string value: literal text plus highlighted `@…` / `@{…}` expressions. */
function Text({ value, ctx }: { value: string; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const long = value.length > LONG;
  const parts = splitExpressions(long && !open ? value.slice(0, LONG) : value);
  return (
    <span className="text-[12.5px] leading-relaxed break-words whitespace-pre-wrap">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <code key={i} className="rounded bg-brand/10 px-1 py-px font-mono text-[11.5px]">
            {tokenizeExpression(p.text).map((t, j) => {
              if (t.kind === "fn") return <span key={j} className="text-brand">{t.text}</span>;
              if (t.kind === "string") return <span key={j} className="text-success">{t.text}</span>;
              if (t.kind === "step" && ctx.index.byKey.has(t.name)) {
                return (
                  <button key={j} className="text-info underline decoration-dotted underline-offset-2 hover:decoration-solid" onClick={() => ctx.onSelectKey(t.name)} title={`Go to ${pretty(t.name)}`}>
                    {t.text}
                  </button>
                );
              }
              if (t.kind === "variable" && ctx.index.variables.has(t.name.toLowerCase())) {
                const decl = ctx.index.variables.get(t.name.toLowerCase())!;
                return (
                  <button key={j} className="text-warning underline decoration-dotted underline-offset-2 hover:decoration-solid" onClick={() => ctx.onSelectKey(decl.key)} title={`Declared in ${decl.name}`}>
                    {t.text}
                  </button>
                );
              }
              return <span key={j}>{t.text}</span>;
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
