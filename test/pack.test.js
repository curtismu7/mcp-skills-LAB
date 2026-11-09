import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPack } from '../scripts/build-content-pack.mjs';
import { validatePack } from '../scripts/validate-content-pack.mjs';
import { HOSTILE_CASES } from '../server/src/hostile/cases.js';
import { renderTalkTrackMarkdown, TALK_TRACK } from '../server/src/talkTrack.js';
import { TABS } from '../server/src/spec.js';

test('the content pack validates against the hub schema (ajv, strict)', () => assert.deepEqual(validatePack(buildPack()), []));

test('the committed content-pack.json is up to date with the hostile cases (run: npm run content-pack)', () => {
  const committed = JSON.parse(fs.readFileSync(new URL('../content-pack.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildPack())));
});

test('every hostile case has a story and a card; every card terms exist; a broken pack is caught', () => {
  const pack = buildPack();
  assert.equal(pack.stories.length, HOSTILE_CASES.length);
  for (const c of HOSTILE_CASES) assert.ok(pack.cards.some((x) => x.action.href === `/#/verifier?case=${c.id}`), c.id);
  const bad = buildPack(); bad.cards[0].terms = ['nope']; bad.cards[1].story = 'ghost';
  const errors = validatePack(bad).join('\n');
  assert.match(errors, /unknown term nope/); assert.match(errors, /unknown story ghost/);
  const wrongCatalog = buildPack(); wrongCatalog.demo.catalog = 'TBD';
  assert.ok(validatePack(wrongCatalog).length > 0, 'the schema insists on a catalog id pattern (a letter and digits)');
});

test('the pack and the shelf entry carry the same catalog id, D127', () => {
  assert.equal(buildPack().demo.catalog, 'D127');
  assert.equal(JSON.parse(fs.readFileSync(new URL('../docs/shelf-entry.json', import.meta.url), 'utf8')).demos[0].catalogId, 'D127');
});

test('docs/talk-track.md is exactly what the talk-track data renders (run: npm run talk-track)', () => {
  assert.equal(fs.readFileSync(new URL('../docs/talk-track.md', import.meta.url), 'utf8'), renderTalkTrackMarkdown());
});

test('every tab has a talk-track note, every note names tabs that exist, and the first note says UNVERIFIED and carries the MEASURED fact', () => {
  for (const t of TABS) assert.ok(TALK_TRACK.some((n) => n.for.includes(t)), `no note for ${t}`);
  for (const n of TALK_TRACK) for (const t of n.for) assert.ok(TABS.includes(t), `${n.id}: ${t}`);
  assert.match(TALK_TRACK[0].say, /verified against a vendor gateway/); assert.match(TALK_TRACK[0].say, /MEASURED 2026-11-09/);
  assert.equal(new Set(TALK_TRACK.map((n) => n.id)).size, TALK_TRACK.length);
});
