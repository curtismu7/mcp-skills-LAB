# MCP Skills LAB

A tester for the official MCP Skills extension, `io.modelcontextprotocol/skills` (SEP-2640, protocol revision 2026-07-28). It has three parts: a skills **server** (synthetic Mock skills, or Real skills read from a folder you mount), a **hostile catalog** of 23 named attacks (18 families) a correct host must catch, and a **host verifier**: a model host that connects with the SDK client, fetches files lazily and applies the named checks listed under "Host checks: enforced and not enforced" (it is a model of a careful host, not a complete implementation of the specification's Host requirements). Step 2 adds the web app: six tabs (Overview, Skills, Verifier, Approvals, Source, Diagram), a Mock / Real toggle in every page header, presenter mode, Reset and a ReactFlow diagram.

Tier: Tester
Repo: not created yet (needs owner approval; local git only)
Catalog: TBD

> **Simulated and UNVERIFIED.** The extension is new, the SDK's exported `SUPPORTED_PROTOCOL_VERSIONS` still lists only 2025 revisions (the 2026-07-28 path works anyway), and nothing here has been checked against a vendor gateway or a shipping host. The hostile servers are honest SDK servers with a documented lie added on the wire. No skill is ever executed. Nothing leaves the machine.

## What is simulated

- **Mock** mode: four synthetic skills written for this lab (`meeting-notes`, `release-checklist` with `references/`, `log-summarizer` with an inert `scripts/` file, `style-guide` with a nested folder). Digests and sizes come from the SDK's catalog builder.
- **Real** mode: skills read at runtime from `SKILLS_DIR` (read-only). Nothing from that folder is copied into this repo. Symlinks are never followed (a link that escapes the root is refused, so is a link that stays inside), skills over 512 files or 16 MiB are refused, a `SKILL.md` that is not UTF-8 or whose `name` differs from its folder is reported as a catalog problem and skipped.
- **Hostile** servers at `/mcp/hostile/<case-id>`: each is an honest server plus one documented lie. Scripts and prompt-injection text inside them are inert data.
- The **host verifier** is a model of what a careful host does. It never executes anything (no code path exists), and its approvals live in memory.

## What is verified (and what is not)

Read: the SEP-2640 specification page (`skills.mdx`) through a page summariser, not verbatim, so quotes are paraphrased; the 2.4.0 SDK type definitions and source for `@modelcontextprotocol/server`, `client` and `core`. Sources:

- https://modelcontextprotocol.io/extensions/skills/overview
- https://modelcontextprotocol.io/seps/2640-skills-extension.md
- https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx

Not verified: exact error codes for each hostile case on other servers, cursor semantics beyond "opaque, never split a skill" (the SDK's cursor is a base64 token and a bad cursor is `-32602` here), host behaviour of any shipping client. Hostile-case URI containment (`..`, absolute, other scheme, encoded) and the 512-file / 16 MiB refusal are **lab policy** layered on spec MUSTs, labelled as such in the catalog.

## The hostile catalog

Served at `POST /mcp/hostile/<id>` (both protocol eras). `GET /api/hostile` returns the same table as JSON, including the spec statement each case exercises and the expected host verdict.

| Id | Attack | Exercises | Expected host verdict |
|---|---|---|---|
| `a-digest-mismatch` | file bytes differ from the manifest digest (same length) | MUST verify SHA-256 | file rejected |
| `b-size-mismatch` | manifest size differs from the served bytes | MUST verify byte size | file rejected |
| `c-frontmatter-mismatch` | SKILL.md frontmatter differs from the entry's | MUST compare field by field | skill not loaded |
| `d-post-approval-swap` | manifest changes between two reads after approval | approval bound to the resources set | approval revoked |
| `e-allowed-tools-smuggling` | `allowed-tools` and a hook in frontmatter | MUST ignore unless approved | requested, not granted |
| `f-name-collision` | same `name` from two paths and two servers | MUST disambiguate and MUST NOT silently shadow (surfacing it is a SHOULD) | all kept, labels disambiguated, collision reported |
| `g-dynamic-skill` | `resources: "dynamic"` | MAY decline; approval cannot be content-bound | declined |
| `h1-dotdot-traversal` `h2-absolute-path` `h3-other-scheme` `h4-encoded-dotdot` `h5-encoded-backslash` | manifest URI leaves the skill root | reads only to URIs in the entry (lab policy: refuse the skill) | skill refused, nothing read |
| `i1-too-many-files` `i2-too-many-bytes` | 600 files / 16 MiB + 1 byte (generated, never stored) | SHOULD NOT exceed 512 files / 16 MiB (lab policy: decline) | declined at listing time |
| `j-prompt-injection` | injection text in SKILL.md and a script | untrusted content, origin tag, no execution without approval | tagged untrusted, script run denied |
| `k-unlisted-skill` | absent from `skills/list`, served by `skills/get` | list may be partial; loading by URI must work (flagging it is lab policy) | fetchable, flagged unlisted |
| `l-cross-server-reference` | SKILL.md points at another server's resource | cross-server read needs approval naming both servers | denied without it |
| `m-unlisted-file-read` | a file the manifest does not list | reads only to URIs in the entry | refused before any request |
| `n-name-path-mismatch` | path ends in `finance-helper`, name is `payroll` | last path segment MUST equal `name` | skill refused |
| `o-comment-in-block-scalar` | SKILL.md `description: \|` ends with a `# ...` line the entry omits (a look-alike YAML parser drops it as a comment) | compare frontmatter field by field, with the SDK's parser | skill not loaded |
| `p-missing-skill-md` | the manifest omits SKILL.md | an array MUST list every file, including SKILL.md | skill refused, nothing read |
| `q-nested-skill` | `references/helper/SKILL.md` asks for `allowed-tools` | a nested SKILL.md is a supporting file; activating it needs fresh consent | read as data, frontmatter not acted on, activation denied |
| `r-no-resources-capability` | declares the skills extension but not the resources capability | a server that declares the extension MUST also declare resources | the host calls no skills method on it |

## Host checks: enforced and not enforced

Enforced by the verifier (each is a named check that tests switch off to prove the case then fails): `digest`, `size`, `frontmatter` (the SDK's own parser and comparison, so the verifier cannot disagree with `SkillsClient`), `manifest-only` (reads only to URIs in the entry), `approval-binding` (approval bound to the resources set, also across A to B to A), `allowed-tools` (allowed-tools and hooks ignored unless approved; any other frontmatter field is never honoured), `collision`, `dynamic`, `uri-scope`, `limits`, `name-path`, `unlisted-flag`, `exec-gate`, `cross-server`, `manifest-self` (SKILL.md present once), `nested`, `resources-cap` (a server that declares the extension without the resources capability is not called). Also: origin tagging of accepted content, no prefetch (no file is read on connect, list, get or approve), a refetch of the entry (`skills/get`) when a file fails verification, a page budget on listings (reported as `list-truncated`), and directory-read children classified against the held manifest.

Not enforced or not modelled: signed or attested digests (the spec says a digest match is not a trust boundary and this lab agrees; it does not add trust); any persistent cache. **No cache is kept on disk**: the verifier holds entries in memory only and bypasses the SDK client's response cache for verification reads, so the cache rules (write-protect or re-verify on every access, exclude from filesystem-skill discovery, keep MCP-origin restrictions after restart) are not implemented and have nothing to apply to; a host that caches must implement them. Not modelled: removing a server's cached content, a user interface for approvals, listing entries that are nested under another listed skill (the spec keeps `skills/list` flat; this lab does not flag a server that breaks that), whether the spec names permission-widening frontmatter fields beyond `allowed-tools` and hooks (UNVERIFIED; the verifier honours none). Lab policy rather than spec text is labelled as such in the catalog and in `GET /api/spec`.

A verdict of **PASS** means the hostile case was correctly rejected or flagged. Each case names the host check that catches it; the mutation tests switch that check off and require the case to stop passing.

## The web app

Open http://127.0.0.1:7807/ . The banner (simulated, UNVERIFIED, plus the MEASURED gateway fact) is the first thing on every tab, presenter mode included.

- **Overview**: what the lab is, what it measured, where the claims come from, the talk track.
- **Skills**: connect to the catalog or to one hostile server, in either protocol era; list skills; read a manifest; open a file only when you click View. Two retrieval counters (the host's and `resources/read` counted on the wire) stay at 0 through connect, list and get. Raw wire with a `traceparent` on every request.
- **Verifier**: run all 23 hostile cases and the clean control in both eras. Each row carries the rule kind (MUST, SHOULD, MAY or lab) and the check that caught it; click a case for the attack, the rule, the findings and the raw request and response.
- **Approvals**: approve a skill, then scripts and allowed-tools separately; ask to run a script; swap the manifest (A, then B, then A) and watch the approval be revoked and stay revoked.
- **Source**: the Mock / Real status, `SKILLS_DIR`, the catalog problems list, and two read-only mount examples (`claudSkills/pingone` from a checkout of the other project, and your `~/.claude/skills`). Nothing is copied into this repository.
- **Diagram**: the discovery, read and verify flow as ReactFlow, loaded by name from diagram-studio/1 data (`server/diagrams/skills-flow.json`, validated by the studio's validator copy in `server/src/diagramStudioValidate.js`; the diagram is not registered in the diagram-studio repo). Movable boxes, Simulate, Previous / Next, speed, Reset (restores box positions).

The header toggle is the rule-19 Mock / Real control (`POST /api/mode`, exactly `{ "source": "mock" | "real" }`). "Hostile" is not a mode: it is a choice of target in the Skills tab (the hostile servers are separate endpoints), so a third value in `/api/mode` would break the rule's contract. The page never speaks MCP itself: a host verifier session per browser tab (`X-Workspace`) runs on the server and the page shows what it did. Skill text is rendered as text only.

## Run from a clone

```
npm ci
npm run build                  # the web app, into web/dist
npm start                      # http://127.0.0.1:7807  (Node 26)
curl -s http://127.0.0.1:7807/api/health
npm run e2e                    # Playwright against the running lab (see Tests)
```

Endpoints: `POST /mcp` (both eras from one endpoint), `POST /mcp/hostile/<id>` (and the support server `swap-aba`), `GET /api/health`, `GET /api/info`, `POST /api/mode`, `GET /api/catalog`, `GET /api/hostile`, `GET /api/spec`, `GET /api/diagram?name=`, `GET /api/talk-track`, `GET /api/shelf`, `POST /api/verify` (`wire: true` returns one run's raw wire), `POST /api/browse/{connect,list,get,file,dir,activate,approve,script}` and `GET /api/browse/{state,wire}`, `POST /api/reset`. Every POST to `/api/*` must be `application/json`.

Modern (2026-07-28) requests need the headers `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: <method>` and, for `resources/read`, `Mcp-Name: <uri>` (tools/call uses the tool name), plus the `_meta` envelope keys `io.modelcontextprotocol/protocolVersion`, `.../clientInfo`, `.../clientCapabilities`. A missing `Mcp-Method` or `Mcp-Name` is HTTP 400 with JSON-RPC `-32020`. Legacy (2025-11-25) works through a stateless `initialize`.

## Settings file

None. The lab reads no `.env` and holds no secret. Settings are plain environment variables: `PORT` (default 7807), `SKILLS_DIR` (Real mode), `SKILLS_LAB_BIND` (the container sets it), `LAB_ALLOWED_HOSTS` (extra Host names for the shared lab-proxy).

## Ports, and what to do if the port is taken

Port range for this app: 7807 (one port; the packed range is 7800-7999, so `PORT` may be any free port there).

```
lsof -iTCP:7807 -sTCP:LISTEN -n -P
PORT=<other port> npm start
```

## Mock and real modes

`GET /api/info` returns `source` and `realAvailable`. `POST /api/mode` takes exactly `{ "source": "mock" | "real" }` and switches without a restart; Real that is not configured answers `409` with the reason and leaves the mode alone. Default: Real if `SKILLS_DIR` is usable, else Mock. The visible toggle is in the header of every page; Real that is not configured is `aria-disabled` with a how-to tooltip.

## Health, doctor and reset

`GET /api/health` returns `demo-health/1`. `npm run doctor` runs the same checks plus every hostile case in both eras and a clean-catalog control, on a throwaway port. `npm run reset` (or `POST /api/reset`, or the Reset button) rebuilds the hostile servers, drops every browse session and re-scans `SKILLS_DIR`; the button also puts the diagram boxes and the verify results back.

## Docker

```
docker compose up --build -d        # OrbStack; published on 127.0.0.1:7807 only
```

For Real mode, mount your skills folder read-only (commented example in `docker-compose.yml`) and set `SKILLS_DIR`.

## Tests

`npm test` runs `node --test test/*.test.js` (server, API, hostile catalog, mutation and differential tests) and then the web component tests (vitest). Run it on the Air with `air-test` when you can. `npm run build && npm run e2e` drives a real Chromium (Playwright). It starts its own labs from the checkout on the committed fixtures in `test/fixtures/real-skills/` (a tiny `ok-skill`, a skill with a 64-character name, and one the Real mode refuses), a lab with `SKILLS_DIR` unset, and a test-only "mutant" lab (`test/support/mutant-server.mjs`, never in the image) so the page can be seen showing FAIL. It runs in CI (the `e2e` job). Against the container: `docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build -d`, then `BASE_URL=http://127.0.0.1:7807 npm run e2e`. It checks: the banner on every tab, the Mock / Real toggle, the no-prefetch counters, 22/22 PASS in both eras, the approval swap, Reset, no console errors, 375px without horizontal scroll (also with a 64-character skill name), dark and light, and the FAIL path (red FAIL cells, summary and control against the mutant lab). Set `SHOT_DIR` to save screenshots. `npm run content-pack` builds and validates the Learning Hub pack (`content-pack.json`, `demo-content-pack/1`, ajv against the schema copy in `docs/`; the pack uses the family placeholder catalog id D999, the shelf entry keeps TBD). `npm run check-ui` checks the vendored shared stylesheet against its pin and the canonical copy.

## Troubleshooting

- `refusing to start: port-range`: use a port in 7800-7999.
- Real mode says "no skills directory configured": set `SKILLS_DIR` to a folder of skill folders.
- A skill is missing in Real mode: `GET /api/catalog` lists the problems (symlink, over the limit, name differs from folder, not UTF-8).

## Ownership

Owner: curtismu7. Built to `STANDALONE-RULES.md`; Step 2 of 3 (core, web, integration).
