// Tests for the individual guards of the host verifier: each one exists because deleting the guard used to survive the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, serveExt, tamper } from './helpers.js';
import { SkillsExtension, memorySkillFiles } from '@modelcontextprotocol/server/ext/skills';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildHostileServer, mapEntries, sha256 } from '../server/src/hostile/server.js';
import { HostVerifier, MAX_PAGES } from '../server/src/verifier/host.js';
import { fileKey } from '../server/src/verifier/uri.js';

const URL_ = 'http://127.0.0.1:7807/mcp';
const REPORT = { path: 'report-writer', files: {
  'SKILL.md': '---\nname: report-writer\ndescription: Draft a short status report.\n---\n# Report\n',
  'references/TEMPLATE.md': '# Template\n\nSummary:\n',
  'scripts/make.sh': '#!/bin/sh\necho inert\n',
} };
const RW = 'skill://report-writer/SKILL.md';
const over = async (def, { wrap } = {}) => {
  const srv = await buildHostileServer(def);
  const base = (input, init) => srv.fetch(new Request(input, init));
  const send = wrap ? wrap(base) : base;
  const v = new HostVerifier({ fetch: send });
  await v.connect('s', URL_);
  return { srv, v, send };
};
const swapDigest = (e) => ({ ...e, resources: e.resources.map((r) => (r.uri.endsWith('TEMPLATE.md') ? { ...r, digest: sha256('different'), size: 9 } : r)) });

// ---- 2(a) A -> B -> A ----------------------------------------------------------------------------------------------------------------------
test('A -> B -> A manifest swap: the approval given at A is gone at B and does NOT come back when the manifest returns to A', async () => {
  const { srv, v } = await over({ skills: [REPORT], mutate: ({ method, result, state }) => (state.mode === 'B' ? mapEntries(method, result, swapDigest) : undefined) });
  await v.getSkill('s', RW);
  v.approve('s', RW, { scripts: true, allowedTools: true });
  assert.ok(v.approvalFor('s', RW), 'approved at A');
  srv.state.mode = 'B';
  await v.getSkill('s', RW);
  assert.equal(v.approvalFor('s', RW), null, 'revoked at B');
  assert.ok(v.has('approval-revoked'));
  srv.state.mode = 'A';
  await v.getSkill('s', RW);
  assert.equal(v.approvalFor('s', RW), null, 'a manifest that looks like A again does not resurrect the old approval');
  assert.equal(v.requestScriptRun('s', RW, 'scripts/make.sh').allowed, false);
  await v.close();
});

// ---- 2(b) scripts vs allowedTools are separate grants ---------------------------------------------------------------------------------------------
test('approving only allowed-tools does not allow script runs; approving only scripts does not grant allowed-tools', async () => {
  const files = { ...REPORT.files, 'SKILL.md': '---\nname: report-writer\ndescription: Draft a short status report.\nallowed-tools: Read Write\n---\n# Report\n' };
  const { v } = await over({ skills: [{ path: 'report-writer', files }] });
  await v.getSkill('s', RW);
  v.approve('s', RW, { allowedTools: true });
  assert.equal(v.requestScriptRun('s', RW, 'scripts/make.sh').allowed, false, 'allowed-tools approval is not a script approval');
  assert.deepEqual((await v.activate('s', RW)).grants.allowedTools, ['Read', 'Write']);
  v.approve('s', RW, { scripts: true });
  assert.equal(v.requestScriptRun('s', RW, 'scripts/make.sh').allowed, true);
  assert.deepEqual((await v.activate('s', RW)).grants.allowedTools, [], 'a scripts-only approval grants no tools');
  assert.equal((await v.activate('s', RW)).grants.scripts, true);
  await v.close();
});

// ---- 2(c) the page budget --------------------------------------------------------------------------------------------------------------------
test('an endless nextCursor stops at the page budget and is reported (list-truncated), not silently cut off', { timeout: 20000 }, async () => {
  const { srv } = await over({ skills: [REPORT] });
  const base = (input, init) => srv.fetch(new Request(input, init));
  const endless = tamper(base, {
    onRequest: (m) => (m.method === 'skills/list' ? { ...m, params: { ...m.params, cursor: undefined } } : m),
    onResult: (m, r) => (m.method === 'skills/list' ? { ...r, nextCursor: 'again' } : r),
  });
  const v = new HostVerifier({ fetch: endless });
  await v.connect('s', URL_);
  const l = await v.listSkills('s');
  assert.equal(l.pages, MAX_PAGES); assert.equal(l.truncated, true);
  assert.equal(endless.counts['skills/list'], MAX_PAGES, 'no request beyond the budget');
  assert.ok(v.has('list-truncated'));
  const ok = await (async () => { const w = new HostVerifier({ fetch: base }); await w.connect('s', URL_); const r = await w.listSkills('s'); await w.close(); return r; })();
  assert.equal(ok.truncated, false); assert.equal(ok.pages, 1);
  await v.close();
});

