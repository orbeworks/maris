import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";

import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);
const config = app.get(ConfigService);

app.enableShutdownHooks();
await app.listen(
  config.get<number>("PORT", 3001),
  config.get<string>("HOST", "0.0.0.0"),
);
