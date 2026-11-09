// Builds content-pack.json for the Learning Hub from the hostile-case data, so the pack cannot drift from the cases.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
// demo.catalog is D999: the content-pack schema requires a catalog id and no catalog row matches this lab yet (D999 is the family's "no row yet"
// placeholder). docs/shelf-entry.json keeps catalogId "TBD" until the owner assigns one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTILE_CASES } from '../server/src/hostile/cases.js';
import { SPEC_SOURCES } from '../server/src/spec.js';
import { strictestKind } from '../server/src/verifier/findings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const storyId = (i) => `S${String(i + 1).padStart(2, '0')}`; // the hub wants S01, S02, ...

const TERMS = {
  digest: ['digest'], size: ['digest'], frontmatter: ['frontmatter'], 'manifest-only': ['manifest'], 'approval-binding': ['approval-binding'],
  'allowed-tools': ['allowed-tools'], collision: ['name-collision'], dynamic: ['dynamic-skill'], 'uri-scope': ['manifest'], limits: ['manifest'], 'name-path': ['skill'],
  'unlisted-flag': ['skill'], 'exec-gate': ['untrusted-content'], 'cross-server': ['origin-binding'], 'manifest-self': ['manifest'], nested: ['skill'],
};

export function buildPack() {
  return {
    schema: 'demo-content-pack/1',
    id: 'mcp-skills-lab',
    title: 'MCP Skills LAB',
    version,
    demo: { id: 'mcp-skills-lab', name: 'MCP Skills LAB', catalog: 'D999', baseUrl: 'http://127.0.0.1:7807', doctor: '/api/health', tags: ['mcp', 'skills', 'sep-2640', 'host-verification', 'hostile', 'mock'] },
    glossary: [
      { id: 'skill', term: 'Skill', definition: 'A folder with a SKILL.md (YAML frontmatter with name and description) and optional files, exposed over MCP resources at skill://<skill-path>/<file>. The last segment of the skill path must equal the frontmatter name.' },
      { id: 'manifest', term: 'Manifest', definition: 'The resources array of a skill entry: every file exactly once (including SKILL.md) with its URI, SHA-256 digest and byte size. A host reads only URIs that are in it.' },
      { id: 'digest', term: 'Digest and size', definition: 'The sha256:<64 hex> digest and byte size in the manifest. A host checks both on every file it fetches and does not use a file that fails. A digest match is not a trust boundary: the digests are unsigned and come from the same server.' },
      { id: 'frontmatter', term: 'Frontmatter comparison', definition: 'A host parses the fetched SKILL.md frontmatter and compares it field by field with the entry; any difference means the skill is not loaded. This lab uses the SDK\'s own parser for it.' },
      { id: 'approval-binding', term: 'Content-bound approval', definition: 'An approval is bound to the resources set (every URI and digest). A changed set revokes it, and returning to the old set does not bring it back.' },
      { id: 'allowed-tools', term: 'allowed-tools', definition: 'A frontmatter field asking for tool permissions. For a skill that came over MCP it is ignored unless the user explicitly approves that grant; hooks are ignored or gated the same way.' },
      { id: 'name-collision', term: 'Name collision', definition: 'Names are labels, not identifiers. Two skills can share a name (one server or two); a host disambiguates them and does not let one silently replace the other.' },
      { id: 'dynamic-skill', term: 'Dynamic skill', definition: 'An entry with resources: "dynamic". Its files cannot be pinned by digest, so a host may decline it and cannot bind an approval to it.' },
      { id: 'untrusted-content', term: 'Untrusted content', definition: 'Skill text is untrusted model input. A host tags it with the server it came from and never runs a script from it without a per-skill approval. Nothing in this lab ever executes.' },
      { id: 'origin-binding', term: 'Origin binding', definition: 'A skill is identified by the host\'s label for the server plus its URI. A read of another server\'s resource needs explicit per-call approval naming both servers.' },
    ],
    sources: [
      { id: 'mcp-skills-overview', title: 'MCP Skills extension: overview', url: SPEC_SOURCES.overview, kind: 'standard', use: 'What the extension is', status: 'read', checked: '2026-11-09' },
      { id: 'mcp-skills-sep-2640', title: 'SEP-2640: Skills extension', url: SPEC_SOURCES.sepPage, kind: 'standard', use: 'The proposal text', status: 'read', checked: '2026-11-09' },
      { id: 'mcp-skills-spec', title: 'ext-skills specification (skills.mdx)', url: SPEC_SOURCES.specification, kind: 'standard', use: 'Wire format and host requirements; read through a page summariser, not verbatim', status: 'read', checked: '2026-11-09' },
    ],
    stories: HOSTILE_CASES.map((c, i) => ({ id: storyId(i), title: c.title, say: c.expected })),
    cards: [
      { id: 'tab-skills', label: 'Browse skills, read nothing until you click', description: 'List a server\'s skills and manifests; the retrieval counter stays at 0 until a file is opened.', group: 'concept', action: { type: 'route', href: '/#/skills' }, terms: ['skill', 'manifest'] },
      { id: 'tab-approvals', label: 'Approvals bound to the set of files', description: 'Approve, swap the manifest, watch the approval go and stay gone.', group: 'concept', action: { type: 'route', href: '/#/approvals' }, terms: ['approval-binding', 'allowed-tools'] },
      ...HOSTILE_CASES.map((c, i) => ({
        id: `try-${c.id}`, label: `${c.letter}: ${c.title}`, description: `${strictestKind(c.findings)}: ${c.expected}`, group: 'try-it', action: { type: 'route', href: `/#/verifier?case=${c.id}` }, story: storyId(i), terms: TERMS[c.guardedBy] ?? ['skill'],
      })),
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
  console.log('wrote content-pack.json');
}
