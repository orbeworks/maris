import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ProcessingCleanupService } from "./processing-cleanup.service.js";
import { EncArchiveService } from "./enc-archive.service.js";
import { coverageCells } from "../../charts/models/chart-selection.js";
import { ObjectStorageService } from "../../storage/object-storage.service.js";

import type {
  EncMetadataFeature,
  EncJsonValue,
  ProcessedCell,
  ProcessingJob,
  ProcessingResult,
  ProcessingShard,
} from "../types/ingestion.types.js";

const execFileAsync = promisify(execFile);

type GeneratedManifest = {
  bounds: [number, number, number, number];
};

@Injectable()
export class EncProcessingService {
  private readonly cellConcurrency: number;
  private readonly shardCellCount: number;
  private readonly chartStorageDirectory: string;
  private readonly storageDirectory: string;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(ProcessingCleanupService)
    private readonly cleanup: ProcessingCleanupService = new ProcessingCleanupService(
      config,
    ),
    @Inject(EncArchiveService)
    protected readonly archiveService: EncArchiveService = new EncArchiveService(
      config,
    ),
    @Inject(ObjectStorageService)
    private readonly objectStorage: ObjectStorageService = undefined as never,
  ) {
    const configuredConcurrency = Number(
      config.get<number>("ENC_CELL_CONCURRENCY", 2),
    );
    this.cellConcurrency = Number.isInteger(configuredConcurrency)
      ? Math.max(1, Math.min(8, configuredConcurrency))
      : 2;
    const configuredShardSize = Number(
      config.get<number>("ENC_SHARD_CELL_COUNT", 100),
    );
    this.shardCellCount = Number.isInteger(configuredShardSize)
      ? Math.max(10, Math.min(500, configuredShardSize))
      : 100;
    this.storageDirectory = path.resolve(
      config.getOrThrow<string>("STORAGE_DIR"),
    );
    this.chartStorageDirectory = path.resolve(
      config.getOrThrow<string>("CHART_STORAGE_DIR"),
    );
  }

  async process(
    job: ProcessingJob,
    onShard?: (shard: ProcessingShard) => Promise<void>,
  ): Promise<ProcessingResult> {
    const archivePath = path.join(this.storageDirectory, job.archivePath);
    const workDirectory = path.join(
      this.storageDirectory,
      ".processing",
      job.ingestionId,
    );
    const extractedDirectory = path.join(workDirectory, "cells");

    await rm(workDirectory, { force: true, recursive: true });
    await mkdir(extractedDirectory, { recursive: true });

    try {
      const archive = await this.archiveService.inspect(archivePath);
      if (archive.cells.length === 0)
        throw new Error("No S-57 base cells extracted");

      const collectedCells: ProcessedCell[] = [];
      let batchCells: ProcessedCell[] = [];
      let sequence = 0;
      let aggregateBounds: [number, number, number, number] | undefined;
      let lastResult: ProcessingShard | undefined;
      let geopackage = path.join(workDirectory, `soundings-${sequence}.gpkg`);
      let geopackageCreated = false;
      const entries = archive.cells.sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      type PreparedCell = {
        cell: string;
        directory: string;
        entry: (typeof entries)[number];
        metadata: Awaited<ReturnType<EncProcessingService["readCellMetadata"]>>;
      };
      const pending = new Map<number, Promise<PreparedCell>>();
      let nextToStart = 0;
      const publishBatch = async () => {
        if (batchCells.length === 0) return;
        if (!geopackageCreated) {
          throw new Error(
            "No SOUNDG layer found in this ENC batch; no sounding shard can be published",
          );
        }
        const shardKey = `${job.versionKey}-${String(sequence).padStart(5, "0")}`;
        const storagePath = path.posix.join("soundg", "versions", shardKey);
        const manifestPath = path.posix.join(storagePath, "manifest.json");
        const localRoot = path.join(this.chartStorageDirectory, storagePath);
        const coveragePath = path.join(
          workDirectory,
          `coverage-${sequence}.json`,
        );
        await writeFile(
          coveragePath,
          JSON.stringify(coverageCells(batchCells)),
        );

        const apiRoot = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../../",
        );
        await this.run(process.execPath, [
          path.join(apiRoot, "node_modules/tsx/dist/cli.mjs"),
          path.join(apiRoot, "scripts/build-soundg-tiles.ts"),
          "--input",
          geopackage,
          "--layer",
          "soundings",
          "--storage-dir",
          this.chartStorageDirectory,
          "--version",
          shardKey,
          "--coverage",
          coveragePath,
        ]);
        const manifest = JSON.parse(
          await readFile(
            path.join(this.chartStorageDirectory, manifestPath),
            "utf8",
          ),
        ) as GeneratedManifest;
        const remote = this.objectStorage?.enabled
          ? await this.publishArtifacts(shardKey, localRoot)
          : undefined;
        const shard: ProcessingShard = {
          bounds: manifest.bounds,
          cells: batchCells,
          manifestPath,
          storagePath,
          sequence,
          shardKey,
          ...remote,
        };
        await onShard?.(shard);
        if (!onShard) collectedCells.push(...batchCells);
        aggregateBounds = aggregateBounds
          ? [
              Math.min(aggregateBounds[0], shard.bounds[0]),
              Math.min(aggregateBounds[1], shard.bounds[1]),
              Math.max(aggregateBounds[2], shard.bounds[2]),
              Math.max(aggregateBounds[3], shard.bounds[3]),
            ]
          : shard.bounds;
        // The callback has already persisted the batch. Do not retain its
        // potentially large survey/coverage metadata while preparing the next
        // shard; only the non-incremental compatibility path needs it.
        lastResult = onShard ? { ...shard, cells: [] } : shard;
        if (remote)
          await rm(localRoot, { force: true, recursive: true, maxRetries: 3 });
        await Promise.all([
          rm(geopackage, { force: true }),
          rm(coveragePath, { force: true }),
        ]);
        sequence += 1;
        batchCells = [];
        geopackage = path.join(workDirectory, `soundings-${sequence}.gpkg`);
        geopackageCreated = false;
      };
      const prepare = async (index: number): Promise<PreparedCell> => {
        const entry = entries[index]!;
        const directory = path.join(
          extractedDirectory,
          `${String(index).padStart(5, "0")}-${entry.name}`,
        );
        await mkdir(directory, { recursive: true });
        const files = await this.archiveService.extractCell(
          archivePath,
          entry.name,
          directory,
        );
        const cell = files.find((file) => /\.000$/i.test(file));
        if (!cell) throw new Error(`Missing extracted base cell ${entry.name}`);
        return {
          cell,
          directory,
          entry,
          metadata: await this.readCellMetadata(cell),
        };
      };
      const fillPipeline = () => {
        while (
          nextToStart < entries.length &&
          pending.size < this.cellConcurrency
        ) {
          const index = nextToStart++;
          const task = prepare(index);
          // Attach an immediate observer so a later cell cannot become an
          // unhandled rejection while the ordered consumer awaits earlier work.
          void task.catch(() => undefined);
          pending.set(index, task);
        }
      };
      fillPipeline();
      try {
        for (let index = 0; index < entries.length; index += 1) {
          const prepared = await pending.get(index)!;
          pending.delete(index);
          fillPipeline();
          const { cell, directory, entry, metadata: result } = prepared;
          const { hasSoundings, ...metadata } = result;
          const processedCell: ProcessedCell = {
            ...metadata,
            edition: metadata.edition,
            name: entry.name,
            updateNumber: Math.max(
              metadata.updateNumber,
              ...entry.updateNumbers,
              0,
            ),
            updatesApplied: entry.updateNumbers,
          };
          if (hasSoundings) {
            const arguments_ = [
              ...(geopackageCreated ? ["-update", "-append"] : []),
              ...(!geopackageCreated ? ["-f", "GPKG"] : []),
              geopackage,
              cell,
              "-oo",
              "SPLIT_MULTIPOINT=ON",
              "-oo",
              "ADD_SOUNDG_DEPTH=ON",
              "-oo",
              "UPDATES=APPLY",
              "-sql",
              `SELECT *, '${entry.name}' AS SOURCE_CELL, '${processedCell.edition ?? ""}' AS SOURCE_EDITION, ${processedCell.updateNumber} AS SOURCE_UPDATE FROM SOUNDG`,
              "-nln",
              "soundings",
              "-dim",
              "XY",
            ];
            await this.run("ogr2ogr", arguments_);
            geopackageCreated = true;
          }
          batchCells.push(processedCell);
          await rm(directory, { force: true, recursive: true });
          // Keep at least one full tail batch. Besides avoiding tiny shards,
          // this lets metadata-only cells at the end travel with the last
          // SOUNDG-producing cells instead of creating an empty PMTiles file.
          const remaining = entries.length - index - 1;
          if (
            batchCells.length >= this.shardCellCount &&
            remaining >= this.shardCellCount
          )
            await publishBatch();
        }
        await publishBatch();
      } catch (error) {
        await Promise.allSettled(pending.values());
        throw error;
      }

      if (!lastResult || !aggregateBounds) {
        throw new Error(
          "No SOUNDG layer found in any ENC cell; no sounding tiles can be published",
        );
      }
      return {
        ...lastResult,
        bounds: aggregateBounds,
        cells: onShard ? [] : collectedCells,
      };
    } finally {
      await Promise.all([
        rm(workDirectory, { force: true, recursive: true, maxRetries: 3 }),
        this.cleanup.cleanVersion(job.versionKey),
      ]);
    }
  }

  private async publishArtifacts(versionKey: string, localRoot: string) {
    if (!this.objectStorage?.enabled) return undefined;
    const artifactObjectKey = `datasets/soundg/${versionKey}/tiles.pmtiles`;
    const manifestObjectKey = `datasets/soundg/${versionKey}/manifest.json`;
    const localArtifact = path.join(localRoot, "tiles.pmtiles");
    const expectedSize = (await stat(localArtifact)).size;
    const existingArtifact =
      await this.objectStorage.tryHead(artifactObjectKey);
    if (
      !existingArtifact ||
      Number(existingArtifact.ContentLength ?? 0) !== expectedSize
    ) {
      await this.objectStorage.putFile(
        artifactObjectKey,
        localArtifact,
        "application/vnd.pmtiles",
      );
    }
    await this.objectStorage.putFile(
      manifestObjectKey,
      path.join(localRoot, "manifest.json"),
      "application/json",
    );
    const [artifact, manifest] = await Promise.all([
      this.objectStorage.head(artifactObjectKey),
      this.objectStorage.head(manifestObjectKey),
    ]);
    if (Number(artifact.ContentLength ?? 0) !== expectedSize)
      throw new Error("Published PMTiles object failed validation");
    if (Number(manifest.ContentLength ?? 0) <= 0)
      throw new Error("Published PMTiles manifest is empty");
    return { artifactObjectKey, manifestObjectKey };
  }

  async readCellMetadata(cell: string) {
    const { stdout } = await execFileAsync(
      "ogrinfo",
      ["-ro", "-so", "-oo", "UPDATES=APPLY", cell],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const layers = [...stdout.matchAll(/^\d+: (\w+)/gm)].map(
      (match) => match[1]!,
    );
    const readLayer = async (
      layer: string,
      keepProperties?: string[],
    ): Promise<EncMetadataFeature[]> => {
      const result = await execFileAsync(
        "ogr2ogr",
        ["-f", "GeoJSON", "/vsistdout/", cell, layer, "-oo", "UPDATES=APPLY"],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      const features = (
        JSON.parse(result.stdout) as { features: EncMetadataFeature[] }
      ).features;
      if (!keepProperties) return features;

      // Metadata layers can contain very large geometries and many properties.
      // Keep only the fields consumed by the catalog so one large ENC cannot
      // retain hundreds of megabytes until the whole archive is processed.
      return features.flatMap((feature) => {
        const properties: Record<string, EncJsonValue> = {};
        for (const key of keepProperties) {
          const value = feature.properties[key];
          if (value !== undefined) properties[key] = value;
        }
        return Object.keys(properties).length > 0
          ? [{ ...feature, properties }]
          : [];
      });
    };
    const dsid = (await readLayer("DSID"))[0]?.properties;
    if (!dsid) throw new Error("Missing S-57 DSID metadata");
    const metaObjects: Record<string, EncMetadataFeature[]> = {};
    const surveyProperties = ["CATZOC", "SORIND", "SORDAT", "SURSTA", "SUREND"];
    for (const layer of layers.filter(
      (name) => name.startsWith("M_") && name !== "M_COVR",
    )) {
      metaObjects[layer] = await readLayer(layer, surveyProperties);
    }
    const names = new Set<string>();
    // Geographic place names, not names of individual buoys or lights.
    for (const layer of ["SEAARE", "LNDARE", "FAIRWY", "CANALS", "HRBARE"]) {
      if (!layers.includes(layer)) continue;
      for (const feature of await readLayer(layer, ["OBJNAM", "NOBJNM"])) {
        for (const key of ["OBJNAM", "NOBJNM"]) {
          const value = feature.properties[key];
          if (typeof value === "string" && value.trim())
            names.add(value.trim());
        }
      }
    }
    const number = (key: string): number | null => {
      const value = dsid[key];
      return value !== null &&
        value !== undefined &&
        value !== "" &&
        Number.isFinite(Number(value))
        ? Number(value)
        : null;
    };
    const date = (key: string): string | null => {
      const value = String(dsid[key] ?? "");
      if (!/^\d{8}$/.test(value)) return null;
      const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      const parsed = new Date(iso);
      return Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === iso
        ? iso
        : null;
    };
    const agencyCode = number("DSID_AGEN");
    return {
      hasSoundings: layers.includes("SOUNDG"),
      edition: dsid.DSID_EDTN == null ? null : String(dsid.DSID_EDTN),
      updateNumber: number("DSID_UPDN") ?? 0,
      metadata: {
        source: agencyCode === 550 ? "NOAA" : null,
        agencyCode,
        issueDate: date("DSID_ISDT"),
        updateApplicationDate: date("DSID_UADT"),
        compilationScale: number("DSPM_CSCL"),
        horizontalDatum: number("DSPM_HDAT"),
        verticalDatum: number("DSPM_VDAT"),
        soundingDatum: number("DSPM_SDAT"),
        coveredAreaNames: [...names].sort(),
        coverage: layers.includes("M_COVR")
          ? await readLayer("M_COVR", ["CATCOV"])
          : [],
        metaObjects,
        rawDatasetIdentification: dsid,
      },
    };
  }

  protected async run(command: string, arguments_: string[]) {
    try {
      await execFileAsync(command, arguments_, { maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      throw new Error(
        `${command} failed: ${failure.stderr?.trim() || failure.message}`,
        { cause: error },
      );
    }
  }
}
