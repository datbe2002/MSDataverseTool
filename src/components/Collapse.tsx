// A block that slides open and shut (height + fade) instead of appearing at
// once. Its content mounts when it opens and unmounts once it has closed, so
// what it reads (inputs, outputs…) is still read on demand.
import { useEffect, useState } from "react";

const DURATION = 200;

export function Collapse({ open, className = "", children }: { open: boolean; className?: string; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames: the closed state is painted before it opens, so it animates.
      let inner = 0;
      const outer = requestAnimationFrame(() => (inner = requestAnimationFrame(() => setExpanded(true))));
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setExpanded(false);
    const t = setTimeout(() => setMounted(false), DURATION);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
        expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
      aria-hidden={!open}
    >
      {/* Padding goes inside: on the shrinking box it would stay when closed. */}
      <div className="min-h-0 overflow-hidden">
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
