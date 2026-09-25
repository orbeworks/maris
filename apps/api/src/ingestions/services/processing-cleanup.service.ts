import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

@Injectable()
export class ProcessingCleanupService {
  private readonly logger = new Logger(ProcessingCleanupService.name);
  private readonly storage: string;
  private readonly charts: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.storage = path.resolve(config.getOrThrow<string>("STORAGE_DIR"));
    this.charts = path.resolve(config.getOrThrow<string>("CHART_STORAGE_DIR"));
  }

  // Run before accepting uploads or starting jobs. Assumes the current single worker/volume.
  async recoverOrphans() {
    await this.clean(
      path.join(this.storage, ".processing"),
      new RegExp(`^${UUID}$`, "i"),
      true,
    );
    await this.clean(
      path.join(this.storage, ".tmp"),
      new RegExp(String.raw`^${UUID}\.zip$`, "i"),
      false,
    );
    await this.clean(
      path.join(this.charts, "soundg", "versions"),
      /^\.[a-zA-Z0-9][a-zA-Z0-9._-]*\.\d+\.tmp$/,
      true,
    );
  }

  async cleanVersion(versionKey: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(versionKey))
      throw new Error("Invalid version key");
    const escaped = versionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await this.clean(
      path.join(this.charts, "soundg", "versions"),
      new RegExp(String.raw`^\.${escaped}\.\d+\.tmp$`),
      true,
    );
  }

  private async clean(
    directory: string,
    allowed: RegExp,
    directories: boolean,
  ) {
    try {
      // Never follow a replacement symlink outside the managed temporary roots.
      if (!(await lstat(directory)).isDirectory())
        throw new Error(`Invalid temporary directory: ${directory}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !allowed.test(entry.name) ||
        (directories ? !entry.isDirectory() : !entry.isFile())
      )
        continue;
      await rm(path.join(directory, entry.name), {
        recursive: directories,
        force: true,
        maxRetries: 3,
      });
      this.logger.log(`Removed orphan temporary artifact: ${entry.name}`);
    }
  }
}
