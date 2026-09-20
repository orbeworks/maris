import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createRequire } from 'node:module';
import vtpbf from 'vt-pbf';

import { ChartSelection } from '../charts/models/chart-selection.js';
import { ChartCatalogService } from '../ingestions/services/chart-catalog.service.js';
import type { TileJsonDto } from './dtos/tile-json.dto.js';
import {
  CHART_STORAGE,
  type ChartStorage,
} from './storage/chart-storage.js';

type DecodedFeature = {
  extent: number;
  id?: number;
  loadGeometry(): Array<Array<{ x: number; y: number }>>;
  properties: Record<string, number | string | boolean>;
  type: number;
};
type DecodedLayer = { feature(index: number): DecodedFeature; length: number };
const require = createRequire(import.meta.url);
const vtpbfEntry = require.resolve('vt-pbf');
const { VectorTile } = require(require.resolve('@mapbox/vector-tile', {
  paths: [vtpbfEntry],
})) as { VectorTile: new (pbf: unknown) => { layers: Record<string, DecodedLayer> } };
const Pbf = require(require.resolve('pbf', { paths: [vtpbfEntry] })) as new (
  bytes: Uint8Array,
) => unknown;

@Injectable()
export class TilesService {
  private readonly selectionCache = new Map<number, Promise<ChartSelection>>();
  constructor(
    @Inject(CHART_STORAGE)
    private readonly chartStorage: ChartStorage,
    @Inject(ChartCatalogService)
    private readonly catalog: ChartCatalogService,
  ) {}

  async getLatestTile(z: string, x: string, y: string): Promise<Buffer | undefined> {
    const latest = await this.catalog.getPublishedCatalog('soundg');
    if (!latest) throw new NotFoundException('No published SOUNDG catalog');
    return this.getTile(`catalog-${latest.revision}`, z, x, y);
  }

