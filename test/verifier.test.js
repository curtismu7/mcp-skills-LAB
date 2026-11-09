import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { HostVerifier, outsideRootReason, resourcesHash } from '../server/src/verifier/host.js';

const ROOT = 'skill://acme/tool/';

test('outsideRootReason: files inside the root (including legitimately encoded ones) pass', () => {
  for (const ok of [`${ROOT}SKILL.md`, `${ROOT}references/a.md`, `${ROOT}a/b/c.txt`, `${ROOT}file%20name.md`, `${ROOT}q%3Fx.md`, `${ROOT}h%23x.md`, `${ROOT}100%25.md`, `${ROOT}a%2520b.md`, `${ROOT}caf%C3%A9.md`]) {
    assert.equal(outsideRootReason(ROOT, ok), null, ok);
  }
});

test('outsideRootReason: every escape form is refused, each with its own reason', () => {
  const cases = {
    'dotdot': `${ROOT}../other/SKILL.md`, 'dotdot deep': `${ROOT}a/../../x`, 'dot': `${ROOT}./a`, 'empty segment': `${ROOT}a//b`, 'leading slash': `${ROOT}/abs`,
    'absolute path': 'skill:///etc/passwd', 'sibling root': 'skill://acme/tool2/SKILL.md', 'other skill': 'skill://acme/other/SKILL.md', 'https': 'https://x.example/a', 'file scheme': 'file:///etc/passwd',
    'encoded dotdot': `${ROOT}%2e%2e/x`, 'encoded dotdot mixed case': `${ROOT}%2E%2e/x`, 'double-encoded dotdot': `${ROOT}%252e%252e/x`, 'triple-encoded dotdot': `${ROOT}%25252e%25252e/x`,
    'encoded slash then dotdot': `${ROOT}%2e%2e%2fx`, 'raw backslash': `${ROOT}a\\..\\b`, 'encoded backslash %5C': `${ROOT}a%5Cb`, 'lowercase %5c': `${ROOT}a%5cb`, 'double-encoded backslash': `${ROOT}a%255Cb`,
    'NUL': `${ROOT}a%00b`, 'raw NUL': `${ROOT}a\u0000b`, 'raw newline': `${ROOT}a\nb`, 'raw CR': `${ROOT}a\rb`, 'encoded newline': `${ROOT}a%0Ab`, 'encoded CR': `${ROOT}a%0Db`,
    'bidi RLO raw': `${ROOT}a\u202Eb`, 'bidi RLO encoded': `${ROOT}a%E2%80%AEb`, 'bidi isolate': `${ROOT}a\u2066b`, 'bidi isolate encoded': `${ROOT}a%E2%81%A6b`,
    'fullwidth dots raw': `${ROOT}\uFF0E\uFF0E/x`, 'fullwidth dots encoded': `${ROOT}%EF%BC%8E%EF%BC%8E/x`, 'ideographic full stop': `${ROOT}a%E3%80%82b`,
    'dotdot semicolon': `${ROOT}..;/x`, 'dotdot semicolon inner': `${ROOT}a/..;x/b`, 'dot semicolon': `${ROOT}.;/x`,
    'never converges': `${ROOT}%2525252525252e`, 'never converges dotdot': `${ROOT}%25252525252e%25252525252e/x`,
    'query': `${ROOT}a?x=1`, 'fragment': `${ROOT}a#f`, 'the root itself': ROOT, 'empty': '',
  };
  for (const [what, uri] of Object.entries(cases)) assert.notEqual(outsideRootReason(ROOT, uri), null, `${what}: ${JSON.stringify(uri)}`);
  assert.match(outsideRootReason(ROOT, cases['never converges']), /does not converge/);
  assert.match(outsideRootReason(ROOT, cases['encoded backslash %5C']), /backslash/);
  assert.match(outsideRootReason(ROOT, cases['dotdot semicolon']), /\.\.;/);
  assert.match(outsideRootReason(ROOT, cases['bidi RLO encoded']), /bidirectional/);
  assert.match(outsideRootReason(ROOT, cases['fullwidth dots encoded']), /fullwidth/);
});

test('resourcesHash: order-independent; any uri, digest or size change moves it; dynamic has none', () => {
  const a = { uri: `${ROOT}SKILL.md`, digest: `sha256:${'a'.repeat(64)}`, size: 5 };
  const b = { uri: `${ROOT}x.md`, digest: `sha256:${'b'.repeat(64)}`, size: 6 };
  assert.equal(resourcesHash([a, b]), resourcesHash([b, a]));
  assert.notEqual(resourcesHash([a, b]), resourcesHash([a, { ...b, digest: `sha256:${'c'.repeat(64)}` }]));
  assert.notEqual(resourcesHash([a, b]), resourcesHash([a, { ...b, size: 7 }]));
  assert.notEqual(resourcesHash([a, b]), resourcesHash([a, { ...b, uri: `${ROOT}y.md` }]));
  assert.notEqual(resourcesHash([a, b]), resourcesHash([a]));
  assert.equal(resourcesHash('dynamic'), null);
});

