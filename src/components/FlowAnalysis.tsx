import { api } from "../api";
import { useStore } from "../store";
import { docLabel, getRule, label, type Finding, type FlowAnalysis, type Grade, type ScoredCategory } from "../lib/flowAnalyzer";
import { AlertTriangle, ArrowUpRight } from "./Icon";

export const GRADE_BADGE: Record<Grade, string> = {
  A: "badge-success",
  B: "badge-success",
  C: "badge-warning",
  D: "badge-danger",
  F: "badge-danger",
};

const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  high: "badge-danger",
  medium: "badge-warning",
  low: "badge-neutral",
};

const CATEGORIES: [ScoredCategory, string][] = [
  ["speed", "Speed"],
  ["resources", "Resources"],
  ["reliability", "Reliability"],
  ["security", "Security"],
];

/** Grade and findings of the Cloud Flow Analyzer rules for one flow definition. */
export function FlowAnalysisPane({
  analysis,
  error,
  onShowStep,
}: {
  analysis: FlowAnalysis | null;
  error: string | null;
  /** Shows the step (an action or trigger name) in the Designer. */
  onShowStep: (name: string) => void;
}) {
  if (!analysis) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
        <AlertTriangle size={18} className="text-warning" />
        <div className="font-medium">Couldn't analyse this flow</div>
        {error && <div className="max-w-xl break-words text-xs text-subtle">{error}</div>}
      </div>
    );
  }
  const { score, findings, estimate, warnings } = analysis;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-5">
        <div className="card flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
          <div className="flex items-center gap-3">
            <span className={`badge ${GRADE_BADGE[score.grade]} !px-3 !py-1 text-2xl font-semibold`}>{score.grade}</span>
            <div>
              <div className="text-sm font-medium tabular-nums">{score.overall} / 100</div>
              <div className="text-xs text-subtle">
                {findings.length === 0 ? "No issues found" : `${findings.length} ${findings.length === 1 ? "issue" : "issues"}`}
                {score.capped && " · capped at C by a security issue"}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {CATEGORIES.map(([key, name]) => {
              const c = score.categories[key];
              return (
                <div key={key} title={`${c.findings} ${c.findings === 1 ? "issue" : "issues"}`}>
                  <div className="eyebrow">{name}</div>
                  <div className="mt-0.5 text-sm tabular-nums">
                    <span className={`badge ${GRADE_BADGE[c.grade]} mr-1.5`}>{c.grade}</span>
                    {c.score}
                  </div>
                </div>
              );
            })}
            <div title={estimate.assumed ? "Loops are assumed to run a typical number of items" : undefined}>
              <div className="eyebrow">Actions / run</div>
              <div className="mt-0.5 text-sm tabular-nums">
                {estimate.assumed ? "≈ " : ""}
                {estimate.total.toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        {findings.map((f, i) => (
          <FindingCard key={`${f.ruleId}-${f.target.name ?? ""}-${i}`} finding={f} onShowStep={onShowStep} />
        ))}

        {warnings.length > 0 && (
          <details className="text-xs text-subtle">
            <summary className="cursor-pointer">{warnings.length} parser notes</summary>
            <ul className="mt-1 list-disc pl-5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        <p className="text-xs text-subtle">
          Rules from Cloud Flow Analyzer (MIT), based on Microsoft's Power Automate coding guidelines. Run timings aren't read, so
          loop sizes are assumed.
        </p>
      </div>
    </div>
  );
}

function FindingCard({ finding: f, onShowStep }: { finding: Finding; onShowStep: (name: string) => void }) {
  const rule = getRule(f.ruleId);
  const pushToast = useStore((s) => s.pushToast);
  const openDoc = (url: string) =>
    api.openDocs(url).catch((e) => pushToast({ tone: "error", title: "Couldn't open the link", body: String((e as Error)?.message ?? e) }));
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${SEVERITY_BADGE[f.severity]}`}>{f.severity}</span>
        <span className="font-mono text-xs text-subtle">{f.ruleId}</span>
        <span className="font-medium">{rule?.title ?? f.ruleId}</span>
        {f.target.name && f.target.kind !== "flow" && (
          <button className="badge badge-brand gap-1 hover:underline" onClick={() => onShowStep(f.target.name!)} title="Show in the Designer">
            ⌖ {label(f.target.name)}
          </button>
        )}
      </div>
      <p className="mt-2 text-sm">{f.message}</p>
      {f.blockedBy && f.blockedBy.length > 0 && <p className="mt-1 text-xs text-subtle">Fix {f.blockedBy.join(", ")} first.</p>}
      {rule && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted">How to fix</summary>
          <div className="mt-2 space-y-2">
            <p className="text-muted">{rule.why}</p>
            <p>{f.fix ?? rule.fix}</p>
            {rule.example && (
              <div className="grid gap-2 sm:grid-cols-2">
                {(["before", "after"] as const).map((k) => (
                  <div key={k} className="min-w-0">
                    <div className="eyebrow">{k === "before" ? "Before" : "After"}</div>
                    <pre className="mt-1 overflow-x-auto rounded-md border border-line bg-s1 p-2 font-mono text-xs">{rule.example![k]}</pre>
                  </div>
                ))}
              </div>
            )}
            {rule.docs.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {rule.docs.map((url) => (
                  <button key={url} className="badge badge-neutral gap-1 hover:underline" onClick={() => void openDoc(url)} title={url}>
                    {docLabel(url)}
                    <ArrowUpRight size={11} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
