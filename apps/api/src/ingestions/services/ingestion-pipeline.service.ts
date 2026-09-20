import path from 'node:path';
import { rm } from 'node:fs/promises';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ProcessingJob } from '../models/processing.js';
import { ChartCatalogService } from './chart-catalog.service.js';
import { EncArchiveService } from './enc-archive.service.js';
import { EncProcessingService } from './enc-processing.service.js';

@Injectable()
export class IngestionPipelineService {
  private readonly logger = new Logger(IngestionPipelineService.name);
  private readonly storageDirectory: string;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(ChartCatalogService)
    private readonly catalog: ChartCatalogService,
    @Inject(EncArchiveService)
    private readonly archiveService: EncArchiveService,
    @Inject(EncProcessingService)
    private readonly processor: EncProcessingService,
  ) {
    this.storageDirectory = path.resolve(
      config.getOrThrow<string>('STORAGE_DIR'),
    );
  }

  async run(job: ProcessingJob, propagateFailure = false) {
    try {
      const current = await this.catalog.findIngestion(job.ingestionId!);
      if (current?.status === 'published') return;
      if (current?.status === 'ready') {
        await this.catalog.publishReadyVersion(job.versionId!);
        this.logger.log(`Published recovered chart version ${job.versionKey}`);
        return;
      }
      if (!(await this.catalog.claimForProcessing(job.ingestionId!))) return;
      await this.archiveService.inspect(path.join(this.storageDirectory, job.archivePath!));
      await this.catalog.markProcessing(job.ingestionId!);
      let publishedShards = 0;
      const result = await this.processor.process(job, async (shard) => {
        const revision = await this.catalog.publishShard(job.ingestionId!, shard);
        publishedShards += 1;
        this.logger.log(
          `Published chart shard ${shard.shardKey} as catalog revision ${revision}`,
        );
      });
      if (publishedShards > 0) {
        await this.catalog.finishIncrementalIngestion(job.ingestionId!);
        this.logger.log(
          `Completed incremental chart ingestion ${job.versionKey} (${publishedShards} shards)`,
        );
      } else {
        // Compatibility for processors/storage backends that do not emit shards.
        await this.catalog.markReady(job.ingestionId!, result);
        await this.catalog.publishReadyVersion(job.versionId!);
        this.logger.log(`Published chart version ${job.versionKey}`);
      }
    } catch (error) {
      this.logger.error(
        `Chart processing failed for ingestion ${job.ingestionId}`,
        error instanceof Error ? error.stack : String(error),
      );
      if (job.ingestionId) await this.catalog.markFailed(job.ingestionId, error);
      if (propagateFailure) throw error;
    } finally {
      await rm(path.join(this.storageDirectory, '.processing', job.ingestionId), { force: true, recursive: true });
    }
  }

  async removeSource(job: ProcessingJob) {
    const expected = path.posix.join('ingestions', job.ingestionId, 'source.zip');
    if (job.archivePath.replaceAll('\\', '/') !== expected) {
      throw new Error(`Refusing to remove unexpected ENC source path: ${job.archivePath}`);
    }
    await rm(path.join(this.storageDirectory, 'ingestions', job.ingestionId), {
      force: true,
      recursive: true,
      maxRetries: 3,
    });
  }
}
