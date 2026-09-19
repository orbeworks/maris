import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { EncArchiveDto } from '../dtos/ingestion.dto.js';
import { ChartDataset } from '../entities/chart-dataset.entity.js';
import { ChartIngestion } from '../entities/chart-ingestion.entity.js';
import { ChartVersion } from '../entities/chart-version.entity.js';
import { ChartCell } from '../entities/chart-cell.entity.js';
import { ChartCoverage } from '../entities/chart-coverage.entity.js';
import { ChartSurvey } from '../entities/chart-survey.entity.js';
import { mapChartCell } from '../models/chart-cell.mapper.js';
import type {
  IngestionStatus,
  ProcessingJob,
  ProcessingResult,
} from '../models/processing.js';

export type CatalogIngestion = {
  archive: Pick<EncArchiveDto, 'cells'>;
  checksum: { algorithm: 'sha256'; value: string };
  createdAt: string;
  datasetId: string;
  error: string | null;
  id: string;
  originalFilename: string;
  sizeBytes: number;
  sourceType: 'S57';
  status: IngestionStatus;
  storagePath: string;
  updatedAt: string;
  versionId: string;
  versionKey: string;
};

@Injectable()
export class ChartCatalogService {
  constructor(private readonly dataSource: DataSource) {}

  async createIngestion(input: {
    archive: EncArchiveDto;
    checksum: string;
    ingestionId: string;
    originalFilename: string;
    sizeBytes: number;
    storagePath: string;
  }): Promise<CatalogIngestion> {
    const versionId = randomUUID();
    const datasetKey = 'soundg';
    const versionKey = `${datasetKey}-${versionId}`;

    await this.dataSource.transaction(async (manager) => {
      const dataset = await manager.getRepository(ChartDataset).findOneBy({
        key: datasetKey,
      });
      if (!dataset) throw new Error(`Dataset ${datasetKey} is not configured`);

      const ingestions = manager.getRepository(ChartIngestion);
      await ingestions.save(
        ingestions.create({
          archiveStoragePath: input.storagePath,
          checksumSha256: input.checksum,
          datasetId: dataset.id,
          id: input.ingestionId,
          sourceCells: input.archive.cells,
          sourceFilename: input.originalFilename,
          sourceSizeBytes: String(input.sizeBytes),
          status: 'received',
        }),
      );
      const versions = manager.getRepository(ChartVersion);
      await versions.save(
        versions.create({
          datasetId: dataset.id,
          id: versionId,
          ingestionId: input.ingestionId,
          status: 'received',
          versionKey,
        }),
      );
    });

    const ingestion = await this.findIngestion(input.ingestionId);
    if (!ingestion) throw new Error('Created ingestion could not be loaded');
    return ingestion;
  }

  async findIngestion(id: string): Promise<CatalogIngestion | null> {
    const ingestion = await this.dataSource.getRepository(ChartIngestion).findOne({
      relations: { dataset: true, version: true },
      where: { id },
    });
    return ingestion ? this.toIngestion(ingestion) : null;
  }

  async listRecoverableJobs(): Promise<ProcessingJob[]> {
    const ingestions = await this.dataSource.getRepository(ChartIngestion).find({
      order: { createdAt: 'ASC' },
      relations: { version: true },
      where: [
        { status: 'received' },
        { status: 'validating' },
        { status: 'processing' },
        { status: 'ready' },
      ],
    });
    return ingestions.map((ingestion) => ({
      archivePath: ingestion.archiveStoragePath ?? '',
      ingestionId: ingestion.id,
      versionId: ingestion.version.id,
      versionKey: ingestion.version.versionKey,
    }));
  }

