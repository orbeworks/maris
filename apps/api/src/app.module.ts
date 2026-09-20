import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnv } from './config/env.schema.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IngestionsModule } from './ingestions/ingestions.module.js';
import { TilesModule } from './tiles/tiles.module.js';
import { WeatherModule } from './weather/weather.module.js';
import { ChartsModule } from './charts/charts.module.js';
import { RequestTimingMiddleware } from './request-timing.middleware.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule,
    StorageModule,
    HealthModule,
    IngestionsModule,
    TilesModule,
    WeatherModule,
    ChartsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestTimingMiddleware).forRoutes('*');
  }
}
