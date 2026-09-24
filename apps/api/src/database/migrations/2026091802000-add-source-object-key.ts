import { MigrationInterface, QueryRunner } from "typeorm";
export class AddSourceObjectKey2026091802000 implements MigrationInterface {
  name = "AddSourceObjectKey2026091802000";
  async up(q: QueryRunner) {
    await q.query(
      "ALTER TABLE chart_ingestions ADD COLUMN IF NOT EXISTS source_object_key text",
    );
  }
  async down(q: QueryRunner) {
    await q.query(
      "ALTER TABLE chart_ingestions DROP COLUMN IF EXISTS source_object_key",
    );
  }
}
