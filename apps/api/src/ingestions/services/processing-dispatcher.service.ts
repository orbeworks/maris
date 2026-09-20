import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, UnrecoverableError } from 'bullmq';
import type { ProcessingJob } from '../models/processing.js';
import { ChartCatalogService } from './chart-catalog.service.js';
import { IngestionPipelineService } from './ingestion-pipeline.service.js';
import { ProcessingCleanupService } from './processing-cleanup.service.js';

export const ENC_QUEUE = 'enc-processing';

@Injectable()
export class ProcessingDispatcherService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProcessingDispatcherService.name);
  private readonly queue: Queue<ProcessingJob>;
  private worker?: Worker<ProcessingJob>;
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  private readonly enabled: boolean;
  private readonly connection;
  private readonly prefix: string;

  constructor(
    @Inject(ChartCatalogService) private readonly catalog: ChartCatalogService,
    @Inject(IngestionPipelineService) private readonly pipeline: IngestionPipelineService,
    @Inject(ProcessingCleanupService) private readonly cleanup: ProcessingCleanupService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('ENC_PROCESSING_ENABLED', true) !== false;
    const url = new URL(config.getOrThrow<string>('REDIS_URL'));
    this.prefix = config.get<string>('ENC_QUEUE_PREFIX', 'maris');
    this.connection = {
      host: url.hostname, port: Number(url.port || 6379),
      username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      db: Number(url.pathname.slice(1) || 0),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}), connectTimeout: 5000,
    };
    this.queue = new Queue<ProcessingJob>(ENC_QUEUE, {
      prefix: this.prefix,
      connection: { ...this.connection, maxRetriesPerRequest: 1 },
      defaultJobOptions: {
        attempts: 3, backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 604800, count: 1000 },
        removeOnFail: { age: 2592000, count: 1000 },
      },
    });
    this.queue.on('error', (error) => this.logger.error(`ENC queue: ${error.message}`));
  }

  async onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log('disabled by ENC_PROCESSING_ENABLED');
      return;
    }
    await this.cleanup.recoverOrphans();
    await this.queue.waitUntilReady();
    await this.queue.setGlobalConcurrency(1);
    await this.reconcile();
    this.worker = new Worker<ProcessingJob>(ENC_QUEUE, async (job) => {
      try {
        await this.pipeline.run(job.data, true);
        // A job is successful only after its local source has been removed.
        // If cleanup fails, BullMQ retries and the already-published bucket
        // artifacts make processing idempotent.
        await this.pipeline.removeSource(job.data);
      } catch (error) {
        if (error instanceof Error && /ENOSPC|No SOUNDG layer found/.test(error.message)) throw new UnrecoverableError(error.message);
        throw error;
      }
    }, { prefix: this.prefix, connection: { ...this.connection, maxRetriesPerRequest: null }, concurrency: 1, maxStalledCount: 2 });
    this.worker.on('error', (error) => this.logger.error(`ENC worker: ${error.message}`));
    this.worker.on('failed', (job, error) => {
      this.logger.error(`ENC job ${job?.id}: ${error.message}`);
      const attempts = Number(job?.opts.attempts ?? 1);
      if (job && (error instanceof UnrecoverableError || job.attemptsMade >= attempts)) {
        void this.pipeline.removeSource(job.data).catch((cleanupError: Error) => this.logger.error(cleanupError.message));
      }
    });
    this.worker.on('completed', (job) => this.logger.log(`ENC job ${job.id} completed`));
    await this.worker.waitUntilReady();
    this.timer = setInterval(() => void this.reconcile().catch((error: Error) => this.logger.error(error.message)), 30_000);
    this.timer.unref();
  }

  async dispatch(job: ProcessingJob) {
    if (!this.enabled) return;
    try {
      // The ingestion is the idempotency boundary. A retry may reuse the same
      // source object, but must get a new BullMQ id after a previous failed job
      // remains in Redis.
      await this.queue.add('import-enc', job, { jobId: job.ingestionId });
    } catch (error) {
      // Preserve the persisted ingestion and ZIP; PostgreSQL reconciliation retries enqueueing.
      this.logger.error(`Enqueue pending for ${job.ingestionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  ensureEnabled() {
    if (!this.enabled) throw new ServiceUnavailableException('ENC ingestion is disabled on this API instance');
  }

  private async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const job of await this.catalog.listRecoverableJobs()) await this.dispatch(job);
    } finally { this.reconciling = false; }
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue.close();
  }
}
