import type { GfsBounds } from "./gfs.types.js";

export const GFS_TILE_SIZE_DEGREES = 10;
export const GFS_TILE_COLUMNS = 36;
export const GFS_TILE_ROWS = 18;

export type GfsTileCoordinate = { x: number; y: number };

export function gfsTileBounds(x: number, y: number): GfsBounds {
  if (
    !Number.isInteger(x) ||
    x < 0 ||
    x >= GFS_TILE_COLUMNS ||
    !Number.isInteger(y) ||
    y < 0 ||
    y >= GFS_TILE_ROWS
  ) {
    throw new RangeError("Invalid GFS tile coordinate");
  }
  const west = -180 + x * GFS_TILE_SIZE_DEGREES;
  const south = -90 + y * GFS_TILE_SIZE_DEGREES;
  return {
    west,
    east: west + GFS_TILE_SIZE_DEGREES,
    south,
    north: south + GFS_TILE_SIZE_DEGREES,
  };
}

export function gfsTileFromCoordinate(
  longitude: number,
  latitude: number,
): GfsTileCoordinate {
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new RangeError("Invalid GFS coordinate");
  }
  const normalizedLongitude = Math.min(
    179.999999999,
    Math.max(-180, longitude),
  );
  const normalizedLatitude = Math.min(89.999999999, Math.max(-90, latitude));
  return {
    x: Math.floor((normalizedLongitude + 180) / GFS_TILE_SIZE_DEGREES),
    y: Math.floor((normalizedLatitude + 90) / GFS_TILE_SIZE_DEGREES),
  };
}
