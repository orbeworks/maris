import { MigrationInterface, QueryRunner } from "typeorm";

export class AddArtifactObjectKeys2026091803000 implements MigrationInterface {
  name = "AddArtifactObjectKeys2026091803000";
  async up(q: QueryRunner) {
    await q.query(
      "ALTER TABLE chart_versions ADD COLUMN IF NOT EXISTS artifact_object_key text",
    );
    await q.query(
      "ALTER TABLE chart_versions ADD COLUMN IF NOT EXISTS manifest_object_key text",
    );
  }
  async down(q: QueryRunner) {
    await q.query(
      "ALTER TABLE chart_versions DROP COLUMN IF EXISTS manifest_object_key",
    );
    await q.query(
      "ALTER TABLE chart_versions DROP COLUMN IF EXISTS artifact_object_key",
    );
  }
}
