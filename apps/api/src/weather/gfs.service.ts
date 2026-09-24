import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { Cacheable } from "../utils/cacheable.decorator.js";
import { gfsTileBounds, gfsTileFromCoordinate } from "./gfs-grid-tiles.js";
import { type GfsBounds, type GfsGrid, type GfsRun } from "./gfs.types.js";
import {
  GFS_MAX_WEATHER_ZOOM,
  GFS_XYZ_GRID_SIZE,
  webMercatorTileBounds,
  xyzTileCount,
} from "./xyz-tiles.js";

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const NOMADS_FILTER_URL =
  "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl";

const NOMADS_TIMEOUT_MS = 30_000;
const RESOLUTION = 0.25;

export type Inventory = {
  run: GfsRun;
  files: Set<string>;
};

export type CurrentGfsForecast = {
  inventory: Inventory;
  sourceForecastHour: number;
  validTime: string;
};

type NegativeRunEntry = {
  runKey: string;
  reason: string;
  expiresAt: number;
};

type InventoryReadResult = {
  inventory: Inventory | null;
  reason?: string;
};

type ParsedSubset = {
  metadata: {
    width: number;
    height: number;
    iScansNegatively: boolean;
    jScansPositively: boolean;
  };
  fields: Record<string, Array<number | null>>;
};

function sampleGridField(
  grid: GfsGrid,
  field: keyof GfsGrid["fields"],
  latitude: number,
  longitude: number,
) {
  const values = grid.fields[field];

  if (values?.length !== grid.width * grid.height) {
    return null;
  }

  const { west, east, north, south } = grid.bounds;

  if (
    latitude < south ||
    latitude > north ||
    longitude < west ||
    longitude > east
  ) {
    return null;
  }

  const x = Math.max(
    0,
    Math.min(
      grid.width - 1,
      ((longitude - west) / (east - west)) * (grid.width - 1),
    ),
  );

  const y = Math.max(
    0,
    Math.min(
      grid.height - 1,
      ((north - latitude) / (north - south)) * (grid.height - 1),
    ),
  );

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);

  const tx = x - x0;
  const ty = y - y0;

  const valuesAt = (row: number, column: number) =>
    values[row * grid.width + column];

  const corners = [
    valuesAt(y0, x0),
    valuesAt(y0, x1),
    valuesAt(y1, x0),
    valuesAt(y1, x1),
  ];

  const valid = corners.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );

  if (valid.length !== corners.length) {
    return valid.length
      ? valid.reduce((sum, value) => sum + value, 0) / valid.length
      : null;
  }

  return (
    corners[0]! * (1 - tx) * (1 - ty) +
    corners[1]! * tx * (1 - ty) +
    corners[2]! * (1 - tx) * ty +
    corners[3]! * tx * ty
  );
}

@Injectable()
export class GfsService {
  private readonly logger = new Logger(GfsService.name);

  private readonly unavailableRuns = new Map<string, NegativeRunEntry>();

  private negativeCacheStores = 0;
  private negativeCacheHits = 0;
  private skippedRunProbes = 0;

  private currentForecastLogKey = "";

  constructor(private readonly config: ConfigService) {}

  async getTile(x: number, y: number, forecastHour: number): Promise<GfsGrid> {
    const bounds = gfsTileBounds(x, y);

    const normalizedHour = this.normalizeForecastHours([forecastHour])[0];

    if (normalizedHour === undefined) {
      throw new BadRequestException("A valid forecast hour is required");
    }

    const inventory = await this.findCompleteInventory([normalizedHour]);

    const file = this.fileForHour(inventory.files, normalizedHour);

    if (!file) {
      throw new ServiceUnavailableException(
        `GFS forecast hour ${normalizedHour} is unavailable`,
      );
    }

    return this.getGrid(inventory.run, file, normalizedHour, bounds);
  }

  async getCompleteInventory(forecastHours: number[]): Promise<Inventory> {
    return this.findCompleteInventory(
      this.normalizeForecastHours(forecastHours),
    );
  }

