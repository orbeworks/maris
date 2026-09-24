import { open, readFile } from "node:fs/promises";
import { PMTiles, SharedPromiseCache } from "pmtiles";
import path from "node:path";

import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { ChartStorage, TilesetManifest } from "./chart-storage.js";

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

@Injectable()
export class LocalChartStorageService implements ChartStorage {
  private readonly publicBaseUrl: string | undefined;
  private readonly storageDirectory: string;
  private readonly archiveCache = new SharedPromiseCache(64);

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.storageDirectory = path.resolve(
      config.getOrThrow<string>("CHART_STORAGE_DIR"),
    );
    this.publicBaseUrl = config
      .get<string>("CHART_ASSET_BASE_URL")
      ?.replace(/\/$/, "");
  }

  async getManifest(
    dataset: string,
    version: string,
  ): Promise<TilesetManifest> {
    this.assertSafeSegment(dataset);
    this.assertSafeSegment(version);

    try {
      const manifest = await this.readJson<TilesetManifest>(
        path.join(
          this.storageDirectory,
          dataset,
          "versions",
          version,
          "manifest.json",
        ),
      );

      if (manifest.dataset !== dataset || manifest.version !== version) {
        throw new InternalServerErrorException(
          `Invalid manifest for ${dataset}/${version}`,
        );
      }
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NotFoundException(`No published dataset named ${dataset}`);
      }
      throw error;
    }
  }

  getTileUrl(manifest: TilesetManifest, fallbackBaseUrl: string): string {
    if (this.publicBaseUrl && manifest.storageFormat !== "pmtiles") {
      return `${this.publicBaseUrl}/${manifest.tilePathTemplate}`;
    }

    // Nginx serves legacy files directly and proxies PMTiles reads to the API.
    return `${fallbackBaseUrl}/tiles/${manifest.dataset}/${manifest.version}/{z}/{x}/{y}.pbf`;
  }

  async getTile(
    dataset: string,
    version: string,
    z: number,
    x: number,
    y: number,
  ): Promise<Buffer | undefined> {
    const manifest = await this.getManifest(dataset, version);
    if (z < manifest.minzoom || z > manifest.maxzoom) return undefined;
    const directory = path.join(
      this.storageDirectory,
      dataset,
      "versions",
      version,
    );
    if (manifest.storageFormat !== "pmtiles") {
      try {
        return await readFile(
          path.join(directory, String(z), String(x), `${y}.pbf`),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    }
    const archive = path.join(directory, "tiles.pmtiles");
    const reader = new PMTiles(
      {
        getKey: () => archive,
        getBytes: async (offset, length) => {
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > 32 * 1024 * 1024
          ) {
            throw new Error("Invalid PMTiles byte range");
          }
          const handle = await open(archive, "r");
          try {
            const buffer = new Uint8Array(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return { data: buffer.slice(0, bytesRead).buffer };
          } finally {
            await handle.close();
          }
        },
      },
      this.archiveCache,
    );
    const tile = await reader.getZxy(z, x, y);
    return tile ? Buffer.from(tile.data) : undefined;
  }

  private async readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  }

  private assertSafeSegment(value: string) {
    if (!SAFE_SEGMENT.test(value)) {
      throw new InternalServerErrorException("Invalid chart storage key");
    }
  }
}
