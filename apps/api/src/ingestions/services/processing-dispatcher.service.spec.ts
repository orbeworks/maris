import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ProcessingJob } from '../types/ingestion.types.js';
import { ProcessingDispatcherService } from './processing-dispatcher.service.js';

const JOB: ProcessingJob = {
  archivePath: 'ingestions/ingestion-id/source.zip',
  ingestionId: 'ingestion-id',
  versionId: 'version-id',
  versionKey: 'soundg-version-id',
};

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Local processing test timed out');
    await delay(5);
  }
}

test('processes directly, rejects concurrent ingestion, and removes the source', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const calls: string[] = [];
  const dispatcher = new ProcessingDispatcherService(
    { listRecoverableJobs: async () => [] } as never,
    {
      removeSource: async (job: ProcessingJob) => {
        calls.push(`remove:${job.ingestionId}`);
      },
      run: async (job: ProcessingJob, propagateFailure: boolean) => {
        assert.equal(propagateFailure, true);
        calls.push(`run:${job.ingestionId}`);
        await gate;
      },
    } as never,
    { recoverOrphans: async () => undefined } as never,
    new ConfigService({ ENC_PROCESSING_ENABLED: true }),
  );

  await dispatcher.onApplicationBootstrap();
  dispatcher.reserve();
  dispatcher.dispatch(JOB);
  assert.throws(() => dispatcher.reserve(), ServiceUnavailableException);
  finish();
  await until(() => calls.includes(`remove:${JOB.ingestionId}`));
  dispatcher.reserve();
  dispatcher.releaseReservation();
  assert.deepEqual(calls, [
    `run:${JOB.ingestionId}`,
    `remove:${JOB.ingestionId}`,
  ]);
});

test('resumes a recoverable PostgreSQL job', async () => {
  const calls: string[] = [];
  let firstLookup = true;
  const dispatcher = new ProcessingDispatcherService(
    {
      listRecoverableJobs: async () => {
        if (!firstLookup) return [];
        firstLookup = false;
        return [JOB];
      },
    } as never,
    {
      removeSource: async () => { calls.push('remove'); },
      run: async () => { calls.push('run'); },
    } as never,
    { recoverOrphans: async () => { calls.push('cleanup'); } } as never,
    new ConfigService({ ENC_PROCESSING_ENABLED: true }),
  );

  await dispatcher.onApplicationBootstrap();
  await until(() => calls.includes('remove'));
  assert.deepEqual(calls, ['cleanup', 'run', 'remove']);
});

test('production mode rejects ingestion when processing is disabled', async () => {
  const dispatcher = new ProcessingDispatcherService(
    {} as never,
    {} as never,
    {} as never,
    new ConfigService({ ENC_PROCESSING_ENABLED: false }),
  );

  await dispatcher.onApplicationBootstrap();
  assert.throws(() => dispatcher.reserve(), ServiceUnavailableException);
});
