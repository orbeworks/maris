import {
  Controller,
  Get,
  Param,
  Inject,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { TileJsonDto } from './dtos/tile-json.dto.js';
import { TilesService } from './tiles.service.js';

@Controller('tiles')
export class TilesController {
  constructor(
    @Inject(TilesService) private readonly tilesService: TilesService,
  ) {}

  @Get('soundg/:z/:x/:y.pbf')
  async getLatestTile(
    @Param('z') z: string,
    @Param('x') x: string,
    @Param('y') y: string,
    @Res() response: Response,
  ) {
    response.set('Cache-Control', 'no-store');
    const tile = await this.tilesService.getLatestTile(z, x, y);
    response.set('Cache-Control', 'public, max-age=30, must-revalidate');
    response.type('application/vnd.mapbox-vector-tile');
    if (!tile) return response.status(204).end();
    return response.status(200).send(tile);
  }

  @Get('soundg.json')
  async getTileJson(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TileJsonDto> {
    response.set('Cache-Control', 'no-cache');
    const forwardedProtocol = request.get('x-forwarded-proto')?.split(',')[0];
    const protocol = forwardedProtocol ?? request.protocol;
    return this.tilesService.getTileJson(
      `${protocol}://${request.get('host')}`,
    );
  }
}
