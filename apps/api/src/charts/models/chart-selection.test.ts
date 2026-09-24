import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChartSelection,
  coversPoint,
  type CoverageCell,
} from "./chart-selection.js";

const square = (w: number, s: number, e: number, n: number) => ({
  type: "Polygon",
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});
const cell = (
  name: string,
  scale: number,
  overrides: Partial<CoverageCell> = {},
): CoverageCell => ({
  name,
  compilationScale: scale,
  edition: "1",
  updateNumber: 0,
  issueDate: "2020-01-01",
  updateApplicationDate: "2020-01-01",
  coverages: [{ category: 1, geometry: square(-81, 25, -79, 27) }],
  ...overrides,
});

test("latest edition/updates of a cell precede detail selection between different cells", () => {
  const selection = new ChartSelection([
    cell("harbor", 1000, { edition: "1", updateNumber: 9 }),
    cell("harbor", 22000, { edition: "2", updateNumber: 0 }),
    cell("harbor", 22000, { edition: "2", updateNumber: 1 }),
    cell("coastal", 80000, {
      issueDate: "2026-01-01",
      updateApplicationDate: "2026-01-01",
    }),
  ]);
  assert.equal(selection.at([-80, 26])?.name, "harbor");
  assert.equal(selection.at([-80, 26])?.edition, "2");
  assert.equal(selection.at([-80, 26])?.updateNumber, 1);
  assert.equal(selection.at([0, 0]), null);
});

test("uses CATCOV=1 and excludes holes/CATCOV=2; coarse chart fills uncovered areas", () => {
  const harbor = cell("harbor", 1000, {
    coverages: [
      { category: 1, geometry: square(-80.5, 25.5, -79.5, 26.5) },
      { category: 2, geometry: square(-80.1, 25.9, -79.9, 26.1) },
    ],
  });
  const selection = new ChartSelection([cell("coastal", 80000), harbor]);
  assert.equal(selection.at([-80, 26])?.name, "coastal");
  assert.equal(selection.at([-80.2, 26])?.name, "harbor");
  assert.equal(selection.at([-80.7, 26])?.name, "coastal");
  assert.equal(selection.at([-80.1, 26])?.name, "coastal");
  const withHole = square(-81, 25, -79, 27);
  withHole.coordinates.push(square(-80.1, 25.9, -79.9, 26.1).coordinates[0]!);
  assert.equal(coversPoint(withHole, [-80, 26]), false);
  assert.equal(coversPoint(withHole, [-81, 26]), true);
  assert.equal(coversPoint(null, [-80, 26]), false);
});

test("handles multipolygons and antimeridian without claiming the rest of the world", () => {
  const shape = {
    type: "MultiPolygon",
    coordinates: [
      square(179, -1, -179, 1).coordinates,
      square(10, 10, 11, 11).coordinates,
    ],
  };
  assert.equal(coversPoint(shape, [179.5, 0]), true);
  assert.equal(coversPoint(shape, [-179.5, 0]), true);
  assert.equal(coversPoint(shape, [0, 0]), false);
  assert.equal(coversPoint(shape, [10.5, 10.5]), true);
});

test("same-scale ties use update date then cell name, independent of input order", () => {
  const a = cell("A", 22000),
    b = cell("B", 22000);
  assert.equal(new ChartSelection([b, a]).at([-80, 26])?.name, "A");
  b.updateApplicationDate = "2026-01-01";
  assert.equal(new ChartSelection([a, b]).at([-80, 26])?.name, "B");
});
