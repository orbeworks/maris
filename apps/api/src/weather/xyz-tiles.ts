import type { GfsBounds } from "./gfs.types.js";

export const GFS_MAX_WEATHER_ZOOM = 6;
export const GFS_XYZ_TILE_SIZE = 256;
export const GFS_XYZ_GRID_SIZE = 65;
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

export function xyzTileCount(z: number) {
  return 2 ** z;
}

export function normalizeX(x: number, z: number) {
  const n = xyzTileCount(z);
  return ((x % n) + n) % n;
}

export function webMercatorTileBounds(
  z: number,
  x: number,
  y: number,
): GfsBounds {
  const n = xyzTileCount(z);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const latitude = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return { west, east, north: latitude(y), south: latitude(y + 1) };
}

export function xyzTileForCoordinate(
  longitude: number,
  latitude: number,
  z: number,
) {
  const n = xyzTileCount(z);
  const lon = ((((longitude + 180) % 360) + 360) % 360) - 180;
  const lat = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude),
  );
  const phi = (lat * Math.PI) / 180;
  return {
    z,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.max(
      0,
      Math.min(
        n - 1,
        Math.floor(((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * n),
      ),
    ),
  };
}
