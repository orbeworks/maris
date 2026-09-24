export class EncCellDto {
  name!: string;
  updateNumbers!: number[];
}

export class EncArchiveDto {
  catalogPresent!: boolean;
  cellCount!: number;
  cells!: EncCellDto[];
  compressedBytes!: number;
  entryCount!: number;
  fileCount!: number;
  uncompressedBytes!: number;
}

export class IngestionChecksumDto {
  algorithm!: "sha256";
  value!: string;
}

export class IngestionDto {
  archive!: Pick<EncArchiveDto, "cells">;
  checksum!: IngestionChecksumDto;
  createdAt!: string;
  datasetId!: string;
  error!: string | null;
  id!: string;
  originalFilename!: string;
  sizeBytes!: number;
  sourceType!: "S57";
  status!: IngestionStatus;
  storagePath!: string;
  updatedAt!: string;
  versionId!: string;
  versionKey!: string;
}

export class UploadEncDto {
  file!: Express.Multer.File;
}
import type { IngestionStatus } from "../models/processing.js";
