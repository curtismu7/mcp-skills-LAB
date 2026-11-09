#!/usr/bin/env node
// Reset a running lab: rebuilds the hostile servers (clears their per-case state) and re-scans SKILLS_DIR in Real mode.
//   node scripts/reset.mjs [base-url]      (default http://127.0.0.1:${PORT:-7807})
// Loopback only: refuses any other host. Needs the server already running; sends the same-origin header the server requires.
import { pathToFileURL } from 'node:url';
import { isLoopbackHost } from '../server/src/safety.js';

export async function reset(base = `http://127.0.0.1:${process.env.PORT || 7807}`) {
  const u = new URL(base);
  if (!isLoopbackHost(u.hostname)) throw new Error(`refusing ${u.hostname}: loopback only`);
  const r = await fetch(new URL('/api/reset', u), { method: 'POST', headers: { 'content-type': 'application/json', origin: u.origin }, body: '{}' });
  if (!r.ok) throw new Error(`reset failed: HTTP ${r.status}`);
  return r.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reset(process.argv[2]).then((j) => console.log(`reset: ${j.reset} (mode ${j.source})`), (e) => { console.error(e.message); process.exit(1); });
}
