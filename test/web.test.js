// The web app's server side: static serving, the browse session API (what the Skills and Approvals tabs drive), wire capture, diagram, talk track.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/src/app.js';
import { rawRequest } from './helpers.js';
import { CSP } from '../server/src/static.js';
import { validateDiagram } from '../server/src/diagramStudioValidate.js';
import { loadDiagram, diagramByName } from '../server/src/diagramData.js';
import { MEASURED } from '../server/src/spec.js';

const B = 'http://127.0.0.1:7807';
const JSONH = { 'content-type': 'application/json' };

async function appWithDist(env = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title><div id="root"></div><script type="module" src="/assets/a.js"></script>');
  fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, '..', `secret-${path.basename(dist)}.txt`), 'outside');
  const app = await createApp({ env: { PORT: '7807', ...env }, webDist: dist });
  const send = (u, init) => app.fetch(new Request(u.startsWith('http') ? u : `${B}${u}`, init));
  const post = async (p, b, headers = {}) => { const r = await send(p, { method: 'POST', headers: { ...JSONH, ...headers }, body: JSON.stringify(b ?? {}) }); return [r.status, await r.json()]; };
  return { app, dist, send, post, done: () => { app.health.stop(); fs.rmSync(dist, { recursive: true, force: true }); fs.rmSync(path.join(dist, '..', `secret-${path.basename(dist)}.txt`), { force: true }); } };
}

test('static: / serves index.html with a strict CSP and nosniff; assets are served; HEAD works; only GET/HEAD', async () => {
  const { send, done } = await appWithDist();
  try {
    const r = await send('/');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.equal(r.headers.get('content-security-policy'), CSP); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(CSP, /default-src 'self'/); assert.doesNotMatch(CSP, /unsafe-eval|https?:/); assert.match(CSP, /script-src 'self'(;|$)/);
    assert.match(await r.text(), /id="root"/);
    const a = await send('/assets/a.js');
    assert.equal(a.status, 200); assert.match(a.headers.get('content-type'), /javascript/); assert.match(a.headers.get('cache-control'), /max-age/);
    assert.equal((await send('/', { method: 'HEAD' })).status, 200);
    assert.equal((await send('/', { method: 'DELETE' })).status, 404);
    assert.equal((await send('/nothing-here')).status, 404);
    assert.equal((await send('/assets/')).status, 404, 'no directory listing');
  } finally { done(); }
});

test('static: path traversal is impossible (raw, encoded, double-encoded, backslash, NUL) over real HTTP', async () => {
  const { app, dist, done } = await appWithDist();
  await app.listen(0, '127.0.0.1');
  const port = app.server.address().port;
  try {
    const name = `secret-${path.basename(dist)}.txt`;
    for (const p of [`/../${name}`, `/%2e%2e/${name}`, `/%2e%2e%2f${name}`, `/assets/../../${name}`, `/..%5c${name}`, `/%252e%252e/${name}`, '/%00', '/assets/%00.js', '//etc/passwd']) {
      const r = await rawRequest({ port, path: p, headers: { host: `127.0.0.1:${port}` } });
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
      assert.doesNotMatch(r.text, /outside/, p);
    }
  } finally { await app.close(); done(); }
});

test('static: the web build is absent -> a JSON 404, not a crash', async () => {
  const app = await createApp({ env: { PORT: '7807' }, webDist: path.join(os.tmpdir(), 'no-such-dist') });
  try { const r = await app.fetch(new Request(`${B}/`)); assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: 'not_found' }); } finally { app.health.stop(); }
});

test('browse: connect and list read no file (host counter 0 AND resources/read on the wire 0); one file read makes both 1', async () => {
  const { post, send, done } = await appWithDist();
  try {
    const [cs, conn] = await post('/api/browse/connect', { target: 'catalog', era: 'modern' });
    assert.equal(cs, 200); assert.equal(conn.declared, true); assert.equal(conn.negotiated, '2026-07-28');
    const [, l] = await post('/api/browse/list');
    assert.equal(l.skills.length, 4); assert.equal(l.pages, 2);
    const rc = l.skills.find((s) => s.name === 'release-checklist');
    assert.equal(rc.resources.length, 4); assert.ok(rc.loadable && rc.listed);
    assert.equal(l.state.stats.reads, 0); assert.equal(l.state.wireReads, 0);
    const [, g] = await post('/api/browse/get', { uri: rc.uri });
    assert.equal(g.state.stats.reads, 0); assert.equal(g.state.wireReads, 0);
    const [, f] = await post('/api/browse/file', { uri: rc.uri, ref: 'references/CHECKLIST.md' });
    assert.equal(f.ok, true); assert.match(f.text, /Pre-flight checklist/); assert.equal(f.verified, true);
    assert.equal(f.state.stats.reads, 1); assert.equal(f.state.wireReads, 1);
    const w = await (await send('/api/browse/wire')).json();
    assert.ok(w.wire.length >= 3);
    for (const e of w.wire) assert.match(e.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, 'a traceparent on every hop (rule 14)');
    const read = w.wire.find((e) => e.method === 'resources/read');
    assert.match(read.request, /"method": "resources\/read"/); assert.match(read.response, /Pre-flight checklist/);
    assert.equal(w.wire.filter((e) => e.method === 'resources/read').length, 1);
  } finally { done(); }
});

