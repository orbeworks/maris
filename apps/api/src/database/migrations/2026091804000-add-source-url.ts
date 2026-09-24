import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSourceUrl2026091804000 implements MigrationInterface {
  name = "AddSourceUrl2026091804000";
  async up(q: QueryRunner) {
    await q.query(
      "ALTER TABLE enc_uploads ADD COLUMN IF NOT EXISTS source_url text",
    );
  }
  async down(q: QueryRunner) {
    await q.query("ALTER TABLE enc_uploads DROP COLUMN IF EXISTS source_url");
  }
}
