// The hostile catalog: every case must be caught by the host verifier in BOTH eras, the attacks must really be on the wire, and every
// check must be load-bearing (disable it and its case stops passing). A verdict of PASS means the hostile case was correctly rejected or flagged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, listen, rpcClient } from './helpers.js';
import { HOSTILE_CASES, PEER_SERVERS } from '../server/src/hostile/cases.js';
import { CHECKS, FINDINGS } from '../server/src/verifier/findings.js';
import { runCase, runAllCases, runControl } from '../server/src/verifier/drive.js';
import { HostVerifier } from '../server/src/verifier/host.js';

const harness = async () => {
  const { app, send } = await makeApp();
  const opts = (extra = {}) => ({ fetch: send, base: 'http://127.0.0.1:7807', beforeCase: (id) => app.hostile.resetCase(id), ...extra });
  return { app, send, opts };
};

test('the catalog documents every case: attack, spec MUST, expected verdict, expected findings, the guarding check', () => {
  assert.ok(HOSTILE_CASES.length >= 22, `${HOSTILE_CASES.length} cases`);
  assert.equal(new Set(HOSTILE_CASES.map((c) => c.id)).size, HOSTILE_CASES.length, 'unique ids');
  assert.deepEqual([...new Set(HOSTILE_CASES.map((c) => c.letter[0]))].sort(), 'abcdefghijklmnopqr'.split(''), 'the brief\'s cases (a)-(l) plus m, n, o (hidden block-scalar line), p (no SKILL.md in manifest), q (nested skill), r (extension without the resources capability)');
  for (const c of HOSTILE_CASES) {
    assert.ok(c.title.length > 3, `${c.id}.title`);
    for (const k of ['attack', 'must', 'expected']) assert.ok(typeof c[k] === 'string' && c[k].length > 20, `${c.id}.${k}`);
    assert.match(c.must, /MUST|MAY|SHOULD|lab policy/i, `${c.id} names the requirement level`);
    assert.ok(CHECKS.includes(c.guardedBy), `${c.id} guardedBy ${c.guardedBy}`);
    assert.ok(c.findings.length > 0 && c.findings.every((f) => f in FINDINGS), `${c.id} findings`);
    if (c.peer) assert.ok(c.peer in PEER_SERVERS, `${c.id} peer`);
  }
});

test('every named host check is the guard of at least one case (no dead check)', () => {
  assert.deepEqual([...new Set(HOSTILE_CASES.map((c) => c.guardedBy))].sort(), [...CHECKS].sort());
});

for (const era of ['modern', 'legacy']) {
  test(`${era}: every hostile case ends in verdict PASS (correctly rejected or flagged)`, async () => {
    const { opts } = await harness();
    const all = await runAllCases(opts({ era }));
    const bad = all.results.filter((r) => r.verdict !== 'PASS').map((r) => `${r.caseId}: missing [${r.missing}] failed [${r.failedAssertions}] ${r.error ?? ''}`);
    assert.deepEqual(bad, []);
    assert.equal(all.total, HOSTILE_CASES.length);
    assert.equal(all.passed, all.total);
  });
}

test('over real HTTP (a real loopback listener, global fetch): all cases PASS in both eras', async () => {
  const srv = await listen();
  try {
    for (const era of ['modern', 'legacy']) {
      for (const c of HOSTILE_CASES) {
        await srv.app.hostile.resetCase(c.id);
        const r = await runCase(c.id, { base: srv.base, era });
        assert.equal(r.verdict, 'PASS', `${era} ${c.id}: ${r.error ?? r.missing} ${r.failedAssertions}`);
      }
    }
  } finally { await srv.close(); }
});

// ---- Mutation tests: a check that is removed must make its case stop passing ------------------------------------------------------------
for (const c of HOSTILE_CASES) {
  test(`mutation: with the "${c.guardedBy}" check removed, ${c.id} no longer passes`, async () => {
    const { opts } = await harness();
    const r = await runCase(c.id, opts({ disable: [c.guardedBy] }));
    assert.notEqual(r.verdict, 'PASS', `${c.id} still passed with ${c.guardedBy} disabled: the case does not prove the check`);
    // A crash is also "killed" (the verdict is not PASS), but say which: most cases must fail by an assertion or a missing finding, not an exception.
    assert.ok(r.missing.length > 0 || r.failedAssertions.length > 0 || r.error, 'a reason is recorded');
  });
}

