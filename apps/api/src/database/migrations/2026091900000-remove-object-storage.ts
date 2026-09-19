import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Remove the retired remote ENC/S3 ingestion surface. */
export class RemoveObjectStorage2026091900000 implements MigrationInterface {
  name = 'RemoveObjectStorage2026091900000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS enc_uploads');
    await queryRunner.query('ALTER TABLE chart_ingestions DROP COLUMN IF EXISTS source_object_key');
    await queryRunner.query('ALTER TABLE chart_versions DROP COLUMN IF EXISTS artifact_object_key');
    await queryRunner.query('ALTER TABLE chart_versions DROP COLUMN IF EXISTS enc_object_key');
    await queryRunner.query('ALTER TABLE chart_versions DROP COLUMN IF EXISTS manifest_object_key');
  }

  async down(): Promise<void> {
    // The remote object-storage integration is intentionally not restored.
  }
}
