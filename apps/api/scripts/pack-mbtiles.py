"""Convert a GDAL MBTiles database to PMTiles without loading all tiles."""

import gzip
import json
import sqlite3
import sys

from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write


source_path, destination, manifest_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as source:
    manifest = json.load(source)

west, south, east, north = manifest["bounds"]
connection = sqlite3.connect(source_path)
connection.create_function(
    "pmtiles_tileid",
    3,
    lambda z, x, tile_row: zxy_to_tileid(z, x, (1 << z) - 1 - tile_row),
    deterministic=True,
)
tile_count = 0
with write(destination) as writer:
    rows = connection.execute(
        """
        SELECT zoom_level, tile_column, tile_row, tile_data
        FROM tiles
        ORDER BY pmtiles_tileid(zoom_level, tile_column, tile_row)
        """
    )
    for zoom, column, tile_row, tile_data in rows:
        row = (1 << zoom) - 1 - tile_row
        payload = bytes(tile_data)
        if not payload.startswith(b"\x1f\x8b"):
            payload = gzip.compress(payload, compresslevel=6, mtime=0)
        writer.write_tile(zxy_to_tileid(zoom, column, row), payload)
        tile_count += 1
    writer.finalize(
        {
            "tile_type": TileType.MVT,
            "tile_compression": Compression.GZIP,
            "min_lon_e7": round(west * 1e7),
            "min_lat_e7": round(south * 1e7),
            "max_lon_e7": round(east * 1e7),
            "max_lat_e7": round(north * 1e7),
            "center_zoom": manifest["minzoom"],
            "center_lon_e7": round((west + east) * 0.5e7),
            "center_lat_e7": round((south + north) * 0.5e7),
        },
        {
            "name": manifest["name"],
            "format": "pbf",
            "vector_layers": manifest["vectorLayers"],
        },
    )

connection.close()
print(json.dumps({"tileCount": tile_count}))
