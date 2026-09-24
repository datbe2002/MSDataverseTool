// Layout of a flow for the Designer tab: cards stacked top to bottom in run
// order, parallel branches side by side, Scope / Apply to each / Do until /
// Condition / Switch drawn as frames around their steps. Pure geometry; the
// React Flow rendering lives in components/FlowDesigner.tsx.
import type { OutlineNode } from "./flowOutline";

export const CARD_W = 264;
export const CARD_H = 60;
const GAP_Y = 44;
const GAP_X = 28;
const PAD = 20;
const PILL_W = 96;
const PILL_H = 24;
const EMPTY_W = 180;
const EMPTY_H = 34;

/** Steps drawn as a frame around their own steps (unless collapsed). */
export const CONTAINERS = new Set(["Scope", "Foreach", "Until", "If", "Switch"]);

export type GraphNodeKind = "card" | "frame" | "pill" | "empty";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Frames sit behind what they contain: deeper = drawn later. */
  depth: number;
  /** The step (cards, frames); null for pills and empty placeholders. */
  step: OutlineNode | null;
  /** Pill text ("True", "Case \"a\"", "Default"); an empty placeholder's text. */
  label?: string;
  /** A container shown as a card: how many steps it hides. */
  hidden?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** "out" = bottom of a card/frame; "inner" = bottom of a frame's header. */
  sourceHandle: "out" | "inner";
  /** Statuses other than "Succeeded" the target waits for (e.g. Failed). */
  when: string[] | null;
}

export interface FlowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

interface Block {
  w: number;
  h: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node that incoming edges attach to (its top). */
  top: string;
  /** Node that outgoing edges leave from (its bottom). */
  bottom: string;
}

function shift(nodes: GraphNode[], dx: number, dy: number) {
  for (const n of nodes) {
    n.x += dx;
    n.y += dy;
  }
}

/** Every step inside a container (for "12 steps" on a collapsed card). */
export function countSteps(step: OutlineNode): number {
  let n = 0;
  for (const c of step.children) n += (c.kind === "branch" ? 0 : 1) + countSteps(c);
  return n;
}

function edge(source: string, target: string, sourceHandle: "out" | "inner", statuses?: string[]): GraphEdge {
  const unusual = statuses?.filter((s) => s !== "Succeeded") ?? [];
  return {
    id: `${source}→${target}`,
    source,
    target,
    sourceHandle,
    when: unusual.length ? statuses! : null,
  };
}

class Layout {
  constructor(private collapsed: Set<string>) {}

