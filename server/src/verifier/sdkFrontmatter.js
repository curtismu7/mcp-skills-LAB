// Frontmatter verification by the SDK itself. This lab used to ship its own YAML-subset parser; it disagreed with the SDK's on block scalars,
// comments and number forms, so a host built on it could accept a SKILL.md that SkillsClient.read rejects. Now the SDK's parser and field-by-field
// comparison are the only ones: we hand SkillsClient a one-resource stub "client" that returns the bytes we already fetched, with the entry's
// size and digest set to those bytes' (so ONLY the frontmatter rules can fail). The SDK's `_readResource` and `_enforceStrictCapabilities` are
// private members, which is acceptable because the SDK is pinned to the exact version 2.4.0 (a test pins it and exercises this path).
import { SkillsClient, SkillVerificationError } from '@modelcontextprotocol/client/ext/skills';
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/skills';
import { createHash } from 'node:crypto';
import { canonicalUri } from './uri.js';

const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * entry: the manifest entry (as received). content: the resources/read content item {uri, mimeType?, text|blob}. bytes: its raw bytes.
 * Returns { ok: true, frontmatter, body } or { ok: false, kind: 'mismatch'|'unreadable', differences, message }. Never throws.
 */
export async function checkSkillMdWithSdk(entry, content, bytes) {
  const self = canonicalUri(entry.uri);
  const patched = entry.resources === 'dynamic' ? entry : {
    ...entry,
    resources: entry.resources.map((r) => (canonicalUri(r.uri) === self ? { ...r, size: bytes.byteLength, digest: digestOf(bytes) } : r)),
  };
  const stub = {
    getServerCapabilities: () => ({ resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } }),
    getNegotiatedProtocolVersion: () => '2026-07-28',
    _enforceStrictCapabilities: false,
    _readResource: async () => ({ result: { contents: [content] }, cached: false }),
  };
  try {
    const file = await new SkillsClient(stub).read(patched, 'SKILL.md');
    return { ok: true, frontmatter: file.frontmatter ?? entry.frontmatter, body: file.body ?? '' };
  } catch (e) {
    if (e instanceof SkillVerificationError && e.reason === 'frontmatter') {
      return e.differences.length > 0
        ? { ok: false, kind: 'mismatch', differences: [...e.differences], message: e.message }
        : { ok: false, kind: 'unreadable', differences: [], message: e.message };
    }
    // Anything else (the SDK refuses the entry itself, a size or digest rule, an unexpected shape): fail closed.
    return { ok: false, kind: 'unreadable', differences: [], message: String(e?.message ?? e).slice(0, 200) };
  }
}
