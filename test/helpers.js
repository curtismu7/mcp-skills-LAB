// Hand-driven JSON-RPC over `fetch`-shaped functions (app.fetch in-process, or real HTTP). No SDK client involved, so the wire shape itself is tested.
import http from 'node:http';
import { createApp } from '../server/src/app.js';

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'lab-test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** Parses a JSON body or the "data:" frames of an SSE body into the JSON-RPC messages it carries. */
export function messagesOf(contentType, text) {
  if (/text\/event-stream/.test(contentType || '')) return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  return text ? [JSON.parse(text)] : [];
}

export function rpcClient(send, { path = '/mcp', base = 'http://127.0.0.1:7807' } = {}) {
  let id = 0;
  const post = async (body, headers) => {
    const res = await send(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type'), messages: messagesOf(res.headers.get('content-type'), text), text };
  };
  return {
    post,
    /** A 2026-07-28 request: headers + per-request _meta envelope. `name` becomes Mcp-Name (resources/read uses the URI). */
    async modern(method, params = {}, { name, headers = {} } = {}) {
      const h = { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...headers };
      if (name !== undefined) h['Mcp-Name'] = name;
      else if (method === 'resources/read') h['Mcp-Name'] = params.uri;
      const r = await post({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: META } }, h);
      return { ...r, body: r.messages[0] };
    },
    /** A 2025-11-25 stateless request: initialize first, then plain requests. */
    async legacyInit() {
      const r = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lab-test', version: '0' } } });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return { ...r, body: r.messages[0] };
    },
    async legacy(method, params = {}) {
      const r = await post({ jsonrpc: '2.0', id: ++id, method, params });
      return { ...r, body: r.messages[0] };
    },
  };
}

export async function makeApp(env = {}) {
  const app = await createApp({ env: { PORT: '7807', ...env } });
  const send = (input, init) => app.fetch(new Request(input, init));
  return { app, send, close: async () => { app.health.stop(); } };
}

/** A real HTTP listener on an ephemeral loopback port. */
export async function listen(env = {}) {
  const app = await createApp({ env: { PORT: '7807', ...env } });
  await app.listen(0, '127.0.0.1');
  const port = app.server.address().port;
  return { app, port, base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

/** Sends a raw HTTP request with a chosen Host header (fetch will not let a test set it). */
export function rawRequest({ port, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Serves a SkillsExtension (or any McpServer factory) from a fetch-shaped function, both eras. */
export async function serveExt(ext) {
  const { McpServer, createMcpHandler } = await import('@modelcontextprotocol/server');
  const handler = createMcpHandler(() => { const s = new McpServer({ name: 'test-skills', version: '0' }); ext.attach(s); return s; }, { legacy: 'stateless' });
  return (input, init) => handler.fetch(new Request(input, init));
}

/**
 * Wraps a fetch-shaped function: `onRequest(msg)` may return a changed request message, `onResult(msg, result)` a changed result.
 * Works for the JSON responses the modern era sends. Counts requests by method in `.counts`.
 */
export function tamper(send, { onRequest, onResult } = {}) {
  const counts = {};
  const fn = async (input, init) => {
    let msg; try { msg = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { msg = undefined; }
    if (msg?.method) counts[msg.method] = (counts[msg.method] ?? 0) + 1;
    const body = msg && onRequest ? JSON.stringify(onRequest(msg) ?? msg) : init?.body;
    const res = await send(input, { ...init, body });
    if (!msg || !onResult || !(res.headers.get('content-type') || '').includes('json')) return res;
    const obj = JSON.parse(await res.text());
    if (obj.result) obj.result = onResult(msg, obj.result) ?? obj.result;
    return new Response(JSON.stringify(obj), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  fn.counts = counts;
  return fn;
}
