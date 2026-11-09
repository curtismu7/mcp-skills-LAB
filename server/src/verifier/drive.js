// Case drivers: the scripted host flow for each hostile case, and the verdict. PASS = the hostile case was correctly rejected or flagged.
// A driver returns facts (booleans / small values). The verdict is PASS only when every expected finding was raised AND every assertion holds.
import { HostVerifier } from './host.js';
import { HOSTILE_CASES, PEER_SERVERS, caseById } from '../hostile/cases.js';
import { FINDINGS, strictestKind } from './findings.js';

const SKILL = (id, name) => `skill://${name}/SKILL.md`;

async function open(v, serverId, url, era) { await v.connect(serverId, url, { era }); return v.listSkills(serverId); }

const DRIVERS = {
  async 'a-digest-mismatch'(v, url, era) {
    const { skills } = await open(v, 'srv', url, era);
    const lazy = v.stats.reads === 0;
    const act = await v.activate('srv', skills[0].uri);
    const t = await v.readFile('srv', skills[0].uri, 'references/TEMPLATE.md');
    return { lazy, skillMdAccepted: act.loaded, templateRejected: !t.ok };
  },
  async 'b-size-mismatch'(v, url, era) {
    const { skills } = await open(v, 'srv', url, era);
    const lazy = v.stats.reads === 0;
    const act = await v.activate('srv', skills[0].uri);
    const t = await v.readFile('srv', skills[0].uri, 'references/TEMPLATE.md');
    return { lazy, skillMdAccepted: act.loaded, templateRejected: !t.ok };
  },
  async 'c-frontmatter-mismatch'(v, url, era) {
    const { skills } = await open(v, 'srv', url, era);
    const act = await v.activate('srv', skills[0].uri);
    return { lazy: v.stats.reads === 1, skillNotLoaded: act.loaded === false };
  },
  async 'd-post-approval-swap'(v, url, era) {
    await open(v, 'srv', url, era);
    const uri = SKILL('', 'report-writer');
    await v.getSkill('srv', uri);                         // honest manifest
    const act = await v.activate('srv', uri);
    v.approve('srv', uri, { scripts: true, allowedTools: true });
    const approvedBefore = v.approvalFor('srv', uri) !== null;
    await v.getSkill('srv', uri);                         // the swapped manifest
    const approvedAfter = v.approvalFor('srv', uri) !== null;
    const script = v.requestScriptRun('srv', uri, 'scripts/anything.sh');
    return { loadedBefore: act.loaded, approvedBefore, approvalRevokedAfterSwap: approvedAfter === false, scriptDeniedAfterSwap: script.allowed === false };
  },
  async 'e-allowed-tools-smuggling'(v, url, era) {
    const { skills } = await open(v, 'srv', url, era);
    const act = await v.activate('srv', skills[0].uri);
    const noGrant = act.grants.allowedTools.length === 0 && act.grants.hooks === false;
    const asked = act.requested.allowedTools.length > 0 && act.requested.hooks === true;
    v.approve('srv', skills[0].uri, { allowedTools: true });
    const after = await v.activate('srv', skills[0].uri);
    return { loaded: act.loaded, requestedButNotGranted: asked && noGrant, grantedOnlyAfterApproval: after.grants.allowedTools.length > 0 };
  },
  async 'f-name-collision'(v, url, era) {
    await open(v, 'server-a', url, era);
    await open(v, 'server-b', url, era);
    const reg = v.registry().filter((r) => r.name === 'deploy');
    return { copiesKept: reg.length === 4, keysDistinct: new Set(reg.map((r) => r.key)).size === 4, labelsDistinct: new Set(reg.map((r) => r.label)).size === 4 };
  },
  async 'g-dynamic-skill'(v, url, era) {
    const { skills } = await open(v, 'srv', url, era);
    const act = await v.activate('srv', skills[0].uri);
    // A host that chooses to load dynamic skills still cannot bind an approval to them.
    const lax = new HostVerifier({ fetch: v.fetch, disable: [...v.disabled], policy: { allowDynamic: true } });
    await lax.connect('srv', url, { era });
    const l2 = await lax.listSkills('srv');
    const act2 = await lax.activate('srv', l2.skills[0].uri);
    const ap = lax.approve('srv', l2.skills[0].uri, { scripts: true });
    v.findings.push(...lax.findings.filter((f) => !v.findings.some((x) => x.key === f.key)));
    await lax.close();
    return { declinedByDefault: act.loaded === false, laxHostLoadsUnverified: act2.loaded === true, approvalCannotBind: ap.approved === false };
  },
  async 'j-prompt-injection'(v, url, era) {
    const { skills } = await open(v, 'srv', url, era);
    const act = await v.activate('srv', skills[0].uri);
    const script = await v.readFile('srv', skills[0].uri, 'scripts/setup.sh');
    const run = v.requestScriptRun('srv', skills[0].uri, 'scripts/setup.sh');
    return { loaded: act.loaded, taggedWithOrigin: /origin="srv"/.test(act.content ?? '') && /trust="untrusted"/.test(act.content ?? ''), scriptTagged: /trust="untrusted"/.test(script.tagged ?? ''), scriptRunDenied: run.allowed === false, nothingExecuted: v.executed.length === 0, markersFlagged: v.has('injection-markers') };
  },
  async 'k-unlisted-skill'(v, url, era) {
    const { skills } = await open(v, 'srv', url, era);
    const hiddenUri = SKILL('', 'hidden-helper');
    const notListed = !skills.some((s) => s.uri === hiddenUri);
    const got = await v.getSkill('srv', hiddenUri);
    const act = await v.activate('srv', hiddenUri);
    return { notInListing: notListed, fetchableByGet: got.record.uri === hiddenUri, flaggedUnlisted: got.record.listed === false, loadedWithSameChecks: act.loaded };
  },
  async 'l-cross-server-reference'(v, url, era, peerUrl) {
    const { skills } = await open(v, 'server-a', url, era);
    await open(v, 'server-b', peerUrl, era);
    await v.activate('server-a', skills[0].uri);
    const target = 'skill://partner-docs/references/GUIDE.md';
    const denied = v.followReference('server-a', skills[0].uri, 'server-b', target);
    const approved = v.followReference('server-a', skills[0].uri, 'server-b', target, { approvedBy: { from: 'server-a', to: 'server-b' } });
    const wrongPair = v.followReference('server-a', skills[0].uri, 'server-b', target, { approvedBy: { from: 'server-a', to: 'server-c' } });
    return { deniedWithoutApproval: denied.allowed === false, allowedWithApprovalNamingBoth: approved.allowed === true, approvalForOtherPairIgnored: wrongPair.allowed === false };
  },
  async 'm-unlisted-file-read'(v, url, era) {
    const { skills } = await open(v, 'srv', url, era);
    await v.activate('srv', skills[0].uri);
    const before = v.stats.reads;
    const r = await v.readFile('srv', skills[0].uri, 'references/private/NOTES.txt');
    return { refused: r.ok === false, noRequestMade: v.stats.reads === before };
  },
};
DRIVERS['o-comment-in-block-scalar'] = async (v, url, era) => {
  const { skills } = await open(v, 'srv', url, era);
  const act = await v.activate('srv', skills[0].uri);
  return { skillNotLoaded: act.loaded === false, onlySkillMdRead: v.stats.reads === 1 };
};
DRIVERS['p-missing-skill-md'] = async (v, url, era) => {
  const { skills } = await open(v, 'srv', url, era);
  const act = await v.activate('srv', skills[0].uri);
  return { skillRefused: act.loaded === false, nothingRead: v.stats.reads === 0 };
};
DRIVERS['q-nested-skill'] = async (v, url, era) => {
  const { skills } = await open(v, 'srv', url, era);
  const uri = skills[0].uri;
  v.approve('srv', uri, { allowedTools: true });
  const act = await v.activate('srv', uri);
  const nested = await v.readFile('srv', uri, 'references/helper/SKILL.md');
  const without = v.activateNested('srv', uri, 'references/helper/SKILL.md');
  const withConsent = v.activateNested('srv', uri, 'references/helper/SKILL.md', { consent: true });
  return {
    parentLoaded: act.loaded, nestedReadAsData: nested.ok === true && nested.nested === true, nestedFrontmatterNotActedOn: nested.frontmatter === undefined,
    nestedToolsNotGranted: act.grants.allowedTools.length === 0, deniedWithoutOwnConsent: without.eligible === false, eligibleOnlyWithConsent: withConsent.eligible === true,
  };
};
DRIVERS['r-no-resources-capability'] = async (v, url, era) => {
  const info = await v.connect('srv', url, { era });
  const l = await v.listSkills('srv');
  const refusedGet = await v.getSkill('srv', 'skill://report-writer/SKILL.md').then(() => false, () => true);
  return { declaredButNotUsable: info.declared === true && info.hasResources === false && info.usable === false, noSkillsListing: l.skills.length === 0, noSkillsRequests: v.stats.lists === 0 && v.stats.gets === 0, getRefused: refusedGet };
};
// The families that share a driver.
for (const id of ['h1-dotdot-traversal', 'h2-absolute-path', 'h3-other-scheme', 'h4-encoded-dotdot', 'h5-encoded-backslash']) {
  DRIVERS[id] = async (v, url, era) => {
    const { skills } = await open(v, 'srv', url, era);
    const act = await v.activate('srv', skills[0].uri);
    return { lazy: v.stats.reads === 0, skillRefused: act.loaded === false, noRequestForEscapingUri: v.stats.reads === 0 };
  };
}
for (const id of ['i1-too-many-files', 'i2-too-many-bytes']) {
  DRIVERS[id] = async (v, url, era) => {
    const { skills } = await open(v, 'srv', url, era);
    const act = await v.activate('srv', skills[0].uri);
    return { declinedAtListing: act.loaded === false, nothingRead: v.stats.reads === 0 };
  };
}
DRIVERS['n-name-path-mismatch'] = async (v, url, era) => {
  const { skills } = await open(v, 'srv', url, era);
  const act = await v.activate('srv', skills[0].uri);
  return { skillRefused: act.loaded === false, nothingRead: v.stats.reads === 0 };
};

