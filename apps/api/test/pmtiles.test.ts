import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { LocalChartStorageService } from '../src/tiles/storage/local-chart-storage.service.js';
import { TilesController } from '../src/tiles/tiles.controller.js';
import { TilesService } from '../src/tiles/tiles.service.js';
import type { ChartCatalogService } from '../src/ingestions/services/chart-catalog.service.js';
import { ChartSelection, CHART_SELECTION_POLICY, type CoverageCell } from '../src/charts/models/chart-selection.js';

let decodedTileNumber = 0;
async function decodedFeatures(
  bytes: Buffer | undefined,
  directory: string,
  z: number,
  x: number,
  y: number,
) {
  if (!bytes) return [];
  const tile = path.join(directory, `decoded-${decodedTileNumber++}.pbf`);
  await writeFile(tile, bytes);
  const { stdout } = await promisify(execFile)('ogr2ogr', [
    '-f', 'GeoJSON', '/vsistdout/', tile,
    '-oo', `Z=${z}`, '-oo', `X=${x}`, '-oo', `Y=${y}`,
  ]);
  const collection = JSON.parse(stdout) as GeoJSON.FeatureCollection;
  return collection.features.map((feature) => {
    const coordinates = feature.geometry.type === 'Point'
      ? feature.geometry.coordinates.map((value) => Number(value.toFixed(6)))
      : feature.geometry.coordinates;
    return { coordinates, properties: feature.properties };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function assertEquivalentMvt(
  actual: Buffer | undefined,
  expected: Buffer | undefined,
  directory: string,
  z: number,
  x: number,
  y: number,
) {
  assert.deepEqual(
    await decodedFeatures(actual, directory, z, x, y),
    await decodedFeatures(expected, directory, z, x, y),
  );
}

test('streaming PMTiles generation preserves MVT contents and publishes only archive + manifest', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-pmtiles-'));
  try {
    const source = { type: 'FeatureCollection' as const, features: [
      { type: 'Feature' as const, properties: { DEPTH: 21, SOURCE_CELL: 'test' }, geometry: { type: 'Point' as const, coordinates: [-80.15, 25.7] } },
      ...Array.from({ length: 40 }, (_, i) => ({
        type: 'Feature' as const, properties: { DEPTH: i, SOURCE_CELL: 'adjacent' },
        geometry: { type: 'Point' as const, coordinates: [-80.18 + i * 0.003, 25.68 + i * 0.002] },
      })),
    ] };
    const input = path.join(directory, 'source.json');
    await writeFile(input, JSON.stringify(source));
    const builder = fileURLToPath(new URL('../scripts/build-soundg-tiles.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const args = [tsx, builder, '--input', input, '--storage-dir', directory, '--version', 'v1'];
    await promisify(execFile)(process.execPath, args);
    const versionPath = path.join(directory, 'soundg/versions/v1');
    assert.deepEqual((await readdir(versionPath)).sort(), ['manifest.json', 'tiles.pmtiles']);
    const storage = new LocalChartStorageService(new ConfigService({ CHART_STORAGE_DIR: directory }));
    const manifest = await storage.getManifest('soundg', 'v1');
    assert.equal(manifest.storageFormat, 'pmtiles');
    const index = geojsonvt(source, { buffer: 64, extent: 4096, indexMaxZoom: 12, maxZoom: 16, tolerance: 3 });
    const expected = Buffer.from(vtpbf.fromGeojsonVt({ soundings: index.getTile(14, 4544, 6981)! }));
    await assertEquivalentMvt(await storage.getTile('soundg', 'v1', 14, 4544, 6981), expected, directory, 14, 4544, 6981);
    // Compare every relevant tile at every zoom with the original index,
    // including buffered points and siblings revisited after subtree eviction.
    for (let z = 8; z <= 16; z++) {
      const n = 2 ** z;
      const x = (lng: number) => Math.floor((lng + 180) / 360 * n);
      const y = (lat: number) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
      for (let tx = x(-80.18) - 1; tx <= x(-80.063) + 1; tx++) {
        for (let ty = y(25.758) - 1; ty <= y(25.68) + 1; ty++) {
          const tile = index.getTile(z, tx, ty);
          const bytes = tile?.features.length ? Buffer.from(vtpbf.fromGeojsonVt({ soundings: tile })) : undefined;
          assert.equal(Boolean(await storage.getTile('soundg', 'v1', z, tx, ty)), Boolean(bytes), `${z}/${tx}/${ty}`);
        }
      }
    }
    assert.equal(await storage.getTile('soundg', 'v1', 14, 0, 0), undefined);
    await assert.rejects(storage.getTile('soundg', 'missing', 14, 0, 0));
    const module = await Test.createTestingModule({
      controllers: [TilesController],
      providers: [{ provide: TilesService, useValue: new TilesService(storage, {} as ChartCatalogService) }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/tiles/soundg/v1/14/4544/6981.pbf')
        .expect(200).expect('Cache-Control', 'public, max-age=30, must-revalidate')
        .expect('Content-Type', /application\/vnd.mapbox-vector-tile/);
      await request(app.getHttpServer()).get('/tiles/soundg/v1/14/0/0.pbf')
        .expect(204).expect('Cache-Control', 'public, max-age=30, must-revalidate');
      await request(app.getHttpServer()).get('/tiles/soundg/missing/14/0/0.pbf')
        .expect(404).expect('Cache-Control', 'no-store');
      await request(app.getHttpServer()).get('/tiles/soundg/v1/14/999999/0.pbf')
        .expect(400).expect('Cache-Control', 'no-store');
    } finally { await app.close(); }
    const original = await readFile(path.join(versionPath, 'tiles.pmtiles'));
    await assert.rejects(promisify(execFile)(process.execPath, args), /already exists/);
    assert.deepEqual(await readFile(path.join(versionPath, 'tiles.pmtiles')), original);
    assert.deepEqual(await readdir(path.join(directory, 'soundg/versions')), ['v1']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('streaming generation handles filtered GeoJSONSeq larger than the GDAL stdin seek limit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-pmtiles-large-stream-'));
  try {
    const input = path.join(directory, 'large.json');
    await writeFile(input, JSON.stringify({
      type: 'FeatureCollection',
      features: Array.from({ length: 10_000 }, (_, index) => ({
        type: 'Feature',
        properties: {
          DEPTH: index % 100,
          RCID: index,
          SOURCE_CELL: 'LARGE',
          SOURCE_EDITION: '1',
          SOURCE_UPDATE: 0,
        },
        geometry: {
          type: 'Point',
          coordinates: [-80 + (index % 100) * 0.0001, 25 + Math.floor(index / 100) * 0.0001],
        },
      })),
    }));
    const builder = fileURLToPath(new URL('../scripts/build-soundg-tiles.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    await promisify(execFile)(process.execPath, [
      tsx, builder, '--input', input, '--storage-dir', directory, '--version', 'large',
    ]);
    assert.deepEqual(
      (await readdir(path.join(directory, 'soundg/versions/large'))).sort(),
      ['manifest.json', 'tiles.pmtiles'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('composed MVT contains only the cell selected by the metadata API at each point', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-chart-composition-'));
  try {
    const polygon = (w: number, e: number) => ({ type: 'Polygon', coordinates: [[[w,25],[e,25],[e,26],[w,26],[w,25]]] });
    const cells: CoverageCell[] = [
      { name: 'coastal', edition: '1', updateNumber: 0, issueDate: null, updateApplicationDate: null, compilationScale: 80000, coverages: [{ category: 1, geometry: polygon(-81,-79) }] },
      { name: 'harbor', edition: '1', updateNumber: 0, issueDate: null, updateApplicationDate: null, compilationScale: 22000, coverages: [{ category: 1, geometry: polygon(-80.16,-80.14) }] },
    ];
    const selection = new ChartSelection(cells);
    const features = [['coastal',-80.15],['harbor',-80.15],['coastal',-80.17],['harbor',-80.17]].map(([name,lon]) => ({
      type: 'Feature' as const, properties: { DEPTH: 21, SOURCE_CELL: name }, geometry: { type: 'Point' as const, coordinates: [Number(lon),25.7] },
    }));
    await writeFile(path.join(directory,'source.json'),JSON.stringify({type:'FeatureCollection',features}));
    await writeFile(path.join(directory,'coverage.json'),JSON.stringify(cells));
    await promisify(execFile)(process.execPath,[
      fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs',import.meta.url)),
      fileURLToPath(new URL('../scripts/build-soundg-tiles.ts',import.meta.url)),
      '--input',path.join(directory,'source.json'),'--coverage',path.join(directory,'coverage.json'),'--storage-dir',directory,'--version','composed',
    ]);
    const manifest = JSON.parse(await readFile(path.join(directory,'soundg/versions/composed/manifest.json'),'utf8'));
    assert.equal(manifest.selectionPolicy,CHART_SELECTION_POLICY);
    assert.equal(manifest.sourceFeatureCount,2);
    const expectedFeatures = features.filter((f) => selection.at(f.geometry.coordinates as [number,number])?.name === f.properties.SOURCE_CELL);
    const expected = geojsonvt({type:'FeatureCollection',features:expectedFeatures},{buffer:64,extent:4096,indexMaxZoom:12,maxZoom:16,tolerance:3});
    const storage = new LocalChartStorageService(new ConfigService({CHART_STORAGE_DIR:directory}));
    await assertEquivalentMvt(
      await storage.getTile('soundg','composed',14,4544,6981),
      Buffer.from(vtpbf.fromGeojsonVt({soundings:expected.getTile(14,4544,6981)!})),
      directory,
      14,4544,6981,
    );
  } finally { await rm(directory,{recursive:true,force:true}); }
});
