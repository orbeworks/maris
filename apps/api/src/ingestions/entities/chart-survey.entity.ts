import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from "typeorm";
import type { Relation } from "typeorm";
import { ChartCell } from "./chart-cell.entity.js";
import type { EncMetadataFeature } from "../models/processing.js";

@Entity({ name: "chart_surveys" })
@Index("chart_surveys_cell_index", ["cellId"])
export class ChartSurvey {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ name: "cell_id", type: "uuid" })
  cellId!: string;

  @ManyToOne(() => ChartCell, (cell) => cell.surveys, { onDelete: "CASCADE" })
  @JoinColumn({ name: "cell_id" })
  cell!: Relation<ChartCell>;

  @Column({ name: "object_class", type: "text" })
  objectClass!: string;

  @Column({ name: "data_quality", type: "integer", nullable: true })
  dataQuality!: number | null;

  @Column({ name: "survey_source", type: "text", nullable: true })
  surveySource!: string | null;

  @Column({ name: "survey_date", type: "date", nullable: true })
  surveyDate!: string | null;

  @Column({ name: "survey_started_at", type: "date", nullable: true })
  surveyStartedAt!: string | null;

  @Column({ name: "survey_ended_at", type: "date", nullable: true })
  surveyEndedAt!: string | null;

  @Column({ type: "jsonb", nullable: true })
  geometry!: EncMetadataFeature["geometry"];
}
