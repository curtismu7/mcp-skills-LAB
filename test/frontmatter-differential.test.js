// DIFFERENTIAL: the host verifier's frontmatter decision must never be more permissive than the SDK client's SkillsClient.read, for the inputs that
// used to separate a look-alike parser from the SDK (comments inside block scalars, blank lines in folded text, 0x/0o numbers, lax plain scalars ...)
// and a few hundred more. For every snippet three claims are served: the SDK's own reading of it (honest), a tampered description, a dropped key.
// Pass condition: host accepts => SDK accepts (agreement or fail-closed). The test also requires that both outcomes occur, so it cannot pass vacuously.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveExt } from './helpers.js';
import { HostVerifier } from '../server/src/verifier/host.js';

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const URL_ = 'http://127.0.0.1:7807/mcp';

// Frontmatter bodies (after the name/description lines). The first block is the reviewer's repros.
const REPROS = [
  'description: |\n  line one\n  # a comment-looking line\n  line two',
  'description: >\n  folded one\n  # a comment-looking line\n  folded two',
  'description: >\n  a\n\n  b',
  'description: >\n  a\n\n\n  b',
  'description: |\n  a\n\n  b\n',
  'description: |\n    deeper\n  shallow',
  'description: |\n  trailing   \n  spaces  ',
  'description: |+\n  keep\n\n',
  'description: |-\n  strip\n\n',
  'description: >+\n  keep folded\n\n',
  'description: >\n  double  space  inside',
  'description: >\n  indented\n    more indented\n  back',
  'x: 0x1F', 'x: 0o17', 'x: 0b101', 'x: 1_000', 'x: .inf', 'x: -.inf', 'x: .nan', 'x: 1e3', 'x: +12', 'x: -0', 'x: 0.5', 'x: .5', 'x: 5.',
  'x: a: b', 'x: a:b', 'x: a #c', 'x: a#c', "x: 'a' 'b'", "x: 'it''s'", 'x: "a" "b"', 'x: "tab\\there"', 'x: "bad \\q escape"',
  '&a k: v', 'k: &a v', 'k: *a', 'k: !!str 12', 'k: !tag v', '? complex\n: v', '1: numeric key', 'true: bool key', 'null: null key', '~: tilde key',
  '- a: b: c', '- a\n- b', 'k:\n  - a: b: c', 'k: [a, b]', 'k: [a, [b]]', 'k: {a: 1}', 'k: [a, b', 'k: ]',
  'metadata:\n  a: b', 'metadata:\n  a: 1', 'metadata:\n  a:\n    b: c', 'metadata:\n  a: "1"', 'metadata: x',
  'allowed-tools: Read Write', 'allowed-tools: [Read, Write]', 'allowed-tools:\n  - Read\n  - Write',
  'hooks:\n  Pre:\n    - command: ./x.sh', 'hooks:\n  Pre: ./x.sh',
  'license: MIT', 'compatibility: needs awk', 'compatibility: ""',
  'k: a\nk: b', '__proto__: x', 'constructor: x', 'k:\ttab', 'k:\n\tx: 1', '\tk: v', 'k: v\n   bad: indent',
  'k: null', 'k: ~', 'k:', 'k: ""', "k: ''", 'k: yes', 'k: No', 'k: on', 'k: Null', 'k: TRUE', 'k: 2026-01-01', 'k: 1.0', 'k: 010', 'k: 1.2.3', 'k: 12:30:45',
  'k: ' + 'a'.repeat(3000), 'k: "' + 'b'.repeat(3000) + '"',
  'k: |\n  # only a comment-looking line', 'k: |\n  - not a list\n  key: not a map',
  'k: >-\n  a\n  b\n\n  c',
  'k: "multi\n  line"', "k: 'multi\n  line'", 'k: plain\n  continued', 'k: plain\n\n  after blank',
  'k: a\r\nj: b', 'k: é', 'k: "\\u00e9"', 'k: "\\ud83d\\ude00"', 'k: \u200bzero width',
  '# leading comment\nk: v', 'k: v # trailing comment', 'k: v\n# between\nj: w', '---\nk: v', 'k: v\n...',
  'k: [a,\n  b]', 'k:\n- a\n- b', 'k:\n  - a\n  -   b', 'k:\n  -\n    c: d',
  'k:\n  a:\n    b:\n      c:\n        d:\n          e:\n            f:\n              g:\n                h:\n                  i: j',
];
// Generated families: a block scalar with a comment-looking line at each position, and a plain value with each special character.
const GEN = [];
for (const ind of ['  ', '    ', ' ']) for (const style of ['|', '>', '|-', '>-', '|+', '>+']) {
  GEN.push(`description: ${style}\n${ind}first\n${ind}# hidden?\n${ind}last`);
  GEN.push(`description: ${style}\n${ind}first\n\n${ind}last\n`);
}
for (const ch of [':', '#', '@', '`', '%', '!', '&', '*', '|', '>', '{', '}', '[', ']', ',', '?', '-', '\\', '"', "'"]) GEN.push(`k: a${ch}b`, `k: ${ch}b`, `k: a ${ch} b`);

