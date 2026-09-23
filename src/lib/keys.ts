// Configurable keyboard shortcuts (frontend-only, persisted in localStorage).

export interface Keybindings {
  /** Combos that trigger Run (selection if any, else the whole script). */
  run: string[];
}

export const DEFAULT_KEYS: Keybindings = { run: ["F5", "Ctrl+Enter"] };

const KEY = "cds.keybindings";

export function loadKeybindings(): Keybindings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_KEYS;
    const parsed = JSON.parse(raw) as Partial<Keybindings>;
    return { run: Array.isArray(parsed.run) && parsed.run.length ? parsed.run : DEFAULT_KEYS.run };
  } catch {
    return DEFAULT_KEYS;
  }
}

export function saveKeybindings(k: Keybindings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(k));
  } catch {
    /* ignore */
  }
}

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** Builds a normalized combo string from a keydown event, or null for a bare modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");

  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

export function matchesBinding(e: KeyboardEvent, bindings: string[]): boolean {
  const combo = comboFromEvent(e);
  return combo !== null && bindings.includes(combo);
}

/** Reject bare keys (would fire while typing); require a modifier or a function key. */
export function isValidBinding(combo: string): boolean {
  const hasModifier = /(?:^|\+)(Ctrl|Alt|Shift|Meta)(?=\+)/.test(combo);
  const isFunctionKey = /(?:^|\+)F\d{1,2}$/.test(combo);
  return hasModifier || isFunctionKey;
}

/** Human-friendly label, e.g. "Ctrl+Enter" -> "Ctrl + Enter". */
export function formatCombo(combo: string): string {
  return combo
    .replace("Meta", "Cmd")
    .split("+")
    .join(" + ");
}
