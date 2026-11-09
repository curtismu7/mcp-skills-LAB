// Real mode: skills read at runtime from SKILLS_DIR. The fixture folder is built inside each test under the OS temp dir; nothing external is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, rpcClient } from './helpers.js';
import { loadRealCatalog, NO_DIR_REASON } from '../server/src/catalog/real.js';
import { runControl } from '../server/src/verifier/drive.js';

const md = (name, description = 'A fixture skill.', extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n\nBody for ${name}.\n`;

/** Builds a throwaway skills root plus a sibling "outside" folder the root must never serve. */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-lab-'));
  const root = path.join(base, 'skills');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret\n');
  const w = (rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  w('alpha/SKILL.md', md('alpha'));
  w('alpha/references/NOTES.md', '# Notes\n\nSome notes.\n');
  w('beta/SKILL.md', md('beta', 'Second skill.'));
  w('beta/scripts/run.sh', '#!/bin/sh\necho inert\n');
  return { base, root, outside, w, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const problemFor = (cat, p) => cat.problems.filter((x) => x.path === p || x.path.startsWith(`${p}/`));

test('no SKILLS_DIR: Real is reported unavailable through the API (409), nothing crashes, Mock keeps serving', async () => {
  const { send, app } = await makeApp({});
  const info = await (await send('http://127.0.0.1:7807/api/info')).json();
  assert.equal(info.source, 'mock'); assert.equal(info.realAvailable, false); assert.equal(info.realReason, NO_DIR_REASON);
  const r = await send('http://127.0.0.1:7807/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'real' }) });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.error, 'real_not_available'); assert.match(body.message, /no skills directory configured/);
  assert.equal(app.catalogs.source, 'mock', 'the mode did not change');
  const l = await rpcClient(send).modern('skills/list');
  assert.equal(l.status, 200);
});

test('SKILLS_DIR that is missing or not a directory: Real unavailable with a reason, no crash', async () => {
  const f = fixture();
  try {
    for (const dir of [path.join(f.base, 'does-not-exist'), path.join(f.root, 'alpha', 'SKILL.md')]) {
      const { app } = await makeApp({ SKILLS_DIR: dir });
      assert.equal(app.catalogs.realAvailable, false);
      assert.match(app.catalogs.realReason, /not readable/);
      assert.equal(app.catalogs.source, 'mock');
    }
  } finally { f.cleanup(); }
});

test('Real mode serves fixture skills over both eras and the host verifier verifies every file', async () => {
  const f = fixture();
  try {
    const { send, app } = await makeApp({ SKILLS_DIR: f.root });
    assert.equal(app.catalogs.source, 'real', 'default is Real when configured');
    const c = rpcClient(send);
    const list = await c.modern('skills/list');
    assert.deepEqual(list.body.result.skills.map((s) => s.frontmatter.name), ['alpha', 'beta']);
    assert.equal(list.body.result.cacheScope, 'private'); assert.equal(list.body.result.ttlMs, 0);
    assert.equal(list.body.result.skills[0].uri, 'skill://alpha/SKILL.md', 'no prefix in Real mode');
    const get = await c.modern('skills/get', { uri: 'skill://beta/SKILL.md' });
    assert.equal(get.body.result.skill.resources.length, 2);
    const dir = await c.modern('resources/directory/read', { uri: 'skill://alpha' });
    assert.deepEqual(dir.body.result.resources.map((r) => r.name).sort(), ['SKILL.md', 'references']);
    const legacy = rpcClient(send); await legacy.legacyInit();
    assert.equal((await legacy.legacy('skills/list')).body.result.skills.length, 2);
    for (const era of ['modern', 'legacy']) {
      const ctl = await runControl({ fetch: send, era });
      assert.equal(ctl.verdict, 'PASS', JSON.stringify(ctl));
      assert.equal(ctl.skills.length, 2);
    }
  } finally { f.cleanup(); }
});

test('toggle: Mock -> Real -> Mock without a restart, and the data reloads (rule 19)', async () => {
  const f = fixture();
  try {
    const { send, app } = await makeApp({ SKILLS_DIR: f.root });
    const post = (b) => send('http://127.0.0.1:7807/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const names = async () => (await rpcClient(send).modern('skills/list')).body.result.skills.map((s) => s.frontmatter.name).join(',');
    assert.equal(await names(), 'alpha,beta');
    assert.equal((await post({ source: 'mock' })).status, 200);
    assert.equal(app.catalogs.source, 'mock');
    assert.match(await names(), /meeting-notes/);
    const back = await post({ source: 'real' });
    assert.equal(back.status, 200); assert.equal((await back.json()).source, 'real');
    assert.equal(await names(), 'alpha,beta');
    // exactly { source }
    assert.equal((await post({ source: 'mock', extra: 1 })).status, 400);
    assert.equal((await post({ source: 'live' })).status, 400);
    assert.equal((await post({})).status, 400);
  } finally { f.cleanup(); }
});

test('Reset re-scans the folder: a skill added after start appears, one removed disappears', async () => {
  const f = fixture();
  try {
    const { send } = await makeApp({ SKILLS_DIR: f.root });
    const names = async () => (await rpcClient(send).modern('skills/list')).body.result.skills.map((s) => s.frontmatter.name).join(',');
    assert.equal(await names(), 'alpha,beta');
    f.w('gamma/SKILL.md', md('gamma')); fs.rmSync(path.join(f.root, 'alpha'), { recursive: true });
    assert.equal(await names(), 'alpha,beta', 'served from the loaded catalog until Reset');
    assert.equal((await send('http://127.0.0.1:7807/api/reset', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 200);
    assert.equal(await names(), 'beta,gamma');
  } finally { f.cleanup(); }
});

test('symlinks are never followed: a file link and a folder link that escape the root are refused and never served', async () => {
  const f = fixture();
  try {
    f.w('linky/SKILL.md', md('linky'));
    fs.symlinkSync(path.join(f.outside, 'secret.txt'), path.join(f.root, 'linky', 'leak.txt'));       // a link INSIDE a skill, pointing out
    fs.symlinkSync(f.outside, path.join(f.root, 'escapedir'));                                         // a link AT the root, pointing out
    fs.symlinkSync(path.join(f.root, 'alpha'), path.join(f.root, 'alias'));                            // a link that stays inside: still not followed
    const cat = await loadRealCatalog(f.root);
    assert.deepEqual(cat.entries.map((e) => e.frontmatter.name), ['alpha', 'beta'], 'linky is skipped as a whole; the root links are skipped');
    assert.ok(problemFor(cat, 'linky/leak.txt').length === 1 && problemFor(cat, 'linky/leak.txt')[0].level === 'refused');
    assert.ok(problemFor(cat, 'escapedir').length === 1);
    assert.ok(problemFor(cat, 'alias').length === 1);
    const { send } = await makeApp({ SKILLS_DIR: f.root });
    const c = rpcClient(send);
    for (const uri of ['skill://linky/leak.txt', 'skill://linky/SKILL.md', 'skill://escapedir/secret.txt', 'skill://alias/SKILL.md']) {
      const r = await c.modern('resources/read', { uri });
      assert.ok(r.body.error, `${uri} must not be served`);
      assert.doesNotMatch(r.text, /outside-secret/);
    }
    const all = JSON.stringify((await c.modern('skills/list')).body);
    assert.doesNotMatch(all, /linky|escapedir|alias/);
  } finally { f.cleanup(); }
});

test('a skill over the file limit is refused with a problem, not served and not a crash (small limits keep the fixture tiny)', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 6; i++) f.w(`crowded/refs/f${i}.txt`, `file ${i}\n`);
    f.w('crowded/SKILL.md', md('crowded'));
    const cat = await loadRealCatalog(f.root, { limits: { files: 5, bytes: 1_000_000 } });
    assert.deepEqual(cat.entries.map((e) => e.frontmatter.name), ['alpha', 'beta']);
    const p = problemFor(cat, 'crowded');
    assert.equal(p.length, 1); assert.equal(p[0].level, 'refused'); assert.match(p[0].message, /SHOULD NOT serve more than 5 files/);
  } finally { f.cleanup(); }
});

test('a skill over the byte limit is refused (limit lowered, not a 16 MiB fixture)', async () => {
  const f = fixture();
  try {
    f.w('fat/SKILL.md', md('fat')); f.w('fat/data.txt', 'x'.repeat(5000));
    const cat = await loadRealCatalog(f.root, { limits: { files: 512, bytes: 4096 } });
    assert.ok(!cat.entries.some((e) => e.frontmatter.name === 'fat'));
    assert.match(problemFor(cat, 'fat')[0].message, /bytes/);
  } finally { f.cleanup(); }
});

test('the real 512-file limit is enforced on a generated folder of 513 tiny files', async () => {
  const f = fixture();
  try {
    f.w('many/SKILL.md', md('many'));
    for (let i = 0; i < 512; i++) fs.writeFileSync(path.join(f.root, 'many', `f${i}.txt`), 'x');
    const cat = await loadRealCatalog(f.root);
    assert.ok(!cat.entries.some((e) => e.frontmatter.name === 'many'), '513 files is over 512');
    assert.equal(problemFor(cat, 'many')[0].level, 'refused');
    fs.rmSync(path.join(f.root, 'many', 'f0.txt'));
    const ok = await loadRealCatalog(f.root);
    assert.equal(ok.entries.find((e) => e.frontmatter.name === 'many').resources.length, 512, 'exactly 512 is served');
  } finally { f.cleanup(); }
});

test('non-UTF-8: a binary side file is served as a blob with a digest over the raw bytes; a non-UTF-8 SKILL.md is skipped with a problem', async () => {
  const f = fixture();
  try {
    f.w('binny/SKILL.md', md('binny')); f.w('binny/blob.bin', Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]));
    f.w('badbytes/SKILL.md', Buffer.concat([Buffer.from('---\nname: badbytes\ndescription: x\n---\n'), Buffer.from([0xff, 0xfe, 0xfd])]));
    const cat = await loadRealCatalog(f.root);
    const names = cat.entries.map((e) => e.frontmatter.name);
    assert.ok(names.includes('binny')); assert.ok(!names.includes('badbytes'));
    assert.ok(cat.problems.some((p) => p.path === 'binny/blob.bin' && p.level === 'info'));
    assert.ok(problemFor(cat, 'badbytes').length >= 1, JSON.stringify(cat.problems));
    const { send } = await makeApp({ SKILLS_DIR: f.root });
    const r = await rpcClient(send).modern('resources/read', { uri: 'skill://binny/blob.bin' });
    assert.ok(r.body.result.contents[0].blob, 'binary content is a base64 blob');
    const ctl = await runControl({ fetch: send });
    assert.equal(ctl.verdict, 'PASS', JSON.stringify(ctl.findings ?? ctl.error));
  } finally { f.cleanup(); }
});

test('control on a clean Real folder whose skills carry a Claude Code field (argument-hint): PASS in both eras; the ignored field is reported as an information note, not a problem', async () => {
  const f = fixture();
  try {
    f.w('hinted/SKILL.md', md('hinted', 'A skill with an editor-only field.', 'argument-hint: "[topic]"\n'));
    const { send } = await makeApp({ SKILLS_DIR: f.root });
    for (const era of ['modern', 'legacy']) {
      const ctl = await runControl({ fetch: send, era });
      assert.equal(ctl.verdict, 'PASS', JSON.stringify(ctl.findings ?? ctl.error));
      assert.equal(ctl.skills.length, 3);
      assert.deepEqual(ctl.findings, [], 'nothing that fails the control');
      assert.deepEqual(ctl.notes.map((n) => [n.id, n.skillUri, n.detail]), [['extra-frontmatter-ignored', 'skill://hinted/SKILL.md', 'argument-hint']]);
    }
  } finally { f.cleanup(); }
});

test('frontmatter name that differs from the folder is a catalog problem and the skill is skipped; a folder without SKILL.md is ignored', async () => {
  const f = fixture();
  try {
    f.w('wrong-folder/SKILL.md', md('other-name'));
    f.w('no-skill-md/README.md', '# not a skill\n');
    f.w('broken-yaml/SKILL.md', '---\nname: broken-yaml\ndescription: [unterminated\n---\nbody\n');
    f.w('no-frontmatter/SKILL.md', '# Just markdown\n');
    const cat = await loadRealCatalog(f.root);
    assert.deepEqual(cat.entries.map((e) => e.frontmatter.name), ['alpha', 'beta']);
    assert.match(problemFor(cat, 'wrong-folder')[0].message, /must match/);
    assert.ok(problemFor(cat, 'broken-yaml').length >= 1);
    assert.ok(problemFor(cat, 'no-frontmatter').length >= 1);
    const { send } = await makeApp({ SKILLS_DIR: f.root });
    const api = await (await send('http://127.0.0.1:7807/api/catalog')).json();
    assert.equal(api.source, 'real'); assert.ok(api.problems.length >= 3); assert.equal(api.skills.length, 2);
  } finally { f.cleanup(); }
});

test('Real mode content is never copied into this repository (the catalog reads the folder it is given and nothing else)', () => {
  const src = fs.readFileSync(new URL('../server/src/catalog/real.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /writeFile|copyFile|cpSync|appendFile|mkdir|rename|unlink|rmSync/, 'real.js only reads');
});

test('the committed e2e fixtures load in Real mode: ok-skill and the 64-character name are served, refused-example is a catalog problem', async () => {
  const dir = fileURLToPath(new URL('./fixtures/real-skills', import.meta.url));
  const cat = await loadRealCatalog(dir);
  const names = cat.entries.map((e) => e.frontmatter.name);
  assert.ok(names.includes('ok-skill'));
  const long = names.find((n) => n.startsWith('long-skill-name-'));
  assert.equal(long.length, 64);
  assert.ok(!names.includes('some-other-name') && problemFor(cat, 'refused-example').length === 1);
});

// ---- scan guards (each used to survive deletion) ---------------------------------------------------------------------------------------------
test('scan uses lstat: a symlinked folder is never followed or counted, so it is refused as a symlink, not as "too many files"', async () => {
  const f = fixture();
  try {
    f.w('linked/SKILL.md', md('linked'));
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(f.outside, `big${i}.txt`), 'x'.repeat(100));
    fs.symlinkSync(f.outside, path.join(f.root, 'linked', 'ext'));
    const cat = await loadRealCatalog(f.root, { limits: { files: 5, bytes: 1000 } });
    const p = problemFor(cat, 'linked');
    assert.equal(p.length, 1, JSON.stringify(p));
    assert.match(p[0].message, /symlink/);
    assert.doesNotMatch(p[0].message, /SHOULD NOT serve/, 'the link target was counted: stat followed the link');
    assert.ok(!cat.entries.some((e) => e.frontmatter.name === 'linked'));
  } finally { f.cleanup(); }
});

test('scan depth cap: a folder nested deeper than the cap is refused as "too many entries to count"; the cap is 24 by default', async () => {
  const f = fixture();
  try {
    f.w('deep/SKILL.md', md('deep'));
    f.w(`deep/${Array.from({ length: 6 }, (_, i) => `d${i}`).join('/')}/leaf.txt`, 'leaf');
    const small = await loadRealCatalog(f.root, { scan: { maxDepth: 3 } });
    assert.ok(!small.entries.some((e) => e.frontmatter.name === 'deep'));
    assert.match(problemFor(small, 'deep')[0].message, /too many entries to count/);
    const roomy = await loadRealCatalog(f.root, { scan: { maxDepth: 10 } });
    assert.ok(roomy.entries.some((e) => e.frontmatter.name === 'deep'), 'depth 6 fits under a cap of 10');
    f.w(`deeper/SKILL.md`, md('deeper'));
    f.w(`deeper/${Array.from({ length: 27 }, (_, i) => `n${i}`).join('/')}/leaf.txt`, 'leaf');
    const dflt = await loadRealCatalog(f.root);
    assert.ok(!dflt.entries.some((e) => e.frontmatter.name === 'deeper'), 'default cap (24) refuses 27 levels');
    assert.match(problemFor(dflt, 'deeper')[0].message, /too many entries to count/);
  } finally { f.cleanup(); }
});

test('scan file-count cap: a folder with more entries than the scan cap is refused instead of walked forever', async () => {
  const f = fixture();
  try {
    f.w('wide/SKILL.md', md('wide'));
    for (let i = 0; i < 8; i++) f.w(`wide/f${i}.txt`, 'x');
    const cat = await loadRealCatalog(f.root, { scan: { maxFiles: 5 } });
    assert.ok(!cat.entries.some((e) => e.frontmatter.name === 'wide'));
    assert.match(problemFor(cat, 'wide')[0].message, /too many entries to count/);
    assert.ok((await loadRealCatalog(f.root, { scan: { maxFiles: 50 } })).entries.some((e) => e.frontmatter.name === 'wide'));
  } finally { f.cleanup(); }
});

test('blob report is bounded: a non-UTF-8 file over 256 KiB is not read for the report; a FIFO in a skill folder never blocks the scan', { timeout: 20000 }, async () => {
  const f = fixture();
  try {
    f.w('chunky/SKILL.md', md('chunky')); f.w('chunky/small.bin', Buffer.from([0xff, 0xfe, 0xfd]));
    f.w('chunky/large.bin', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(300 * 1024, 0x80)]));
    const cat = await loadRealCatalog(f.root);
    assert.ok(cat.problems.some((p) => p.path === 'chunky/small.bin' && p.level === 'info'));
    assert.ok(!cat.problems.some((p) => p.path === 'chunky/large.bin'), 'over 256 KiB: not read just to say it is binary');
    const { spawnSync } = await import('node:child_process');
    f.w('fifo-skill/SKILL.md', md('fifo-skill'));
    const mk = spawnSync('mkfifo', [path.join(f.root, 'fifo-skill', 'pipe')]);
    if (mk.status === 0) {
      const again = await loadRealCatalog(f.root);
      assert.ok(!again.entries.some((e) => e.frontmatter.name === 'fifo-skill'), 'special files are refused by the SDK adapter');
      assert.ok(problemFor(again, 'fifo-skill/pipe').length >= 1);
    }
  } finally { f.cleanup(); }
});

test('SKILLS_DIR may itself be a symlink: it is resolved first, the real folder is served, and its real name is reported', async () => {
  const f = fixture();
  try {
    const link = path.join(f.base, 'link-to-skills');
    fs.symlinkSync(f.root, link);
    const cat = await loadRealCatalog(link);
    assert.equal(cat.available, true, cat.reason);
    assert.deepEqual(cat.entries.map((e) => e.frontmatter.name), ['alpha', 'beta']);
    assert.equal(cat.root, 'skills', 'the resolved folder name, not the link name');
  } finally { f.cleanup(); }
});

test('a non-UTF-8 SKILL.md is reported once (refused), not also as a binary blob', async () => {
  const f = fixture();
  try {
    f.w('nonutf2/SKILL.md', Buffer.concat([Buffer.from('---\nname: nonutf2\ndescription: x\n---\n'), Buffer.from([0xff, 0xfe])]));
    const cat = await loadRealCatalog(f.root);
    const p = problemFor(cat, 'nonutf2');
    assert.equal(p.length, 1, JSON.stringify(p));
    assert.equal(p[0].level, 'refused'); assert.match(p[0].message, /UTF-8/i);
  } finally { f.cleanup(); }
});
