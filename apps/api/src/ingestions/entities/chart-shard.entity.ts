import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';

import { ChartCell } from './chart-cell.entity.js';
import { ChartVersion } from './chart-version.entity.js';

@Entity({ name: 'chart_shards' })
@Index('chart_shards_version_sequence_unique', ['versionId', 'sequence'], {
  unique: true,
})
export class ChartShard {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId!: string;

  @ManyToOne(() => ChartVersion, (version) => version.shards, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'version_id' })
  version!: Relation<ChartVersion>;

  @Column({ type: 'integer' })
  sequence!: number;

  @Column({ name: 'shard_key', type: 'text', unique: true })
  shardKey!: string;

  @Column({ type: 'bigint', unique: true })
  revision!: string;

  @Column({ type: 'jsonb' })
  bounds!: [number, number, number, number];

  @Column({ name: 'artifact_object_key', type: 'text' })
  artifactObjectKey!: string;

  @Column({ name: 'manifest_object_key', type: 'text' })
  manifestObjectKey!: string;

  @CreateDateColumn({ name: 'published_at', type: 'timestamptz' })
  publishedAt!: Date;

  @OneToMany(() => ChartCell, (cell) => cell.shard)
  cells!: Relation<ChartCell[]>;
}
