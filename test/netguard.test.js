// Zero real outbound calls: the guard has a self-test, refuses every kind of non-loopback attempt, and a full run of the app records none.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dns from 'node:dns';
import { installNetguard, netguardSelfTest } from '../server/src/netguard.js';
import { listen } from './helpers.js';
import { runAllCases, runControl } from '../server/src/verifier/drive.js';

test('self-test: the guard refuses fetch, socket, socket-by-IP, dns lookup, dns resolve, udp send and udp connect (7 of 7)', async () => {
  installNetguard();
  const r = await netguardSelfTest();
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.blocked, 7);
  assert.equal(r.detail.split('; ').length, 7);
});

test('self-test results do not leak into the attempt log, and overlapping self-tests do not corrupt each other', async () => {
  const guard = installNetguard();
  const [a, b] = await Promise.all([netguardSelfTest(), netguardSelfTest()]);
  assert.ok(a.ok && b.ok);
  assert.equal(guard.attempts.length, 0);
});

test('real attempts are refused AND recorded; loopback is not', async () => {
  const guard = installNetguard();
  const before = guard.attempts.length;
  await assert.rejects(fetch('https://outbound.example/x'), /network blocked/);
  assert.throws(() => net.connect({ host: 'outbound.example', port: 443 }).on('error', () => {}), /network blocked/);
  await assert.rejects(dns.promises.lookup('outbound.example'), /network blocked/);
  assert.deepEqual(guard.attempts.slice(before).map((x) => x.split(':')[0]), ['fetch', 'socket', 'dns']);
  guard.attempts.length = before;
  const srv = await listen();
  try { assert.equal((await fetch(`${srv.base}/api/health`)).status, 200); } finally { await srv.close(); }
  assert.equal(guard.attempts.length, before, 'loopback fetch is allowed and not an attempt');
});

test('a full run (all hostile cases in both eras, the clean control, the API) makes ZERO outbound attempts', async () => {
  const guard = installNetguard();
  guard.attempts.length = 0;
  const srv = await listen();
  try {
    for (const era of ['modern', 'legacy']) {
      const all = await runAllCases({ base: srv.base, era, beforeCase: (id) => srv.app.hostile.resetCase(id) });
      assert.equal(all.passed, all.total);
      assert.equal((await runControl({ base: srv.base, era })).verdict, 'PASS');
    }
    await fetch(`${srv.base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await fetch(`${srv.base}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  } finally { await srv.close(); }
  assert.deepEqual(guard.attempts, [], 'outbound attempts recorded by the netguard');
});

test('the verifier refuses a non-loopback endpoint before opening anything', async () => {
  const guard = installNetguard();
  const { HostVerifier } = await import('../server/src/verifier/host.js');
  const v = new HostVerifier();
  await assert.rejects(v.connect('x', 'https://skills.example/mcp'), /loopback/);
  assert.equal(guard.attempts.length, 0);
});

test('the hostile URLs (https://files.example/..., skill:///etc/...) are data: following a manifest never fetches them', async () => {
  const guard = installNetguard();
  guard.attempts.length = 0;
  const srv = await listen();
  try {
    for (const id of ['h3-other-scheme', 'h2-absolute-path', 'l-cross-server-reference']) {
      await srv.app.hostile.resetCase(id);
      const { runCase } = await import('../server/src/verifier/drive.js');
      assert.equal((await runCase(id, { base: srv.base })).verdict, 'PASS');
    }
  } finally { await srv.close(); }
  assert.deepEqual(guard.attempts, []);
});
