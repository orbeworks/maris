import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  access,
  constants,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import type { TilesetManifest } from '../src/tiles/storage/chart-storage.js';
import {
  ChartSelection,
  CHART_SELECTION_POLICY,
  type CoverageCell,
} from '../src/charts/models/chart-selection.js';

const DATASET = 'soundg';
const MIN_ZOOM = 8;
const MAX_ZOOM = 16;
const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const FIELDS = [
  'DEPTH', 'RCID', 'LNAM', 'SORDAT', 'SORIND', 'SOURCE_CELL',
  'SOURCE_EDITION', 'SOURCE_UPDATE',
];

type SoundingFeature = GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>;
type Options = {
  coverage?: string;
  input: string;
  layer?: string;
  sampling: 'none' | 'legacy-v1';
  storageDirectory: string;
  version: string;
};

function parseArguments(): Options {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]!;
    if (argument === '--') continue;
    const value = process.argv[index + 1];
    if (!argument.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }

  const input = values.get('--input');
  const storageDirectory = values.get('--storage-dir');
  const version = values.get('--version');
  const sampling = values.get('--sampling') ?? 'none';
  if (!input || !storageDirectory || !version) {
    throw new Error(
      'Usage: build-soundg-tiles --input <dataset> --storage-dir <dir> --version <id> [--layer soundings] [--coverage cells.json]',
    );
  }
  if (!SAFE_VERSION.test(version)) throw new Error('Invalid version identifier');
  if (sampling !== 'none' && sampling !== 'legacy-v1') {
    throw new Error('Sampling must be none or legacy-v1');
  }

  return {
    input: path.resolve(input),
    sampling,
    storageDirectory: path.resolve(storageDirectory),
    version,
    ...(values.get('--coverage')
      ? { coverage: path.resolve(values.get('--coverage')!) }
      : {}),
    ...(values.get('--layer') ? { layer: values.get('--layer')! } : {}),
  };
}

async function pathExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function processFailure(label: string, code: number | null, stderr: string) {
  return new Error(
    `${label} failed (${code ?? 'signal'}): ${stderr.trim() || 'no diagnostics'}`,
  );
}

function waitForProcess(
  child: ReturnType<typeof spawn>,
  label: string,
  stderr: { value: string },
) {
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(processFailure(label, code, stderr.value));
    });
  });
}

function captureStderr(child: ReturnType<typeof spawn>) {
  const captured = { value: '' };
  child.stderr?.on('data', (chunk: Buffer) => {
    captured.value = `${captured.value}${chunk.toString('utf8')}`.slice(
      -64 * 1024,
    );
  });
  return captured;
}

