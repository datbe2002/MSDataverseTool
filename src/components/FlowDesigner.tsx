// Designer tab: the flow drawn as cards like the Power Automate designer
// (read-only), with a side panel for the picked step. Layout: lib/flowGraph.ts.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CARD_H, CARD_W, containerIds, layoutFlow, type GraphNode } from "../lib/flowGraph";
import { inlineOwners, withChildFlows, type ChildFlow, type OutlineNode } from "../lib/flowOutline";
import { indexFlow, type FlowIndex } from "../lib/flowRefs";
import { queryTerms, searchSteps } from "../lib/flowSearch";
import { StepSearchBox } from "./StepSearch";
import { StepIcon } from "./StepIcon";
import { FlowStepPanel, type PanelTab } from "./FlowStepPanel";
import { ArrowUpRight, ChevronDown } from "./Icon";

interface Props {
  /** Connection the flow is in (choice labels are read from its tables). */
  connId: string;
  /** Id of the flow shown (a child flow running it again isn't expanded). */
  flowId: string;
  outline: OutlineNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  flowName: (flowId: string) => string | null;
  /** Opens another flow; `from` is the step it's opened from (Back returns to it). */
  onOpenFlow: (flowId: string, from?: string) => void;
  /** A child flow's definition, to show it inside the step that runs it. */
  childFlow: (flowId: string) => ChildFlow;
  onShowInJson: (step: OutlineNode) => void;
  theme: "dark" | "light";
}

interface NodeData extends Record<string, unknown> {
  g: GraphNode;
  selected: boolean;
  /** Matches the search (a collapsed container: something inside does). */
  match: boolean;
  childName: string | null;
  onToggle: (id: string) => void;
  onOpenFlow: (id: string, from?: string) => void;
}

type FlowNode = Node<NodeData>;

const SEP = "\u0001";

function subtitle(step: OutlineNode, childName: string | null, hidden?: number) {
  const same = step.type.toLowerCase() === step.name.toLowerCase();
  const parts = [same ? "" : step.type, step.childFlowId ? childName ?? "flow not in this environment" : step.detail];
  if (hidden !== undefined) parts.push(`${hidden} step${hidden === 1 ? "" : "s"}`);
  return parts.filter(Boolean).join(" · ");
}

const hidden = { opacity: 0, pointerEvents: "none" } as const;

/** Canvas width the step panel covers: it floats over a narrow designer (see FlowStepPanel). */
function panelOver(box: HTMLElement): number {
  const aside = box.parentElement?.querySelector(":scope > aside");
  return aside instanceof HTMLElement && getComputedStyle(aside).position === "absolute" ? aside.offsetWidth : 0;
}

/** The card of one step (also a collapsed container). */
function CardBody({ data, children }: { data: NodeData; children?: React.ReactNode }) {
  const step = data.g.step!;
  return (
    <div
      className={`flow-card ${data.selected ? "is-selected" : ""} ${data.match ? "is-match" : ""}`}
      style={{ width: CARD_W, height: CARD_H }}
    >
      <StepIcon step={step} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium leading-5">{step.name}</div>
        <div className={`truncate text-[11.5px] leading-4 ${step.childFlowId && data.childName ? "text-brand" : "text-subtle"}`}>
          {subtitle(step, data.childName, data.g.hidden)}
        </div>
      </div>
      {step.runAfter && (
        <span className="flow-card-flag" title={step.runAfter}>
          !
        </span>
      )}
      {step.childFlowId && data.childName && (
        <button
          className="btn btn-ghost btn-icon btn-sm nodrag shrink-0"
          title={`Open child flow “${data.childName}”`}
          aria-label={`Open child flow ${data.childName}`}
          onClick={(e) => {
            e.stopPropagation();
            data.onOpenFlow(step.childFlowId!, step.id);
          }}
        >
          <ArrowUpRight size={13} />
        </button>
      )}
      {children}
    </div>
  );
}

