# NOAA/NCEP GFS 0.25° backend

The API endpoint `GET /weather/gfs/tiles/:z/:x/:y` downloads and normalizes the
NOMADS Grib Filter subsets needed for one XYZ tile. Example:

```text
/weather/gfs/tiles/6/24/36?forecastHour=0
```

The backend, not the React Native app, performs the GRIB2 parsing. A selected
run is complete before any request is served: if the newest cycle does not
contain every requested forecast hour, the previous complete cycle is used.
The selected run is recorded in the response, so different runs are never
silently mixed.

## Normalized grid

Each response is a gzip-compressed binary grid. Arrays are row-major, with rows
ordered north-to-south and columns west-to-east. The backend keeps SI units:

| Field | GRIB source | Level | Unit |
| --- | --- | --- | --- |
| `windU`, `windV` | `UGRD`, `VGRD` / `10u`, `10v` | 10 m above ground | m/s |
| `temperature` | `TMP` / `2t` | 2 m above ground | K |
| `precipitation` | `APCP` / `tp` | surface | kg/m² |
| `precipitationRate` | `PRATE` / `prate` | surface | kg/m²/s |
| `cloudCover` | `TCDC` / `tcc` | entire atmosphere | % |
| `pressure` | `PRMSL` / `prmsl` | mean sea level | Pa |
| `gust` | `GUST` / `gust` | surface | m/s |
| `humidity` | `RH` / `2r` | 2 m above ground | % |

Accumulated precipitation and precipitation rate are kept as separate fields
so the UI can choose `mm` or `mm/h` without losing the original model data.

## Longitude and antimeridian

MARIS accepts longitudes in `-180..180`. NOMADS requests use `0..360`. The
service converts each request before sending it. A request that needs to wrap
past the `0/360` seam is rejected explicitly instead of returning a silently
truncated subset; it can be supported later by issuing two subsets and joining
their grids.

## Cache

The route resolves data on demand. Rendered grids are cached in Redis by the
service's `@Cacheable` decorator. Downloaded source subsets are processed in
temporary files and are not persisted after the request completes.

## Validation

Run the real NOAA integration test with:

```bash
pnpm --filter @maris/api test:gfs
```

It downloads a 10° × 10° subset, parses GRIB2 with ecCodes, checks the expected
5 × 5 grid and prints finite min/max values for every field. The test is
network-dependent and is intentionally not part of the default test suite.
