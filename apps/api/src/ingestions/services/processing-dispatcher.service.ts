import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { ProcessingJob } from "../types/ingestion.types.js";
import { ChartCatalogService } from "./chart-catalog.service.js";
import { IngestionPipelineService } from "./ingestion-pipeline.service.js";
import { ProcessingCleanupService } from "./processing-cleanup.service.js";

@Injectable()
export class ProcessingDispatcherService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProcessingDispatcherService.name);
  private readonly enabled: boolean;
  private active = false;
  private reserved = false;

  constructor(
    @Inject(ChartCatalogService) private readonly catalog: ChartCatalogService,
    @Inject(IngestionPipelineService)
    private readonly pipeline: IngestionPipelineService,
    @Inject(ProcessingCleanupService)
    private readonly cleanup: ProcessingCleanupService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.enabled =
      config.get<boolean>("ENC_PROCESSING_ENABLED", true) !== false;
  }

  async onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log("disabled by ENC_PROCESSING_ENABLED");
      return;
    }
    await this.cleanup.recoverOrphans();
    await this.startNextRecoverable();
  }

  reserve() {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        "ENC ingestion is disabled on this API instance",
      );
    }
    if (this.active || this.reserved) {
      throw new ServiceUnavailableException(
        "An ENC ingestion is already processing on this API instance",
      );
    }
    this.reserved = true;
  }

  releaseReservation() {
    this.reserved = false;
  }

  dispatch(job: ProcessingJob) {
    if (!this.reserved) {
      throw new Error("ENC processing must be reserved before dispatch");
    }
    this.reserved = false;
    this.launch(job);
  }

  private launch(job: ProcessingJob) {
    this.active = true;
    void this.process(job);
  }

  private async process(job: ProcessingJob) {
    try {
      await this.pipeline.run(job, true);
      this.logger.log(`ENC ingestion ${job.ingestionId} completed`);
    } catch (error) {
      this.logger.error(
        `ENC ingestion ${job.ingestionId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      try {
        await this.pipeline.removeSource(job);
      } catch (error) {
        this.logger.error(
          `ENC source cleanup failed for ${job.ingestionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      this.active = false;
      try {
        await this.startNextRecoverable();
      } catch (error) {
        this.logger.error(
          `ENC recovery lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async startNextRecoverable() {
    if (!this.enabled || this.active || this.reserved) return;
    const [job] = await this.catalog.listRecoverableJobs();
    if (job) this.launch(job);
  }
}
