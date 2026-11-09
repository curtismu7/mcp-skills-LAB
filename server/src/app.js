// The app, written as a Web-standard router (Request -> Response) so the same code serves real HTTP (node:http adapter below) and in-process calls
// (the verifier runs against it without a socket). Plain node:http, no framework.
import http from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { hostProblem, crossOriginProblem } from './safety.js';
import { createHealth } from './health.js';
import { createCatalogs } from './catalog/manager.js';
import { createHostileRegistry } from './hostile/registry.js';
import { HOSTILE_CASES, publicCase } from './hostile/cases.js';
import { runCase, runAllCases, runControl } from './verifier/drive.js';
import { CHECKS, FINDINGS } from './verifier/findings.js';
import { DEMO, SPEC_SOURCES, MEASURED, TABS } from './spec.js';
import { createSessions, wireEntry } from './session.js';
import { serveStatic, WEB_DIST } from './static.js';
import { diagramByName } from './diagramData.js';
import { TALK_TRACK } from './talkTrack.js';
import { SKILL_LIMITS } from '@modelcontextprotocol/server/ext/skills';

export { DEMO, SPEC_SOURCES };
const MAX_BODY = 1024 * 1024;
const DRAIN_CAP = 32 * 1024 * 1024; // beyond this the connection is dropped instead of drained
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const NOT_FOUND = () => json(404, { error: 'not_found' });

const WORKSPACE = /^[a-z0-9-]{1,40}$/;
const workspaceOf = (req) => { const v = req.headers.get('x-workspace'); return v === null ? 'default' : (WORKSPACE.test(v) ? v : null); };
// The shelf (launcher) URL comes from the SHELF_URL environment variable only; this app reads no settings file. Anything that is not http(s) is ignored.
const shelfUrl = (env) => { try { const u = new URL(String(env.SHELF_URL || '').trim()); return /^https?:$/.test(u.protocol) ? u.href.replace(/\/+$/, '') : null; } catch { return null; } };

