import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GFS_MAX_WEATHER_ZOOM,
  tileBounds,
  tileContainsCoordinate,
  tileForCoordinate,
  tileKey,
  tilesForViewport,
} from './gfs-tiles';
import { fieldDimensionsForTiles, sourceZoomForMapZoom, sourceZoomForViewport } from './gfs-zoom';

test('maps coordinates to deterministic Web Mercator XYZ tiles', () => {
  assert.deepEqual(tileForCoordinate(-43.2, -22.9, 0), { z: 0, x: 0, y: 0 });
  const tile = tileForCoordinate(-43.2, -22.9, 6);
  assert.equal(tile.z, 6);
  const bounds = tileBounds(tile);
  assert.ok(bounds.west <= -43.2 && bounds.east >= -43.2);
  assert.ok(bounds.south <= -22.9 && bounds.north >= -22.9);
  assert.deepEqual(tileForCoordinate(180, 90, 6), { z: 6, x: 0, y: 0 });
});

test('adds one tile of margin and handles the antimeridian', () => {
  const tiles = tilesForViewport({ west: 179, east: -179, south: -1, north: 1 }, 2);
  assert.ok(tiles.some((tile) => tile.x === 3));
  assert.ok(tiles.some((tile) => tile.x === 0));
  assert.ok(tiles.some((tile) => tile.x === 2));
  assert.ok(tiles.some((tile) => tile.x === 1));
  assert.ok(tiles.every((tile) => tile.z === 2 && tile.y >= 0 && tile.y < 4));
});

test('clamps polar viewports to the global tile range', () => {
  const tiles = tilesForViewport({ west: -180, east: 180, south: -90, north: 90 }, 1);
  assert.equal(new Set(tiles.map((tile) => tile.x)).size, 2);
  assert.equal(new Set(tiles.map((tile) => tile.y)).size, 2);
  assert.equal(tiles.length, 4);
});

test('the pyramid has 1, 4, ..., 4096 tiles by level', () => {
  for (let z = 0; z <= GFS_MAX_WEATHER_ZOOM; z += 1) {
    const tiles = tilesForViewport({ west: -180, east: 180, south: -90, north: 90 }, z, 0);
    assert.equal(tiles.length, 2 ** (2 * z));
  }
});

test('validates zoom, coordinates and viewport margin', () => {
  for (const z of [-1, 6.5, 7, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => tileForCoordinate(0, 0, z), /Invalid GFS weather zoom/);
    assert.throws(() => tilesForViewport({ west: -1, east: 1, south: -1, north: 1 }, z), /Invalid GFS weather zoom/);
  }
  assert.throws(() => tileForCoordinate(Number.NaN, 0, 0), /Invalid GFS coordinate/);
  assert.throws(() => tileForCoordinate(0, Number.POSITIVE_INFINITY, 0), /Invalid GFS coordinate/);
  assert.throws(() => tilesForViewport({ west: -1, east: 1, south: -1, north: 1 }, 0, -1), /Invalid GFS viewport margin/);
  assert.throws(() => tilesForViewport({ west: -1, east: 1, south: -1, north: 1 }, 0, 0.5), /Invalid GFS viewport margin/);
  assert.deepEqual(tilesForViewport({ west: 1, east: -1, south: 1, north: -1 }, 0), []);
});

test('wraps longitudes while keeping x in range', () => {
  for (const longitude of [-180, 180, 181, -181, 540, -540]) {
    const tile = tileForCoordinate(longitude, 0, 6);
    assert.equal(tile.z, 6);
    assert.ok(tile.x >= 0 && tile.x < 64);
  }
  assert.equal(tileForCoordinate(-180, 0, 3).x, tileForCoordinate(180, 0, 3).x);
});

test('clamps latitudes to the Web Mercator limit', () => {
  assert.equal(tileForCoordinate(0, 90, 6).y, 0);
  assert.equal(tileForCoordinate(0, 85.05112878, 6).y, 0);
  assert.equal(tileForCoordinate(0, 85, 6).y, 0);
  assert.equal(tileForCoordinate(0, -85, 6).y, 63);
  assert.equal(tileForCoordinate(0, -85.05112878, 6).y, 63);
  assert.equal(tileForCoordinate(0, -90, 6).y, 63);
});

test('east=180 and exact tile boundaries do not add an extra tile without margin', () => {
  assert.deepEqual(tilesForViewport({ west: -180, east: 180, south: -90, north: 90 }, 1, 0), [
    { z: 1, x: 0, y: 0 }, { z: 1, x: 1, y: 0 },
    { z: 1, x: 0, y: 1 }, { z: 1, x: 1, y: 1 },
  ]);
  const boundary = tileBounds({ z: 3, x: 2, y: 3 });
  const next = tileBounds({ z: 3, x: 3, y: 3 });
  const tiles = tilesForViewport({ west: boundary.west, east: next.west, south: next.south, north: boundary.north }, 3, 0);
  assert.deepEqual(tiles, [{ z: 3, x: 2, y: 3 }]);
});

test('antimeridian viewports include both sides without duplicate keys', () => {
  const tiles = tilesForViewport({ west: 170, east: -170, south: -10, north: 10 }, 3, 0);
  assert.ok(tiles.some((tile) => tile.x === 0));
  assert.ok(tiles.some((tile) => tile.x === 7));
  assert.equal(new Set(tiles.map((tile) => tileKey(tile, 0))).size, tiles.length);
});

test('tile bounds round-trip through their center at z0, z1, z3 and z6', () => {
  for (const z of [0, 1, 3, 6]) {
    for (const tile of [{ z, x: 0, y: 0 }, { z, x: 2 ** z - 1, y: 2 ** z - 1 }]) {
      const bounds = tileBounds(tile);
      const center = [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2] as const;
      assert.deepEqual(tileForCoordinate(center[0], center[1], z), tile);
    }
  }
});

test('tileContainsCoordinate includes edges and rejects points outside', () => {
  const grid = { bounds: { west: -10, east: 10, south: -5, north: 5 } } as never;
  assert.equal(tileContainsCoordinate(grid, [0, 0]), true);
  assert.equal(tileContainsCoordinate(grid, [-10, 5]), true);
  assert.equal(tileContainsCoordinate(grid, [10, -5]), true);
  assert.equal(tileContainsCoordinate(grid, [10.0001, 0]), false);
  assert.equal(tileContainsCoordinate(grid, [0, -5.0001]), false);
});

test('source zoom follows the old rounded and clamped weather zoom', () => {
  assert.equal(sourceZoomForMapZoom(0.49), 0);
  assert.equal(sourceZoomForMapZoom(0.5), 1);
  assert.equal(sourceZoomForMapZoom(5.49), 5);
  assert.equal(sourceZoomForMapZoom(5.5), 6);
  assert.equal(sourceZoomForMapZoom(16), 6);
  assert.equal(sourceZoomForMapZoom(10, 1), 5);
});

test('field size fallback lowers source zoom for a world viewport', () => {
  const selected = sourceZoomForViewport(
    { west: -180, east: 180, south: -85, north: 85 },
    16,
  );
  assert.equal(selected.sourceZoom, 1);
  assert.ok(fieldDimensionsForTiles(selected.tiles).width <= 2048);
});