const CardNode = memo(function CardNode({ data }: NodeProps<FlowNode>) {
  const g = data.g;
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" isConnectable={false} style={hidden} />
      <CardBody data={data}>
        {g.step!.childFlowId && data.childName && (
          <button
            className="btn btn-ghost btn-icon btn-sm nodrag shrink-0"
            title="Show the child flow here"
            aria-label="Show the child flow here"
            onClick={(e) => {
              e.stopPropagation();
              data.onToggle(g.id);
            }}
          >
            <ChevronDown size={14} />
          </button>
        )}
        {g.hidden !== undefined && (
          <button
            className="btn btn-ghost btn-icon btn-sm nodrag shrink-0"
            title={`Expand (${g.hidden} steps inside)`}
            aria-label="Expand"
            onClick={(e) => {
              e.stopPropagation();
              data.onToggle(g.id);
            }}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </CardBody>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable={false} style={hidden} />
    </>
  );
});

const FrameNode = memo(function FrameNode({ data }: NodeProps<FlowNode>) {
  const g = data.g;
  const tone = g.step!.inline
    ? "is-child"
    : g.step!.actionType === "If" || g.step!.actionType === "Switch"
    ? "is-branch"
    : "";
  return (
    <div className="relative" style={{ width: g.w, height: g.h }}>
      <Handle type="target" position={Position.Top} id="in" isConnectable={false} style={hidden} />
      <div className={`flow-frame ${tone}`} style={{ top: CARD_H / 2 }} />
      <div className="absolute top-0" style={{ left: (g.w - CARD_W) / 2 }}>
        <CardBody data={data}>
          <button
            className="btn btn-ghost btn-icon btn-sm nodrag shrink-0"
            title={g.step!.inline ? "Hide the child flow" : "Collapse"}
            aria-label={g.step!.inline ? "Hide the child flow" : "Collapse"}
            onClick={(e) => {
              e.stopPropagation();
              data.onToggle(g.id);
            }}
          >
            <ChevronDown size={14} className="rotate-180" />
          </button>
        </CardBody>
        <Handle type="source" position={Position.Bottom} id="inner" isConnectable={false} style={hidden} />
      </div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable={false} style={hidden} />
    </div>
  );
});

const PillNode = memo(function PillNode({ data }: NodeProps<FlowNode>) {
  const label = data.g.label ?? "";
  const tone = label === "True" ? "is-true" : label === "False" ? "is-false" : "";
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" isConnectable={false} style={hidden} />
      <div className={`flow-pill ${tone}`} style={{ width: data.g.w, height: data.g.h }} title={label}>
        <span className="truncate">{label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable={false} style={hidden} />
    </>
  );
});

const EmptyNode = memo(function EmptyNode({ data }: NodeProps<FlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" isConnectable={false} style={hidden} />
      <div className="flow-empty" style={{ width: data.g.w, height: data.g.h }}>
        {data.g.label ?? "No steps"}
      </div>
    </>
  );
});

const nodeTypes = { card: CardNode, frame: FrameNode, pill: PillNode, empty: EmptyNode };

export function FlowDesigner(props: Props) {
  return (
    <ReactFlowProvider>
      <Designer {...props} />
    </ReactFlowProvider>
  );
}

