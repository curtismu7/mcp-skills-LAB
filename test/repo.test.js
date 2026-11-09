// Repo hygiene: portability, the shipped files, compose/Docker lock-down, CI, README standard, pins, no foreign identifiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTILE_CASES } from '../server/src/hostile/cases.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SKIP = new Set(['node_modules', '.git', 'package-lock.json', 'dist', 'standalone-ui.css']);
// Every shipped text file except the tests, which hold the patterns they look for.
function shipped(dir = root, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) shipped(p, out);
    else if (/\.(m?jsx?|json|md|ya?ml|sh|css|html)$/.test(name) || ['Dockerfile', '.gitignore', '.dockerignore', 'pre-commit', '.nvmrc'].includes(name) || name === 'LICENSE') out.push(p);
  }
  return out;
}
const nonTest = () => shipped().filter((p) => !p.includes(`${path.sep}test${path.sep}`) && !/\.test\.[jm]?jsx?$/.test(p) && !p.endsWith('check-no-ai-attribution.sh') && !p.endsWith('content-pack.schema.json'));

test('portability: no absolute author path, personal account name or foreign hostname in any shipped file', () => {
  const hits = [];
  const ALLOWED = new Set(['modelcontextprotocol.io', 'github.com', 'raw.githubusercontent.com']); // the last one is only the vendored check-ui-standard.sh
  for (const p of nonTest()) {
    const t = fs.readFileSync(p, 'utf8');
    if (/\/Users\/|\/home\/[a-z]|cmuir|ping-devops|pingone\.com|pingidentity/i.test(t)) hits.push(`${path.relative(root, p)}: a personal path or foreign name`);
    if (p.endsWith('.github/workflows/ci.yml') || p.endsWith('.gitignore')) continue;
    for (const m of t.matchAll(/\b(?:https?|wss?|ftp|skill):\/\/([^\s/?#"'`<>\\)\]]+)/gi)) {
      const h = m[1].replace(/^[^@]*@/, '').replace(/^\[::1\].*/, '::1').split(':')[0].toLowerCase();
      if (!h || h.startsWith('${') || h.startsWith('$') || /(^|\.)(invalid|example)$/.test(h) || /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/.test(h) || ALLOWED.has(h)) continue;
      if (/^[a-z0-9-]+(\/|$)/.test(h) && !h.includes('.')) continue; // skill://name URIs have no dot in the "host"
      hits.push(`${path.relative(root, p)}: ${h}`);
    }
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t)) hits.push(`${path.relative(root, p)}: a UUID-shaped id`);
  }
  assert.deepEqual(hits, []);
});

test('the files the standalone rules ask for are present', () => {
  for (const f of ['README.md', 'CLAUDE.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.gitignore', '.nvmrc', '.github/workflows/ci.yml', 'docs/talk-track.md', 'docs/shelf-entry.json', 'scripts/doctor.mjs', 'scripts/reset.mjs', 'scripts/check-no-ai-attribution.sh', '.githooks/pre-commit', 'server/src/netguard.js', 'server/src/health.js', 'package-lock.json',
    'content-pack.json', 'docs/content-pack.schema.json', 'scripts/build-content-pack.mjs', 'scripts/validate-content-pack.mjs', 'scripts/build-talk-track.mjs', 'scripts/check-ui-standard.sh', 'scripts/standalone-ui.sha256', 'scripts/e2e.mjs', 'docker-compose.e2e.yml', 'test/support/mutant-server.mjs', 'test/fixtures/real-skills/ok-skill/SKILL.md',
    'web/index.html', 'web/package.json', 'web/vite.config.js', 'web/src/main.jsx', 'web/src/App.jsx', 'web/src/App.test.jsx', 'web/src/app.css', 'web/src/styles/standalone-ui.css', 'web/src/FlowDiagram.jsx', 'server/diagrams/skills-flow.json', 'server/src/diagramData.js', 'server/src/diagramStudioValidate.js']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('docker-compose.yml publishes only on 127.0.0.1, port 7807 on both sides, restart policy, locked down', () => {
  const c = read('docker-compose.yml');
  const ports = [];
  c.split('\n').forEach((l, i, all) => { if (/^\s*ports:\s*$/.test(l)) for (let j = i + 1; j < all.length && /^\s*-/.test(all[j]); j++) ports.push(all[j].replace(/^\s*-\s*["']?|["']?\s*$/g, '')); });
  assert.deepEqual(ports, ['127.0.0.1:${HOST_PORT:-7807}:7807']);
  assert.match(c, /restart: unless-stopped/);
  assert.match(c, /read_only: true/); assert.match(c, /cap_drop: \[ALL\]/); assert.match(c, /no-new-privileges:true/);
  assert.doesNotMatch(c, /^\s*MODE:|extra_hosts|privileged|network_mode: host/m);
  assert.match(c, /^#\s+- \/path\/to\/your\/skills:\/skills:ro$/m, 'the Real-mode mount example is read-only');
  const d = read('Dockerfile');
  assert.equal((d.match(/^FROM node:26-alpine/gm) || []).length, 2, 'build stage + run stage');
  assert.match(d, /npm run build -w web/); assert.match(d, /npm ci --omit=dev --workspaces=false/);
  assert.match(d, /^USER node$/m); assert.match(d, /^EXPOSE 7807$/m); assert.match(d, /^ENV SKILLS_LAB_BIND=0\.0\.0\.0$/m);
  assert.doesNotMatch(d, /\bMODE=/);
  assert.match(c, /name: mcp-skills-lab/);
});

test('package.json: Node 26, exact-pinned SDK (no ranges), the three scripts, glob test command', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.engines.node, '>=26'); assert.equal(pkg.type, 'module'); assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.scripts.test, 'node --test test/*.test.js && npm test -w web', 'the server tests use a glob, never a directory');
  for (const k of ['start', 'doctor', 'reset', 'build', 'e2e', 'talk-track', 'content-pack', 'check-ui']) assert.ok(pkg.scripts[k], k);
  assert.deepEqual(pkg.workspaces, ['web']);
  for (const dep of ['@modelcontextprotocol/server', '@modelcontextprotocol/client', '@modelcontextprotocol/core']) assert.equal(pkg.dependencies[dep], '2.4.0', dep);
  for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v} must be an exact pin`);
  assert.equal(read('.nvmrc').trim(), '26');
});

test('the SDK in node_modules is exactly the pinned version, and the lock file agrees', () => {
  for (const n of ['server', 'client', 'core']) assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@modelcontextprotocol', n, 'package.json'), 'utf8')).version, '2.4.0');
  const lock = JSON.parse(read('package-lock.json'));
  for (const n of ['server', 'client', 'core']) assert.equal(lock.packages[`node_modules/@modelcontextprotocol/${n}`].version, '2.4.0');
});

test('CI is GitHub-hosted, Node 26 only, actions v5, with test, doctor, forbidden-strings and gitleaks jobs', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /runs-on: ubuntu-latest/); assert.ok(!/self-hosted/.test(ci));
  const versions = [...ci.matchAll(/node-version: (\S+)/g)].map((m) => m[1]);
  assert.ok(versions.length >= 2 && versions.every((v) => v === '26'), versions.join());
  assert.match(ci, /actions\/checkout@v5/); assert.match(ci, /actions\/setup-node@v5/);
  for (const job of ['build:', 'e2e:', 'test:', 'doctor:', 'forbidden-strings:', 'gitleaks:']) assert.ok(ci.includes(`\n  ${job}`), job);
  assert.match(ci, /npm run build/); assert.match(ci, /npm test/); assert.match(ci, /PORT=7999 npm run doctor/); assert.match(ci, /check-ui-standard\.sh/); assert.match(ci, /validate-content-pack\.mjs/);
});

test('README standard: title ends in LAB, plain Tier: Tester, Repo and Catalog lines, the UNVERIFIED banner, the sources, one row per hostile case', () => {
  const r = read('README.md');
  assert.match(r.split('\n')[0], /^# .* LAB$/);
  assert.match(r, /^Tier: Tester$/m); assert.match(r, /^Repo: /m); assert.match(r, /^Catalog: TBD$/m);
  assert.match(r, /Simulated and UNVERIFIED/);
  for (const u of ['https://modelcontextprotocol.io/extensions/skills/overview', 'https://modelcontextprotocol.io/seps/2640-skills-extension.md', 'https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx']) assert.ok(r.includes(u), u);
  for (const c of HOSTILE_CASES) assert.ok(r.includes(`\`${c.id}\``), `README lists ${c.id}`);
  assert.match(r, /lsof -iTCP:7807 -sTCP:LISTEN -n -P/); assert.match(r, /PORT=<other port> npm start/);
  assert.match(r, /\/api\/health/);
  assert.ok(!/\bdoor\b/i.test(r + read('CLAUDE.md') + read('docs/talk-track.md')), 'the word "door" is not used');
});

test('shelf entry: port 7807, health path, Tester, catalog id left as TBD (not invented), portable composeFile', () => {
  const e = JSON.parse(read('docs/shelf-entry.json')).demos[0];
  assert.equal(e.id, 'mcp-skills-lab'); assert.equal(e.kind, 'Tester'); assert.equal(e.catalogId, 'TBD');
  assert.equal(e.url, 'http://localhost:7807'); assert.equal(e.healthPath, '/api/health');
  assert.equal(e.composeFile, 'mcp-skills-LAB/docker-compose.yml'); assert.ok(!path.isAbsolute(e.composeFile) && !e.composeFile.includes('..'));
  assert.deepEqual(e.pingProducts, []);
});

test('no EC key generation, no bare MODE, no k8s/SE code, no .env loader, no network library other than the SDK client and fetch', () => {
  for (const p of nonTest().filter((f) => /\.m?js$/.test(f))) {
    const t = fs.readFileSync(p, 'utf8');
    assert.ok(!/generateKeyPair(Sync)?\(\s*['"]ec['"]/.test(t), path.relative(root, p));
    assert.ok(!/process\.env\.MODE|\benv\.MODE\b|LAB_HOSTED|__SE_HOST__|__IMAGE__|kubectl|loadEnvFile|dotenv/.test(t), path.relative(root, p));
    assert.ok(!/from 'node:(https?|net|tls|dgram)'/.test(t) || p.endsWith('netguard.js') || p.endsWith('app.js') || p.endsWith('doctor.mjs') || p.endsWith('e2e.mjs'), `${path.relative(root, p)} imports a network module`);
  }
  assert.ok(!fs.existsSync(path.join(root, 'k8s')) && !fs.existsSync(path.join(root, '.env')));
});

test('the pre-commit hook runs gitleaks and the attribution check script is present and executable', () => {
  assert.match(read('.githooks/pre-commit'), /gitleaks protect --staged/);
  assert.ok(fs.statSync(path.join(root, 'scripts/check-no-ai-attribution.sh')).mode & 0o111);
});

test('app CSS follows the CSS standard: tokens only, no dark-mode media query, no forced priority, no italics, breakpoints 600 and 900 only, no purple, shared stylesheet first', () => {
  const css = read('web/src/app.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(css), 'no colour literal');
  assert.ok(!/prefers-color-scheme/.test(css)); assert.ok(!/!important/.test(css)); assert.ok(!/font-style:\s*italic/.test(css)); assert.ok(!/outline:\s*none/.test(css));
  const widths = [...css.matchAll(/@media \((?:max|min)-width: (\d+)px\)/g)].map((m) => m[1]);
  assert.ok(widths.length > 0 && widths.every((w) => w === '600' || w === '900'), widths.join());
  assert.ok(!/purple|violet|magenta|indigo/i.test(css));
  const main = read('web/src/main.jsx');
  assert.ok(main.indexOf('standalone-ui.css') < main.indexOf('app.css'), 'the shared stylesheet loads before the app stylesheet');
});

test('the web code never interprets skill text: no dangerouslySetInnerHTML, innerHTML, eval, style attribute, mermaid or credential field; no remote URL is fetched', () => {
  const web = shipped().filter((p) => p.includes(`${path.sep}web${path.sep}src${path.sep}`) && /\.jsx?$/.test(p) && !/\.test\./.test(p));
  assert.ok(web.length >= 12);
  for (const p of web) {
    const t = fs.readFileSync(p, 'utf8');
    assert.ok(!/dangerouslySetInnerHTML|innerHTML|\beval\(|new Function|style=\{\{|mermaid|type="password"|document\.write/.test(t), path.relative(root, p));
    assert.ok(!/fetch\(\s*['"`]https?:/.test(t), `${path.relative(root, p)} fetches a remote URL`);
  }
  assert.ok(!/mermaid/i.test(read('web/package.json')));
});

test('the vendored stylesheet is pinned by hash (scripts/check-ui-standard.sh) and the pin file is a sha256', () => {
  assert.match(read('scripts/standalone-ui.sha256').trim(), /^[0-9a-f]{64}$/);
  assert.match(read('scripts/check-ui-standard.sh'), /copy_rel="web\/src\/styles\/standalone-ui\.css"/);
});
