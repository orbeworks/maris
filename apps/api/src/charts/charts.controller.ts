import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ChartsService } from "./charts.service.js";
import { ChartQueryDto } from "./dtos/chart-query.dto.js";
import type { ChartInformationDto } from "./dtos/chart-information.dto.js";
import { HttpCache } from "../utils/http-cache.decorator.js";
import { TimeInSeconds } from "../utils/time-in-seconds.enum.js";

@Controller("charts")
export class ChartsController {
  constructor(@Inject(ChartsService) private readonly charts: ChartsService) {}

  @Get("at-point")
  @HttpCache({
    sharedMaxAge: TimeInSeconds.DAY,
    staleWhileRevalidate: 5 * TimeInSeconds.MINUTE,
  })
  atPoint(
    @Query() query: Record<string, unknown>,
  ): Promise<ChartInformationDto> {
    return this.charts.atPoint(ChartQueryDto.parse(query));
  }
}