// verifyDisable switches host checks off for POST /api/verify. It exists for the browser check's FAIL path (test/support/mutant-server.mjs); nothing in the shipped
// server passes it.
export async function createApp({ env = process.env, health, catalogs, hostile, webDist = WEB_DIST, verifyDisable = [] } = {}) {
  catalogs ??= await createCatalogs({ env });
  hostile ??= await createHostileRegistry();
  const port = Number(env.PORT) || 7807;
  const handlers = new WeakMap(); // SkillsExtension -> MCP handler (both protocol eras from one endpoint)
  const mcpFor = (ext) => {
    if (!handlers.has(ext)) {
      handlers.set(ext, createMcpHandler(() => {
        const s = new McpServer({ name: DEMO.id, version: DEMO.version });
        ext.attach(s);
        return s;
      }, { legacy: 'stateless' }));
    }
    return handlers.get(ext);
  };

  const app = { catalogs, hostile };
  health ??= createHealth({ ctx: { env, catalogs } });
  app.health = health;

  // In-process fetch used by the verify API: same router, no socket.
  const selfFetch = (input, init) => app.fetch(new Request(input, init));
  const sessions = createSessions({ fetch: selfFetch, base: `http://127.0.0.1:${port}` });
  app.sessions = sessions;

  app.fetch = async function route(req, { tooLarge = false } = {}) {
    const url = new URL(req.url);
    const headers = Object.fromEntries(req.headers);
    headers.host ||= url.host;
    const hp = hostProblem(headers, env);
    if (hp) return json(403, { error: 'bad_host', message: hp });
    const cp = crossOriginProblem(req.method, headers);
    if (cp) return json(403, { error: 'cross_origin', message: cp });
    if (tooLarge) return json(413, { error: 'payload_too_large' });
    const p = url.pathname;

    // ---- MCP endpoints (both eras) -------------------------------------------------------------------------------------------------------
    if (p === '/mcp') return mcpFor(catalogs.ext).fetch(req);
    const hm = /^\/mcp\/hostile\/([a-z0-9-]+)$/.exec(p);
    if (hm) { const srv = hostile.get(hm[1]); return srv ? srv.fetch(req) : NOT_FOUND(); }

    // ---- API -----------------------------------------------------------------------------------------------------------------------------
    if (p === '/api/health') {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return json(200, health.body());
    }
    if (!p.startsWith('/api/')) return (await serveStatic(req, webDist)) ?? NOT_FOUND();

    let body = {};
    if (req.method === 'POST') {
      if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') || '')) return json(415, { error: 'unsupported_media_type', message: 'POST bodies must be application/json' });
      const text = await req.text();
      if (text.length > MAX_BODY) return json(413, { error: 'payload_too_large' });
      if (text.trim()) { try { body = JSON.parse(text); } catch { return json(400, { error: 'bad_json' }); } }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'bad_request' });
    }

    const handler = routes.get(`${req.method} ${p}`) ?? (p.startsWith('/api/browse/') ? routes.get(`${req.method} /api/browse/*`) : undefined);
    return handler ? handler({ req, url, body, p }) : NOT_FOUND();
  };

  // ---- the API route table: method + path -> handler ----------------------------------------------------------------------------------------
  const routes = new Map();
  const on = (method) => (path, h) => routes.set(`${method} ${path}`, h);
  const R = { get: on('GET'), post: on('POST') };

  R.get('/api/info', () => json(200, { ...catalogs.info(), demo: DEMO, port, limits: SKILL_LIMITS }));
  R.post('/api/mode', ({ body }) => {
    // Rule 19: exactly { source: "mock" | "real" }. Real not configured: 409, mode unchanged.
    if (Object.keys(body).some((k) => k !== 'source')) return json(400, { error: 'bad_request', message: 'the only accepted body field is { "source": "mock" | "real" }' });
    if (body.source !== 'mock' && body.source !== 'real') return json(400, { error: 'bad_source', message: 'source must be "mock" or "real"' });
    try { catalogs.setSource(body.source); } catch (e) { return json(409, { error: e.code || 'conflict', message: e.message, source: catalogs.source, realAvailable: catalogs.realAvailable }); }
    return json(200, catalogs.info());
  });
  R.get('/api/catalog', () => json(200, { source: catalogs.source, skills: catalogs.entries, problems: catalogs.problems, simulated: catalogs.source === 'mock' }));
  R.post('/api/reset', async () => { await hostile.reset(); await sessions.reset(); return json(200, await catalogs.reset()); });
  R.get('/api/shelf', () => json(200, { shelfUrl: shelfUrl(env) }));
  R.get('/api/talk-track', () => json(200, { talkTrack: TALK_TRACK }));
  R.get('/api/diagram', ({ url }) => { const d = diagramByName(url.searchParams.get('name') ?? 'skills-flow'); return d ? json(200, d) : NOT_FOUND(); });
  R.get('/api/spec', () => json(200, { ...SPEC_SOURCES, measured: MEASURED, tabs: TABS, limits: SKILL_LIMITS, checks: CHECKS, findings: FINDINGS }));
  R.get('/api/hostile', () => json(200, { cases: HOSTILE_CASES.map(publicCase) }));

  // The browse session (the Skills and Approvals tabs): one host verifier per workspace, driven here, never by the page itself.
  const browseRoute = async ({ req, url, body, p }) => {
    const ws = workspaceOf(req);
    if (!ws) return json(400, { error: 'bad_workspace' });
    const sess = sessions.get(ws);
    const act = p.slice('/api/browse/'.length);
    const str = (v, max = 600) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
    try {
      if (act === 'wire' && req.method === 'GET') { const since = Number(url.searchParams.get('since')) || 0; return json(200, { wire: sess.wire.filter((w) => w.seq > since), ...sess.state() }); }
      if (act === 'state' && req.method === 'GET') return json(200, sess.state());
      if (req.method !== 'POST') return NOT_FOUND();
      if (act === 'connect') {
        const era = body.era === 'legacy' ? 'legacy' : 'modern';
        const t = typeof body.target === 'string' ? body.target : 'catalog';
        let urlPath;
        if (t === 'catalog') urlPath = '/mcp';
        else if (t.startsWith('hostile:') && HOSTILE_CASES.some((c) => c.id === t.slice(8))) { urlPath = `/mcp/hostile/${t.slice(8)}`; await hostile.resetCase(t.slice(8)); }
        else if (t === 'support:swap-aba') { urlPath = '/mcp/hostile/swap-aba'; await hostile.resetCase('swap-aba'); }
        else return json(400, { error: 'unknown_target', message: 'target must be one of: catalog, hostile:<case id>, support:swap-aba' });
        const info = await sess.connect({ target: t, era, urlPath });
        return json(200, { ...info, state: sess.state() });
      }
      const uri = str(body.uri);
      if (act === 'list') return json(200, { ...(await sess.list()), state: sess.state() });
      if (!uri) return json(400, { error: 'uri_required' });
      if (act === 'get') return json(200, { ...(await sess.get(uri)), state: sess.state() });
      if (act === 'file') return json(200, { ...(await sess.file(uri, str(body.ref) ?? 'SKILL.md')), state: sess.state() });
      if (act === 'dir') return json(200, { ...(await sess.dir(uri, str(body.skillUri))), state: sess.state() });
      if (act === 'activate') return json(200, { ...(await sess.activate(uri)), state: sess.state() });
      if (act === 'approve') return json(200, { ...sess.approve(uri, body), state: sess.state() });
      if (act === 'script') return json(200, { ...sess.script(uri, str(body.ref) ?? 'scripts/run.sh'), state: sess.state() });
      return NOT_FOUND();
    } catch (e) {
      return json(409, { error: e.code === 'not_connected' ? 'not_connected' : 'conflict', message: String(e.message ?? e).slice(0, 300) });
    }
  };
  R.get('/api/browse/*', browseRoute);
  R.post('/api/browse/*', browseRoute);

  R.post('/api/verify', async ({ body }) => {
    const era = body.era === 'legacy' ? 'legacy' : 'modern';
    // wire: true returns the raw request/response pairs of ONE run (a case or the control); the whole-suite run never carries them.
    const wire = []; let seq = 0;
    const opts = { fetch: selfFetch, base: `http://127.0.0.1:${port}`, era, disable: verifyDisable, beforeCase: (id) => hostile.resetCase(id), ...(body.wire === true ? { onWire: (w) => { if (wire.length < 80) wire.push(wireEntry(w, ++seq)); } } : {}) };
    if (body.target === 'catalog') return json(200, { control: await runControl({ ...opts, path: '/mcp' }), source: catalogs.source, ...(body.wire === true ? { wire } : {}) });
    if (typeof body.caseId === 'string') {
      if (!HOSTILE_CASES.some((c) => c.id === body.caseId)) return json(400, { error: 'unknown_case' });
      const r = await runCase(body.caseId, opts);
      return json(200, body.wire === true ? { ...r, wire } : r);
    }
    return json(200, await runAllCases({ ...opts, onWire: undefined }));
  });

  // ---- node:http adapter -----------------------------------------------------------------------------------------------------------------
  app.server = http.createServer(async (nreq, nres) => {
    try {
      const chunks = []; let size = 0; let tooLarge = false;
      if (!['GET', 'HEAD'].includes(nreq.method)) {
        // An oversized body is read and thrown away (up to a hard cap), then answered with 413; destroying the socket early gives the client an EPIPE instead.
        for await (const c of nreq) {
          size += c.length;
          if (size > MAX_BODY) { tooLarge = true; if (size > DRAIN_CAP) { nreq.destroy(); return; } } else chunks.push(c);
        }
      }
      const host = nreq.headers.host || 'localhost';
      const req = new Request(`http://${host}${nreq.url}`, { method: nreq.method, headers: nreq.headers, body: chunks.length && !tooLarge ? Buffer.concat(chunks) : undefined });
      const res = await app.fetch(req, { tooLarge });
      nres.writeHead(res.status, Object.fromEntries(res.headers));
      if (res.body) { const reader = res.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; nres.write(value); } }
      nres.end();
    } catch {
      if (!nres.headersSent) nres.writeHead(500, { 'content-type': 'application/json' });
      nres.end('{"error":"internal_error"}');
    }
  });
  app.listen = (p, host) => new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(p, host, () => resolve(app.server)); });
  app.close = () => new Promise((resolve) => { health.stop(); sessions.reset(); app.server.close(() => resolve()); app.server.closeAllConnections?.(); });
  return app;
}
