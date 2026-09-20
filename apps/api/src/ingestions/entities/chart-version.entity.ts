import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';

import type { IngestionStatus } from '../models/processing.js';
import { ChartCell } from './chart-cell.entity.js';
import { ChartDataset } from './chart-dataset.entity.js';
import { ChartIngestion } from './chart-ingestion.entity.js';

@Entity({ name: 'chart_versions' })
@Index('chart_versions_dataset_version_unique', ['datasetId', 'versionKey'], {
  unique: true,
})
export class ChartVersion {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'ingestion_id', type: 'uuid', unique: true })
  ingestionId!: string;

  @OneToOne(() => ChartIngestion, (ingestion) => ingestion.version, {
    nullable: false,
  })
  @JoinColumn({ name: 'ingestion_id' })
  ingestion!: Relation<ChartIngestion>;

  @Column({ name: 'dataset_id', type: 'uuid' })
  datasetId!: string;

  @ManyToOne(() => ChartDataset, (dataset) => dataset.versions, {
    nullable: false,
  })
  @JoinColumn({ name: 'dataset_id' })
  dataset!: Relation<ChartDataset>;

  @Column({ name: 'version_key', type: 'text' })
  versionKey!: string;

  @Column({ type: 'text' })
  status!: IngestionStatus;

  @OneToMany(() => ChartCell, (cell) => cell.version)
  cells!: Relation<ChartCell[]>;

  @Column({ name: 'update_number', nullable: true, type: 'integer' })
  updateNumber!: number | null;

  @Column({ nullable: true, type: 'jsonb' })
  bounds!: [number, number, number, number] | null;

  @Column({ name: 'storage_path', nullable: true, type: 'text' })
  storagePath!: string | null;

  @Column({ name: 'manifest_path', nullable: true, type: 'text' })
  manifestPath!: string | null;

  @Column({ name: 'artifact_object_key', nullable: true, type: 'text' })
  artifactObjectKey!: string | null;

  @Column({ name: 'manifest_object_key', nullable: true, type: 'text' })
  manifestObjectKey!: string | null;

  @Column({ default: false, type: 'boolean' })
  active!: boolean;

  @Column({ name: 'error_message', nullable: true, type: 'text' })
  errorMessage!: string | null;

  @Column({ name: 'error_stack', nullable: true, type: 'text' })
  errorStack!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'processed_at', nullable: true, type: 'timestamptz' })
  processedAt!: Date | null;

  @Column({ name: 'published_at', nullable: true, type: 'timestamptz' })
  publishedAt!: Date | null;
}