async function writeWithBackpressure(
  stream: NodeJS.WritableStream,
  value: string,
) {
  if (stream.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function legacyKeep(feature: SoundingFeature) {
  const id = String(feature.properties?.RCID ?? feature.id ?? '0');
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % 16 === 0;
}

async function streamToMbtiles(
  options: Options,
  mbtiles: string,
  temporaryDatabase: string,
  filteredSequence: string,
) {
  const selection = options.coverage
    ? new ChartSelection(
        JSON.parse(await readFile(options.coverage, 'utf8')) as CoverageCell[],
      )
    : null;
  const readerArguments = [
    '-f',
    'GeoJSONSeq',
    '/vsistdout/',
    options.input,
    ...(options.layer ? [options.layer] : []),
    '-dim',
    'XY',
    '-lco',
    'RS=NO',
    '-lco',
    'COORDINATE_PRECISION=6',
  ];
  const writerArguments = [
    '-f',
    'MVT',
    mbtiles,
    '-if',
    'GeoJSONSeq',
    filteredSequence,
    '-nln',
    'soundings',
    '-dsco',
    'FORMAT=MBTILES',
    '-dsco',
    `MINZOOM=${MIN_ZOOM}`,
    '-dsco',
    `MAXZOOM=${MAX_ZOOM}`,
    '-dsco',
    'COMPRESS=YES',
    '-dsco',
    `TEMPORARY_DB=${temporaryDatabase}`,
    '-dsco',
    'MAX_SIZE=30000000',
    '-dsco',
    'MAX_FEATURES=1000000',
    '-dsco',
    'BUFFER=64',
    '-dsco',
    'EXTENT=4096',
  ];

  const reader = spawn('ogr2ogr', readerArguments, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const readerError = captureStderr(reader);
  const readerDone = waitForProcess(
    reader,
    'GDAL GeoJSONSeq reader',
    readerError,
  );
  if (!reader.stdout) throw new Error('GDAL streaming output is unavailable');
  const filtered = createWriteStream(filteredSequence, { flags: 'wx' });
  const filteredDone = new Promise<void>((resolve, reject) => {
    filtered.once('finish', resolve);
    filtered.once('error', reject);
  });

  let inputFeatureCount = 0;
  let retainedFeatureCount = 0;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  try {
    const lines = createInterface({ input: reader.stdout, crlfDelay: Infinity });
    for await (const rawLine of lines) {
      const line = rawLine.replace(/^\x1e/, '').trim();
      if (!line) continue;
      const feature = JSON.parse(line) as SoundingFeature;
      inputFeatureCount += 1;
      if (feature.geometry?.type !== 'Point') continue;
      const [longitude, latitude] = feature.geometry.coordinates;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
      if (
        selection &&
        (() => {
          const selected = selection.at([longitude, latitude]);
          return !selected || selected.name !== feature.properties?.SOURCE_CELL ||
            (feature.properties?.SOURCE_EDITION !== undefined &&
              String(selected.edition ?? '') !== String(feature.properties.SOURCE_EDITION)) ||
            (feature.properties?.SOURCE_UPDATE !== undefined &&
              selected.updateNumber !== Number(feature.properties.SOURCE_UPDATE));
        })()
      ) {
        continue;
      }
      if (options.sampling === 'legacy-v1' && !legacyKeep(feature)) continue;

      feature.properties = Object.fromEntries(
        FIELDS.flatMap((field) =>
          feature.properties?.[field] === undefined
            ? []
            : [[field, feature.properties[field]]],
        ),
      );

      west = Math.min(west, longitude);
      south = Math.min(south, latitude);
      east = Math.max(east, longitude);
      north = Math.max(north, latitude);
      retainedFeatureCount += 1;
      await writeWithBackpressure(filtered, `${JSON.stringify(feature)}\n`);
    }
    filtered.end();
    await readerDone;
    await filteredDone;
  } catch (error) {
    reader.kill('SIGTERM');
    filtered.destroy();
    await Promise.allSettled([readerDone, filteredDone]);
    throw error;
  }

  if (
    retainedFeatureCount === 0 ||
    ![west, south, east, north].every(Number.isFinite)
  ) {
    throw new Error('No sounding features remain after chart coverage selection');
  }
  const writer = spawn('ogr2ogr', writerArguments, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const writerError = captureStderr(writer);
  await waitForProcess(writer, 'GDAL MVT writer', writerError);
  return {
    bounds: [west, south, east, north] as [number, number, number, number],
    inputFeatureCount,
    retainedFeatureCount,
  };
}

async function build(options: Options) {
  const versionsDirectory = path.join(
    options.storageDirectory,
    DATASET,
    'versions',
  );
  const destination = path.join(versionsDirectory, options.version);
  const temporaryDestination = path.join(
    versionsDirectory,
    `.${options.version}.${process.pid}.tmp`,
  );
  if (await pathExists(destination)) {
    throw new Error(
      `Version ${options.version} already exists; published artifacts are immutable`,
    );
  }

  await rm(temporaryDestination, { force: true, recursive: true });
  await mkdir(temporaryDestination, { recursive: true });
  const mbtiles = path.join(temporaryDestination, 'tiles.mbtiles');
  const temporaryDatabase = path.join(
    temporaryDestination,
    'gdal-mvt.sqlite',
  );
  const filteredSequence = path.join(
    temporaryDestination,
    'filtered.geojsonseq',
  );
  try {
    const streamed = await streamToMbtiles(
      options,
      mbtiles,
      temporaryDatabase,
      filteredSequence,
    );
    const manifest: TilesetManifest & {
      artifactChecksum: string;
      sourceFeatureCount: number;
      tileCount: number;
      totalBytes: number;
    } = {
      artifactChecksum: '',
      bounds: streamed.bounds,
      createdAt: new Date().toISOString(),
      dataset: DATASET,
      format: 'mvt',
      storageFormat: 'pmtiles',
      ...(options.coverage ? { selectionPolicy: CHART_SELECTION_POLICY } : {}),
      maxzoom: MAX_ZOOM,
      minzoom: MIN_ZOOM,
      name: 'Marine SOUNDG',
      sourceFeatureCount: streamed.retainedFeatureCount,
      tileCount: 0,
      tilePathTemplate: `${DATASET}/versions/${options.version}/{z}/{x}/{y}.pbf`,
      totalBytes: 0,
      vectorLayers: [
        {
          fields: {
            DEPTH: 'Number',
            LNAM: 'String',
            RCID: 'Number',
            SORDAT: 'String',
            SORIND: 'String',
            SOURCE_CELL: 'String',
            SOURCE_EDITION: 'String',
            SOURCE_UPDATE: 'Number',
          },
          id: 'soundings',
          maxzoom: MAX_ZOOM,
          minzoom: MIN_ZOOM,
        },
      ],
      version: options.version,
    };
    const manifestPath = path.join(temporaryDestination, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const archive = path.join(temporaryDestination, 'tiles.pmtiles');
    const pmtilesPython = [
      process.env.PMTILES_PYTHON,
      '/opt/pmtiles/bin/python',
      path.resolve(process.cwd(), 'apps/api/.venv/pmtiles/bin/python'),
      path.resolve(process.cwd(), '.venv/pmtiles/bin/python'),
      '/tmp/maris-pmtiles-venv/bin/python',
      'python3',
    ].find(
      (candidate) =>
        candidate && (candidate === 'python3' || existsSync(candidate)),
    ) ?? 'python3';
    const { stdout } = await promisify(execFile)(pmtilesPython, [
      fileURLToPath(new URL('./pack-mbtiles.py', import.meta.url)),
      mbtiles,
      archive,
      manifestPath,
    ], {
      env: { ...process.env, TMPDIR: temporaryDestination },
      maxBuffer: 2 * 1024 * 1024,
    });
    const packed = JSON.parse(stdout) as { tileCount: number };
    manifest.tileCount = packed.tileCount;
    const checksum = createHash('sha256');
    for await (const chunk of createReadStream(archive)) checksum.update(chunk);
    manifest.artifactChecksum = checksum.digest('hex');
    manifest.totalBytes = (await stat(archive)).size;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await Promise.all([
      rm(mbtiles, { force: true }),
      rm(temporaryDatabase, { force: true }),
      rm(filteredSequence, { force: true }),
    ]);
    await mkdir(versionsDirectory, { recursive: true });
    await rename(temporaryDestination, destination);

    console.log(
      JSON.stringify({
        directory: destination,
        inputFeatureCount: streamed.inputFeatureCount,
        retainedFeatureCount: streamed.retainedFeatureCount,
        tileCount: manifest.tileCount,
        totalBytes: manifest.totalBytes,
        version: options.version,
      }),
    );
  } catch (error) {
    await rm(temporaryDestination, { force: true, recursive: true });
    throw error;
  }
}

void build(parseArguments()).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