// ---- 2(d) approve and get retrieve nothing ----------------------------------------------------------------------------------------------------
test('no file retrieval at connect, list, get or approve: the server sees zero resources/read until a file is needed', async () => {
  const { srv } = await over({ skills: [REPORT] });
  const counting = tamper((i, init) => srv.fetch(new Request(i, init)));
  const v = new HostVerifier({ fetch: counting });
  await v.connect('s', URL_);
  await v.listSkills('s'); await v.getSkill('s', RW); v.approve('s', RW, { scripts: true, allowedTools: true });
  assert.equal(counting.counts['resources/read'] ?? 0, 0); assert.equal(v.stats.reads, 0);
  await v.activate('s', RW);
  assert.equal(counting.counts['resources/read'], 1, 'activation reads SKILL.md only');
  await v.close();
});

// ---- 2(e) refused skills are inert --------------------------------------------------------------------------------------------------------------
test('a refused skill (not loadable) is inert: readFile makes no request, activate does not load, approve refuses and stores nothing', async () => {
  const { srv } = await over({ skills: [REPORT], mutate: ({ method, result }) => mapEntries(method, result, (e) => ({ ...e, resources: [...e.resources, { uri: 'https://files.example/x.md', digest: sha256('x'), size: 1 }] })) });
  const counting = tamper((i, init) => srv.fetch(new Request(i, init)));
  const v = new HostVerifier({ fetch: counting });
  await v.connect('s', URL_); await v.listSkills('s');
  assert.equal(v.recordFor('s', RW).loadable, false);
  const f = await v.readFile('s', RW, 'references/TEMPLATE.md');
  assert.equal(f.ok, false); assert.match(f.problems[0], /refused/);
  const a = await v.activate('s', RW);
  assert.equal(a.loaded, false); assert.ok(a.reasons.includes('uri-outside-root'));
  const ap = v.approve('s', RW, { scripts: true });
  assert.equal(ap.approved, false); assert.equal(v.approvals.size, 0);
  assert.equal(counting.counts['resources/read'] ?? 0, 0, 'no read for a refused skill');
  await v.close();
});

test('invalid-entry: an entry whose uri is not a SKILL.md URI is refused (checked through ingest, as a hostile server could send it)', async () => {
  const { v } = await over({ skills: [REPORT] });
  const rec = v.ingest('s', { uri: 'skill://report-writer/README.md', frontmatter: { name: 'report-writer', description: 'x' }, resources: [{ uri: 'skill://report-writer/README.md', digest: sha256('x'), size: 1 }] }, true);
  assert.equal(rec.loadable, false); assert.ok(rec.reasons.includes('invalid-entry')); assert.ok(v.has('invalid-entry'));
  await v.close();
});

test('dynamic skills: declined by default; a host that allows them reads inside the root only, unverified, and cannot bind an approval', async () => {
  const dyn = { skills: [REPORT], mutate: ({ method, result }) => mapEntries(method, result, (e) => ({ ...e, resources: 'dynamic' })) };
  const strict = await over(dyn);
  assert.equal(strict.v.ingest('s', (await strict.v.getSkill('s', RW)).record.entry, true).loadable, false);
  assert.equal((await strict.v.readFile('s', RW, 'references/TEMPLATE.md')).ok, false);
  await strict.v.close();
  const srv = await buildHostileServer(dyn);
  const lax = new HostVerifier({ fetch: (i, init) => srv.fetch(new Request(i, init)), policy: { allowDynamic: true } });
  await lax.connect('s', URL_); await lax.getSkill('s', RW);
  const inside = await lax.readFile('s', RW, 'references/TEMPLATE.md');
  assert.equal(inside.ok, true); assert.equal(inside.verified, false, 'no digest to check');
  assert.equal((await lax.readFile('s', RW, 'https://files.example/payload.md')).ok, false, 'outside the root even for a dynamic skill');
  assert.equal((await lax.readFile('s', RW, 'skill://report-writer/../x')).ok, false);
  assert.equal(lax.approve('s', RW, { scripts: true }).approved, false);
  await lax.close();
});

