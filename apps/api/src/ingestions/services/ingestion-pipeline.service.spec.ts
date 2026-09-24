import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ConfigService } from '@nestjs/config';

import type {
  ProcessingJob,
  ProcessingResult,
} from '../models/processing.js';
import { IngestionPipelineService } from './ingestion-pipeline.service.js';

const JOB: ProcessingJob = {
  archivePath: 'ingestions/id/source.zip',
  ingestionId: 'ingestion-id',
  versionId: 'version-id',
  versionKey: 'soundg-version-id',
};

const RESULT: ProcessingResult = {
  bounds: [-80.2, 25.6, -80.0, 25.9],
  cells: [
    {
      edition: '4',
      name: 'US5MIABC',
      updateNumber: 2,
      updatesApplied: [1, 2],
    },
  ],
  manifestPath: 'soundg/versions/version/manifest.json',
  storagePath: 'soundg/versions/version',
};

const config = {
  getOrThrow: () => '/chart-storage',
} as ConfigService;

test('run executes the complete processing pipeline in order', async () => {
  const calls: string[] = [];
  const pipeline = new IngestionPipelineService(
    config,
    {
      claimForProcessing: async () => { calls.push('claim'); return true; },
      findIngestion: async () => { calls.push('find'); return { status: 'received' }; },
      markProcessing: async () => { calls.push('processing'); },
      markReady: async (_id: string, result: ProcessingResult) => {
        calls.push('ready');
        assert.deepEqual(result, RESULT);
      },
      publishReadyVersion: async () => { calls.push('publish'); },
    } as never,
    {
      inspect: async (archivePath: string) => {
        calls.push('inspect');
        assert.equal(
          archivePath,
          path.resolve('/chart-storage', JOB.archivePath),
        );
      },
    } as never,
    { process: async () => { calls.push('process'); return RESULT; } } as never,
  );

  await pipeline.run(JOB);

  assert.deepEqual(calls, [
    'find',
    'claim',
    'inspect',
    'processing',
    'process',
    'ready',
    'publish',
  ]);
});

test('run publishes a recovered ready version without reprocessing it', async () => {
  const calls: string[] = [];
  const pipeline = new IngestionPipelineService(
    config,
    {
      findIngestion: async () => ({ status: 'ready' }),
      publishReadyVersion: async (versionId: string) => {
        calls.push(`publish:${versionId}`);
      },
    } as never,
    { inspect: async () => { calls.push('inspect'); } } as never,
    { process: async () => { calls.push('process'); } } as never,
  );

  await pipeline.run(JOB);

  assert.deepEqual(calls, [`publish:${JOB.versionId}`]);
});

test('run stops when another worker already claimed the ingestion', async () => {
  const calls: string[] = [];
  const pipeline = new IngestionPipelineService(
    config,
    {
      claimForProcessing: async () => false,
      findIngestion: async () => ({ status: 'received' }),
    } as never,
    { inspect: async () => { calls.push('inspect'); } } as never,
    { process: async () => { calls.push('process'); } } as never,
  );

  await pipeline.run(JOB);

  assert.deepEqual(calls, []);
});

test('run persists a processing failure without publishing it', async () => {
  const failure = new Error('GDAL failed');
  const calls: string[] = [];
  const pipeline = new IngestionPipelineService(
    config,
    {
      claimForProcessing: async () => true,
      findIngestion: async () => ({ status: 'received' }),
      markFailed: async (id: string, error: unknown) => {
        calls.push(`failed:${id}`);
        assert.equal(error, failure);
      },
      markProcessing: async () => { calls.push('processing'); },
      markReady: async () => { calls.push('ready'); },
      publishReadyVersion: async () => { calls.push('publish'); },
    } as never,
    { inspect: async () => undefined } as never,
    { process: async () => { throw failure; } } as never,
  );
  (pipeline as unknown as { logger: { error: () => void } }).logger.error =
    () => undefined;

  await pipeline.run(JOB);

  assert.deepEqual(calls, ['processing', `failed:${JOB.ingestionId}`]);
});

test('removeSource removes only the expected local ingestion directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-pipeline-unit-'));
  const sourceDirectory = path.join(directory, 'ingestions', JOB.ingestionId);
  const source = path.join(sourceDirectory, 'source.zip');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(source, 'temporary source');
  const pipeline = new IngestionPipelineService(
    { getOrThrow: () => directory } as ConfigService,
    {} as never,
    {} as never,
    {} as never,
  );

  try {
    await pipeline.removeSource({
      ...JOB,
      archivePath: `ingestions/${JOB.ingestionId}/source.zip`,
    });
    await assert.rejects(readFile(source), { code: 'ENOENT' });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('removeSource refuses an unexpected path', async () => {
  const pipeline = new IngestionPipelineService(
    { getOrThrow: () => '/chart-storage' } as ConfigService,
    {} as never,
    {} as never,
    {} as never,
  );

  await assert.rejects(
    pipeline.removeSource({ ...JOB, archivePath: '../source.zip' }),
    /Refusing to remove unexpected ENC source path/,
  );
});
