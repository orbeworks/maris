import path from "node:path";

import {
  HttpException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import type { EncArchiveDto } from "../dtos/ingestion.dto.js";

type InspectOptions = {
  maxEntries: number;
  maxUncompressedBytes: number;
};

type MutableCell = {
  hasBase: boolean;
  updates: Set<number>;
};

const CELL_FILE_PATTERN = /^([A-Z0-9]{8})\.(\d{3})$/i;
const MAX_COMPRESSION_RATIO = 200;

@Injectable()
export class EncArchiveService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async inspect(archivePath: string): Promise<EncArchiveDto> {
    const options: InspectOptions = {
      maxEntries: this.config.getOrThrow<number>("MAX_ARCHIVE_ENTRIES"),
      maxUncompressedBytes: this.config.getOrThrow<number>(
        "MAX_UNCOMPRESSED_BYTES",
      ),
    };
    const zipFile = await this.openZip(archivePath);

    return new Promise((resolve, reject) => {
      let settled = false;
      let entryCount = 0;
      let fileCount = 0;
      let compressedBytes = 0;
      let uncompressedBytes = 0;
      let catalogPresent = false;
      const cells = new Map<string, MutableCell>();

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(
          error instanceof HttpException
            ? error
            : this.invalidEnc(
                "INVALID_ZIP",
                "Could not inspect the ZIP archive",
              ),
        );
      };

      zipFile.on("error", fail);
      zipFile.on("entry", (entry) => {
        try {
          entryCount += 1;
          if (entryCount > options.maxEntries) {
            throw this.invalidEnc(
              "TOO_MANY_ARCHIVE_ENTRIES",
              `Archive exceeds the ${options.maxEntries} entry limit`,
            );
          }

          this.assertSafeEntry(entry);
          if (entry.fileName.endsWith("/")) {
            zipFile.readEntry();
            return;
          }

          fileCount += 1;
          compressedBytes += entry.compressedSize;
          uncompressedBytes += entry.uncompressedSize;
          if (uncompressedBytes > options.maxUncompressedBytes) {
            throw this.invalidEnc(
              "ARCHIVE_TOO_LARGE_UNCOMPRESSED",
              `Archive expands beyond ${options.maxUncompressedBytes} bytes`,
            );
          }

          const basename = path.posix.basename(
            entry.fileName.replaceAll("\\", "/"),
          );
          if (basename.toUpperCase() === "CATALOG.031") catalogPresent = true;

          const match = CELL_FILE_PATTERN.exec(basename);
          if (match) {
            const [, rawName, rawExtension] = match;
            const name = rawName!.toUpperCase();
            const updateNumber = Number(rawExtension);
            const cell = cells.get(name) ?? {
              hasBase: false,
              updates: new Set<number>(),
            };

            if (updateNumber === 0) cell.hasBase = true;
            else cell.updates.add(updateNumber);
            cells.set(name, cell);
          }

          zipFile.readEntry();
        } catch (error) {
          fail(error);
        }
      });

      zipFile.on("end", () => {
        if (settled) return;

        try {
          if (
            uncompressedBytes / Math.max(compressedBytes, 1) >
            MAX_COMPRESSION_RATIO
          ) {
            throw this.invalidEnc(
              "SUSPICIOUS_COMPRESSION_RATIO",
              "Archive compression ratio exceeds the safety limit",
            );
          }

          const missingBases = [...cells.entries()]
            .filter(([, cell]) => !cell.hasBase)
            .map(([name]) => name);
          if (missingBases.length > 0) {
            throw this.invalidEnc(
              "MISSING_BASE_CELL",
              `Updates without matching .000 cells: ${missingBases.slice(0, 5).join(", ")}`,
            );
          }

          const completeCells = [...cells.entries()]
            .filter(([, cell]) => cell.hasBase)
            .map(([name, cell]) => ({
              name,
              updateNumbers: [...cell.updates].sort(
                (left, right) => left - right,
              ),
            }))
            .sort((left, right) => left.name.localeCompare(right.name));

          if (completeCells.length === 0) {
            throw this.invalidEnc(
              "NO_S57_CELLS",
              "Archive must contain at least one S-57 .000 base cell",
            );
          }

          settled = true;
          resolve({
            catalogPresent,
            cellCount: completeCells.length,
            cells: completeCells,
            compressedBytes,
            entryCount,
            fileCount,
            uncompressedBytes,
          });
        } catch (error) {
          fail(error);
        }
      });

      zipFile.readEntry();
    });
  }

  /** Extracts only one cell's .000/.001... entries and immediately closes the ZIP stream. */
  async extractCell(
    archivePath: string,
    cellName: string,
    destination: string,
  ): Promise<string[]> {
    const zip = await this.openZip(archivePath);
    const written: string[] = [];
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (e: unknown) => {
        if (!done) {
          done = true;
          zip.close();
          reject(e);
        }
      };
      zip.on("error", fail);
      zip.on("entry", async (entry) => {
        try {
          const base = path.posix.basename(
            entry.fileName.replaceAll("\\", "/"),
          );
          if (!new RegExp(String.raw`^${cellName}\.\d{3}$`, "i").test(base)) {
            zip.readEntry();
            return;
          }
          const target = path.join(destination, base);
          await pipeline(
            await new Promise<NodeJS.ReadableStream>((res, rej) =>
              zip.openReadStream(entry, (err, stream) =>
                err || !stream
                  ? rej(err ?? new Error("ZIP stream unavailable"))
                  : res(stream),
              ),
            ),
            createWriteStream(target),
          );
          written.push(target);
          zip.readEntry();
        } catch (e) {
          fail(e);
        }
      });
      zip.on("end", () => {
        if (!done) {
          done = true;
          resolve(written);
        }
      });
      zip.readEntry();
    });
  }

  private assertSafeEntry(entry: Entry) {
    const normalized = entry.fileName.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (
      normalized.includes("\0") ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) ||
      segments.includes("..")
    ) {
      throw this.invalidEnc(
        "UNSAFE_ARCHIVE_PATH",
        `Unsafe path in archive: ${entry.fileName}`,
      );
    }

    if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
      throw this.invalidEnc(
        "ENCRYPTED_ARCHIVE_ENTRY",
        `Encrypted entries are not supported: ${entry.fileName}`,
      );
    }
  }

  private invalidEnc(code: string, message: string) {
    return new UnprocessableEntityException({ code, message, statusCode: 422 });
  }

  private openZip(archivePath: string) {
    return new Promise<ZipFile>((resolve, reject) => {
      yauzl.open(
        archivePath,
        { autoClose: true, decodeStrings: true, lazyEntries: true },
        (error, zipFile) => {
          if (error || !zipFile) {
            reject(
              this.invalidEnc(
                "INVALID_ZIP",
                error?.message ??
                  "The uploaded file is not a readable ZIP archive",
              ),
            );
            return;
          }
          resolve(zipFile);
        },
      );
    });
  }
}
