import {
  Global,
  Injectable,
  Module,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";

import { createTypeOrmOptions } from "./typeorm.options.js";

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(private readonly dataSource: DataSource) {}

  async onApplicationShutdown() {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      inject: [ConfigService],
      provide: DataSource,
      useFactory: async (config: ConfigService) =>
        new DataSource(
          createTypeOrmOptions(
            config.getOrThrow<string>("DATABASE_URL"),
            config.get<boolean>("DATABASE_MIGRATIONS_RUN", true),
          ),
        ).initialize(),
    },
    DatabaseLifecycle,
  ],
  exports: [DataSource],
})
export class DatabaseModule {}