function Designer({ connId, flowId, outline: own, selectedId, onSelect, flowName, onOpenFlow, childFlow, onShowInJson, theme }: Props) {
  const rf = useReactFlow();
  const boxRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // "Run a Child Flow" steps showing their child flow inside them.
  const [inlined, setInlined] = useState<Set<string>>(() => new Set());
  const { outline, scopes } = useMemo(
    () => withChildFlows(own, inlined, childFlow, flowId),
    [own, inlined, childFlow, flowId]
  );
  const graph = useMemo(() => layoutFlow(outline, collapsed), [outline, collapsed]);
  // References resolve within one flow: this one, or the child flow a step belongs to.
  const indexes = useMemo(() => {
    const map = new Map<string, FlowIndex>([["", indexFlow(own)]]);
    for (const [owner, steps] of scopes) map.set(owner, indexFlow(steps));
    return map;
  }, [own, scopes]);
  const stepsById = useMemo(() => {
    const map = new Map<string, OutlineNode>();
    const walk = (nodes: OutlineNode[]) => nodes.forEach((n) => (map.set(n.id, n), walk(n.children)));
    walk(outline);
    return map;
  }, [outline]);
  const selected = selectedId ? stepsById.get(selectedId) ?? null : null;
  const index = indexes.get(selected?.owner ?? "") ?? indexes.get("")!;
  const [panelTab, setPanelTab] = useState<PanelTab>("parameters");

  // Search: matching cards are marked, the rest fade; picking one selects it
  // (which opens its containers and scrolls it into view).
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const terms = useMemo(() => queryTerms(query), [query]);
  const matches = useMemo(
    () => searchSteps(outline, query, (st) => (st.childFlowId ? flowName(st.childFlowId) : null)),
    [outline, query, flowName]
  );
  const current = matches.findIndex((m) => m.step.id === selectedId);
  // Matched ids plus every container around them (so a collapsed one shows it).
  const matchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of matches) {
      const parts = m.step.id.split(SEP);
      for (let i = 1; i <= parts.length; i++) ids.add(parts.slice(0, i).join(SEP));
    }
    return ids;
  }, [matches]);
  const exactIds = useMemo(() => new Set(matches.map((m) => m.step.id)), [matches]);
  const searching = terms.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const toggle = useCallback(
    (id: string) => {
      const flip = (prev: Set<string>) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      };
      // The card of a "Run a Child Flow" step opens / closes its child flow.
      if (stepsById.get(id)?.childFlowId) setInlined(flip);
      else setCollapsed(flip);
    },
    [stepsById]
  );

  const nodes: FlowNode[] = useMemo(
    () =>
      graph.nodes.map((g) => {
        // Cards (incl. collapsed containers) and frame headers get marked;
        // only cards fade, so frames keep the shape of the flow readable.
        const match =
          searching && (g.kind === "card" ? matchIds.has(g.id) : g.kind === "frame" && exactIds.has(g.id));
        return {
          id: g.id,
          type: g.kind,
          className: searching && g.kind === "card" && !match ? "is-dimmed" : undefined,
          position: { x: g.x, y: g.y },
          width: g.w,
          height: g.h,
          draggable: false,
          selectable: false,
          focusable: false,
          // Frames behind edges, cards above them.
          zIndex: g.kind === "frame" ? g.depth : 1000,
          data: {
            g,
            selected: g.id === selectedId,
            match,
            childName: g.step?.childFlowId ? flowName(g.step.childFlowId) : null,
            onToggle: toggle,
            onOpenFlow,
          },
        };
      }),
    [graph, selectedId, flowName, toggle, onOpenFlow, searching, matchIds, exactIds]
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const color = e.when ? "var(--warning)" : "var(--line-strong)";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: "in",
          type: "smoothstep",
          pathOptions: { borderRadius: 10 },
          zIndex: 500,
          focusable: false,
          selectable: false,
          style: e.when ? { stroke: color, strokeDasharray: "5 4", strokeWidth: 1.5 } : { stroke: color, strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
          label: e.when ? `if ${e.when.map((s) => s.toLowerCase()).join(" / ")}` : undefined,
          labelStyle: { fill: "var(--warning)", fontSize: 11, fontWeight: 500 },
          labelBgStyle: { fill: "var(--editor-bg)" },
          labelBgPadding: [4, 2] as [number, number],
        };
      }),
    [graph]
  );

  // Picking a step inside a collapsed container opens that container (and
  // the child flows it's in, e.g. coming Back to a step of one).
  useEffect(() => {
    if (!selectedId) return;
    setCollapsed((prev) => {
      const next = new Set([...prev].filter((id) => !selectedId.startsWith(id + SEP)));
      return next.size === prev.size ? prev : next;
    });
    const owners = inlineOwners(selectedId);
    if (owners.length) setInlined((prev) => (owners.every((o) => prev.has(o)) ? prev : new Set([...prev, ...owners])));
  }, [selectedId]);

  // Set by onInit: before it, React Flow's viewport isn't the one shown yet.
  const [ready, setReady] = useState(false);

  // Bring the picked step into view (after its container or child flow opened).
  useEffect(() => {
    const g = selectedId ? graph.nodes.find((n) => n.id === selectedId) : null;
    const box = boxRef.current;
    if (!ready || !g || !box) return;
    const { x, y, zoom } = rf.getViewport();
    const cardW = g.kind === "frame" ? CARD_W : g.w;
    const left = g.x + (g.w - cardW) / 2;
    const sx = left * zoom + x;
    const sy = g.y * zoom + y;
    const covered = panelOver(box);
    const inView = sx >= 0 && sy >= 0 && sx + cardW * zoom <= box.clientWidth - covered && sy + CARD_H * zoom <= box.clientHeight;
    if (!inView) {
      const z = Math.max(zoom, 0.8);
      void rf.setCenter(left + cardW / 2 + covered / 2 / z, g.y + CARD_H / 2, { zoom: z, duration: 300 });
    }
  }, [selectedId, graph, rf, ready]);

  // Open at the top of the flow, as wide as fits (a long flow would shrink to
  // nothing with fitView).
  // A step picked in the JSON tab is centred instead.
  const onInit = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    setReady(true);
    // A step inside a child flow that's still opening: centred once it's drawn.
    if (selectedId) {
      const picked = graph.nodes.find((n) => n.id === selectedId);
      if (picked) void rf.setCenter(picked.x + picked.w / 2 + panelOver(box) / 2 / 0.9, picked.y + CARD_H / 2, { zoom: 0.9 });
      return;
    }
    // Readable first: never below 60%, even if the widest part doesn't fit.
    const zoom = Math.min(1, Math.max(0.6, (box.clientWidth - 80) / graph.width));
    void rf.setViewport({ x: (box.clientWidth - graph.width * zoom) / 2, y: 32, zoom });
  }, [rf, graph, selectedId]);

  const onNodeClick = useCallback(
    (e: React.MouseEvent, node: FlowNode) => {
      // A frame is picked by its header card, not by its empty area.
      if (!(e.target as HTMLElement).closest(".flow-card")) return;
      if (node.data.g.step) onSelect(node.data.g.step.id);
    },
    [onSelect]
  );

  const selectKey = useCallback(
    (key: string) => {
      const step = index.byKey.get(key);
      if (step) onSelect(step.id);
    },
    [index, onSelect]
  );

  return (
    <div
      className="@container/designer relative flex h-full min-h-0"
      onKeyDown={(e) => {
        if (e.key === "Escape" && selectedId) onSelect(null);
      }}
    >
      <div ref={boxRef} className="@container relative min-w-0 flex-1">
        <ReactFlow
          className="hexa-flow"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          onInit={onInit}
          onNodeClick={onNodeClick}
          onPaneClick={() => onSelect(null)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          minZoom={0.1}
          maxZoom={1.5}
          proOptions={{ hideAttribution: false }}
          attributionPosition="top-right"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Panel position="top-left" className="flex max-w-[calc(100%-30px)] flex-wrap items-start gap-1.5">
            <StepSearchBox
              ref={searchRef}
              query={query}
              onQuery={setQuery}
              matches={matches}
              terms={terms}
              current={current}
              onPick={(i) => onSelect(matches[i].step.id)}
            />
            <button className="btn btn-secondary btn-sm !h-8 !rounded-[7px]" onClick={() => void rf.fitView({ padding: 0.08, duration: 300 })} title="Show the whole flow">
              Fit
            </button>
            <button className="btn btn-secondary btn-sm !h-8 !rounded-[7px]" onClick={() => setCollapsed(new Set())} title="Open every Scope, loop, Condition and Switch">
              Expand all
            </button>
            <button
              className="btn btn-secondary btn-sm !h-8 !rounded-[7px]"
              onClick={() => {
                setCollapsed(new Set(containerIds(own)));
                setInlined(new Set());
              }}
              title="Show every Scope, loop, Condition and Switch as one card, and hide child flows"
            >
              Collapse all
            </button>
          </Panel>
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            className="@max-xl:!hidden short:!hidden"
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(n) => ((n as FlowNode).data.g.kind === "frame" ? "transparent" : "var(--line-strong)")}
            nodeStrokeColor={(n) => ((n as FlowNode).data.g.kind === "frame" ? "var(--line-strong)" : "transparent")}
            nodeBorderRadius={4}
          />
        </ReactFlow>
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-s1/90 px-2 py-1 text-[11px] text-subtle shadow-sm @max-xl:hidden">
          Scroll to move · Ctrl + scroll to zoom
        </div>
      </div>
      {selected && selected.kind !== "branch" && (
        <FlowStepPanel
          key={selected.id}
          connId={connId}
          step={selected}
          tab={panelTab}
          onTab={setPanelTab}
          index={index}
          onSelectKey={selectKey}
          flowName={flowName}
          onOpenFlow={(id) => onOpenFlow(id, selected.id)}
          inlined={selected.childFlowId ? inlined.has(selected.id) : undefined}
          onToggleInline={() => toggle(selected.id)}
          onShowInJson={() => onShowInJson(selected)}
          onClose={() => onSelect(null)}
        />
      )}
    </div>
  );
}
