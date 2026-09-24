import assert from "node:assert/strict";
import { test } from "node:test";

import { scaleDivisionPercentages } from "./scale-ruler-layout";

test("scale labels are anchored at every exact segment boundary", () => {
  assert.deepEqual(scaleDivisionPercentages(1), [0, 100]);
  assert.deepEqual(scaleDivisionPercentages(2), [0, 50, 100]);
  const thirds = scaleDivisionPercentages(3);
  assert.equal(thirds.length, 4);
  thirds.forEach((position, index) => {
    assert.ok(Math.abs(position - (index * 100) / 3) < 1e-12);
  });
});
