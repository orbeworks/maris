import {
  validateArea,
  usesCoordinateSoundgRoute,
  withOfflineSoundings,
  type AreaBounds,
  type ChartSnapshot,
  type StyleSnapshot,
} from "./offline-style";

export const MAP_AMBIENT_CACHE_BYTES = 256 * 1024 * 1024;
export const OFFLINE_DOWNLOAD_BUDGET_BYTES = 512 * 1024 * 1024;
export const MIN_FREE_DISK_BYTES = 128 * 1024 * 1024;
export const MAX_OFFLINE_AREAS = 5;
export type PackStatus = {
  state: string;
  completedResourceSize: number;
  completedResourceCount: number;
  requiredResourceCount: number;
  percentage: number;
};
export type NativePack = {
  id: string;
  metadata: Record<string, unknown>;
  status(): Promise<PackStatus>;
  pause(): Promise<void>;
  resume(): Promise<void>;
};
export type AreaRevision = {
  id: string;
  areaId: string;
  name: string;
  bounds: AreaBounds;
  minZoom: number;
  maxZoom: number;
  createdAt: string;
  downloadedAt?: string;
  state: "downloading" | "ready" | "failed" | "removed";
  baseStyle: StyleSnapshot;
  chart: ChartSnapshot;
  packs: string[];
  styles: string[];
  size: number;
  error?: string;
};
export type DownloadOptions = {
  areaId?: string;
  name: string;
  bounds: AreaBounds;
  minZoom: number;
  maxZoom: number;
  baseStyleUrl: string;
  apiUrl: string;
};
export type OfflinePorts = {
  packs(): Promise<NativePack[]>;
  create(
    style: string,
    options: DownloadOptions,
    metadata: Record<string, unknown>,
    progress: (status: PackStatus) => void,
    error: (message: string) => void,
  ): Promise<NativePack>;
  remove(id: string): Promise<void>;
  reclaim(): Promise<void>;
  unlisten(id: string): void;
  read(): Promise<AreaRevision[]>;
  save(revision: AreaRevision): Promise<void>;
  style(id: string, style: StyleSnapshot): Promise<string>;
  deleteStyle(uri: string): Promise<void>;
  json<T>(url: string): Promise<T>;
  freeDisk(): number;
};

