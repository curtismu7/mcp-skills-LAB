// A test-only lab server for the browser check's FAIL path. It is the real app with two things changed on purpose, so the page has something to show in red:
//   MUTANT_DISABLE (default "size,collision")  host checks switched off for POST /api/verify, so those hostile cases FAIL;
//   MUTANT_TAMPER=1 (default on)               one byte of references/CHECKLIST.md is flipped on the wire (same length), so the digest check fails the clean control.
// It lives under test/ (not in the Docker image) and nothing in the shipped server can switch a check off.
import { installNetguard } from '../../server/src/netguard.js';
import { createApp } from '../../server/src/app.js';

installNetguard();
const disable = (process.env.MUTANT_DISABLE ?? 'size,collision').split(',').map((s) => s.trim()).filter(Boolean);
const app = await createApp({ env: process.env, verifyDisable: disable });
if ((process.env.MUTANT_TAMPER ?? '1') === '1') {
  const real = app.fetch;
  app.fetch = async (req, opts) => {
    const res = await real(req, opts);
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/mcp') return res;
    const body = await req.clone().text();
    if (!body.includes('"resources/read"') || !body.includes('CHECKLIST.md')) return res;
    const text = await res.text();
    const obj = JSON.parse(text.startsWith('data:') ? text.slice(5) : text);
    const t = obj.result.contents[0].text;
    obj.result.contents[0].text = `${t.slice(0, 5)}${t[5] === 'X' ? 'Y' : 'X'}${t.slice(6)}`;
    return new Response(JSON.stringify(obj), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
}
const port = Number(process.env.PORT) || 7897;
await app.listen(port, '127.0.0.1');
console.log(`[mutant-server] http://127.0.0.1:${port}/ checks off: ${disable.join(',') || 'none'}; tamper ${process.env.MUTANT_TAMPER ?? '1'}`);
