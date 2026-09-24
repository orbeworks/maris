import type { DataSourceOptions } from "typeorm";

import { ChartDataset } from "../ingestions/entities/chart-dataset.entity.js";
import { ChartIngestion } from "../ingestions/entities/chart-ingestion.entity.js";
import { ChartVersion } from "../ingestions/entities/chart-version.entity.js";
import { ChartCell } from "../ingestions/entities/chart-cell.entity.js";
import { ChartCoverage } from "../ingestions/entities/chart-coverage.entity.js";
import { ChartSurvey } from "../ingestions/entities/chart-survey.entity.js";
import { ChartShard } from "../ingestions/entities/chart-shard.entity.js";
import { ModelEncMetadata2026091800000 } from "./migrations/2026091800000-model-enc-metadata.js";
import { CreateChartCatalog2026091700000 } from "./migrations/2026091700000-create-chart-catalog.js";
import { CreateEncUploads2026091801000 } from "./migrations/2026091801000-create-enc-uploads.js";
import { AddSourceObjectKey2026091802000 } from "./migrations/2026091802000-add-source-object-key.js";
import { AddArtifactObjectKeys2026091803000 } from "./migrations/2026091803000-add-artifact-object-keys.js";
import { AddSourceUrl2026091804000 } from "./migrations/2026091804000-add-source-url.js";
import { AddEncObjectKey2026091805000 } from "./migrations/2026091805000-add-enc-object-key.js";
import { EnsureObjectStorage2026092000000 } from "./migrations/2026092000000-ensure-object-storage.js";
import { DropSourceObjectStorage2026092001000 } from "./migrations/2026092001000-drop-source-object-storage.js";
import { IncrementalChartShards2026092002000 } from "./migrations/2026092002000-incremental-chart-shards.js";

export function createTypeOrmOptions(
  databaseUrl: string,
  migrationsRun = true,
): DataSourceOptions {
  return {
    type: "postgres",
    url: databaseUrl,
    entities: [
      ChartDataset,
      ChartIngestion,
      ChartVersion,
      ChartShard,
      ChartCell,
      ChartCoverage,
      ChartSurvey,
    ],
    // RemoveObjectStorage was never deployed to production and is intentionally
    // omitted. EnsureObjectStorage also repairs databases where it did run.
    migrations: [
      CreateChartCatalog2026091700000,
      ModelEncMetadata2026091800000,
      CreateEncUploads2026091801000,
      AddSourceObjectKey2026091802000,
      AddArtifactObjectKeys2026091803000,
      AddSourceUrl2026091804000,
      AddEncObjectKey2026091805000,
      EnsureObjectStorage2026092000000,
      DropSourceObjectStorage2026092001000,
      IncrementalChartShards2026092002000,
    ],
    migrationsRun,
    synchronize: false,
  };
}
