# Talk track

<!-- Generated from server/src/talkTrack.js by `npm run talk-track`. Do not edit by hand. -->

> MCP Skills extension (SEP-2640, revision 2026-07-28). Simulated: the skills are synthetic or read from a folder you mounted, and the hostile servers are honest servers with one documented lie. UNVERIFIED against any shipping host.

Presenter mode: press P (or the Presenter button); Esc leaves. The banner stays on every tab. 23 hostile cases, tabs: Overview, Skills, Verifier, Approvals, Source, Diagram.

## What is simulated, and what is not verified

The extension is new and the SDK's exported constants still list only 2025 revisions, so nothing here is verified against a vendor gateway. The skills are synthetic (Mock) or read from a folder you mounted (Real), and the hostile servers are honest servers with one documented lie. Nothing is executed or fetched. MEASURED 2026-11-09 on the hosted Privilege gateway (privilege-aigw v1.261106): its aggregate endpoint answered server/discover, skills/list, skills/get and resources/directory/read with JSON-RPC -32601 unknown method, so it does not carry the Skills extension there. A non-aggregate endpoint (hostile-mcp) passed skills/list through to its backend, which answered Method not found (-32601). This lab itself was not reached through the gateway: a temporary endpoint for it was denied (403) because no grant matched the caller, the same answer an unknown endpoint gets.

Tabs: Overview.

## What a skill is

A folder with a SKILL.md and optional files, exposed over MCP resources at skill:// URIs. The server lists each skill with a manifest: every file's URI, size and SHA-256 digest. Open a skill in the Skills tab and read its manifest.

Tabs: Overview, Skills.

## Reading is not activating, and nothing is prefetched

Connect and list: the retrieval counter stays at 0, on the host side and on the wire. Only a click on a file reads it. Reading SKILL.md is not activation either: activation is the host's own step, after the checks.

Tabs: Skills.

## A digest match is not trust

The digests come from the same server that serves the files and are unsigned. They catch corruption and swaps, not a malicious server. Run all the hostile cases: each one names the check that catches it and whether the rule is a MUST, a SHOULD or lab policy.

Tabs: Verifier.

## Click a case to see the raw wire

Every verdict has the exact JSON-RPC requests and responses behind it, with a traceparent on each request. The hostile server is an honest SDK server with one lie added on the wire; the response shown is the lie.

Tabs: Verifier.

## Approvals are bound to the set of files

Approve the skill, then scripts and allowed-tools separately. Then change the manifest: the approval is dropped at once. Change it back: the approval is still gone. It was dropped when the manifest changed and was never restored, and the user has not approved again. "Script run allowed" on that page is a gate decision only: the lab never executes anything.

Tabs: Approvals.

## Skill text is untrusted input

A skill can say anything, including "ignore previous instructions". The host tags accepted content with the server it came from. A real host would refuse to run a script without a per-skill approval; this lab only answers allowed or denied and never executes anything.

Tabs: Skills, Verifier.

## Mock, Real, and the mount

The Mock/Real toggle is in the header of every page. Real reads the folder in SKILLS_DIR, mounted read-only; the page lists what was refused and why (symlinks, over the limits, a name that differs from the folder). Nothing from that folder is copied into this repository.

Tabs: Source.

## The whole flow on one diagram

Connect, list, get, read when needed, verify, approve, revoke on change, load into context tagged untrusted. Drag the boxes, press Simulate, change the speed, press Reset to put the boxes back.

Tabs: Diagram.
