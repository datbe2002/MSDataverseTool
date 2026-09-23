// Environment tag palette. Class strings are spelled out in full so Tailwind
// can see them.

export const TAG_COLORS = [
  "red",
  "amber",
  "green",
  "blue",
  "violet",
  "pink",
  "cyan",
  "slate",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const TAG_PRESETS = ["DEV", "TEST", "UAT", "SIT", "PROD"];

interface TagStyle {
  /** pill background + text */
  badge: string;
  /** small status dot / swatch */
  dot: string;
  /** thin accent stripe */
  stripe: string;
  /** very light wash for the top bar */
  tint: string;
  /** border for selected cards */
  ring: string;
  /** foreground tint for icons */
  text: string;
  /** whether writes should get an extra warning */
  danger: boolean;
}

const STYLES: Record<TagColor, TagStyle> = {
  red: {
    badge: "bg-red-500/15 text-red-600 dark:text-red-300",
    dot: "bg-red-500",
    stripe: "bg-red-500",
    tint: "bg-red-500/[0.06]",
    ring: "border-red-500/40",
    text: "text-red-500",
    danger: true,
  },
  amber: {
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
    stripe: "bg-amber-500",
    tint: "bg-amber-500/[0.06]",
    ring: "border-amber-500/40",
    text: "text-amber-500",
    danger: false,
  },
  green: {
    badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
    stripe: "bg-emerald-500",
    tint: "bg-emerald-500/[0.06]",
    ring: "border-emerald-500/40",
    text: "text-emerald-500",
    danger: false,
  },
  blue: {
    badge: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
    stripe: "bg-sky-500",
    tint: "bg-sky-500/[0.06]",
    ring: "border-sky-500/40",
    text: "text-sky-500",
    danger: false,
  },
  violet: {
    badge: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
    stripe: "bg-violet-500",
    tint: "bg-violet-500/[0.06]",
    ring: "border-violet-500/40",
    text: "text-violet-500",
    danger: false,
  },
  pink: {
    badge: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
    dot: "bg-pink-500",
    stripe: "bg-pink-500",
    tint: "bg-pink-500/[0.06]",
    ring: "border-pink-500/40",
    text: "text-pink-500",
    danger: false,
  },
  cyan: {
    badge: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
    dot: "bg-cyan-500",
    stripe: "bg-cyan-500",
    tint: "bg-cyan-500/[0.06]",
    ring: "border-cyan-500/40",
    text: "text-cyan-500",
    danger: false,
  },
  slate: {
    badge: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    dot: "bg-slate-400",
    stripe: "bg-slate-400",
    tint: "bg-slate-500/[0.06]",
    ring: "border-slate-400/40",
    text: "text-slate-400",
    danger: false,
  },
};

export function tagStyle(color: string | null | undefined): TagStyle {
  return STYLES[(color ?? "slate") as TagColor] ?? STYLES.slate;
}
