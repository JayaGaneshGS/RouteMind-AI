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

import { PREFERENCES, roadLine, sceneryLine, weightsText, bandText, pct, osmWayUrl } from '../src/utils.js';

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

test('weightsText lists only weighted factors; helpers format percentages and distance bands', () => {
  assert.equal(weightsText({ time: 0.25, traffic: 0.15, cost: 0.1, road: 0, scenery: 0.5 }), 'time 25% · traffic 15% · cost 10% · scenery 50%');
  assert.equal(weightsText({ time: 0.55, traffic: 0.3, cost: 0.15 }), 'time 55% · traffic 30% · cost 15%'); // results saved before the new factors existed
  assert.equal(pct(0.874), '87%');
  assert.equal(bandText('near'), 'within 300 m');
  assert.equal(bandText('ring', { nearM: 300, maxM: 1500 }), 'within 1.5 km');
  assert.equal(osmWayUrl(222), 'https://www.openstreetmap.org/way/222');
});
