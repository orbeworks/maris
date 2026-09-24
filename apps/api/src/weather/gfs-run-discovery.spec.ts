import assert from "node:assert/strict";
import { test } from "node:test";

import { GfsService } from "./gfs.service.js";

type InventoryLookup = (hours: number[]) => Promise<unknown>;

function createService() {
  return new GfsService({
    get<T>(_key: string, fallback?: T) {
      return fallback as T;
    },
  } as never);
}

function inventoryHtml(hours: number[] = [0]) {
  const files = hours.map(
    (hour) =>
      `<option value="gfs.t00z.pgrb2.0p25.f${String(hour).padStart(3, "0")}">`,
  );
  return files.join("\n");
}

async function lookup(service: GfsService, hours: number[]) {
  return (
    service as unknown as { findCompleteInventory: InventoryLookup }
  ).findCompleteInventory(hours);
}

test("successful inventory lookups check NOMADS directly", async () => {
  const service = createService();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => inventoryHtml(),
    } as Response;
  };
  try {
    const first = await lookup(service, [0]);
    const second = await lookup(service, [0]);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("different forecast-hour requests use distinct cache entries", async () => {
  const service = createService();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => inventoryHtml([0, 3]),
    } as Response;
  };
  try {
    await lookup(service, [0]);
    await lookup(service, [3]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid inventory is not stored as a valid run", async () => {
  const service = createService();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 500, text: async () => "" } as Response;
  };
  try {
    await assert.rejects(() => lookup(service, [0]), /No complete GFS run/);
    const callsAfterFirstLookup = calls;
    await assert.rejects(() => lookup(service, [0]), /No complete GFS run/);
    assert.equal(calls, callsAfterFirstLookup * 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unavailable latest run is skipped and an older run can be used", async () => {
  const service = createService();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 500, text: async () => "" } as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => inventoryHtml(),
    } as Response;
  };
  try {
    const inventory = await lookup(service, [0]);
    assert.equal(inventory.files.size, 1);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run candidates never include a future cycle", () => {
  const service = createService();
  const candidates = (
    service as unknown as {
      candidateRuns: (now: Date) => Array<{ dateText: string; cycle: number }>;
    }
  ).candidateRuns;

  const keys = (now: string) =>
    candidates(new Date(now))
      .slice(0, 4)
      .map(
        ({ dateText, cycle }) =>
          `${dateText}/${String(cycle).padStart(2, "0")}`,
      );

  assert.deepEqual(keys("2026-09-19T07:10:00Z"), [
    "20260919/06",
    "20260919/00",
    "20260918/18",
    "20260918/12",
  ]);
  assert.deepEqual(keys("2026-09-19T12:00:00Z"), [
    "20260919/12",
    "20260919/06",
    "20260919/00",
    "20260918/18",
  ]);
  assert.deepEqual(keys("2026-09-19T05:59:59Z"), [
    "20260919/00",
    "20260918/18",
    "20260918/12",
    "20260918/06",
  ]);
  assert.deepEqual(keys("2026-09-19T00:00:00Z"), [
    "20260919/00",
    "20260918/18",
    "20260918/12",
    "20260918/06",
  ]);
});

test("current forecast resolves hour zero to the closest UTC valid time", async () => {
  const service = createService();
  const inventory = {
    run: {
      date: "20260920",
      cycle: 18,
      runAt: "2026-09-20T18:00:00.000Z",
      baseUrl: "https://example.test/gfs.20260920/18/atmos",
    },
    files: new Set([
      "gfs.t18z.pgrb2.0p25.f000",
      "gfs.t18z.pgrb2.0p25.f001",
      "gfs.t18z.pgrb2.0p25.f002",
      "gfs.t18z.pgrb2.0p25.f003",
      "gfs.t18z.pgrb2.0p25.f004",
      "gfs.t18z.pgrb2.0p25.f005",
    ]),
  };
  (
    service as unknown as {
      findCompleteInventory: () => Promise<typeof inventory>;
    }
  ).findCompleteInventory = async () => inventory;

  const current = await service.getCurrentForecast(
    new Date("2026-09-20T19:18:00-03:00"),
  );

  assert.equal(current.sourceForecastHour, 4);
  assert.equal(current.validTime, "2026-09-20T22:00:00.000Z");
});

test("current forecast breaks an exact tie toward the earlier valid time", async () => {
  const service = createService();
  const inventory = {
    run: {
      date: "20260920",
      cycle: 18,
      runAt: "2026-09-20T18:00:00.000Z",
      baseUrl: "https://example.test/gfs.20260920/18/atmos",
    },
    files: new Set(["gfs.t18z.pgrb2.0p25.f004", "gfs.t18z.pgrb2.0p25.f005"]),
  };
  (
    service as unknown as {
      findCompleteInventory: () => Promise<typeof inventory>;
    }
  ).findCompleteInventory = async () => inventory;

  const current = await service.getCurrentForecast(
    new Date("2026-09-20T22:30:00.000Z"),
  );

  assert.equal(current.sourceForecastHour, 4);
  assert.equal(current.validTime, "2026-09-20T22:00:00.000Z");
});
