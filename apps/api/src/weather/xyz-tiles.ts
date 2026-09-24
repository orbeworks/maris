import type { GfsBounds } from "./gfs.types.js";

export const GFS_MAX_WEATHER_ZOOM = 6;
export const GFS_XYZ_GRID_SIZE = 65;

export function xyzTileCount(z: number) {
  return 2 ** z;
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
