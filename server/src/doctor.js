// Preflight checks shared by `npm run doctor` and GET /api/health. Never prints a secret, needs no network.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import { assertBindAllowed, bindHost, portProblem, DEFAULT_PORT, PORT_MIN, PORT_MAX } from './safety.js';
import { netguardSelfTest } from './netguard.js';
import { MOCK_FILES } from './catalog/mockSkills.js';
import { HOSTILE_CASES } from './hostile/cases.js';
import { CHECKS } from './verifier/findings.js';
import fs from 'node:fs';
import path from 'node:path';
import { DIAGRAM_NAMES, loadDiagram } from './diagramData.js';
import { TALK_TRACK } from './talkTrack.js';
import { WEB_DIST } from './static.js';

export async function runChecks({ env = process.env, catalogs, selfTest } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 26 ? 'pass' : 'fail', `v${process.versions.node} (need >= 26)`);

  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.SKILLS_LAB_BIND ? ' (SKILLS_LAB_BIND opt-in)' : ' (loopback)'}`); }
  catch (e) { add('bind', 'fail', e.message); }

  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  add('port-range', problem ? 'fail' : 'pass', problem || `${port} is inside ${PORT_MIN}-${PORT_MAX} and not reserved`);

  if (catalogs) {
    add('mock-catalog', catalogs.mockExt.entries.length >= 3 ? 'pass' : 'fail', `${catalogs.mockExt.entries.length} synthetic skills, digests built by the SDK`);
    add('real-catalog', catalogs.realAvailable ? 'pass' : 'info', catalogs.realAvailable ? `SKILLS_DIR readable (${catalogs.info().skillCount} skills in the current mode, ${catalogs.problems.length} catalog problems reported)` : `Real mode off: ${catalogs.realReason}`);
    add('mode', 'pass', `${catalogs.source} (toggle: POST /api/mode)`);
  } else add('mock-catalog', Object.keys(MOCK_FILES).length >= 3 ? 'pass' : 'fail', `${Object.keys(MOCK_FILES).length} synthetic files`);

  add('hostile-catalog', HOSTILE_CASES.length >= 12 ? 'pass' : 'fail', `${HOSTILE_CASES.length} hostile cases, ${CHECKS.length} named host checks`);

  try { for (const n of DIAGRAM_NAMES) loadDiagram(n); add('diagrams', 'pass', `${DIAGRAM_NAMES.length} diagram-studio/1 diagram loads and validates`); }
  catch (e) { add('diagrams', 'fail', e.message); }

  const ids = TALK_TRACK.map((t) => t.id);
  add('talk-track', new Set(ids).size === ids.length && TALK_TRACK.every((t) => t.title && t.say) ? 'pass' : 'fail', `${TALK_TRACK.length} talk-track entries, unique ids`);

  const built = fs.existsSync(path.join(env.WEB_DIST || WEB_DIST, 'index.html'));
  add('web', built ? 'pass' : 'info', built ? 'web/dist is built; the page is served at /' : 'web/dist is not built: run npm run build (the API and MCP endpoints work without it)');

  const ng = selfTest ? await selfTest() : await netguardSelfTest();
  add('netguard', ng.ok ? 'pass' : 'fail', ng.ok ? `blocked fetch, socket, socket-by-IP, dns lookup, dns resolve, udp send and udp connect to a non-loopback host (${ng.blocked}/7)` : ng.detail);

  add('tenant', 'pass', 'simulated only: no tenant, no credentials, no outbound network; the extension is new and nothing here is verified against a vendor gateway (UNVERIFIED)');
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
