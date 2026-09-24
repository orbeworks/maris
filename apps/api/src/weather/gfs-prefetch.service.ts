import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GfsService } from "./gfs.service.js";
import { encodeGfsTile } from "./gfs-tile-codec.js";
import {
  GfsRedisCacheService,
  gfsCurrentRunId,
  gfsRunId,
} from "./gfs-redis-cache.service.js";
import { GFS_MAX_WEATHER_ZOOM, xyzTileCount } from "./xyz-tiles.js";

type PrefetchTask = { z: number; x: number; y: number; forecastHour: number };
const GFS_ZOOMS = Array.from({ length: GFS_MAX_WEATHER_ZOOM + 1 }, (_, z) => z);

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000];

@Injectable()
export class GfsPrefetchService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger("GFS Prefetch");
  private readonly enabled: boolean;
  private readonly concurrency: number;
  private readonly refreshIntervalMs: number;
  private readonly lockTtlMs: number;
  private readonly maxEstimatedRedisBytes: number;
  private readonly forecastHours: number[];
  private timer?: NodeJS.Timeout;
  private lockRenewal: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private estimatedRun?: string;
  private estimatedRunBytes?: number;

  constructor(
    private readonly config: ConfigService,
    private readonly gfs: GfsService,
    private readonly redis: GfsRedisCacheService,
  ) {
    this.enabled = config.get<boolean>("GFS_PREFETCH_ENABLED", true) !== false;
    this.concurrency = this.int(
      config.get<number>("GFS_PREFETCH_CONCURRENCY", 6),
      6,
      1,
      16,
    );
    this.refreshIntervalMs = this.int(
      config.get<number>("GFS_PREFETCH_REFRESH_INTERVAL_MS", 900_000),
      900_000,
      10_000,
      Number.MAX_SAFE_INTEGER,
    );
    this.lockTtlMs = this.int(
      config.get<number>("GFS_PREFETCH_LOCK_TTL_MS", 120_000),
      120_000,
      10_000,
      Number.MAX_SAFE_INTEGER,
    );
    this.maxEstimatedRedisBytes = this.int(
      config.get<number>(
        "GFS_PREFETCH_MAX_ESTIMATED_REDIS_BYTES",
        1024 * 1024 * 1024,
      ),
      1024 * 1024 * 1024,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    this.forecastHours = this.parseForecastHours(
      config.get<string>("GFS_PREFETCH_FORECAST_HOURS", "0"),
    );
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log("disabled by GFS_PREFETCH_ENABLED");
      return;
    }
    // Never block API boot on global population.
    setTimeout(() => void this.runCycle(), 0).unref();
    this.timer = setInterval(
      () => void this.runCycle(),
      this.refreshIntervalMs,
    );
    this.timer.unref();
  }

  private async runCycle() {
    if (this.stopping || this.running) return;
    this.running = true;
    const token = randomUUID();
    const startedAt = Date.now();
    let locked = false;
    try {
      locked = await this.redis.acquireLock(token, this.lockTtlMs);
      if (!locked) {
        this.logger.log(
          "lock busy or Redis unavailable; API fallback remains active",
        );
        return;
      }
      this.lockRenewal = setInterval(
        () => void this.redis.renewLock(token, this.lockTtlMs),
        Math.max(5_000, Math.floor(this.lockTtlMs / 3)),
      );
      this.lockRenewal.unref();

      const currentOnly =
        this.forecastHours.length === 1 && this.forecastHours[0] === 0;
      const current = currentOnly
        ? await this.gfs.getCurrentForecast()
        : undefined;
      const inventory =
        current?.inventory ??
        (await this.gfs.getCompleteInventory(this.forecastHours));
      const run = current
        ? gfsCurrentRunId(inventory.run.runAt, current.sourceForecastHour)
        : gfsRunId(inventory.run.runAt);
      const tasks = this.tasks();
      const sourceCache = new Map<
        string,
        Awaited<ReturnType<GfsService["getTileFromInventory"]>>
      >();
      const estimatedRedisBytes = await this.estimateRedisBytes(
        inventory,
        tasks.length,
        sourceCache,
        run,
        current?.sourceForecastHour,
      );
      if (estimatedRedisBytes > this.maxEstimatedRedisBytes) {
        this.logger.warn(
          `run=${run} prefetch aborted: estimatedRedisBytes=${estimatedRedisBytes} exceeds max=${this.maxEstimatedRedisBytes}`,
        );
        return;
      }
      let cacheHits = 0;
      let cacheMisses = 0;
      let storedCount = 0;
      let failed = 0;
      let retries = 0;
      let bytes = 0;
      let next = 0;
      const totalKeys = tasks.length;
      const processTask = async () => {
        while (!this.stopping) {
          const index = next++;
          const task = tasks[index];
          if (!task) return;
          let stored = false;
          let taskCached = false;
          let taskBytes = 0;
          for (
            let attempt = 0;
            attempt < RETRY_DELAYS_MS.length && !this.stopping;
            attempt += 1
          ) {
            try {
              const existing = await this.redis.getTile(
                run,
                task.forecastHour,
                task.x,
                task.y,
                task.z,
              );
              if (existing) {
                taskCached = true;
                taskBytes = existing.byteLength;
                stored = true;
                retries += attempt;
                break;
              }
              const grid = await this.gfs.getXyzTileFromInventory(
                inventory,
                task.z,
                task.x,
                task.y,
                current?.sourceForecastHour ?? task.forecastHour,
                sourceCache,
              );
              const body = gzipSync(
                encodeGfsTile(current ? { ...grid, forecastHour: 0 } : grid),
              );
              if (
                !(await this.redis.setTile(
                  run,
                  task.forecastHour,
                  task.x,
                  task.y,
                  body,
                  task.z,
                ))
              ) {
                throw new Error("Redis SET failed");
              }
              taskBytes = body.byteLength;
              stored = true;
              retries += attempt;
              break;
            } catch (error) {
              retries += 1;
              if (attempt + 1 < RETRY_DELAYS_MS.length) {
                await this.delayWithJitter(RETRY_DELAYS_MS[attempt]!);
              } else {
                this.logger.warn(
                  `tile failed run=${run} f=${task.forecastHour} x=${task.x} y=${task.y}: ${this.message(error)}`,
                );
              }
            }
          }
          if (stored) {
            if (taskCached) cacheHits += 1;
            else {
              cacheMisses += 1;
              storedCount += 1;
            }
            bytes += taskBytes;
          } else failed += 1;
          if ((cacheHits + cacheMisses) % 100 === 0) {
            this.logger.log(
              `run=${run} progress=${cacheHits + cacheMisses}/${totalKeys} cacheHits=${cacheHits} cacheMisses=${cacheMisses} stored=${storedCount} failed=${failed} retries=${retries} concurrency=${this.concurrency}`,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: this.concurrency }, () => processTask()),
      );

      if (
        !this.stopping &&
        failed === 0 &&
        cacheHits + cacheMisses === totalKeys
      ) {
        await this.redis.publishActiveRun(run);
        this.logger.log(`run=${run} READY active-run published`);
      } else {
        this.logger.warn(`run=${run} incomplete; active-run was not changed`);
      }
      const stats = this.redis.stats();
      this.logger.log(
        `run=${run} progress=${cacheHits + cacheMisses}/${totalKeys} cacheHits=${cacheHits} cacheMisses=${cacheMisses} stored=${storedCount} failed=${failed} retries=${retries} bytes=${bytes} durationMs=${Date.now() - startedAt} redisHits=${stats.redisHits} redisMisses=${stats.redisMisses}`,
      );
    } catch (error) {
      this.logger.warn(`cycle failed: ${this.message(error)}`);
    } finally {
      if (this.lockRenewal) clearInterval(this.lockRenewal);
      this.lockRenewal = undefined;
      if (locked) await this.redis.releaseLock(token);
      this.running = false;
    }
  }

  private tasks(): PrefetchTask[] {
    const tasks: PrefetchTask[] = [];
    for (const forecastHour of this.forecastHours) {
      for (const z of GFS_ZOOMS) {
        const count = xyzTileCount(z);
        for (let y = 0; y < count; y += 1) {
          for (let x = 0; x < count; x += 1)
            tasks.push({ z, x, y, forecastHour });
        }
      }
    }
    return tasks;
  }

  private async estimateRedisBytes(
    inventory: Awaited<ReturnType<GfsService["getCompleteInventory"]>>,
    taskCount: number,
    sourceCache: Map<
      string,
      Awaited<ReturnType<GfsService["getTileFromInventory"]>>
    >,
    run: string,
    currentSourceForecastHour?: number,
  ) {
    if (taskCount === 0) return 0;
    if (this.estimatedRun === run && this.estimatedRunBytes !== undefined) {
      return this.estimatedRunBytes;
    }
    const samples: number[] = [];
    for (const forecastHour of this.forecastHours) {
      try {
        let totalSampleBytes = 0;
        for (const z of GFS_ZOOMS) {
          const grid = await this.gfs.getXyzTileFromInventory(
            inventory,
            z,
            0,
            0,
            currentSourceForecastHour ?? forecastHour,
            sourceCache,
          );
          totalSampleBytes += gzipSync(
            encodeGfsTile(
              currentSourceForecastHour === undefined
                ? grid
                : { ...grid, forecastHour: 0 },
            ),
          ).byteLength;
        }
        samples.push(totalSampleBytes);
      } catch (error) {
        this.logger.warn(
          `prefetch size sample failed f=${forecastHour}: ${this.message(error)}`,
        );
      }
    }
    if (samples.length === 0) return Number.POSITIVE_INFINITY;
    const average =
      samples.reduce((sum, value) => sum + value, 0) /
      samples.length /
      GFS_ZOOMS.length;
    // Include a conservative allowance for Redis key/value/object overhead.
    const estimate = Math.ceil(average * taskCount * 1.25);
    this.estimatedRun = run;
    this.estimatedRunBytes = estimate;
    this.logger.log(
      `run=${run} estimatedRedisBytes=${estimate} sampleAverageBytesPerTile=${Math.ceil(average)} zooms=0-${GFS_MAX_WEATHER_ZOOM}`,
    );
    return estimate;
  }

  private parseForecastHours(value: string) {
    const hours = value
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 384);
    return [...new Set(hours)].sort((a, b) => a - b);
  }

  private async delayWithJitter(baseMs: number) {
    const jitter = baseMs * (0.8 + Math.random() * 0.4);
    await new Promise((resolve) => setTimeout(resolve, jitter));
  }

  private int(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
  ) {
    return Number.isInteger(value) &&
      value !== undefined &&
      value >= min &&
      value <= max
      ? value
      : fallback;
  }

  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  async onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.lockRenewal) clearInterval(this.lockRenewal);
    while (this.running)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
