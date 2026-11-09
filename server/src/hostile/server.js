// Builds one hostile skills server: an honest SDK-built server (SkillsExtension over a small static source) wrapped by a wire mutator that lies
// in a documented way. The hostile servers live at /mcp/hostile/<case-id>; each case has its own state so a swap in one never leaks into another.
import { createHash } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills';

export const sha256 = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

/** A static SkillSource: entries built by the SDK's skillEntry (correct digests), hidden skills served by get/read only, extra files served but never listed. */
function staticSource({ skills, hidden = [], extraFiles = {} }) {
  let built;
  const build = async () => {
    if (built) return built;
    const all = new Map(); const files = new Map(); const listed = [];
    for (const s of [...skills, ...hidden]) {
      const entry = await skillEntry(s.path, s.files);
      all.set(entry.uri, entry);
      for (const [rel, content] of Object.entries(s.files)) files.set(`skill://${s.path}/${rel}`, content);
      if (!hidden.includes(s)) listed.push(entry);
    }
    for (const [uri, content] of Object.entries(extraFiles)) files.set(uri, content);
    built = { all, files, listed };
    return built;
  };
  return {
    async list() { const b = await build(); return { skills: b.listed }; },
    async get(uri) { return (await build()).all.get(uri); },
    async read(uri) { const c = (await build()).files.get(uri); return c === undefined ? undefined : (typeof c === 'string' ? { text: c } : { bytes: c }); },
    async readDirectory() { return undefined; },
  };
}

/** Re-serialises a JSON-RPC response (plain JSON or SSE "data:" frames) after `fn` changed its result. */
async function rewrite(res, fn) {
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  const headers = new Headers(res.headers); headers.delete('content-length');
  let body = text;
  const apply = (obj) => { if (obj && typeof obj === 'object' && obj.result && !obj.error) obj.result = fn(obj.result) ?? obj.result; return obj; };
  try {
    if (type.includes('text/event-stream')) body = text.split('\n').map((l) => (l.startsWith('data:') ? `data: ${JSON.stringify(apply(JSON.parse(l.slice(5))))}` : l)).join('\n');
    else if (type.includes('json')) body = JSON.stringify(apply(JSON.parse(text)));
  } catch { body = text; }
  return new Response(body, { status: res.status, headers });
}

/**
 * def: { skills, hidden?, extraFiles?, mutate?(ctx) }.  mutate ctx: { method, params, result, count, state } -> new result (or undefined to keep).
 * count = how many times this (method, uri) was answered before this response. state = per-server scratch object.
 */
export async function buildHostileServer(def) {
  const ext = new SkillsExtension({ source: staticSource(def), baseUri: 'skill://', cacheHint: { ttlMs: 0, cacheScope: 'private' }, onWarning: () => {} });
  const handler = createMcpHandler(() => { const s = new McpServer({ name: 'mcp-skills-lab-hostile', version: '0.1.0' }); ext.attach(s); return s; }, { legacy: 'stateless' });
  const state = {}; const counts = new Map();
  if (!def.mutate) return { fetch: (req) => handler.fetch(req), state };
  return {
    state,
    async fetch(req) {
      if (req.method !== 'POST') return handler.fetch(req);
      let msg; try { msg = JSON.parse(await req.clone().text()); } catch { return handler.fetch(req); }
      const res = await handler.fetch(req);
      const method = msg?.method; const params = msg?.params ?? {};
      const k = `${method}|${params.uri ?? ''}`; const count = counts.get(k) ?? 0; counts.set(k, count + 1);
      return rewrite(res, (result) => def.mutate({ method, params, result, count, state }));
    },
  };
}

/** Applies fn to every skill entry in a skills/list or skills/get result. */
export function mapEntries(method, result, fn) {
  if (method === 'skills/list') return { ...result, skills: result.skills.map(fn) };
  if (method === 'skills/get') return { ...result, skill: fn(result.skill) };
  return undefined;
}
