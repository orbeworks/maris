import { rm } from "node:fs/promises";
import { test } from "node:test";

import { GfsService } from "../../src/weather/gfs.service.js";

const runRealTest = process.env.RUN_GFS_INTEGRATION === "1";

test(
  "downloads and parses a real NOAA GFS subset",
  { skip: !runRealTest },
  async () => {
    const cacheDirectory = `/tmp/maris-gfs-test-${process.pid}`;
    await rm(cacheDirectory, { recursive: true, force: true });
    const config = {
      get<T>(key: string, fallback?: T) {
        if (key === "GFS_CACHE_DIR") return cacheDirectory as T;
        if (key === "GFS_PARSER_PYTHON")
          return (process.env.GFS_PARSER_PYTHON ?? "python3") as T;
        if (key === "GFS_PARSER_SCRIPT")
          return "apps/api/scripts/gfs-grib-parser.py" as T;
        return fallback as T;
      },
    };

    const grid = await new GfsService(config as never).getTile(13, 6, 0);

    const expectedFields = [
      "windU",
      "windV",
      "temperature",
      "precipitation",
      "precipitationRate",
      "cloudCover",
      "pressure",
      "gust",
      "humidity",
    ];
    console.log("GFS field availability:");
    for (const field of expectedFields) {
      console.log(
        `${field.padEnd(18)} f000=${field in grid.fields ? "yes" : "no"}`,
      );
    }
    for (const field of ["windU", "windV", "temperature"]) {
      if (!(field in grid.fields))
        throw new Error(`Required f000 field ${field} is missing`);
    }

    for (const [name, values] of Object.entries(grid.fields)) {
      if (!values?.length) throw new Error(`NOAA field ${name} is empty`);
      const finite = values.filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
      if (!finite.length)
        throw new Error(`NOAA field ${name} has no finite values`);
      console.log(
        `GFS ${name}: min=${Math.min(...finite)} max=${Math.max(...finite)} count=${finite.length}`,
      );
    }
    if (grid.width !== 5 || grid.height !== 5) {
      throw new Error(
        `Unexpected 0.25 degree subset dimensions: ${grid.width}x${grid.height}`,
      );
    }
    await rm(cacheDirectory, { recursive: true, force: true });
  },
);
