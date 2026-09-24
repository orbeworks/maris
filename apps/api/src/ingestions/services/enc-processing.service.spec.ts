import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigService } from '@nestjs/config';
import { EncProcessingService } from './enc-processing.service.js';
import type { EncArchiveService } from './enc-archive.service.js';

const cell = fileURLToPath(new URL('../../../../../data/ENC_ROOT/US5MIABC/US5MIABC.000', import.meta.url));

test('extracts real Miami S-57 coverage, dates, names, datums and spatial survey quality',
  { skip: !existsSync(cell) && 'Local ENC fixture not installed' }, async () => {
    const service = new EncProcessingService(new ConfigService({
      STORAGE_DIR: path.dirname(cell), CHART_STORAGE_DIR: path.dirname(cell),
    }));
    const result = await service.readCellMetadata(cell);
    assert.equal(result.hasSoundings, true);
    assert.equal(result.edition, '2');
    assert.equal(result.updateNumber, 0);
    const metadata = result.metadata;
    assert.equal(metadata.source, 'NOAA');
    assert.equal(metadata.issueDate, '2025-09-03');
    assert.equal(metadata.updateApplicationDate, '2025-09-03');
    assert.equal(metadata.compilationScale, 22000);
    assert.equal(metadata.horizontalDatum, 2);
    assert.equal(metadata.soundingDatum, 12);
    assert.ok(metadata.coveredAreaNames.includes('Biscayne Bay'));
    assert.ok(metadata.coveredAreaNames.includes('Key Biscayne'));
    assert.equal(new Set(metadata.coveredAreaNames).size, metadata.coveredAreaNames.length);
    assert.ok(metadata.coverage.length > 0);
    assert.ok(metadata.coverage.every((feature) => feature.geometry && feature.properties.CATCOV));
    assert.ok(metadata.metaObjects.M_QUAL?.some((feature) => feature.properties.CATZOC === 3));
    assert.ok(metadata.metaObjects.M_QUAL?.some((feature) => feature.properties.SURSTA === '20080713'
      && feature.properties.SUREND === '20080826' && feature.properties.SORIND));
  });

const noSoundingsCell = fileURLToPath(new URL('../../../../../data/ENC_ROOT/US3FL1DF/US3FL1DF.000', import.meta.url));
test('accepts metadata from the real US3FL1DF cell without SOUNDG',
  { skip: !existsSync(noSoundingsCell) && 'Local ENC fixture not installed' }, async () => {
    const service = new EncProcessingService(new ConfigService({ STORAGE_DIR: '/tmp', CHART_STORAGE_DIR: '/tmp' }));
    const result = await service.readCellMetadata(noSoundingsCell);
    assert.equal(result.hasSoundings, false);
    assert.ok(result.metadata.coverage.length);
  });

test('mixed archive keeps every cell but creates GPKG from cells containing SOUNDG', async () => {
  await checkArchive(['EMPTY', 'SOUND1', 'SOUND2'], false);
});

test('archive without SOUNDG fails explicitly without generating or publishing tiles', async () => {
  await checkArchive(['EMPTY'], false);
});

test('actual conversion errors are not mistaken for absent SOUNDG', async () => {
  await checkArchive(['EMPTY', 'SOUND1'], true);
});

async function checkArchive(names: string[], failConversion: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), 'maris-soundg-test-'));
  const commands: string[][] = [];
  class Processor extends EncProcessingService {
    constructor(configuration: ConfigService) {
      const archiveService = {
        inspect: async () => ({
          catalogPresent: true,
          cellCount: names.length,
          cells: names.map((name) => ({ name, updateNumbers: [] })),
          compressedBytes: 1,
          entryCount: names.length,
          fileCount: names.length,
          uncompressedBytes: names.length,
        }),
        extractCell: async (_archive: string, cellName: string, target: string) => {
          await mkdir(target, { recursive: true });
          const output = path.join(target, `${cellName}.000`);
          await writeFile(output, 'fixture');
          return [output];
        },
      } as unknown as EncArchiveService;
      super(configuration, undefined, archiveService);
    }
    override async readCellMetadata(filename: string) {
      return {
        hasSoundings: path.basename(filename).startsWith('SOUND'), edition: '1', updateNumber: 0,
        metadata: {
          source: null, agencyCode: null, issueDate: null, updateApplicationDate: null,
          compilationScale: null, horizontalDatum: null, verticalDatum: null, soundingDatum: null,
          coveredAreaNames: [], coverage: [], metaObjects: {}, rawDatasetIdentification: {},
        },
      };
    }
    protected override async run(command: string, args: string[]) {
      commands.push([command, ...args]);
      if (command === process.execPath) {
        const target = path.join(directory, 'soundg/versions/test-00000');
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, 'manifest.json'), JSON.stringify({ bounds: [-80, 25, -79, 26] }));
      } else if (failConversion) {
        throw new Error('conversion failed');
      }
    }
  }
  try {
    const processor = new Processor(new ConfigService({ STORAGE_DIR: directory, CHART_STORAGE_DIR: directory, MAX_ARCHIVE_ENTRIES: '100', MAX_UNCOMPRESSED_BYTES: '1000000' }));
    const processing = processor.process({ ingestionId: 'test', versionId: 'test', versionKey: 'test', archivePath: 'test.zip' });
    if (failConversion) {
      await assert.rejects(processing, /conversion failed/);
      assert.ok(!commands.some(([command]) => command === process.execPath));
    } else if (names.every((name) => name === 'EMPTY')) {
      await assert.rejects(processing, /No SOUNDG layer found/);
      assert.equal(commands.length, 0, 'no conversion is needed when SOUNDG is absent');
    } else {
      const result = await processing;
      assert.deepEqual(result.cells.map((cell) => cell.name), names);
      const conversions = commands.filter((args) => args.includes('-sql'));
      assert.equal(conversions.length, 2);
      assert.ok(conversions[0]!.includes('GPKG'));
      assert.ok(!conversions[0]!.includes('-append'));
      assert.ok(conversions[1]!.includes('-append'));
      assert.ok(conversions.every((args) => !args.includes('-dialect')));
      assert.ok(conversions.every((args) => !args.some((arg) => arg.endsWith('EMPTY.000'))));
    }
    assert.equal(existsSync(path.join(directory, '.processing/test')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
