import { createHash } from "node:crypto";

interface CacheProvider {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlInSeconds?: number): Promise<unknown>;
  del?(key: string): Promise<unknown>;
}

type MemoryEntry = { value: unknown; expiresAt: number };

const memoryCache = new Map<string, MemoryEntry>();
const defaultCacheProvider: CacheProvider = {
  async get<T>(key: string): Promise<T | null> {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memoryCache.delete(key);
      return null;
    }
    return entry.value as T;
  },
  async set(key: string, value: unknown, ttlInSeconds = 60 * 60) {
    memoryCache.set(key, {
      value,
      expiresAt: Date.now() + Math.max(0, ttlInSeconds) * 1_000,
    });
  },
  async del(key: string) {
    memoryCache.delete(key);
  },
};

let globalCacheProvider: CacheProvider = defaultCacheProvider;

export function setGlobalCacheProvider(provider: CacheProvider): void {
  globalCacheProvider = provider;
}

interface CacheableOptions {
  /**
   * Tempo em segundos que o valor ficará armazenado em cache.
   * Default: 1 hora.
   */
  ttl?: number;

  /**
   * Função que gera a chave do cache com base nos argumentos.
   *
   * string -> chave pronta
   * array  -> hash do array exatamente na ordem recebida
   */
  key?: (...args: unknown[]) => string | unknown[];

  /**
   * Prefixo da chave.
   * Se não informado, usa o nome do método.
   */
  keyPrefix?: string;
}

export function Cacheable(options: CacheableOptions = {}): MethodDecorator {
  const { ttl = 60 * 60, key, keyPrefix } = options;

  return function (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const originalMethod = descriptor.value;

    if (typeof originalMethod !== "function") {
      throw new TypeError(
        `@Cacheable só pode ser usado em métodos. "${String(propertyKey)}" não é uma função.`,
      );
    }

    descriptor.value = async function (...args: unknown[]) {
      const cacheKey = generateCacheKey(key, keyPrefix, propertyKey, args);

      try {
        const cached = await globalCacheProvider.get(cacheKey);

        if (cached !== null) {
          return cached;
        }
      } catch (error) {
        console.warn(
          `Erro ao buscar valor no cache (ignorado): ${String(error)}`,
        );
      }

      const result = await originalMethod.apply(this, args);

      await storeInCache(globalCacheProvider, cacheKey, result, ttl);

      return result;
    };

    return descriptor;
  };
}

function generateCacheKey(
  keyFn: CacheableOptions["key"],
  keyPrefix: string | undefined,
  propertyKey: string | symbol,
  args: unknown[],
): string {
  if (keyFn) {
    const rawKey = keyFn(...args);

    if (typeof rawKey === "string") {
      return rawKey;
    }

    return `${keyPrefix ?? String(propertyKey)}:${hash(rawKey)}`;
  }

  return `${keyPrefix ?? String(propertyKey)}:${hash(args)}`;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(serialize(value))
    .digest("hex");
}

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "bigint") return `${current}n`;
    if (typeof current !== "object" || current === null) return current;
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    if (current instanceof Uint8Array)
      return { type: current.constructor.name, values: [...current] };
    return current;
  });
}

async function storeInCache(
  cache: CacheProvider,
  key: string,
  value: unknown,
  ttl: number,
): Promise<void> {
  if (value === undefined || value === null || value instanceof Error) {
    return;
  }

  try {
    await cache.set(key, value, ttl);
  } catch (error) {
    console.warn(`Erro ao armazenar no cache (ignorado): ${String(error)}`);
  }
}
