import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { encodeGfsTile } from "./gfs-tile-codec.js";

test("measures the 10 degree tile representations at GFS 0.25 degrees", () => {
  const count = 41 * 41;
  const values = (scale: number) =>
    Array.from({ length: count }, (_, index) =>
      index % 17 === 0 ? null : scale + index / 100,
    );
  const grid = {
    model: "gfs" as const,
    run: "2026-09-18T12:00:00Z",
    forecastTime: "2026-09-18T12:00:00Z",
    forecastHour: 0,
    resolution: 0.25 as const,
    bounds: { north: -20, south: -30, east: -40, west: -50 },
    width: 41,
    height: 41,
    gridOrder: "north-to-south,west-to-east" as const,
    longitudeConvention: "-180..180" as const,
    units: {
      wind: "m/s" as const,
      temperature: "K" as const,
      precipitation: "kg/m2" as const,
      precipitationRate: "kg/m2/s" as const,
      cloudCover: "%" as const,
      pressure: "Pa" as const,
      gust: "m/s" as const,
      humidity: "%" as const,
    },
    fields: {
      windU: values(1),
      windV: values(2),
      temperature: values(273),
      precipitationRate: values(0.001),
      cloudCover: values(50),
      pressure: values(101_000),
      gust: values(4),
      humidity: values(70),
    },
  };
  const json = Buffer.from(JSON.stringify(grid));
  const jsonGzip = gzipSync(json);
  const binary = encodeGfsTile(grid);
  const binaryGzip = gzipSync(binary);
  console.log(
    JSON.stringify({
      "10x10@0.25": {
        json: json.length,
        jsonGzip: jsonGzip.length,
        binary: binary.length,
        binaryGzip: binaryGzip.length,
      },
    }),
  );
  assert.ok(binary.length < json.length);
  assert.ok(binaryGzip.length < binary.length);
});
