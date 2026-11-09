import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import App, { PAGES } from "./App.jsx";
import { BANNER_SIM, MEASURED } from "./banner.js";
import { buildGraph } from "./FlowDiagram.jsx";
import Chip from "./components/Chip.jsx";
import WireView from "./components/WireView.jsx";
import { forgetWorkspace, workspaceId } from "./workspace.js";

// React Flow measures the DOM, which jsdom does not have: a small stand-in that keeps node and edge state. The real library runs in the browser check (scripts/e2e.mjs).
vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" }, MarkerType: { ArrowClosed: "arrowclosed" },
    Handle: () => null, Background: () => null, Controls: () => null, ReactFlowProvider: ({ children }) => children, useReactFlow: () => ({ fitView: () => {} }),
    useNodesState: (init) => { const [n, set] = React.useState(init); return [n, set, (changes) => set((cur) => cur.map((x) => { const c = changes.find((y) => y.id === x.id); return c ? { ...x, position: c.position } : x; }))]; },
    useEdgesState: (init) => { const [e, set] = React.useState(init); return [e, set, () => {}]; },
    ReactFlow: ({ nodes, edges, onNodesChange }) => (
      <div data-testid="rf">
        {nodes.map((n) => <button key={n.id} type="button" data-testid={`node-${n.id}`} data-x={n.position.x} onClick={() => onNodesChange([{ id: n.id, position: { x: n.position.x + 50, y: n.position.y } }])}>{n.data.label}</button>)}
        {edges.map((e) => <span key={e.id} data-testid={`edge-${e.id}`} data-class={e.className}>{e.label}</span>)}
      </div>
    ),
  };
});

const MOCK_INFO = { mode: "mock", source: "mock", realAvailable: false, realReason: "no skills directory configured (set SKILLS_DIR to a folder of skill folders, mounted read-only)", modes: ["mock", "real"], skillCount: 4, problemCount: 0, directory: null };
const REAL_INFO = { ...MOCK_INFO, mode: "real", source: "real", realAvailable: true, realReason: null, skillCount: 2, directory: "skills" };
const SKILL = { uri: "skill://demo/release-checklist/SKILL.md", serverId: "srv", name: "release-checklist", label: "release-checklist", listed: true, loadable: true, reasons: [], dynamic: false, hash: "a".repeat(64), frontmatter: { name: "release-checklist", description: "d" },
  resources: [{ uri: "skill://demo/release-checklist/SKILL.md", digest: `sha256:${"b".repeat(64)}`, size: 50 }, { uri: "skill://demo/release-checklist/references/CHECKLIST.md", digest: `sha256:${"c".repeat(64)}`, size: 20 }] };
const STATE0 = { connected: true, target: "catalog", era: "modern", stats: { requests: 3, reads: 0, lists: 1, gets: 0, refreshes: 0 }, wireReads: 0, wireCount: 3, findings: [], approvals: {}, activated: [] };
const CASES = [
  { id: "a-digest-mismatch", letter: "a", title: "Digest mismatch", attack: "attack a", must: "Hosts MUST verify", expected: "rejected", findings: ["digest-mismatch"], guardedBy: "digest", kind: "MUST" },
  { id: "h1-dotdot-traversal", letter: "h1", title: "Traversal", attack: "attack h", must: "lab policy", expected: "refused", findings: ["uri-outside-root"], guardedBy: "uri-scope", kind: "lab" },
];
const DIAGRAM = { schema: "diagram-studio/1", id: "skills-flow", title: "t", lede: "lede", groups: { a: { label: "a", color: "blue" } },
  nodes: [{ id: "host", label: "Host", group: "a", x: 0, y: 0 }, { id: "server", label: "Server", group: "a", x: 300, y: 0 }],
  edges: [{ source: "host", target: "server", label: "one" }, { source: "host", target: "server", label: "two" }],
  steps: [{ title: "s1", what: "w1", why: "y1", edges: [0] }, { title: "s2", what: "w2", why: "y2", edges: [1] }] };

