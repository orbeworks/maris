export type AreaBounds = [number, number, number, number];
export type StyleSnapshot = {
  version: 8;
  sources: Record<string, Record<string, unknown>>;
  layers: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
export type ChartSnapshot = {
  version: string;
  tiles: string[];
  bounds: AreaBounds;
  minzoom: number;
  maxzoom: number;
};

const SOUNDG_COORDINATE_TILE = /\/tiles\/soundg\/\{z\}\/\{x\}\/\{y\}\.pbf(?:[?#]|$)/;

export function usesCoordinateSoundgRoute(chart: ChartSnapshot) {
  return Boolean(
    chart.version &&
      chart.tiles?.length &&
      chart.tiles.every((url) => SOUNDG_COORDINATE_TILE.test(url)),
  );
}

export function validateArea(
  bounds: AreaBounds,
  minZoom: number,
  maxZoom: number,
) {
  const [w, s, e, n] = bounds;
  if (
    !bounds.every(Number.isFinite) ||
    w < -180 ||
    e > 180 ||
    w >= e ||
    s < -85.05112878 ||
    n > 85.05112878 ||
    s >= n ||
    !Number.isInteger(minZoom) ||
    !Number.isInteger(maxZoom) ||
    minZoom < 0 ||
    maxZoom > 16 ||
    minZoom > maxZoom
  ) {
    throw new Error("Invalid offline bounds or zoom range (0–16)");
  }
}

// Offline downloads only inspect style sources/layers: the runtime JSX source
// is not sufficient. The API owns shard/version selection; clients only send
// tile coordinates. `version` is retained solely to detect stale downloads.
export function withOfflineSoundings(
  style: StyleSnapshot,
  chart: ChartSnapshot,
): StyleSnapshot {
  if (!usesCoordinateSoundgRoute(chart)) {
    throw new Error("ENC TileJSON must use the coordinate-only SOUNDG route");
  }
  return {
    ...style,
    sources: {
      ...style.sources,
      "offline-soundg": {
        type: "vector",
        tiles: chart.tiles,
        bounds: chart.bounds,
        minzoom: chart.minzoom,
        maxzoom: chart.maxzoom,
      },
    },
    layers: [
      ...style.layers,
      {
        id: "offline-soundg-resources",
        source: "offline-soundg",
        "source-layer": "soundings",
        type: "symbol",
        minzoom: 10,
        layout: {
          "text-field": ["to-string", ["get", "DEPTH"]],
          "text-font": ["Noto Sans Regular"],
        },
      },
    ],
  };
}