test('browse: a long file is cut for the page and says so, while verified still means the WHOLE file matched; a long activation says how many lines it cut', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-long-'));
  fs.mkdirSync(path.join(dir, 'big-skill'));
  fs.writeFileSync(path.join(dir, 'big-skill', 'SKILL.md'), `---\nname: big-skill\ndescription: long\n---\n${Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'big-skill', 'huge.txt'), 'x'.repeat(70000));
  fs.writeFileSync(path.join(dir, 'big-skill', 'small.txt'), 'tiny');
  const { post, done } = await appWithDist({ SKILLS_DIR: dir });
  try {
    await post('/api/browse/connect', { target: 'catalog' });
    const [, l] = await post('/api/browse/list');
    const U = l.skills[0].uri;
    const [, big] = await post('/api/browse/file', { uri: U, ref: 'huge.txt' });
    assert.equal(big.ok, true); assert.equal(big.verified, true); assert.equal(big.bytes, 70000);
    assert.equal(big.truncated, true); assert.equal(big.shownChars, 64 * 1024); assert.equal(big.totalChars, 70000); assert.equal(big.text.length, 64 * 1024);
    const [, small] = await post('/api/browse/file', { uri: U, ref: 'small.txt' });
    assert.equal(small.truncated, false); assert.equal(small.shownChars, 4); assert.equal(small.totalChars, 4);
    const [, act] = await post('/api/browse/activate', { uri: U });
    assert.equal(act.loaded, true); assert.equal(act.contentTruncated, true); assert.equal(act.contentLines.shown, 40); assert.ok(act.contentLines.total > 80);
    assert.equal(act.content.split('\n').length, 40);
  } finally { done(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('browse: a tampered file is rejected and its content is never returned; hostile and legacy targets work', async () => {
  const { post, done } = await appWithDist();
  try {
    await post('/api/browse/connect', { target: 'hostile:a-digest-mismatch', era: 'legacy' });
    const [, l] = await post('/api/browse/list');
    const [, f] = await post('/api/browse/file', { uri: l.skills[0].uri, ref: 'references/TEMPLATE.md' });
    assert.equal(f.ok, false); assert.deepEqual(f.problems, ['digest-mismatch']); assert.equal(f.text, null);
    assert.ok(f.state.findings.some((x) => x.id === 'digest-mismatch' && x.spec === 'MUST'));
    assert.equal(f.state.era, 'legacy');
    await post('/api/browse/connect', { target: 'hostile:k-unlisted-skill' });
    await post('/api/browse/list');
    const [gs, g] = await post('/api/browse/get', { uri: 'skill://hidden-helper/SKILL.md' });
    assert.equal(gs, 200); assert.equal(g.skill.listed, false);
  } finally { done(); }
});

test('browse: the approval flow over the API, A -> B -> A: separate grants, revoked at B, NOT back at A', async () => {
  const { post, done } = await appWithDist();
  try {
    const U = 'skill://report-writer/SKILL.md';
    await post('/api/browse/connect', { target: 'support:swap-aba' });
    await post('/api/browse/list');
    const hashes = [];
    const get = async () => { const [, g] = await post('/api/browse/get', { uri: U }); hashes.push(g.skill.hash); return g.state; };
    let st = await get();
    const [, a1] = await post('/api/browse/approve', { uri: U });
    assert.equal(a1.approved, true);
    assert.deepEqual(Object.values(a1.state.approvals)[0], { scripts: false, allowedTools: false, hash: hashes[0] });
    const [, a2] = await post('/api/browse/approve', { uri: U, scripts: true });
    assert.deepEqual([a2.state.approvals[U].scripts, a2.state.approvals[U].allowedTools], [true, false]);
    const [, run] = await post('/api/browse/script', { uri: U, ref: 'scripts/make.sh' });
    assert.equal(run.allowed, true);
    const [, a3] = await post('/api/browse/approve', { uri: U, scripts: true, allowedTools: true });
    const [, act] = await post('/api/browse/activate', { uri: U });
    assert.deepEqual(act.grants.allowedTools, ['Read', 'Write']);
    st = await get();                                  // manifest B
    assert.notEqual(hashes[1], hashes[0]); assert.equal(st.approvals[U], undefined); assert.ok(st.findings.some((f) => f.id === 'approval-revoked'));
    const [, run2] = await post('/api/browse/script', { uri: U, ref: 'scripts/make.sh' });
    assert.equal(run2.allowed, false);
    st = await get();                                  // back to A
    assert.equal(hashes[2], hashes[0]); assert.equal(st.approvals[U], undefined, 'the approval must not come back when the manifest returns to A');
    assert.equal((await post('/api/browse/script', { uri: U, ref: 'scripts/make.sh' }))[1].allowed, false);
    assert.ok(a3.approved);
  } finally { done(); }
});

test('browse: input validation, workspace isolation and errors', async () => {
  const { post, send, done } = await appWithDist();
  try {
    assert.equal((await post('/api/browse/list'))[0], 409);
    assert.equal((await post('/api/browse/list'))[1].error, 'not_connected');
    assert.equal((await post('/api/browse/connect', { target: 'hostile:nope' }))[0], 400);
    assert.equal((await post('/api/browse/connect', { target: 'support:l-cross-server-peer' }))[0], 400);
    assert.equal((await post('/api/browse/connect', { target: 'https://evil.example/mcp' }))[0], 400, 'a URL is never a target');
    assert.equal((await post('/api/browse/list', {}, { 'x-workspace': 'Bad Workspace!' }))[0], 400);
    assert.equal((await post('/api/browse/get', {}, { 'x-workspace': 'w-1' }))[0], 400, 'uri is required before anything else');
    await post('/api/browse/connect', { target: 'catalog' }, { 'x-workspace': 'w-one' });
    assert.equal((await post('/api/browse/list', {}, { 'x-workspace': 'w-one' }))[0], 200);
    assert.equal((await post('/api/browse/list', {}, { 'x-workspace': 'w-two' }))[0], 409, 'another workspace has its own (empty) session');
    await post('/api/browse/connect', { target: 'catalog' });
    assert.equal((await post('/api/browse/get', {}))[1].error, 'uri_required');
    assert.equal((await post('/api/browse/get', { uri: 'skill://nope/SKILL.md' }))[0], 409);
    assert.equal((await post('/api/browse/file', { uri: 'skill://never-listed/SKILL.md' }))[0], 409);
    assert.equal((await send('/api/browse/nothing', { method: 'POST', headers: JSONH, body: '{"uri":"x"}' })).status, 404);
  } finally { done(); }
});

test('Reset clears every browse session and the swap state', async () => {
  const { post, send, app, done } = await appWithDist();
  try {
    await post('/api/browse/connect', { target: 'catalog' }, { 'x-workspace': 'w-r' });
    assert.equal(app.sessions.size, 1);
    assert.equal((await post('/api/reset'))[0], 200);
    assert.equal(app.sessions.size, 0);
    assert.equal((await post('/api/browse/list', {}, { 'x-workspace': 'w-r' }))[0], 409);
    assert.equal((await (await send('/api/browse/state')).json()).connected, false);
  } finally { done(); }
});

test('verify: results carry the rule kind and the check; one case or the control can return its raw wire; the whole suite never does', async () => {
  const { post, done } = await appWithDist();
  try {
    const [, one] = await post('/api/verify', { caseId: 'e-allowed-tools-smuggling', wire: true });
    assert.equal(one.verdict, 'PASS'); assert.equal(one.kind, 'MUST'); assert.equal(one.check, 'allowed-tools'); assert.deepEqual(one.checksFired.includes('allowed-tools'), true);
    assert.ok(one.wire.length >= 3 && one.wire.every((w) => /^00-/.test(w.traceparent)));
    const [, g] = await post('/api/verify', { caseId: 'g-dynamic-skill' }); assert.equal(g.kind, 'MAY'); assert.equal(g.wire, undefined);
    const [, lab] = await post('/api/verify', { caseId: 'h1-dotdot-traversal' }); assert.equal(lab.kind, 'lab');
    const [, ctl] = await post('/api/verify', { target: 'catalog', wire: true }); assert.equal(ctl.control.verdict, 'PASS'); assert.ok(ctl.wire.length > 5);
    const [, all] = await post('/api/verify', { wire: true });
    assert.equal(all.passed, all.total); assert.equal(all.total, 23); assert.ok(all.results.every((r) => r.wire === undefined && r.kind && r.check));
    assert.deepEqual([...new Set(all.results.map((r) => r.kind))].sort(), ['MAY', 'MUST', 'SHOULD', 'lab']);
  } finally { done(); }
});

test('the swap-aba support server is honest, swapped, honest (A, B, A) on the wire and resets', async () => {
  const { app, send, done } = await appWithDist();
  try {
    const get = async () => {
      const r = await send('/mcp/hostile/swap-aba', { method: 'POST', headers: { ...JSONH, accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'skills/get' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'skills/get', params: { uri: 'skill://report-writer/SKILL.md', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
      return JSON.stringify((await r.json()).result.skill.resources);
    };
    const [a1, b, a2, a3] = [await get(), await get(), await get(), await get()];
    assert.notEqual(a1, b); assert.equal(a1, a2); assert.equal(a1, a3);
    await app.hostile.resetCase('swap-aba');
    assert.equal(await get(), a1); assert.notEqual(await get(), a1);
  } finally { done(); }
});

test('diagram: loaded by name, valid diagram-studio/1, steps point at real edges, unknown name is 404; nodes do not overlap', async () => {
  const { send, done } = await appWithDist();
  try {
    const d = await (await send('/api/diagram?name=skills-flow')).json();
    assert.deepEqual(validateDiagram(d), []); assert.equal(d.schema, 'diagram-studio/1'); assert.equal(d.nodes.length, 6); assert.equal(d.steps.length, 7);
    assert.deepEqual(d, JSON.parse(JSON.stringify(diagramByName('skills-flow'))));
    assert.deepEqual(loadDiagram('skills-flow'), d);
    assert.equal((await send('/api/diagram?name=nope')).status, 404);
    assert.equal((await send('/api/diagram?name=../../package')).status, 404);
    for (const s of d.steps) for (const e of s.edges) assert.ok(e >= 0 && e < d.edges.length);
    for (const e of d.edges) assert.ok(e.label.length <= 24, `label too long for the line: ${e.label}`);
    const boxes = d.nodes.map((n) => ({ id: n.id, x1: n.x, y1: n.y, x2: n.x + 200, y2: n.y + 100 }));
    for (const a of boxes) for (const b of boxes) if (a.id < b.id) assert.ok(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1, `${a.id} overlaps ${b.id}`);
    const bad = structuredClone(d); bad.steps[0].edges = [99];
    assert.ok(validateDiagram(bad).length > 0, 'the validator catches a step pointing at no edge');
  } finally { done(); }
});

test('the banner words: the web app and the server say the same MEASURED fact, and both say UNVERIFIED and SDK', () => {
  const web = fs.readFileSync(new URL('../web/src/banner.js', import.meta.url), 'utf8');
  assert.ok(web.includes(MEASURED), 'web/src/banner.js MEASURED differs from server/src/spec.js');
  assert.match(MEASURED, /^MEASURED 2026-11-09 /); assert.match(MEASURED, /-32601/); assert.match(MEASURED, /v1\.261106/); assert.match(MEASURED, /non-aggregate endpoint \(hostile-mcp\) passed skills\/list through to its backend/); assert.match(MEASURED, /This lab itself was not reached through the gateway/);
  assert.match(web, /UNVERIFIED/); assert.match(web, /SDK's exported protocol constants still lag/); assert.match(web, /nothing here is verified against a vendor gateway/);
  assert.doesNotMatch(MEASURED + web, /\bdoor\b/i, 'the owner says P1 Privilege Agent App / endpoint, never "door"');
});

test('/api/shelf reads SHELF_URL from the environment only; only http(s) is accepted', async () => {
  for (const [value, expected] of [['http://shelf.example:9999/', 'http://shelf.example:9999'], ['https://lab.example:8443', 'https://lab.example:8443'], ['javascript:alert(1)', null], ['', null], ['not a url', null], [undefined, null]]) {
    const { send, done } = await appWithDist(value === undefined ? {} : { SHELF_URL: value });
    try { assert.deepEqual(await (await send('/api/shelf')).json(), { shelfUrl: expected }, String(value)); } finally { done(); }
  }
});
