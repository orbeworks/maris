import type {
  EncMetadataFeature,
  ProcessedCell,
} from "../../ingestions/models/processing.js";

export const CHART_SELECTION_POLICY = "detailed-coverage-v1";
type Position = [number, number];
type Ring = { points: Position[]; bounds: [number, number, number, number] };
type Polygon = Ring[];
export type CoverageCell = {
  name: string;
  edition: string | null;
  updateNumber: number;
  issueDate: string | null;
  updateApplicationDate: string | null;
  compilationScale: number | null;
  coverages: {
    category: number | null;
    geometry: EncMetadataFeature["geometry"];
  }[];
};

function prepareRing(input: unknown): Ring | null {
  if (!Array.isArray(input) || input.length < 4) return null;
  const points: Position[] = [];
  for (const p of input) {
    if (
      !Array.isArray(p) ||
      typeof p[0] !== "number" ||
      typeof p[1] !== "number" ||
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1])
    )
      return null;
    let longitude = p[0];
    const previous = points.at(-1);
    if (previous)
      longitude += 360 * Math.round((previous[0] - longitude) / 360);
    points.push([longitude, p[1]]);
  }
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  for (const [x, y] of points) {
    w = Math.min(w, x);
    s = Math.min(s, y);
    e = Math.max(e, x);
    n = Math.max(n, y);
  }
  return { points, bounds: [w, s, e, n] };
}

function prepareGeometry(geometry: EncMetadataFeature["geometry"]): Polygon[] {
  if (!geometry) return [];
  const input =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  if (!Array.isArray(input)) return [];
  return input.flatMap((polygon) => {
    if (!Array.isArray(polygon) || !polygon.length) return [];
    const rings = polygon.map(prepareRing);
    return rings.every((ring): ring is Ring => ring !== null) ? [rings] : [];
  });
}

// -1 = boundary, 0 = outside, 1 = inside. Unwrap rings across the antimeridian.
function inRing(point: Position, ring: Ring): number {
  const [w, s, e, n] = ring.bounds;
  const x = point[0] + 360 * Math.round(((w + e) / 2 - point[0]) / 360),
    y = point[1];
  if (x < w || x > e || y < s || y > n) return 0;
  let inside = false;
  for (let i = 0, j = ring.points.length - 1; i < ring.points.length; j = i++) {
    const [ax, ay] = ring.points[j]!,
      [bx, by] = ring.points[i]!;
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (
      Math.abs(cross) <= 1e-12 &&
      x >= Math.min(ax, bx) &&
      x <= Math.max(ax, bx) &&
      y >= Math.min(ay, by) &&
      y <= Math.max(ay, by)
    )
      return -1;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax)
      inside = !inside;
  }
  return inside ? 1 : 0;
}

function inPolygons(point: Position, polygons: Polygon[]): boolean {
  return polygons.some(
    ([outer, ...holes]) =>
      outer &&
      inRing(point, outer) !== 0 &&
      holes.every((hole) => inRing(point, hole) === 0),
  );
}

export function coversPoint(
  geometry: EncMetadataFeature["geometry"],
  point: Position,
): boolean {
  return inPolygons(point, prepareGeometry(geometry));
}

function newest(a: CoverageCell, b: CoverageCell) {
  return (
    Number(b.edition ?? 0) - Number(a.edition ?? 0) ||
    b.updateNumber - a.updateNumber ||
    (b.updateApplicationDate ?? "").localeCompare(
      a.updateApplicationDate ?? "",
    ) ||
    (b.issueDate ?? "").localeCompare(a.issueDate ?? "")
  );
}

/** The identical ownership rule is used before MVT generation and by the API. */
export class ChartSelection {
  private readonly cells;
  constructor(input: CoverageCell[]) {
    const latest = new Map<string, CoverageCell>();
    for (const cell of input) {
      const previous = latest.get(cell.name);
      if (!previous || newest(cell, previous) < 0) latest.set(cell.name, cell);
    }
    const scale = (c: CoverageCell) =>
      c.compilationScale && c.compilationScale > 0
        ? c.compilationScale
        : Infinity;
    this.cells = [...latest.values()]
      .sort(
        (a, b) =>
          scale(a) - scale(b) ||
          (b.updateApplicationDate ?? b.issueDate ?? "").localeCompare(
            a.updateApplicationDate ?? a.issueDate ?? "",
          ) ||
          a.name.localeCompare(b.name),
      )
      .map((cell) => ({
        cell,
        included: cell.coverages
          .filter((c) => c.category === 1)
          .flatMap((c) => prepareGeometry(c.geometry)),
        excluded: cell.coverages
          .filter((c) => c.category === 2)
          .flatMap((c) => prepareGeometry(c.geometry)),
      }));
  }
  at(point: Position): CoverageCell | null {
    return (
      this.cells.find(
        (c) => inPolygons(point, c.included) && !inPolygons(point, c.excluded),
      )?.cell ?? null
    );
  }
}

export function coverageCells(cells: ProcessedCell[]): CoverageCell[] {
  return cells.map((c) => ({
    name: c.name,
    edition: c.edition,
    updateNumber: c.updateNumber,
    issueDate: c.metadata?.issueDate ?? null,
    updateApplicationDate: c.metadata?.updateApplicationDate ?? null,
    compilationScale: c.metadata?.compilationScale ?? null,
    coverages: (c.metadata?.coverage ?? []).map((f) => ({
      category:
        typeof f.properties.CATCOV === "number" ? f.properties.CATCOV : null,
      geometry: f.geometry,
    })),
  }));
}
