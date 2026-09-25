// Matching and ranking for the command palette (Ctrl+K).
import type { ReactNode } from "react";

export interface PaletteAction {
  /** Shown in the footer after its keys, e.g. "query in SQL". */
  label: string;
  /** "shift" = Shift+Enter, "alt" = Alt+Enter. */
  key: "shift" | "alt";
  run: () => void;
}

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  /** Muted text on the right. */
  hint?: string;
  /** Also searched, never shown. */
  keywords?: string;
  icon?: ReactNode;
  /** Only listed once something is typed (tables, flows… are too many to show all). */
  searchOnly?: boolean;
  run: () => void;
  /** Enter runs `run`; these run with a modifier. */
  alts?: PaletteAction[];
}

export interface PaletteGroup {
  group: string;
  items: PaletteItem[];
}

const SEPARATORS = " ._-·/()[]:";

/** `word` starts at a word boundary somewhere in `text`. */
function startsWord(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (i === 0 || SEPARATORS.includes(text[i - 1])) return true;
  }
  return false;
}

/**
 * How well `query` matches: lower is better, null = no match. Every word of
 * the query must appear in the label or keywords; the label beats keywords,
 * a prefix beats a word start beats anywhere.
 */
export function matchScore(query: string, label: string, keywords = ""): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const l = label.toLowerCase();
  const all = `${l} ${keywords.toLowerCase()}`;
  const words = q.split(/\s+/);
  if (!words.every((w) => all.includes(w))) return null;
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  if (words.every((w) => startsWord(l, w))) return 2;
  if (words.every((w) => l.includes(w))) return 3;
  return words.every((w) => startsWord(all, w)) ? 4 : 5;
}

/**
 * The items to show for `query`, grouped. Groups keep their order when
 * nothing is typed; otherwise the group with the best match comes first.
 * Each group is capped at `perGroup`, the whole list at `total`.
 */
export function rank(items: PaletteItem[], query: string, perGroup = 8, total = 60): PaletteGroup[] {
  const typed = query.trim() !== "";
  const order: string[] = [];
  const scored = new Map<string, { item: PaletteItem; score: number; index: number }[]>();
  items.forEach((item, index) => {
    if (item.searchOnly && !typed) return;
    const score = matchScore(query, item.label, `${item.keywords ?? ""} ${item.hint ?? ""} ${item.group}`);
    if (score === null) return;
    if (!scored.has(item.group)) {
      scored.set(item.group, []);
      order.push(item.group);
    }
    scored.get(item.group)!.push({ item, score, index });
  });

  const groups = order.map((group) => {
    const list = scored.get(group)!.sort((a, b) => a.score - b.score || a.index - b.index);
    return { group, best: list[0].score, first: order.indexOf(group), list };
  });
  if (typed) groups.sort((a, b) => a.best - b.best || a.first - b.first);

  let left = total;
  const out: PaletteGroup[] = [];
  for (const g of groups) {
    if (left <= 0) break;
    const items = g.list.slice(0, Math.min(perGroup, left)).map((x) => x.item);
    left -= items.length;
    out.push({ group: g.group, items });
  }
  return out;
}