  @Cacheable()
  async getCurrentForecast(now = new Date()): Promise<CurrentGfsForecast> {
    const inventory = await this.findCompleteInventory([0]);

    const runAtMs = Date.parse(inventory.run.runAt);

    if (!Number.isFinite(runAtMs)) {
      throw new ServiceUnavailableException(
        "GFS run has an invalid initialization time",
      );
    }

    const elapsedHours = Math.max(0, (now.getTime() - runAtMs) / 3_600_000);

    const availableHours = [...inventory.files]
      .flatMap((file) => {
        const match = /\.f(\d{3})$/.exec(file);

        return match?.[1]
          ? [Number(match[1])]
          : file.endsWith(".anl")
            ? [0]
            : [];
      })
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 384);

    if (availableHours.length === 0) {
      throw new ServiceUnavailableException("GFS run has no forecast hours");
    }

    const sourceForecastHour = availableHours.reduce((closest, hour) => {
      const difference = Math.abs(hour - elapsedHours);
      const closestDifference = Math.abs(closest - elapsedHours);

      return difference < closestDifference ||
        (difference === closestDifference && hour < closest)
        ? hour
        : closest;
    });

    const validTime = new Date(
      runAtMs + sourceForecastHour * 3_600_000,
    ).toISOString();

    const logKey = `${inventory.run.runAt}|${sourceForecastHour}`;

    if (this.currentForecastLogKey !== logKey) {
      this.currentForecastLogKey = logKey;

      const deltaMinutes = Math.round(
        (Date.parse(validTime) - now.getTime()) / 60_000,
      );

      this.logger.log(
        `[GFS current] serverNowUtc=${now.toISOString()} ` +
          `serverTimezone=${Intl.DateTimeFormat().resolvedOptions().timeZone} ` +
          `serverUtcOffsetMinutes=${-now.getTimezoneOffset()} ` +
          `runAtUtc=${inventory.run.runAt} ` +
          `sourceForecastHour=${sourceForecastHour} ` +
          `validTimeUtc=${validTime} ` +
          `deltaMinutes=${deltaMinutes}`,
      );
    }

