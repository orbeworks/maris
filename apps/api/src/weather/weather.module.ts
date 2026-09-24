import { Module } from "@nestjs/common";

import { WeatherController } from "./weather.controller.js";
import { GfsService } from "./gfs.service.js";
import { GfsRedisCacheService } from "./gfs-redis-cache.service.js";
import { GfsPrefetchService } from "./gfs-prefetch.service.js";

@Module({
  controllers: [WeatherController],
  providers: [GfsService, GfsRedisCacheService, GfsPrefetchService],
  exports: [GfsService],
})
export class WeatherModule {}
