import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddEncObjectKey2026091805000 implements MigrationInterface {
  name = "AddEncObjectKey2026091805000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE chart_versions ADD COLUMN IF NOT EXISTS enc_object_key text",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE chart_versions DROP COLUMN IF EXISTS enc_object_key",
    );
  }
}