/**
 * Runs one hostile case with a fresh host verifier.
 * opts: { fetch, base = 'http://127.0.0.1:7807', era = 'modern', disable = [] }. `fetch` may route in-process or over real HTTP.
 */
export async function runCase(id, { fetch = globalThis.fetch, base = 'http://127.0.0.1:7807', era = 'modern', disable = [], beforeCase, onWire } = {}) {
  const def = caseById(id);
  if (!def) throw new Error(`unknown hostile case: ${id}`);
  await beforeCase?.(id); // a fresh server state per run: the post-approval swap keeps a counter
  const v = new HostVerifier({ fetch, disable, onWire });
  let facts; let error = null;
  try {
    facts = await DRIVERS[id](v, `${base}/mcp/hostile/${id}`, era, def.peer ? `${base}/mcp/hostile/${def.peer}` : undefined);
  } catch (e) { error = String(e.message).slice(0, 240); facts = {}; }
  await v.close();
  const observed = [...new Set(v.findings.map((f) => f.id))];
  const missing = def.findings.filter((f) => !observed.includes(f));
  const failedAssertions = Object.entries(facts).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = !error && missing.length === 0 && failedAssertions.length === 0;
  return {
    caseId: id, letter: def.letter, title: def.title, era, verdict: pass ? 'PASS' : 'FAIL',
    kind: strictestKind(def.findings), check: def.guardedBy,
    checksFired: [...new Set(observed.map((f) => FINDINGS[f]?.check).filter(Boolean))],
    must: def.must, expected: def.expected, observed, missing, failedAssertions, facts, error,
    disabledChecks: [...disable], requests: v.stats.requests, reads: v.stats.reads,
    findings: v.findings.map(({ key, ...f }) => f),
  };
}

