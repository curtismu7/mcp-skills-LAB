// The host verifier: a small, in-memory MCP Skills HOST MODEL. It connects to a skills server with the SDK client, lists and gets skills, reads
// files lazily (never on connect, list, get or approve), and enforces the checks named in CHECKS (see README "Host checks: enforced and not enforced").
// It returns structured findings; it never executes anything and has no code path that runs a skill file (requestScriptRun only answers allowed / denied).
// Nothing is cached on disk: the only state is in memory, and every verification read bypasses the SDK client's response cache.
//
// `disable` turns individual checks off; it exists ONLY so tests can prove they fail when a check is removed (mutation tests).
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ListSkillsResultSchema, GetSkillResultSchema, ReadResourceDirectoryResultSchema, RESOURCES_DIRECTORY_READ_METHOD, SKILLS_EXTENSION_ID, SKILLS_LIST_METHOD, SKILLS_GET_METHOD, SKILL_LIMITS } from '@modelcontextprotocol/core/ext/skills';
import { isLoopbackHost } from '../safety.js';
import { FINDINGS, CHECKS } from './findings.js';
import { checkSkillMdWithSdk } from './sdkFrontmatter.js';
import { outsideRootReason, fileKey, canonicalUri } from './uri.js';

export { outsideRootReason };
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const MAX_PAGES = 20;
const AGENT_SKILLS_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const INJECTION = /(ignore (all |any )?(previous|prior|above) (instructions|rules)|disregard (the )?(system|previous)|you are now|exfiltrate|curl [^\n|]*\|\s*(ba)?sh|rm -rf|base64 -d|send (the )?(contents|secrets|keys?) to)/i;

