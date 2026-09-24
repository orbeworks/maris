import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GfsGrid } from './gfs-grid';
import { mergeGfsTiles } from './gfs-tile-merge';

const units: GfsGrid['units'] = {
  wind: 'm/s',
  temperature: 'K',
  precipitation: 'kg/m2',
  precipitationRate: 'kg/m2/s',
  cloudCover: '%',
  pressure: 'Pa',
  gust: 'm/s',
  humidity: '%',
};

function grid(windU: number[], bounds: GfsGrid['bounds']): GfsGrid {
  return {
    model: 'gfs',
    run: '2026-09-24T18:00:00Z',
    forecastTime: '2026-09-24T18:00:00Z',
    forecastHour: 0,
    resolution: 0.25,
    bounds,
    width: 2,
    height: 2,
    longitudeConvention: '-180..180',
    units,
    fields: { windU },
  };
}

test('merges northern XYZ tiles above southern tiles', () => {
  const merged = mergeGfsTiles([
    {
      tile: { z: 1, x: 0, y: 0 },
      grid: grid([10, 10, 15, 15], {
        west: -180,
        east: 0,
        north: 85.05112878,
        south: 0,
      }),
    },
    {
      tile: { z: 1, x: 0, y: 1 },
      grid: grid([15, 15, 20, 20], {
        west: -180,
        east: 0,
        north: 0,
        south: -85.05112878,
      }),
    },
  ]);

  assert.ok(merged);
  assert.equal(merged.width, 2);
  assert.equal(merged.height, 3);
  assert.deepEqual(merged.fields.windU, [10, 10, 15, 15, 20, 20]);
});
