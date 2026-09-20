import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OfflineAreas,
  activeAreas,
  type AreaRevision,
  type NativePack,
  type OfflinePorts,
  type PackStatus,
  type DownloadOptions,
} from "./offline-engine";
const options: DownloadOptions = {
  name: "Miami",
  bounds: [-80.2, 25.75, -80.18, 25.77],
  minZoom: 10,
  maxZoom: 16,
  baseStyleUrl: "https://test/style",
  apiUrl: "https://test",
};
function fixture() {
  const records = new Map<string, AreaRevision>();
  const packs = new Map<string, NativePack>();
  const styles = new Map<string, unknown>();
  let version = "v1",
    failure = false;
  const ports: OfflinePorts = {
    reclaim: async () => {},
    packs: async () => [...packs.values()],
    read: async () => structuredClone([...records.values()]),
    save: async (r) => {
      records.set(r.id, structuredClone(r));
    },
    freeDisk: () => 2 ** 30,
    style: async (id, style) => {
      styles.set(id, style);
      return id;
    },
    deleteStyle: async (id) => {
      styles.delete(id);
    },
    remove: async (id) => {
      packs.delete(id);
    },
    unlisten: () => {},
    json: async <T>(url: string): Promise<T> =>
      structuredClone(
        url.endsWith("/style")
          ? {
              version: 8,
              sources: {},
              layers: [],
              glyphs: "https://test/fonts/{fontstack}/{range}.pbf",
            }
          : {
              version,
              tiles: [`https://test/tiles/soundg/{z}/{x}/{y}.pbf?catalog=${version}`],
              bounds: [-81, 25, -80, 26],
              minzoom: 8,
              maxzoom: 16,
            },
      ) as T,
    async create(_style, _options, metadata, progress, error) {
      const id = `pack-${packs.size}`;
      let status: PackStatus = {
        state: "inactive",
        percentage: 0,
        completedResourceSize: 0,
        completedResourceCount: 0,
        requiredResourceCount: 4,
      };
      const pack: NativePack = {
        id,
        metadata,
        status: async () => status,
        pause: async () => {},
        resume: async () => {
          status = {
            ...status,
            state: "active",
            percentage: 50,
            completedResourceCount: 2,
            completedResourceSize: 200,
          };
          progress(status);
          if (failure && metadata.part === "enc") {
            error("simulated network failure");
            return;
          }
          status = {
            ...status,
            state: "complete",
            percentage: 100,
            completedResourceCount: 4,
            completedResourceSize: 400,
          };
          progress(status);
        },
      };
      packs.set(id, pack);
      return pack;
    },
  };
  return {
    ports,
    records,
    packs,
    styles,
    engine: new OfflineAreas(ports),
    setVersion: (v: string) => {
      version = v;
    },
    fail: () => {
      failure = true;
    },
  };
}
test("two native packs publish together; reopening reconstructs complete offline metadata without fetch", async () => {
  const f = fixture();
  const progress: number[] = [];
  const area = await f.engine.download(options, (p) => progress.push(p));
  assert.equal(area.state, "ready");
  assert.equal(area.packs.length, 2);
  assert.equal(area.size, 800);
  assert.equal(progress.at(-1), 100);
  assert.ok(area.downloadedAt);
  f.ports.json = async () => {
    throw Error("offline");
  };
  const reopened = new OfflineAreas(f.ports);
  const [saved] = activeAreas(await reopened.recover());
  assert.equal(saved.chart.version, "v1");
  assert.deepEqual(saved.bounds, options.bounds);
  assert.equal(saved.baseStyle.version, 8);
});
test("new version replaces selection only after both packs complete; failure retains previous ready revision", async () => {
  const f = fixture();
  const old = await f.engine.download(options, () => {});
  f.setVersion("v2");
  assert.equal(await f.engine.isOutdated(old, options.apiUrl), true);
  const next = await f.engine.download(
    { ...options, areaId: old.areaId },
    () => {
      assert.equal(activeAreas([...f.records.values()])[0].id, old.id);
    },
  );
  assert.equal(activeAreas(await f.engine.list())[0].id, next.id);
  for (const id of old.packs) assert.ok(f.packs.has(id));
  f.setVersion("v3");
  f.fail();
  await assert.rejects(
    f.engine.download({ ...options, areaId: old.areaId }, () => {}),
    /network failure/,
  );
  assert.equal(activeAreas(await f.engine.list())[0].id, next.id);
  assert.ok((await f.engine.list()).some((r) => r.state === "failed"));
});
test("legacy version-selected tile routes are always considered outdated", async () => {
  const f = fixture();
  const old = await f.engine.download(options, () => {});
  old.chart.tiles = ["https://test/tiles/soundg/v1/{z}/{x}/{y}.pbf"];
  assert.equal(await f.engine.isOutdated(old, options.apiUrl), true);
});
test("interrupted publication is recovered only with two complete native packs", async () => {
  const f = fixture();
  const old = await f.engine.download(options, () => {});
  const interrupted = {
    ...old,
    id: "interrupted",
    state: "downloading" as const,
    packs: [],
  };
  await f.ports.save(interrupted);
  await f.engine.recover();
  assert.equal(
    (await f.engine.list()).find((r) => r.id === "interrupted")?.state,
    "failed",
  );
  assert.equal(activeAreas(await f.engine.list())[0].id, old.id);
});
test("removal releases both packs and style files for all revisions; storage limit preserves old area", async () => {
  const f = fixture();
  const old = await f.engine.download(options, () => {});
  f.ports.freeDisk = () => 1;
  await assert.rejects(
    f.engine.download({ ...options, areaId: old.areaId }, () => {}),
    /Not enough storage/,
  );
  assert.equal(activeAreas(await f.engine.list()).length, 1);
  await f.engine.remove(old.areaId);
  assert.equal(f.packs.size, 0);
  assert.equal(f.styles.size, 0);
  assert.equal(activeAreas(await f.engine.list()).length, 0);
});
