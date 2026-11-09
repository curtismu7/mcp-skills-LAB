import { useEffect, useState } from "react";
import Chip from "../components/Chip.jsx";
import Kv from "../components/Kv.jsx";
import { getHostile, getSpec } from "../api.js";
import { MEASURED } from "../banner.js";

export default function Overview({ info, dataKey, presenter, talk, lastVerify }) {
  const [spec, setSpec] = useState(null);
  const [cases, setCases] = useState(null);
  useEffect(() => { getSpec().then(setSpec).catch(() => {}); getHostile().then((h) => setCases(h.cases)).catch(() => {}); }, []);
  const v = lastVerify;
  return (
    <>
      <div className="page-head"><h1>MCP Skills LAB</h1></div>
      {!presenter && <p className="intro">A tester for the official MCP Skills extension, <code>io.modelcontextprotocol/skills</code> (SEP-2640, protocol revision 2026-07-28). A skills <strong>server</strong>, a catalog of <strong>hostile</strong> servers, and a <strong>host verifier</strong> that decides what a careful host would accept.</p>}
      <div className="card-grid">
        <div className="card">
          <h3>Skills</h3>
          <p>Browse what a server lists, read its manifest (size and SHA-256 per file) and open a file only when you click it. The retrieval counter stays at 0 until then.</p>
          <p><a href="#/skills">Open the Skills tab</a></p>
        </div>
        <div className="card">
          <h3>Verifier</h3>
          <p>{cases ? `Run ${cases.length} hostile cases` : "Loading the hostile cases"} in both protocol eras. Each verdict names the spec rule (MUST, SHOULD or lab policy) and the check that caught it, with the raw wire behind it.</p>
          <p><a href="#/verifier">Open the Verifier tab</a></p>
        </div>
        <div className="card">
          <h3>Approvals</h3>
          <p>Approve a skill, then scripts and allowed-tools separately. Swap the manifest underneath and watch the approval go, and stay gone.</p>
          <p><a href="#/approvals">Open the Approvals tab</a></p>
        </div>
      </div>
      <div className="card-grid">
        <div className="card card--neutral">
          <h3>Right now</h3>
          <Kv rows={[
            ["Source", <Chip key="s" tone={info?.source === "real" ? "info" : "ok"} testid="overview-source">{info ? info.source : "..."}</Chip>],
            ["Skills in the catalog", info ? String(info.skillCount) : "..."],
            ["Hostile cases", cases ? String(cases.length) : "..."],
            ["Last verify", v ? `modern ${v.modern ? `${v.modern.passed}/${v.modern.total}` : "-"}, legacy ${v.legacy ? `${v.legacy.passed}/${v.legacy.total}` : "-"}${v.control ? `, control ${v.control}` : ""}` : "not run yet"],
          ]} />
        </div>
        <div className="card card--neutral" data-testid="measured-card">
          <h3>Measured against a gateway</h3>
          <p><Chip tone="warn">MEASURED</Chip> {MEASURED.replace(/^MEASURED /, "")}</p>
        </div>
      </div>
      {!presenter && spec && (
        <section className="panel" aria-label="Sources">
          <h2>Where the claims come from</h2>
          <ul className="sources">
            <li><a href={spec.overview} target="_blank" rel="noreferrer">Extension overview</a></li>
            <li><a href={spec.sepPage} target="_blank" rel="noreferrer">SEP-2640 page</a></li>
            <li><a href={spec.specification} target="_blank" rel="noreferrer">skills.mdx specification</a></li>
          </ul>
          <p className="muted">{spec.readNote}</p>
          <p className="muted">Lab policy (not spec text) is labelled <code>lab</code> in the Verifier tab: containment of manifest URIs, refusing skills over 512 files or 16 MiB, and flagging an unlisted skill. No disk cache is implemented. Whether the spec names other permission-widening frontmatter fields is UNVERIFIED.</p>
        </section>
      )}
      {!presenter && talk.length > 0 && (
        <section className="panel" aria-label="Talk track">
          <h2>Talk track</h2>
          <ol className="talk" data-testid="talk-track">{talk.map((t) => <li key={t.id}><h3>{t.title}</h3><p>{t.say}</p></li>)}</ol>
        </section>
      )}
    </>
  );
}
