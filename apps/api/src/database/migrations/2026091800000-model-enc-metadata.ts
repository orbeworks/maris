import { randomUUID } from "node:crypto";
import { Table } from "typeorm";
import type { MigrationInterface, QueryRunner } from "typeorm";

export class ModelEncMetadata2026091800000 implements MigrationInterface {
  name = "ModelEncMetadata2026091800000";

  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "chart_cells",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "version_id", type: "uuid" },
          { name: "name", type: "text" },
          { name: "source", type: "text", isNullable: true },
          { name: "agency_code", type: "integer", isNullable: true },
          { name: "edition", type: "text", isNullable: true },
          { name: "update_number", type: "integer" },
          { name: "updates_applied", type: "integer", isArray: true },
          { name: "issue_date", type: "date", isNullable: true },
          { name: "update_application_date", type: "date", isNullable: true },
          { name: "compilation_scale", type: "integer", isNullable: true },
          { name: "horizontal_datum", type: "integer", isNullable: true },
          { name: "vertical_datum", type: "integer", isNullable: true },
          { name: "sounding_datum", type: "integer", isNullable: true },
          { name: "covered_area_names", type: "text", isArray: true },
        ],
        foreignKeys: [
          {
            columnNames: ["version_id"],
            referencedTableName: "chart_versions",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
        indices: [
          {
            name: "chart_cells_version_name_unique",
            columnNames: ["version_id", "name"],
            isUnique: true,
          },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "chart_coverages",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "cell_id", type: "uuid" },
          { name: "category", type: "integer", isNullable: true },
          { name: "geometry", type: "jsonb", isNullable: true },
        ],
        foreignKeys: [
          {
            columnNames: ["cell_id"],
            referencedTableName: "chart_cells",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
        indices: [
          { name: "chart_coverages_cell_index", columnNames: ["cell_id"] },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "chart_surveys",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "cell_id", type: "uuid" },
          { name: "object_class", type: "text" },
          { name: "data_quality", type: "integer", isNullable: true },
          { name: "survey_source", type: "text", isNullable: true },
          { name: "survey_date", type: "date", isNullable: true },
          { name: "survey_started_at", type: "date", isNullable: true },
          { name: "survey_ended_at", type: "date", isNullable: true },
          { name: "geometry", type: "jsonb", isNullable: true },
        ],
        foreignKeys: [
          {
            columnNames: ["cell_id"],
            referencedTableName: "chart_cells",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
        indices: [
          { name: "chart_surveys_cell_index", columnNames: ["cell_id"] },
        ],
      }),
    );

    // Snapshot conversion deliberately belongs to this migration, not application entities.
    // Retain the legacy column as an archival copy; new application writes use the tables above.
    const versions = await runner.query(
      "SELECT id, edition_metadata FROM chart_versions",
    );
    const date = (value: unknown) => {
      const raw = String(value ?? "");
      if (!/^\d{8}$/.test(raw)) return null;
      const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      const parsed = new Date(iso);
      return Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === iso
        ? iso
        : null;
    };
    for (const version of versions) {
      for (const cell of version.edition_metadata ?? []) {
        const id = randomUUID();
        const m = cell.metadata ?? {};
        await runner.query(
          `INSERT INTO chart_cells
          (id, version_id, name, source, agency_code, edition, update_number, updates_applied,
           issue_date, update_application_date, compilation_scale, horizontal_datum, vertical_datum,
           sounding_datum, covered_area_names)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            id,
            version.id,
            cell.name,
            m.source ?? null,
            m.agencyCode ?? null,
            cell.edition,
            cell.updateNumber,
            cell.updatesApplied ?? [],
            m.issueDate ?? null,
            m.updateApplicationDate ?? null,
            m.compilationScale ?? null,
            m.horizontalDatum ?? null,
            m.verticalDatum ?? null,
            m.soundingDatum ?? null,
            m.coveredAreaNames ?? [],
          ],
        );
        for (const feature of m.coverage ?? []) {
          await runner.query(
            "INSERT INTO chart_coverages (id,cell_id,category,geometry) VALUES ($1,$2,$3,$4)",
            [
              randomUUID(),
              id,
              feature.properties.CATCOV ?? null,
              JSON.stringify(feature.geometry),
            ],
          );
        }
        for (const [objectClass, features] of Object.entries(
          m.metaObjects ?? {},
        )) {
          for (const feature of features as Array<{
            properties: Record<string, unknown>;
            geometry: unknown;
          }>) {
            const p = feature.properties;
            if (
              !["CATZOC", "SORIND", "SORDAT", "SURSTA", "SUREND"].some(
                (key) => p[key] != null,
              )
            )
              continue;
            await runner.query(
              `INSERT INTO chart_surveys
              (id,cell_id,object_class,data_quality,survey_source,survey_date,survey_started_at,survey_ended_at,geometry)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                randomUUID(),
                id,
                objectClass,
                p.CATZOC ?? null,
                p.SORIND ?? null,
                date(p.SORDAT),
                date(p.SURSTA),
                date(p.SUREND),
                JSON.stringify(feature.geometry),
              ],
            );
          }
        }
      }
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("chart_surveys");
    await runner.dropTable("chart_coverages");
    await runner.dropTable("chart_cells");
  }
}
