// The talk track is DATA. The Talk track section in the page, the presenter-mode notes and docs/talk-track.md (npm run talk-track) are all
// rendered from it, and a test fails when the committed doc drifts. `for` names the tabs a note goes with in presenter mode.
// Claims are about the MCP Skills extension (SEP-2640, revision 2026-07-28) as read in the specification page summary, or about what this lab does.
import { HOSTILE_CASES } from './hostile/cases.js';
import { MEASURED, TABS } from './spec.js';

export const TALK_TRACK = [
  { id: 'what-is-simulated', title: 'What is simulated, and what is not verified', for: ['overview'], say: `The extension is new and the SDK's exported constants still list only 2025 revisions, so nothing here is verified against a vendor gateway. The skills are synthetic (Mock) or read from a folder you mounted (Real), and the hostile servers are honest servers with one documented lie. Nothing is executed or fetched. ${MEASURED}` },
  { id: 'what-a-skill-is', title: 'What a skill is', for: ['overview', 'skills'], say: 'A folder with a SKILL.md and optional files, exposed over MCP resources at skill:// URIs. The server lists each skill with a manifest: every file\'s URI, size and SHA-256 digest. Open a skill in the Skills tab and read its manifest.' },
  { id: 'reading-is-not-activating', title: 'Reading is not activating, and nothing is prefetched', for: ['skills'], say: 'Connect and list: the retrieval counter stays at 0, on the host side and on the wire. Only a click on a file reads it. Reading SKILL.md is not activation either: activation is the host\'s own step, after the checks.' },
  { id: 'digest-not-trust', title: 'A digest match is not trust', for: ['verifier'], say: 'The digests come from the same server that serves the files and are unsigned. They catch corruption and swaps, not a malicious server. Run all the hostile cases: each one names the check that catches it and whether the rule is a MUST, a SHOULD or lab policy.' },
  { id: 'raw-wire', title: 'Click a case to see the raw wire', for: ['verifier'], say: 'Every verdict has the exact JSON-RPC requests and responses behind it, with a traceparent on each request. The hostile server is an honest SDK server with one lie added on the wire; the response shown is the lie.' },
  { id: 'approvals-bound', title: 'Approvals are bound to the set of files', for: ['approvals'], say: 'Approve the skill, then scripts and allowed-tools separately. Then change the manifest: the approval is dropped at once. Change it back: the approval is still gone. It was dropped when the manifest changed and was never restored, and the user has not approved again. "Script run allowed" on that page is a gate decision only: the lab never executes anything.' },
  { id: 'untrusted-text', title: 'Skill text is untrusted input', for: ['skills', 'verifier'], say: 'A skill can say anything, including "ignore previous instructions". The host tags accepted content with the server it came from. A real host would refuse to run a script without a per-skill approval; this lab only answers allowed or denied and never executes anything.' },
  { id: 'sources', title: 'Mock, Real, and the mount', for: ['source'], say: 'The Mock/Real toggle is in the header of every page. Real reads the folder in SKILLS_DIR, mounted read-only; the page lists what was refused and why (symlinks, over the limits, a name that differs from the folder). Nothing from that folder is copied into this repository.' },
  { id: 'flow', title: 'The whole flow on one diagram', for: ['diagram'], say: 'Connect, list, get, read when needed, verify, approve, revoke on change, load into context tagged untrusted. Drag the boxes, press Simulate, change the speed, press Reset to put the boxes back.' },
];

const TAB_TITLE = { overview: 'Overview', skills: 'Skills', verifier: 'Verifier', approvals: 'Approvals', source: 'Source', diagram: 'Diagram' };

export function renderTalkTrackMarkdown() {
  const lines = ['# Talk track', '', '<!-- Generated from server/src/talkTrack.js by `npm run talk-track`. Do not edit by hand. -->', '',
    '> MCP Skills extension (SEP-2640, revision 2026-07-28). Simulated: the skills are synthetic or read from a folder you mounted, and the hostile servers are honest servers with one documented lie. UNVERIFIED against any shipping host.', '',
    `Presenter mode: press P (or the Presenter button); Esc leaves. The banner stays on every tab. ${HOSTILE_CASES.length} hostile cases, tabs: ${TABS.map((t) => TAB_TITLE[t]).join(', ')}.`, ''];
  for (const t of TALK_TRACK) lines.push(`## ${t.title}`, '', t.say, '', `Tabs: ${t.for.map((x) => TAB_TITLE[x]).join(', ')}.`, '');
  return `${lines.join('\n').trimEnd()}\n`;
}
