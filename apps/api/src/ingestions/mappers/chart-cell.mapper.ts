import { randomUUID } from "node:crypto";
import { ChartCell } from "../entities/chart-cell.entity.js";
import { ChartCoverage } from "../entities/chart-coverage.entity.js";
import { ChartSurvey } from "../entities/chart-survey.entity.js";
import type { ProcessedCell } from "../types/ingestion.types.js";

export function encDate(value: unknown): string | null {
  const raw = String(value ?? "");
  if (!/^\d{8}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === iso
    ? iso
    : null;
}

export function mapChartCell(
  versionId: string,
  input: ProcessedCell,
  shardId: string | null = null,
): ChartCell {
  const metadata = input.metadata;
  const cell = Object.assign(new ChartCell(), {
    id: randomUUID(),
    versionId,
    shardId,
    name: input.name,
    edition: input.edition,
    updateNumber: input.updateNumber,
    updatesApplied: input.updatesApplied,
    source: metadata?.source ?? null,
    agencyCode: metadata?.agencyCode ?? null,
    issueDate: metadata?.issueDate ?? null,
    updateApplicationDate: metadata?.updateApplicationDate ?? null,
    compilationScale: metadata?.compilationScale ?? null,
    horizontalDatum: metadata?.horizontalDatum ?? null,
    verticalDatum: metadata?.verticalDatum ?? null,
    soundingDatum: metadata?.soundingDatum ?? null,
    coveredAreaNames: metadata?.coveredAreaNames ?? [],
  });
  cell.coverages = (metadata?.coverage ?? []).map((feature) =>
    Object.assign(new ChartCoverage(), {
      id: randomUUID(),
      cellId: cell.id,
      category:
        typeof feature.properties.CATCOV === "number"
          ? feature.properties.CATCOV
          : null,
      geometry: feature.geometry,
    }),
  );
  cell.surveys = Object.entries(metadata?.metaObjects ?? {}).flatMap(
    ([objectClass, features]) =>
      features
        .filter(({ properties: p }) =>
          ["CATZOC", "SORIND", "SORDAT", "SURSTA", "SUREND"].some(
            (key) => p[key] != null,
          ),
        )
        .map((feature) => {
          const p = feature.properties;
          return Object.assign(new ChartSurvey(), {
            id: randomUUID(),
            cellId: cell.id,
            objectClass,
            dataQuality: typeof p.CATZOC === "number" ? p.CATZOC : null,
            surveySource: typeof p.SORIND === "string" ? p.SORIND : null,
            // SORDAT is the source date, not necessarily the date of survey execution.
            surveyDate: encDate(p.SORDAT),
            surveyStartedAt: encDate(p.SURSTA),
            surveyEndedAt: encDate(p.SUREND),
            geometry: feature.geometry,
          });
        }),
  );
  return cell;
}