  async getTile(version: string, z: string, x: string, y: string): Promise<Buffer | undefined> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(version) || ![z, x, y].every((v) => /^\d{1,10}$/.test(v))) {
      throw new BadRequestException('Invalid tile coordinates or version');
    }
    const zoom = Number(z), column = Number(x), row = Number(y);
    if (zoom > 16 || column >= 2 ** zoom || row >= 2 ** zoom) throw new BadRequestException('Invalid tile coordinates');
    const catalogMatch = /^catalog-(\d+)$/.exec(version);
    if (!catalogMatch) {
      try {
        return await this.chartStorage.getTile('soundg', version, zoom, column, row);
      } catch (error) {
        // Old app/offline snapshots may still contain an ingestion UUID whose
        // artifact has already been retired. Resolve those URLs through the
        // current catalog so installed clients do not need a binary update.
        if (
          error instanceof NotFoundException &&
          this.catalog.getPublishedCatalog
        ) {
          return this.getLatestTile(z, x, y);
        }
        throw error;
      }
    }
    const revision = Number(catalogMatch[1]);
    const catalog = await this.catalog.getPublishedCatalog('soundg', revision);
    if (!catalog || catalog.revision !== revision) {
      throw new NotFoundException('Published chart catalog revision not found');
    }
    const tileBounds = this.tileBounds(zoom, column, row);
    const shards = catalog.shards.filter((shard) =>
      this.boundsIntersect(shard.bounds, tileBounds),
    );
    const tiles = (await Promise.all(
      shards.map((shard) =>
        this.chartStorage.getTile('soundg', shard.shardKey, zoom, column, row),
      ),
    )).filter((tile): tile is Buffer => Boolean(tile));
    if (tiles.length === 0) return undefined;
    const selection = await this.selectionForRevision(revision);
    return this.composeTiles(tiles, selection, zoom, column, row);
  }

  async getTileJson(baseUrl: string): Promise<TileJsonDto> {
    const catalog = this.catalog.getPublishedCatalog
      ? await this.catalog.getPublishedCatalog('soundg')
      : null;
    if (catalog) {
      const bounds = catalog.shards.reduce<[number, number, number, number]>(
        (result, shard) => [
          Math.min(result[0], shard.bounds[0]),
          Math.min(result[1], shard.bounds[1]),
          Math.max(result[2], shard.bounds[2]),
          Math.max(result[3], shard.bounds[3]),
        ],
        [Infinity, Infinity, -Infinity, -Infinity],
      );
      const version = `catalog-${catalog.revision}`;
      return {
        bounds,
        maxzoom: 16,
        minzoom: 8,
        name: 'Marine SOUNDG',
        scheme: 'xyz',
        tilejson: '3.0.0',
        tiles: [`${baseUrl}/tiles/soundg/{z}/{x}/{y}.pbf?empty=204-v2`],
        vector_layers: [{
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
          maxzoom: 16,
          minzoom: 8,
        }],
        version,
      };
    }
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

  private async selectionForRevision(revision: number) {
    const cached = this.selectionCache.get(revision);
    if (cached) return cached;
    const loading = this.catalog.getPublishedCells('soundg', revision)
      .then((cells) => new ChartSelection(cells));
    this.selectionCache.set(revision, loading);
    while (this.selectionCache.size > 4) {
      const oldest = this.selectionCache.keys().next().value as number | undefined;
      if (oldest !== undefined && oldest !== revision) this.selectionCache.delete(oldest);
      else break;
    }
    try {
      return await loading;
    } catch (error) {
      this.selectionCache.delete(revision);
      throw error;
    }
  }

  private composeTiles(
    tiles: Buffer[],
    selection: ChartSelection,
    z: number,
    x: number,
    y: number,
  ) {
    const features: Array<{
      id?: number;
      type: number;
      geometry: number[][];
      tags: Record<string, number | string | boolean>;
    }> = [];
    for (const bytes of tiles) {
      const layer = new VectorTile(new Pbf(bytes)).layers.soundings;
      if (!layer) continue;
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        if (feature.type !== 1) continue;
        const geometry = feature.loadGeometry();
        const point = geometry[0]?.[0];
        if (!point) continue;
        const coordinate = this.tilePointToLonLat(
          z, x, y, point.x, point.y, feature.extent,
        );
        const selected = selection.at(coordinate);
        if (
          !selected ||
          selected.name !== feature.properties.SOURCE_CELL ||
          String(selected.edition ?? '') !== String(feature.properties.SOURCE_EDITION ?? '') ||
          selected.updateNumber !== Number(feature.properties.SOURCE_UPDATE ?? 0)
        ) continue;
        features.push({
          ...(feature.id === undefined ? {} : { id: feature.id }),
          type: feature.type,
          geometry: geometry.flatMap((ring) =>
            ring.map((candidate) => [candidate.x, candidate.y]),
          ),
          tags: feature.properties,
        });
      }
    }
    if (features.length === 0) return undefined;
    return Buffer.from(vtpbf.fromGeojsonVt({
      soundings: { features, extent: 4096, name: 'soundings', length: features.length },
    } as never));
  }

  private tilePointToLonLat(
    z: number,
    x: number,
    y: number,
    pointX: number,
    pointY: number,
    extent: number,
  ): [number, number] {
    const scale = 2 ** z;
    const worldX = (x + pointX / extent) / scale;
    const worldY = (y + pointY / extent) / scale;
    return [
      worldX * 360 - 180,
      Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI,
    ];
  }

  private tileBounds(z: number, x: number, y: number): [number, number, number, number] {
    const scale = 2 ** z;
    const longitude = (column: number) => column / scale * 360 - 180;
    const latitude = (row: number) =>
      Math.atan(Math.sinh(Math.PI * (1 - 2 * row / scale))) * 180 / Math.PI;
    return [longitude(x), latitude(y + 1), longitude(x + 1), latitude(y)];
  }

  private boundsIntersect(
    left: [number, number, number, number],
    right: [number, number, number, number],
  ) {
    return left[0] <= right[2] && left[2] >= right[0] &&
      left[1] <= right[3] && left[3] >= right[1];
  }
}
