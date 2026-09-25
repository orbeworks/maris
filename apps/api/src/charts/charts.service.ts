import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { ChartCell } from "../ingestions/entities/chart-cell.entity.js";
import { ChartSurvey } from "../ingestions/entities/chart-survey.entity.js";
import { ChartVersion } from "../ingestions/entities/chart-version.entity.js";
import { ChartCatalogService } from "../ingestions/services/chart-catalog.service.js";
import {
  CHART_STORAGE,
  type ChartStorage,
} from "../tiles/storage/chart-storage.js";
import { ChartQueryDto } from "./dtos/chart-query.dto.js";
import type { ChartInformationDto } from "./dtos/chart-information.dto.js";
import {
  ChartSelection,
  CHART_SELECTION_POLICY,
  coversPoint,
} from "./models/chart-selection.js";
import { Cacheable } from "../utils/cacheable.decorator.js";
import { TimeInSeconds } from "../utils/time-in-seconds.enum.js";

@Injectable()
export class ChartsService {
  constructor(
    @Inject(DataSource) private readonly database: DataSource,
    @Inject(CHART_STORAGE) private readonly storage: ChartStorage,
    @Inject(ChartCatalogService)
    private readonly catalog: ChartCatalogService = undefined as never,
  ) {}

  @Cacheable({
    ttl: TimeInSeconds.DAY,
  })
  async atPoint(query: ChartQueryDto): Promise<ChartInformationDto> {
    const catalogRevision = query.version
      ? /^catalog-(\d+)$/.exec(query.version)?.[1]
      : undefined;

    const incremental = this.catalog?.getPublishedCatalog
      ? await this.catalog.getPublishedCatalog(
          "soundg",
          catalogRevision === undefined ? undefined : Number(catalogRevision),
        )
      : null;

    if (incremental && (!query.version || catalogRevision !== undefined)) {
      const cells = await this.catalog.getPublishedCells(
        "soundg",
        incremental.revision,
      );

      const coordinate: [number, number] = [query.lon, query.lat];

      const selected = new ChartSelection(cells).at(coordinate);

      const cell =
        selected &&
        cells.find(
          (candidate) =>
            candidate.name === selected.name &&
            candidate.edition === selected.edition &&
            candidate.updateNumber === selected.updateNumber,
        );

      if (!cell) {
        throw new NotFoundException("No ENC coverage at this coordinate");
      }

      return this.information(
        cell,
        coordinate,
        `catalog-${incremental.revision}`,
        cell.shard?.publishedAt ?? null,
        cell.shard?.publishedAt ?? null,
      );
    }

    const version = await this.database.getRepository(ChartVersion).findOne({
      where: {
        status: "published",
        dataset: { key: "soundg" },
        ...(query.version ? { versionKey: query.version } : { active: true }),
      },
    });

    if (!version) {
      throw new NotFoundException("Published chart version not found");
    }

    const manifest = await this.storage.getManifest(
      "soundg",
      version.versionKey,
    );

    if (manifest.selectionPolicy !== CHART_SELECTION_POLICY) {
      throw new ConflictException(
        "This legacy dataset has overlapping charts; update the chart dataset",
      );
    }

    // Coverage metadata only. Never load the sounding GeoJSON or PMTiles here.
    const cells = await this.database.getRepository(ChartCell).find({
      where: { versionId: version.id },
      relations: { coverages: true },
    });

    const coordinate: [number, number] = [query.lon, query.lat];

    const selected = new ChartSelection(cells).at(coordinate);

    const cell =
      selected &&
      cells.find(
        (c) =>
          c.name === selected.name &&
          c.edition === selected.edition &&
          c.updateNumber === selected.updateNumber,
      );

    if (!cell) {
      throw new NotFoundException("No ENC coverage at this coordinate");
    }

    return this.information(
      cell,
      coordinate,
      version.versionKey,
      version.processedAt,
      version.publishedAt,
    );
  }

  private async information(
    cell: ChartCell,
    coordinate: [number, number],
    version: string,
    processedAt: Date | null,
    publishedAt: Date | null,
  ): Promise<ChartInformationDto> {
    const surveys = (
      await this.database.getRepository(ChartSurvey).find({
        where: { cellId: cell.id },
        order: { objectClass: "ASC", id: "ASC" },
      })
    ).filter(
      (survey) =>
        survey.geometry === null || coversPoint(survey.geometry, coordinate),
    );

    return {
      id: cell.id,
      name: cell.name,
      source: cell.source,
      edition: cell.edition,
      updateNumber: cell.updateNumber,
      updatesApplied: cell.updatesApplied,
      issueDate: cell.issueDate,
      updateApplicationDate: cell.updateApplicationDate,
      compilationScale: cell.compilationScale,
      coveredAreaNames: cell.coveredAreaNames,
      horizontalDatum: cell.horizontalDatum,
      soundingDatum: cell.soundingDatum,
      verticalDatum: cell.verticalDatum,
      dataQuality: [
        ...new Set(
          surveys.flatMap((s) =>
            s.dataQuality === null ? [] : [s.dataQuality],
          ),
        ),
      ].sort((a, b) => a - b),
      surveys: surveys.map((s) => ({
        objectClass: s.objectClass,
        source: s.surveySource,
        date: s.surveyDate,
        startedAt: s.surveyStartedAt,
        endedAt: s.surveyEndedAt,
      })),
      version,
      processedAt: processedAt?.toISOString() ?? null,
      publishedAt: publishedAt?.toISOString() ?? null,
      coordinate,
    };
  }
}