export function activeAreas(revisions: AreaRevision[]) {
  const result = new Map<string, AreaRevision>();
  for (const revision of revisions
    .filter((r) => r.state === "ready")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    result.set(revision.areaId, revision);
  return [...result.values()];
}

export class OfflineAreas {
  private busy = false;
  constructor(private ports: OfflinePorts) {}
  async list() {
    return this.ports.read();
  }
  async recover() {
    const packs = await this.ports.packs();
    for (const record of await this.list()) {
      if (record.state === "removed") {
        await this.erase(record);
        continue;
      }
      if (record.state !== "downloading") continue;
      const found = packs.filter((p) => p.metadata.revision === record.id);
      await Promise.all(found.map((p) => p.pause()));
      const statuses = await Promise.all(found.map((p) => p.status()));
      record.packs = found.map((p) => p.id);
      if (found.length === 2 && statuses.every((s) => s.state === "complete")) {
        record.state = "ready";
        record.downloadedAt = new Date().toISOString();
        record.size = statuses.reduce(
          (sum, s) => sum + s.completedResourceSize,
          0,
        );
      } else {
        record.state = "failed";
        record.error =
          "Download interrupted. Try again; the previous revision was preserved.";
      }
      await this.ports.save(record);
    }
    return this.list();
  }
  async isOutdated(record: AreaRevision, apiUrl: string) {
    const chart = await this.ports.json<ChartSnapshot>(
      `${apiUrl}/tiles/soundg.json`,
    );
    return (
      chart.version !== record.chart.version ||
      !usesCoordinateSoundgRoute(record.chart)
    );
  }
  async download(
    options: DownloadOptions,
    progress: (percentage: number, bytes: number) => void,
  ) {
    validateArea(options.bounds, options.minZoom, options.maxZoom);
    if (!options.name.trim()) throw new Error("Enter an area name.");
    if (this.busy) throw new Error("Wait for the current download to finish.");
    this.busy = true;
    let record: AreaRevision | undefined;
    const created: NativePack[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    try {
      const records = await this.list();
      // Failed staging packs can be discarded on retry; published revisions
      // are never deleted here, even when disk space is low.
      for (const failed of records.filter(
        (r) => r.areaId === options.areaId && r.state === "failed",
      )) {
        failed.state = "removed";
        await this.ports.save(failed);
        await this.erase(failed);
      }
      if (
        !options.areaId &&
        new Set(
          records.filter((r) => r.state !== "removed").map((r) => r.areaId),
        ).size >= MAX_OFFLINE_AREAS
      )
        throw new Error(
          "Limit of 5 areas reached. Remove an area before downloading another.",
        );
      const packs = await this.ports.packs();
      const occupied = (await Promise.all(packs.map((p) => p.status()))).reduce(
        (sum, s) => sum + s.completedResourceSize,
        0,
      );
      if (
        occupied >= OFFLINE_DOWNLOAD_BUDGET_BYTES ||
        this.ports.freeDisk() < MIN_FREE_DISK_BYTES
      )
        throw new Error(
        "Not enough storage to keep the current version and download the new one.",
        );
      const [baseStyle, chart] = await Promise.all([
        this.ports.json<StyleSnapshot>(options.baseStyleUrl),
        this.ports.json<ChartSnapshot>(`${options.apiUrl}/tiles/soundg.json`),
      ]);
      const [w, s, e, n] = options.bounds;
      if (
        w >= chart.bounds[2] ||
        e <= chart.bounds[0] ||
        s >= chart.bounds[3] ||
        n <= chart.bounds[1]
      )
        throw new Error("Area is outside the available ENC coverage.");
      for (const source of Object.values(baseStyle.sources)) {
        if (typeof source.url !== "string") continue;
        const catalog = await this.ports.json<Record<string, unknown>>(
          source.url,
        );
        delete source.url;
        Object.assign(source, catalog);
      }
      const encStyle = withOfflineSoundings(
        { version: 8, sources: {}, layers: [], glyphs: baseStyle.glyphs },
        chart,
      );
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      record = {
        id,
        areaId: options.areaId ?? id,
        name: options.name.trim(),
        bounds: options.bounds,
        minZoom: options.minZoom,
        maxZoom: options.maxZoom,
        createdAt: new Date().toISOString(),
        state: "downloading",
        baseStyle,
        chart,
        packs: [],
        styles: [],
        size: 0,
      };
      await this.ports.save(record);
      record.styles = [
        await this.ports.style(`${id}-base`, baseStyle),
        await this.ports.style(`${id}-enc`, encStyle),
      ];
      await this.ports.save(record);
      const statuses = new Map<number, PackStatus>();
      let resolve!: () => void, reject!: (error: Error) => void;
      const complete = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void complete.catch(() => {});
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };
      const watch = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            fail(
              "Download made no progress for 60 seconds. The previous version was kept.",
            ),
          60_000,
        );
      };
      watch();
      for (let index = 0; index < 2; index++) {
        const onProgress = (status: PackStatus) => {
          if (settled) return;
          const before = statuses.get(index);
          if (
            !before ||
            status.completedResourceCount > before.completedResourceCount
          )
            watch();
          statuses.set(index, status);
          const size = [...statuses.values()].reduce(
            (sum, s) => sum + s.completedResourceSize,
            0,
          );
          progress(
            [...statuses.values()].reduce((sum, s) => sum + s.percentage, 0) /
              2,
            size,
          );
          if (
            occupied + size > OFFLINE_DOWNLOAD_BUDGET_BYTES ||
            this.ports.freeDisk() < MIN_FREE_DISK_BYTES
          ) {
            fail(
              "Storage limit reached. The previous version was kept.",
            );
            return;
          }
          if (
            statuses.size === 2 &&
            [...statuses.values()].every((s) => s.state === "complete")
          ) {
            settled = true;
            resolve();
          }
        };
        const pack = await this.ports.create(
          record.styles[index],
          options,
          {
            kind: "maris-area-v2",
            revision: id,
            areaId: record.areaId,
            part: index === 0 ? "base" : "enc",
          },
          onProgress,
          fail,
        );
        created.push(pack);
        record.packs.push(pack.id);
        await this.ports.save(record);
        if (!settled) {
          await pack.resume();
          onProgress(await pack.status());
        }
      }
      await complete;
      record.state = "ready";
      record.downloadedAt = new Date().toISOString();
      record.size = [...statuses.values()].reduce(
        (sum, s) => sum + s.completedResourceSize,
        0,
      );
      await this.ports.save(record);
      return record;
    } catch (error) {
      settled = true;
      await Promise.all(created.map((p) => p.pause().catch(() => {})));
      if (record) {
        record.state = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        await this.ports.save(record);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      created.forEach((p) => this.ports.unlisten(p.id));
      this.busy = false;
    }
  }
  private async erase(record: AreaRevision) {
    const packs = await this.ports.packs();
    for (const pack of packs.filter(
      (p) => record.packs.includes(p.id) || p.metadata.revision === record.id,
    )) {
      await pack.pause();
      this.ports.unlisten(pack.id);
      await this.ports.remove(pack.id);
    }
    for (const style of record.styles) await this.ports.deleteStyle(style);
  }
  async remove(areaId: string) {
    if (this.busy)
      throw new Error("Wait for the current download to finish before removing an area.");
    for (const record of (await this.list()).filter(
      (r) => r.areaId === areaId,
    )) {
      record.state = "removed";
      await this.ports.save(record);
      await this.erase(record);
    }
    // Native deletion unpins tiles into the ambient cache. Expunge only
    // unpinned resources as well so explicit removal really releases disk.
    // Other offline packs keep their native references and are preserved.
    await this.ports.reclaim();
  }
}
