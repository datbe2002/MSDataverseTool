import { tagStyle } from "../lib/tags";
import type { Connection } from "../types";

/** The connection's environment tag as a coloured pill (renders nothing without a tag). */
export function TagBadge({
  connection,
  size = "sm",
  className = "",
}: {
  connection: Pick<Connection, "tag" | "color">;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!connection.tag) return null;
  const s = tagStyle(connection.color);
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md font-semibold uppercase tracking-wider ${s.badge} ${
        size === "md" ? "px-2 py-0.5 text-xs" : "px-1.5 py-px text-[10px]"
      } ${className}`}
    >
      {connection.tag}
    </span>
  );
}
