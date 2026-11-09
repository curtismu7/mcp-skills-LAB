import { useCallback, useEffect, useRef, useState } from "react";
import ShelfLink from "./components/ShelfLink.jsx";
import ModeToggle from "./components/ModeToggle.jsx";
import Overview from "./pages/Overview.jsx";
import Skills from "./pages/Skills.jsx";
import Verifier from "./pages/Verifier.jsx";
import Approvals from "./pages/Approvals.jsx";
import Source from "./pages/Source.jsx";
import DiagramPage from "./pages/DiagramPage.jsx";
import { BANNER_SIM, MEASURED, modeBanner } from "./banner.js";
import { getInfo, getTalkTrack, postMode, resetServer } from "./api.js";
import { workspaceId } from "./workspace.js";
import { clearSavedPositions } from "./FlowDiagram.jsx";

export { BANNER_SIM, MEASURED };
// Hash-routed tabs (no router dependency). The banner sits above every one of them, presenter mode included.
export const PAGES = [["overview", "Overview", Overview], ["skills", "Skills", Skills], ["verifier", "Verifier", Verifier], ["approvals", "Approvals", Approvals], ["source", "Source", Source], ["diagram", "Diagram", DiagramPage]];
const THEME_KEY = "msl.theme";
const THEMES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* not remembered */ } },
};
const pageFromHash = () => { const id = window.location.hash.replace(/^#\/?/, "").split("?")[0]; return PAGES.some(([p]) => p === id) ? id : "overview"; };

export default function App() {
  const [page, setPage] = useState(pageFromHash);
  const [info, setInfo] = useState(null);
  const [talk, setTalk] = useState([]);
  const [theme, setTheme] = useState(() => (["light", "dark"].includes(store.get(THEME_KEY)) ? store.get(THEME_KEY) : "auto"));
  const [presenter, setPresenter] = useState(false);
  const [dataKey, setDataKey] = useState(0);   // bumps when the source changes: every tab reloads its data
  const [resetKey, setResetKey] = useState(0); // bumps on Reset: every tab forgets its state, the diagram restores its boxes
  const [modeMsg, setModeMsg] = useState("");
  const [resetMsg, setResetMsg] = useState("");
  const [lastVerify, setLastVerify] = useState(null);
  const [verifyData, setVerifyData] = useState({ runs: {}, control: {} }); // kept here so the results survive a change of tab
  const mainRef = useRef(null);

  useEffect(() => { getInfo().then(setInfo).catch(() => {}); getTalkTrack().then((t) => setTalk(t.talkTrack)).catch(() => {}); }, []);
  useEffect(() => { const on = () => setPage(pageFromHash()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);
  // Presenter mode: P toggles, Esc leaves. A key with a modifier is the browser's, and a key typed into a field is text.
  useEffect(() => {
    const on = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const pickTheme = (next) => { store.set(THEME_KEY, next === "auto" ? null : next); setTheme(next); };
  // Rule 19: switching asks the server; on success every tab reloads. Real not configured: the server's 409 reason is shown and the mode stays.
  const selectMode = useCallback(async (source) => {
    try { setInfo(await postMode(source)); setModeMsg(""); setVerifyData({ runs: {}, control: {} }); setLastVerify(null); setDataKey((k) => k + 1); } catch (e) { setModeMsg(e.message); }
  }, []);
  const onReset = useCallback(async () => {
    setModeMsg("");
    const ok = await resetServer().then(() => true, () => false);
    clearSavedPositions(); setLastVerify(null); setVerifyData({ runs: {}, control: {} }); setResetKey((k) => k + 1);
    getInfo().then(setInfo).catch(() => {});
    setResetMsg(ok ? "Reset: the browse session and the hostile servers are back to the start, and the diagram boxes are back in place." : "Reset failed on the server; the page was cleared.");
  }, []);

  const Page = PAGES.find(([id]) => id === page)[2];
  const say = talk.filter((t) => t.for.includes(page));
  const source = info?.source;

  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      <header className="shell-bar">
        <span className="shell-brand"><span className="shell-logo" aria-hidden="true">P</span> MCP Skills LAB <span className="shell-badge" data-testid="mode-badge">{info ? (source === "real" ? "Real" : "Mock") : "..."}</span></span>
        <nav className="shell-nav" aria-label="Lab sections">
          {PAGES.map(([id, label]) => <a key={id} href={`#/${id}`} aria-current={id === page ? "page" : undefined}>{label}</a>)}
        </nav>
        <span className="shell-right">
          <ModeToggle info={info} onSelect={selectMode} />
          <ShelfLink headers={() => ({ "x-workspace": workspaceId() })} />
          <label className="shell-theme">Theme
            <select value={theme} onChange={(e) => pickTheme(e.target.value)} data-testid="theme">{THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
          </label>
          <button type="button" onClick={onReset} data-testid="reset">Reset</button>
          <button type="button" aria-pressed={presenter} onClick={() => setPresenter((v) => !v)} data-testid="presenter">{presenter ? "Exit presenter (Esc)" : "Presenter (P)"}</button>
        </span>
      </header>
      <main className="page" id="main" tabIndex={-1} ref={mainRef}>
        <div className="banner" role="note" data-testid="banner" data-state={source === "real" ? "live" : "mock"}>
          <strong>{modeBanner(source)}</strong>{BANNER_SIM}
          <p className="banner__measured" data-testid="measured">{MEASURED}</p>
        </div>
        {info && info.realAvailable === false && <p className="muted" data-testid="real-howto">Real is off: {info.realReason}. Mount a skills folder read-only and set SKILLS_DIR (see the Source tab).</p>}
        {modeMsg && <p className="field-error" role="alert" data-testid="mode-message">{modeMsg}</p>}
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        {presenter && say.length > 0 && (
          <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track for this tab">
            {say.map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
          </aside>
        )}
        <Page info={info} dataKey={dataKey} resetKey={resetKey} presenter={presenter} talk={talk} lastVerify={lastVerify} setLastVerify={setLastVerify} verifyData={verifyData} setVerifyData={setVerifyData} />
      </main>
    </div>
  );
}
