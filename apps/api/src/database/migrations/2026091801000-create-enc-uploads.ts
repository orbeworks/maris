import { MigrationInterface, QueryRunner } from "typeorm";
export class CreateEncUploads2026091801000 implements MigrationInterface {
  name = "CreateEncUploads2026091801000";
  async up(q: QueryRunner) {
    await q.query(
      `CREATE TABLE IF NOT EXISTS enc_uploads (id uuid PRIMARY KEY, upload_id text NOT NULL UNIQUE, object_key text NOT NULL UNIQUE, source_filename text NOT NULL, expected_size bigint, checksum_sha256 text, status text NOT NULL DEFAULT 'created', parts jsonb NOT NULL DEFAULT '[]', ingestion_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
    );
  }
  async down(q: QueryRunner) {
    await q.query("DROP TABLE IF EXISTS enc_uploads");
  }
}