let info; let calls; let readsN;
const stateNow = () => ({ ...STATE0, stats: { ...STATE0.stats, reads: readsN }, wireReads: readsN });
function mockApi(over = {}) {
  calls = []; readsN = 0;
  info = over.info ?? MOCK_INFO;
  globalThis.fetch = vi.fn(async (url, init) => {
    const clean = url.split("?")[0]; const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: clean, body });
    let out; let status = 200;
    if (clean === "/api/mode") {
      if (body.source === "real" && !info.realAvailable) { status = 409; out = { error: "real_not_available", message: info.realReason }; } else { info = body.source === "real" ? REAL_INFO : MOCK_INFO; out = info; }
    } else out = ({
      "/api/info": () => info, "/api/shelf": () => ({ shelfUrl: null }), "/api/talk-track": () => ({ talkTrack: [{ id: "t1", title: "Overview note", for: ["overview"], say: "Say overview." }, { id: "t2", title: "Skills note", for: ["skills"], say: "Say skills." }] }),
      "/api/hostile": () => ({ cases: CASES }), "/api/spec": () => ({ overview: "https://x.example/o", sepPage: "https://x.example/s", specification: "https://x.example/m", readNote: "note", checks: ["digest"], findings: {} }),
      "/api/diagram": () => DIAGRAM, "/api/catalog": () => ({ source: info.source, skills: [SKILL], problems: info.source === "real" ? [{ level: "refused", path: "linky", message: "symlinks are not followed" }] : [] }),
      "/api/reset": () => ({ reset: true }), "/api/browse/connect": () => ({ declared: true, state: STATE0 }), "/api/browse/list": () => ({ pages: 1, ttlMs: 30000, cacheScope: "public", skills: over.skills ?? [SKILL], state: STATE0 }),
      "/api/browse/wire": () => ({ wire: [], ...stateNow() }),
      "/api/browse/file": () => { readsN += 1; return over.file ?? { ok: true, text: "# Pre-flight checklist", problems: [], verified: true, nested: false, bytes: 22, state: stateNow() }; },
      "/api/browse/activate": () => over.activate ?? { loaded: true, reasons: [], requested: { allowedTools: [], hooks: false, scripts: [] }, grants: { allowedTools: [], scripts: false, hooks: false }, content: "x", contentTruncated: false, contentLines: { shown: 1, total: 1 }, state: stateNow() },
      "/api/verify": () => (body.target === "catalog" ? { control: over.control ?? { verdict: "PASS", skills: [1, 2, 3, 4] }, source: "mock" } : body.caseId ? { ...CASES[0], verdict: "PASS", facts: { a: true }, findings: [{ id: "digest-mismatch", kind: "MUST", detail: "d" }], checksFired: ["digest"], requests: 4, reads: 1, wire: [{ seq: 1, method: "resources/read", http: "POST", url: "/mcp", status: 200, ms: 3, traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01", request: "{}", response: "{}" }] }
        : { era: body.era, total: 2, passed: 2, results: CASES.map((c) => ({ ...c, caseId: c.id, verdict: over.verdicts?.[c.id] ?? "PASS" })) }),
    }[clean] ?? (() => { status = 404; return { error: "not_found" }; }))();
    return { ok: status < 400, status, json: async () => out };
  });
}
beforeEach(() => { forgetWorkspace(); window.location.hash = ""; mockApi(); });
afterEach(() => { cleanup(); window.location.hash = ""; delete document.documentElement.dataset.theme; try { localStorage.clear(); } catch { /* */ } });
const go = (tab) => { window.location.hash = `#/${tab}`; fireEvent(window, new HashChangeEvent("hashchange")); };

describe("shell and banner", () => {
  it("shows the UNVERIFIED banner with the MEASURED fact first in the page, on every tab, and in presenter mode", async () => {
    render(<App />);
    await screen.findByTestId("mode-badge");
    for (const presenter of [false, true]) {
      if (presenter) fireEvent.click(screen.getByTestId("presenter"));
      for (const [id] of PAGES) {
        go(id);
        await waitFor(() => expect(screen.getByRole("link", { name: PAGES.find((p) => p[0] === id)[1] })).toHaveAttribute("aria-current", "page"));
        const banner = screen.getByTestId("banner");
        expect(banner).toHaveTextContent(BANNER_SIM); expect(banner).toHaveTextContent(MEASURED); expect(banner).toHaveTextContent("-32601");
        expect(banner.parentElement.firstElementChild).toBe(banner);
      }
    }
  });
  it("has the shell-bar, six nav links, a theme select that sets data-theme, and Reset", async () => {
    const { container } = render(<App />);
    await screen.findByTestId("mode-badge");
    expect(container.querySelector("header.shell-bar")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Lab sections" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Overview", "Skills", "Verifier", "Approvals", "Source", "Diagram"]);
    fireEvent.change(screen.getByTestId("theme"), { target: { value: "dark" } });
    expect(document.documentElement.dataset.theme).toBe("dark"); expect(localStorage.getItem("msl.theme")).toBe("dark");
    fireEvent.change(screen.getByTestId("theme"), { target: { value: "auto" } });
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
  it("presenter mode: P toggles, Esc leaves, the note for the current tab shows, typing P in a field does not toggle", async () => {
    render(<App />);
    await screen.findByTestId("mode-badge");
    fireEvent.keyDown(window, { key: "p" });
    expect(await screen.findByTestId("presenter-say")).toHaveTextContent("Say overview.");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("presenter-say")).toBeNull();
    go("verifier"); const sel = await screen.findByTestId("verify-eras");
    fireEvent.keyDown(sel, { key: "p" });
    expect(screen.queryByTestId("presenter-say")).toBeNull();
  });
});

describe("rule 19 toggle", () => {
  it("Mock is pressed; Real is aria-disabled with the how-to tooltip; pressing it shows the server's 409 reason and the mode stays", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true"));
    const real = screen.getByTestId("mode-real");
    expect(real).toHaveAttribute("aria-disabled", "true"); expect(real.title).toMatch(/SKILLS_DIR/);
    fireEvent.click(real);
    expect(await screen.findByTestId("mode-message")).toHaveTextContent("no skills directory configured");
    expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true");
    expect(calls.filter((c) => c.url === "/api/mode")).toEqual([{ url: "/api/mode", body: { source: "real" } }]);
  });
  it("switches Mock to Real and back with exactly { source }, flips the banner state, and reloads the data", async () => {
    mockApi({ info: { ...MOCK_INFO, realAvailable: true, realReason: null } });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode-real")).not.toHaveAttribute("aria-disabled"));
    go("skills"); await screen.findByTestId("skill-release-checklist");
    const listsBefore = calls.filter((c) => c.url === "/api/browse/list").length;
    fireEvent.click(screen.getByTestId("mode-real"));
    await waitFor(() => expect(screen.getByTestId("mode-real")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("banner")).toHaveAttribute("data-state", "live"); expect(screen.getByTestId("mode-badge")).toHaveTextContent("Real");
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/browse/list").length).toBeGreaterThan(listsBefore));
    fireEvent.click(screen.getByTestId("mode-mock"));
    await waitFor(() => expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true"));
    expect(calls.filter((c) => c.url === "/api/mode").map((c) => c.body)).toEqual([{ source: "real" }, { source: "mock" }]);
  });
});

describe("Skills tab", () => {
  it("connects and lists without reading a file: counters 0; a click on View reads one and the counters say 1", async () => {
    render(<App />);
    go("skills");
    await screen.findByTestId("skill-release-checklist");
    expect(screen.getByTestId("reads")).toHaveTextContent("Files read: 0"); expect(screen.getByTestId("wire-reads")).toHaveTextContent("resources/read on the wire: 0");
    expect(calls.some((c) => c.url === "/api/browse/file")).toBe(false);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("view-references/CHECKLIST.md"));
    expect(await screen.findByTestId("filetext")).toHaveTextContent("Pre-flight checklist");
    expect(screen.getByTestId("reads")).toHaveTextContent("Files read: 1");
    expect(calls.filter((c) => c.url === "/api/browse/file")).toHaveLength(1);
  });
  it("skill text is inert: markup in a file is shown as text, never as elements", async () => {
    render(<WireView wire={[{ seq: 1, method: "x", http: "POST", url: "/mcp", status: 200, ms: 1, traceparent: null, request: '<img src=x onerror="alert(1)">', response: "<script>alert(2)</script>" }]} />);
    const { container } = render(<Chip>{"<b>MUST</b>"}</Chip>);
    expect(document.querySelector("img")).toBeNull(); expect(document.querySelector("script")).toBeNull(); expect(container.querySelector("b")).toBeNull();
  });
});

describe("Verifier tab", () => {
  it("runs the cases and the control in both eras and shows PASS cells, the rule tag and the check", async () => {
    render(<App />);
    go("verifier");
    await screen.findByTestId("row-a-digest-mismatch");
    expect(screen.getByTestId("row-a-digest-mismatch")).toHaveTextContent("MUST"); expect(screen.getByTestId("row-h1-dotdot-traversal")).toHaveTextContent("lab"); expect(screen.getByTestId("row-a-digest-mismatch")).toHaveTextContent("digest");
    fireEvent.click(screen.getByTestId("run-all"));
    const summary = await screen.findByTestId("verify-summary");
    expect(summary).toHaveTextContent("2026-07-28: 2/2 PASS"); expect(summary).toHaveTextContent("2025-11-25: 2/2 PASS"); expect(summary.textContent.match(/control PASS/g)).toHaveLength(2);
    expect(screen.getByTestId("verdict-a-digest-mismatch-modern")).toHaveTextContent("PASS");
    go("overview"); go("verifier");
    expect(await screen.findByTestId("verify-summary")).toBeInTheDocument();
  });
  it("opens a case with its attack, rule, findings and raw wire", async () => {
    render(<App />);
    go("verifier");
    fireEvent.click(await screen.findByTestId("open-a-digest-mismatch"));
    expect(await screen.findByTestId("detail-verdict")).toHaveTextContent("PASS");
    expect(screen.getByTestId("case-detail")).toHaveTextContent("attack a"); expect(screen.getByTestId("case-detail")).toHaveTextContent("Hosts MUST verify"); expect(screen.getByTestId("case-detail")).toHaveTextContent("traceparent 00-");
    expect(calls.find((c) => c.url === "/api/verify" && c.body.caseId).body).toEqual({ caseId: "a-digest-mismatch", era: "modern", wire: true });
  });
  it("opens the case named in the hash (#/verifier?case=<id>)", async () => {
    window.location.hash = "#/verifier?case=h1-dotdot-traversal";
    render(<App />);
    expect(await screen.findByTestId("detail-verdict")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/verify" && c.body.caseId).body.caseId).toBe("h1-dotdot-traversal");
  });
});

describe("Approvals tab", () => {
  it("separate grants send the full flag set; the page shows revoked after the manifest changes", async () => {
    const U = "skill://report-writer/SKILL.md";
    let approvals = {}; let hash = "1".repeat(64); const seen = [];
    const base = globalThis.fetch;
    mockApi();
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const clean = url.split("?")[0]; const body = init?.body ? JSON.parse(init.body) : null;
      const st = () => ({ ...STATE0, approvals, findings: seen.includes("revoked") ? [{ id: "approval-revoked", kind: "MUST", spec: "MUST", detail: "d" }] : [] });
      const ok = (o) => ({ ok: true, status: 200, json: async () => o });
      if (clean === "/api/browse/connect") return ok({ state: st() });
      if (clean === "/api/browse/list") return ok({ skills: [{ ...SKILL, uri: U, hash }], state: st() });
      if (clean === "/api/browse/get") { if (seen.length === 1) { hash = "2".repeat(64); approvals = {}; seen.push("revoked"); } else if (seen.length === 0) seen.push("a"); return ok({ skill: { ...SKILL, uri: U, hash }, state: st() }); }
      if (clean === "/api/browse/approve") { approvals = { [U]: { scripts: body.scripts === true, allowedTools: body.allowedTools === true, hash } }; calls.push({ url: clean, body }); return ok({ approved: true, state: st() }); }
      if (clean === "/api/browse/wire") return ok({ wire: [], ...st() });
      return inner(url, init);
    });
    render(<App />); void base;
    go("approvals");
    fireEvent.click(await screen.findByTestId("ap-connect"));
    await waitFor(() => expect(screen.getByTestId("ap-get")).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(screen.getByTestId("ap-get")); await waitFor(() => expect(screen.getByTestId("ap-current")).toHaveTextContent("11111111"));
    fireEvent.click(screen.getByTestId("ap-approve")); await waitFor(() => expect(screen.getByTestId("ap-state")).toHaveTextContent("approved for"));
    fireEvent.click(screen.getByTestId("ap-scripts")); await waitFor(() => expect(screen.getByTestId("ap-state")).toHaveTextContent("scripts granted"));
    expect(calls.filter((c) => c.url === "/api/browse/approve").map((c) => c.body)).toEqual([{ uri: U, scripts: false, allowedTools: false }, { uri: U, scripts: true, allowedTools: false }]);
    expect(screen.getByTestId("ap-state")).toHaveTextContent("allowed-tools not granted");
    fireEvent.click(screen.getByTestId("ap-get"));
    await waitFor(() => expect(screen.getByTestId("ap-state")).toHaveTextContent("revoked"));
    expect(screen.getByTestId("ap-note")).toHaveTextContent("approval was revoked"); expect(screen.getByTestId("ap-history").querySelectorAll(".chip")).toHaveLength(2);
  });
});

describe("Source tab", () => {
  it("shows Real status, the problems list and both read-only mount examples", async () => {
    mockApi({ info: REAL_INFO });
    render(<App />);
    go("source");
    expect(await screen.findByTestId("problems")).toHaveTextContent("symlinks are not followed");
    expect(screen.getByTestId("skills-dir")).toHaveTextContent('readable (folder "skills")');
    const ex = screen.getAllByTestId("mount-example");
    expect(ex).toHaveLength(2); expect(ex[0]).toHaveTextContent("claudSkills/pingone"); expect(ex[0]).toHaveTextContent(":/skills:ro"); expect(ex[1]).toHaveTextContent(".claude/skills"); expect(ex[1]).toHaveTextContent(":/skills:ro");
  });
  it("Mock with Real unconfigured says why", async () => {
    render(<App />);
    go("source");
    expect(await screen.findByTestId("skills-dir")).toHaveTextContent("no skills directory configured");
    expect(await screen.findByTestId("no-problems")).toBeInTheDocument();
  });
});

describe("Diagram tab, Reset", () => {
  it("loads the diagram BY NAME from the server, walks the steps (Next, Previous), lights the edges of the step, drags a box and Reset restores it", async () => {
    render(<App />);
    go("diagram");
    await screen.findByTestId("rf");
    expect(calls.find((c) => c.url === "/api/diagram")).toBeTruthy();
    expect(screen.getByTestId("step-now")).toHaveTextContent("Press Simulate");
    fireEvent.click(screen.getByTestId("next"));
    expect(screen.getByTestId("step-now")).toHaveTextContent("Step 1 of 2: s1");
    expect(screen.getByTestId("edge-e0").dataset.class).toMatch(/--now/); expect(screen.getByTestId("edge-e1").dataset.class).toMatch(/--idle/);
    fireEvent.click(screen.getByTestId("next"));
    expect(screen.getByTestId("edge-e0").dataset.class).toMatch(/--seen/); expect(screen.getByTestId("edge-e1").dataset.class).toMatch(/--now/);
    fireEvent.click(screen.getByTestId("prev")); expect(screen.getByTestId("step-now")).toHaveTextContent("Step 1 of 2");
    fireEvent.click(screen.getByTestId("node-host")); expect(screen.getByTestId("node-host").dataset.x).toBe("50");
    fireEvent.click(screen.getByTestId("diagram-reset"));
    await waitFor(() => expect(screen.getByTestId("node-host").dataset.x).toBe("0"));
    expect(screen.getByTestId("step-now")).toHaveTextContent("Press Simulate");
  });
  it("the Reset button calls the server, clears the verify results and says so", async () => {
    render(<App />);
    go("verifier"); await screen.findByTestId("row-a-digest-mismatch");
    fireEvent.click(screen.getByTestId("run-all")); await screen.findByTestId("verify-summary");
    fireEvent.click(screen.getByTestId("reset"));
    await waitFor(() => expect(screen.queryByTestId("verify-summary")).toBeNull());
    expect(calls.some((c) => c.url === "/api/reset")).toBe(true);
  });
});

describe("pure helpers", () => {
  it("buildGraph: parallel edges between the same pair use different handles; the step decides idle, now and seen", () => {
    const g0 = buildGraph(DIAGRAM, -1); expect(g0.edges.map((e) => e.className)).toEqual(["flow-edge flow-edge--idle", "flow-edge flow-edge--idle"]);
    expect(new Set(g0.edges.map((e) => e.sourceHandle)).size).toBe(2);
    const g1 = buildGraph(DIAGRAM, 1); expect(g1.edges.map((e) => e.className.split("--")[1])).toEqual(["seen", "now"]); expect(g1.edges[1].animated).toBe(true);
  });
  it("the workspace id is stable per tab and well formed", () => { const a = workspaceId(); expect(a).toMatch(/^w-[0-9a-f]{16}$/); expect(workspaceId()).toBe(a); forgetWorkspace(); expect(workspaceId()).toBe(a); });
});

describe("the page shows the SERVER's verdicts, never a hard-coded PASS", () => {
  const runAll = async () => { render(<App />); go("verifier"); await screen.findByTestId("row-a-digest-mismatch"); fireEvent.click(screen.getByTestId("run-all")); return screen.findByTestId("verify-summary"); };
  it("a FAIL for one case: that cell, the summary count and the chip tone all say FAIL; the other cell says PASS", async () => {
    mockApi({ verdicts: { "a-digest-mismatch": "FAIL" } });
    const summary = await runAll();
    expect(screen.getByTestId("verdict-a-digest-mismatch-modern")).toHaveTextContent("FAIL"); expect(screen.getByTestId("verdict-a-digest-mismatch-modern").className).toMatch(/chip--danger/);
    expect(screen.getByTestId("verdict-h1-dotdot-traversal-modern")).toHaveTextContent("PASS"); expect(screen.getByTestId("verdict-h1-dotdot-traversal-modern").className).toMatch(/chip--ok/);
    expect(screen.getByTestId("summary-modern")).toHaveTextContent("2026-07-28: 1/2 PASS, 1 FAIL"); expect(screen.getByTestId("summary-modern").className).toMatch(/chip--danger/);
    expect(summary).not.toHaveTextContent("2/2 PASS");
    expect(screen.getByTestId("control-modern")).toHaveTextContent("control PASS"); expect(screen.getByTestId("control-modern").className).toMatch(/chip--ok/);
  });
  it("everything FAIL: 0/2 and both cells danger", async () => {
    mockApi({ verdicts: { "a-digest-mismatch": "FAIL", "h1-dotdot-traversal": "FAIL" } });
    await runAll();
    expect(screen.getByTestId("summary-legacy")).toHaveTextContent("2025-11-25: 0/2 PASS, 2 FAIL");
    expect(screen.getAllByTestId(/^verdict-/).every((c) => /FAIL/.test(c.textContent) && /chip--danger/.test(c.className))).toBe(true);
  });
  it("a FAIL for the clean control: its chip says FAIL in the danger tone while the cases stay PASS", async () => {
    mockApi({ control: { verdict: "FAIL", skills: [1] } });
    await runAll();
    expect(screen.getByTestId("control-modern")).toHaveTextContent("control FAIL (1 mock skills)"); expect(screen.getByTestId("control-modern").className).toMatch(/chip--danger/);
    expect(screen.getByTestId("summary-modern")).toHaveTextContent("2/2 PASS"); expect(screen.getByTestId("summary-modern").className).toMatch(/chip--ok/);
    go("overview");
    expect(await screen.findByText("Last verify")).toBeInTheDocument();
  });
  it("the counts come from the verdicts, not from the server's passed/total", async () => {
    mockApi({ verdicts: { "a-digest-mismatch": "FAIL" } });
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => { const r = await base(url, init); if (url === "/api/verify" && !JSON.parse(init.body).caseId && !JSON.parse(init.body).target) { const j = await r.json(); return { ok: true, status: 200, json: async () => ({ ...j, passed: j.total }) }; } return r; });
    await runAll();
    expect(screen.getByTestId("summary-modern")).toHaveTextContent("1/2 PASS, 1 FAIL");
  });
  it("the case detail shows the server's FAIL for that run", async () => {
    mockApi();
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => { const r = await base(url, init); if (url === "/api/verify" && JSON.parse(init.body).caseId) { const j = await r.json(); return { ok: true, status: 200, json: async () => ({ ...j, verdict: "FAIL" }) }; } return r; });
    render(<App />); go("verifier");
    fireEvent.click(await screen.findByTestId("open-a-digest-mismatch"));
    const v = await screen.findByTestId("detail-verdict");
    expect(v).toHaveTextContent("FAIL"); expect(v.className).toMatch(/chip--danger/);
  });
  it("before the case list arrives there is no hard-coded case count anywhere", async () => {
    mockApi();
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init) => (url.startsWith("/api/hostile") ? new Promise(() => {}) : base(url, init)));
    render(<App />); go("verifier");
    expect(await screen.findByTestId("run-all")).toHaveTextContent("Loading the cases..."); expect(screen.getByTestId("run-all")).toHaveAttribute("aria-disabled", "true");
    go("overview");
    expect(await screen.findByText(/Loading the hostile cases/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b22\b/);
  });
});

