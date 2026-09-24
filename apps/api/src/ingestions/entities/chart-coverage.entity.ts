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

@Entity({ name: "chart_coverages" })
@Index("chart_coverages_cell_index", ["cellId"])
export class ChartCoverage {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ name: "cell_id", type: "uuid" })
  cellId!: string;

  @ManyToOne(() => ChartCell, (cell) => cell.coverages, { onDelete: "CASCADE" })
  @JoinColumn({ name: "cell_id" })
  cell!: Relation<ChartCell>;

  @Column({ type: "integer", nullable: true })
  category!: number | null;

  @Column({ type: "jsonb", nullable: true })
  geometry!: EncMetadataFeature["geometry"];
}
