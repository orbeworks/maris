import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  sampleGridAtCoordinate,
  type GfsBounds,
  type GfsGrid,
  type GfsPackage,
  type MapCenter,
  type SampledGfsValues,
} from './gfs-grid';
import { decodeGfsTile } from './gfs-tile-codec';
import { GfsTileMemoryStore } from './gfs-tile-memory';
import { mergeGfsTiles } from './gfs-tile-merge';
import {
  tileForCoordinate,
  tileKey,
  type GfsTileCoordinate,
} from './gfs-tiles';
import {
  DEFAULT_MAX_FIELD_DIMENSION,
  sourceZoomForViewport,
} from './gfs-zoom';

const REQUEST_DEBOUNCE_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_RETRY_DELAY_MS = 2_000;
const TILE_CACHE_TTL_MS = 30 * 60 * 1_000;
const CACHE_ROOT = new Directory(Paths.document, 'gfs-weather-tiles');

type GfsPerfCounter = 'mergeTiles' | 'packageFromTiles';
const gfsPerf = {
  lastLogAt: Date.now(),
  mergeTiles: 0,
  packageFromTiles: 0,
};

export function recordGfsPerf(counter: GfsPerfCounter) {
  if (!__DEV__) return;
  gfsPerf[counter] += 1;
  const now = Date.now();
  if (now - gfsPerf.lastLogAt < 1_000) return;
  console.debug('[GFS perf]', {
    mergeTilesPerSecond: gfsPerf.mergeTiles,
    packageFromTilesPerSecond: gfsPerf.packageFromTiles,
  });
  gfsPerf.mergeTiles = 0;
  gfsPerf.packageFromTiles = 0;
  gfsPerf.lastLogAt = now;
}

type CachedTile = {
  tile: GfsTileCoordinate;
  forecastHour: number;
  grid: GfsGrid;
  savedAt: number;
  etag?: string;
  source: 'cache' | 'network';
};

type ViewportJob = {
  key: string;
  tiles: GfsTileCoordinate[];
  center: GfsTileCoordinate | null;
  sourceZoom: number;
};

function prioritizeViewportTiles(
  tiles: GfsTileCoordinate[],
  center: MapCenter | null | undefined,
) {
  if (!center) return tiles;
  const centerTile = tileForCoordinate(center[0], center[1], tiles[0]?.z ?? 0);
  const tileCount = 2 ** centerTile.z;
  const wrappedDistance = (a: number, b: number) => {
    const direct = Math.abs(a - b);
    return Math.min(direct, tileCount - direct);
  };
  return [...tiles].sort((left, right) => {
    // Chebyshev distance creates square/concentric rings around the center:
    // center tile, immediate neighbors, then progressively farther edges.
    const leftRing = Math.max(wrappedDistance(left.x, centerTile.x), Math.abs(left.y - centerTile.y));
    const rightRing = Math.max(wrappedDistance(right.x, centerTile.x), Math.abs(right.y - centerTile.y));
    const leftDistance = wrappedDistance(left.x, centerTile.x) + Math.abs(left.y - centerTile.y);
    const rightDistance = wrappedDistance(right.x, centerTile.x) + Math.abs(right.y - centerTile.y);
    return leftRing - rightRing || leftDistance - rightDistance || left.y - right.y || left.x - right.x;
  });
}

function validBounds(bounds: GfsBounds | null | undefined): bounds is GfsBounds {
  return Boolean(bounds) &&
    [bounds!.north, bounds!.south, bounds!.east, bounds!.west].every(Number.isFinite) &&
    bounds!.north > bounds!.south;
}

function filePrefix(tile: GfsTileCoordinate, forecastHour: number) {
  return `f${forecastHour}-z${tile.z}-x${tile.x}-y${tile.y}-`;
}

function etagFromFileName(name: string) {
  const match = /-([0-9a-f]{64})\.bin$/i.exec(name);
  return match?.[1] ? `"${match[1]}"` : undefined;
}

class GfsTileStore {
  private initialized = false;
  private memory = new GfsTileMemoryStore<CachedTile>();
  private inFlight = new Map<string, Promise<CachedTile>>();

  private addressKey(tile: GfsTileCoordinate, forecastHour: number) {
    return tileKey(tile, forecastHour);
  }

  private recordKey(tile: GfsTileCoordinate, forecastHour: number, run: string) {
    return `${run}|${tileKey(tile, forecastHour)}`;
  }

