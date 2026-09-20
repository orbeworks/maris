import { Redis } from "ioredis";
import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GFS_MAX_WEATHER_ZOOM, normalizeX } from "./gfs-xyz.js";

export type ActiveGfsRun = { run: string; status: "READY" };

export function gfsRunId(run: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(run);
  return match ? `${match[1]}${match[2]}${match[3]}T${match[4]}` : run;
}

export function gfsCurrentRunId(run: string, sourceForecastHour: number) {
  return `${gfsRunId(run)}F${String(sourceForecastHour).padStart(3, "0")}`;
}

const ACTIVE_RUN_KEY = "gfs:active-run";
const LOCK_KEY = "gfs:global-prefetch-lock";
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

@Injectable()
export class GfsRedisCacheService implements OnApplicationShutdown {
  private readonly logger = new Logger(GfsRedisCacheService.name);
  private readonly redis: Redis;
  private readonly tileTtl: number;
  private readonly defaultTileTtl = 1_800;
  private hits = 0;
  private misses = 0;

  constructor(private readonly config: ConfigService) {
    this.tileTtl = this.positiveInt(
      config.get<number>("GFS_PREFETCH_TILE_TTL_SECONDS", this.defaultTileTtl),
      this.defaultTileTtl,
    );
    this.redis = new Redis(config.getOrThrow<string>("REDIS_URL"), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
    });
    this.redis.on("error", (error: Error) =>
      this.logger.warn(`[GFS Redis] unavailable: ${error.message}`),
    );
  }

  async getTile(
    run: string,
    forecastHour: number,
    x: number,
    y: number,
    z = 0,
  ) {
    try {
      await this.ensureConnected();
      const value = await this.redis.getBuffer(
        this.tileKey(run, forecastHour, z, x, y),
      );
      if (value) this.hits += 1;
      else this.misses += 1;
      return value ?? null;
    } catch (error) {
      this.misses += 1;
      this.logger.warn(`[GFS Redis] GET failed: ${this.message(error)}`);
      return null;
    }
  }

  async setTile(
    run: string,
    forecastHour: number,
    x: number,
    y: number,
    body: Buffer,
    z = 0,
  ) {
    try {
      await this.ensureConnected();
      await this.redis.set(
        this.tileKey(run, forecastHour, z, x, y),
        body,
        "EX",
        this.tileTtl,
      );
      return true;
    } catch (error) {
      this.logger.warn(`[GFS Redis] SET failed: ${this.message(error)}`);
      return false;
    }
  }

  async getActiveRun(): Promise<ActiveGfsRun | null> {
    try {
      await this.ensureConnected();
      const value = await this.redis.get(ACTIVE_RUN_KEY);
      if (!value) return null;
      const parsed = JSON.parse(value) as ActiveGfsRun;
      return parsed.status === "READY" && typeof parsed.run === "string" ? parsed : null;
    } catch (error) {
      this.logger.warn(`[GFS Redis] active-run GET failed: ${this.message(error)}`);
      return null;
    }
  }

  async publishActiveRun(run: string) {
    try {
      await this.ensureConnected();
      await this.redis.set(
        ACTIVE_RUN_KEY,
        JSON.stringify({ run, status: "READY" } satisfies ActiveGfsRun),
        "EX",
        this.tileTtl,
      );
      return true;
    } catch (error) {
      this.logger.warn(`[GFS Redis] active-run publish failed: ${this.message(error)}`);
      return false;
    }
  }

  async acquireLock(token: string, ttlMs: number) {
    try {
      await this.ensureConnected();
      return (await this.redis.set(LOCK_KEY, token, "PX", ttlMs, "NX")) === "OK";
    } catch (error) {
      this.logger.warn(`[GFS Redis] lock acquire failed: ${this.message(error)}`);
      return false;
    }
  }

  async renewLock(token: string, ttlMs: number) {
    try {
      await this.ensureConnected();
      return (await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        LOCK_KEY,
        token,
        String(ttlMs),
      )) === 1;
    } catch {
      return false;
    }
  }

  async releaseLock(token: string) {
    try {
      await this.ensureConnected();
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, LOCK_KEY, token);
    } catch (error) {
      this.logger.warn(`[GFS Redis] lock release failed: ${this.message(error)}`);
    }
  }

  stats() {
    return { redisHits: this.hits, redisMisses: this.misses };
  }

  async onApplicationShutdown() {
    if (this.redis.status !== "end") await this.redis.quit().catch(() => undefined);
  }

  private tileKey(
    run: string,
    forecastHour: number,
    z: number,
    x: number,
    y: number,
  ) {
    if (!Number.isInteger(z) || z < 0 || z > GFS_MAX_WEATHER_ZOOM) {
      throw new RangeError("Invalid GFS weather zoom");
    }
    return `gfs:${run}:f${String(forecastHour).padStart(3, "0")}:z${z}:x${normalizeX(x, z)}:y${y}:v1`;
  }

  private async ensureConnected() {
    if (this.redis.status === "wait") await this.redis.connect();
  }

  private positiveInt(value: number | undefined, fallback: number) {
    return Number.isInteger(value) && value && value > 0 ? value : fallback;
  }

  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
