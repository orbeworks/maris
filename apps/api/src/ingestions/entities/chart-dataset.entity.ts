import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";
import type { Relation } from "typeorm";

import { ChartIngestion } from "./chart-ingestion.entity.js";
import { ChartVersion } from "./chart-version.entity.js";

@Entity({ name: "chart_datasets" })
export class ChartDataset {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text", unique: true })
  key!: string;

  @Column({ type: "text" })
  name!: string;

  @Column({ default: 0, type: "bigint" })
  revision!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @OneToMany(() => ChartIngestion, (ingestion) => ingestion.dataset)
  ingestions!: Relation<ChartIngestion[]>;

  @OneToMany(() => ChartVersion, (version) => version.dataset)
  versions!: Relation<ChartVersion[]>;
}
