import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import vtpbf from 'vt-pbf';

import { TilesService } from '../src/tiles/tiles.service.js';
import type { ChartStorage } from '../src/tiles/storage/chart-storage.js';
import type { ChartCatalogService } from '../src/ingestions/services/chart-catalog.service.js';
import { ObjectChartStorageService } from '../src/tiles/storage/object-chart-storage.service.js';
import type { ObjectStorageService } from '../src/storage/object-storage.service.js';

const require = createRequire(import.meta.url);
const vtpbfEntry = require.resolve('vt-pbf');
const { VectorTile } = require(require.resolve('@mapbox/vector-tile', {
  paths: [vtpbfEntry],
})) as { VectorTile: new (pbf: unknown) => { layers: Record<string, {
  length: number;
  feature(index: number): { properties: Record<string, unknown> };
}> } };
const Pbf = require(require.resolve('pbf', { paths: [vtpbfEntry] })) as new (
  bytes: Uint8Array,
) => unknown;

const coverage = {
  type: 'Polygon',
  coordinates: [[[-81, 24], [-78, 24], [-78, 27], [-81, 27], [-81, 24]]],
};

function encodedTile(name: string, depth: number) {
  return Buffer.from(vtpbf.fromGeojsonVt({
    soundings: {
      extent: 4096,
      features: [{
        geometry: [[2048, 2048]],
        tags: {
          DEPTH: depth,
          SOURCE_CELL: name,
          SOURCE_EDITION: '1',
          SOURCE_UPDATE: 0,
        },
        type: 1,
      }],
      length: 1,
      name: 'soundings',
    },
  } as never));
}

test('catalog tile composition keeps the most detailed cell across immutable shards', async () => {
  const tiles = new Map([
    ['coarse', encodedTile('COARSE', 10)],
    ['detail', encodedTile('DETAIL', 20)],
  ]);
  const storage = {
    async getTile(_dataset: string, version: string) { return tiles.get(version); },
  } as unknown as ChartStorage;
  const cells = [
    { name: 'COARSE', edition: '1', updateNumber: 0, compilationScale: 100_000,
      issueDate: null, updateApplicationDate: null, coverages: [{ category: 1, geometry: coverage }] },
    { name: 'DETAIL', edition: '1', updateNumber: 0, compilationScale: 10_000,
      issueDate: null, updateApplicationDate: null, coverages: [{ category: 1, geometry: coverage }] },
  ];
  const shards = [
    { shardKey: 'coarse', bounds: [-180, -85, 180, 85] },
    { shardKey: 'detail', bounds: [-180, -85, 180, 85] },
  ];
  const catalog = {
    async getPublishedCatalog(_dataset: string, revision?: number) {
      return { dataset: { key: 'soundg' }, revision: revision ?? 2, shards };
    },
    async getPublishedCells() { return cells; },
  } as unknown as ChartCatalogService;

  const service = new TilesService(storage, catalog);
  const output = await service.getTile('catalog-2', '8', '71', '109');
  assert.ok(output);
  const layer = new VectorTile(new Pbf(output)).layers.soundings;
  assert.equal(layer?.length, 1);
  assert.equal(layer?.feature(0).properties.SOURCE_CELL, 'DETAIL');

  const tilejson = await service.getTileJson('https://api.example');
  assert.equal(tilejson.version, 'catalog-2');
  assert.equal(
    tilejson.tiles[0],
    'https://api.example/tiles/soundg/{z}/{x}/{y}.pbf?empty=204-v2',
  );
  assert.ok(await service.getLatestTile('8', '71', '109'));
});

test('concurrent missing manifests normalize every shared S3 rejection and allow retry', async () => {
  let calls = 0;
  const objects = {
    async getText() {
      calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      throw Object.assign(new Error('missing'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    },
  } as unknown as ObjectStorageService;
  const storage = new ObjectChartStorageService(objects);
  const results = await Promise.allSettled([
    storage.getManifest('soundg', 'retired'),
    storage.getManifest('soundg', 'retired'),
    storage.getManifest('soundg', 'retired'),
  ]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) =>
    result.status === 'rejected' && result.reason instanceof NotFoundException
  ));
  await assert.rejects(
    storage.getManifest('soundg', 'retired'),
    NotFoundException,
  );
  assert.equal(calls, 2);
});
