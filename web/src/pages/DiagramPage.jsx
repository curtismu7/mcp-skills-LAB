import { useCallback, useEffect, useRef, useState } from "react";
import FlowDiagram from "../FlowDiagram.jsx";
import { getDiagram } from "../api.js";

const SPEEDS = [0.5, 1, 2, 4];
export const DIAGRAM = "skills-flow";

export default function DiagramPage({ resetKey }) {
  const [diagram, setDiagram] = useState(null);
  const [step, setStep] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [err, setErr] = useState("");
  const [boxKey, setBoxKey] = useState(0);
  const timer = useRef(null);
  const steps = diagram?.steps ?? [];

  useEffect(() => { getDiagram(DIAGRAM).then(setDiagram).catch((e) => setErr(e.message)); return () => clearTimeout(timer.current); }, []);
  // Simulate: step through the flow, one step per tick; the speed changes the tick.
  useEffect(() => {
    clearTimeout(timer.current);
    if (!playing) return undefined;
    if (step >= steps.length - 1) { setPlaying(false); return undefined; }
    timer.current = setTimeout(() => setStep((s) => s + 1), 1600 / speed);
    return () => clearTimeout(timer.current);
  }, [playing, step, speed, steps.length]);
  const reset = useCallback(() => { clearTimeout(timer.current); setPlaying(false); setStep(-1); setBoxKey((k) => k + 1); }, []);
  useEffect(() => { if (resetKey) reset(); }, [resetKey, reset]);

  const simulate = () => { setStep(0); setPlaying(true); };
  const cur = steps[step];
  return (
    <>
      <div className="page-head"><h1>How discovery, reading and verifying fit together</h1></div>
      <p className="muted">{diagram?.lede ?? "Loading..."} Drag any box; drag the background to pan.</p>
      {err && <p className="field-error" role="alert">{err}</p>}
      <section className="controls" aria-label="Diagram controls">
        <button type="button" className="primary" onClick={simulate} data-testid="simulate">{playing ? "Restart" : "Simulate"}</button>
        <button type="button" aria-disabled={step <= 0} onClick={() => { setPlaying(false); if (step > 0) setStep(step - 1); }} data-testid="prev">Previous step</button>
        <button type="button" aria-disabled={step >= steps.length - 1} onClick={() => { setPlaying(false); if (step < steps.length - 1) setStep(step + 1); }} data-testid="next">Next step</button>
        <label>Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} data-testid="speed">{SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}</select>
        </label>
        <button type="button" onClick={reset} data-testid="diagram-reset">Reset diagram</button>
      </section>
      <FlowDiagram diagram={diagram} step={step} resetKey={boxKey} />
      <div className="dg-now" role="status" aria-live="polite" data-testid="step-now">
        {cur ? <><b>Step {step + 1} of {steps.length}: {cur.title}.</b> {cur.what} <span className="muted">{cur.why}</span></> : <span>Press Simulate, or Next step, to walk through the flow.</span>}
      </div>
    </>
  );
}