  /** One step: a card, or a frame around its steps. */
  step(step: OutlineNode, depth: number): Block {
    // A child flow shown inline is a frame too, until it's closed again.
    const isContainer = CONTAINERS.has(step.actionType) || !!step.inline;
    if (!isContainer || (!step.inline && this.collapsed.has(step.id))) {
      const node: GraphNode = {
        id: step.id,
        kind: "card",
        x: 0,
        y: 0,
        w: CARD_W,
        h: CARD_H,
        depth,
        step,
        hidden: isContainer ? countSteps(step) : undefined,
      };
      return { w: CARD_W, h: CARD_H, nodes: [node], edges: [], top: step.id, bottom: step.id };
    }

    // Condition / Switch: one column per branch; others: one sequence.
    const columns: Block[] = [];
    const edges: GraphEdge[] = [];
    if (step.inline) {
      const body = this.flow(step.children, depth + 1);
      if (body) {
        columns.push(body.block);
        for (const r of body.roots) edges.push(edge(step.id, r, "inner"));
      } else {
        const text: Record<string, string> = {
          loading: "Loading the child flow…",
          error: "Couldn't load the child flow",
          missing: "Flow not in this environment",
          cycle: "Runs a flow above it again",
          ready: "No steps",
        };
        const empty = this.empty(`${step.id}empty`, depth + 1, text[step.inline.status]);
        columns.push(empty);
        edges.push(edge(step.id, empty.top, "inner"));
      }
    } else if (step.actionType === "If" || step.actionType === "Switch") {
      const branches =
        step.actionType === "If"
          ? [
              { label: "True", id: `${step.id}\u0001actions`, steps: step.children[0]?.children ?? [] },
              {
                label: "False",
                id: `${step.id}\u0001else`,
                steps: step.children.find((c) => c.id.endsWith("\u0001else"))?.children ?? [],
              },
            ]
          : step.children.map((b) => ({ label: b.name, id: b.id, steps: b.children }));
      for (const b of branches) columns.push(this.branch(b.id, b.label, b.steps, depth + 1));
      for (const c of columns) edges.push(edge(step.id, c.top, "inner"));
    } else {
      const seq = this.sequence(step.children, depth + 1);
      if (seq) {
        columns.push(seq.block);
        for (const r of seq.roots) edges.push(edge(step.id, r, "inner"));
      } else {
        const empty = this.empty(`${step.id}\u0001empty`, depth + 1);
        columns.push(empty);
        edges.push(edge(step.id, empty.top, "inner"));
      }
    }

    // Columns side by side, under the frame's header card.
    const innerW = columns.reduce((w, c) => w + c.w, 0) + GAP_X * (columns.length - 1);
    const frameW = Math.max(CARD_W, innerW) + 2 * PAD;
    const innerTop = CARD_H + GAP_Y;
    let x = (frameW - innerW) / 2;
    let innerH = 0;
    const nodes: GraphNode[] = [];
    for (const c of columns) {
      shift(c.nodes, x, innerTop);
      nodes.push(...c.nodes);
      edges.push(...c.edges);
      x += c.w + GAP_X;
      innerH = Math.max(innerH, c.h);
    }
    const frameH = innerTop + innerH + PAD;
    const frame: GraphNode = { id: step.id, kind: "frame", x: 0, y: 0, w: frameW, h: frameH, depth, step };
    return { w: frameW, h: frameH, nodes: [frame, ...nodes], edges, top: step.id, bottom: step.id };
  }

  /** A labelled branch of a Condition / Switch: pill, then its steps. */
  private branch(id: string, label: string, steps: OutlineNode[], depth: number): Block {
    const pill: GraphNode = { id, kind: "pill", x: 0, y: 0, w: PILL_W, h: PILL_H, depth, step: null, label };
    const seq = this.sequence(steps, depth);
    const body = seq?.block ?? this.empty(`${id}\u0001empty`, depth);
    const w = Math.max(PILL_W, body.w);
    pill.x = (w - PILL_W) / 2;
    shift(body.nodes, (w - body.w) / 2, PILL_H + GAP_Y * 0.7);
    const roots = seq ? seq.roots : [body.top];
    return {
      w,
      h: PILL_H + GAP_Y * 0.7 + body.h,
      nodes: [pill, ...body.nodes],
      edges: [...roots.map((r) => edge(id, r, "out")), ...body.edges],
      top: id,
      bottom: id,
    };
  }

  private empty(id: string, depth: number, label?: string): Block {
    const w = label ? Math.max(EMPTY_W, label.length * 6.5 + 24) : EMPTY_W;
    const node: GraphNode = { id, kind: "empty", x: 0, y: 0, w, h: EMPTY_H, depth, step: null, label };
    return { w, h: EMPTY_H, nodes: [node], edges: [], top: id, bottom: id };
  }

  /** A whole flow (or a child flow shown inline): its triggers in a row, the actions below. */
  flow(outline: OutlineNode[], depth: number): { block: Block; roots: string[] } | null {
    const triggers = outline.filter((n) => n.kind === "trigger");
    const actions = outline.filter((n) => n.kind !== "trigger");
    const seq = this.sequence(actions, depth);
    if (!triggers.length) return seq;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const triggerRowW = triggers.length * CARD_W + (triggers.length - 1) * GAP_X;
    const width = Math.max(triggerRowW, seq?.block.w ?? 0);
    triggers.forEach((t, i) => {
      nodes.push({
        id: t.id,
        kind: "card",
        x: (width - triggerRowW) / 2 + i * (CARD_W + GAP_X),
        y: 0,
        w: CARD_W,
        h: CARD_H,
        depth,
        step: t,
      });
    });
    let height = CARD_H;
    if (seq) {
      const top = CARD_H + GAP_Y;
      shift(seq.block.nodes, (width - seq.block.w) / 2, top);
      nodes.push(...seq.block.nodes);
      edges.push(...seq.block.edges);
      for (const t of triggers) for (const r of seq.roots) edges.push(edge(t.id, r, "out"));
      height = top + seq.block.h;
    }
    const roots = triggers.map((t) => t.id);
    return { block: { w: width, h: height, nodes, edges, top: roots[0], bottom: roots[0] }, roots };
  }