const SNIPPETS = [...REPROS, ...GEN];

async function build() {
  const entries = new Map(); const files = new Map(); const meta = [];
  let n = 0;
  for (const extra of SNIPPETS) {
    for (const variant of ['honest', 'tampered', 'dropped']) {
      const name = `diff-${String(n++).padStart(4, '0')}`;
      const text = `---\nname: ${name}\ndescription: base\n${extra}\n---\nbody\n`
        .replace('description: base\ndescription:', 'description:'); // a snippet that sets description replaces the base one
      const bytes = new TextEncoder().encode(text);
      let claim;
      try { claim = (await skillEntry(name, { 'SKILL.md': text })).frontmatter; } catch { claim = { name, description: 'base' }; }
      if (variant === 'tampered') claim = { ...claim, description: `${claim.description ?? ''}!` };
      if (variant === 'dropped') { const { description, ...rest } = claim; claim = { ...rest, ...(Object.keys(rest).length > 1 ? {} : { x: 1 }) }; }
      const uri = `skill://${name}/SKILL.md`;
      const entry = { uri, frontmatter: claim, resources: [{ uri, digest: sha(bytes), size: bytes.length }] };
      entries.set(uri, entry); files.set(uri, text); meta.push({ name, uri, variant, extra });
    }
  }
  const source = {
    list: async () => ({ skills: [] }),
    get: async (uri) => entries.get(uri),
    read: async (uri) => (files.has(uri) ? { text: files.get(uri) } : undefined),
  };
  return { entries, meta, ext: new SkillsExtension({ source, cacheHint: { ttlMs: 0, cacheScope: 'private' }, onWarning: () => {} }) };
}

async function run(disable = []) {
  const { entries, meta, ext } = await build();
  const send = await serveExt(ext);
  const client = new Client({ name: 'sdk', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: send }));
  const sdk = new SkillsClient(client);
  const v = new HostVerifier({ fetch: send, disable });
  await v.connect('s', URL_);
  const rows = [];
  for (const m of meta) {
    const entry = entries.get(m.uri);
    const sdkOk = await sdk.read(entry).then(() => true, () => false);
    const rec = v.ingest('s', entry, true);
    const hostOk = rec.loadable ? (await v.readFile('s', m.uri)).ok : false;
    rows.push({ ...m, sdkOk, hostOk });
  }
  await client.close(); await v.close();
  return rows;
}

test(`differential: for ${SNIPPETS.length} snippets x 3 claims the host never accepts what SkillsClient.read rejects`, { timeout: 120000 }, async () => {
  assert.ok(SNIPPETS.length >= 100, `${SNIPPETS.length} snippets`);
  const rows = await run();
  const dangerous = rows.filter((r) => r.hostOk && !r.sdkOk).map((r) => `${r.variant}: ${JSON.stringify(r.extra).slice(0, 80)}`);
  assert.deepEqual(dangerous, [], 'host accepted, SDK rejected');
  const failClosed = rows.filter((r) => !r.hostOk && r.sdkOk).map((r) => `${r.variant}: ${JSON.stringify(r.extra).slice(0, 80)}`);
  assert.deepEqual(failClosed, [], 'the host and the SDK use the same parser, so they should agree exactly');
  const acceptBoth = rows.filter((r) => r.hostOk && r.sdkOk).length; const rejectBoth = rows.filter((r) => !r.hostOk && !r.sdkOk).length;
  console.log(`# differential: ${SNIPPETS.length} snippets, ${rows.length} claims, accepted by both ${acceptBoth}, rejected by both ${rejectBoth}`);
  assert.ok(acceptBoth >= 100, `only ${acceptBoth} snippets accepted by both: the test would be vacuous`);
  assert.ok(rejectBoth >= 100, `only ${rejectBoth} rejected by both: tampered claims must be caught`);
  // Every tampered / dropped claim that is itself readable must be rejected by both.
  assert.ok(rows.filter((r) => r.variant !== 'honest' && r.hostOk).length === 0, 'a tampered claim was accepted');
});

test('the reviewer repros specifically: comment line in | and > blocks, blank line in >, 0x1F and 0o17 are decided exactly as the SDK decides them', async () => {
  const rows = await run();
  const pick = (needle) => rows.filter((r) => r.variant === 'honest' && r.extra.includes(needle));
  for (const r of [...pick('# a comment-looking line'), ...pick('x: 0x1F'), ...pick('x: 0o17'), ...pick('description: >\n  a\n\n  b')]) assert.equal(r.hostOk, r.sdkOk, JSON.stringify(r.extra));
});

test('mutation: with the frontmatter check removed the same differential run FAILS (tampered claims are accepted)', async () => {
  const rows = await run(['frontmatter']);
  const dangerous = rows.filter((r) => r.hostOk && !r.sdkOk);
  assert.ok(dangerous.length >= 100, `${dangerous.length}`);
});
