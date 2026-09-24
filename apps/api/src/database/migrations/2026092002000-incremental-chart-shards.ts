import type { MigrationInterface, QueryRunner } from "typeorm";

export class IncrementalChartShards2026092002000 implements MigrationInterface {
  name = "IncrementalChartShards2026092002000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chart_datasets
      ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      UPDATE chart_datasets SET revision = 0 WHERE revision IS NULL
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chart_shards (
        id uuid PRIMARY KEY,
        version_id uuid NOT NULL REFERENCES chart_versions(id) ON DELETE CASCADE,
        sequence integer NOT NULL,
        shard_key text NOT NULL UNIQUE,
        revision bigint NOT NULL UNIQUE,
        bounds jsonb NOT NULL,
        artifact_object_key text NOT NULL,
        manifest_object_key text NOT NULL,
        published_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chart_shards_version_sequence_unique UNIQUE(version_id, sequence)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE chart_cells
      ADD COLUMN IF NOT EXISTS shard_id uuid
    `);
    await queryRunner.query(`
      ALTER TABLE chart_cells
      ADD CONSTRAINT chart_cells_shard_fk
      FOREIGN KEY (shard_id) REFERENCES chart_shards(id) ON DELETE CASCADE
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS chart_cells_shard_index ON chart_cells(shard_id)
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS chart_versions_one_active_per_dataset
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP INDEX IF EXISTS chart_cells_shard_index");
    await queryRunner.query(
      "ALTER TABLE chart_cells DROP COLUMN IF EXISTS shard_id",
    );
    await queryRunner.query("DROP TABLE IF EXISTS chart_shards");
    await queryRunner.query(
      "ALTER TABLE chart_datasets DROP COLUMN IF EXISTS revision",
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS chart_versions_one_active_per_dataset
      ON chart_versions(dataset_id) WHERE active
    `);
  }
}
