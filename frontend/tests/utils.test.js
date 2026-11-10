import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, errorMessage, prefLabel, inr } from '../src/utils.js';

test('formatDuration', () => {
  assert.equal(formatDuration(185), '3h 05m');
  assert.equal(formatDuration(42), '42m');
});
test('errorMessage prefers the server message', () => {
  assert.equal(errorMessage({ response: { data: { error: { message: 'Nope' } } } }), 'Nope');
  assert.match(errorMessage({ request: {} }), /Cannot reach the server/);
});
test('labels and currency', () => {
  assert.equal(prefLabel('LOW_TRAFFIC'), 'Low Traffic');
  assert.equal(inr(420), '₹420');
});

import { PREFERENCES, roadLine, sceneryLine, weightsText, bandText, pct, osmWayUrl, overpassText } from '../src/utils.js';

test('the two new preferences are offered and the old four are kept', () => {
  const values = PREFERENCES.map((p) => p.value);
  assert.deepEqual(values.slice(0, 4), ['FASTEST', 'CHEAPEST', 'LOW_TRAFFIC', 'BALANCED']);
  assert.ok(values.includes('BETTER_ROADS') && values.includes('BETTER_SCENERY'));
  assert.equal(prefLabel('BETTER_ROADS'), 'Better Road Conditions');
  assert.equal(prefLabel('BETTER_SCENERY'), 'Better Scenery');
});

test('roadLine: unavailable data is stated, never turned into a score', () => {
  assert.equal(roadLine(undefined), null);
  assert.deepEqual(roadLine({ available: false, reason: 'no tags' }), { ok: false, headline: 'Road quality data unavailable', detail: 'no tags' });
  const l = roadLine({ available: true, score: 65, coverage: 0.87, pavedShare: 0.87, unpavedShare: 0, unknownShare: 0.13 });
  assert.equal(l.headline, 'Road data score 65/100');
  assert.match(l.detail, /documented for 87% of the route/);
  assert.match(l.detail, /13% unknown/);
});

test('sceneryLine: unavailable vs. no POIs vs. POIs', () => {
  assert.equal(sceneryLine(null), null);
  assert.equal(sceneryLine({ available: false }).headline, 'Scenery information unavailable');
  assert.match(sceneryLine({ available: true, score: 0, totalPois: 0, pois: [] }).detail, /No nature-related POIs/);
  const l = sceneryLine({ available: true, score: 72, totalPois: 2, pois: [{ counted: true, name: 'Marina Beach' }, { counted: true, name: '', categoryLabel: 'viewpoint' }] });
  assert.equal(l.headline, 'Scenery score 72/100');
  assert.match(l.detail, /2 nature-related POIs near the route: Marina Beach, unnamed viewpoint/);
  assert.ok(!/official/i.test(l.detail));
});

test('sceneryLine: a score from partial data is labelled incomplete, never presented as complete', () => {
  const full = sceneryLine({ available: true, score: 60, totalPois: 1, pois: [{ counted: true, name: 'A' }], incomplete: false, coverage: 1 });
  assert.equal(full.incomplete, false);
  assert.ok(!/incomplete/.test(full.detail));
  const part = sceneryLine({ available: true, score: 60, totalPois: 1, pois: [{ counted: true, name: 'A' }], incomplete: true, coverage: 0.86 });
  assert.equal(part.incomplete, true);
  assert.match(part.detail, /data incomplete: only 86% of the route could be checked/);
  assert.equal(part.headline, 'Scenery score 60/100');
});

test('weightsText lists only weighted factors; helpers format percentages and distance bands', () => {
  assert.equal(weightsText({ time: 0.25, traffic: 0.15, cost: 0.1, road: 0, scenery: 0.5 }), 'time 25% · traffic 15% · cost 10% · scenery 50%');
  assert.equal(weightsText({ time: 0.55, traffic: 0.3, cost: 0.15 }), 'time 55% · traffic 30% · cost 15%'); // results saved before the new factors existed
  assert.equal(pct(0.874), '87%');
  assert.equal(bandText('near'), 'within 300 m');
  assert.equal(bandText('ring', { nearM: 300, maxM: 1500 }), 'within 1.5 km');
  assert.equal(osmWayUrl(222), 'https://www.openstreetmap.org/way/222');
});

// Same shapes as the backend's diagnostics.overpass.* (services/scenery.js, services/roadQuality.js, planner.js).
test('overpassText: all corridor segments retrieved -> ok/total, not flagged incomplete', () => {
  const text = overpassText({ provider: 'Overpass', requested: true, cached: false, ms: 18200, categories: ['park'], tiles: 9, segments: 9, segmentsFailed: 0, candidates: 41 });
  assert.match(text, /9\/9 corridor segments/);
  assert.match(text, /41 candidates/);
  assert.match(text, /18200 ms/);
  assert.doesNotMatch(text, /incomplete|not completed/i);
  assert.doesNotMatch(text, /map tiles/); // the segment count replaces the old tile wording
});
test('overpassText: some segments failed -> the real ok/total count and an explicit INCOMPLETE label, never a plain success', () => {
  const note = 'incomplete: 2 of 9 corridor segments could not be retrieved (timeout, http); coverage Route A 78 %, Route B 80 %';
  const text = overpassText({ provider: 'Overpass', requested: true, cached: false, ms: 30000, tiles: 9, segments: 9, segmentsFailed: 2, candidates: 33, note });
  assert.match(text, /7\/9 corridor segments \(INCOMPLETE\)/);
  assert.doesNotMatch(text, /9\/9/);
  assert.ok(text.includes(note)); // the backend's reason and coverage are shown as well
});
test('overpassText: scenery unavailable -> "request not completed", never shown as a successful result', () => {
  const text = overpassText({ provider: 'Overpass', requested: false });
  assert.equal(text, 'Overpass · request not completed');
  assert.doesNotMatch(text, /corridor segments|candidates|ms|cached/);
});
test('overpassText: cached, road-tag and plain-text meta keep their wording', () => {
  assert.equal(overpassText({ provider: 'Overpass', requested: true, cached: true, segments: 3, segmentsFailed: 0, candidates: 5 }), 'Overpass (cached) · 3/3 corridor segments, 5 candidates');
  assert.equal(overpassText({ provider: 'Overpass', requested: true, cached: false, ms: 900, samples: 30 }), 'Overpass · 900 ms · 30 sample points');
  assert.match(overpassText({ provider: 'Overpass', requested: true, ms: 1, samples: 60, requests: 3, note: 'incomplete: 1 of 3 requests failed (timeout); the samples in them are counted as unknown' }), /incomplete: 1 of 3 requests failed/);
  assert.equal(overpassText('not requested'), 'not requested');
});
