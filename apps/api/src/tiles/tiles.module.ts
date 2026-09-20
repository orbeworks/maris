import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IngestionsModule } from '../ingestions/ingestions.module.js';
import { CHART_STORAGE } from './storage/chart-storage.js';
import { LocalChartStorageService } from './storage/local-chart-storage.service.js';
import { ObjectChartStorageService } from './storage/object-chart-storage.service.js';
import { TilesController } from './tiles.controller.js';
import { TilesService } from './tiles.service.js';

@Module({
  imports: [IngestionsModule],
  controllers: [TilesController],
  exports: [CHART_STORAGE],
  providers: [
    TilesService,
    LocalChartStorageService,
    ObjectChartStorageService,
    {
      provide: CHART_STORAGE,
      inject: [ConfigService, LocalChartStorageService, ObjectChartStorageService],
      useFactory: (
        config: ConfigService,
        local: LocalChartStorageService,
        object: ObjectChartStorageService,
      ) => config.get<string>('CHART_STORAGE_BACKEND', 'local') === 's3' ? object : local,
    },
  ],
})
export class TilesModule {}
