import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveHeading,
  smoothHeading,
} from "../location/navigation-heading";

test("heading prefers reliable true heading and falls back to magnetic heading", () => {
  assert.equal(resolveHeading(82, 25), 82);
  assert.equal(resolveHeading(-1, 25), 25);
  assert.equal(resolveHeading(null, 25), 25);
  assert.equal(resolveHeading(370, 25), 10);
  assert.equal(resolveHeading(82, 25), 82);
  assert.equal(resolveHeading(null, null), null);
});

test("heading smoothing follows the shortest path across north", () => {
  assert.ok(Math.abs(smoothHeading(359, 1, 0.2) - 359.4) < 1e-9);
  assert.ok(Math.abs(smoothHeading(1, 359, 0.2) - 0.6) < 1e-9);
});
