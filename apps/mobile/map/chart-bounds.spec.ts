import assert from "node:assert/strict";
import { test } from "node:test";
import { isWithinChartBounds } from "./chart-bounds";

test("chart button requires known bounds containing the map center", () => {
  const bounds: [number, number, number, number] = [-81, 25, -80, 26];
  assert.equal(isWithinChartBounds(undefined, -80.5, 25.5), false);
  assert.equal(isWithinChartBounds(bounds, -80.5, 25.5), true);
  assert.equal(isWithinChartBounds(bounds, -81, 25), true);
  assert.equal(isWithinChartBounds(bounds, -80, 26), true);
  for (const [lon, lat] of [[-82, 25.5], [-79, 25.5], [-80.5, 24], [-80.5, 27], [NaN, 25]]) {
    assert.equal(isWithinChartBounds(bounds, lon, lat), false);
  }
});

test("supports wrapped longitudes and bounds crossing the antimeridian", () => {
  assert.equal(isWithinChartBounds([-81, 25, -80, 26], 279.5, 25.5), true);
  assert.equal(isWithinChartBounds([170, -10, -170, 10], -179, 0), true);
  assert.equal(isWithinChartBounds([170, -10, -170, 10], 179, 0), true);
  assert.equal(isWithinChartBounds([170, -10, -170, 10], 0, 0), false);
});