  private put(tile: GfsTileCoordinate, forecastHour: number, grid: GfsGrid,
    savedAt: number, source: CachedTile['source'], etag?: string) {
    const value = { tile, forecastHour, grid, savedAt, etag, source };
    return this.memory.upsert(
      this.addressKey(tile, forecastHour),
      this.recordKey(tile, forecastHour, grid.run),
      value,
    );
  }

  setActiveViewport(tiles: GfsTileCoordinate[], forecastHour: number) {
    this.memory.setActiveAddresses(tiles.map((tile) => this.addressKey(tile, forecastHour)));
  }

  snapshot(tiles: GfsTileCoordinate[], forecastHour: number) {
    return tiles
      .map((tile) => this.memory.getLatest(this.addressKey(tile, forecastHour)))
      .filter((tile): tile is CachedTile => tile !== undefined);
  }

  async initialize() {
    if (this.initialized) return;
    CACHE_ROOT.create({ idempotent: true, intermediates: true });
    this.initialized = true;
  }

  async read(tile: GfsTileCoordinate, forecastHour: number): Promise<CachedTile | null> {
    await this.initialize();
    const key = this.addressKey(tile, forecastHour);
    const memory = this.memory.getLatest(key);
    if (memory) return memory;
    const prefix = filePrefix(tile, forecastHour);
    const file = CACHE_ROOT.list()
      .filter((entry): entry is File =>
        entry instanceof File && entry.name.startsWith(prefix) && entry.name.endsWith('.bin'))
      .sort((left, right) => (right.modificationTime ?? 0) - (left.modificationTime ?? 0))[0];
    if (!file) return null;
    try {
      const grid = decodeGfsTile(await file.bytes());
      return this.put(
        tile,
        forecastHour,
        grid,
        file.modificationTime ?? Date.now(),
        'cache',
        etagFromFileName(file.name),
      );
    } catch {
      return null;
    }
  }

