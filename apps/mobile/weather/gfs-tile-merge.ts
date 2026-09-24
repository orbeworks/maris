import type { GfsGrid } from './gfs-grid';
import { tileBounds, type GfsTileCoordinate } from './gfs-tiles';

export type GfsTileEntry = {
  tile: GfsTileCoordinate;
  grid: GfsGrid;
};

export function mergeGfsTiles(tiles: GfsTileEntry[]): GfsGrid | null {
  if (!tiles.length) return null;
  const xValues = [...new Set(tiles.map((item) => item.tile.x))].sort((a, b) => a - b);
  // A rectangular grid cannot represent the -180/180 seam. Keep the tile
  // containing the point for the native field in that special case.
  const tileZoom = tiles[0]!.tile.z;
  const tileCount = 2 ** tileZoom;
  if (xValues.length > 1 && xValues[xValues.length - 1]! - xValues[0]! > tileCount / 2) {
    return tiles[0]!.grid;
  }
  const yValues = [...new Set(tiles.map((item) => item.tile.y))].sort((a, b) => a - b);
  const first = tiles[0]!.grid;
  const tileWidth = first.width;
  const tileHeight = first.height;
  const minX = xValues[0]!;
  const maxX = xValues[xValues.length - 1]!;
  const minY = yValues[0]!;
  const maxY = yValues[yValues.length - 1]!;
  const width = (maxX - minX) * (tileWidth - 1) + tileWidth;
  const height = (maxY - minY) * (tileHeight - 1) + tileHeight;
  const fields: GfsGrid['fields'] = {};
  for (const field of new Set(tiles.flatMap((item) => Object.keys(item.grid.fields)))) {
    const values = new Array<number | null>(width * height).fill(null);
    for (const item of tiles) {
      const source = item.grid.fields[field as keyof GfsGrid['fields']];
      if (!source) continue;
      const offsetX = (item.tile.x - minX) * (tileWidth - 1);
      const offsetY = (item.tile.y - minY) * (tileHeight - 1);
      for (let row = 0; row < tileHeight; row += 1) {
        for (let column = 0; column < tileWidth; column += 1) {
          values[(offsetY + row) * width + offsetX + column] = source[row * tileWidth + column] ?? null;
        }
      }
    }
    fields[field as keyof GfsGrid['fields']] = values;
  }
  return {
    ...first,
    bounds: {
      ...tileBounds({ z: tileZoom, x: minX, y: minY }),
      east: tileBounds({ z: tileZoom, x: maxX, y: minY }).east,
      south: tileBounds({ z: tileZoom, x: minX, y: maxY }).south,
    },
    width,
    height,
    fields,
  };
}
