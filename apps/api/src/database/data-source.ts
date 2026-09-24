import "dotenv/config";

import { DataSource } from "typeorm";

import { createTypeOrmOptions } from "./typeorm.options.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations");
}

export default new DataSource(
  createTypeOrmOptions(
    databaseUrl,
    process.env.DATABASE_MIGRATIONS_RUN !== "false",
  ),
);