// ---- 2(f) directory children against the held manifest ----------------------------------------------------------------------------------------
test('a directory read that returns a child the manifest does not list flags it (inManifest false) and does not extend the manifest', async () => {
  const { send } = await makeApp();
  const evil = tamper(send, { onResult: (m, r) => (m.method === 'resources/directory/read' && m.params.uri.endsWith('/examples')
    ? { ...r, resources: [...r.resources, { uri: 'skill://demo/style-guide/references/examples/extra.md', name: 'extra.md', mimeType: 'text/markdown' }] } : r) });
  const v = new HostVerifier({ fetch: evil });
  await v.connect('mock', 'http://127.0.0.1:7807/mcp'); await v.listSkills('mock');
  const SG = 'skill://demo/style-guide/SKILL.md';
  const d = await v.readDirectory('mock', 'skill://demo/style-guide/references/examples', SG);
  assert.deepEqual(d.resources.map((r) => [r.name, r.inManifest]), [['email.md', true], ['release-note.md', true], ['extra.md', false]]);
  assert.ok(v.has('directory-unlisted-child'));
  assert.equal((await v.readFile('mock', SG, 'references/examples/extra.md')).ok, false, 'an unlisted child cannot be read as a skill file');
  await v.close();
});

// ---- 4: manifest completeness, nested SKILL.md, refresh on mismatch --------------------------------------------------------------------------------
test('a manifest that lists a file twice (also under another percent-encoding) is refused', async () => {
  const { v } = await over({ skills: [REPORT] });
  const e = (await v.getSkill('s', RW)).record.entry;
  const t = e.resources.find((r) => r.uri.endsWith('TEMPLATE.md'));
  const rec = v.ingest('s', { ...e, resources: [...e.resources, { ...t, uri: t.uri.replace('TEMPLATE', 'TEMPLAT%45') }] }, true);
  assert.equal(rec.loadable, false); assert.ok(rec.reasons.includes('manifest-duplicate'));
  await v.close();
});

test('stale listing: a file that fails against the listed entry is verified against a refetched entry (skills/get) when the manifest changed; a lie that survives the refetch stays a failure', async () => {
  const { srv } = await over({ skills: [REPORT] });
  const base = (i, init) => srv.fetch(new Request(i, init));
  // skills/list is stale (wrong digest for TEMPLATE.md); skills/get is current.
  const stale = tamper(base, { onResult: (m, r) => (m.method === 'skills/list' ? { ...r, skills: r.skills.map(swapDigest) } : r) });
  const v = new HostVerifier({ fetch: stale });
  await v.connect('s', URL_); await v.listSkills('s');
  const f = await v.readFile('s', RW, 'references/TEMPLATE.md');
  assert.equal(f.ok, true, JSON.stringify(f.problems));
  assert.equal(v.stats.refreshes, 1); assert.ok(v.has('entry-refreshed'));
  assert.equal(v.has('digest-mismatch') || v.has('size-mismatch'), false, 'no failure is reported once the refetched entry verifies');
  await v.close();
  // The lie survives the refetch (list and get both wrong): the failure stands and nothing loops.
  const lying = tamper(base, { onResult: (m, r) => (m.method === 'skills/list' || m.method === 'skills/get' ? mapEntries(m.method, r, swapDigest) : r) });
  const w = new HostVerifier({ fetch: lying });
  await w.connect('s', URL_); await w.listSkills('s');
  const g = await w.readFile('s', RW, 'references/TEMPLATE.md');
  assert.equal(g.ok, false); assert.equal(w.stats.refreshes, 1); assert.equal(w.stats.reads, 1);
  assert.ok(w.has('digest-mismatch') || w.has('size-mismatch'));
  await w.close();
});