/** The resources set an approval binds to: every uri, digest and size, order-independent. null for "dynamic" (it cannot be content-bound). */
export function resourcesHash(resources) {
  if (resources === 'dynamic' || !Array.isArray(resources)) return null;
  const rows = resources.map((r) => `${r.uri}\u0000${r.digest}\u0000${r.size}`).sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

const skillRoot = (skillMdUri) => skillMdUri.replace(/SKILL\.md$/, '');

export class HostVerifier {
  constructor({ fetch: fetchImpl = globalThis.fetch, disable = [], policy = {}, onWire } = {}) {
    for (const d of disable) if (!CHECKS.includes(d)) throw new Error(`unknown check: ${d}`);
    this.disabled = new Set(disable);
    this.fetch = fetchImpl;
    this.onWire = onWire; // optional: called with each request/response pair (rule 14: raw wire shown)
    this.traceId = randomBytes(16).toString('hex');
    this.policy = { allowDynamic: false, ...policy };
    this.servers = new Map();   // serverId -> { client, url, era, directoryRead }
    this.skills = new Map();    // registry key -> record
    this.approvals = new Map(); // approval key -> { scripts, allowedTools, hash }
    this.findings = [];
    this.stats = { requests: 0, reads: 0, lists: 0, gets: 0, refreshes: 0 };
    this.executed = []; // always empty: the verifier has no execution path
    this.activated = new Set(); // set ONLY by activate(): reading SKILL.md with readFile() does not activate a skill
  }

  on(check) { return !this.disabled.has(check); }

  note(id, serverId, skillUri, detail = '') {
    const key = `${id}|${serverId}|${skillUri}|${detail}`;
    if (this.findings.some((f) => f.key === key)) return;
    const meta = FINDINGS[id];
    this.findings.push({ key, id, kind: meta.kind, must: meta.must, serverId, skillUri, detail });
  }
  has(id) { return this.findings.some((f) => f.id === id); }

  // ---- connection -------------------------------------------------------------------------------------------------------------------------
  /** serverId is the host-assigned label (never serverInfo.name). era: "modern" (server/discover, 2026-07-28) or "legacy" (initialize, 2025). */
  async connect(serverId, url, { era = 'modern' } = {}) {
    const u = new URL(url);
    if (!isLoopbackHost(u.hostname)) throw new Error(`refusing ${u.hostname}: the verifier only talks to loopback endpoints`);
    // Every hop carries a W3C traceparent (rule 14); when onWire is set the request and response are handed to it, bodies bounded.
    const counting = async (input, init = {}) => {
      this.stats.requests += 1;
      const headers = new Headers(init.headers);
      headers.set('traceparent', `00-${this.traceId}-${randomBytes(8).toString('hex')}-01`);
      const t0 = Date.now();
      const res = await this.fetch(input, { ...init, headers });
      if (this.onWire) {
        const post = (init.method ?? 'POST') === 'POST';
        const body = post ? await res.clone().text().catch(() => '') : '';
        this.onWire({ serverId, method: init.method ?? 'POST', url: String(input.url ?? input), requestHeaders: Object.fromEntries([...headers].filter(([k]) => k !== 'content-length')), requestBody: typeof init.body === 'string' ? init.body : '', status: res.status, responseType: res.headers.get('content-type') ?? '', responseBody: body, ms: Date.now() - t0 });
      }
      return res;
    };
    const client = new Client({ name: 'mcp-skills-lab-verifier', version: '0.1.0' }, era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {});
    await client.connect(new StreamableHTTPClientTransport(u, { fetch: counting }));
    const caps = client.getServerCapabilities() ?? {};
    const ext = caps.extensions?.[SKILLS_EXTENSION_ID];
    const info = { client, url, era, negotiated: client.getNegotiatedProtocolVersion?.() ?? null, declared: ext !== undefined, directoryRead: ext?.directoryRead === true, hasResources: caps.resources !== undefined };
    // The spec: a server declaring the skills extension MUST also declare resources. Without it the host does not call skills methods.
    info.usable = !(info.declared && !info.hasResources && this.on('resources-cap'));
    if (!info.usable) this.note('resources-capability-missing', serverId, '', 'the server declared the skills extension but not the resources capability');
    this.servers.set(serverId, info);
    return { serverId, era, negotiated: info.negotiated, declared: info.declared, directoryRead: info.directoryRead, hasResources: info.hasResources, usable: info.usable };
  }
  async close() { for (const s of this.servers.values()) await s.client.close().catch(() => {}); this.servers.clear(); }

  server(serverId) { const s = this.servers.get(serverId); if (!s) throw new Error(`not connected: ${serverId}`); return s; }

  // ---- listing ----------------------------------------------------------------------------------------------------------------------------
  /** Walks the pages of skills/list (at most MAX_PAGES; a listing that goes on longer is reported). Reads no file. */
  async listSkills(serverId) {
    const s = this.server(serverId);
    if (!s.declared) return { skills: [], pages: 0, note: 'the server did not declare the skills extension' };
    if (!s.usable) return { skills: [], pages: 0, note: 'the server declared the skills extension without the resources capability: skills methods are not called' };
    const out = []; let cursor; let pages = 0; let first;
    do {
      const res = await s.client.request({ method: SKILLS_LIST_METHOD, params: cursor ? { cursor } : {} }, ListSkillsResultSchema.omit({ ttlMs: true, cacheScope: true }));
      this.stats.lists += 1; pages += 1; first ??= res;
      for (const entry of res.skills) out.push(this.ingest(serverId, entry, true));
      cursor = res.nextCursor;
    } while (cursor && pages < MAX_PAGES);
    const truncated = Boolean(cursor);
    if (truncated) this.note('list-truncated', serverId, '', `stopped after ${pages} pages while the server still returned a nextCursor`);
    return { skills: out, pages, truncated, ttlMs: first?.ttlMs, cacheScope: first?.cacheScope };
  }

  /** One skill by SKILL.md URI, listed or not. Retrieves no file. */
  async getSkill(serverId, uri) {
    const s = this.server(serverId);
    if (!s.usable) throw new Error('the server declared the skills extension without the resources capability: skills/get is not called');
    this.stats.gets += 1;
    const res = await s.client.request({ method: SKILLS_GET_METHOD, params: { uri } }, GetSkillResultSchema.omit({ ttlMs: true, cacheScope: true }));
    const known = [...this.skills.values()].find((r) => r.serverId === serverId && r.uri === res.skill.uri);
    return { record: this.ingest(serverId, res.skill, known?.listed ?? false), ttlMs: res.ttlMs, cacheScope: res.cacheScope };
  }

  keyOf(serverId, uri, name) { return this.on('collision') ? `${serverId}|${uri}` : name; }

  /** Validates one manifest entry against the checks and stores it. Never throws on a hostile entry: it records why the skill is refused. */
  ingest(serverId, entry, listed) {
    const reasons = [];
    const uri = entry.uri;
    const name = entry.frontmatter?.name;
    const root = skillRoot(uri);
    const hash = resourcesHash(entry.resources);
    const dynamic = entry.resources === 'dynamic';
    const refuse = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };

    // Always on: the entry must be a SKILL.md URI and `resources` an array or "dynamic" (the SDK client's schema already guarantees the second).
    if (!/\/SKILL\.md$/.test(uri)) { this.note('invalid-entry', serverId, uri, 'entry uri does not end in /SKILL.md'); refuse('invalid-entry'); }

    // The last path segment of the skill path must equal frontmatter name.
    if (this.on('name-path')) {
      const last = root.replace(/\/$/, '').split('/').pop();
      if (last !== name) { this.note('name-path-mismatch', serverId, uri, `path segment "${last}" vs name "${name}"`); refuse('name-path-mismatch'); }
    }

    if (dynamic) {
      if (this.on('dynamic') && !this.policy.allowDynamic) { this.note('dynamic-declined', serverId, uri, 'resources: "dynamic"'); refuse('dynamic-declined'); }
    } else {
      const rs = entry.resources;
      if (this.on('limits')) {
        if (rs.length > SKILL_LIMITS.files) { this.note('limit-files', serverId, uri, `${rs.length} entries > ${SKILL_LIMITS.files}`); refuse('limit-files'); }
        const total = rs.reduce((n, r) => n + (Number.isFinite(r.size) ? r.size : 0), 0);
        if (total > SKILL_LIMITS.bytes) { this.note('limit-bytes', serverId, uri, `${total} bytes > ${SKILL_LIMITS.bytes}`); refuse('limit-bytes'); }
      }
      if (this.on('uri-scope')) {
        for (const r of rs.slice(0, 2000)) {
          if (canonicalUri(r.uri) === canonicalUri(uri)) continue; // SKILL.md itself
          const why = outsideRootReason(root, r.uri);
          if (why) { this.note('uri-outside-root', serverId, uri, `${String(r.uri).slice(0, 120)}: ${why}`); refuse('uri-outside-root'); }
        }
      }
      if (this.on('manifest-self')) {
        const keys = rs.slice(0, 2000).map((r) => fileKey(root, r.uri) ?? r.uri);
        if (!keys.includes(fileKey(root, uri) ?? uri)) { this.note('manifest-missing-skill-md', serverId, uri, 'the resources array does not list SKILL.md'); refuse('manifest-missing-skill-md'); }
        const dup = keys.find((k, i) => keys.indexOf(k) !== i);
        if (dup !== undefined) { this.note('manifest-duplicate', serverId, uri, `${dup} is listed more than once`); refuse('manifest-duplicate'); }
      }
    }

    // Approval bound to the resources set: when the set changed since the last time we saw this skill, drop the approvals that named the old set.
    const previous = [...this.skills.values()].find((r) => r.serverId === serverId && r.uri === uri);
    if (previous && previous.hash !== hash) this.revokeChanged(serverId, uri, previous.hash, hash);

    if (!listed && this.on('unlisted-flag')) this.note('unlisted-skill', serverId, uri, 'found through skills/get only');

    const key = this.keyOf(serverId, uri, name);
    const record = { key, serverId, uri, name, entry, hash, listed, dynamic, reasons, loadable: reasons.length === 0, label: name };
    this.skills.set(key, record);
    this.relabel(name);
    return record;
  }

  /** Same name from more than one origin or path: surface it, give each its own disambiguated label, never merge. */
  relabel(name) {
    const same = [...this.skills.values()].filter((r) => r.name === name);
    if (same.length < 2) { for (const r of same) r.label = name; return; }
    const servers = new Set(same.map((r) => r.serverId));
    for (const r of same) r.label = servers.size > 1 ? `${r.serverId}:${r.uri.replace(/^[^:]+:\/\//, '').replace(/\/SKILL\.md$/, '')}` : r.uri.replace(/^[^:]+:\/\//, '').replace(/\/SKILL\.md$/, '');
    if (this.on('collision')) this.note('name-collision', same.map((r) => r.serverId).join('+'), same.map((r) => r.uri).join(' | '), `"${name}" is served ${same.length} times`);
  }

  revokeChanged(serverId, uri, oldHash, newHash) {
    if (this.on('approval-binding')) {
      const k = `${serverId}|${uri}|${oldHash}`;
      if (this.approvals.delete(k)) this.note('approval-revoked', serverId, uri, `resources set changed (${String(oldHash).slice(0, 8)} -> ${String(newHash).slice(0, 8)}); approval revoked, re-prompt`);
    }
  }

  // ---- reading ----------------------------------------------------------------------------------------------------------------------------
  recordFor(serverId, uri) {
    const r = [...this.skills.values()].find((x) => x.serverId === serverId && x.uri === uri);
    if (!r) throw new Error(`unknown skill ${uri} on ${serverId}: list or get it first`);
    return r;
  }

  /** Size and digest problems of fetched bytes against a manifest row (an empty array means they match). */
  verifyBytes(listed, bytes) {
    const problems = [];
    if (this.on('size') && bytes.byteLength !== listed.size) problems.push(['size-mismatch', `${bytes.byteLength} bytes, manifest ${listed.size}`]);
    if (this.on('digest') && sha256(bytes) !== listed.digest) problems.push(['digest-mismatch', 'digest differs from the manifest']);
    return problems;
  }

  /**
   * Reads one file of a skill, lazily, and verifies it. ref: path relative to the skill root, or an absolute URI. A file that fails size or digest
   * makes the host refetch the entry once (skills/get) in case the listing was stale; if the entry is unchanged the failure stands.
   */
  async readFile(serverId, skillUri, ref = 'SKILL.md', { retried = false } = {}) {
    const rec = this.recordFor(serverId, skillUri);
    const root = skillRoot(rec.uri);
    const target = /^[a-z][a-z0-9+.-]*:/i.test(ref) ? ref : root + ref;
    const result = { ok: false, uri: target, serverId, origin: serverId, untrusted: true, problems: [], verified: false };
    if (!rec.loadable) { result.problems.push(`skill is refused (${rec.reasons.join(', ')})`); return result; }

    const isSelf = fileKey(root, target) === fileKey(root, rec.uri);
    // A dynamic skill the host chose to load has no manifest: size and digest cannot be checked, the frontmatter still is. Reads stay inside the root.
    const listed = rec.dynamic ? undefined : rec.entry.resources.find((r) => fileKey(root, r.uri) === fileKey(root, target));
    if (rec.dynamic ? (!isSelf && outsideRootReason(root, target) !== null) : (!listed && this.on('manifest-only'))) {
      this.note('unlisted-file-read', serverId, skillUri, target); result.problems.push('unlisted-file-read'); return result;
    }
    const requestUri = listed ? listed.uri : target;
    result.verified = Boolean(listed);

    const s = this.server(serverId);
    this.stats.reads += 1;
    const read = await s.client.readResource({ uri: requestUri }, { cacheMode: 'refresh' });
    const c = read.contents.find((x) => fileKey(root, x.uri) === fileKey(root, requestUri));
    if (!c) { result.problems.push('no contents returned for the requested uri'); return result; }
    const bytes = 'text' in c ? new TextEncoder().encode(c.text) : Uint8Array.from(Buffer.from(c.blob, 'base64'));

    const bad = listed ? this.verifyBytes(listed, bytes) : [];
    if (bad.length && !retried) {
      // The listing may be stale (or a cache served old bytes): refetch the entry once and, if the manifest really changed, verify against the new one.
      this.stats.refreshes += 1;
      const before = rec.hash;
      const fresh = (await this.getSkill(serverId, rec.uri)).record;
      if (fresh.hash !== before && fresh.loadable) {
        this.note('entry-refreshed', serverId, skillUri, `${target}: manifest changed on refetch, verifying against the new entry`);
        return this.readFile(serverId, skillUri, ref, { retried: true });
      }
    }
    for (const [id, detail] of bad) { this.note(id, serverId, skillUri, `${target}: ${detail}`); result.problems.push(id); }

    if (isSelf && result.problems.length === 0) {
      if (this.on('frontmatter')) {
        const check = await checkSkillMdWithSdk(rec.entry, c, bytes);
        if (check.ok) { result.frontmatter = check.frontmatter; result.body = check.body; }
        else if (check.kind === 'mismatch') { this.note('frontmatter-mismatch', serverId, skillUri, check.differences.join('; ')); result.problems.push('frontmatter-mismatch'); }
        else { this.note('frontmatter-unreadable', serverId, skillUri, check.message); result.problems.push('frontmatter-unreadable'); }
      } else {
        result.frontmatter = rec.entry.frontmatter;
      }
    }
    // A SKILL.md that is only a supporting file of this skill is data: its frontmatter is never read, never acted on.
    if (!isSelf && /\/SKILL\.md$/.test(fileKey(root, target) ?? target) && this.on('nested')) {
      result.nested = true;
      this.note('nested-skill', serverId, skillUri, `${target} is a supporting file; its frontmatter is not acted on`);
    }
    if (result.problems.length === 0) {
      result.ok = true; result.bytes = bytes; result.text = 'text' in c ? c.text : undefined;
      result.tagged = `<skill-content origin="${serverId}" uri="${target}" trust="untrusted">\n${result.text ?? '(binary)'}\n</skill-content>`;
      if (result.text !== undefined && INJECTION.test(result.text)) this.note('injection-markers', serverId, skillUri, `${target}: instruction-like text`);
    }
    return result;
  }

  /** Reading SKILL.md is not activation; this is the host's skill-loading path. Reads only SKILL.md. */
  async activate(serverId, skillUri) {
    const rec = this.recordFor(serverId, skillUri);
    const out = { loaded: false, serverId, uri: skillUri, name: rec.name, label: rec.label, listed: rec.listed, reasons: [...rec.reasons], requested: {}, grants: { allowedTools: [], scripts: false, hooks: false } };
    // readFile refuses a skill that is not loadable (and says why), so activate needs no second check of its own.
    const file = await this.readFile(serverId, skillUri);
    if (!file.ok) { if (!rec.loadable) return out; out.reasons.push(...file.problems); return out; }
    this.note('untrusted-content', serverId, skillUri, 'tagged with origin before it enters context');
    out.loaded = true; this.activated.add(`${serverId}|${skillUri}`); out.content = file.tagged; out.frontmatter = file.frontmatter;
    const fm = file.frontmatter;
    const tools = fm['allowed-tools'];
    out.requested.allowedTools = tools === undefined ? [] : Array.isArray(tools) ? tools.map(String) : String(tools).split(/\s+/).filter(Boolean);
    out.requested.hooks = fm.hooks !== undefined;
    out.requested.scripts = Array.isArray(rec.entry.resources) ? rec.entry.resources.map((r) => r.uri.slice(skillRoot(rec.uri).length)).filter((p) => /^scripts\//.test(p)) : [];
    const extra = Object.keys(fm).filter((k) => !AGENT_SKILLS_FIELDS.has(k) && k !== 'hooks');
    if (extra.length) this.note('extra-frontmatter-ignored', serverId, skillUri, extra.join(', '));
    const ap = this.approvalFor(serverId, skillUri);
    // allowed-tools and hooks: ignored for MCP-origin skills unless the user approved that grant for this exact resources set.
    if (this.on('allowed-tools')) {
      if (out.requested.allowedTools.length && !ap?.allowedTools) this.note('allowed-tools-ignored', serverId, skillUri, out.requested.allowedTools.join(' ').slice(0, 160));
      if (out.requested.hooks && !ap?.allowedTools) this.note('hooks-ignored', serverId, skillUri, 'frontmatter declares hooks');
      out.grants.allowedTools = ap?.allowedTools ? out.requested.allowedTools : [];
      out.grants.hooks = Boolean(ap?.allowedTools && out.requested.hooks);
    } else {
      out.grants.allowedTools = out.requested.allowedTools; out.grants.hooks = out.requested.hooks;
    }
    out.grants.scripts = Boolean(ap?.scripts);
    return out;
  }

  /** A SKILL.md that is a supporting file of `parentUri`. Never a skill by itself: it needs its own fresh, explicit consent. */
  activateNested(serverId, parentUri, ref, { consent = false } = {}) {
    this.recordFor(serverId, parentUri);
    const eligible = consent === true;
    if (this.on('nested') && !eligible) { this.note('nested-activation-denied', serverId, parentUri, ref); return { loaded: false, eligible: false, reason: 'a nested skill needs fresh explicit consent; approval of the enclosing skill does not cover it' }; }
    return { loaded: false, eligible: true, reason: 'consent given: the nested skill would go through its own listing, verification and approval (not activated here)' };
  }

  // ---- directory reads --------------------------------------------------------------------------------------------------------------------
  /** resources/directory/read: only when the server declared directoryRead. Children are NOT added to the held manifest; unlisted file children are flagged. */
  async readDirectory(serverId, uri, skillUri) {
    const s = this.server(serverId);
    if (!s.usable) throw new Error('the server declared the skills extension without the resources capability: directory reads are not called');
    if (!s.directoryRead) throw new Error('the server did not declare directoryRead: resources/directory/read must not be called');
    const out = []; let cursor; let pages = 0;
    do {
      const res = await s.client.request({ method: RESOURCES_DIRECTORY_READ_METHOD, params: cursor ? { uri, cursor } : { uri } }, ReadResourceDirectoryResultSchema.omit({ ttlMs: true, cacheScope: true }));
      pages += 1; out.push(...res.resources); cursor = res.nextCursor;
    } while (cursor && pages < MAX_PAGES);
    const rec = skillUri ? this.recordFor(serverId, skillUri) : undefined;
    const root = rec ? skillRoot(rec.uri) : undefined;
    const resources = out.map((r) => {
      const isDir = r.mimeType === 'inode/directory';
      const inManifest = !isDir && rec && Array.isArray(rec.entry.resources) ? rec.entry.resources.some((x) => fileKey(root, x.uri) === fileKey(root, r.uri)) : null;
      if (inManifest === false) this.note('directory-unlisted-child', serverId, skillUri, r.uri);
      return { ...r, inManifest };
    });
    return { resources, pages, truncated: Boolean(cursor) };
  }

  // ---- approvals --------------------------------------------------------------------------------------------------------------------------
  approvalKey(serverId, uri, hash) { return this.on('approval-binding') ? `${serverId}|${uri}|${hash}` : `${serverId}|${uri}|*`; }
  /** The user approves script execution and/or allowed-tools for this skill, bound to its current resources set. Dynamic skills cannot be bound. Retrieves nothing. */
  approve(serverId, skillUri, { scripts = false, allowedTools = false } = {}) {
    const rec = this.recordFor(serverId, skillUri);
    if (rec.dynamic && this.on('dynamic')) { this.note('dynamic-not-bindable', serverId, skillUri, 'a dynamic skill has no resources set to bind an approval to'); return { approved: false, reason: 'dynamic skills cannot be content-bound' }; }
    if (!rec.loadable) return { approved: false, reason: `skill is refused (${rec.reasons.join(', ')})` };
    this.approvals.set(this.approvalKey(serverId, skillUri, rec.hash), { scripts, allowedTools, hash: rec.hash });
    return { approved: true, hash: rec.hash };
  }
  approvalFor(serverId, skillUri) {
    const rec = this.recordFor(serverId, skillUri);
    return this.approvals.get(this.approvalKey(serverId, skillUri, rec.hash)) ?? null;
  }
  /** Would the host run this script? Answers allowed or denied; the verifier itself never executes anything. Needs a script approval, not just an allowed-tools one. */
  requestScriptRun(serverId, skillUri, ref) {
    const ap = this.on('exec-gate') ? this.approvalFor(serverId, skillUri) : { scripts: true };
    const allowed = Boolean(ap?.scripts);
    if (!allowed) this.note('script-exec-denied', serverId, skillUri, ref);
    return { allowed, reason: allowed ? 'approved for this resources set' : 'no per-skill approval for script execution' };
  }

  /** A skill on one server asks to read a resource that belongs to another server. */
  followReference(fromServerId, skillUri, toServerId, uri, { approvedBy } = {}) {
    if (fromServerId === toServerId) return { allowed: true, reason: 'same origin' };
    const approved = approvedBy && approvedBy.from === fromServerId && approvedBy.to === toServerId;
    if (this.on('cross-server') && !approved) { this.note('cross-server-denied', `${fromServerId}->${toServerId}`, skillUri, uri); return { allowed: false, reason: 'cross-server reads need explicit per-call approval naming both servers' }; }
    return { allowed: true, reason: approved ? `approved for ${fromServerId} -> ${toServerId}` : 'cross-server check disabled' };
  }

  registry() { return [...this.skills.values()].map(({ key, serverId, uri, name, label, listed, loadable, reasons, dynamic }) => ({ key, serverId, uri, name, label, listed, loadable, reasons, dynamic })); }
}
