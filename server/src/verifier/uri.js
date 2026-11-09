// URI containment and canonical file keys for skill manifests. Pure functions, no I/O.
//  - outsideRootReason: is a manifest URI inside the skill root? Checks the RAW string first (WHATWG URL parsing silently removes ".." segments
//    for non-special schemes, which would hide the attack), then every segment through bounded repeated percent-decoding. It fails CLOSED:
//    a segment that is still changing after MAX_DECODES rounds is refused.
//  - fileKey: one spelling for all ways of writing a file's URI below a root (Q&A.md, Q%26A.md), like the SDK client does, so a listed file
//    matches however the name is percent-encoded.
const MAX_DECODES = 4;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
const CONTROL = /[\u0000-\u001F\u007F]/u;
const FULLWIDTH_DOT = /[\uFF0E\u3002\uFF61]/u;

const tryUrl = (u) => { try { return new URL(u); } catch { return undefined; } };
const tryDecode = (s) => { try { return decodeURIComponent(s); } catch { return undefined; } };

/** Why one path segment (at any decoding round) is unacceptable, or null. */
function segmentProblem(seg) {
  if (seg === '') return 'empty path segment';
  if (seg === '.' || seg === '..') return 'dot segment';
  if (/^\.{1,2};/.test(seg) || seg.includes('..;')) return 'path-parameter dot segment ("..;")';
  if (seg.includes('/')) return 'encoded slash in a segment';
  if (seg.includes('\\')) return 'backslash';
  if (CONTROL.test(seg)) return 'control character (NUL, line break, ...)';
  if (BIDI.test(seg)) return 'bidirectional override character';
  if (FULLWIDTH_DOT.test(seg)) return 'fullwidth or ideographic dot';
  return null;
}

/** Returns null when `uri` is a file strictly inside `rootUri` (which ends with "/"), else a short reason. */
export function outsideRootReason(rootUri, uri) {
  if (typeof uri !== 'string' || uri === '') return 'empty URI';
  const rootScheme = rootUri.slice(0, rootUri.indexOf(':'));
  const scheme = uri.includes(':') ? uri.slice(0, uri.indexOf(':')) : '';
  if (scheme.toLowerCase() !== rootScheme.toLowerCase()) return `other scheme (${scheme || 'none'})`;
  const parsed = tryUrl(uri); const root = tryUrl(rootUri);
  if (!parsed || !root) return 'not a valid URI';
  if (!uri.startsWith(rootUri) && !parsed.href.startsWith(root.href)) return 'does not start with the skill root';
  // Work on the raw remainder when the spelling matches the root, else on the canonical form.
  const rel = uri.startsWith(rootUri) ? uri.slice(rootUri.length) : parsed.href.slice(root.href.length);
  if (rel === '') return 'the root itself, not a file';
  if (/[?#]/.test(rel)) return 'query or fragment in a file URI (a file name containing ? or # must be percent-encoded)';
  for (const raw of rel.split('/')) {
    let cur = raw;
    for (let round = 0; ; round++) {
      const p = segmentProblem(cur);
      if (p) return round === 0 ? p : `${p} after ${round} round(s) of percent-decoding`;
      const next = tryDecode(cur);
      if (next === undefined || next === cur) break;       // malformed escape or stable: a literal "%" is a legal file name character
      if (round + 1 >= MAX_DECODES) return `percent-decoding does not converge within ${MAX_DECODES} rounds (refused, fail closed)`;
      cur = next;
    }
  }
  if (parsed.href.slice(root.href.length) === '' || !parsed.href.startsWith(root.href)) return 'canonical form leaves the skill root';
  return null;
}

const encodePathText = (text) => text.replaceAll(/[^\w!$&'()*+,.:;=@[\]|~-]/gu, (c) => encodeURIComponent(c));

/** One spelling for every way of writing a file below `rootUri` (with trailing slash). Undefined if the URI does not parse. */
export function fileKey(rootUri, uri) {
  const u = tryUrl(uri); const r = tryUrl(rootUri);
  if (!u || !r) return undefined;
  u.hash = '';
  const href = u.href;
  if (href.includes('?') || !href.startsWith(r.href)) return href;
  return r.href + href.slice(r.href.length).split('/').map((seg) => {
    const dec = tryDecode(seg);
    return encodePathText(dec === undefined ? seg : dec); // a malformed escape is a literal "%"
  }).join('/');
}

export const canonicalUri = (uri) => tryUrl(uri)?.href;
