// Real mode: serve skills read at runtime from a folder (SKILLS_DIR, a read-only bind mount in Docker). Nothing is copied into this repo.
// Every skill problem becomes a "catalog problem" in the API; none of them crashes the server.
//  - symlinks and special files: never followed (the SDK adapter skips the skill that contains one; a link that escapes the root is the same case)
//  - skills over the spec's SHOULD limits (512 files / 16 MiB): refused here (the SDK would only warn)
//  - SKILL.md that is not valid UTF-8, or whose frontmatter name differs from its folder: reported and skipped by the SDK catalog
//  - other non-UTF-8 files: served as binary blobs (base64), reported as info
import fs from 'node:fs';
import path from 'node:path';
import { SkillsExtension, SKILL_LIMITS } from '@modelcontextprotocol/server/ext/skills';
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node';
import { REAL_OPTIONS } from './catalogOptions.js';

export const NO_DIR_REASON = 'no skills directory configured (set SKILLS_DIR to a folder of skill folders, mounted read-only)';

/** Iterative, depth-bounded size scan of one skill folder using lstat only (never follows links, never reads content). */
function scanFolder(root, { maxDepth, maxFiles }) {
  let files = 0; let bytes = 0; let truncated = false;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) { truncated = true; continue; }
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      // lstat reports a link as neither a directory nor a file, so it is never followed and never counted (the SDK adapter refuses the skill that holds one)
      if (st.isDirectory()) { stack.push([p, depth + 1]); continue; }
      if (st.isFile()) { files += 1; bytes += st.size; }
      if (files > maxFiles) { truncated = true; stack.length = 0; break; }
    }
  }
  return { files, bytes, truncated };
}

function isUtf8(buf) { try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; } }

export async function loadRealCatalog(dirInput, { limits = SKILL_LIMITS, scan = {} } = {}) {
  const scanLimits = { maxDepth: 24, maxFiles: 100000, ...scan }; // overridable so tests can hit the caps with tiny fixtures
  const problems = [];
  if (!dirInput) return { available: false, reason: NO_DIR_REASON, problems, entries: [], ext: null };
  let root;
  try {
    root = fs.realpathSync(dirInput);
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    return { available: false, reason: `skills directory is not readable (${e.code || e.message})`, problems, entries: [], ext: null };
  }

  // Pre-scan the top-level folders: refuse the ones over the limits before the SDK sees them.
  const refused = new Set();
  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { /* handled by the SDK adapter */ }
  for (const d of top) {
    if (!d.isDirectory()) continue; // links at the top level are reported by the SDK adapter as unsupported
    const s = scanFolder(path.join(root, d.name), scanLimits);
    if (s.files > limits.files || s.bytes > limits.bytes || s.truncated) {
      refused.add(d.name);
      problems.push({ level: 'refused', path: d.name, message: `skill folder has ${s.truncated ? 'too many entries to count' : `${s.files} files / ${s.bytes} bytes`}; the spec says servers SHOULD NOT serve more than ${limits.files} files / ${limits.bytes} bytes (refused)` });
    }
    // Non-UTF-8 files other than SKILL.md are served as blobs; say so (bounded: first 50 files per skill, small files only).
    let seen = 0;
    const stack = [path.join(root, d.name)];
    while (stack.length && seen < 50 && !refused.has(d.name)) {
      const dir = stack.pop();
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of names) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (!e.isFile() || seen >= 50) continue;
        if (p === path.join(root, d.name, 'SKILL.md')) continue; // a non-UTF-8 SKILL.md is refused by the catalog (one report, not two)
        seen += 1;
        try { if (fs.statSync(p).size <= 262144 && !isUtf8(fs.readFileSync(p))) problems.push({ level: 'info', path: path.relative(root, p), message: 'not valid UTF-8: served as a binary blob (base64), digest over the raw bytes' }); } catch { /* ignore */ }
      }
    }
  }

  const base = nodeSkillFiles(root);
  const files = {
    list: async (dir) => (await base.list(dir)).filter((e) => !(dir === '' && refused.has(e.name))),
    read: (p) => base.read(p),
  };
  const warnings = [];
  const ext = await SkillsExtension.load(files, { ...REAL_OPTIONS, onWarning: (w) => warnings.push(w) });
  for (const w of warnings) {
    const skipped = /\bskipped\b/.test(w.message);
    problems.push({ level: skipped ? 'refused' : 'warning', path: w.path, message: w.message });
  }
  return { available: true, reason: null, problems, entries: [...ext.entries], ext, root: path.basename(root) };
}