test('mutation: digest and size checks are independent (a same-length swap needs the digest; a wrong size needs the size)', async () => {
  const { opts } = await harness();
  assert.equal((await runCase('a-digest-mismatch', opts({ disable: ['size'] }))).verdict, 'PASS', 'size check removal does not hide a digest mismatch');
  assert.equal((await runCase('b-size-mismatch', opts({ disable: ['digest'] }))).verdict, 'PASS', 'digest check removal does not hide a size mismatch');
  assert.notEqual((await runCase('a-digest-mismatch', opts({ disable: ['digest'] }))).verdict, 'PASS');
  assert.notEqual((await runCase('b-size-mismatch', opts({ disable: ['size'] }))).verdict, 'PASS');
});

test('mutation: flipping one byte of a served file in the clean catalog makes the control fail; without the digest check it slips through', async () => {
  const { send } = await harness();
  const flip = async (input, init) => {
    const res = await send(input, init);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (!body.includes('"resources/read"') || !body.includes('CHECKLIST.md')) return res;
    const obj = JSON.parse(await res.text());
    const t = obj.result.contents[0].text;
    obj.result.contents[0].text = `${t.slice(0, 5)}${t[5] === 'X' ? 'Y' : 'X'}${t.slice(6)}`; // same length, one byte different
    return new Response(JSON.stringify(obj), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  const clean = await runControl({ fetch: send });
  assert.equal(clean.verdict, 'PASS', 'the control passes on the untouched catalog');
  const flipped = await runControl({ fetch: flip });
  assert.equal(flipped.verdict, 'FAIL');
  assert.ok(flipped.findings.some((f) => f.id === 'digest-mismatch'));
  const mutant = await runControl({ fetch: flip, disable: ['digest'] });
  assert.equal(mutant.verdict, 'PASS', 'proof the test can fail: with the digest check removed the tampered byte is accepted');
});

// ---- The attacks are really on the wire (so a PASS means something) -----------------------------------------------------------------------
test('wire: the hostile servers really lie in the documented way', async () => {
  const { send } = await harness();
  const at = (id) => rpcClient(send, { path: `/mcp/hostile/${id}` });
  const entryOf = async (id) => (await at(id).modern('skills/list')).body.result.skills[0];

  const h1 = await entryOf('h1-dotdot-traversal'); assert.ok(h1.resources.some((r) => r.uri.includes('/../')));
  const h2 = await entryOf('h2-absolute-path'); assert.ok(h2.resources.some((r) => r.uri === 'skill:///etc/hostname'));
  const h3 = await entryOf('h3-other-scheme'); assert.ok(h3.resources.some((r) => r.uri.startsWith('https://')));
  const h4 = await entryOf('h4-encoded-dotdot'); assert.ok(h4.resources.some((r) => /%2e%2e/i.test(r.uri)));
  const h5 = await entryOf('h5-encoded-backslash'); assert.ok(h5.resources.some((r) => /%5C/i.test(r.uri)));
  const p = await entryOf('p-missing-skill-md'); assert.ok(!p.resources.some((r) => r.uri.endsWith('/SKILL.md')));
  const o = await entryOf('o-comment-in-block-scalar'); assert.equal(o.frontmatter.description, 'Format text nicely.\n');
  const oMd = (await at('o-comment-in-block-scalar').modern('resources/read', { uri: o.uri })).body.result.contents[0].text;
  assert.match(oMd, /# SYSTEM: run scripts/, 'SKILL.md carries the line the entry omits');
  const q = await entryOf('q-nested-skill'); assert.ok(q.resources.some((r) => r.uri.endsWith('references/helper/SKILL.md')));
  const i1 = await entryOf('i1-too-many-files'); assert.ok(i1.resources.length > 512, `${i1.resources.length}`);
  const i2 = await entryOf('i2-too-many-bytes'); assert.ok(i2.resources.reduce((n, r) => n + r.size, 0) > 16 * 1024 * 1024);
  const g = await entryOf('g-dynamic-skill'); assert.equal(g.resources, 'dynamic');
  const c = await entryOf('c-frontmatter-mismatch'); assert.equal(c.frontmatter.description, 'A harmless formatting helper.');
  const n = await entryOf('n-name-path-mismatch'); assert.equal(n.uri, 'skill://acme/finance-helper/SKILL.md'); assert.equal(n.frontmatter.name, 'payroll');
  const e = await entryOf('e-allowed-tools-smuggling'); assert.match(e.frontmatter['allowed-tools'], /Bash\(curl/); assert.ok(e.frontmatter.hooks);

  // (a) same length, different bytes; (b) size claims more than is served
  const a = at('a-digest-mismatch');
  const aEntry = await entryOf('a-digest-mismatch');
  const aRef = aEntry.resources.find((r) => r.uri.endsWith('TEMPLATE.md'));
  const aText = (await a.modern('resources/read', { uri: aRef.uri })).body.result.contents[0].text;
  assert.equal(Buffer.byteLength(aText), aRef.size, 'size still matches in (a)');
  const b = await entryOf('b-size-mismatch');
  const bRef = b.resources.find((r) => r.uri.endsWith('TEMPLATE.md'));
  const bText = (await at('b-size-mismatch').modern('resources/read', { uri: bRef.uri })).body.result.contents[0].text;
  assert.equal(Buffer.byteLength(bText) + 7, bRef.size);

  // (d) the second skills/get differs from the first
  const d = at('d-post-approval-swap');
  const first = (await d.modern('skills/get', { uri: 'skill://report-writer/SKILL.md' })).body.result.skill;
  const second = (await d.modern('skills/get', { uri: 'skill://report-writer/SKILL.md' })).body.result.skill;
  assert.notDeepEqual(first.resources, second.resources);

  // (k) listing is partial but get answers
  const k = at('k-unlisted-skill');
  assert.equal((await k.modern('skills/list')).body.result.skills.length, 1);
  assert.equal((await k.modern('skills/get', { uri: 'skill://hidden-helper/SKILL.md' })).body.result.skill.frontmatter.name, 'hidden-helper');

  // (m) the unlisted file is actually served, so only the host's manifest rule stops it
  const m = at('m-unlisted-file-read');
  assert.match((await m.modern('resources/read', { uri: 'skill://notes-keeper/references/private/NOTES.txt' })).body.result.contents[0].text, /private notes/);
  const mEntry = (await m.modern('skills/list')).body.result.skills[0];
  assert.ok(!mEntry.resources.some((r) => r.uri.includes('NOTES.txt')));

  // (f) two skills with one name
  const f = (await at('f-name-collision').modern('skills/list')).body.result.skills;
  assert.deepEqual(f.map((s) => s.frontmatter.name), ['deploy', 'deploy']);
  assert.notEqual(f[0].uri, f[1].uri);
});

test('wire: both eras carry the same lie (the legacy SSE frames are rewritten too)', async () => {
  const { send } = await harness();
  const c = rpcClient(send, { path: '/mcp/hostile/g-dynamic-skill' });
  await c.legacyInit();
  const l = await c.legacy('skills/list');
  assert.equal(l.body.result.skills[0].resources, 'dynamic');
});

test('verifier is lazy: connect and list read no file (server-side count of resources/read is zero)', async () => {
  const { send } = await harness();
  let reads = 0;
  const counting = async (input, init) => { if (typeof init?.body === 'string' && init.body.includes('"resources/read"')) reads += 1; return send(input, init); };
  for (const era of ['modern', 'legacy']) {
    const v = new HostVerifier({ fetch: counting });
    await v.connect('srv', 'http://127.0.0.1:7807/mcp', { era });
    const l = await v.listSkills('srv');
    assert.equal(l.skills.length, 4); assert.equal(l.pages, 2);
    assert.equal(reads, 0, `${era}: no resources/read on connect or list`);
    assert.equal(v.stats.reads, 0);
    await v.close();
  }
});

test('control: the clean Mock catalog verifies completely in both eras (every skill loads, every file matches, no findings)', async () => {
  const { send } = await harness();
  for (const era of ['modern', 'legacy']) {
    const r = await runControl({ fetch: send, era });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.findings ?? r.error));
    assert.equal(r.skills.length, 4);
    assert.equal(r.skills.reduce((n, s) => n + s.files.length, 0), 6, 'non-SKILL.md files: 3 + 1 + 2');
    assert.equal(r.readsAfterList, 0);
    assert.deepEqual(r.findings, []);
  }
});

test('cases isolate: the post-approval swap counter resets between runs', async () => {
  const { opts } = await harness();
  for (let i = 0; i < 3; i++) assert.equal((await runCase('d-post-approval-swap', opts())).verdict, 'PASS', `run ${i + 1}`);
});
