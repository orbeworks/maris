import { PMTiles, SharedPromiseCache } from 'pmtiles';

import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { ObjectStorageService } from '../../storage/object-storage.service.js';
import type { ChartStorage, TilesetManifest } from './chart-storage.js';

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

@Injectable()
export class ObjectChartStorageService implements ChartStorage {
  private readonly archiveCache = new SharedPromiseCache(64);
  private readonly manifestCache = new Map<string, Promise<TilesetManifest>>();

  constructor(private readonly objects: ObjectStorageService) {}

  async getManifest(dataset: string, version: string): Promise<TilesetManifest> {
    this.assertSafeSegment(dataset);
    this.assertSafeSegment(version);
    const key = this.key(dataset, version, 'manifest.json');
    let loading = this.manifestCache.get(key);
    if (!loading) {
      loading = this.loadManifest(key, dataset, version);
      this.manifestCache.set(key, loading);
      if (this.manifestCache.size > 64) {
        const oldest = this.manifestCache.keys().next().value as string | undefined;
        if (oldest && oldest !== key) this.manifestCache.delete(oldest);
      }
    }
    try {
      return await loading;
    } catch (error) {
      // Every waiter must normalize a shared S3 rejection. Only remove this
      // exact promise so an older waiter cannot evict a newer retry.
      if (this.manifestCache.get(key) === loading) this.manifestCache.delete(key);
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === 'NoSuchKey') {
        throw new NotFoundException(`No published dataset named ${dataset}`);
      }
      throw error;
    }
  }

  private async loadManifest(key: string, dataset: string, version: string) {
    const manifest = JSON.parse(await this.objects.getText(key)) as TilesetManifest;
    if (manifest.dataset !== dataset || manifest.version !== version) {
      throw new InternalServerErrorException(`Invalid manifest for ${dataset}/${version}`);
    }
    return manifest;
  }

  getTileUrl(manifest: TilesetManifest, fallbackBaseUrl: string): string {
    return `${fallbackBaseUrl}/tiles/${manifest.dataset}/${manifest.version}/{z}/{x}/{y}.pbf`;
  }

  async getTile(dataset: string, version: string, z: number, x: number, y: number) {
    const manifest = await this.getManifest(dataset, version);
    if (z < manifest.minzoom || z > manifest.maxzoom) return undefined;
    if (manifest.storageFormat !== 'pmtiles') {
      throw new InternalServerErrorException('S3 chart storage requires PMTiles artifacts');
    }
    const archiveKey = this.key(dataset, version, 'tiles.pmtiles');
    const reader = new PMTiles({
      getKey: () => `s3://${archiveKey}`,
      getBytes: (offset, length, signal) => this.objects.getRange(archiveKey, offset, length, signal),
    }, this.archiveCache);
    const tile = await reader.getZxy(z, x, y);
    return tile ? Buffer.from(tile.data) : undefined;
  }

  private key(dataset: string, version: string, filename: string) {
    return `datasets/${dataset}/${version}/${filename}`;
  }

  private assertSafeSegment(value: string) {
    if (!SAFE_SEGMENT.test(value)) throw new InternalServerErrorException('Invalid chart storage key');
  }
}