describe("Skills tab shows the real state", () => {
  const REFUSED = { ...SKILL, uri: "skill://x/bad/SKILL.md", name: "bad", label: "bad", loadable: false, reasons: ["uri-outside-root"] };
  it("a refused skill is labelled refused with its reasons, never loadable", async () => {
    mockApi({ skills: [REFUSED, SKILL] });
    render(<App />); go("skills");
    fireEvent.click(await screen.findByTestId("skill-bad"));
    const panel = screen.getByRole("region", { name: "Skill" });
    expect(within(panel).getByText("refused")).toBeInTheDocument(); expect(within(panel).queryByText("loadable")).toBeNull();
    expect(screen.getByTestId("refused-reasons")).toHaveTextContent("uri-outside-root");
    expect(screen.getByTestId("skill-bad")).toHaveTextContent("(refused)");
    fireEvent.click(screen.getByTestId("skill-release-checklist")); expect(within(screen.getByRole("region", { name: "Skill" })).getByText("loadable")).toBeInTheDocument();
  });
  it("an activation that did not load says 'not loaded' with the reasons, and never 'loaded'", async () => {
    mockApi({ skills: [REFUSED], activate: { loaded: false, reasons: ["uri-outside-root"], requested: {}, grants: {}, content: null, contentTruncated: false, contentLines: { shown: 0, total: 0 }, state: STATE0 } });
    render(<App />); go("skills");
    fireEvent.click(await screen.findByTestId("activate"));
    const a = await screen.findByTestId("activation");
    expect(a).toHaveTextContent("not loaded"); expect(a).toHaveTextContent("uri-outside-root"); expect(a).not.toHaveTextContent("loaded, tagged untrusted");
  });
  it("a rejected file shows the problems, no content and no green chip", async () => {
    mockApi({ file: { ok: false, problems: ["digest-mismatch"], text: null, verified: false, nested: false, bytes: null, state: STATE0 } });
    render(<App />); go("skills");
    fireEvent.click(await screen.findByTestId("view-references/CHECKLIST.md"));
    const f = await screen.findByTestId("fileview");
    expect(f).toHaveTextContent("rejected: digest-mismatch"); expect(f).not.toHaveTextContent("verified"); expect(screen.queryByTestId("filetext")).toBeNull();
  });
  it("a long file says it is cut and that the verification covered all of it; an activation cut to N lines says so", async () => {
    mockApi({ file: { ok: true, text: "x".repeat(100), problems: [], verified: true, nested: false, bytes: 200000, truncated: true, shownChars: 100, totalChars: 200000, state: STATE0 },
      activate: { loaded: true, reasons: [], requested: { allowedTools: [], hooks: false, scripts: [] }, grants: { allowedTools: [], scripts: false, hooks: false }, content: "l", contentTruncated: true, contentLines: { shown: 40, total: 300 }, state: STATE0 } });
    render(<App />); go("skills");
    fireEvent.click(await screen.findByTestId("view-references/CHECKLIST.md"));
    expect(await screen.findByTestId("truncated")).toHaveTextContent("first 100 of 200000 characters"); expect(screen.getByTestId("fileview")).toHaveTextContent("size and SHA-256 of all 200000 bytes");
    fireEvent.click(screen.getByTestId("activate"));
    expect(await screen.findByTestId("activation-truncated")).toHaveTextContent("first 40 of 300 lines");
  });
  it("a 64-character skill name wraps (class wrap) instead of widening the page; the list button wraps too", async () => {
    const LONG = "long-skill-name-" + "n".repeat(48);
    mockApi({ skills: [{ ...SKILL, name: LONG, label: LONG, uri: `skill://x/${LONG}/SKILL.md` }] });
    render(<App />); go("skills");
    expect((await screen.findByTestId("skill-title")).className).toMatch(/\bwrap\b/); expect(LONG).toHaveLength(64);
    expect(screen.getByTestId("skill-title")).toHaveTextContent(LONG);
  });
  it("changing the target or the era forgets the old connection: 'Not connected yet', empty list, counters not shown as current", async () => {
    render(<App />); go("skills");
    await screen.findByTestId("skill-release-checklist");
    expect(screen.queryByTestId("not-connected")).toBeNull();
    fireEvent.change(screen.getByTestId("target"), { target: { value: "hostile:a-digest-mismatch" } });
    expect(screen.getByTestId("not-connected")).toBeInTheDocument(); expect(screen.queryByTestId("skill-release-checklist")).toBeNull();
    fireEvent.click(screen.getByTestId("connect")); await screen.findByTestId("skill-release-checklist"); expect(screen.queryByTestId("not-connected")).toBeNull();
    fireEvent.change(screen.getByTestId("era"), { target: { value: "legacy" } });
    expect(screen.getByTestId("not-connected")).toBeInTheDocument(); expect(screen.queryByTestId("skill-release-checklist")).toBeNull();
  });
});

