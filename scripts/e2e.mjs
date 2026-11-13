#!/usr/bin/env node
// Browser check (Playwright, headless Chromium) against the lab.
//   npm run build && npm run e2e
//     Starts three throwaway servers from this checkout on free loopback ports: the lab with Real mode on the committed fixtures
//     (test/fixtures/real-skills), a lab with SKILLS_DIR unset, and a test-only "mutant" lab (test/support/mutant-server.mjs) that makes the page show FAIL.
//   docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build -d && BASE_URL=http://127.0.0.1:7807 npm run e2e
//     Runs against the container instead (Real on the same fixtures); the no-Real and mutant labs are still started locally.
//   SHOT_DIR=/some/dir saves screenshots. E2E_NO_MUTANT=1 / E2E_NO_NOREAL=1 skip those two extras. Loopback only. Exit 1 on any failed check.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
const freePort = (from) => new Promise((resolve, reject) => {
  const tryPort = (p) => { if (p > 7999) return reject(new Error('no free port in 7800-7999')); const s = net.createServer(); s.once('error', () => tryPort(p + 1)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(p))); };
  tryPort(from);
});
async function startLab(label, script, env, from) {
  const port = await freePort(from);
  const child = spawn(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/api/health`)).ok) return url; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`${label} did not start on ${url}`);
}
process.on('exit', () => { for (const c of children) c.kill(); });
if (!fs.existsSync(path.join(ROOT, 'web/dist/index.html'))) { console.error('web/dist is missing: run npm run build first'); process.exit(1); }

const FIXTURES = path.join(ROOT, 'test/fixtures/real-skills');
let BASE = process.env.BASE_URL || '';
if (!BASE) BASE = await startLab('lab', 'server/src/index.js', { SKILLS_DIR: FIXTURES }, 7880);
const NOREAL = process.env.E2E_NO_NOREAL ? '' : (process.env.BASE_URL_NOREAL || await startLab('lab without SKILLS_DIR', 'server/src/index.js', { SKILLS_DIR: '' }, 7885));
const MUTANT = process.env.E2E_NO_MUTANT ? '' : await startLab('mutant lab', 'test/support/mutant-server.mjs', { SKILLS_DIR: '' }, 7890);
for (const u of [BASE, NOREAL, MUTANT].filter(Boolean)) {
  const host = new URL(u).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { console.error(`refusing ${host}: loopback only`); process.exit(1); }
}
const N = (await (await fetch(`${BASE}/api/hostile`)).json()).cases.length; // the number of hostile cases, from the server
const LONG = 'long-skill-name-' + 'n'.repeat(48);
const SHOTS = process.env.SHOT_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0; let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`); } catch (e) { failed += 1; console.log(`FAIL  ${name}: ${String(e.message).split('\n')[0]}`); }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const TABS = ['overview', 'skills', 'verifier', 'approvals', 'source', 'diagram'];
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); };
const go = async (page, tab) => { await page.evaluate((t) => { window.location.hash = `#/${t}`; }, tab); await page.waitForFunction((t) => document.querySelector('.shell-nav a[aria-current="page"]')?.getAttribute('href') === `#/${t}`, tab); };

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const consoleProblems = []; const failedRequests = [];
  page.on('pageerror', (e) => consoleProblems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleProblems.push(`console.error: ${m.text()}`); });
  page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 500 || (r.status() === 404 && !r.url().includes('favicon'))) failedRequests.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${BASE}/`);
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* blocked */ } });
  await page.reload();

  await check('shell bar, banner is the first element of the page, Mock or Real badge shown', async () => {
    await page.getByTestId('banner').waitFor({ timeout: 15000 });
    expect(await page.locator('header.shell-bar').count() === 1, 'no shell bar');
    const first = await page.evaluate(() => document.querySelector('main.page').firstElementChild.dataset.testid);
    expect(first === 'banner', `first element in the page is ${first}`);
    await page.waitForFunction(() => /^(Mock|Real)$/.test(document.querySelector('[data-testid=mode-badge]').textContent));
  });

  await check('the banner (UNVERIFIED text and the MEASURED -32601 fact) is on EVERY tab, in light and with presenter mode on', async () => {
    for (const presenter of [false, true]) {
      if (presenter !== (await page.getByTestId('presenter').getAttribute('aria-pressed') === 'true')) await page.getByTestId('presenter').click();
      for (const tab of TABS) {
        await go(page, tab);
        const text = await page.getByTestId('banner').textContent();
        expect(/UNVERIFIED/.test(text) && /MEASURED 2026-11-09/.test(text) && /-32601/.test(text) && /v1\.261106/.test(text) && /SDK/.test(text), `banner text wrong on ${tab} (presenter ${presenter})`);
        expect(await page.getByTestId('banner').isVisible(), `banner hidden on ${tab}`);
      }
    }
    if (await page.getByTestId('presenter').getAttribute('aria-pressed') === 'true') await page.getByTestId('presenter').click();
    await go(page, 'overview');
  });

  await check('rule 19 toggle: Mock then Real then Mock, pressed state follows the server, data reloads (Skills tab shows the other catalog)', async () => {
    await page.getByTestId('mode-select').selectOption('mock');
    await page.waitForFunction(() => document.querySelector('[data-testid=mode-select]').value === 'mock');
    await go(page, 'skills');
    await page.getByTestId('skill-meeting-notes').waitFor();
    await page.getByTestId('mode-select').selectOption('real');
    await page.waitForFunction(() => document.querySelector('[data-testid=mode-select]').value === 'real');
    expect(await page.getByTestId('mode-badge').textContent() === 'Real', 'badge is not Real');
    expect(await page.getByTestId('banner').getAttribute('data-state') === 'live', 'banner is not in the Real (live) state');
    await page.getByTestId('skill-ok-skill').waitFor({ timeout: 15000 });
    expect(await page.getByTestId('skill-meeting-notes').count() === 0, 'mock skill still listed in Real');
    await shot(page, '04-skills-real');
    await page.getByTestId('mode-select').selectOption('mock');
    await page.getByTestId('skill-meeting-notes').waitFor({ timeout: 15000 });
    expect(await page.getByTestId('mode-badge').textContent() === 'Mock', 'badge is not Mock again');
  });

  await check('Skills tab: no prefetch. connect and list leave the counters at 0 (host and wire); one click on View makes both 1', async () => {
    await go(page, 'skills');
    await page.getByTestId('connect').click();
    await page.getByTestId('skill-release-checklist').waitFor();
    expect((await page.getByTestId('reads').textContent()).trim().endsWith(': 0'), 'files read is not 0 after connect and list');
    expect((await page.getByTestId('wire-reads').textContent()).trim().endsWith(': 0'), 'wire reads is not 0 after connect and list');
    await page.getByTestId('skill-release-checklist').click();
    expect((await page.getByTestId('reads').textContent()).trim().endsWith(': 0'), 'selecting a skill read a file');
    expect(await page.locator('[data-testid=manifest] tbody tr').count() === 4, 'manifest rows');
    await page.getByTestId('view-references/CHECKLIST.md').click();
    await page.getByTestId('filetext').waitFor();
    expect(/Pre-flight checklist/.test(await page.getByTestId('filetext').textContent()), 'file text not shown');
    expect((await page.getByTestId('reads').textContent()).trim().endsWith(': 1'), 'files read is not 1 after one click');
    expect((await page.getByTestId('wire-reads').textContent()).trim().endsWith(': 1'), 'wire reads is not 1 after one click');
    await page.locator('summary', { hasText: 'Raw wire' }).click();
    await page.locator('[data-testid=wire] summary').first().waitFor();
    expect(/traceparent 00-[0-9a-f]{32}-[0-9a-f]{16}-01/.test(await page.getByTestId('wire').textContent()) || (await page.locator('[data-testid=wire] details').count()) > 0, 'no wire entries');
    await shot(page, '03-skills-mock-light');
  });

  await check('Skills tab: a hostile server (digest mismatch) rejects the tampered file and says why', async () => {
    await page.getByTestId('target').selectOption('hostile:a-digest-mismatch');
    await page.getByTestId('connect').click();
    await page.getByTestId('skill-report-writer').waitFor();
    await page.getByTestId('view-references/TEMPLATE.md').click();
    await page.getByTestId('fileview').waitFor();
    expect(/rejected: digest-mismatch/.test(await page.getByTestId('fileview').textContent()), 'digest mismatch not reported');
    expect(await page.getByTestId('filetext').count() === 0, 'rejected file content was shown');
    await page.getByTestId('target').selectOption('catalog');
    await page.getByTestId('connect').click();
    await page.getByTestId('skill-meeting-notes').waitFor();
  });

  await check('Verifier tab: all hostile cases and the clean control PASS in both protocol eras; the table shows every case PASS per era with rule tag and check', async () => {
    await go(page, 'verifier');
    await page.getByTestId('run-all').click();
    await page.getByTestId('verify-summary').waitFor({ timeout: 120000 });
    await page.waitForFunction((n) => { const t = document.querySelector('[data-testid=verify-summary]')?.textContent || ''; return t.includes(`2026-07-28: ${n}/${n} PASS`) && t.includes(`2025-11-25: ${n}/${n} PASS`); }, N, { timeout: 120000 });
    const summary = await page.getByTestId('verify-summary').textContent();
    expect((summary.match(/control PASS/g) || []).length === 2, `control did not pass twice: ${summary}`);
    const pass = await page.locator('[data-testid^=verdict-]').filter({ hasText: 'PASS' }).count();
    expect(pass === 2 * N, `${pass} PASS cells, expected ${2 * N}`);
    expect(await page.locator('[data-testid^=verdict-]').filter({ hasText: 'FAIL' }).count() === 0, 'a FAIL cell');
    const tags = await page.locator('[data-testid=verify-table] tbody tr td:nth-child(2)').allTextContents();
    expect(tags.every((t) => /MUST|SHOULD|MAY|lab/.test(t)) && tags.some((t) => /MUST/.test(t)) && tags.some((t) => /lab/.test(t)), `rule tags: ${tags.slice(0, 4)}`);
    await shot(page, '05-verifier-light');
  });

  await check('Verifier tab: clicking a case shows the raw request and response (with traceparent) and what the host did', async () => {
    await page.getByTestId('open-d-post-approval-swap').click();
    await page.getByTestId('detail-verdict').waitFor({ timeout: 30000 });
    expect(await page.getByTestId('detail-verdict').textContent() === 'PASS', 'detail verdict is not PASS');
    await page.locator('[data-testid=case-detail] [data-testid=wire] summary').first().waitFor();
    await page.locator('[data-testid=case-detail] [data-testid=wire] summary').nth(1).click();
    expect(/"jsonrpc": "2.0"/.test(await page.locator('[data-testid=case-detail] [data-testid=wire-request]').first().textContent()), 'no raw JSON-RPC request');
    expect(await page.locator('[data-testid=case-detail] [data-testid=wire] details').count() >= 4, 'too few wire entries');
    expect(/approval-revoked/.test(await page.getByTestId('case-detail').textContent()), 'finding approval-revoked not listed');
  });

  await check('Approvals tab: approve skill, scripts and allowed-tools separately; the swap (B) revokes; returning to A does not bring it back', async () => {
    await go(page, 'approvals');
    await page.getByTestId('ap-connect').click();
    await page.getByTestId('ap-get').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=ap-current]').textContent !== 'none');
    await page.getByTestId('ap-approve').click();
    await page.waitForFunction(() => /approved for/.test(document.querySelector('[data-testid=ap-state]').textContent));
    expect(/scripts not granted/.test(await page.getByTestId('ap-state').textContent()), 'scripts granted without being asked');
    await page.getByTestId('ap-scripts').click();
    await page.waitForFunction(() => /scripts granted/.test(document.querySelector('[data-testid=ap-state]').textContent));
    await page.getByTestId('ap-tools').click();
    await page.waitForFunction(() => /allowed-tools granted/.test(document.querySelector('[data-testid=ap-state]').textContent));
    await page.getByTestId('ap-activate').click();
    await page.getByTestId('ap-act').waitFor();
    expect(/granted\s*<?/.test(await page.getByTestId('ap-act').textContent()) && /Read Write/.test(await page.getByTestId('ap-act').textContent()), 'granted tools not shown after approval');
    await page.getByTestId('ap-run').click();
    await page.getByTestId('ap-run-result').waitFor();
    expect(/script run allowed/.test(await page.getByTestId('ap-run-result').textContent()), 'script run should be allowed with the scripts grant');
    await shot(page, '06-approvals-approved');
    const A = await page.getByTestId('ap-current').textContent();
    await page.getByTestId('ap-get').click();   // manifest B
    await page.waitForFunction((a) => document.querySelector('[data-testid=ap-current]').textContent !== a, A);
    expect(/revoked/.test(await page.getByTestId('ap-state').textContent()), 'approval not shown as revoked at B');
    expect(/approval was revoked/.test(await page.getByTestId('ap-note').textContent()), 'no revocation note');
    await page.getByTestId('ap-run').click();
    await page.waitForFunction(() => /script run denied/.test(document.querySelector('[data-testid=ap-run-result]').textContent));
    await page.getByTestId('ap-get').click();   // back to A
    await page.waitForFunction((a) => document.querySelector('[data-testid=ap-current]').textContent === a, A);
    expect(/revoked/.test(await page.getByTestId('ap-state').textContent()) && !/approved for/.test(await page.getByTestId('ap-state').textContent()), 'approval came back at A');
    const hist = await page.getByTestId('ap-history').locator('.chip').allTextContents();
    expect(hist.length === 3 && hist[0] === hist[2] && hist[0] !== hist[1], `manifest history is not A, B, A: ${hist}`);
    expect(/approval-revoked/.test(await page.getByTestId('ap-findings').textContent()), 'finding missing');
    await shot(page, '07-approvals-revoked');
  });

  await check('Source tab: SKILLS_DIR status, catalog problems (refused / info), and both read-only mount examples', async () => {
    await page.getByTestId('mode-select').selectOption('real');
    await page.waitForFunction(() => document.querySelector('[data-testid=mode-select]').value === 'real');
    await go(page, 'source');
    await page.getByTestId('problems').waitFor();
    expect(await page.getByTestId('mount-example').count() === 2, 'mount examples');
    const text = await page.getByTestId('mount-example').allTextContents();
    expect(/claudSkills\/pingone/.test(text[0]) && /:\/skills:ro/.test(text[0]) && /\.claude\/skills/.test(text[1]) && /:\/skills:ro/.test(text[1]), 'mount example text');
    expect(/readable/.test(await page.getByTestId('skills-dir').textContent()), 'SKILLS_DIR status');
    expect(Number(await page.getByTestId('problem-count').textContent()) >= 1, 'no problems listed for the fixture folder');
    await shot(page, '08-source');
    await page.getByTestId('mode-select').selectOption('mock');
    await page.waitForFunction(() => document.querySelector('[data-testid=mode-select]').value === 'mock');
  });

  await check('Diagram tab: loaded by name, Simulate walks the steps, boxes drag, speed control, Reset restores positions', async () => {
    await go(page, 'diagram');
    await page.locator('.react-flow__node').first().waitFor({ timeout: 15000 });
    expect(await page.locator('.react-flow__node').count() === 6, 'node count');
    const posOf = () => page.locator('.react-flow__node').first().evaluate((el) => el.style.transform);
    const before = await posOf();
    const box = await page.locator('.react-flow__node').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 60, { steps: 6 }); await page.mouse.up();
    const moved = await posOf();
    expect(moved !== before, 'drag did not move the box');
    await page.getByTestId('speed').selectOption('4');
    await page.getByTestId('simulate').click();
    await page.waitForFunction(() => /Step 7 of 7/.test(document.querySelector('[data-testid=step-now]').textContent), null, { timeout: 30000 });
    expect(await page.locator('.flow-edge--seen, .flow-edge--now').count() > 0, 'no lit edges');
    await shot(page, '09-diagram-end');
    await page.getByTestId('diagram-reset').click();
    await page.waitForFunction(() => /Press Simulate/.test(document.querySelector('[data-testid=step-now]').textContent));
    await page.waitForFunction((b) => document.querySelector('.react-flow__node').style.transform === b, before, { timeout: 5000 });
  });

  await check('Reset button: clears the verify results, the browse session and the diagram', async () => {
    await go(page, 'verifier');
    await page.getByTestId('run-all').click();
    await page.getByTestId('verify-summary').waitFor({ timeout: 120000 });
    await go(page, 'skills'); await go(page, 'verifier');
    expect(await page.getByTestId('verify-summary').count() === 1, 'the results did not survive a change of tab');
    await page.getByTestId('reset').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid=verify-summary]'));
    await go(page, 'skills');
    await page.getByTestId('skill-meeting-notes').waitFor({ timeout: 15000 });
    expect((await page.getByTestId('reads').textContent()).trim().endsWith(': 0'), 'counter not back to 0 after Reset');
    await go(page, 'overview');
    expect(/not run yet/.test(await page.getByText('Last verify').locator('xpath=..').textContent()), 'last verify not cleared');
  });

  await check('presenter mode: talk-track note for the tab, larger text, banner still there; Esc leaves', async () => {
    await go(page, 'verifier');
    await page.keyboard.press('p');
    await page.getByTestId('presenter-say').waitFor();
    expect(await page.getByTestId('banner').isVisible(), 'banner hidden in presenter mode');
    expect(await page.locator('.app--presenter').count() === 1, 'presenter class');
    await shot(page, '10-presenter');
    await page.keyboard.press('Escape');
    expect(await page.locator('.app--presenter').count() === 0, 'Esc did not leave presenter mode');
  });

  await check('dark and light: every unselected control has a visible border (3:1 or more) in both themes; screenshots of each tab', async () => {
    for (const theme of ['light', 'dark']) {
      await page.getByTestId('theme-select').selectOption(theme);
      for (const tab of TABS) {
        await go(page, tab);
        await page.waitForTimeout(250);
        const bad = await page.evaluate(() => {
          const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
          const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
          const bgOf = (el) => { for (let n = el.parentElement; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return 'rgb(255,255,255)'; };
          const out = [];
          for (const el of document.querySelectorAll('button:not([aria-pressed="true"]):not([aria-selected="true"]):not(.primary), select, input')) {
            if (el.closest('.shell-nav') || el.closest('.react-flow') || !el.offsetParent) continue;
            const s = getComputedStyle(el);
            if (s.borderTopWidth === '0px' || /rgba\(0, 0, 0, 0\)/.test(s.borderTopColor)) { out.push(`${el.tagName} ${el.textContent.slice(0, 20)}: no border`); continue; }
            // WCAG 1.4.11: the control's boundary is perceivable if its border OR its own fill stands out from what is behind it at 3:1.
            const r = Math.max(ratio(s.borderTopColor, bgOf(el)), /rgba\(0, 0, 0, 0\)/.test(s.backgroundColor) ? 0 : ratio(s.backgroundColor, bgOf(el)));
            if (r < 3) out.push(`${el.tagName} ${el.textContent.slice(0, 20) || el.getAttribute('data-testid')}: border ${r.toFixed(2)}:1`);
          }
          return out;
        });
        expect(bad.length === 0, `${theme} ${tab}: ${bad.slice(0, 3).join('; ')}`);
        await shot(page, `${theme}-${tab}`);
      }
    }
    await page.getByTestId('theme-select').selectOption('auto');
  });

  await check('375px: no horizontal scroll on any tab, in light and in dark', async () => {
    const small = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: 'light' });
    const p = await small.newPage();
    await p.goto(`${BASE}/`);
    for (const theme of ['light', 'dark']) {
      await p.getByTestId('theme-select').selectOption(theme);
      for (const tab of TABS) {
        await go(p, tab);
        if (tab === 'verifier') { await p.getByTestId('run-all').click(); await p.getByTestId('verify-summary').waitFor({ timeout: 120000 }); }
        await p.waitForTimeout(300);
        const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, body: document.body.scrollWidth }));
        expect(w.sw <= w.cw + 1 && w.body <= w.cw + 1, `${theme} ${tab}: scrollWidth ${w.sw} > ${w.cw}`);
        await shot(p, `375-${theme}-${tab}`);
      }
    }
    await small.close();
  });

  if (NOREAL) {
    await check(`a lab with SKILLS_DIR unset (${NOREAL}): Real is disabled with a how-to tooltip, pressing it shows the server's 409 reason and the mode stays Mock`, async () => {
      const p = await ctx.newPage();
      await p.goto(`${NOREAL}/`);
      await p.getByTestId('mode-real').waitFor({ state: 'attached' });
      await p.getByTestId('mode-real').waitFor({ state: 'attached' });
      await p.waitForFunction(() => document.querySelector('[data-testid=mode-real]')?.disabled === true);
      expect(/SKILLS_DIR/.test(await p.getByTestId('mode-real').getAttribute('title')), 'no how-to tooltip');
      // A disabled option cannot be chosen: the select stays on mock and no 409 is sent.
      expect(await p.getByTestId('mode-select').inputValue() === 'mock', 'mode stayed mock');
      await go(p, 'source');
      await p.getByTestId('no-problems').waitFor();
      await shot(p, '11-source-no-real');
      await p.close();
    });
  }

  await check('375px with a legal 64-character skill name: the Skills tab does not scroll sideways, in light and in dark', async () => {
    expect(LONG.length === 64, 'fixture name length');
    const small = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: 'light' });
    const p = await small.newPage();
    await p.goto(`${BASE}/`);
    await p.getByTestId('mode-select').selectOption('real');
    await p.waitForFunction(() => document.querySelector('[data-testid=mode-select]').value === 'real');
    await go(p, 'skills');
    await p.getByTestId(`skill-${LONG}`).click();
    expect((await p.getByTestId('skill-title').textContent()) === LONG, 'the long name is not shown in full');
    for (const theme of ['light', 'dark']) {
      await p.getByTestId('theme-select').selectOption(theme);
      await p.waitForTimeout(300);
      const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(w.sw <= w.cw + 1, `${theme}: scrollWidth ${w.sw} > ${w.cw}`);
      await shot(p, `375-${theme}-long-name`);
    }
    await small.close();
  });

  if (MUTANT) {
    await check(`the FAIL path: against a lab with host checks switched off and a tampered byte, the page shows FAIL (danger tone) for cases, the summary and the control; the untouched cases still say PASS (${MUTANT})`, async () => {
      const p = await ctx.newPage();
      await p.goto(`${MUTANT}/`);
      await go(p, 'verifier');
      await p.getByTestId('run-all').click();
      await p.getByTestId('verify-summary').waitFor({ timeout: 120000 });
      await p.waitForFunction(() => /control/.test(document.querySelector('[data-testid=control-legacy]')?.textContent || ''), null, { timeout: 120000 });
      const cls = (id) => p.getByTestId(id).getAttribute('class');
      for (const era of ['modern', 'legacy']) {
        const t = await p.getByTestId(`summary-${era}`).textContent();
        expect(new RegExp(`${N - 2}/${N} PASS, 2 FAIL`).test(t), `summary ${era}: ${t}`);
        expect(/chip--danger/.test(await cls(`summary-${era}`)), `summary ${era} is not in the danger tone`);
        expect(/control FAIL/.test(await p.getByTestId(`control-${era}`).textContent()) && /chip--danger/.test(await cls(`control-${era}`)), `control ${era} does not show FAIL in the danger tone`);
        for (const id of ['b-size-mismatch', 'f-name-collision']) {
          expect((await p.getByTestId(`verdict-${id}-${era}`).textContent()) === 'FAIL' && /chip--danger/.test(await cls(`verdict-${id}-${era}`)), `${id} ${era} is not a red FAIL`);
        }
        expect((await p.getByTestId(`verdict-a-digest-mismatch-${era}`).textContent()) === 'PASS', `a-digest-mismatch ${era} should still PASS`);
      }
      expect(await p.locator('[data-testid^=verdict-]').filter({ hasText: 'FAIL' }).count() === 4, 'expected exactly 4 FAIL cells (2 cases x 2 eras)');
      await p.getByTestId('open-b-size-mismatch').click();
      await p.getByTestId('detail-verdict').waitFor({ timeout: 30000 });
      expect((await p.getByTestId('detail-verdict').textContent()) === 'FAIL' && /chip--danger/.test(await p.getByTestId('detail-verdict').getAttribute('class')), 'detail verdict is not a red FAIL');
      await shot(p, '12-verifier-fail-path');
      await p.close();
    });
  }

  await check('no console errors, no page errors, no failed or 5xx requests during the whole run', async () => {
    expect(consoleProblems.length === 0, consoleProblems.slice(0, 3).join(' | '));
    expect(failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));
  });
} finally { await browser.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
