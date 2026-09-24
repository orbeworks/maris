import { Module } from "@nestjs/common";
import { TilesModule } from "../tiles/tiles.module.js";
import { IngestionsModule } from "../ingestions/ingestions.module.js";
import { ChartsController } from "./charts.controller.js";
import { ChartsService } from "./charts.service.js";

@Module({
  imports: [TilesModule, IngestionsModule],
  controllers: [ChartsController],
  providers: [ChartsService],
})
export class ChartsModule {}
