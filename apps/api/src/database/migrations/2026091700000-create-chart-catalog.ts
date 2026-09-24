import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateChartCatalog2026091700000 implements MigrationInterface {
  name = "CreateChartCatalog2026091700000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chart_datasets (
        id uuid PRIMARY KEY,
        key text NOT NULL UNIQUE,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chart_ingestions (
        id uuid PRIMARY KEY,
        dataset_id uuid NOT NULL REFERENCES chart_datasets(id),
        status text NOT NULL CHECK (status IN ('received', 'validating', 'processing', 'ready', 'failed', 'published')),
        source_filename text,
        checksum_sha256 text,
        source_size_bytes bigint,
        archive_storage_path text,
        source_cells jsonb NOT NULL DEFAULT '[]'::jsonb,
        error_message text,
        error_stack text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        processing_started_at timestamptz,
        processed_at timestamptz,
        published_at timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chart_versions (
        id uuid PRIMARY KEY,
        ingestion_id uuid NOT NULL UNIQUE REFERENCES chart_ingestions(id),
        dataset_id uuid NOT NULL REFERENCES chart_datasets(id),
        version_key text NOT NULL,
        status text NOT NULL CHECK (status IN ('received', 'validating', 'processing', 'ready', 'failed', 'published')),
        edition_metadata jsonb NOT NULL DEFAULT '[]'::jsonb,
        update_number integer,
        bounds jsonb,
        storage_path text,
        manifest_path text,
        active boolean NOT NULL DEFAULT false,
        error_message text,
        error_stack text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        published_at timestamptz,
        CONSTRAINT chart_versions_dataset_version_unique UNIQUE(dataset_id, version_key)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS chart_versions_one_active_per_dataset
      ON chart_versions(dataset_id) WHERE active
    `);

    // Baseline the two immutable Miami artifacts already shipped by the MVP.
    await queryRunner.query(`
      INSERT INTO chart_datasets (id, key, name)
      VALUES ('00000000-0000-4000-8000-000000000001', 'soundg', 'Miami SOUNDG')
      ON CONFLICT (key) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO chart_ingestions (
        id, dataset_id, status, source_filename, source_cells, processed_at, published_at
      )
      VALUES
        (
          '00000000-0000-4000-8000-000000000011',
          (SELECT id FROM chart_datasets WHERE key = 'soundg'),
          'published', 'legacy-import-v1', '[]'::jsonb, now(), now()
        ),
        (
          '00000000-0000-4000-8000-000000000012',
          (SELECT id FROM chart_datasets WHERE key = 'soundg'),
          'published', 'legacy-import-v2', '[]'::jsonb, now(), now()
        )
      ON CONFLICT (id) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO chart_versions (
        id, ingestion_id, dataset_id, version_key, status, bounds,
        storage_path, manifest_path, active, processed_at, published_at
      )
      VALUES
        (
          '00000000-0000-4000-8000-000000000021',
          '00000000-0000-4000-8000-000000000011',
          (SELECT id FROM chart_datasets WHERE key = 'soundg'),
          'miami-soundg-v1', 'published',
          '[-80.265019,25.650179,-80.026909,25.949411]'::jsonb,
          'soundg/versions/miami-soundg-v1',
          'soundg/versions/miami-soundg-v1/manifest.json', false, now(), now()
        ),
        (
          '00000000-0000-4000-8000-000000000022',
          '00000000-0000-4000-8000-000000000012',
          (SELECT id FROM chart_datasets WHERE key = 'soundg'),
          'miami-soundg-v2', 'published',
          '[-80.265019,25.650179,-80.026909,25.949411]'::jsonb,
          'soundg/versions/miami-soundg-v2',
          'soundg/versions/miami-soundg-v2/manifest.json', false, now(), now()
        )
      ON CONFLICT (id) DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE chart_versions
      SET active = true
      WHERE id = '00000000-0000-4000-8000-000000000022'
        AND NOT EXISTS (SELECT 1 FROM chart_versions WHERE active = true)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DROP INDEX IF EXISTS chart_versions_one_active_per_dataset",
    );
    await queryRunner.query("DROP TABLE IF EXISTS chart_versions");
    await queryRunner.query("DROP TABLE IF EXISTS chart_ingestions");
    await queryRunner.query("DROP TABLE IF EXISTS chart_datasets");
  }
}