describe("accessibility, wording and the diagram session", () => {
  it("no aria-selected on buttons or rows; the verify table has a caption, scoped headers and no empty header cell", async () => {
    render(<App />); go("skills"); await screen.findByTestId("skill-release-checklist");
    expect(document.querySelectorAll('button[aria-selected], tr[aria-selected]')).toHaveLength(0);
    expect(screen.getByTestId("skill-release-checklist")).toHaveAttribute("aria-current", "true");
    go("verifier"); await screen.findByTestId("row-a-digest-mismatch");
    const table = screen.getByTestId("verify-table");
    expect(table.querySelector("caption")).toBeTruthy(); expect(table).toHaveAccessibleName("Hostile cases and verdicts");
    const ths = [...table.querySelectorAll("th")]; expect(ths.every((t) => t.getAttribute("scope") === "col" && t.textContent.trim() !== "")).toBe(true);
    expect(document.querySelectorAll("[aria-selected]")).toHaveLength(0);
  });
  it("the Real how-to is visible text, not only a tooltip", async () => {
    render(<App />);
    expect(await screen.findByTestId("real-howto")).toHaveTextContent("no skills directory configured"); expect(screen.getByTestId("real-howto")).toHaveTextContent("SKILLS_DIR");
  });
  it("Approvals says a script result is a gate decision and the lab never executes anything", async () => {
    render(<App />); go("approvals");
    expect(await screen.findByText(/Gate decisions only/)).toHaveTextContent("never executes anything");
  });
  it("the Source mount examples use a placeholder path, not a path into another project's checkout", async () => {
    render(<App />); go("source");
    const ex = await screen.findAllByTestId("mount-example");
    expect(ex[0]).toHaveTextContent("<path-to>/claudSkills/pingone"); expect(ex[1]).toHaveTextContent("~/.claude/skills");
    expect(document.body.textContent).not.toMatch(/Development\/AI-DEMO2|\$\{HOME\}/);
  });
  it("dragged diagram boxes keep their place when you change tab and come back; Reset puts them back", async () => {
    render(<App />); go("diagram");
    fireEvent.click(await screen.findByTestId("node-host")); expect(screen.getByTestId("node-host").dataset.x).toBe("50");
    go("overview"); await screen.findByTestId("talk-track");
    go("diagram");
    expect((await screen.findByTestId("node-host")).dataset.x).toBe("50");
    fireEvent.click(screen.getByTestId("reset"));
    await waitFor(() => expect(screen.getByTestId("node-host").dataset.x).toBe("0"));
    fireEvent.click(screen.getByTestId("node-host")); go("overview"); await screen.findByTestId("talk-track"); fireEvent.click(screen.getByTestId("reset")); go("diagram");
    expect((await screen.findByTestId("node-host")).dataset.x).toBe("0");
  });
});
