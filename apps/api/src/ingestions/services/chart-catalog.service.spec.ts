import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataSource } from 'typeorm';
import { ChartCell } from '../entities/chart-cell.entity.js';
import { ChartCoverage } from '../entities/chart-coverage.entity.js';
import { ChartSurvey } from '../entities/chart-survey.entity.js';
import { ChartCatalogService } from './chart-catalog.service.js';

test('ready persistence batches cells and child entities independently in one transaction', async () => {
  const saves = new Map<unknown, unknown[]>();
  let transactions = 0;
  const query = {
    update() { return this; }, set() { return this; },
    where() { return this; }, async execute() {},
  };
  const database = {
    async transaction(callback: (manager: unknown) => Promise<void>) {
      transactions++;
      await callback({ getRepository: (entity: unknown) => ({
        async findOneByOrFail() { return { id: 'version' }; },
        async delete() {}, async update() {}, createQueryBuilder: () => query,
        async save(rows: unknown[], options: unknown) {
          assert.deepEqual(options, { chunk: 500, reload: false });
          saves.set(entity, rows);
        },
      }) });
    },
  } as unknown as DataSource;
  await new ChartCatalogService(database).markReady('ingestion', {
    bounds: [-81, 25, -80, 26], storagePath: 'version', manifestPath: 'version/manifest.json',
    cells: Array.from({ length: 700 }, (_, i) => ({
      name: `cell-${i}`, edition: '1', updateNumber: 0, updatesApplied: [],
      metadata: {
        source: 'NOAA',
        coverage: [{ type: 'Feature', geometry: null, properties: { CATCOV: 1 } }],
        metaObjects: { M_QUAL: [{ type: 'Feature', geometry: null, properties: { CATZOC: 3 } }] },
      },
    })),
  });
  assert.equal(transactions, 1);
  for (const entity of [ChartCell, ChartCoverage, ChartSurvey]) assert.equal(saves.get(entity)?.length, 700);
  for (const row of saves.get(ChartCell)! as Record<string, unknown>[]) {
    assert.equal('coverages' in row, false);
    assert.equal('surveys' in row, false);
  }
});
