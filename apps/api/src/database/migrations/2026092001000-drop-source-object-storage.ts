import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DropSourceObjectStorage2026092001000 implements MigrationInterface {
  name = 'DropSourceObjectStorage2026092001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS enc_uploads');
    await queryRunner.query('ALTER TABLE chart_ingestions DROP COLUMN IF EXISTS source_object_key');
    await queryRunner.query('ALTER TABLE chart_versions DROP COLUMN IF EXISTS enc_object_key');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE chart_ingestions ADD COLUMN IF NOT EXISTS source_object_key text');
    await queryRunner.query('ALTER TABLE chart_versions ADD COLUMN IF NOT EXISTS enc_object_key text');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS enc_uploads (
      id uuid PRIMARY KEY,
      upload_id text NOT NULL UNIQUE,
      object_key text NOT NULL UNIQUE,
      source_filename text NOT NULL,
      expected_size bigint,
      checksum_sha256 text,
      source_url text,
      status text NOT NULL DEFAULT 'created',
      parts jsonb NOT NULL DEFAULT '[]',
      ingestion_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }
}
