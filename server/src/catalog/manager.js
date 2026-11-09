// The runtime server-side mode (rule 19): "mock" (synthetic skills in this repo) or "real" (SKILLS_DIR read at runtime).
// Default: Real if a usable SKILLS_DIR is configured, else Mock. Switching needs no restart.
import { SkillsExtension, memorySkillFiles } from '@modelcontextprotocol/server/ext/skills';
import { MOCK_FILES } from './mockSkills.js';
import { MOCK_OPTIONS } from './catalogOptions.js';
import { loadRealCatalog, NO_DIR_REASON } from './real.js';

export async function createCatalogs({ env = process.env } = {}) {
  const dir = env.SKILLS_DIR || '';
  const mock = await SkillsExtension.load(memorySkillFiles(MOCK_FILES), { ...MOCK_OPTIONS, strict: true });
  let real = await loadRealCatalog(dir);
  let source = real.available ? 'real' : 'mock';

  const api = {
    get source() { return source; },
    get realAvailable() { return real.available; },
    get realReason() { return real.available ? null : (real.reason || NO_DIR_REASON); },
    /** The SkillsExtension serving the current mode. */
    get ext() { return source === 'real' ? real.ext : mock; },
    get entries() { return [...(source === 'real' ? real.entries : mock.entries)]; },
    get problems() { return source === 'real' ? [...real.problems] : []; },
    mockExt: mock,
    setSource(next) {
      if (next === 'real' && !real.available) { const e = new Error(api.realReason); e.code = 'real_not_available'; throw e; }
      source = next;
    },
    /** Reset (rule 3): re-scan the Real folder. Mock is immutable. */
    async reset() {
      real = await loadRealCatalog(dir);
      if (source === 'real' && !real.available) source = 'mock';
      return { reset: true, source };
    },
    info() {
      return { mode: source, source, realAvailable: real.available, realReason: api.realReason, modes: ['mock', 'real'], simulated: source === 'mock', skillCount: api.entries.length, problemCount: api.problems.length, directory: real.available ? real.root : null };
    },
  };
  return api;
}
