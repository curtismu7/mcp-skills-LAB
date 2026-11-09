// Preflight: the same checks GET /api/health reports from (Node version, bind, port range, catalogs, hostile catalog, netguard self-test), plus whether
// the port is free, plus one real run through the HTTP layer on a throwaway port (every hostile case in both eras must end PASS, the clean control must pass).
// Prints only pass/fail lines, never a setting's value. Exit 1 on failure. Needs no network and no other service.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(root, p)));
const { installNetguard } = await load('server/src/netguard.js');
installNetguard();

const { createApp } = await load('server/src/app.js');
const { runChecks } = await load('server/src/doctor.js');
const { runAllCases, runControl } = await load('server/src/verifier/drive.js');
let failed = 0;
const report = (level, name, detail) => { if (level === 'fail') failed++; console.log(`${level.toUpperCase().padEnd(4)}  ${name}: ${detail}`); };

const app = await createApp({ env: { ...process.env, PORT: process.env.PORT || '7807' } });
for (const c of await runChecks({ catalogs: app.catalogs })) report(c.level, c.id, c.detail);

try {
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const hz = await (await fetch(`${base}/api/health`)).json();
  report(hz.schema === 'demo-health/1' ? 'pass' : 'fail', 'health', `answers ${hz.schema}`);
  for (const era of ['modern', 'legacy']) {
    const all = await runAllCases({ base, era, beforeCase: (id) => app.hostile.resetCase(id) });
    report(all.passed === all.total ? 'pass' : 'fail', `hostile-${era}`, `${all.passed}/${all.total} hostile cases correctly rejected or flagged`);
    const ctl = await runControl({ base, era });
    report(ctl.verdict === 'PASS' ? 'pass' : 'fail', `control-${era}`, `clean ${app.catalogs.source} catalog: ${ctl.skills.length} skills loaded and every file verified, 0 reads before a file is needed`);
  }
} catch (e) { report('fail', 'http-cycle', `could not run (${String(e.message).slice(0, 120)})`); }
await app.close();

const port = Number(process.env.PORT) || 7807;
await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => { report('fail', 'port-free', `${port} is not free (${e.code}). Set PORT to a free port in 7800-7999`); resolve(); });
  s.listen(port, '127.0.0.1', () => s.close(() => { report('pass', 'port-free', `${port} is free`); resolve(); }));
});
process.exit(failed ? 1 : 0);
