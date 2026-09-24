import { Controller, Get } from "@nestjs/common";
import { DataSource } from "typeorm";

@Controller("health")
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async getHealth() {
    let database = "up";
    try {
      await this.dataSource.query("SELECT 1");
    } catch {
      database = "down";
    }
    return { database, status: database === "down" ? "degraded" : "ok" };
  }
}
