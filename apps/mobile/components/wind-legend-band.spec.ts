import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatWindLegendLabel, windLegendBand } from './wind-legend-band';

test('legend converts speeds and preserves inequality markers without changing bands', () => {
  assert.equal(formatWindLegendLabel('20.8', 'kn'), '40.4');
  assert.equal(formatWindLegendLabel('>32.6', 'kn'), '>63.4');
  assert.equal(formatWindLegendLabel('<5.4', 'kn'), '<10.5');
  assert.equal(windLegendBand(26.24), 2);
});

test('wind legend selects exactly one band and clears missing data', () => {
  for (const value of [null, undefined, NaN, Infinity, -1]) assert.equal(windLegendBand(value), -1);
  const edges = [32.6, 28.5, 24.5, 20.8, 17.2, 13.9, 10.8, 8, 5.5];
  edges.forEach((edge, index) => {
    assert.equal(windLegendBand(edge), index);
    assert.equal(windLegendBand(edge - .001), index + 1);
  });
  assert.equal(windLegendBand(0), 9);
  assert.equal(windLegendBand(4.03), 9);
  assert.equal(windLegendBand(50), 0);
});
