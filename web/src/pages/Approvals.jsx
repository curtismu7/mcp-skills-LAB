import { useCallback, useEffect, useState } from "react";
import Chip from "../components/Chip.jsx";
import WireView from "../components/WireView.jsx";
import { createBrowse } from "../api.js";

const browse = createBrowse("ap"); // its own session: connecting here never disturbs the Skills tab
const U = "skill://report-writer/SKILL.md";
const h8 = (h) => (h ? h.slice(0, 8) : "none");

export default function Approvals({ resetKey }) {
  const [skill, setSkill] = useState(null);
  const [state, setState] = useState(null);
  const [history, setHistory] = useState([]);    // manifest hashes seen, in order: A, B, A
  const [act, setAct] = useState(null);
  const [run, setRun] = useState(null);
  const [wire, setWire] = useState([]);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const sync = useCallback(async (r) => { if (r?.state) setState(r.state); try { setWire((await browse.wire(0)).wire); } catch { /* shown next time */ } }, []);
  const guard = (fn) => async () => { setErr(""); try { await fn(); } catch (e) { setErr(e.message); } };

  useEffect(() => { setSkill(null); setState(null); setHistory([]); setAct(null); setRun(null); setWire([]); setNote(""); setErr(""); }, [resetKey]);

  const connect = guard(async () => {
    setHistory([]); setAct(null); setRun(null); setNote("");
    await browse.connect("support:swap-aba", "modern");
    const l = await browse.list();
    setSkill(l.skills[0]); setState(l.state); setHistory([]); await sync(l);
  });
  const getManifest = guard(async () => {
    const g = await browse.get(U);
    setSkill(g.skill); setHistory((h) => [...h, g.skill.hash]);
    const was = state?.approvals?.[U];
    setNote(was && !g.state.approvals[U] ? "The manifest changed since you approved it: the approval was revoked." : "");
    await sync(g);
  });
  const approval = state?.approvals?.[U] ?? null;
  const setFlags = (patch) => guard(async () => {
    const r = await browse.approve(U, { scripts: approval?.scripts ?? false, allowedTools: approval?.allowedTools ?? false, ...patch });
    setNote(r.approved ? "" : `Not approved: ${r.reason}`);
    await sync(r);
  });
  const activate = guard(async () => { const a = await browse.activate(U); setAct(a); await sync(a); });
  const ask = guard(async () => { const r = await browse.script(U, "scripts/make.sh"); setRun(r); await sync(r); });

  const revoked = state?.findings?.some((f) => f.id === "approval-revoked");
  return (
    <>
      <div className="page-head"><h1>Approvals</h1></div>
      <p className="muted">Gate decisions only: "script run allowed" means a real host would be allowed to run the script. This lab never executes anything. One skill, <code>report-writer</code>, from a server whose manifest changes: it is honest on the first <code>skills/get</code>, different on the second, honest again on the third (A, B, A). An approval is bound to the exact set of files (URI, digest, size) it was given for.</p>
      {err && <p className="field-error" role="alert" data-testid="approvals-error">{err}</p>}
      <ol className="steps">
        <li><button type="button" className="primary" onClick={connect} data-testid="ap-connect">1. Connect to the swap lab</button> <span className="muted">no file is read</span></li>
        <li><button type="button" aria-disabled={!skill} onClick={() => skill && getManifest()} data-testid="ap-get">2. skills/get the manifest</button> <span className="muted">press it again for B, and once more for A</span></li>
        <li><button type="button" aria-disabled={!skill} onClick={() => skill && setFlags({})()} data-testid="ap-approve">3. Approve the skill</button>{" "}
          <button type="button" aria-pressed={Boolean(approval?.scripts)} aria-disabled={!approval} onClick={() => approval && setFlags({ scripts: !approval.scripts })()} data-testid="ap-scripts">Grant scripts</button>{" "}
          <button type="button" aria-pressed={Boolean(approval?.allowedTools)} aria-disabled={!approval} onClick={() => approval && setFlags({ allowedTools: !approval.allowedTools })()} data-testid="ap-tools">Grant allowed-tools</button></li>
        <li><button type="button" aria-disabled={!skill} onClick={() => skill && activate()} data-testid="ap-activate">4. Activate (reads SKILL.md)</button>{" "}
          <button type="button" aria-disabled={!skill} onClick={() => skill && ask()} data-testid="ap-run">Ask to run scripts/make.sh</button></li>
      </ol>
      {note && <p className="field-error" role="status" data-testid="ap-note">{note}</p>}
      <div className="card-grid">
        <div className="card card--neutral">
          <h3>Manifest seen</h3>
          <p data-testid="ap-history">{history.length ? history.map((h, i) => <span key={i}><Chip tone="info">{h8(h)}</Chip> </span>) : <span className="muted">none yet</span>}</p>
          <p className="muted">Current: <code data-testid="ap-current">{h8(skill?.hash)}</code></p>
        </div>
        <div className="card card--neutral">
          <h3>Approval</h3>
          {approval
            ? <p data-testid="ap-state"><Chip tone="ok">approved</Chip> for <code>{h8(approval.hash)}</code>; scripts <Chip tone={approval.scripts ? "ok" : "info"}>{approval.scripts ? "granted" : "not granted"}</Chip> allowed-tools <Chip tone={approval.allowedTools ? "ok" : "info"}>{approval.allowedTools ? "granted" : "not granted"}</Chip></p>
            : <p data-testid="ap-state"><Chip tone={revoked ? "danger" : "info"}>{revoked ? "revoked" : "not approved"}</Chip> {revoked ? "The set of files changed, so the approval is gone." : ""}</p>}
        </div>
        <div className="card card--neutral">
          <h3>What the host does</h3>
          {act && <p data-testid="ap-act">{act.loaded ? <>Loaded. Requested tools <code>{act.requested.allowedTools.join(" ") || "none"}</code>, granted <code>{act.grants.allowedTools.join(" ") || "none"}</code>.</> : <>Not loaded: {act.reasons.join(", ")}</>}</p>}
          {run && <p data-testid="ap-run-result"><Chip tone={run.allowed ? "warn" : "ok"}>{run.allowed ? "script run allowed" : "script run denied"}</Chip> {run.reason}. <span className="muted">A gate decision only: the lab never executes anything.</span></p>}
          {!act && !run && <p className="muted">Nothing asked yet.</p>}
        </div>
      </div>
      {state?.findings?.length > 0 && (
        <section className="panel" aria-label="Findings"><h2>Findings</h2>
          <ul className="findings" data-testid="ap-findings">{state.findings.map((f, i) => <li key={i}><Chip>{f.spec ?? f.kind}</Chip> <code>{f.id}</code> <span className="muted">{f.detail}</span></li>)}</ul>
        </section>
      )}
      <details><summary>Raw wire ({state?.wireCount ?? 0} requests)</summary><WireView wire={wire} /></details>
    </>
  );
}
