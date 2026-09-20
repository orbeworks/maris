import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { EncArchiveDto } from '../dtos/ingestion.dto.js';
import { IngestionsService } from './ingestions.service.js';

const ARCHIVE: EncArchiveDto = {
  catalogPresent: true,
  cellCount: 1,
  cells: [{ name: 'US5MIABC', updateNumbers: [1, 2] }],
  compressedBytes: 4,
  entryCount: 3,
  fileCount: 3,
  uncompressedBytes: 8,
};

function config(storageDirectory: string) {
  return {
    getOrThrow: (key: string) => {
      assert.equal(key, 'STORAGE_DIR');
      return storageDirectory;
    },
  } as ConfigService;
}

function upload(filePath: string, overrides: Partial<Express.Multer.File> = {}) {
  return {
    buffer: Buffer.alloc(0),
    destination: path.dirname(filePath),
    encoding: '7bit',
    fieldname: 'file',
    filename: path.basename(filePath),
    mimetype: 'application/zip',
    originalname: 'miami.zip',
    path: filePath,
    size: 8,
    stream: undefined as never,
    ...overrides,
  } satisfies Express.Multer.File;
}

test('create validates, persists and dispatches a valid ENC upload', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-ingestion-unit-'));
  const temporaryFile = path.join(directory, 'upload.zip');
  const contents = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  await writeFile(temporaryFile, contents);
  const created: unknown[] = [];
  const dispatched: unknown[] = [];
  const service = new IngestionsService(
    config(directory),
    { inspect: async () => ARCHIVE } as never,
    {
      createIngestion: async (input: Record<string, unknown>) => {
        created.push(input);
        return {
          archive: { cells: ARCHIVE.cells },
          checksum: { algorithm: 'sha256', value: input.checksum },
          createdAt: new Date().toISOString(),
          datasetId: 'dataset-id',
          error: null,
          id: input.ingestionId,
          originalFilename: input.originalFilename,
          sizeBytes: input.sizeBytes,
          sourceType: 'S57',
          status: 'received',
          storagePath: input.storagePath,
          updatedAt: new Date().toISOString(),
          versionId: 'version-id',
          versionKey: 'soundg-version-id',
        };
      },
      findIngestion: async () => null,
    } as never,
    {
      dispatch: (job: unknown) => dispatched.push(job),
      releaseReservation: () => undefined,
      reserve: () => undefined,
    } as never,
  );

  try {
    const result = await service.create(upload(temporaryFile));
    const input = created[0] as Record<string, unknown>;

    assert.equal(result.status, 'received');
    assert.equal(created.length, 1);
    assert.equal(input.originalFilename, 'miami.zip');
    assert.equal(
      input.checksum,
      createHash('sha256').update(contents).digest('hex'),
    );
    assert.deepEqual(dispatched, [
      {
        archivePath: result.storagePath,
        ingestionId: result.id,
        versionId: result.versionId,
        versionKey: result.versionKey,
      },
    ]);
    assert.deepEqual(
      await readFile(path.join(directory, result.storagePath)),
      contents,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('create rejects an invalid extension before inspecting the archive', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-ingestion-unit-'));
  const temporaryFile = path.join(directory, 'upload.bin');
  await writeFile(temporaryFile, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  let inspected = false;
  const service = new IngestionsService(
    config(directory),
    { inspect: async () => { inspected = true; } } as never,
    {} as never,
    { releaseReservation: () => undefined, reserve: () => undefined } as never,
  );

  try {
    await assert.rejects(
      service.create(upload(temporaryFile, { originalname: 'miami.bin' })),
      (error: unknown) =>
        error instanceof UnprocessableEntityException &&
        (error.getResponse() as { code?: string }).code ===
          'INVALID_FILE_EXTENSION',
    );
    assert.equal(inspected, false);
    await assert.rejects(readFile(temporaryFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('create rejects a production upload and removes its temporary file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-ingestion-unit-'));
  const temporaryFile = path.join(directory, 'upload.zip');
  await writeFile(temporaryFile, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const service = new IngestionsService(
    config(directory),
    { inspect: async () => ARCHIVE } as never,
    {} as never,
    {
      releaseReservation: () => undefined,
      reserve: () => {
        throw new ServiceUnavailableException('ENC ingestion is disabled');
      },
    } as never,
  );

  try {
    await assert.rejects(
      service.create(upload(temporaryFile)),
      ServiceUnavailableException,
    );
    await assert.rejects(readFile(temporaryFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('create rejects a file without a ZIP signature', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-ingestion-unit-'));
  const temporaryFile = path.join(directory, 'upload.zip');
  await writeFile(temporaryFile, Buffer.from('not a zip'));
  let inspected = false;
  const service = new IngestionsService(
    config(directory),
    { inspect: async () => { inspected = true; } } as never,
    {} as never,
    { releaseReservation: () => undefined, reserve: () => undefined } as never,
  );

  try {
    await assert.rejects(
      service.create(upload(temporaryFile)),
      (error: unknown) =>
        error instanceof UnprocessableEntityException &&
        (error.getResponse() as { code?: string }).code ===
          'INVALID_ZIP_SIGNATURE',
    );
    assert.equal(inspected, false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('find delegates to the chart catalog', async () => {
  const expected = { id: 'ingestion-id', status: 'processing' };
  const service = new IngestionsService(
    config('/tmp'),
    {} as never,
    { findIngestion: async (id: string) => ({ ...expected, id }) } as never,
    {} as never,
  );

  assert.deepEqual(await service.find('requested-id'), {
    id: 'requested-id',
    status: 'processing',
  });
});