    return {
      inventory,
      sourceForecastHour,
      validTime,
    };
  }

  @Cacheable()
  private async getTileFromInventory(
    inventory: Inventory,
    x: number,
    y: number,
    forecastHour: number,
  ): Promise<GfsGrid> {
    const normalizedHour = this.normalizeForecastHours([forecastHour])[0];

    if (normalizedHour === undefined) {
      throw new BadRequestException("A valid forecast hour is required");
    }

    const file = this.fileForHour(inventory.files, normalizedHour);

    if (!file) {
      throw new ServiceUnavailableException(
        `GFS forecast hour ${normalizedHour} is unavailable`,
      );
    }

    return this.getGrid(
      inventory.run,
      file,
      normalizedHour,
      gfsTileBounds(x, y),
    );
  }

  @Cacheable()
  async getXyzTileFromInventory(
    inventory: Inventory,
    z: number,
    x: number,
    y: number,
    forecastHour: number,
    sourceCache = new Map<string, GfsGrid>(),
  ): Promise<GfsGrid> {
    if (!Number.isInteger(z) || z < 0 || z > GFS_MAX_WEATHER_ZOOM) {
      throw new BadRequestException("Invalid GFS weather zoom");
    }

    const n = xyzTileCount(z);

    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= n ||
      y < 0 ||
      y >= n
    ) {
      throw new BadRequestException("Invalid GFS XYZ tile coordinate");
    }

    const bounds = webMercatorTileBounds(z, x, y);

    const width = GFS_XYZ_GRID_SIZE;
    const height = GFS_XYZ_GRID_SIZE;

    const fields: GfsGrid["fields"] = {};

    const fieldNames = [
      "windU",
      "windV",
      "temperature",
      "precipitation",
      "precipitationRate",
      "cloudCover",
      "pressure",
      "gust",
      "humidity",
    ] as const;

    for (const field of fieldNames) {
      fields[field] = new Array<number | null>(width * height).fill(null);
    }

    for (let row = 0; row < height; row += 1) {
      const latitude =
        bounds.north + (bounds.south - bounds.north) * (row / (height - 1));

      for (let column = 0; column < width; column += 1) {
        const longitude =
          bounds.west + (bounds.east - bounds.west) * (column / (width - 1));

        const normalizedLongitude = longitude === 180 ? -180 : longitude;

        const geographic = gfsTileFromCoordinate(normalizedLongitude, latitude);

        const sourceKey = `${forecastHour}:${geographic.x}:${geographic.y}`;

        let source = sourceCache.get(sourceKey);

        if (!source) {
          source = await this.getTileFromInventory(
            inventory,
            geographic.x,
            geographic.y,
            forecastHour,
          );

          sourceCache.set(sourceKey, source);

          if (sourceCache.size > 720) {
            const first = sourceCache.keys().next().value;

            if (first) {
              sourceCache.delete(first);
            }
          }
        }

        const targetIndex = row * width + column;

        for (const field of fieldNames) {
          fields[field]![targetIndex] = sampleGridField(
            source,
            field,
            latitude,
            normalizedLongitude,
          );
        }
      }
    }

    return {
      model: "gfs",
      run: inventory.run.runAt,

      forecastTime: new Date(
        Date.parse(inventory.run.runAt) + forecastHour * 3_600_000,
      ).toISOString(),

      forecastHour,

      resolution: RESOLUTION,

      bounds,
      width,
      height,

      gridOrder: "north-to-south,west-to-east",
      longitudeConvention: "-180..180",

      units: {
        wind: "m/s",
        temperature: "K",
        precipitation: "kg/m2",
        precipitationRate: "kg/m2/s",
        cloudCover: "%",
        pressure: "Pa",
        gust: "m/s",
        humidity: "%",
      },

      fields,
    };
  }

  private normalizeForecastHours(hours: number[]) {
    const normalized = [...new Set(hours)]
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 384)
      .sort((a, b) => a - b);

    if (normalized.length === 0) {
      throw new BadRequestException(
        "At least one valid forecast hour is required",
      );
    }

    return normalized;
  }

  private toGfsLongitude(longitude: number) {
    return longitude < 0 ? longitude + 360 : longitude;
  }

  @Cacheable()
  private async findCompleteInventory(
    forecastHours: number[],
  ): Promise<Inventory> {
    const inventory = await this.discoverCompleteInventory(forecastHours);

    return inventory;
  }

  private async discoverCompleteInventory(
    forecastHours: number[],
  ): Promise<Inventory> {
    const now = new Date();

    for (const candidate of this.candidateRuns(now)) {
      const { dateText, cycle } = candidate;

      const runKey = this.runKey(dateText, cycle);

      if (this.isRunTemporarilyUnavailable(runKey)) {
        continue;
      }

      const result = await this.readInventory(dateText, cycle);

      const inventory = result.inventory;

      if (
        inventory &&
        forecastHours.every((hour) => this.fileForHour(inventory.files, hour))
      ) {
        return inventory;
      }

      this.storeNegativeRun(
        runKey,
        inventory
          ? "INVENTORY_MISSING_REQUESTED_HOURS"
          : (result.reason ?? "INVENTORY_UNAVAILABLE"),
      );
    }

    throw new ServiceUnavailableException(
      "No complete GFS run is currently available",
    );
  }

  private candidateRuns(now: Date) {
    const candidates: Array<{
      dateText: string;
      cycle: number;
    }> = [];

    for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
      const date = new Date(now);

      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - dayOffset);

      const dateText = date.toISOString().slice(0, 10).replaceAll("-", "");

      for (const cycle of [18, 12, 6, 0]) {
        const runTimestamp = Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate(),
          cycle,
        );

        if (runTimestamp > now.getTime()) {
          continue;
        }

        candidates.push({
          dateText,
          cycle,
        });
      }
    }

    return candidates;
  }

  private async readInventory(
    date: string,
    cycle: number,
  ): Promise<InventoryReadResult> {
    const directory = `/gfs.${date}/${String(cycle).padStart(2, "0")}/atmos`;

    const url = new URL(NOMADS_FILTER_URL);

    url.searchParams.set("dir", directory);

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(NOMADS_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(
          `NOMADS inventory returned HTTP ${response.status} ` +
            `for ${date}/${String(cycle).padStart(2, "0")}`,
        );

        return {
          inventory: null,
          reason: `NOMADS_HTTP_${response.status}`,
        };
      }

      const html = await response.text();

      const files = new Set<string>();

      for (const match of html.matchAll(
        /value="(gfs\.t\d{2}z\.pgrb2\.0p25\.(?:anl|f\d{3}))"/g,
      )) {
        if (match[1]) {
          files.add(match[1]);
        }
      }

      if (files.size === 0) {
        this.logger.warn(
          `NOMADS inventory had no recognized GFS files ` +
            `for ${date}/${String(cycle).padStart(2, "0")} ` +
            `(responseBytes=${Buffer.byteLength(html)})`,
        );

        return {
          inventory: null,
          reason: "INVENTORY_EMPTY",
        };
      }

      return {
        inventory: {
          files,

          run: {
            date,
            cycle,

            run: `${date}T${String(cycle).padStart(2, "0")}:00:00Z`,

            runAt:
              `${date.slice(0, 4)}-` +
              `${date.slice(4, 6)}-` +
              `${date.slice(6)}T` +
              `${String(cycle).padStart(2, "0")}:00:00Z`,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(
        `NOMADS inventory request failed ` +
          `for ${date}/${String(cycle).padStart(2, "0")}: ` +
          message,
      );

      return {
        inventory: null,
        reason: "NOMADS_REQUEST_FAILED",
      };
    }
  }

  private runKey(date: string, cycle: number) {
    return `${date}/${String(cycle).padStart(2, "0")}`;
  }

  private negativeRunTtlMs() {
    const configured = this.config.get<number>(
      "GFS_NEGATIVE_RUN_CACHE_TTL_MS",
      3 * 60 * 1_000,
    );

    return Number.isFinite(configured) && configured > 0
      ? configured
      : 3 * 60 * 1_000;
  }

  private isRunTemporarilyUnavailable(runKey: string) {
    const entry = this.unavailableRuns.get(runKey);

    if (!entry) {
      return false;
    }

    const remainingMs = entry.expiresAt - Date.now();

    if (remainingMs <= 0) {
      this.unavailableRuns.delete(runKey);

      this.logger.log(`[GFS] negative run cache EXPIRED run=${runKey}`);

      return false;
    }

    this.negativeCacheHits += 1;
    this.skippedRunProbes += 1;

    this.logger.log(
      `[GFS] negative run cache HIT ` +
        `run=${runKey} ` +
        `remaining=${Math.ceil(remainingMs / 1_000)}s ` +
        `negativeCacheHits=${this.negativeCacheHits}`,
    );

    this.logger.log(`[GFS] skipping temporarily unavailable run=${runKey}`);

    return true;
  }

  private storeNegativeRun(runKey: string, reason: string) {
    const expiresAt = Date.now() + this.negativeRunTtlMs();

    this.unavailableRuns.set(runKey, {
      runKey,
      reason,
      expiresAt,
    });

    this.negativeCacheStores += 1;

    this.logger.warn(
      `[GFS] negative run cache STORE ` +
        `run=${runKey} ` +
        `reason=${reason} ` +
        `ttl=${Math.floor((expiresAt - Date.now()) / 1_000)}s ` +
        `negativeCacheStores=${this.negativeCacheStores} ` +
        `skippedRunProbes=${this.skippedRunProbes}`,
    );
  }

  private fileForHour(files: Set<string>, hour: number) {
    if (hour === 0) {
      return (
        [...files].find((file) => file.endsWith(".f000")) ??
        [...files].find((file) => file.endsWith(".anl"))
      );
    }

    return [...files].find((file) =>
      file.endsWith(`.f${String(hour).padStart(3, "0")}`),
    );
  }

  private async getGrid(
    run: GfsRun,
    file: string,
    forecastHour: number,
    bounds: GfsBounds,
  ): Promise<GfsGrid> {
    const segments = this.splitAtPrimeMeridian(bounds);

    if (segments.length > 1) {
      const mergedCachePath = this.cachePath(run, forecastHour, file, bounds);

      try {
        return JSON.parse(
          (await gunzipAsync(await readFile(mergedCachePath))).toString("utf8"),
        ) as GfsGrid;
      } catch {
        // Cache miss.
      }

      const grids = await Promise.all(
        segments.map((segment) =>
          this.getGridSubset(run, file, forecastHour, segment),
        ),
      );

      const merged = this.mergeGrids(grids as [GfsGrid, GfsGrid], bounds);

      await mkdir(path.dirname(mergedCachePath), {
        recursive: true,
      });

      await writeFile(
        mergedCachePath,
        await gzipAsync(JSON.stringify(merged), {
          level: 6,
        }),
      );

      return merged;
    }

    return this.getGridSubset(run, file, forecastHour, bounds);
  }

  private async getGridSubset(
    run: GfsRun,
    file: string,
    forecastHour: number,
    bounds: GfsBounds,
  ): Promise<GfsGrid> {
    const cachePath = this.cachePath(run, forecastHour, file, bounds);

    try {
      return JSON.parse(
        (await gunzipAsync(await readFile(cachePath))).toString("utf8"),
      ) as GfsGrid;
    } catch {
      // Cache miss.
    }

    const grib = await this.downloadSubset(run, file, bounds);

    const parsed = await this.parseGrib(grib);

    const grid = this.normalizeGrid(run, forecastHour, parsed, bounds);

    await mkdir(path.dirname(cachePath), {
      recursive: true,
    });

    await writeFile(
      cachePath,
      await gzipAsync(JSON.stringify(grid), {
        level: 6,
      }),
    );

    return grid;
  }

  private splitAtPrimeMeridian(bounds: GfsBounds): GfsBounds[] {
    if (bounds.west < 0 && bounds.east > 0 && bounds.east > bounds.west) {
      return [
        {
          ...bounds,
          east: 0,
        },
        {
          ...bounds,
          west: 0,
        },
      ];
    }

    return [bounds];
  }

  private mergeGrids(grids: [GfsGrid, GfsGrid], bounds: GfsBounds): GfsGrid {
    const [westGrid, eastGrid] = grids;

    if (
      westGrid.height !== eastGrid.height ||
      westGrid.forecastTime !== eastGrid.forecastTime
    ) {
      throw new BadGatewayException("GFS seam subsets are incompatible");
    }

    const width = westGrid.width + Math.max(0, eastGrid.width - 1);

    const fields: GfsGrid["fields"] = {};

    const fieldNames = new Set([
      ...Object.keys(westGrid.fields),
      ...Object.keys(eastGrid.fields),
    ]);

    for (const name of fieldNames) {
      const fieldName = name as keyof GfsGrid["fields"];

      const westValues =
        westGrid.fields[fieldName] ??
        new Array<number | null>(westGrid.width * westGrid.height).fill(null);

      const eastValues =
        eastGrid.fields[fieldName] ??
        new Array<number | null>(eastGrid.width * eastGrid.height).fill(null);

      const merged: Array<number | null> = [];

      for (let row = 0; row < westGrid.height; row += 1) {
        const westOffset = row * westGrid.width;

        const eastOffset = row * eastGrid.width;

        merged.push(
          ...westValues.slice(westOffset, westOffset + westGrid.width),
        );

        if (eastGrid.width > 1) {
          merged.push(
            ...eastValues.slice(eastOffset + 1, eastOffset + eastGrid.width),
          );
        }
      }

      fields[fieldName] = merged;
    }

    return {
      ...westGrid,
      bounds,
      width,
      fields,
    };
  }

  private async downloadSubset(run: GfsRun, file: string, bounds: GfsBounds) {
    const url = new URL(NOMADS_FILTER_URL);

    url.searchParams.set("file", file);

    for (const variable of [
      "UGRD",
      "VGRD",
      "TMP",
      "APCP",
      "PRATE",
      "TCDC",
      "PRMSL",
      "GUST",
      "RH",
    ]) {
      url.searchParams.set(`var_${variable}`, "on");
    }

    for (const level of [
      "10_m_above_ground",
      "2_m_above_ground",
      "surface",
      "entire_atmosphere",
      "mean_sea_level",
    ]) {
      url.searchParams.set(`lev_${level}`, "on");
    }

    url.searchParams.set("subregion", "");

    const leftLongitude = this.toGfsLongitude(bounds.west);

    const rightLongitude =
      bounds.east === 0 && bounds.west < 0
        ? 360
        : this.toGfsLongitude(bounds.east);

    url.searchParams.set("leftlon", String(leftLongitude));

    url.searchParams.set("rightlon", String(rightLongitude));

    url.searchParams.set("toplat", String(bounds.north));

    url.searchParams.set("bottomlat", String(bounds.south));

    url.searchParams.set(
      "dir",
      `/gfs.${run.date}/${String(run.cycle).padStart(2, "0")}/atmos`,
    );

    const response = await fetch(url, {
      signal: AbortSignal.timeout(NOMADS_TIMEOUT_MS),
    });

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (
      !response.ok ||
      bytes.length < 16 ||
      String.fromCodePoint(...bytes.slice(0, 4)) !== "GRIB"
    ) {
      throw new BadGatewayException(
        "NOMADS returned an invalid GFS GRIB2 subset",
      );
    }

    return bytes;
  }

  private async parseGrib(bytes: Uint8Array): Promise<ParsedSubset> {
    const parser = this.config.get<string>("GFS_PARSER_PYTHON", "python3");

    const configuredScript = this.config.get<string>(
      "GFS_PARSER_SCRIPT",
      "apps/api/scripts/gfs-grib-parser.py",
    );

    const scriptCandidates = [
      configuredScript,

      path.resolve(process.cwd(), configuredScript),

      path.resolve(process.cwd(), "apps/api/scripts/gfs-grib-parser.py"),

      path.resolve(process.cwd(), "scripts/gfs-grib-parser.py"),

      path.resolve(
        process.cwd(),
        "..",
        "..",
        "apps/api/scripts/gfs-grib-parser.py",
      ),
    ];

    const parserScript = scriptCandidates.find((candidate) =>
      existsSync(candidate),
    );

    if (!parserScript) {
      throw new ServiceUnavailableException(
        "GFS GRIB2 parser script is unavailable",
      );
    }

    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "maris-gfs-"),
    );

    const temporaryFile = path.join(temporaryDirectory, "subset.grib2");

    await writeFile(temporaryFile, bytes);

    try {
      const { stdout } = await execFileAsync(
        parser,
        [parserScript, temporaryFile],
        {
          maxBuffer: 128 * 1024 * 1024,
        },
      );

      return JSON.parse(stdout) as ParsedSubset;
    } catch {
      throw new ServiceUnavailableException(
        "GRIB2 parser is unavailable or rejected the GFS subset",
      );
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }

  private normalizeGrid(
    run: GfsRun,
    forecastHour: number,
    parsed: ParsedSubset,
    bounds: GfsBounds,
  ): GfsGrid {
    const { width, height, iScansNegatively, jScansPositively } =
      parsed.metadata;

    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new BadGatewayException("GFS subset has invalid grid dimensions");
    }

    const fields: GfsGrid["fields"] = {};

    for (const [name, values] of Object.entries(parsed.fields)) {
      if (values.length !== width * height) {
        continue;
      }

      const normalized = new Array<number | null>(values.length);

      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          const sourceRow = jScansPositively ? height - 1 - row : row;

          const sourceColumn = iScansNegatively ? width - 1 - column : column;

          const value = values[sourceRow * width + sourceColumn];

          normalized[row * width + column] = value ?? null;
        }
      }

      fields[name as keyof GfsGrid["fields"]] = normalized;
    }

    if (!fields.windU || !fields.windV || !fields.temperature) {
      throw new BadGatewayException("GFS subset is missing required fields");
    }

    const forecastTime = new Date(
      Date.parse(run.runAt) + forecastHour * 60 * 60 * 1_000,
    ).toISOString();

    return {
      model: "gfs",

      run: run.runAt,
      forecastTime,
      forecastHour,

      resolution: RESOLUTION,

      bounds,
      width,
      height,

      gridOrder: "north-to-south,west-to-east",

      longitudeConvention: "-180..180",

      units: {
        wind: "m/s",
        temperature: "K",
        precipitation: "kg/m2",
        precipitationRate: "kg/m2/s",
        cloudCover: "%",
        pressure: "Pa",
        gust: "m/s",
        humidity: "%",
      },

      fields,
    };
  }

  private cachePath(
    run: GfsRun,
    forecastHour: number,
    file: string,
    bounds: GfsBounds,
  ) {
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          run,
          forecastHour,
          file,
          bounds,
          resolution: RESOLUTION,
        }),
      )
      .digest("hex");

    return path.join(
      this.config.get<string>("GFS_CACHE_DIR", ".storage/gfs"),
      `${run.date}${String(run.cycle).padStart(2, "0")}`,
      `f${String(forecastHour).padStart(3, "0")}-${key}.json.gz`,
    );
  }
}