  /**
   * Sibling steps laid out in layers by `runAfter`: a step sits one row below
   * the lowest step it waits for, so parallel branches end up side by side.
   */
  sequence(steps: OutlineNode[], depth: number): { block: Block; roots: string[] } | null {
    if (steps.length === 0) return null;
    const byKey = new Map(steps.map((s) => [s.key, s]));
    const blocks = new Map(steps.map((s) => [s.id, this.step(s, depth)]));
    const deps = (s: OutlineNode) => Object.keys(s.after).filter((d) => byKey.has(d));

    // Rank = longest chain of waits above the step (steps come in run order).
    const rank = new Map<string, number>();
    for (const s of steps) {
      const r = deps(s).reduce((m, d) => Math.max(m, (rank.get(byKey.get(d)!.id) ?? 0) + 1), 0);
      rank.set(s.id, r);
    }
    const rows: OutlineNode[][] = [];
    for (const s of steps) (rows[rank.get(s.id)!] ??= []).push(s);

    // x: each step centred under what it waits for, pushed right on overlap,
    // then the row is shifted back so it stays balanced around that centre.
    const cx = new Map<string, number>();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    let y = 0;
    for (const row of rows.filter(Boolean)) {
      const wanted = row.map((s, i) => {
        const ds = deps(s);
        if (!ds.length) return i * (CARD_W + GAP_X);
        return ds.reduce((sum, d) => sum + cx.get(byKey.get(d)!.id)!, 0) / ds.length;
      });
      const order = row.map((s, i) => ({ s, want: wanted[i] })).sort((a, b) => a.want - b.want);
      let right = -Infinity;
      let drift = 0;
      const placed = order.map(({ s, want }) => {
        const w = blocks.get(s.id)!.w;
        const left = Math.max(want - w / 2, right + GAP_X);
        right = left + w;
        drift += left + w / 2 - want;
        return { s, left };
      });
      const back = drift / placed.length;
      let rowH = 0;
      for (const { s, left } of placed) {
        const b = blocks.get(s.id)!;
        shift(b.nodes, left - back, y);
        cx.set(s.id, left - back + b.w / 2);
        nodes.push(...b.nodes);
        edges.push(...b.edges);
        rowH = Math.max(rowH, b.h);
      }
      y += rowH + GAP_Y;
    }

    for (const s of steps) {
      for (const d of deps(s)) {
        edges.push(edge(blocks.get(byKey.get(d)!.id)!.bottom, blocks.get(s.id)!.top, "out", s.after[d]));
      }
    }

    // Normalise to a top-left origin.
    const minX = Math.min(...nodes.map((n) => n.x));
    shift(nodes, -minX, 0);
    const w = Math.max(...nodes.map((n) => n.x + n.w));
    const roots = steps.filter((s) => deps(s).length === 0).map((s) => blocks.get(s.id)!.top);
    return { block: { w, h: y - GAP_Y, nodes, edges, top: roots[0], bottom: roots[0] }, roots };
  }
}

/** Triggers on top, then the actions; `collapsed` holds container ids drawn as cards. */
export function layoutFlow(outline: OutlineNode[], collapsed: Set<string>): FlowGraph {
  const body = new Layout(collapsed).flow(outline, 0);
  if (!body) return { nodes: [], edges: [], width: 0, height: 0 };
  return { nodes: body.block.nodes, edges: body.block.edges, width: body.block.w, height: body.block.h };
}

/** Ids of every container, for "collapse all". */
export function containerIds(outline: OutlineNode[], out: string[] = []): string[] {
  for (const n of outline) {
    if (CONTAINERS.has(n.actionType)) out.push(n.id);
    containerIds(n.children, out);
  }
  return out;
}
