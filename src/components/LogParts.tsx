// Pieces shared by the log tools (Trace logs, System jobs).
import Editor from "@monaco-editor/react";
import { useStore } from "../store";
import { EDITOR_THEME } from "../lib/monacoTheme";
import { X } from "./Icon";

/** One figure in the detail header's stat card. */
export function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 flex min-w-0 items-baseline text-sm">{children}</div>
    </div>
  );
}

/** A filter narrowing the list to one thing (a chain, a record), with a way out. */
export function FilterChip({ label, value, title, onClear, clearLabel }: { label: string; value: string; title?: string; onClear: () => void; clearLabel: string }) {
  return (
    <div className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate" title={title ?? value}>
        {label} · <span className="font-mono">{value}</span>
      </span>
      <button className="btn btn-ghost btn-icon btn-sm" onClick={onClear} aria-label={clearLabel} title={clearLabel}>
        <X size={12} />
      </button>
    </div>
  );
}

/** Rows of ids, each copied on click. */
export function IdList({ ids, onCopy }: { ids: [string, string | null | undefined][]; onCopy: (value: string, label: string) => void }) {
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs short:hidden">
      {ids.map(([label, value]) =>
        value ? (
          <div key={label} className="contents">
            <dt className="eyebrow leading-5">{label}</dt>
            <dd className="min-w-0 truncate">
              <button className="font-mono text-muted hover:text-fg hover:underline" onClick={() => onCopy(value, label.toLowerCase())} title="Copy">
                {value}
              </button>
            </dd>
          </div>
        ) : null
      )}
    </dl>
  );
}

/** Read-only text (a trace, an error) in Monaco, wrapped. */
export function LogText({ path, text, empty }: { path: string; text: string; empty: string }) {
  const theme = useStore((s) => s.theme);
  if (!text.trim()) return <div className="flex h-full items-center justify-center text-sm text-subtle">{empty}</div>;
  return (
    <Editor
      height="100%"
      language="plaintext"
      path={path}
      value={text}
      theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
      options={{
        readOnly: true,
        domReadOnly: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace",
        fontLigatures: false,
        lineHeight: 20,
        lineNumbersMinChars: 4,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: "none",
        automaticLayout: true,
        wordWrap: "on",
        folding: false,
      }}
    />
  );
}

/** Placeholder rows while the first page loads. */
export function ListSkeleton() {
  return (
    <>
      {Array.from({ length: 10 }, (_, i) => (
        <li key={i} className="flex items-center gap-2.5 px-2.5 py-2.5">
          <div className="skeleton h-2 w-2 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <div className="skeleton h-3 w-2/3" />
            <div className="skeleton h-2.5 w-1/2" />
          </div>
        </li>
      ))}
    </>
  );
}
