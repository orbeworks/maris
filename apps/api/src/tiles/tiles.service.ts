import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ChartCatalogService } from '../ingestions/services/chart-catalog.service.js';
import type { TileJsonDto } from './dtos/tile-json.dto.js';
import {
  CHART_STORAGE,
  type ChartStorage,
} from './storage/chart-storage.js';

@Injectable()
export class TilesService {
  constructor(
    @Inject(CHART_STORAGE)
    private readonly chartStorage: ChartStorage,
    @Inject(ChartCatalogService)
    private readonly catalog: ChartCatalogService,
  ) {}

  async getTile(version: string, z: string, x: string, y: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(version) || ![z, x, y].every((v) => /^\d{1,10}$/.test(v))) {
      throw new BadRequestException('Invalid tile coordinates or version');
    }
    const zoom = Number(z), column = Number(x), row = Number(y);
    if (zoom > 16 || column >= 2 ** zoom || row >= 2 ** zoom) throw new BadRequestException('Invalid tile coordinates');
    return this.chartStorage.getTile('soundg', version, zoom, column, row);
  }

  async getTileJson(baseUrl: string): Promise<TileJsonDto> {
    const active = await this.catalog.getActiveVersion('soundg');
    if (!active) throw new NotFoundException('No published SOUNDG version');
    const manifest = await this.chartStorage.getManifest(
      'soundg',
      active.version_key,
    );
    // A new cache key bypasses legacy immutable 404s without changing artifacts
    // or deleting offline packs using the original versioned URLs.
    const tileUrl = this.chartStorage.getTileUrl(manifest, baseUrl);
    const tileUrlWithEmptyPolicy = `${tileUrl}${tileUrl.includes('?') ? '&' : '?'}empty=204-v1`;

    return {
      bounds: manifest.bounds,
      maxzoom: manifest.maxzoom,
      minzoom: manifest.minzoom,
      name: manifest.name,
      scheme: 'xyz',
      tilejson: '3.0.0',
      tiles: [tileUrlWithEmptyPolicy],
      vector_layers: manifest.vectorLayers,
      version: manifest.version,
    };
  }
}
