import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from "typeorm";
import type { Relation } from "typeorm";
import { ChartVersion } from "./chart-version.entity.js";
import { ChartCoverage } from "./chart-coverage.entity.js";
import { ChartSurvey } from "./chart-survey.entity.js";
import { ChartShard } from "./chart-shard.entity.js";

@Entity({ name: "chart_cells" })
@Index("chart_cells_version_name_unique", ["versionId", "name"], {
  unique: true,
})
export class ChartCell {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ name: "version_id", type: "uuid" })
  versionId!: string;

  @ManyToOne(() => ChartVersion, (version) => version.cells, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "version_id" })
  version!: Relation<ChartVersion>;

  @Column({ name: "shard_id", type: "uuid", nullable: true })
  shardId!: string | null;

  @ManyToOne(() => ChartShard, (shard) => shard.cells, { onDelete: "CASCADE" })
  @JoinColumn({ name: "shard_id" })
  shard!: Relation<ChartShard> | null;

  @Column({ type: "text" })
  name!: string;

  @Column({ type: "text", nullable: true })
  source!: string | null;

  @Column({ name: "agency_code", type: "integer", nullable: true })
  agencyCode!: number | null;

  @Column({ type: "text", nullable: true })
  edition!: string | null;

  @Column({ name: "update_number", type: "integer" })
  updateNumber!: number;

  @Column({ name: "updates_applied", type: "integer", array: true })
  updatesApplied!: number[];

  @Column({ name: "issue_date", type: "date", nullable: true })
  issueDate!: string | null;

  @Column({ name: "update_application_date", type: "date", nullable: true })
  updateApplicationDate!: string | null;

  @Column({ name: "compilation_scale", type: "integer", nullable: true })
  compilationScale!: number | null;

  @Column({ name: "horizontal_datum", type: "integer", nullable: true })
  horizontalDatum!: number | null;

  @Column({ name: "sounding_datum", type: "integer", nullable: true })
  soundingDatum!: number | null;

  @Column({ name: "vertical_datum", type: "integer", nullable: true })
  verticalDatum!: number | null;

  @Column({ name: "covered_area_names", type: "text", array: true })
  coveredAreaNames!: string[];

  @OneToMany(() => ChartCoverage, (coverage) => coverage.cell, {
    cascade: ["insert"],
  })
  coverages!: Relation<ChartCoverage[]>;

  @OneToMany(() => ChartSurvey, (survey) => survey.cell, {
    cascade: ["insert"],
  })
  surveys!: Relation<ChartSurvey[]>;
}
