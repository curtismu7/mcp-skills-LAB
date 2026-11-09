import { installNetguard } from './netguard.js';
import { createApp } from './app.js';
import { allPassed, runChecks } from './doctor.js';
import { assertBindAllowed, bindHost, resolvePort } from './safety.js';

installNetguard(); // before anything else can open a socket

const app = await createApp();
const checks = await runChecks({ catalogs: app.catalogs });
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[mcp-skills-lab] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
const host = assertBindAllowed(bindHost(), process.env);
const port = resolvePort();
await app.listen(port, host);
console.log(`[mcp-skills-lab] simulated lab at http://${host}:${port}/ (${app.catalogs.source} mode; loopback, no outbound network; MCP: /mcp; health: /api/health)`);
