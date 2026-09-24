import assert from 'node:assert/strict';
import { test } from 'node:test';

import { viewportTileCoverage } from '../map/viewport-tile-coverage';

test('viewportTileCoverage returns zero without loaded tiles', () => {
  const world = { north: 85, south: -85, west: -180, east: 180 };
  assert.equal(viewportTileCoverage(world, []), 0);
});

test('viewportTileCoverage returns full coverage for a complete z0 tile', () => {
  const world = { north: 85, south: -85, west: -180, east: 180 };
  assert.ok(Math.abs(viewportTileCoverage(world, [{ z: 0, x: 0, y: 0 }]) - 1) < 1e-6);
});

test('viewportTileCoverage counts a partial tile by visible area', () => {
  const bounds = { north: 85, south: -85, west: -180, east: 0 };
  assert.ok(Math.abs(viewportTileCoverage(bounds, [
    { z: 1, x: 0, y: 0 },
    { z: 1, x: 0, y: 1 },
  ]) - 1) < 1e-6);
});

test('viewportTileCoverage does not double count duplicate tiles', () => {
  const world = { north: 85, south: -85, west: -180, east: 180 };
  assert.ok(Math.abs(viewportTileCoverage(world, [
    { z: 0, x: 0, y: 0 },
    { z: 0, x: 0, y: 0 },
  ]) - 1) < 1e-6);
});

test('viewportTileCoverage handles a viewport crossing the antimeridian', () => {
  const bounds = { north: 85, south: -85, west: 170, east: -170 };
  assert.ok(Math.abs(viewportTileCoverage(bounds, [
    { z: 2, x: 3, y: 0 },
    { z: 2, x: 0, y: 0 },
    { z: 2, x: 3, y: 1 },
    { z: 2, x: 0, y: 1 },
    { z: 2, x: 3, y: 2 },
    { z: 2, x: 0, y: 2 },
    { z: 2, x: 3, y: 3 },
    { z: 2, x: 0, y: 3 },
  ]) - 1) < 1e-6);
});
