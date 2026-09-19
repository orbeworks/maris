import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';

import type { EncArchiveDto } from '../dtos/ingestion.dto.js';
import type { IngestionStatus } from '../models/processing.js';
import { ChartDataset } from './chart-dataset.entity.js';
import { ChartVersion } from './chart-version.entity.js';

@Entity({ name: 'chart_ingestions' })
export class ChartIngestion {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'dataset_id', type: 'uuid' })
  datasetId!: string;

  @ManyToOne(() => ChartDataset, (dataset) => dataset.ingestions, {
    nullable: false,
  })
  @JoinColumn({ name: 'dataset_id' })
  dataset!: Relation<ChartDataset>;

  @Column({ type: 'text' })
  status!: IngestionStatus;

  @Column({ name: 'source_filename', nullable: true, type: 'text' })
  sourceFilename!: string | null;

  @Column({ name: 'checksum_sha256', nullable: true, type: 'text' })
  checksumSha256!: string | null;

  @Column({ name: 'source_size_bytes', nullable: true, type: 'bigint' })
  sourceSizeBytes!: string | null;

  @Column({ name: 'archive_storage_path', nullable: true, type: 'text' })
  archiveStoragePath!: string | null;

  @Column({
    default: () => "'[]'::jsonb",
    name: 'source_cells',
    type: 'jsonb',
  })
  sourceCells!: EncArchiveDto['cells'];

  @Column({ name: 'error_message', nullable: true, type: 'text' })
  errorMessage!: string | null;

  @Column({ name: 'error_stack', nullable: true, type: 'text' })
  errorStack!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'processing_started_at', nullable: true, type: 'timestamptz' })
  processingStartedAt!: Date | null;

  @Column({ name: 'processed_at', nullable: true, type: 'timestamptz' })
  processedAt!: Date | null;

  @Column({ name: 'published_at', nullable: true, type: 'timestamptz' })
  publishedAt!: Date | null;

  @OneToOne(() => ChartVersion, (version) => version.ingestion)
  version!: Relation<ChartVersion>;
}
