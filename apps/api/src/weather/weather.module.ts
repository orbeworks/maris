import { Module } from "@nestjs/common";

import { CacheModule } from "../utils/cache.module.js";
import { WeatherController } from "./weather.controller.js";
import { GfsService } from "./gfs.service.js";

@Module({
  imports: [CacheModule],
  controllers: [WeatherController],
  providers: [GfsService],
  exports: [GfsService],
})
export class WeatherModule {}
