import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { gzipSync } from "node:zlib";

import { HttpCache } from "../utils/http-cache.decorator.js";
import { TimeInSeconds } from "../utils/time-in-seconds.enum.js";
import { GfsService } from "./gfs.service.js";
import { encodeGfsTile } from "./gfs-tile-codec.js";
import { GFS_MAX_WEATHER_ZOOM, xyzTileCount } from "./xyz-tiles.js";

@Controller("weather")
export class WeatherController {
  constructor(@Inject(GfsService) private readonly gfsService: GfsService) {}

  @Get("gfs/tiles/:z/:x/:y")
  @HttpCache({
    sharedMaxAge: TimeInSeconds.HOUR,
    staleWhileRevalidate: 5 * TimeInSeconds.MINUTE,
  })
  async getGfsTile(
    @Param("z") zValue: string,
    @Param("x") xValue: string,
    @Param("y") yValue: string,
    @Query("forecastHour") forecastHourValue = "0",
    @Res() response: Response,
  ) {
    const z = Number(zValue);
    const x = Number(xValue);
    const y = Number(yValue);
    const forecastHour = Number(forecastHourValue);
    const tileCount =
      Number.isInteger(z) && z >= 0 && z <= GFS_MAX_WEATHER_ZOOM
        ? xyzTileCount(z)
        : 0;
    if (
      ![z, x, y, forecastHour].every(Number.isInteger) ||
      z < 0 ||
      z > GFS_MAX_WEATHER_ZOOM ||
      x < 0 ||
      x >= tileCount ||
      y < 0 ||
      y >= tileCount ||
      forecastHour < 0 ||
      forecastHour > 384
    ) {
      throw new BadRequestException(
        "Invalid GFS tile coordinate or forecast hour",
      );
    }
    let body: Buffer;
    if (forecastHour === 0) {
      const current = await this.gfsService.getCurrentForecast();
      const source = await this.gfsService.getXyzTileFromInventory(
        current.inventory,
        z,
        x,
        y,
        current.sourceForecastHour,
      );
      // `0` remains the mobile contract for "current". forecastTime retains
      // the actual GFS valid time selected by the API.
      body = gzipSync(encodeGfsTile({ ...source, forecastHour: 0 }));
    } else {
      const inventory = await this.gfsService.getCompleteInventory([
        forecastHour,
      ]);
      const grid = await this.gfsService.getXyzTileFromInventory(
        inventory,
        z,
        x,
        y,
        forecastHour,
      );
      body = gzipSync(encodeGfsTile(grid));
    }
    response.set("Content-Type", "application/octet-stream");
    response.set("Content-Encoding", "gzip");
    return response.status(200).send(body);
  }
}
