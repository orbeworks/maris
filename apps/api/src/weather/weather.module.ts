import { Module } from "@nestjs/common";

import { WeatherController } from "./weather.controller.js";
import { GfsService } from "./gfs.service.js";

@Module({
  controllers: [WeatherController],
  providers: [GfsService],
  exports: [GfsService],
})
export class WeatherModule {}
