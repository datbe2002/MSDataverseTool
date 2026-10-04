// One flow of a task: its versions side by side (baseline, the edited file,
// the cloud now, earlier versions), what changed step by step, and what
// looks broken in the edited file.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { api } from "../api";
import { useStore } from "../store";
import { buildOutline, keyLines, pathKey, type ChildFlow, type OutlineNode } from "../lib/flowOutline";
import { checkFlow, diffMarks, diffText, flowChanges, stepFieldChanges, stepPairs, type ChangeKind, type DiffMark, type FieldChange, type FlowChange, type FlowProblem } from "../lib/flowTasks";
import { indexFlow } from "../lib/flowRefs";
import { relativeTime } from "../lib/history";
import { friendlyError } from "../lib/errors";
import { EDITOR_FONT, EDITOR_THEME } from "../lib/monacoTheme";
import { syncDiffModels } from "./WebResourceDialogs";
import { FlowDesigner } from "./FlowDesigner";
import { FlowStepPanel, type PanelTab } from "./FlowStepPanel";
import { AlertTriangle, Check, Info, Loader, Refresh, X } from "./Icon";
import type { FlowMeta, LiveTaskFlow, TaskFlow, TaskFlowFile, TaskVersion } from "../types";

const IGNORE_KEY = "cds.flowtasks.ignoreMetadata";
const VIEW_KEY = "cds.flowtasks.view";

type CompareView = "json" | "visual";

function readView(): CompareView {
  try {
    return localStorage.getItem(VIEW_KEY) === "visual" ? "visual" : "json";
  } catch {
    return "json";
  }
}

function readIgnore(): boolean {
  try {
    return localStorage.getItem(IGNORE_KEY) !== "0";
  } catch {
    return true;
  }
}

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  renamed: "Renamed",
  moved: "Moved",
  trigger: "Trigger",
  connection: "Connection",
  settings: "Settings",
};

const KIND_TONE: Record<ChangeKind, string> = {
  added: "text-success",
  removed: "text-danger",
  changed: "text-warning",
  renamed: "text-info",
  moved: "text-info",
  trigger: "text-warning",
  connection: "text-warning",
  settings: "text-warning",
};

const time = (iso: string) => (iso ? relativeTime(Date.parse(iso)) : "");

export interface CompareSide {
  /** "baseline" | "working" | "live" | "git:<sha>" | "snap:<file>" */
  version: string;
}

