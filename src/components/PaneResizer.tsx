/** Vertical drag handle; also moves with ←/→ when focused. */
export function PaneResizer({ label, onDrag, onKey }: { label: string; onDrag: (dx: number, done: boolean) => void; onKey: (dx: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const x0 = e.clientX;
        const move = (ev: PointerEvent) => onDrag(ev.clientX - x0, false);
        const up = (ev: PointerEvent) => {
          onDrag(ev.clientX - x0, true);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onKey((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 64 : 16));
        }
      }}
      className="group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize outline-none"
    >
      <div className="mx-auto h-full w-px bg-line transition group-hover:w-[3px] group-hover:bg-brand group-focus-visible:w-[3px] group-focus-visible:bg-brand" />
    </div>
  );
}
