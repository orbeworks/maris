import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { ProcessingCleanupService } from './processing-cleanup.service.js';

test('restart cleanup removes only temporary artifacts and preserves source ZIPs and published versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maris-cleanup-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const versions = path.join(root, 'charts/soundg/versions');
  const service = new ProcessingCleanupService(new ConfigService({ STORAGE_DIR: root, CHART_STORAGE_DIR: path.join(root, 'charts') }));
  try {
    for (const dir of [`.processing/${id}`, '.tmp', `ingestions/${id}`, 'charts/soundg/versions/published', 'charts/soundg/versions/.soundg-test.123.tmp']) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    await writeFile(path.join(root, '.tmp', `${id}.zip`), 'partial upload');
    await writeFile(path.join(root, 'ingestions', id, 'source.zip'), 'keep');
    await symlink(path.join(root, 'ingestions', id), path.join(root, '.processing', '22222222-2222-4222-8222-222222222222'));
    await service.recoverOrphans();
    assert.deepEqual(await readdir(versions), ['published']);
    assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
    assert.deepEqual(await readdir(path.join(root, 'ingestions', id)), ['source.zip']);
    assert.deepEqual(await readdir(path.join(root, '.processing')), ['22222222-2222-4222-8222-222222222222']);
    await service.recoverOrphans();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('job cleanup removes only its own unfinished tile version, including after a killed child', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maris-cleanup-'));
  const versions = path.join(root, 'soundg/versions');
  const service = new ProcessingCleanupService(new ConfigService({ STORAGE_DIR: root, CHART_STORAGE_DIR: root }));
  try {
    for (const name of ['.soundg-one.12.tmp', '.soundg-two.13.tmp', 'soundg-one']) await mkdir(path.join(versions, name), { recursive: true });
    await service.cleanVersion('soundg-one');
    assert.deepEqual((await readdir(versions)).sort(), ['.soundg-two.13.tmp', 'soundg-one']);
    await assert.rejects(service.cleanVersion('../'), /Invalid version/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