async function connected(opts = {}) {
  const { send } = await makeApp();
  const v = new HostVerifier({ fetch: send, ...opts });
  await v.connect('mock', 'http://127.0.0.1:7807/mcp', { era: opts.era ?? 'modern' });
  return v;
}
const RC = 'skill://demo/release-checklist/SKILL.md';

test('reading SKILL.md with readFile does NOT activate a skill; only activate() does', async () => {
  const v = await connected();
  await v.listSkills('mock');
  const file = await v.readFile('mock', RC);
  assert.equal(file.ok, true); assert.equal(v.activated.size, 0);
  const act = await v.activate('mock', RC);
  assert.equal(act.loaded, true); assert.deepEqual([...v.activated], [`mock|${RC}`]);
  await v.close();
});

test('accepted content is tagged with the host-assigned server label and marked untrusted; the label is not serverInfo.name', async () => {
  const v = await connected();
  await v.listSkills('mock');
  const act = await v.activate('mock', RC);
  assert.match(act.content, /^<skill-content origin="mock" uri="skill:\/\/demo\/release-checklist\/SKILL\.md" trust="untrusted">/);
  assert.doesNotMatch(act.content, /mcp-skills-lab/);
  await v.close();
});

test('approval is bound to the resources set: it survives a re-get of the same set and is gone when the hash differs', async () => {
  const v = await connected();
  await v.listSkills('mock');
  assert.deepEqual(v.approve('mock', RC, { scripts: true }).approved, true);
  await v.getSkill('mock', RC);
  assert.equal(v.approvalFor('mock', RC)?.scripts, true, 'same set, approval kept');
  assert.equal(v.requestScriptRun('mock', RC, 'scripts/x.sh').allowed, true);
  const rec = v.recordFor('mock', RC);
  rec.entry = { ...rec.entry, resources: rec.entry.resources.map((r, i) => (i === 0 ? { ...r, digest: `sha256:${'0'.repeat(64)}` } : r)) };
  rec.hash = resourcesHash(rec.entry.resources);
  assert.equal(v.approvalFor('mock', RC), null, 'a different set has no approval');
  await v.close();
});

test('scripts need approval: without it the run is denied and recorded; the verifier never executes anything', async () => {
  const v = await connected();
  await v.listSkills('mock');
  const r = v.requestScriptRun('mock', 'skill://demo/log-summarizer/SKILL.md', 'scripts/count-levels.sh');
  assert.equal(r.allowed, false);
  assert.ok(v.has('script-exec-denied'));
  assert.deepEqual(v.executed, []);
  await v.close();
});

test('resources/directory/read is refused client-side when directoryRead was not declared', async () => {
  const v = await connected();
  await v.listSkills('mock');
  v.server('mock').directoryRead = false;
  await assert.rejects(v.readDirectory('mock', 'skill://demo/style-guide'), /directoryRead/);
  await v.close();
});

test('resources/directory/read: children are classified against the held manifest (files listed = inManifest true, folders = null), and nothing joins the manifest', async () => {
  const v = await connected();
  await v.listSkills('mock');
  const SG = 'skill://demo/style-guide/SKILL.md';
  const before = JSON.stringify(v.recordFor('mock', SG).entry.resources);
  const top = await v.readDirectory('mock', 'skill://demo/style-guide/references', SG);
  assert.deepEqual(top.resources.map((r) => [r.name, r.inManifest]), [['examples', null]]);
  const ex = await v.readDirectory('mock', 'skill://demo/style-guide/references/examples', SG);
  assert.deepEqual(ex.resources.map((r) => [r.name, r.inManifest]), [['email.md', true], ['release-note.md', true]]);
  assert.equal(JSON.stringify(v.recordFor('mock', SG).entry.resources), before, 'the held manifest is unchanged');
  assert.equal(v.has('directory-unlisted-child'), false);
  await v.close();
});

test('the same skill listed twice is one registry entry per (server, uri), and two servers with equal names stay separate', async () => {
  const v = await connected();
  await v.listSkills('mock'); await v.listSkills('mock');
  assert.equal(v.registry().length, 4);
  await v.connect('second', 'http://127.0.0.1:7807/mcp');
  await v.listSkills('second');
  assert.equal(v.registry().length, 8);
  const mn = v.registry().filter((r) => r.name === 'meeting-notes');
  assert.equal(mn.length, 2); assert.notEqual(mn[0].label, mn[1].label);
  assert.ok(v.has('name-collision'));
  await v.close();
});

test('unknown checks are refused so a typo cannot silently disable nothing', () => {
  assert.throws(() => new HostVerifier({ disable: ['digset'] }), /unknown check/);
});

test('the verifier has no execution path: no child_process, eval or Function anywhere in the verifier or hostile code', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const dirs = ['verifier', 'hostile', 'catalog'].map((d) => new URL(`../server/src/${d}/`, import.meta.url).pathname);
  for (const d of dirs) for (const f of fs.readdirSync(d)) {
    const t = fs.readFileSync(path.join(d, f), 'utf8');
    assert.ok(!/child_process|\beval\(|new Function|node:vm|worker_threads/.test(t), `${d}${f}`);
  }
});
