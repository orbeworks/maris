import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";

import type { IngestionDto, UploadEncDto } from "./dtos/ingestion.dto.js";
import { IngestionsService } from "./services/ingestions.service.js";
import { NoStore } from "../utils/http-cache.decorator.js";

@Controller("ingestions")
export class IngestionsController {
  constructor(
    @Inject(IngestionsService)
    private readonly ingestionsService: IngestionsService,
  ) {}

  @Post("enc")
  @NoStore()
  @UseInterceptors(FileInterceptor("file"))
  async createEncIngestion(
    @UploadedFile() file?: UploadEncDto["file"],
  ): Promise<IngestionDto> {
    if (!file) {
      throw new BadRequestException('Multipart field "file" is required');
    }

    return this.ingestionsService.create(file);
  }

  @Get(":id")
  @NoStore()
  async findIngestion(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<IngestionDto> {
    const ingestion = await this.ingestionsService.find(id);

    if (!ingestion) {
      throw new NotFoundException("Ingestion not found");
    }

    return ingestion;
  }
}