export function FlowTaskCompare({
  path,
  connId,
  envName,
  flow,
  file,
  live,
  liveLoading,
  liveError,
  onCheckCloud,
  envFlows,
  left,
  right,
  onPick,
  onErrors,
}: {
  path: string;
  /** Connection to the task's environment (choice labels); null when there's none. */
  connId: string | null;
  envName: string;
  flow: TaskFlow;
  file: TaskFlowFile | undefined;
  live: LiveTaskFlow | undefined;
  liveLoading: boolean;
  liveError: string | null;
  /** null: no connection to the task's environment. */
  onCheckCloud: (() => void) | null;
  envFlows: FlowMeta[] | null;
  left: string;
  right: string;
  onPick: (left: string, right: string) => void;
  /** Errors in the working copy (none until it's read). */
  onErrors?: (count: number) => void;
}) {
  const theme = useStore((s) => s.theme);
  const [ignore, setIgnore] = useState(readIgnore);
  const [inline, setInline] = useState(false);
  const [view, setViewState] = useState<CompareView>(readView);
  const setView = (v: CompareView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Only a convenience.
    }
  };
  // Visual: the step picked on each side (the same step on both when it's on both).
  const [picked, setPicked] = useState<{ left: string | null; right: string | null }>({ left: null, right: null });
  const [versions, setVersions] = useState<TaskVersion[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<{ added: number; removed: number } | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const marks = useRef<MonacoEditor.IEditorDecorationsCollection[]>([]);
  const requested = useRef(new Set<string>());

  const workingHash = file?.workingHash ?? file?.modifiedAt ?? "none";
  // A version's text is cached by what identifies its content.
  const cacheKey = useCallback(
    (v: string) => (v === "working" ? `working|${workingHash}` : v === "live" ? `live|${live?.hash ?? ""}` : v === "baseline" ? `baseline|${flow.baselineHash}` : v),
    [workingHash, live?.hash, flow.baselineHash]
  );

  useEffect(() => {
    let alive = true;
    api
      .taskFlowVersions(path, flow.id)
      .then((v) => alive && setVersions(v))
      .catch(() => alive && setVersions([]));
    return () => {
      alive = false;
    };
  }, [path, flow.id, workingHash, flow.baselineHash]);

  // Read whichever sides aren't cached yet; the working file again whenever it changes.
  useEffect(() => {
    for (const v of [left, right, "baseline", "working"]) {
      const key = cacheKey(v);
      if (v === "live" || requested.current.has(key)) continue;
      requested.current.add(key);
      api
        .taskFlowText(path, flow.id, v)
        .then((t) => {
          setTexts((s) => ({ ...s, [key]: t }));
          setErrors((s) => {
            const { [key]: _gone, ...rest } = s;
            return rest;
          });
        })
        .catch((e) => {
          // Not kept: the file may be back on the next look.
          requested.current.delete(key);
          setErrors((s) => ({ ...s, [key]: friendlyError(String(e)) }));
        });
    }
  }, [left, right, cacheKey, path, flow.id]);

  const textOf = (v: string): string | undefined => (v === "live" ? live?.content ?? undefined : texts[cacheKey(v)]);
  const errorOf = (v: string): string | undefined =>
    v === "live" ? (live?.error ?? liveError ?? (!live && !liveLoading ? "Not read from the cloud yet." : undefined)) : errors[cacheKey(v)];

  const leftText = textOf(left);
  const rightText = textOf(right);
  const shownLeft = useMemo(() => (leftText === undefined ? undefined : diffText(leftText, ignore)), [leftText, ignore]);
  // Keys in the left side's order, so only real differences show.
  const shownRight = useMemo(() => (rightText === undefined ? undefined : diffText(rightText, ignore, leftText)), [rightText, ignore, leftText]);

  const changes = useMemo(() => (leftText !== undefined && rightText !== undefined ? flowChanges(leftText, rightText) : null), [leftText, rightText]);
  const working = texts[cacheKey("working")];
  const baseline = texts[cacheKey("baseline")];
  const problems = useMemo(() => (working !== undefined ? checkFlow(working, { baseline, flows: envFlows }) : null), [working, baseline, envFlows]);
  const errorCount = problems?.filter((p) => p.level === "error").length ?? 0;
  useEffect(() => onErrors?.(errorCount), [errorCount]);
  const same = shownLeft !== undefined && shownLeft === shownRight;

  // Line numbers of the keys as shown, to jump from a change / problem.
  const leftLines = useMemo(() => (shownLeft ? keyLines(shownLeft) : null), [shownLeft]);
  const rightLines = useMemo(() => (shownRight ? keyLines(shownRight) : null), [shownRight]);
  const reveal = (side: "left" | "right", path: string[] | undefined) => {
    const diff = editorRef.current;
    if (!diff || !path) return;
    const editor = side === "left" ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const lines = side === "left" ? leftLines : rightLines;
    let line: number | undefined;
    for (let n = path.length; n > 0 && !line; n--) line = lines?.get(pathKey(path.slice(0, n)));
    if (!line) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    marks.current.forEach((m) => m.clear());
    const mark = editor.createDecorationsCollection([
      { range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: "flow-line-hl" } },
    ]);
    marks.current = [mark];
  };

  const pairs = useMemo(() => {
    const l = leftText === undefined ? null : buildOutline(leftText);
    const r = rightText === undefined ? null : buildOutline(rightText);
    return l && r && changes ? stepPairs(l, r, changes) : null;
  }, [leftText, rightText, changes]);
  /** Picks a step on one side, and the same step on the other. */
  const pickVisual = useCallback(
    (side: "left" | "right", id: string | null) => {
      if (!id) return setPicked({ left: null, right: null });
      const other = side === "left" ? pairs?.toRight.get(id) ?? null : pairs?.toLeft.get(id) ?? null;
      setPicked(side === "left" ? { left: id, right: other } : { left: other, right: id });
    },
    [pairs]
  );

  const baselineOption = flow.baselineOn ? `Baseline · read ${time(flow.baselineOn)}` : `Baseline · added ${time(flow.addedOn)}`;
  const options = (current: string, side: "left" | "right") => {
    const base: [string, string][] =
      side === "left"
        ? [
            ["baseline", baselineOption],
            ["working", "Working copy (the file)"],
          ]
        : [
            ["working", "Working copy (the file)"],
            ["baseline", baselineOption],
          ];
    base.push(["live", `Cloud now (${envName})`]);
    const all = [...base, ...versions.map((v) => [v.id, `${v.label || "Version"} · ${time(v.at)}`] as [string, string])];
    if (!all.some(([v]) => v === current)) all.push([current, current]);
    return all;
  };

  const sideLabel = (v: string) => {
    if (v === "baseline") return flow.baselineOn ? `Baseline — ${envName} as read ${time(flow.baselineOn)}` : `Baseline — ${envName} when added (${time(flow.addedOn)})`;
    if (v === "working") return `Working copy — ${file?.file ?? "definition.json"}`;
    if (v === "live") return live?.modifiedOn ? `Cloud now — modified ${time(live.modifiedOn)}${live.modifiedBy ? ` by ${live.modifiedBy}` : ""}` : `Cloud now (${envName})`;
    const ver = versions.find((x) => x.id === v);
    return ver ? `${ver.label} · ${time(ver.at)}` : v;
  };

  const setIgnoreKept = (on: boolean) => {
    setIgnore(on);
    try {
      localStorage.setItem(IGNORE_KEY, on ? "1" : "0");
    } catch {
      // Only a convenience.
    }
  };

  const waiting = (v: string) => (v === "live" ? liveLoading : textOf(v) === undefined && !errorOf(v));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* What's compared */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-s1 px-4 py-2">
        <select className="input !h-8 !w-auto max-w-[280px] !px-2 !text-[12.5px]" value={left} onChange={(e) => onPick(e.target.value, right)} aria-label="Left side">
          {options(left, "left").map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <span className="text-subtle" aria-hidden="true">
          ↔
        </span>
        <select className="input !h-8 !w-auto max-w-[280px] !px-2 !text-[12.5px]" value={right} onChange={(e) => onPick(left, e.target.value)} aria-label="Right side">
          {options(right, "right").map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        {(left === "live" || right === "live") && onCheckCloud && (
          <button className="btn btn-ghost btn-sm" onClick={onCheckCloud} disabled={liveLoading} title="Read the flow from the environment again">
            <Refresh size={12} className={liveLoading ? "animate-spin" : ""} /> Re-read cloud
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          {!same && stats && view === "json" && (
            <span className="font-mono text-xs tabular-nums">
              <span className="text-success">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span> <span className="text-subtle">lines</span>
            </span>
          )}
          {view === "json" && <label className="flex items-center gap-1.5 text-xs text-muted" title="What the Power Automate designer rewrites on its own when a flow is saved: a new operationMetadataId on every step, and the default authentication (@parameters('$authentication')) it drops. Hiding them leaves the real changes.">
            <input type="checkbox" className="accent-[var(--brand)]" checked={ignore} onChange={(e) => setIgnoreKept(e.target.checked)} />
            Hide designer ids
          </label>}
          <div className="seg" role="group" aria-label="Show as">
            <button aria-pressed={view === "json"} onClick={() => setView("json")} title="The definitions as JSON, line by line">
              JSON
            </button>
            <button aria-pressed={view === "visual"} onClick={() => setView("visual")} title="The flows drawn like the designer, changed steps marked">
              Visual
            </button>
          </div>
          <div className="seg" role="group" aria-label="Layout">
            <button aria-pressed={!inline} onClick={() => setInline(false)}>
              Side by side
            </button>
            <button aria-pressed={inline} onClick={() => setInline(true)} title={view === "visual" ? "Only the right side, with what changed marked" : undefined}>
              {view === "visual" ? "One side" : "Inline"}
            </button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[clamp(220px,24%,300px)_minmax(0,1fr)]">
        {/* Changes and checks */}
        <div className="min-h-0 overflow-y-auto border-r border-line bg-s1">
          <Section title="Changes" count={changes?.length} hint={`${sideLabel(left).split(" — ")[0]} → ${sideLabel(right).split(" — ")[0]}`}>
            {changes === null ? (
              <Pending />
            ) : same ? (
              <Empty>No differences.</Empty>
            ) : changes.length === 0 ? (
              <Empty>{buildable(leftText, rightText) ? "Only formatting or designer ids differ." : "One side isn't a flow definition; see the diff."}</Empty>
            ) : (
              changes.map((c, i) => <ChangeRow key={i} change={c} onPick={() => (view === "visual" ? pickVisual(c.side, pathKey(c.path)) : reveal(c.side, c.path))} />)
            )}
          </Section>
          <Section title="Checks" count={problems?.length} hint="On the working copy">
            {problems === null ? (
              <Pending />
            ) : problems.length === 0 ? (
              <Empty>
                <Check size={12} className="text-success" /> Nothing looks broken.
              </Empty>
            ) : (
              problems.map((p, i) => (
                <ProblemRow
                  key={i}
                  problem={p}
                  onPick={() => right === "working" && p.path && (view === "visual" ? pickVisual("right", pathKey(p.path)) : reveal("right", p.path))}
                />
              ))
            )}
          </Section>
          {errorCount > 0 && <p className="px-4 pb-4 text-[11.5px] text-subtle">A flow with errors can't be marked reviewed.</p>}
        </div>

        {/* Diff (kept mounted while the visual one shows, so Show in JSON can jump into it) */}
        <div className={`flex min-h-0 flex-col ${view === "visual" ? "hidden" : ""}`} style={{ background: "var(--editor-bg)" }}>
          {!inline && (
            <div className="grid shrink-0 grid-cols-2 border-b border-line bg-s1 text-[11.5px] text-subtle">
              <span className="truncate px-4 py-1.5" title={sideLabel(left)}>
                {sideLabel(left)}
              </span>
              <span className="truncate px-4 py-1.5" title={sideLabel(right)}>
                {sideLabel(right)}
              </span>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {errorOf(left) || errorOf(right) ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
                <AlertTriangle size={18} className="text-warning" />
                <div className="max-w-xl break-words text-xs text-subtle">{errorOf(left) ?? errorOf(right)}</div>
                {(left === "live" || right === "live") && onCheckCloud && !live && (
                  <button className="btn btn-secondary btn-sm" onClick={onCheckCloud} disabled={liveLoading}>
                    {liveLoading ? <Loader size={12} /> : <Refresh size={12} />} Read from the cloud
                  </button>
                )}
              </div>
            ) : waiting(left) || waiting(right) || shownLeft === undefined || shownRight === undefined ? (
              <div className="space-y-2 p-6">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="skeleton h-3" style={{ width: `${30 + ((i * 37) % 50)}%` }} />
                ))}
              </div>
            ) : (
              <>
                {same && (
                  <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
                    <span className="badge badge-neutral">No differences</span>
                  </div>
                )}
                <DiffEditor
                  height="100%"
                  language="json"
                  original={shownLeft}
                  modified={shownRight}
                  originalModelPath={`flowtask/${flow.id}/left.json`}
                  modifiedModelPath={`flowtask/${flow.id}/right.json`}
                  keepCurrentOriginalModel
                  keepCurrentModifiedModel
                  theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
                  options={{
                    readOnly: true,
                    originalEditable: false,
                    renderSideBySide: !inline,
                    // The labels above say which side is which; keep two sides when asked.
                    useInlineViewWhenSpaceIsLimited: false,
                    fontSize: 12.5,
                    fontFamily: EDITOR_FONT,
                    lineHeight: 19,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    bracketPairColorization: { enabled: false },
                    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 },
                  }}
                  onMount={(editor) => {
                    editorRef.current = editor;
                    syncDiffModels(editor, shownLeft, shownRight);
                    const count = () => {
                      let added = 0;
                      let removed = 0;
                      for (const c of editor.getLineChanges() ?? []) {
                        if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
                        if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
                      }
                      setStats({ added, removed });
                    };
                    editor.onDidUpdateDiff(count);
                  }}
                />
              </>
            )}
          </div>
        </div>

        {view === "visual" && (
          <VisualCompare
            leftText={leftText}
            rightText={rightText}
            leftKey={cacheKey(left)}
            rightKey={cacheKey(right)}
            leftLabel={sideLabel(left)}
            rightLabel={sideLabel(right)}
            loading={waiting(left) || waiting(right)}
            error={errorOf(left) ?? errorOf(right) ?? null}
            changes={changes}
            single={inline}
            picked={picked}
            onPick={pickVisual}
            envFlows={envFlows}
            connId={connId}
            theme={theme}
            onShowInJson={(side, path) => {
              setView("json");
              // The diff editor was hidden: let it lay out first.
              setTimeout(() => reveal(side, path), 80);
            }}
          />
        )}
      </div>
    </div>
  );
}

