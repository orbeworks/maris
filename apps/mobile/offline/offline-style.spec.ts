import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateArea,
  withOfflineSoundings,
  type ChartSnapshot,
  type StyleSnapshot,
} from "./offline-style";

const chart: ChartSnapshot = {
  version: "v1",
  tiles: ["https://example.test/tiles/soundg/{z}/{x}/{y}.pbf?catalog=v1"],
  bounds: [-81, 25, -80, 26],
  minzoom: 8,
  maxzoom: 16,
};
const style: StyleSnapshot = { version: 8, sources: {}, layers: [] };
test("offline snapshot contains a pinned ENC source and required font, without changing input", () => {
  const result = withOfflineSoundings(style, chart);
  assert.deepEqual(result.sources["offline-soundg"].tiles, chart.tiles);
  assert.equal(result.sources["offline-soundg"].url, undefined);
  assert.equal(style.layers.length, 0);
  assert.equal(result.layers[0]["source-layer"], "soundings");
});
test("rejects version-selected chart urls and invalid download bounds", () => {
  assert.throws(() =>
    withOfflineSoundings(style, {
      ...chart,
      tiles: ["https://example.test/tiles/soundg/v1/{z}/{x}/{y}.pbf"],
    }),
  );
  assert.throws(() => validateArea([0, 0, 0, 1], 0, 16));
  assert.throws(() => validateArea([-81, 25, -80, 26], 0, 20));
  assert.doesNotThrow(() => validateArea([-81, 25, -80, 26], 10, 16));
});
