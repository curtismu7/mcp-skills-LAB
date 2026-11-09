import { useCallback, useEffect, useMemo, useState } from "react";
import Chip from "../components/Chip.jsx";
import Kv from "../components/Kv.jsx";
import WireView from "../components/WireView.jsx";
import { createBrowse, getHostile } from "../api.js";

const browse = createBrowse();
const short = (d) => (d ? d.replace("sha256:", "").slice(0, 12) : "");
const rel = (skillUri, fileUri) => fileUri.replace(skillUri.replace(/SKILL\.md$/, ""), "");

export default function Skills({ info, dataKey, resetKey }) {
  const [cases, setCases] = useState([]);
  const [target, setTarget] = useState("catalog");
  const [era, setEra] = useState("modern");
  const [state, setState] = useState(null);
  const [skills, setSkills] = useState([]);
  const [listing, setListing] = useState(null);
  const [selected, setSelected] = useState(null);
  const [files, setFiles] = useState({});      // `${skillUri}|${ref}` -> result of a click
  const [activation, setActivation] = useState({});
  const [wire, setWire] = useState([]);
  const [showWire, setShowWire] = useState(false);
  const [byUri, setByUri] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { getHostile().then((h) => setCases(h.cases)).catch(() => {}); }, []);
  const refreshWire = useCallback(() => browse.wire(0).then((w) => { setWire(w.wire); setState(w); }).catch(() => {}), []);

  const connect = useCallback(async (t = target, e = era) => {
    setBusy(true); setErr(""); setFiles({}); setActivation({}); setSelected(null); setSkills([]); setListing(null);
    try {
      await browse.connect(t, e);
      const l = await browse.list();
      setSkills(l.skills); setListing(l); setState(l.state); setSelected(l.skills[0]?.uri ?? null);
      await refreshWire();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }, [target, era, refreshWire]);

  // A new source (Mock/Real toggle) or a Reset: forget everything shown and, on the catalog, connect and list again (no file is read by that).
  useEffect(() => { setFiles({}); setActivation({}); setWire([]); setState(null); if (target === "catalog") connect("catalog", era); else { setSkills([]); setListing(null); setSelected(null); } }, [dataKey, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new target or era is a different connection: forget the old list, counters and files until the person connects again.
  const forget = () => { setSkills([]); setListing(null); setSelected(null); setFiles({}); setActivation({}); setState(null); setWire([]); setErr(""); };
  const sel = useMemo(() => skills.find((s) => s.uri === selected) ?? null, [skills, selected]);
  const openFile = async (ref) => {
    if (!sel) return;
    setErr("");
    try { const r = await browse.file(sel.uri, ref); setFiles((f) => ({ ...f, [`${sel.uri}|${ref}`]: r })); setState(r.state); await refreshWire(); } catch (x) { setErr(x.message); }
  };
  const activate = async () => {
    if (!sel) return;
    setErr("");
    try { const a = await browse.activate(sel.uri); setActivation((m) => ({ ...m, [sel.uri]: a })); setState(a.state); await refreshWire(); } catch (x) { setErr(x.message); }
  };
  const getByUri = async () => {
    setErr("");
    try { const g = await browse.get(byUri.trim()); setSkills((cur) => (cur.some((s) => s.uri === g.skill.uri) ? cur.map((s) => (s.uri === g.skill.uri ? g.skill : s)) : [...cur, g.skill])); setSelected(g.skill.uri); setState(g.state); await refreshWire(); } catch (x) { setErr(x.message); }
  };

  const manifest = Array.isArray(sel?.resources) ? sel.resources : [];
  const fm = sel?.frontmatter;
  return (
    <>
      <div className="page-head"><h1>Skills</h1></div>
      <section className="controls" aria-label="Source and era">
        <label>Browse
          <select value={target} onChange={(e) => { setTarget(e.target.value); forget(); }} data-testid="target">
            <option value="catalog">The catalog ({info?.source ?? "..."})</option>
            <optgroup label="A hostile server">{cases.map((c) => <option key={c.id} value={`hostile:${c.id}`}>{c.letter}: {c.title}</option>)}</optgroup>
          </select>
        </label>
        <label>Protocol era
          <select value={era} onChange={(e) => { setEra(e.target.value); forget(); }} data-testid="era"><option value="modern">2026-07-28 (server/discover)</option><option value="legacy">2025-11-25 (initialize)</option></select>
        </label>
        <button type="button" className="primary" aria-disabled={busy} onClick={() => !busy && connect()} data-testid="connect">{busy ? "Connecting..." : "Connect and list"}</button>
      </section>
      <p className="muted">Connecting and listing read no file. Files are fetched one at a time, only when you click View.</p>
      {err && <p className="field-error" role="alert" data-testid="skills-error">{err}</p>}

      <div className="counters" data-testid="counters">
        {!state?.connected && <Chip tone="warn" testid="not-connected">Not connected yet: press Connect and list</Chip>}
        <Chip tone={state?.stats?.reads ? "warn" : "ok"} testid="reads">Files read: {state?.stats?.reads ?? 0}</Chip>
        <Chip tone={state?.wireReads ? "warn" : "ok"} testid="wire-reads">resources/read on the wire: {state?.wireReads ?? 0}</Chip>
        <Chip tone="info" testid="requests">Requests: {state?.stats?.requests ?? 0}</Chip>
        {listing && <Chip tone="info">{listing.pages} page{listing.pages === 1 ? "" : "s"}, ttl {listing.ttlMs ?? "-"} ms, {listing.cacheScope ?? "-"}</Chip>}
        {state?.connected && <Chip tone="info">{state.era === "modern" ? "2026-07-28" : "2025-11-25"}</Chip>}
      </div>

      <div className="inspector">
        <nav className="tree" aria-label="Skills" data-testid="skill-list">
          {skills.length === 0 && <p className="muted">{busy ? "Loading..." : "No skills listed."}</p>}
          {skills.map((s) => (
            <button key={s.uri} type="button" aria-current={s.uri === selected ? "true" : undefined} onClick={() => setSelected(s.uri)} data-testid={`skill-${s.name}`}>
              {s.label}{!s.loadable ? " (refused)" : ""}{!s.listed ? " (unlisted)" : ""}
            </button>
          ))}
          <label className="byuri">Get by URI
            <input value={byUri} onChange={(e) => setByUri(e.target.value)} placeholder="skill://name/SKILL.md" data-testid="by-uri" />
          </label>
          <button type="button" aria-disabled={!byUri.trim()} onClick={() => byUri.trim() && getByUri()} data-testid="get-by-uri">skills/get</button>
        </nav>
        <section className="panel" aria-label="Skill">
          {!sel && <p className="muted">Select a skill.</p>}
          {sel && (
            <>
              <h2 className="mono wrap" data-testid="skill-title">{sel.name}</h2>
              <p><Chip tone={sel.loadable ? "ok" : "danger"}>{sel.loadable ? "loadable" : "refused"}</Chip> <Chip tone={sel.listed ? "ok" : "warn"}>{sel.listed ? "listed" : "unlisted"}</Chip> {sel.dynamic && <Chip tone="warn">dynamic</Chip>}</p>
              {!sel.loadable && <p className="field-error" data-testid="refused-reasons">Refused: {sel.reasons.join(", ")}</p>}
              <Kv rows={[["URI", <code key="u">{sel.uri}</code>], ["Frontmatter", <pre className="code" key="f" data-testid="frontmatter">{JSON.stringify(fm, null, 2)}</pre>]]} />
              <p className="section-label">Manifest ({manifest.length} file{manifest.length === 1 ? "" : "s"})</p>
              {sel.dynamic ? <p className="muted">resources: "dynamic". There is no manifest to check files against.</p> : (
                <div className="scroll">
                  <table className="tbl" data-testid="manifest">
                    <thead><tr><th>File</th><th>Size</th><th>SHA-256</th><th /></tr></thead>
                    <tbody>
                      {manifest.map((r) => (
                        <tr key={r.uri}>
                          <td className="mono">{rel(sel.uri, r.uri)}</td><td>{r.size}</td><td className="mono" title={r.digest}>{short(r.digest)}</td>
                          <td><button type="button" onClick={() => openFile(rel(sel.uri, r.uri))} data-testid={`view-${rel(sel.uri, r.uri)}`}>View</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {Object.entries(files).filter(([k]) => k.startsWith(`${sel.uri}|`)).map(([k, r]) => (
                <div key={k} className="fileview" data-testid="fileview">
                  <p><strong className="mono wrap">{k.split("|")[1]}</strong> {r.ok ? <Chip tone="ok" title="The byte size and SHA-256 of the WHOLE file matched the manifest">{`verified (size and SHA-256 of all ${r.bytes} bytes)`}</Chip> : <Chip tone="danger">rejected: {r.problems.join(", ")}</Chip>} {r.nested && <Chip tone="warn">nested SKILL.md: data, not a skill</Chip>}</p>
                  {r.ok && r.truncated && <p className="notice" data-testid="truncated">Showing only the first {r.shownChars} of {r.totalChars} characters. The verification above covered the whole file ({r.bytes} bytes); only the text shown here is cut.</p>}
                  {r.ok && <pre className="code" data-testid="filetext">{r.text ?? "(binary)"}</pre>}
                </div>
              ))}
              <div className="row">
                <button type="button" onClick={activate} data-testid="activate">Activate (reads SKILL.md)</button>
                <span className="muted">Reading SKILL.md is not activation; this is the host's own loading step.</span>
              </div>
              {activation[sel.uri] && (
                <div data-testid="activation">
                  {activation[sel.uri].loaded
                    ? <p><Chip tone="ok">loaded, tagged untrusted</Chip> requested tools: <code>{activation[sel.uri].requested.allowedTools.join(" ") || "none"}</code>, granted: <code>{activation[sel.uri].grants.allowedTools.join(" ") || "none"}</code>; scripts: {activation[sel.uri].requested.scripts.length ? activation[sel.uri].requested.scripts.join(", ") : "none"}, granted: {String(activation[sel.uri].grants.scripts)}</p>
                    : <p><Chip tone="danger">not loaded</Chip> {activation[sel.uri].reasons.join(", ")}</p>}
                  {activation[sel.uri].contentTruncated && <p className="notice" data-testid="activation-truncated">Showing the first {activation[sel.uri].contentLines.shown} of {activation[sel.uri].contentLines.total} lines of the tagged content.</p>}
                  {activation[sel.uri].content && <pre className="code">{activation[sel.uri].content}</pre>}
                </div>
              )}
            </>
          )}
        </section>
      </div>
      <details open={showWire} onToggle={(e) => setShowWire(e.currentTarget.open)}>
        <summary>Raw wire ({state?.wireCount ?? 0} requests)</summary>
        <WireView wire={wire} />
      </details>
      {state?.findings?.length > 0 && (
        <section className="panel" aria-label="Findings"><h2>Findings so far</h2>
          <ul className="findings" data-testid="findings">{state.findings.map((f, i) => <li key={i}><Chip>{f.spec ?? f.kind}</Chip> <code>{f.id}</code> <span className="muted">{f.detail}</span></li>)}</ul>
        </section>
      )}
    </>
  );
}
