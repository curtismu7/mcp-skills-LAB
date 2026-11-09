// A browse session: one HostVerifier per workspace (the X-Workspace header), driven by the web app through /api/browse/*.
// The page never talks MCP itself: the verifier does, in-process, and every request/response pair is kept (bounded) so the page can show the raw wire.
// Nothing is executed, nothing leaves the machine, retrieval counters come from the verifier AND from counting resources/read on the wire.
import { HostVerifier } from './verifier/host.js';
import { FINDINGS } from './verifier/findings.js';

const MAX_WIRE = 80;
const BODY_CAP = 6000;
const MAX_SESSIONS = 100;
const TEXT_CAP = 64 * 1024;
const ACTIVATION_LINES = 40;
const cap = (s) => (s.length > BODY_CAP ? `${s.slice(0, BODY_CAP)}\n... (${s.length - BODY_CAP} more characters not shown)` : s);

/** Frames of a response body as JSON text: plain JSON, or the "data:" lines of an SSE body. */
function pretty(text) {
  const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  const raw = frames.length ? frames : [text.trim()];
  return raw.map((r) => { try { return JSON.stringify(JSON.parse(r), null, 2); } catch { return r; } }).join('\n\n');
}
const methodOf = (body) => { try { const m = JSON.parse(body); return typeof m?.method === 'string' ? m.method : null; } catch { return null; } };

export function wireEntry(w, seq) {
  return {
    seq, method: methodOf(w.requestBody), http: w.method, url: new URL(w.url, 'http://x.invalid').pathname, status: w.status, ms: w.ms, responseType: w.responseType,
    traceparent: w.requestHeaders.traceparent ?? null,
    requestHeaders: w.requestHeaders, request: w.requestBody ? cap(pretty(w.requestBody)) : '', response: cap(pretty(w.responseBody)),
  };
}

const summary = (r) => ({
  uri: r.uri, serverId: r.serverId, name: r.name, label: r.label, listed: r.listed, loadable: r.loadable, reasons: r.reasons, dynamic: r.dynamic,
  hash: r.hash, frontmatter: r.entry.frontmatter, resources: r.entry.resources,
});

export class BrowseSession {
  constructor({ fetch, base }) { this.fetch = fetch; this.base = base; this.v = null; this.target = null; this.era = null; this.wire = []; this.seq = 0; this.reads = 0; }

  onWire = (w) => { this.wire.push(wireEntry(w, ++this.seq)); if (this.wire.length > MAX_WIRE) this.wire.shift(); };

  async connect({ target, era, urlPath }) {
    await this.v?.close();
    this.wire = []; this.seq = 0;
    this.v = new HostVerifier({ fetch: this.fetch, onWire: this.onWire });
    this.target = target; this.era = era;
    const info = await this.v.connect('srv', `${this.base}${urlPath}`, { era });
    return info;
  }
  need() { if (!this.v) { const e = new Error('not connected: connect first'); e.code = 'not_connected'; throw e; } return this.v; }

  async list() { const v = this.need(); const l = await v.listSkills('srv'); return { pages: l.pages, truncated: l.truncated, ttlMs: l.ttlMs ?? null, cacheScope: l.cacheScope ?? null, skills: l.skills.map(summary) }; }
  async get(uri) { const v = this.need(); const g = await v.getSkill('srv', uri); return { skill: summary(g.record), ttlMs: g.ttlMs ?? null, cacheScope: g.cacheScope ?? null }; }
  async file(uri, ref) {
    const v = this.need();
    const f = await v.readFile('srv', uri, ref);
    const whole = f.ok && typeof f.text === 'string' ? f.text : null;
    const text = whole === null ? null : (whole.length > TEXT_CAP ? whole.slice(0, TEXT_CAP) : whole);
    // verified means the size and SHA-256 of ALL the bytes matched; the text sent to the page may be shorter (truncated says so).
    return { ok: f.ok, uri: f.uri, problems: f.problems, verified: f.verified, nested: Boolean(f.nested), bytes: f.bytes?.byteLength ?? null, text, binary: f.ok && text === null, truncated: whole !== null && whole.length > TEXT_CAP, shownChars: text?.length ?? 0, totalChars: whole?.length ?? 0, tagged: f.tagged ? f.tagged.split('\n')[0] : null };
  }
  async dir(uri, skillUri) { const v = this.need(); return v.readDirectory('srv', uri, skillUri); }
  async activate(uri) {
    const v = this.need();
    const a = await v.activate('srv', uri);
    const lines = a.content ? a.content.split('\n') : [];
    const shownLines = lines.slice(0, ACTIVATION_LINES).join('\n').slice(0, TEXT_CAP);
    return { loaded: a.loaded, reasons: a.reasons, requested: a.requested, grants: a.grants, origin: a.serverId && 'srv', content: a.content ? shownLines : null,
      contentTruncated: Boolean(a.content) && (lines.length > ACTIVATION_LINES || shownLines.length < lines.slice(0, ACTIVATION_LINES).join('\n').length), contentLines: { shown: Math.min(lines.length, ACTIVATION_LINES), total: lines.length } };
  }
  approve(uri, flags) { const v = this.need(); const r = v.approve('srv', uri, { scripts: flags.scripts === true, allowedTools: flags.allowedTools === true }); return r; }
  script(uri, ref) { const v = this.need(); return v.requestScriptRun('srv', uri, ref); }

  state() {
    const v = this.v;
    if (!v) return { connected: false, target: null, era: null, stats: { requests: 0, reads: 0, lists: 0, gets: 0, refreshes: 0 }, wireReads: 0, wireCount: 0, findings: [], approvals: {}, activated: [] };
    const approvals = {};
    for (const r of v.registry()) { try { const a = v.approvalFor(r.serverId, r.uri); if (a) approvals[r.uri] = { scripts: a.scripts, allowedTools: a.allowedTools, hash: a.hash }; } catch { /* record gone */ } }
    return {
      connected: true, target: this.target, era: this.era, stats: { ...v.stats },
      wireReads: this.wire.filter((w) => w.method === 'resources/read').length, wireCount: this.wire.length,
      findings: v.findings.map(({ key, ...f }) => ({ ...f, spec: FINDINGS[f.id]?.kind })), approvals, activated: [...v.activated].map((k) => k.split('|')[1]),
    };
  }
  async close() { await this.v?.close(); this.v = null; }
}

/** Sessions by workspace id, bounded: the oldest is dropped (and closed) beyond MAX_SESSIONS. */
export function createSessions({ fetch, base }) {
  const map = new Map();
  return {
    get(id) {
      let s = map.get(id);
      if (!s) {
        s = new BrowseSession({ fetch, base });
        map.set(id, s);
        if (map.size > MAX_SESSIONS) { const oldest = map.keys().next().value; map.get(oldest)?.close(); map.delete(oldest); }
      } else { map.delete(id); map.set(id, s); }
      return s;
    },
    async reset() { for (const s of map.values()) await s.close(); map.clear(); },
    get size() { return map.size; },
  };
}
