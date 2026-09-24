import { deserialize, serialize } from "node:v8";
import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

import {
  type CacheProvider,
  setGlobalCacheProvider,
} from "./cacheable.decorator.js";
import { TimeInSeconds } from "./time-in-seconds.enum.js";

@Injectable()
export class RedisCacheService
  implements CacheProvider, OnModuleInit, OnApplicationShutdown
{
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    this.redis = new Redis(config.getOrThrow<string>("REDIS_URL"), {
      connectTimeout: 3_000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redis.on("error", () => {
      // Cache operations report failures at the decorator boundary.
    });
  }

  onModuleInit(): void {
    setGlobalCacheProvider(this);
  }

  async get<T>(key: string): Promise<T | null> {
    await this.ensureConnected();
    const cached = await this.redis.getBuffer(key);
    return cached === null ? null : (deserialize(cached) as T);
  }

  async set(
    key: string,
    value: unknown,
    ttlInSeconds = TimeInSeconds.HOUR,
  ): Promise<void> {
    if (ttlInSeconds <= 0) return;

    await this.ensureConnected();
    await this.redis.set(
      key,
      serialize(value),
      "EX",
      Math.ceil(ttlInSeconds),
    );
  }

  async del(key: string): Promise<void> {
    await this.ensureConnected();
    await this.redis.del(key);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== "end") {
      await this.redis.quit().catch(() => undefined);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === "wait") await this.redis.connect();
  }
}