const NO_CHILD = (): ChildFlow => ({ status: "missing" });

const DRAWER_KEY = "cds.flowtasks.drawer";
const MIN_DRAWER = 160;

function readDrawer(): number {
  try {
    const v = Number(localStorage.getItem(DRAWER_KEY));
    return Number.isFinite(v) && v >= MIN_DRAWER ? v : 300;
  } catch {
    return 300;
  }
}

const MARK_TEXT: Record<DiffMark, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  moved: "Moved",
  renamed: "Renamed",
};

const MARK_BADGE: Record<DiffMark, string> = {
  added: "badge-success",
  removed: "badge-danger",
  changed: "badge-warning",
  moved: "badge-info",
  renamed: "badge-info",
};

function allSteps(nodes: OutlineNode[] | null, out = new Map<string, OutlineNode>()) {
  for (const n of nodes ?? []) {
    out.set(n.id, n);
    allSteps(n.children, out);
  }
  return out;
}

/** Both versions drawn like the designer, changed steps marked; picking a step picks it on both sides. */
function VisualCompare({
  leftText,
  rightText,
  leftKey,
  rightKey,
  leftLabel,
  rightLabel,
  loading,
  error,
  changes,
  single,
  picked,
  onPick,
  envFlows,
  connId,
  theme,
  onShowInJson,
}: {
  leftText: string | undefined;
  rightText: string | undefined;
  /** Change when the version shown changes (the canvas starts over). */
  leftKey: string;
  rightKey: string;
  leftLabel: string;
  rightLabel: string;
  loading: boolean;
  error: string | null;
  changes: FlowChange[] | null;
  /** Only the right side. */
  single: boolean;
  picked: { left: string | null; right: string | null };
  onPick: (side: "left" | "right", id: string | null) => void;
  envFlows: FlowMeta[] | null;
  connId: string | null;
  theme: "dark" | "light";
  onShowInJson: (side: "left" | "right", path: string[]) => void;
}) {
  const [detail, setDetail] = useState<"changes" | "both">("changes");
  const boxRef = useRef<HTMLDivElement>(null);
  const [drawerH, setDrawerH] = useState(readDrawer);
  /** Keeps the canvases at least ~140px tall. */
  const setDrawer = useCallback((h: number) => {
    const max = Math.max(MIN_DRAWER, (boxRef.current?.clientHeight ?? 800) - 140);
    const v = Math.round(Math.min(max, Math.max(MIN_DRAWER, h)));
    setDrawerH(v);
    try {
      localStorage.setItem(DRAWER_KEY, String(v));
    } catch {
      // Only a convenience.
    }
  }, []);
  const startResize = (e: React.PointerEvent) => {
    const box = boxRef.current;
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const bottom = box.getBoundingClientRect().bottom;
    const move = (ev: PointerEvent) => setDrawer(bottom - ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [panelTab, setPanelTab] = useState<PanelTab>("parameters");
  const leftOutline = useMemo(() => (leftText === undefined ? undefined : buildOutline(leftText)), [leftText]);
  const rightOutline = useMemo(() => (rightText === undefined ? undefined : buildOutline(rightText)), [rightText]);
  const marks = useMemo(() => diffMarks(changes ?? []), [changes]);
  const names = useMemo(() => new Map((envFlows ?? []).map((f) => [f.id.toLowerCase(), f.name])), [envFlows]);
  const flowName = useCallback((id: string) => names.get(id.toLowerCase()) ?? null, [names]);
  const noop = useCallback(() => {}, []);
  const pickLeft = useCallback((id: string | null) => onPick("left", id), [onPick]);
  const pickRight = useCallback((id: string | null) => onPick("right", id), [onPick]);
  const leftSteps = useMemo(() => allSteps(leftOutline ?? null), [leftOutline]);
  const rightSteps = useMemo(() => allSteps(rightOutline ?? null), [rightOutline]);
  const leftIndex = useMemo(() => indexFlow(leftOutline ?? []), [leftOutline]);
  const rightIndex = useMemo(() => indexFlow(rightOutline ?? []), [rightOutline]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
        <AlertTriangle size={18} className="text-warning" />
        <div className="max-w-xl break-words text-xs text-subtle">{error}</div>
      </div>
    );
  }
  if (loading || leftOutline === undefined || rightOutline === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader size={18} className="text-brand" />
      </div>
    );
  }

  // The picked step and what changed in it.
  const side: "left" | "right" | null = picked.right ? "right" : picked.left ? "left" : null;
  const id = side ? picked[side] : null;
  const step = side && id ? (side === "right" ? rightSteps : leftSteps).get(id) ?? null : null;
  const before = picked.left ? leftSteps.get(picked.left) ?? null : null;
  const after = picked.right ? rightSteps.get(picked.right) ?? null : null;
  const fields = step && step.kind !== "branch" ? stepFieldChanges(before, after) : [];
  const shownDetail = detail;
  const stepMarks = side && id ? marks[side].get(id) ?? [] : [];

  const canvas = (which: "left" | "right", outline: OutlineNode[] | null, label: string, key: string) => (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="shrink-0 truncate border-b border-line bg-s1 px-4 py-1.5 text-[11.5px] text-subtle" title={label}>
        {label}
      </div>
      <div className="min-h-0 flex-1" style={{ background: "var(--editor-bg)" }}>
        {outline ? (
          <FlowDesigner
            key={key}
            connId=""
            flowId=""
            outline={outline}
            selectedId={picked[which]}
            onSelect={which === "left" ? pickLeft : pickRight}
            flowName={flowName}
            onOpenFlow={noop}
            childFlow={NO_CHILD}
            onShowInJson={noop}
            theme={theme}
            marks={marks[which]}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-subtle">This version isn't a cloud flow definition the designer can draw. Use JSON.</div>
        )}
      </div>
    </div>
  );

  const picking = !!(step && side && step.kind !== "branch");
  const panelFor = (which: "left" | "right", n: OutlineNode) => (
    <div className="flex min-h-0 min-w-0 flex-col [&>aside]:!w-full [&>aside]:!border-l-0">
      <FlowStepPanel
        key={`${which}|${n.id}`}
        connId={connId ?? ""}
        step={n}
        tab={panelTab}
        onTab={setPanelTab}
        index={which === "left" ? leftIndex : rightIndex}
        onSelectKey={(key) => {
          const k = (which === "left" ? leftIndex : rightIndex).byKey.get(key);
          if (k) onPick(which, k.id);
        }}
        flowName={flowName}
        onOpenFlow={noop}
        onShowInJson={() => onShowInJson(which, n.path)}
        onClose={() => onPick(which, null)}
      />
    </div>
  );
  return (
    <div ref={boxRef} className="flex min-h-0 flex-col">
      <div className={`grid min-h-0 min-w-0 flex-1 ${single ? "grid-cols-1" : "grid-cols-2 divide-x divide-line"}`}>
        {!single && canvas("left", leftOutline, leftLabel, `l|${leftKey}`)}
        {canvas("right", rightOutline, rightLabel, `r|${rightKey}|${single ? 1 : 2}`)}
      </div>
      {picking && step && side && (
        <section className="flex shrink-0 flex-col border-t border-line bg-s1" style={{ height: drawerH }} aria-label={`Step ${step.name}`}>
          {/* Drag (or arrow keys) to give the canvases or the details more room. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the step details"
            aria-valuenow={drawerH}
            tabIndex={0}
            className="group -mt-1.5 flex h-3 shrink-0 cursor-row-resize items-center justify-center focus-visible:outline-none"
            onPointerDown={startResize}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                setDrawer(drawerH + (e.key === "ArrowUp" ? 24 : -24));
              }
            }}
          >
            <span className="h-1 w-10 rounded-full bg-line-strong transition-colors group-hover:bg-brand group-focus-visible:bg-brand" />
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 pb-2">
            <div className="seg" role="tablist" aria-label="Step details">
              <button role="tab" aria-pressed={shownDetail === "changes"} aria-selected={shownDetail === "changes"} onClick={() => setDetail("changes")}>
                What changed
              </button>
              <button role="tab" aria-pressed={shownDetail !== "changes"} aria-selected={shownDetail !== "changes"} onClick={() => setDetail("both")}>
                Before &amp; after
              </button>
            </div>
            <span className="min-w-0 max-w-[40%] shrink-0 truncate text-sm font-medium" title={step.name}>
              {step.name}
            </span>
            {stepMarks.map((m) => (
              <span key={m} className={`badge ${MARK_BADGE[m]} shrink-0`}>
                {MARK_TEXT[m]}
              </span>
            ))}
            <span className="hidden min-w-0 truncate text-xs text-subtle lg:inline">{[step.type, step.detail].filter(Boolean).join(" · ")}</span>
            <button className="btn btn-ghost btn-sm ml-auto shrink-0" onClick={() => onShowInJson(side, step.path)}>
              Show in JSON
            </button>
            <button className="btn btn-ghost btn-icon btn-sm shrink-0" onClick={() => onPick(side, null)} aria-label="Close" title="Close (Esc)">
              <X size={14} />
            </button>
          </div>
          {shownDetail === "changes" ? (
            <StepChanges step={step} fields={fields} onlyLeft={!after} onlyRight={!before} />
          ) : (
            <div className={`grid min-h-0 flex-1 ${before && after ? "grid-cols-2 divide-x divide-line" : "grid-cols-1"}`}>
              {before && (
                <div className="flex min-h-0 flex-col">
                  <div className="shrink-0 border-b border-line bg-s2 px-4 py-1 text-[11.5px] text-subtle">Before · {leftLabel}</div>
                  {panelFor("left", before)}
                </div>
              )}
              {after && (
                <div className="flex min-h-0 flex-col">
                  <div className="shrink-0 border-b border-line bg-s2 px-4 py-1 text-[11.5px] text-subtle">After · {rightLabel}</div>
                  {panelFor("right", after)}
                </div>
              )}
            </div>
          )}
        </section>
      )}
      {!picking && (
        <div className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-s1 px-4 py-2 text-xs text-subtle">
          Pick a step to see what changed in it.
          {(["added", "removed", "changed", "moved"] as DiffMark[]).map((m) => (
            <span key={m} className="flex items-center gap-1.5">
              <span className={`flow-legend is-${m}`} /> {m === "moved" ? "Moved / renamed" : MARK_TEXT[m]}
            </span>
          ))}
          {single && <span>· removed steps show only with Side by side</span>}
        </div>
      )}
    </div>
  );
}

const FIELD_TONE: Record<FieldChange["kind"], string> = {
  added: "text-success",
  removed: "text-danger",
  changed: "text-warning",
};

/** A value as people read it: text as is, the rest as JSON. */
function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v, null, 2);
}

/** What changed in one step, value by value, top to bottom. */
function StepChanges({ step, fields, onlyLeft, onlyRight }: { step: OutlineNode; fields: FieldChange[]; onlyLeft: boolean; onlyRight: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      {(onlyLeft || onlyRight) && (
        <div className="mb-2 px-1 text-xs text-muted">{onlyRight ? "Only in the right version — everything below is new." : "Only in the left version — everything below is gone."}</div>
      )}
      {fields.length === 0 ? (
        <div className="flex items-center gap-1.5 px-1 text-xs text-subtle">
          <Check size={12} className="text-success" /> Its own settings are the same on both sides{step.children.length ? " (steps inside it may differ)" : ""}.
        </div>
      ) : (
        // One step, one table: a row per value, top to bottom.
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-s2">
          {fields.map((f) => (
            <li key={f.path.join("/")} className="grid grid-cols-[minmax(150px,26%)_minmax(0,1fr)]">
              <div className="min-w-0 border-r border-line px-3 py-2">
                <span className={`block text-[11px] font-semibold ${FIELD_TONE[f.kind]}`}>{f.kind === "added" ? "Added" : f.kind === "removed" ? "Removed" : "Changed"}</span>
                <span className="block break-all font-mono text-[11.5px] text-muted">{f.path.join(" › ")}</span>
              </div>
              <div className="min-w-0 space-y-1 p-1.5">
                {f.kind !== "added" && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-danger/10 px-2 py-1.5 font-mono text-[11.5px] leading-[1.45]" title="Before">
                    <span className="select-none text-danger">− </span>
                    {show(f.before)}
                  </pre>
                )}
                {f.kind !== "removed" && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-success/10 px-2 py-1.5 font-mono text-[11.5px] leading-[1.45]" title="After">
                    <span className="select-none text-success">+ </span>
                    {show(f.after)}
                  </pre>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function buildable(a: string | undefined, b: string | undefined) {
  try {
    return !!a && !!b && !!JSON.parse(a) && !!JSON.parse(b);
  } catch {
    return false;
  }
}

function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-2 pb-3 pt-3">
      <div className="mb-1.5 flex items-baseline gap-2 px-2">
        <span className="text-[12.5px] font-medium">{title}</span>
        {!!count && <span className="text-xs tabular-nums text-subtle">{count}</span>}
        {hint && (
          <span className="ml-auto truncate text-[11px] text-subtle" title={hint}>
            {hint}
          </span>
        )}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

function Pending() {
  return (
    <li className="space-y-1.5 px-2 py-1">
      <div className="skeleton h-3 w-3/4" />
      <div className="skeleton h-3 w-1/2" />
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <li className="flex items-center gap-1.5 px-2 py-1 text-xs text-subtle">{children}</li>;
}

function ChangeRow({ change, onPick }: { change: FlowChange; onPick: () => void }) {
  return (
    <li>
      <button className="w-full rounded-md px-2 py-1.5 text-left hover:bg-s3" onClick={onPick} title={`${change.name}${change.type ? ` (${change.type})` : ""}${change.detail ? ` — ${change.detail}` : ""}`}>
        <span className="flex items-baseline gap-2">
          <span className={`w-[68px] shrink-0 text-[11.5px] font-medium ${KIND_TONE[change.kind]}`}>{KIND_LABEL[change.kind]}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{change.name}</span>
        </span>
        {change.detail && <span className="block truncate pl-[76px] text-[11.5px] text-subtle">{change.detail}</span>}
      </button>
    </li>
  );
}

function ProblemRow({ problem, onPick }: { problem: FlowProblem; onPick: () => void }) {
  const error = problem.level === "error";
  return (
    <li>
      <button className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-s3" onClick={onPick}>
        {error ? <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" /> : <Info size={13} className="mt-0.5 shrink-0 text-warning" />}
        <span className="text-[12px] leading-snug">{problem.message}</span>
      </button>
    </li>
  );
}
