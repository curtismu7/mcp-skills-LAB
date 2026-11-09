// The wire, hand-driven, in BOTH protocol eras, against the Mock catalog. Every number below is asserted, not printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeApp, rpcClient } from './helpers.js';

const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const ID = 'io.modelcontextprotocol/skills';

async function modernAll(c, method, key) {
  const out = []; let cursor; let pages = 0; let first;
  do {
    const r = await c.modern(method, cursor ? { cursor } : {});
    assert.equal(r.status, 200, r.text); first ??= r.body.result; pages += 1;
    out.push(...r.body.result[key]); cursor = r.body.result.nextCursor;
  } while (cursor && pages < 10);
  return { items: out, pages, first };
}

test('modern: server/discover declares resources and the skills extension with directoryRead', async () => {
  const { send } = await makeApp(); const c = rpcClient(send);
  const r = await c.modern('server/discover');
  assert.equal(r.status, 200);
  const res = r.body.result;
  assert.ok(res.supportedVersions.includes('2026-07-28'));
  assert.ok(res.capabilities.resources, 'resources capability is required alongside the extension');
  assert.deepEqual(res.capabilities.extensions[ID], { directoryRead: true });
  assert.equal(res.resultType, 'complete');
});

test('modern: skills/list pages with a cursor, never splits a skill, and carries resultType, ttlMs and cacheScope', async () => {
  const { send } = await makeApp(); const c = rpcClient(send);
  const { items, pages, first } = await modernAll(c, 'skills/list', 'skills');
  assert.equal(items.length, 4);
  assert.equal(pages, 2, 'pageSize 2 over 4 mock skills = 2 pages');
  assert.equal(first.resultType, 'complete');
  assert.equal(first.ttlMs, 30000);
  assert.equal(first.cacheScope, 'public');
  assert.deepEqual(items.map((s) => s.frontmatter.name), ['log-summarizer', 'meeting-notes', 'release-checklist', 'style-guide']);
  for (const s of items) {
    assert.match(s.uri, /^skill:\/\/demo\/[a-z-]+\/SKILL\.md$/);
    assert.equal(s.uri.split('/').at(-2), s.frontmatter.name, 'last path segment equals frontmatter name');
    assert.ok(s.resources.some((r) => r.uri === s.uri), 'the manifest lists SKILL.md itself');
    assert.equal(new Set(s.resources.map((r) => r.uri)).size, s.resources.length, 'every file exactly once');
    for (const r of s.resources) { assert.match(r.digest, /^sha256:[0-9a-f]{64}$/); assert.ok(Number.isInteger(r.size) && r.size > 0); }
  }
});

test('modern: a bad cursor is -32602', async () => {
  const { send } = await makeApp(); const c = rpcClient(send);
  const r = await c.modern('skills/list', { cursor: 'not-a-cursor' });
  assert.equal(r.body.error.code, -32602);
});

test('modern: skills/get returns the entry; an unknown skill is -32602', async () => {
  const { send } = await makeApp(); const c = rpcClient(send);
  const ok = await c.modern('skills/get', { uri: 'skill://demo/meeting-notes/SKILL.md' });
  assert.equal(ok.body.result.skill.frontmatter.name, 'meeting-notes');
  assert.equal(ok.body.result.resultType, 'complete');
  assert.ok('ttlMs' in ok.body.result && 'cacheScope' in ok.body.result);
  const bad = await c.modern('skills/get', { uri: 'skill://demo/nope/SKILL.md' });
  assert.equal(bad.body.error.code, -32602);
});

test('modern: resources/read serves every manifest file and each one matches its digest and size', async () => {
  const { send } = await makeApp(); const c = rpcClient(send);
  const { items } = await modernAll(c, 'skills/list', 'skills');
  let files = 0;
  for (const s of items) for (const f of s.resources) {
    const r = await c.modern('resources/read', { uri: f.uri });
    assert.equal(r.status, 200, r.text);
    const content = r.body.result.contents[0];
    const bytes = content.text !== undefined ? Buffer.from(content.text, 'utf8') : Buffer.from(content.blob, 'base64');
    assert.equal(bytes.length, f.size, f.uri);
    assert.equal(sha(bytes), f.digest, f.uri);
    files += 1;
  }
  assert.equal(files, 10, '4 SKILL.md + 3 references + 1 script + 2 examples');
});

