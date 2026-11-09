// The finding vocabulary of the host verifier. Each finding names the spec statement it comes from (paraphrased from the specification page
// summary; see SPEC_SOURCES.readNote) and whether the statement is a spec MUST/SHOULD or a lab policy the spec leaves to the host.
export const FINDINGS = {
  'digest-mismatch': { must: 'Hosts MUST verify each file\'s SHA-256 digest against the skill entry; a mismatch MUST NOT be used.', kind: 'MUST', check: 'digest' },
  'size-mismatch': { must: 'Hosts MUST verify each file\'s byte size against the skill entry; a mismatch MUST NOT be used.', kind: 'MUST', check: 'size' },
  'frontmatter-mismatch': { must: 'Hosts MUST parse the fetched SKILL.md frontmatter and compare it field by field with the entry\'s frontmatter; any discrepancy means the skill MUST NOT be loaded.', kind: 'MUST', check: 'frontmatter' },
  'frontmatter-unreadable': { must: 'Same rule as above: frontmatter the SDK parser cannot read, or an entry the SDK itself refuses, cannot be compared, so the skill is not loaded (fail closed, lab behaviour).', kind: 'lab', check: 'frontmatter' },
  'unlisted-file-read': { must: 'While acting on a skill, hosts MUST resolve reads only to URIs in the held entry; reading an unlisted file is a verification failure.', kind: 'MUST', check: 'manifest-only' },
  'approval-revoked': { must: 'Persisted approvals MUST be bound to the entry\'s resources set (every uri and digest); a changed set MUST revoke the approval and trigger a re-prompt.', kind: 'MUST', check: 'approval-binding' },
  'allowed-tools-ignored': { must: '`allowed-tools` MUST be ignored for MCP-origin skills unless the user explicitly approves that grant; declarative hooks and frontmatter scripts MUST be ignored or gated.', kind: 'MUST', check: 'allowed-tools' },
  'hooks-ignored': { must: 'Declarative hooks and frontmatter scripts MUST be ignored or gated (no implicit execution).', kind: 'MUST', check: 'allowed-tools' },
  'name-collision': { must: 'Names are labels, not identifiers: hosts MUST NOT assume uniqueness, MUST disambiguate collisions and MUST NOT silently shadow a same-named skill from any other origin. Surfacing the collision to the user is a SHOULD; this finding is that surfacing.', kind: 'SHOULD', check: 'collision' },
  'dynamic-declined': { must: 'Dynamic skills (resources: "dynamic") cannot be content-bound: hosts MAY decline to load them and MUST NOT treat a persisted approval as covering whatever content is currently served.', kind: 'MAY', check: 'dynamic' },
  'dynamic-not-bindable': { must: 'A persisted approval MUST NOT be treated as covering whatever content a dynamic skill currently serves.', kind: 'MUST', check: 'dynamic' },
  'uri-outside-root': { must: 'Reads resolve only to URIs in the held entry, and relative references resolve against the directory containing SKILL.md. A manifest URI that leaves the skill root (.., absolute path, another scheme, encoded .., backslash, NUL, line break, bidi override, fullwidth dot, "..;", or a decoding that never settles) is refused (lab policy: the spec does not list this attack by name).', kind: 'lab', check: 'uri-scope' },
  'limit-files': { must: 'Servers SHOULD NOT serve a skill with more than 512 resource entries; hosts MUST support up to that limit. Declining above it is lab policy (hosts MAY decline).', kind: 'SHOULD', check: 'limits' },
  'limit-bytes': { must: 'Servers SHOULD NOT serve a skill whose total size is over 16 MiB (16,777,216 bytes). Declining above it is lab policy (hosts MAY decline).', kind: 'SHOULD', check: 'limits' },
  'name-path-mismatch': { must: 'The final segment of <skill-path> MUST equal the frontmatter `name`.', kind: 'MUST', check: 'name-path' },
  'untrusted-content': { must: 'Hosts MUST treat skill content as untrusted model input, tag it with its originating server where it enters context, and never present it as a local skill.', kind: 'MUST', check: null },
  'injection-markers': { must: 'Skill content is untrusted input (heuristic marker scan, informational: a scan is never a defence).', kind: 'info', check: null },
  'script-exec-denied': { must: 'Hosts MUST NOT allow code execution from skill content without explicit per-skill approval.', kind: 'MUST', check: 'exec-gate' },
  'unlisted-skill': { must: 'skills/list MAY be empty or partial and MUST NOT be treated as proof the server has no skills; servers MUST answer skills/get for every skill they serve. The spec only requires that a skill can be loaded by URI; flagging it as unlisted and giving it the same checks and approvals is lab policy.', kind: 'lab', check: 'unlisted-flag' },
  'cross-server-denied': { must: 'Reads bind to the originating server; a cross-server read MUST need explicit per-call approval naming both servers (identified by host-assigned labels, not serverInfo.name).', kind: 'MUST', check: 'cross-server' },
  'invalid-entry': { must: 'A skill entry whose uri is not a SKILL.md URI (or whose `resources` is not a complete array or "dynamic") MUST NOT be loaded.', kind: 'MUST', check: null },
  'manifest-missing-skill-md': { must: 'A resources array MUST be complete, listing every file exactly once, including SKILL.md; an incomplete manifest is not loaded (lab: refuse the skill).', kind: 'MUST', check: 'manifest-self' },
  'manifest-duplicate': { must: 'A resources array lists every file exactly once; a repeated URI (also under another percent-encoding) makes the manifest ambiguous (lab: refuse the skill).', kind: 'MUST', check: 'manifest-self' },
  'nested-skill': { must: 'A nested skill\'s files are ordinary supporting files of the enclosing skill; hosts MUST NOT act on a nested SKILL.md\'s frontmatter as a skill.', kind: 'MUST', check: 'nested' },
  'nested-activation-denied': { must: 'Activating a nested skill requires fresh, explicit user consent; approval of the enclosing skill does not cover it.', kind: 'MUST', check: 'nested' },
  'list-truncated': { must: 'A listing that keeps returning a nextCursor is cut off after a page budget and reported, not silently truncated (lab policy; the spec allows partial listings).', kind: 'lab', check: null },
  'entry-refreshed': { must: 'When a file fails verification the host refetches the entry with skills/get before giving up (the listing may be stale); a changed resources set is treated as a changed manifest (lab policy).', kind: 'lab', check: null },
  'directory-unlisted-child': { must: 'Directory reads do not extend the held manifest: hosts MUST NOT surface an unlisted child as a skill file and SHOULD present the change as a skill needing re-approval.', kind: 'MUST', check: null },
  'resources-capability-missing': { must: 'A server that declares the skills extension MUST also declare the resources capability. A host does not call skills methods on a server that declares the extension without it.', kind: 'MUST', check: 'resources-cap' },
  'extra-frontmatter-ignored': { must: 'Frontmatter fields other than the Agent Skills set (name, description, license, compatibility, metadata, allowed-tools) are never honoured by this host. Whether the spec names other permission-widening fields is UNVERIFIED.', kind: 'info', check: null },
};

export const CHECKS = ['digest', 'size', 'frontmatter', 'manifest-only', 'approval-binding', 'allowed-tools', 'collision', 'dynamic', 'uri-scope', 'limits', 'name-path', 'unlisted-flag', 'exec-gate', 'cross-server', 'manifest-self', 'nested', 'resources-cap'];

const KIND_ORDER = ['MUST', 'SHOULD', 'MAY', 'lab', 'info'];
/** The strictest spec level among some finding ids (MUST > SHOULD > MAY > lab > info). */
export const strictestKind = (ids) => KIND_ORDER.find((k) => ids.some((id) => FINDINGS[id]?.kind === k)) ?? 'info';
