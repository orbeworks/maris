import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { IngestionDto } from "../dtos/ingestion.dto.js";
import { EncArchiveService } from "./enc-archive.service.js";
import { ChartCatalogService } from "./chart-catalog.service.js";
import { ProcessingDispatcherService } from "./processing-dispatcher.service.js";

const ACCEPTED_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/x-zip-compressed",
  "application/zip",
]);

function invalidEnc(code: string, message: string) {
  return new UnprocessableEntityException({ code, message, statusCode: 422 });
}

@Injectable()
export class IngestionsService {
  private readonly storageDirectory: string;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(EncArchiveService)
    private readonly archiveService: EncArchiveService,
    @Inject(ChartCatalogService)
    private readonly catalog: ChartCatalogService,
    @Inject(ProcessingDispatcherService)
    private readonly dispatcher: ProcessingDispatcherService,
  ) {
    this.storageDirectory = path.resolve(
      config.getOrThrow<string>("STORAGE_DIR"),
    );
  }

  async create(file: Express.Multer.File): Promise<IngestionDto> {
    const ingestionId = randomUUID();
    const ingestionDirectory = path.join(
      this.storageDirectory,
      "ingestions",
      ingestionId,
    );
    const archivePath = path.join(ingestionDirectory, "source.zip");

    try {
      this.dispatcher.reserve();
      this.validateUpload(file);
      await this.assertZipSignature(file.path);
      const archive = await this.archiveService.inspect(file.path);
      const checksum = await this.calculateChecksum(file.path);
      await mkdir(ingestionDirectory, { recursive: true });
      await rename(file.path, archivePath);

      const ingestion = await this.catalog.createIngestion({
        archive,
        checksum,
        ingestionId,
        originalFilename: path.basename(file.originalname),
        sizeBytes: file.size,
        storagePath: path.relative(this.storageDirectory, archivePath),
      });
      this.dispatcher.dispatch({
        archivePath: ingestion.storagePath,
        ingestionId: ingestion.id,
        versionId: ingestion.versionId,
        versionKey: ingestion.versionKey,
      });
      return ingestion;
    } catch (error) {
      this.dispatcher.releaseReservation();
      await rm(file.path, { force: true });
      await rm(ingestionDirectory, { force: true, recursive: true });
      throw error;
    }
  }

  async find(id: string): Promise<IngestionDto | null> {
    return this.catalog.findIngestion(id);
  }

  private validateUpload(file: Express.Multer.File) {
    if (!file.originalname.toLowerCase().endsWith(".zip")) {
      throw invalidEnc(
        "INVALID_FILE_EXTENSION",
        "ENC upload must be a .zip file",
      );
    }

    if (!ACCEPTED_MIME_TYPES.has(file.mimetype.toLowerCase())) {
      throw invalidEnc(
        "INVALID_CONTENT_TYPE",
        `Unsupported content type: ${file.mimetype}`,
      );
    }

    if (file.size === 0) {
      throw invalidEnc("EMPTY_UPLOAD", "Uploaded ZIP is empty");
    }
  }

  private async assertZipSignature(filePath: string) {
    const file = await open(filePath, "r");
    try {
      const signature = Buffer.alloc(4);
      const { bytesRead } = await file.read(signature, 0, signature.length, 0);
      if (bytesRead !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) {
        throw invalidEnc("INVALID_ZIP_SIGNATURE", "File is not a ZIP archive");
      }
    } finally {
      await file.close();
    }
  }

  private async calculateChecksum(filePath: string) {
    const checksum = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) {
      checksum.update(chunk);
    }
    return checksum.digest("hex");
  }
}
