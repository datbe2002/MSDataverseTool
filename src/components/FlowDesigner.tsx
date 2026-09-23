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
import type { OutlineNode } from "../lib/flowOutline";
import { indexFlow } from "../lib/flowRefs";
import { queryTerms, searchSteps } from "../lib/flowSearch";
import { StepSearchBox } from "./StepSearch";
import { StepIcon } from "./StepIcon";
import { FlowStepPanel, type PanelTab } from "./FlowStepPanel";
import { ArrowUpRight, ChevronDown } from "./Icon";

interface Props {
  outline: OutlineNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  flowName: (flowId: string) => string | null;
  onOpenFlow: (flowId: string) => void;
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
  onOpenFlow: (id: string) => void;
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
            data.onOpenFlow(step.childFlowId!);
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
  const tone = g.step!.actionType === "If" || g.step!.actionType === "Switch" ? "is-branch" : "";
  return (
    <div className="relative" style={{ width: g.w, height: g.h }}>
      <Handle type="target" position={Position.Top} id="in" isConnectable={false} style={hidden} />
      <div className={`flow-frame ${tone}`} style={{ top: CARD_H / 2 }} />
      <div className="absolute top-0" style={{ left: (g.w - CARD_W) / 2 }}>
        <CardBody data={data}>
          <button
            className="btn btn-ghost btn-icon btn-sm nodrag shrink-0"
            title="Collapse"
            aria-label="Collapse"
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
        No steps
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

function Designer({ outline, selectedId, onSelect, flowName, onOpenFlow, onShowInJson, theme }: Props) {
  const rf = useReactFlow();
  const boxRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const graph = useMemo(() => layoutFlow(outline, collapsed), [outline, collapsed]);
  const index = useMemo(() => indexFlow(outline), [outline]);
  const stepsById = useMemo(() => {
    const map = new Map<string, OutlineNode>();
    const walk = (nodes: OutlineNode[]) => nodes.forEach((n) => (map.set(n.id, n), walk(n.children)));
    walk(outline);
    return map;
  }, [outline]);
  const selected = selectedId ? stepsById.get(selectedId) ?? null : null;
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
    (id: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    []
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

  // Picking a step inside a collapsed container opens that container.
  useEffect(() => {
    if (!selectedId) return;
    setCollapsed((prev) => {
      const next = new Set([...prev].filter((id) => !selectedId.startsWith(id + SEP)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectedId]);

  // Bring the picked step into view (after its container opened).
  useEffect(() => {
    const g = selectedId ? graph.nodes.find((n) => n.id === selectedId) : null;
    const box = boxRef.current;
    if (!g || !box) return;
    const { x, y, zoom } = rf.getViewport();
    const cardW = g.kind === "frame" ? CARD_W : g.w;
    const left = g.x + (g.w - cardW) / 2;
    const sx = left * zoom + x;
    const sy = g.y * zoom + y;
    const inView = sx >= 0 && sy >= 0 && sx + cardW * zoom <= box.clientWidth && sy + CARD_H * zoom <= box.clientHeight;
    if (!inView) {
      void rf.setCenter(left + cardW / 2, g.y + CARD_H / 2, { zoom: Math.max(zoom, 0.8), duration: 300 });
    }
  }, [selectedId, graph, rf]);

  // Open at the top of the flow, as wide as fits (a long flow would shrink to
  // nothing with fitView).
  // A step picked in the JSON tab is centred instead.
  const onInit = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const picked = selectedId ? graph.nodes.find((n) => n.id === selectedId) : null;
    if (picked) {
      void rf.setCenter(picked.x + picked.w / 2, picked.y + CARD_H / 2, { zoom: 0.9 });
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
      className="flex h-full min-h-0"
      onKeyDown={(e) => {
        if (e.key === "Escape" && selectedId) onSelect(null);
      }}
    >
      <div ref={boxRef} className="relative min-w-0 flex-1">
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
          <Panel position="top-left" className="flex items-start gap-1.5">
            <StepSearchBox
              ref={searchRef}
              query={query}
              onQuery={setQuery}
              matches={matches}
              terms={terms}
              current={current}
              onPick={(i) => onSelect(matches[i].step.id)}
            />
            <button className="btn btn-secondary btn-sm" onClick={() => void rf.fitView({ padding: 0.08, duration: 300 })} title="Show the whole flow">
              Fit
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setCollapsed(new Set())} title="Open every Scope, loop, Condition and Switch">
              Expand all
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setCollapsed(new Set(containerIds(outline)))} title="Show every Scope, loop, Condition and Switch as one card">
              Collapse all
            </button>
          </Panel>
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(n) => ((n as FlowNode).data.g.kind === "frame" ? "transparent" : "var(--line-strong)")}
            nodeStrokeColor={(n) => ((n as FlowNode).data.g.kind === "frame" ? "var(--line-strong)" : "transparent")}
            nodeBorderRadius={4}
          />
        </ReactFlow>
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-s1/90 px-2 py-1 text-[11px] text-subtle shadow-sm">
          Scroll to move · Ctrl + scroll to zoom
        </div>
      </div>
      {selected && selected.kind !== "branch" && (
        <FlowStepPanel
          key={selected.id}
          step={selected}
          tab={panelTab}
          onTab={setPanelTab}
          index={index}
          onSelectKey={selectKey}
          flowName={flowName}
          onOpenFlow={onOpenFlow}
          onShowInJson={() => onShowInJson(selected)}
          onClose={() => onSelect(null)}
        />
      )}
    </div>
  );
}
