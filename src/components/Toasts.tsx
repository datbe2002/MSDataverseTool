import { useEffect } from "react";
import { useStore, type Toast, type ToastTone } from "../store";
import { AlertTriangle, Check, Info, X, Copy } from "./Icon";

const TONE: Record<ToastTone, { icon: typeof Info; color: string; bar: string }> = {
  error: { icon: AlertTriangle, color: "text-danger", bar: "bg-danger" },
  warning: { icon: AlertTriangle, color: "text-warning", bar: "bg-warning" },
  success: { icon: Check, color: "text-success", bar: "bg-success" },
  info: { icon: Info, color: "text-info", bar: "bg-info" },
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast);
  const cfg = TONE[toast.tone];
  const Icon = cfg.icon;

  useEffect(() => {
    // Errors stay until dismissed so the message can be read/copied.
    if (toast.tone === "error") return;
    const timer = setTimeout(() => dismiss(toast.id), toast.duration ?? 4000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.tone, toast.duration, dismiss]);

  return (
    <div
      className={`toast-in popover pointer-events-auto relative flex gap-3 overflow-hidden p-3.5 pl-4`}
      role="alert"
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${cfg.bar}`} aria-hidden="true" />
      <Icon size={16} className={`mt-0.5 shrink-0 ${cfg.color}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{toast.title}</div>
        {toast.body && (
          <div className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted">
            {toast.body}
          </div>
        )}
        {toast.tone === "error" && toast.body && (
          <button
            onClick={() => navigator.clipboard.writeText(toast.body!).catch(() => {})}
            className="btn btn-ghost btn-sm mt-1.5 -ml-2"
          >
            <Copy size={12} /> Copy
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        className="btn btn-ghost btn-icon btn-sm -m-1 self-start"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
