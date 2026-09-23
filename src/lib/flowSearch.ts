// Finding steps in a flow: by name, by type / connector, or by what their
// settings contain (a URL, a variable, a column name…).
import type { OutlineNode } from "./flowOutline";
import { ownPart } from "./flowRefs";

/** Where the query matched, best first. */
export type MatchWhere = "name" | "type" | "content";

export interface StepMatch {
  step: OutlineNode;
  where: MatchWhere;
  /** "Switch › Case "classify""; "" at the top level. */
  location: string;
}

const RANK: Record<MatchWhere, number> = { name: 0, type: 1, content: 2 };

// A step's settings as lowercase text, computed once per step object.
const contentCache = new WeakMap<OutlineNode, string>();
function contentOf(step: OutlineNode): string {
  let text = contentCache.get(step);
  if (text === undefined) {
    // Not `runAfter` (names the step before: searching a variable would also
    // find whatever runs after its declaration) nor `metadata` (ids).
    const own = ownPart(step);
    const { runAfter: _r, metadata: _m, ...settings } =
      typeof own === "object" && own !== null ? (own as Record<string, unknown>) : {};
    text = JSON.stringify(settings).toLowerCase();
    contentCache.set(step, text);
  }
  return text;
}

export function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Steps matching every term of the query; name matches first, then type /
 * connector, then settings content, each group in flow order.
 * `extra` adds text to the type match (a child flow's name).
 */
export function searchSteps(
  outline: OutlineNode[],
  query: string,
  extra?: (step: OutlineNode) => string | null
): StepMatch[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const out: StepMatch[] = [];
  const walk = (nodes: OutlineNode[], above: string[]) => {
    for (const step of nodes) {
      if (step.kind !== "branch") {
        const name = `${step.name} ${step.key}`.toLowerCase();
        const type = `${name} ${step.type} ${step.actionType} ${step.detail ?? ""} ${extra?.(step) ?? ""}`.toLowerCase();
        const all = (hay: string) => terms.every((t) => hay.includes(t));
        const where: MatchWhere | null = all(name)
          ? "name"
          : all(type)
          ? "type"
          : all(`${type} ${contentOf(step)}`)
          ? "content"
          : null;
        if (where) out.push({ step, where, location: above.join(" › ") });
      }
      walk(step.children, [...above, step.name]);
    }
  };
  walk(outline, []);
  // Stable sort keeps flow order within each group.
  return out.sort((a, b) => RANK[a.where] - RANK[b.where]);
}

/** Splits text into plain and matched pieces, for highlighting the terms. */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (terms.length === 0) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const hits = new Array<boolean>(text.length).fill(false);
  for (const t of terms) {
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
      for (let j = i; j < i + t.length; j++) hits[j] = true;
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === hits[i]) last.text += text[i];
    else parts.push({ text: text[i], hit: hits[i] });
  }
  return parts;
}