  async claimForProcessing(ingestionId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const ingestionResult = await manager
        .getRepository(ChartIngestion)
        .createQueryBuilder()
        .update()
        .set({
          errorMessage: null,
          errorStack: null,
          processingStartedAt: () => 'COALESCE(processing_started_at, now())',
          status: 'validating',
          updatedAt: () => 'now()',
        })
        .where('id = :ingestionId', { ingestionId })
        .andWhere('status IN (:...statuses)', {
          statuses: ['received', 'validating', 'processing', 'failed'],
        })
        .execute();
      if (ingestionResult.affected !== 1) return false;

      await manager
        .getRepository(ChartVersion)
        .createQueryBuilder()
        .update()
        .set({
          errorMessage: null,
          errorStack: null,
          status: 'validating',
          updatedAt: () => 'now()',
        })
        .where('ingestion_id = :ingestionId', { ingestionId })
        .andWhere('status IN (:...statuses)', {
          statuses: ['received', 'validating', 'processing', 'failed'],
        })
        .execute();
      return true;
    });
  }

  async markProcessing(ingestionId: string) {
    await this.updateStatus(ingestionId, 'processing');
  }

  async markReady(ingestionId: string, result: ProcessingResult) {
    const maximumUpdate = Math.max(
      0,
      ...result.cells.map((cell) => cell.updateNumber),
    );
    await this.dataSource.transaction(async (manager) => {
      const version = await manager.getRepository(ChartVersion).findOneByOrFail({ ingestionId });
      await manager.getRepository(ChartCell).delete({ versionId: version.id });
      const mappedCells = result.cells.map((cell) => mapChartCell(version.id, cell));
      // Chunk each entity independently: root-only chunking still lets cascade
      // inserts exceed PostgreSQL's parameter limit for survey/coverage rows.
      const cells = mappedCells.map(({ coverages, surveys, ...cell }) => cell);
      const coverages = mappedCells.flatMap((cell) => cell.coverages);
      const surveys = mappedCells.flatMap((cell) => cell.surveys);
      const saveOptions = { chunk: 500, reload: false };
      await manager.getRepository(ChartCell).save(cells, saveOptions);
      await manager.getRepository(ChartCoverage).save(coverages, saveOptions);
      await manager.getRepository(ChartSurvey).save(surveys, saveOptions);
      await manager.getRepository(ChartIngestion).update(ingestionId, {
        errorMessage: null,
        errorStack: null,
        processedAt: new Date(),
        status: 'ready',
      });
      await manager.getRepository(ChartVersion).createQueryBuilder()
        .update()
        .set({
          bounds: result.bounds,
          errorMessage: null,
          errorStack: null,
          manifestPath: result.manifestPath,
          processedAt: new Date(),
          status: 'ready',
          storagePath: result.storagePath,
          updateNumber: maximumUpdate,
        })
        .where('ingestion_id = :ingestionId', { ingestionId })
        .execute();
    });
  }

  async markFailed(ingestionId: string, error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const message = normalized.message.slice(0, 4_000);
    const stack = normalized.stack?.slice(0, 16_000) ?? null;
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(ChartIngestion).update(ingestionId, {
        errorMessage: message,
        errorStack: stack,
        processedAt: new Date(),
        status: 'failed',
      });
      await manager.getRepository(ChartVersion).update(
        { ingestionId },
        {
          active: false,
          errorMessage: message,
          errorStack: stack,
          processedAt: new Date(),
          status: 'failed',
        },
      );
    });
  }

  async publishReadyVersion(versionId: string) {
    return this.dataSource.transaction(async (manager) => {
      const versions = manager.getRepository(ChartVersion);
      const version = await versions.findOne({
        lock: { mode: 'pessimistic_write' },
        where: { id: versionId },
      });
      if (!version) throw new NotFoundException('Chart version not found');
      if (version.status !== 'ready') {
        throw new ConflictException('Only ready chart versions can be published');
      }

      await manager.getRepository(ChartDataset).findOne({
        lock: { mode: 'pessimistic_write' },
        where: { id: version.datasetId },
      });
      await versions.update(
        { active: true, datasetId: version.datasetId },
        { active: false },
      );

      const publishedAt = new Date();
      await versions.update(version.id, {
        active: true,
        publishedAt,
        status: 'published',
      });
      await manager.getRepository(ChartIngestion).update(version.ingestionId, {
        publishedAt,
        status: 'published',
      });
      return version.versionKey;
    });
  }

  async getActiveVersion(datasetKey: string) {
    const version = await this.dataSource.getRepository(ChartVersion).findOne({
      relations: { dataset: true },
      where: {
        active: true,
        dataset: { key: datasetKey },
        status: 'published',
      },
    });
    if (!version) return null;
    return {
      manifest_path: this.required(version.manifestPath, 'manifest path'),
      version_key: version.versionKey,
    };
  }

  private async updateStatus(id: string, status: IngestionStatus) {
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(ChartIngestion).update(id, { status });
      await manager.getRepository(ChartVersion).update(
        { ingestionId: id },
        { status },
      );
    });
  }

  private toIngestion(ingestion: ChartIngestion): CatalogIngestion {
    return {
      archive: { cells: ingestion.sourceCells },
      checksum: {
        algorithm: 'sha256',
        value: this.required(ingestion.checksumSha256, 'checksum'),
      },
      createdAt: ingestion.createdAt.toISOString(),
      datasetId: ingestion.datasetId,
      error: ingestion.errorMessage,
      id: ingestion.id,
      originalFilename: this.required(ingestion.sourceFilename, 'source filename'),
      sizeBytes: Number(ingestion.sourceSizeBytes),
      sourceType: 'S57',
      status: ingestion.status,
      storagePath: this.required(ingestion.archiveStoragePath, 'archive path'),
      updatedAt: ingestion.updatedAt.toISOString(),
      versionId: ingestion.version.id,
      versionKey: ingestion.version.versionKey,
    };
  }

  private required<T>(value: T | null, name: string): T {
    if (value === null) throw new Error(`Missing ${name}`);
    return value;
  }
}