export async function runAllCases(opts = {}) {
  const results = [];
  for (const c of HOSTILE_CASES) results.push(await runCase(c.id, opts));
  return { era: opts.era ?? 'modern', total: results.length, passed: results.filter((r) => r.verdict === 'PASS').length, results };
}

/** Control: the same host against a CLEAN catalog (Mock or Real) must load every skill and verify every file with no findings beyond the information-level tag. */
export async function runControl({ fetch = globalThis.fetch, base = 'http://127.0.0.1:7807', path = '/mcp', era = 'modern', disable = [], onWire } = {}) {
  const v = new HostVerifier({ fetch, disable, onWire });
  const out = { verdict: 'FAIL', era, skills: [], error: null };
  try {
    const info = await v.connect('srv', `${base}${path}`, { era });
    const listing = await v.listSkills('srv');
    out.pages = listing.pages; out.ttlMs = listing.ttlMs ?? null; out.cacheScope = listing.cacheScope ?? null; out.directoryRead = info.directoryRead;
    out.readsAfterList = v.stats.reads;
    for (const rec of listing.skills) {
      const act = await v.activate('srv', rec.uri);
      const files = [];
      if (act.loaded && Array.isArray(rec.entry.resources)) for (const r of rec.entry.resources) { if (r.uri === rec.uri) continue; const f = await v.readFile('srv', rec.uri, r.uri); files.push({ uri: r.uri, ok: f.ok }); }
      out.skills.push({ uri: rec.uri, name: rec.name, loaded: act.loaded, files, filesVerified: files.every((f) => f.ok) });
    }
    const problems = v.findings.filter((f) => f.id !== 'untrusted-content' && f.id !== 'injection-markers');
    out.findings = problems.map(({ key, ...f }) => f);
    out.verdict = problems.length === 0 && listing.skills.length > 0 && out.skills.every((s) => s.loaded && s.filesVerified) && out.readsAfterList === 0 ? 'PASS' : 'FAIL';
  } catch (e) { out.error = String(e.message).slice(0, 240); }
  await v.close();
  return out;
}

export { PEER_SERVERS };