  async fetch(apiUrl: string, tile: GfsTileCoordinate, forecastHour: number, signal?: AbortSignal) {
    const key = this.addressKey(tile, forecastHour);
    const cached = await this.read(tile, forecastHour);
    if (cached && Date.now() - cached.savedAt < TILE_CACHE_TTL_MS) return cached;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
      const query = new URLSearchParams({ forecastHour: String(forecastHour) });
      const url = `${apiUrl.replace(/\/$/, '')}/weather/gfs/tiles/${tile.z}/${tile.x}/${tile.y}?${query}`;
      const requestSignal = signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let response = await fetch(url, {
        headers: cached?.etag ? { 'If-None-Match': cached.etag } : undefined,
        signal: requestSignal,
      });
      if (response.status === 304) {
        if (cached) {
          return this.put(tile, forecastHour, cached.grid, Date.now(), 'cache', cached.etag);
        }

        // A CDN/proxy may revalidate upstream and return 304 even though this
        // process has no local body. Never leave the tile in an endless retry
        // loop: retry once without a validator and require the payload.
        response = await fetch(url, {
          headers: { 'Cache-Control': 'no-cache' },
          signal: requestSignal,
        });
        if (response.status === 304) {
          throw new Error('GFS tile returned 304 without a cached payload after unconditional retry');
        }
      }
      if (!response.ok) throw new Error(`GFS tile request failed: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const grid = decodeGfsTile(bytes);
      if (grid.width < 2 || grid.height < 2 || grid.forecastHour !== forecastHour) {
        throw new Error('Invalid GFS tile response');
      }
      await this.initialize();
      const etag = response.headers.get('etag') ?? undefined;
      const file = new File(
        CACHE_ROOT,
        `${filePrefix(tile, forecastHour)}${grid.run.replace(/[^0-9A-Za-z]/g, '')}-${etag?.replace(/[^0-9a-f]/gi, '') ?? 'noetag'}.bin`,
      );
      file.create({ overwrite: true, intermediates: true });
      await file.write(bytes);
      return this.put(tile, forecastHour, grid, Date.now(), 'network', etag);
      } catch (error) {
        throw error;
      }
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}

export const gfsTileStore = new GfsTileStore();

function packageRun(run: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(run);
  const date = match?.[1]?.replaceAll('-', '') ?? run.slice(0, 8);
  const cycle = Number(match?.[2] ?? 0);
  return { date, cycle, run, runAt: run };
}

function packageFromTiles(tiles: CachedTile[]): GfsPackage | null {
  recordGfsPerf('packageFromTiles');
  if (tiles.length > 1) {
    const newestRun = [...tiles].sort((left, right) => right.savedAt - left.savedAt)[0]!.grid.run;
    tiles = tiles.filter((item) => item.grid.run === newestRun);
  }
  recordGfsPerf('mergeTiles');
  const grid = mergeGfsTiles(tiles);
  if (!grid) return null;
  return {
    model: 'gfs',
    run: packageRun(grid.run),
    resolution: grid.resolution,
    bounds: grid.bounds,
    forecastHours: [grid.forecastHour],
    availableForecastHours: [grid.forecastHour],
    grids: { [String(grid.forecastHour)]: grid },
  };
}

export async function fetchGfsTile(apiUrl: string, tile: GfsTileCoordinate, forecastHour = 0, signal?: AbortSignal) {
  return gfsTileStore.fetch(apiUrl, tile, forecastHour, signal);
}

export type GfsSample = SampledGfsValues & { forecastTime: string; forecastHour: number };

export function sampleGfsPackageAtCoordinate(packageData: GfsPackage | null | undefined, coordinate: MapCenter | null | undefined): GfsSample[] {
  if (!packageData || !coordinate) return [];
  return packageData.forecastHours.map((forecastHour) => {
    const grid = packageData.grids[String(forecastHour)];
    if (!grid) return null;
    const sampled = sampleGridAtCoordinate(grid, coordinate[1], coordinate[0]);
    return sampled ? { ...sampled, forecastTime: grid.forecastTime, forecastHour } : null;
  }).filter((sample): sample is GfsSample => sample !== null);
}

export function useGfsViewport(
  apiUrl: string,
  bounds: GfsBounds | null,
  coordinate: MapCenter | null,
  zoom = 10,
  enabled = true,
  qualityPenalty = 0,
  maxFieldDimension = DEFAULT_MAX_FIELD_DIMENSION,
) {
  const [tilesVersion, setTilesVersion] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string>();
  const [cachedAt, setCachedAt] = useState<number>();
  const selectedSource = useMemo(
    () => sourceZoomForViewport(bounds, zoom, qualityPenalty, maxFieldDimension),
    [bounds?.north, bounds?.south, bounds?.east, bounds?.west, maxFieldDimension, qualityPenalty, zoom],
  );
  const sourceZoom = selectedSource.sourceZoom;
  const activeJob = useRef<ViewportJob | null>(null);
  const pendingJob = useRef<ViewportJob | null>(null);
  const queueRevision = useRef(0);
  const retryWaiters = useRef(new Set<() => void>());
  const completedKey = useRef<string | undefined>(undefined);
  const queueRunning = useRef(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const foreground = useRef(AppState.currentState === 'active');
  const mounted = useRef(true);
  const coordinateRef = useRef(coordinate);
  coordinateRef.current = coordinate;

  const waitBeforeRetry = useCallback((revision: number) => {
    if (revision !== queueRevision.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (canRetry: boolean) => {
        if (timer) clearTimeout(timer);
        retryWaiters.current.delete(wake);
        resolve(canRetry && revision === queueRevision.current);
      };
      const wake = () => finish(false);
      retryWaiters.current.add(wake);
      timer = setTimeout(() => finish(true), REQUEST_RETRY_DELAY_MS);
    });
  }, []);

  const runQueue = useCallback(async () => {
    if (queueRunning.current) return;
    const job = pendingJob.current;
    if (!job) return;

    pendingJob.current = null;
    activeJob.current = job;
    const jobRevision = queueRevision.current;
    queueRunning.current = true;
    if (mounted.current) {
      setLoading(true);
      setError(undefined);
    }

    const loaded: CachedTile[] = [];
    try {
      // Deliberately fetch one tile at a time. The center tile is first so the
      // HUD can become useful before the rest of a large viewport is loaded.
      for (const tile of job.tiles) {
        // A viewport change never aborts the request already in progress, but
        // it clears the remaining old tiles from this job. The pending job
        // contains only the newest viewport and starts after this request.
        if (jobRevision !== queueRevision.current) break;
        let result: CachedTile | undefined;
        let abandoned = false;
        while (jobRevision === queueRevision.current) {
          try {
            result = await fetchGfsTile(apiUrl, tile, 0);
            break;
          } catch {
            // Retry indefinitely every two seconds while this viewport remains
            // current. A newer viewport wakes this wait immediately.
            if (!(await waitBeforeRetry(jobRevision))) {
              abandoned = true;
              break;
            }
          }
        }
        if (abandoned || jobRevision !== queueRevision.current) break;
        if (!result) break;
        loaded.push(result);
        if (mounted.current) {
          setTilesVersion((version) => version + 1);
          setCachedAt((previous) => Math.max(previous ?? 0, result!.savedAt));
          setOffline(result.source === 'cache');
        }
      }

      if (jobRevision === queueRevision.current) {
        const centerLoaded = job.center
          ? loaded.some((item) => item.tile.x === job.center!.x && item.tile.y === job.center!.y)
          : loaded.length > 0;
        if (!centerLoaded && mounted.current) {
          setError('GFS coverage unavailable');
        }
        completedKey.current = job.key;
      }
    } finally {
      activeJob.current = null;
      queueRunning.current = false;
      if (mounted.current) {
        setLoading(Boolean(pendingJob.current));
      }
      if (pendingJob.current) void runQueue();
    }
  }, [apiUrl]);

  const enqueueViewport = useCallback((job: ViewportJob) => {
    if (
      activeJob.current?.key === job.key ||
      pendingJob.current?.key === job.key ||
      completedKey.current === job.key
    ) return;
    // Keep only the newest viewport while the current request finishes. This
    // prevents a rapid pan from building a backlog of obsolete regions. The
    // active tile request is deliberately allowed to finish; the revision
    // makes the remaining tiles of the old job obsolete.
    if (activeJob.current?.key !== job.key || pendingJob.current?.key !== job.key) {
      queueRevision.current += 1;
      for (const wake of retryWaiters.current) wake();
    }
    pendingJob.current = job;
    void runQueue();
  }, [runQueue]);

  useEffect(() => {
    if (!enabled || !validBounds(bounds) || !foreground.current) return;
    const requestedTiles = prioritizeViewportTiles(selectedSource.tiles, coordinateRef.current);
    gfsTileStore.setActiveViewport(requestedTiles, 0);
    const key = requestedTiles.map((tile) => tileKey(tile, 0)).join('|');
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      debounce.current = undefined;
      enqueueViewport({
        key,
        tiles: requestedTiles,
        center: coordinateRef.current ? tileForCoordinate(coordinateRef.current[0], coordinateRef.current[1], sourceZoom) : null,
        sourceZoom,
      });
    }, REQUEST_DEBOUNCE_MS);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [apiUrl, bounds?.north, bounds?.south, bounds?.east, bounds?.west, enabled, enqueueViewport, selectedSource, sourceZoom]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      foreground.current = state === 'active';
      if (foreground.current) completedKey.current = undefined;
    });
    return () => {
      subscription.remove();
      if (debounce.current) clearTimeout(debounce.current);
      gfsTileStore.setActiveViewport([], 0);
      mounted.current = false;
    };
  }, []);

  const computedRequestedTiles = selectedSource.tiles;
  const computedRequestedKey = computedRequestedTiles
    .map((tile) => tileKey(tile, 0))
    .join('|');
  const stableTiles = useRef<{ key: string; tiles: GfsTileCoordinate[] }>({
    key: '',
    tiles: [],
  });
  if (stableTiles.current.key !== computedRequestedKey) {
    stableTiles.current = { key: computedRequestedKey, tiles: computedRequestedTiles };
  }
  const requestedTiles = stableTiles.current.tiles;
  const activeCachedTiles = useMemo(() => {
    void tilesVersion;
    return gfsTileStore.snapshot(requestedTiles, 0);
  }, [computedRequestedKey, tilesVersion]);
  const composedPackage = useMemo(() => packageFromTiles(activeCachedTiles), [activeCachedTiles]);
  const activeTiles = useMemo(() => {
    if (activeCachedTiles.length <= 1) return activeCachedTiles.map((item) => item.grid);
    const newestRun = [...activeCachedTiles]
      .sort((left, right) => right.savedAt - left.savedAt)[0]!.grid.run;
    return activeCachedTiles
      .filter((item) => item.grid.run === newestRun)
      .map((item) => item.grid);
  }, [activeCachedTiles]);
  const activeTileEntries = useMemo(() => {
    if (activeCachedTiles.length <= 1) return activeCachedTiles;
    const newestRun = [...activeCachedTiles]
      .sort((left, right) => right.savedAt - left.savedAt)[0]!.grid.run;
    return activeCachedTiles.filter((item) => item.grid.run === newestRun);
  }, [activeCachedTiles]);
  const displayedPackage = useRef<GfsPackage | null>(null);
  if (composedPackage) displayedPackage.current = composedPackage;
  const packageData = composedPackage ?? displayedPackage.current;
  const samples = useMemo(() => sampleGfsPackageAtCoordinate(packageData, coordinate), [packageData, coordinate?.[0], coordinate?.[1]]);
  return {
    packageData,
    activeTiles,
    activeTileEntries,
    samples,
    current: samples.find((sample) => sample.forecastHour === 0),
    loading: enabled && loading && !packageData,
    offline,
    error,
    cachedAt,
  };
}