// ---- 3: percent-encoding variants of a listed file match like the SDK does --------------------------------------------------------------------
test('file names that need encoding: the skill loads, and every spelling of the listed name is found (and the SDK client agrees)', async () => {
  const files = { 'SKILL.md': '---\nname: odd-names\ndescription: Files with awkward names.\n---\n# Odd\n', 'q?x.md': 'question\n', 'h#x.md': 'hash\n', 'Q&A.md': 'qa\n', 'sp ace.md': 'space\n', 'café.md': 'cafe\n', '100%.md': 'percent\n' };
  const ext = await SkillsExtension.load(memorySkillFiles({ ...Object.fromEntries(Object.entries(files).map(([k, c]) => [`odd-names/${k}`, c])) }), { cacheHint: { ttlMs: 0, cacheScope: 'private' } });
  const send = await serveExt(ext);
  const ODD = 'skill://odd-names/SKILL.md';
  const v = new HostVerifier({ fetch: send });
  await v.connect('s', URL_);
  const l = await v.listSkills('s');
  assert.equal(l.skills[0].loadable, true, `refused: ${l.skills[0].reasons}`);
  const listed = l.skills[0].entry.resources.map((r) => r.uri);
  assert.ok(listed.some((u) => u.includes('q%3Fx.md')) && listed.some((u) => u.includes('h%23x.md')), listed.join(' '));
  const client = new Client({ name: 'sdk', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: send }));
  const sdk = new SkillsClient(client);
  const entry = l.skills[0].entry;
  const spellings = ['q?x.md', 'q%3Fx.md', 'q%3fx.md', 'h#x.md', 'h%23x.md', 'Q&A.md', 'Q%26A.md', 'sp ace.md', 'sp%20ace.md', 'café.md', 'caf%C3%A9.md', 'caf%c3%a9.md', '100%.md', '100%25.md'];
  for (const ref of spellings) {
    // The SDK treats a raw "?" or "#" in a ref as a query / fragment, so those two spellings are not file refs for either side.
    const sdkOk = await sdk.read(entry, ref).then(() => true, () => false);
    const hostOk = (await v.readFile('s', ODD, ref)).ok;
    if (/[?#]/.test(ref)) { assert.equal(hostOk, false, `${ref}: a raw ? or # is not a file name`); continue; }
    assert.equal(hostOk, sdkOk, `${ref}: host ${hostOk}, SDK ${sdkOk}`);
    assert.equal(hostOk, true, `${ref} should resolve to a listed file`);
  }
  assert.equal((await v.readFile('s', ODD, 'q%3Fx.md')).text, 'question\n');
  assert.equal((await v.readFile('s', ODD, 'nothere.md')).ok, false);
  assert.equal(fileKey('skill://a/b/', 'skill://a/b/Q&A.md'), fileKey('skill://a/b/', 'skill://a/b/Q%26A.md'));
  await client.close(); await v.close();
});

// ---- 4: other frontmatter fields, labels ---------------------------------------------------------------------------------------------------------
test('frontmatter fields outside the Agent Skills set (model, context, shell, user-invocable ...) are reported and never honoured: no tool, hook or script grant follows from them', async () => {
  const files = { 'SKILL.md': '---\nname: report-writer\ndescription: Draft a short status report.\nmodel: some-model\ncontext: fork\nshell: bash\nuser-invocable: true\ndisable-model-invocation: false\n---\n# Report\n' };
  const { v } = await over({ skills: [{ path: 'report-writer', files }] });
  await v.getSkill('s', RW);
  const a = await v.activate('s', RW);
  assert.equal(a.loaded, true);
  assert.deepEqual(a.grants, { allowedTools: [], scripts: false, hooks: false });
  const f = v.findings.find((x) => x.id === 'extra-frontmatter-ignored');
  assert.ok(f, 'reported'); assert.match(f.detail, /model.*context.*shell.*user-invocable.*disable-model-invocation/);
  await v.close();
});

test('finding labels match the spec text: loading an unlisted skill by URI is a MUST, flagging it is lab policy; surfacing a name collision is a SHOULD', async () => {
  const { FINDINGS } = await import('../server/src/verifier/findings.js');
  assert.equal(FINDINGS['unlisted-skill'].kind, 'lab');
  assert.equal(FINDINGS['name-collision'].kind, 'SHOULD');
  assert.match(FINDINGS['name-collision'].must, /MUST disambiguate/);
  assert.match(FINDINGS['unlisted-skill'].must, /lab policy/);
  for (const [id, f] of Object.entries(FINDINGS)) assert.ok(['MUST', 'SHOULD', 'MAY', 'lab', 'info'].includes(f.kind), `${id}: ${f.kind}`);
});

// ---- the resources capability is required alongside the extension -----------------------------------------------------------------------------
test('a server that declares the skills extension without the resources capability is not called: no skills/list, skills/get or directory read; finding and reason', async () => {
  for (const era of ['modern', 'legacy']) {
    const srv = await buildHostileServer({ skills: [REPORT], mutate: ({ method, result }) => ((method === 'server/discover' || method === 'initialize') && result.capabilities ? { ...result, capabilities: Object.fromEntries(Object.entries(result.capabilities).filter(([k]) => k !== 'resources')) } : undefined) });
    const counting = tamper((i, init) => srv.fetch(new Request(i, init)));
    const v = new HostVerifier({ fetch: counting });
    const info = await v.connect('s', URL_, { era });
    assert.deepEqual([info.declared, info.hasResources, info.usable], [true, false, false], era);
    const l = await v.listSkills('s');
    assert.equal(l.skills.length, 0); assert.match(l.note, /without the resources capability/);
    await assert.rejects(v.getSkill('s', RW), /resources capability/);
    await assert.rejects(v.readDirectory('s', 'skill://report-writer'), /resources capability/);
    assert.equal(counting.counts['skills/list'] ?? 0, 0); assert.equal(counting.counts['skills/get'] ?? 0, 0);
    assert.ok(v.has('resources-capability-missing'), era);
    await v.close();
  }
  // and a server that declares both is fine
  const ok = await over({ skills: [REPORT] });
  assert.equal((await ok.v.listSkills('s')).skills.length, 1);
  await ok.v.close();
});
