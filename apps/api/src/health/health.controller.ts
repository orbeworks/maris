import { Controller, Get } from "@nestjs/common";
import { DataSource } from "typeorm";

import { NoStore } from "../utils/http-cache.decorator.js";

enum HealthStatus {
  OK = "ok",
  DEGRADED = "degraded",
}

enum DatabaseStatus {
  UP = "up",
  DOWN = "down",
}

@Controller("health")
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  @NoStore()
  async getHealth() {
    let database = DatabaseStatus.UP;

    try {
      await this.dataSource.query("SELECT 1");
    } catch {
      database = DatabaseStatus.DOWN;
    }

    return {
      database,
      status:
        database === DatabaseStatus.DOWN
          ? HealthStatus.DEGRADED
          : HealthStatus.OK,
    };
  }
}