test('modern: resources/read of an unserved file is -32602; a missing Mcp-Name header is HTTP 400 / -32020', async () => {
  const { send } = await makeApp(); const c = rpcClient(send);
  const bad = await c.modern('resources/read', { uri: 'skill://demo/meeting-notes/nothing.md' });
  assert.equal(bad.body.error.code, -32602);
  const raw = await c.post({ jsonrpc: '2.0', id: 99, method: 'resources/read', params: { uri: 'skill://demo/meeting-notes/SKILL.md', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'x', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'resources/read' });
  assert.equal(raw.status, 400);
  assert.equal(raw.messages[0].error.code, -32020);
  const noMethod = await c.post({ jsonrpc: '2.0', id: 100, method: 'skills/list', params: {} }, { 'MCP-Protocol-Version': '2026-07-28' });
  assert.equal(noMethod.status, 400);
});

test('modern: resources/directory/read lists direct children only; a file or a missing path is -32602', async () => {
  const { send } = await makeApp(); const c = rpcClient(send);
  const top = await c.modern('resources/directory/read', { uri: 'skill://demo/style-guide' });
  const names = top.body.result.resources.map((r) => `${r.name}:${r.mimeType}`).sort();
  assert.deepEqual(names, ['SKILL.md:text/markdown', 'references:inode/directory']);
  assert.equal(top.body.result.resultType, 'complete');
  const nested = await c.modern('resources/directory/read', { uri: 'skill://demo/style-guide/references/examples' });
  assert.deepEqual(nested.body.result.resources.map((r) => r.name).sort(), ['email.md', 'release-note.md']);
  assert.equal((await c.modern('resources/directory/read', { uri: 'skill://demo/style-guide/SKILL.md' })).body.error.code, -32602);
  assert.equal((await c.modern('resources/directory/read', { uri: 'skill://demo/nope' })).body.error.code, -32602);
});

test('legacy (2025-11-25, stateless): initialize declares the extension, then list, get, read and directory read work', async () => {
  const { send } = await makeApp(); const c = rpcClient(send);
  const init = await c.legacyInit();
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.body.result.capabilities.extensions[ID], { directoryRead: true });
  assert.ok(init.body.result.capabilities.resources);
  const list = await c.legacy('skills/list');
  assert.equal(list.body.result.skills.length, 2, 'first page of two');
  assert.ok(list.body.result.nextCursor);
  const second = await c.legacy('skills/list', { cursor: list.body.result.nextCursor });
  assert.equal(second.body.result.skills.length, 2);
  const get = await c.legacy('skills/get', { uri: 'skill://demo/release-checklist/SKILL.md' });
  assert.equal(get.body.result.skill.resources.length, 4);
  const read = await c.legacy('resources/read', { uri: 'skill://demo/release-checklist/references/CHECKLIST.md' });
  assert.match(read.body.result.contents[0].text, /Pre-flight checklist/);
  const dir = await c.legacy('resources/directory/read', { uri: 'skill://demo/log-summarizer/scripts' });
  assert.deepEqual(dir.body.result.resources.map((r) => r.name), ['count-levels.sh']);
  assert.equal((await c.legacy('skills/get', { uri: 'skill://demo/zzz/SKILL.md' })).body.error.code, -32602);
});

test('both eras return identical entries for the same skill (digests and sizes agree)', async () => {
  const { send } = await makeApp();
  const m = await rpcClient(send).modern('skills/get', { uri: 'skill://demo/release-checklist/SKILL.md' });
  const l = rpcClient(send); await l.legacyInit();
  const lg = await l.legacy('skills/get', { uri: 'skill://demo/release-checklist/SKILL.md' });
  assert.deepEqual(lg.body.result.skill, m.body.result.skill);
});
