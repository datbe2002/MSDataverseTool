// Moves the designer's cards smoothly when the layout changes (a container
// expanded or collapsed): each node glides from where it is drawn to its new
// place, new nodes fade in and nodes that went away fade out where they were.
import { useLayoutEffect, useRef, useState } from "react";
import type { GraphNode } from "./flowGraph";

const DURATION = 260;

type Box = Pick<GraphNode, "x" | "y" | "w" | "h">;

export interface AnimatedLayout {
  /** Where to draw each node right now (null: at its layout place). */
  boxes: Map<string, Box> | null;
  /** Nodes that just appeared (they fade in). */
  entering: Set<string>;
  /** Nodes that just went away, still drawn while they fade out. */
  leaving: GraphNode[];
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

const same = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export function useAnimatedLayout(nodes: GraphNode[]): AnimatedLayout {
  const [state, setState] = useState<AnimatedLayout>({ boxes: null, entering: new Set(), leaving: [] });
  // What is on screen now (mid-animation included), and the nodes drawn last.
  const shown = useRef<Map<string, Box>>(new Map());
  const previous = useRef<GraphNode[]>([]);

  useLayoutEffect(() => {
    const target = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]));
    const from = shown.current;
    const before = previous.current;
    previous.current = nodes;

    const moves = [...target].some(([id, b]) => {
      const f = from.get(id);
      return f !== undefined && !same(f, b);
    });
    // First drawing, nothing moved, or motion turned off: straight to the layout.
    if (!from.size || !moves || reducedMotion()) {
      shown.current = target;
      setState({ boxes: null, entering: from.size && !reducedMotion() ? new Set([...target.keys()].filter((id) => !from.has(id))) : new Set(), leaving: [] });
      return;
    }

    const entering = new Set([...target.keys()].filter((id) => !from.has(id)));
    const leaving = before.filter((n) => !target.has(n.id)).map((n) => ({ ...n, ...(from.get(n.id) ?? {}) }));
    const at = (t: number) => {
      const e = easeOut(t);
      const out = new Map<string, Box>();
      for (const [id, b] of target) {
        const f = from.get(id) ?? b;
        out.set(id, { x: f.x + (b.x - f.x) * e, y: f.y + (b.y - f.y) * e, w: f.w + (b.w - f.w) * e, h: f.h + (b.h - f.h) * e });
      }
      return out;
    };

    // The first frame is set before paint, so nothing jumps to the end first.
    const first = at(0);
    shown.current = first;
    setState({ boxes: first, entering, leaving });

    const start = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / DURATION);
      if (t < 1) {
        const frame = at(t);
        shown.current = frame;
        setState({ boxes: frame, entering, leaving });
        raf = requestAnimationFrame(tick);
      } else {
        shown.current = target;
        setState({ boxes: null, entering, leaving: [] });
      }
    });
    // Interrupted by another change: the next animation starts from where this one got to.
    return () => cancelAnimationFrame(raf);
  }, [nodes]);

  return state;
}
