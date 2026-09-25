import { Controller, Get, Param, Inject, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import { HttpCache } from "../utils/http-cache.decorator.js";
import type { TileJsonDto } from "./dtos/tile-json.dto.js";
import { TilesService } from "./tiles.service.js";
import { TimeInSeconds } from "../utils/time-in-seconds.enum.js";

@Controller("tiles")
export class TilesController {
  constructor(
    @Inject(TilesService) private readonly tilesService: TilesService,
  ) {}

  @Get("soundg/:z/:x/:y.pbf")
  @HttpCache({
    sharedMaxAge: TimeInSeconds.DAY,
    staleWhileRevalidate: 5 * TimeInSeconds.MINUTE,
  })
  async getLatestTile(
    @Param("z") z: string,
    @Param("x") x: string,
    @Param("y") y: string,
    @Res() response: Response,
  ) {
    const tile = await this.tilesService.getLatestTile(z, x, y);
    response.type("application/vnd.mapbox-vector-tile");
    if (!tile) return response.status(204).end();
    return response.status(200).send(tile);
  }

  @Get("soundg.json")
  @HttpCache({
    sharedMaxAge: TimeInSeconds.DAY,
    staleWhileRevalidate: 5 * TimeInSeconds.MINUTE,
  })
  async getTileJson(
    @Req() request: Request,
    @Res({ passthrough: true }) _response: Response,
  ): Promise<TileJsonDto> {
    const forwardedProtocol = request.get("x-forwarded-proto")?.split(",")[0];
    const protocol = forwardedProtocol ?? request.protocol;
    return this.tilesService.getTileJson(
      `${protocol}://${request.get("host")}`,
    );
  }
}
