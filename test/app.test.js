// Health contract, Host check, same-origin writes, the mode API shape, and the MCP endpoint over real HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, listen, rawRequest, rpcClient } from './helpers.js';
import { createHealth } from '../server/src/health.js';
import { resolvePort, portProblem, assertBindAllowed, isLoopbackHost, hostProblem, crossOriginProblem } from '../server/src/safety.js';

test('GET /api/health is demo-health/1: exact shape, no-store, JSON, under 4 KB, no extra fields', async () => {
  const srv = await listen();
  try {
    await srv.app.health.ready;
    const r = await fetch(`${srv.base}/api/health`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const text = await r.text();
    assert.ok(text.length < 4096);
    const j = JSON.parse(text);
    assert.deepEqual(Object.keys(j).sort(), ['at', 'demo', 'runtime', 'schema', 'state']);
    assert.equal(j.schema, 'demo-health/1');
    assert.equal(j.state, 'ready');
    assert.equal(j.runtime, 'offline');
    assert.ok(!Number.isNaN(Date.parse(j.at)));
    assert.deepEqual(Object.keys(j.demo).sort(), ['id', 'name', 'version']);
    assert.ok(j.demo.id.length <= 64 && j.demo.name.length <= 80 && j.demo.version.length <= 32);
    assert.equal(j.demo.id, 'mcp-skills-lab');
    const post = await fetch(`${srv.base}/api/health`, { method: 'POST' });
    assert.equal(post.status, 405); assert.equal(post.headers.get('allow'), 'GET');
  } finally { await srv.close(); }
});

test('health reports broken when a doctor check fails, and unknown when the checks throw (background refresh, never per request)', async () => {
  let calls = 0;
  const h = createHealth({ runChecks: async () => { calls += 1; return [{ id: 'x', level: 'fail', detail: 'bad' }]; }, intervalMs: 3_600_000 });
  await h.ready; assert.equal(h.body().state, 'broken');
  h.body(); h.body(); assert.equal(calls, 1, 'reading the body does not run the checks');
  h.stop();
  const t = createHealth({ runChecks: async () => { throw new Error('boom'); }, intervalMs: 3_600_000 });
  await t.ready; assert.equal(t.body().state, 'unknown'); t.stop();
});

test('Host check: a non-loopback Host is refused with 403 on every route, including /mcp; loopback names pass', async () => {
  const srv = await listen();
  try {
    for (const p of ['/api/health', '/api/info', '/mcp', '/mcp/hostile/a-digest-mismatch']) {
      const bad = await rawRequest({ port: srv.port, path: p, headers: { host: 'evil.example' } });
      assert.equal(bad.status, 403, p); assert.match(bad.text, /bad_host/);
    }
    for (const h of [`127.0.0.1:${srv.port}`, `localhost:${srv.port}`, `[::1]:${srv.port}`]) {
      const ok = await rawRequest({ port: srv.port, path: '/api/health', headers: { host: h } });
      assert.equal(ok.status, 200, h);
    }
    assert.equal((await rawRequest({ port: srv.port, path: '/api/health', headers: { host: `127.0.0.1.evil.example:${srv.port}` } })).status, 403, 'a suffix trick is not loopback');
  } finally { await srv.close(); }
});

test('LAB_ALLOWED_HOSTS lets the shared lab-proxy name through, and only that name', () => {
  assert.equal(hostProblem({ host: 'lab.example:8443' }, {}), 'Host must be a loopback name');
  assert.equal(hostProblem({ host: 'lab.example:8443' }, { LAB_ALLOWED_HOSTS: 'lab.example' }), null);
  assert.equal(hostProblem({ host: 'other.example' }, { LAB_ALLOWED_HOSTS: 'lab.example' }), 'Host must be a loopback name');
});

const PROXY_HOST = 'mcp-skills-lab.local.ping-devops.com';
const PROXY_ENV = { LAB_ALLOWED_HOSTS: PROXY_HOST };
const viaProxy = (extra = {}) => ({ host: `${PROXY_HOST}:7807`, origin: 'https://local.ping-devops.com:8443', 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin', ...extra });

test('behind the lab-proxy: a write with the proxy Origin passes only when Host is on LAB_ALLOWED_HOSTS and the forwarded headers match the Origin', () => {
  const REFUSED = 'writes must be same-origin';
  assert.equal(crossOriginProblem('POST', viaProxy(), PROXY_ENV), null, 'the proxy path works');
  assert.equal(crossOriginProblem('POST', viaProxy(), {}), REFUSED, 'no allow-list: refused');
  assert.equal(crossOriginProblem('POST', viaProxy({ 'x-forwarded-host': undefined }), PROXY_ENV), REFUSED, 'no forwarded host');
  assert.equal(crossOriginProblem('POST', viaProxy({ origin: 'https://evil.example' }), PROXY_ENV), REFUSED, 'foreign Origin');
  assert.equal(crossOriginProblem('POST', viaProxy({ 'x-forwarded-host': 'evil.example' }), PROXY_ENV), REFUSED, 'forwarded host does not match the Origin');
  assert.equal(crossOriginProblem('POST', viaProxy({ origin: 'http://local.ping-devops.com:8443' }), PROXY_ENV), REFUSED, 'scheme must match X-Forwarded-Proto');
  assert.equal(crossOriginProblem('POST', viaProxy({ 'x-forwarded-proto': 'ftp', origin: 'ftp://local.ping-devops.com:8443' }), PROXY_ENV), REFUSED);
  assert.equal(crossOriginProblem('POST', viaProxy({ 'sec-fetch-site': 'cross-site' }), PROXY_ENV), REFUSED, 'cross-site stays refused');
  // Forwarded headers are ignored on any Host that is not on the list, loopback included.
  assert.equal(crossOriginProblem('POST', viaProxy({ host: '127.0.0.1:7807' }), PROXY_ENV), REFUSED, 'loopback Host does not make forwarded headers believable');
  assert.equal(crossOriginProblem('POST', viaProxy({ host: 'other.example' }), PROXY_ENV), REFUSED);
});

test('behind the lab-proxy over real HTTP: the allowed Host gets the page and a proxied write; a bad Host or a foreign Origin gets 403', async () => {
  const srv = await listen(PROXY_ENV);
  try {
    const req = (path, headers, method = 'GET', body) => rawRequest({ port: srv.port, method, path, headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await req('/api/health', { host: `${PROXY_HOST}:7807` })).status, 200);
    assert.equal((await req('/api/health', { host: 'evil.example:7807' })).status, 403, 'evil Host');
    assert.equal((await req('/api/health', { host: 'local.ping-devops.com:8443' })).status, 403, 'the bare proxy name is not on the list');
    assert.equal((await req('/api/health', { host: `x.${PROXY_HOST}:7807` })).status, 403, 'a subdomain trick');
    const mode = (h) => req('/api/mode', h, 'POST', JSON.stringify({ source: 'mock' }));
    assert.equal((await mode(viaProxy())).status, 200, 'POST /api/mode with the proxy Origin');
    assert.equal((await mode(viaProxy({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example:8443' }))).status, 403, 'foreign Origin');
    assert.equal((await mode(viaProxy({ 'x-forwarded-host': 'evil.example:8443' }))).status, 403, 'forwarded host that does not match the Origin');
    assert.equal((await mode({ host: `${PROXY_HOST}:7807`, origin: 'https://local.ping-devops.com:8443' })).status, 403, 'no forwarded headers');
  } finally { await srv.close(); }
});

test('same-origin writes: a cross-site Origin or Sec-Fetch-Site on a POST is refused (API and /mcp); same-origin and no-Origin pass', async () => {
  const srv = await listen();
  try {
    const post = (path, headers, body = '{}') => rawRequest({ port: srv.port, method: 'POST', path, headers: { host: `127.0.0.1:${srv.port}`, 'content-type': 'application/json', ...headers }, body });
    for (const p of ['/api/reset', '/api/mode', '/api/verify', '/mcp']) {
      assert.equal((await post(p, { origin: 'https://evil.example' })).status, 403, `${p} cross-origin`);
      assert.equal((await post(p, { 'sec-fetch-site': 'cross-site' })).status, 403, `${p} cross-site`);
    }
    assert.notEqual((await post('/api/reset', { origin: `http://127.0.0.1:${srv.port}` })).status, 403);
    assert.notEqual((await post('/api/reset', {})).status, 403, 'a script with no Origin is fine');
    assert.equal(crossOriginProblem('GET', { origin: 'https://evil.example' }), null, 'reads are not writes');
  } finally { await srv.close(); }
});

test('rule 19 shape: GET /api/info carries source and realAvailable; POST /api/mode accepts exactly { source }; junk is 400, unknown routes 404 with no echo', async () => {
  const srv = await listen();
  try {
    const info = await (await fetch(`${srv.base}/api/info`)).json();
    assert.equal(info.source, 'mock'); assert.equal(info.realAvailable, false); assert.deepEqual(info.modes, ['mock', 'real']);
    const post = (b, raw) => fetch(`${srv.base}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(b) });
    assert.equal((await post({ source: 'mock' })).status, 200);
    assert.equal((await post({ source: 'real' })).status, 409);
    assert.equal((await post(undefined, '{not json')).status, 400);
    assert.equal((await post([1])).status, 400);
    const nf = await fetch(`${srv.base}/definitely/not/here?x=<script>`);
    assert.equal(nf.status, 404); assert.deepEqual(await nf.json(), { error: 'not_found' });
    assert.equal((await fetch(`${srv.base}/api/nothing`)).status, 404);
  } finally { await srv.close(); }
});

test('POST bodies over 1 MiB get a clean 413 (the body is drained, not the socket destroyed)', async () => {
  const srv = await listen();
  try {
    const big = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
    const r = await fetch(`${srv.base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    assert.equal(r.status, 413); assert.deepEqual(await r.json(), { error: 'payload_too_large' });
    const m = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: big });
    assert.equal(m.status, 413);
    assert.equal((await fetch(`${srv.base}/api/health`)).status, 200, 'the server is still fine');
  } finally { await srv.close(); }
});

test('POST /api/* requires Content-Type application/json (415 otherwise); /mcp is not affected', async () => {
  const srv = await listen();
  try {
    for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonx', 'multipart/form-data']) {
      const headers = ct ? { 'content-type': ct } : {};
      for (const p of ['/api/reset', '/api/mode', '/api/verify']) {
        const r = await fetch(`${srv.base}${p}`, { method: 'POST', headers, body: ct ? '{"source":"mock"}' : undefined });
        assert.equal(r.status, 415, `${p} ${ct}`);
      }
    }
    const ok = await fetch(`${srv.base}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"source":"mock"}' });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`${srv.base}/api/verify`, { method: 'POST', headers: { 'content-type': 'APPLICATION/JSON' }, body: '{"caseId":"a-digest-mismatch"}' })).status, 200);
  } finally { await srv.close(); }
});

test('MCP over real HTTP, both eras, with the SDK client and hand-driven JSON-RPC', async () => {
  const srv = await listen();
  try {
    const c = rpcClient(fetch, { base: srv.base });
    const m = await c.modern('skills/list');
    assert.equal(m.status, 200); assert.equal(m.body.result.skills.length, 2);
    const l = rpcClient(fetch, { base: srv.base }); await l.legacyInit();
    assert.equal((await l.legacy('skills/list')).body.result.skills.length, 2);
    assert.equal((await fetch(`${srv.base}/mcp`)).status, 405, 'stateless: GET is not a session');
  } finally { await srv.close(); }
});

test('API: /api/hostile lists every case with its MUST and verdict text; /api/verify runs one case, a control, and all', async () => {
  const srv = await listen();
  try {
    const cases = (await (await fetch(`${srv.base}/api/hostile`)).json()).cases;
    assert.ok(cases.length >= 22); assert.ok(cases.every((c) => c.must && c.expected && c.endpoint.startsWith('/mcp/hostile/')));
    const post = (b) => fetch(`${srv.base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const one = await (await post({ caseId: 'a-digest-mismatch' })).json();
    assert.equal(one.verdict, 'PASS');
    assert.equal((await post({ caseId: 'nope' })).status, 400);
    const ctl = await (await post({ target: 'catalog', era: 'legacy' })).json();
    assert.equal(ctl.control.verdict, 'PASS'); assert.equal(ctl.source, 'mock');
    const all = await (await post({})).json();
    assert.equal(all.passed, all.total);
    assert.equal(all.total, cases.length);
  } finally { await srv.close(); }
});

test('ports: 7807 default, packed range 7800-7999 only, reserved ports refused, bind needs an explicit opt-in off loopback', () => {
  assert.equal(resolvePort({}), 7807);
  assert.equal(resolvePort({ PORT: '7999' }), 7999);
  for (const bad of ['7799', '8000', '8080', 'abc', '7807.5']) assert.throws(() => resolvePort({ PORT: bad }), undefined, bad);
  assert.equal(portProblem(4840), 'port 4840 is reserved for something else');
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /loopback only/);
  assert.equal(assertBindAllowed('0.0.0.0', { SKILLS_LAB_BIND: '0.0.0.0' }), '0.0.0.0');
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('[::1]') && isLoopbackHost('localhost'));
  assert.ok(!isLoopbackHost('127.0.0.1.evil.example') && !isLoopbackHost('10.0.0.1') && !isLoopbackHost('0.0.0.0'));
});
