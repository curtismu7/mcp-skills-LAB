import { useEffect, useMemo, useRef } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState } from "@xyflow/react";
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
    <div className={`flow-node flow-node--${data.color}`}>
      {["r", "l", "t", "b"].flatMap((side) => SLOTS.map((pct, i) => (
        <span key={`${side}${i}`}>
          <Handle id={`s-${side}${i}`} type="source" position={SIDES[side]} className="flow-handle" style={side === "r" || side === "l" ? { top: `${pct}%` } : { left: `${pct}%` }} />
          <Handle id={`t-${side}${i}`} type="target" position={SIDES[side]} className="flow-handle" style={side === "r" || side === "l" ? { top: `${pct}%` } : { left: `${pct}%` }} />
        </span>
      )))}
      <strong>{data.label}</strong>
      {(data.sub ?? []).map((s) => <span className="flow-node__sub" key={s}>{s}</span>)}
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
    return { id: `e${i}`, source: e.source, target: e.target, sourceHandle: `s-${a}${slot % 3}`, targetHandle: `t-${b}${slot % 3}`, label: e.label ?? "", animated: state === "now", className: `flow-edge flow-edge--${state}`, markerEnd: { type: MarkerType.ArrowClosed } };
  });
  return { nodes, edges };
}

function Canvas({ diagram, step, resetKey }) {
  const ref = useRef(null);
  const graph = useMemo(() => buildGraph(diagram, step), [diagram, step]);
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState(withSaved(graph.nodes));
  const onNodesChange = (changes) => { for (const c of changes) if (c.position) saved[c.id] = c.position; onNodesChangeRaw(changes); };
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  useFitOnResize(ref, FIT);
  // A new step re-lights the edges but keeps wherever the person dragged the boxes.
  useEffect(() => { setNodes((cur) => graph.nodes.map((n) => ({ ...n, position: cur.find((c) => c.id === n.id)?.position ?? n.position }))); setEdges(graph.edges); }, [graph, setNodes, setEdges]);
  // Reset puts every box back where the diagram data says.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } clearSavedPositions(); setNodes(graph.nodes); setTimeout(() => window.dispatchEvent(new Event(REFIT_EVENT)), 0); }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className="flow" data-testid="flow">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} fitView fitViewOptions={FIT} nodesDraggable nodesConnectable={false} minZoom={0.3} proOptions={{ hideAttribution: true }}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow>
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
