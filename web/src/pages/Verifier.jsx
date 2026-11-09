import { useEffect, useState } from "react";
import Chip from "../components/Chip.jsx";
import WireView from "../components/WireView.jsx";
import { getHostile, getSpec, verify } from "../api.js";

const ERAS = ["modern", "legacy"];
const ERA_LABEL = { modern: "2026-07-28", legacy: "2025-11-25" };

export default function Verifier({ info, setLastVerify, verifyData, setVerifyData }) {
  const [cases, setCases] = useState([]);
  const [spec, setSpec] = useState(null);
  const { runs, control } = verifyData;        // era -> { passed, total, byId }; era -> control result (held by the App so a tab change keeps them)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);       // case id
  const [detailEra, setDetailEra] = useState("modern");
  const [detail, setDetail] = useState(null);
  const [eras, setEras] = useState("both");

  useEffect(() => { getHostile().then((h) => setCases(h.cases)).catch((e) => setErr(e.message)); getSpec().then(setSpec).catch(() => {}); }, []);

  const which = eras === "both" ? ERAS : [eras];
  async function runAll() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const nextRuns = {}; const nextControl = {};
      for (const era of which) {
        const all = await verify({ era });
        // Counted from the verdicts the server returned, never taken on trust from a total.
        const results = all.results ?? [];
        nextRuns[era] = { passed: results.filter((r) => r.verdict === "PASS").length, total: results.length, byId: Object.fromEntries(results.map((r) => [r.caseId, r])) };
        const c = await verify({ target: "catalog", era });
        nextControl[era] = c.control;
      }
      setVerifyData({ runs: nextRuns, control: nextControl });
      setLastVerify({ modern: nextRuns.modern ? { passed: nextRuns.modern.passed, total: nextRuns.modern.total } : null, legacy: nextRuns.legacy ? { passed: nextRuns.legacy.passed, total: nextRuns.legacy.total } : null, control: Object.values(nextControl).every((c) => c.verdict === "PASS") ? "PASS" : "FAIL" });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function openCase(id, era = detailEra) {
    setOpen(id); setDetail(null); setErr("");
    try { setDetail(await verify({ caseId: id, era, wire: true })); } catch (e) { setErr(e.message); }
  }

  // A deep link from the Learning Hub (#/verifier?case=<id>) opens that case once the case list is here.
  useEffect(() => { const m = /[?&]case=([a-z0-9-]+)/.exec(window.location.hash); if (m && cases.some((c) => c.id === m[1])) openCase(m[1]); }, [cases.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const ran = Object.keys(runs);
  return (
    <>
      <div className="page-head"><h1>Host verifier</h1></div>
      <p className="muted">Each hostile server is an honest SDK server with one documented lie. A verdict of <strong>PASS</strong> means the hostile case was correctly rejected or flagged. The tag says whether the rule is a spec <code>MUST</code>, <code>SHOULD</code>, <code>MAY</code> or <code>lab</code> policy.</p>
      <section className="controls" aria-label="Run">
        <label>Protocol era
          <select value={eras} onChange={(e) => setEras(e.target.value)} data-testid="verify-eras"><option value="both">both</option><option value="modern">2026-07-28 only</option><option value="legacy">2025-11-25 only</option></select>
        </label>
        <button type="button" className="primary" aria-disabled={busy || cases.length === 0} onClick={() => cases.length && runAll()} data-testid="run-all">{busy ? "Running..." : cases.length ? `Run all ${cases.length} cases and the clean control` : "Loading the cases..."}</button>
      </section>
      {err && <p className="field-error" role="alert" data-testid="verify-error">{err}</p>}
      {ran.length > 0 && (
        <p className="summary" data-testid="verify-summary" role="status">
          {ran.map((era) => {
            const r = runs[era]; const c = control[era]; const failed = r.total - r.passed;
            return (
              <span key={era} className="summary__item">
                <Chip tone={failed === 0 && r.total > 0 ? "ok" : "danger"} testid={`summary-${era}`}>{ERA_LABEL[era]}: {r.passed}/{r.total} PASS{failed > 0 ? `, ${failed} FAIL` : ""}</Chip>{" "}
                <Chip tone={c?.verdict === "PASS" ? "ok" : "danger"} testid={`control-${era}`}>control {c?.verdict ?? "-"} ({c?.skills?.length ?? 0} {info?.source ?? ""} skills)</Chip>
              </span>
            );
          })}
        </p>
      )}
      <div className="scroll">
        <table className="tbl tbl--wide" data-testid="verify-table" aria-label="Hostile cases and verdicts">
          <caption className="sr-only">Hostile cases, the rule each exercises, the check that catches it, and the verdict in each protocol era</caption>
          <thead><tr><th scope="col">Case</th><th scope="col">Rule</th><th scope="col">Check that catches it</th>{ERAS.map((e) => <th scope="col" key={e}>{ERA_LABEL[e]}</th>)}<th scope="col"><span className="sr-only">Raw wire</span></th></tr></thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id} data-testid={`row-${c.id}`} aria-current={open === c.id ? "true" : undefined}>
                <td><strong>{c.letter}</strong> {c.title}<br /><span className="muted mono">{c.id}</span></td>
                <td><Chip>{c.kind}</Chip></td>
                <td className="mono">{c.guardedBy}</td>
                {ERAS.map((e) => {
                  const r = runs[e]?.byId?.[c.id];
                  return <td key={e}>{r ? <Chip tone={r.verdict === "PASS" ? "ok" : "danger"} testid={`verdict-${c.id}-${e}`}>{r.verdict}</Chip> : <span className="muted">-</span>}</td>;
                })}
                <td><button type="button" onClick={() => openCase(c.id)} data-testid={`open-${c.id}`}>Wire</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <section className="panel" aria-label="Case detail" data-testid="case-detail">
          <div className="row">
            <h2>{cases.find((c) => c.id === open)?.title}</h2>
            <label>Era
              <select value={detailEra} onChange={(e) => { setDetailEra(e.target.value); openCase(open, e.target.value); }} data-testid="detail-era">{ERAS.map((e) => <option key={e} value={e}>{ERA_LABEL[e]}</option>)}</select>
            </label>
            <button type="button" onClick={() => { setOpen(null); setDetail(null); }}>Close</button>
          </div>
          {(() => { const c = cases.find((x) => x.id === open); return c && (
            <dl className="kv">
              <div className="kv__row"><dt>The attack</dt><dd>{c.attack}</dd></div>
              <div className="kv__row"><dt>The rule</dt><dd>{c.must}</dd></div>
              <div className="kv__row"><dt>Expected verdict</dt><dd>{c.expected}</dd></div>
            </dl>); })()}
          {!detail && <p className="muted">Running this case...</p>}
          {detail && (
            <>
              <p><Chip tone={detail.verdict === "PASS" ? "ok" : "danger"} testid="detail-verdict">{detail.verdict}</Chip> {detail.kind && <Chip>{detail.kind}</Chip>} checks fired: <code>{detail.checksFired.join(", ") || "none"}</code> ({detail.requests} requests, {detail.reads} file reads)</p>
              <p className="section-label">What the host did</p>
              <ul className="facts">{Object.entries(detail.facts).map(([k, v]) => <li key={k}><Chip tone={v === true ? "ok" : "danger"}>{v === true ? "true" : "false"}</Chip> <code>{k}</code></li>)}</ul>
              <p className="section-label">Findings</p>
              <ul className="findings">{detail.findings.map((f, i) => <li key={i}><Chip>{f.kind}</Chip> <code>{f.id}</code> <span className="muted">{f.detail}</span></li>)}</ul>
              <p className="section-label">Raw wire</p>
              <WireView wire={detail.wire} />
            </>
          )}
        </section>
      )}
      {spec && <p className="muted">Checks the verifier names: {spec.checks.join(", ")}.</p>}
    </>
  );
}
