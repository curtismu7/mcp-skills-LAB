import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState } from "@xyflow/react";
import { ArrowNoLabel, EdgeLabels, FitOpen, Passport, PassportActions } from "./diagram-kit/DiagramKit.jsx";
import { boxPassport, slotPoint } from "./diagram-kit/diagramKit.js";
import "./diagram-kit/diagram-kit.css";
import { REFIT_EVENT, useFitOnResize } from "./useFitOnResize.js";

// The nodes, edges and steps come from diagram-studio/1 data loaded by name from the server (rule 17); nothing is built by hand here. Boxes are draggable,
// Reset puts every box back where the data says. The edges of the current step light up; earlier steps' edges stay marked as seen.
const FIT = { padding: 0.12 };
// Dragged positions are kept for the session (a change of tab unmounts the diagram); Reset clears them.
let saved = {};
export const clearSavedPositions = () => { saved = {}; };
const withSaved = (nodes) => nodes.map((n) => (saved[n.id] ? { ...n, position: saved[n.id] } : n));
const SLOTS = [20, 50, 80]; // parallel edges between the same two boxes use different points along the side, so their lines and labels do not overlap
const SIDES = { r: Position.Right, l: Position.Left, t: Position.Top, b: Position.Bottom };

function Box({ data }) {
  return (
    <div className={`flow-node flow-node--${data.color}${data.passport ? " dk-open" : ""}`}>
      {["r", "l", "t", "b"].flatMap((side) => SLOTS.map((pct, i) => (
        <span key={`${side}${i}`}>
          <Handle id={`s-${side}${i}`} type="source" position={SIDES[side]} className="flow-handle" style={side === "r" || side === "l" ? { top: `${pct}%` } : { left: `${pct}%` }} />
          <Handle id={`t-${side}${i}`} type="target" position={SIDES[side]} className="flow-handle" style={side === "r" || side === "l" ? { top: `${pct}%` } : { left: `${pct}%` }} />
        </span>
      )))}
      <strong>{data.label}</strong>
      {(data.sub ?? []).map((s) => <span className="flow-node__sub" key={s}>{s}</span>)}
      {data.passport && <Passport p={data.passport} />}
    </div>
  );
}
const nodeTypes = { box: Box };

function facing(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ["r", "l"] : ["l", "r"]) : (dy > 0 ? ["b", "t"] : ["t", "b"]);
}

/** The graph for the diagram document at step `step` (-1: before the first). Exported for tests. */
export function buildGraph(diagram, step) {
  const at = Object.fromEntries(diagram.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const nodes = diagram.nodes.map((n) => ({ id: n.id, type: "box", position: { x: n.x, y: n.y }, data: { label: n.label, sub: n.sub, color: diagram.groups[n.group].color } }));
  const steps = diagram.steps ?? [];
  const now = new Set(step >= 0 ? steps[step]?.edges ?? [] : []);
  const seen = new Set(steps.slice(0, Math.max(step, 0)).flatMap((s) => s.edges));
  const pair = {};
  const edges = diagram.edges.map((e, i) => {
    const k = [e.source, e.target].sort().join("|");
    const slot = pair[k] = (pair[k] ?? -1) + 1;
    const [a, b] = facing(at[e.source], at[e.target]);
    const state = now.has(i) ? "now" : seen.has(i) ? "seen" : "idle";
    return { id: `e${i}`, type: "arrow", source: e.source, target: e.target, sourceHandle: `s-${a}${slot % 3}`, targetHandle: `t-${b}${slot % 3}`, animated: state === "now", className: `flow-edge flow-edge--${state}`, markerEnd: { type: MarkerType.ArrowClosed } };
  });
  return { nodes, edges };
}

// One label item per arrow, for the kit's EdgeLabels layer (above the boxes, never overlapping).
export function toLabelItems(diagram, step) {
  const steps = diagram.steps ?? [];
  const active = step >= 0 ? new Set(steps[step]?.edges ?? []) : new Set();
  return diagram.edges.map((e, i) => ({ id: `e${i}`, text: e.label ?? "", source: e.source, target: e.target, active: active.has(i), dim: active.size > 0 && !active.has(i) }));
}

// The kit's point helper for this lab's slot handles ("s-r1" / "t-l2" -> slot "r1" / "l2").
export const labelPointFor = (box, handle) => slotPoint(box, String(handle).replace(/^[st]-/, ""));

function Canvas({ diagram, step, resetKey }) {
  const ref = useRef(null);
  const graph = useMemo(() => buildGraph(diagram, step), [diagram, step]);
  // Click a box and it expands in place with its details (the shared diagram kit's Passport, §8c).
  const [open, setOpen] = useState(null);
  const passportGraph = useMemo(() => ({
    nodes: diagram.nodes.map((n) => ({ id: n.id, label: n.label, sub: n.sub ?? [], group: n.group })),
    edges: diagram.edges.map((e) => ({ source: e.source, target: e.target, label: e.label ?? "" })),
    groups: diagram.groups,
  }), [diagram]);
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState(withSaved(graph.nodes));
  const onNodesChange = (changes) => { for (const c of changes) if (c.position) saved[c.id] = c.position; onNodesChangeRaw(changes); };
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  useFitOnResize(ref, FIT);
  // A new step re-lights the edges but keeps wherever the person dragged the boxes.
  useEffect(() => { setNodes((cur) => graph.nodes.map((n) => ({ ...n, position: cur.find((c) => c.id === n.id)?.position ?? n.position }))); setEdges(graph.edges); }, [graph, setNodes, setEdges]);
  // Reset puts every box back where the diagram data says.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } clearSavedPositions(); setOpen(null); setNodes(graph.nodes); setTimeout(() => window.dispatchEvent(new Event(REFIT_EVENT)), 0); }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const withPassport = useMemo(() => nodes.map((n) => ({
    ...n,
    zIndex: n.id === open ? 10 : undefined,
    data: { ...n.data, passport: n.id === open ? boxPassport(passportGraph, n.id) : null },
  })), [nodes, open, passportGraph]);
  const items = useMemo(() => toLabelItems(diagram, step), [diagram, step]);
  const actions = useMemo(() => ({
    open: (id) => setOpen(id),
    close: () => setOpen(null),
    link: (id) => { const u = new URL(window.location.href); u.searchParams.set("box", id); return u.toString(); },
  }), []);
  return (
    <div ref={ref} className="flow" data-testid="flow">
      <PassportActions.Provider value={actions}>
        <ReactFlow nodes={withPassport} edges={edges} nodeTypes={nodeTypes} edgeTypes={{ arrow: ArrowNoLabel }} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onNodeClick={(_, n) => setOpen((o) => (o === n.id ? null : n.id))} onPaneClick={() => setOpen(null)}
          fitView fitViewOptions={FIT} nodesDraggable nodesConnectable={false} minZoom={0.3} proOptions={{ hideAttribution: true }}>
          <Background /><Controls showInteractive={false} />
          <EdgeLabels items={items} pointFor={labelPointFor} fallback={{ w: 180, h: 92 }} />
          <FitOpen open={open} closePadding={0.08} />
        </ReactFlow>
      </PassportActions.Provider>
    </div>
  );
}

export default function FlowDiagram({ diagram, step, resetKey }) {
  if (!diagram) return <p className="muted">Loading the diagram...</p>;
  return (
    <section aria-label={diagram.title}>
      <ReactFlowProvider><Canvas diagram={diagram} step={step} resetKey={resetKey} /></ReactFlowProvider>
    </section>
  );
}
