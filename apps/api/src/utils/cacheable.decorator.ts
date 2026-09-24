import { createHash } from "node:crypto";
import { TimeInSeconds } from "./time-in-seconds.enum.js";

export interface CacheProvider {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlInSeconds?: number): Promise<unknown>;
  del?(key: string): Promise<unknown>;
}

const inFlight = new Map<string, Promise<unknown>>();
const noCacheProvider: CacheProvider = {
  async get() {
    return null;
  },
  async set() {},
  async del() {},
};

let globalCacheProvider: CacheProvider = noCacheProvider;

export function setGlobalCacheProvider(provider: CacheProvider): void {
  globalCacheProvider = provider;
}

export function resetGlobalCache(): void {
  inFlight.clear();
  globalCacheProvider = noCacheProvider;
}

interface CacheableOptions {
  /**
   * Tempo em segundos que o valor ficará armazenado em cache.
   * Default: 1 hora.
   */
  ttl?: number;

  /**
   * Função que gera a parte variável da chave com base nos argumentos.
   *
   * string -> usa a string diretamente após o prefixo
   * array  -> gera hash do array exatamente na ordem recebida
   *
   * Exemplos:
   *
   * key: (_, id) => id
   * UserService:getUser:123
   *
   * key: (_, z, x, y) => [z, x, y]
   * WeatherService:getTile:<hash>
   */
  key?: (...args: unknown[]) => string | unknown[];

  /**
   * Prefixo da chave.
   *
   * Se não informado, usa:
   *
   * NomeDaClasse:nomeDoMetodo
   *
   * Exemplo:
   * GfsService:getXyzTileFromInventory
   */
  keyPrefix?: string;
}

export function Cacheable(options: CacheableOptions = {}): MethodDecorator {
  const { ttl = TimeInSeconds.HOUR, key, keyPrefix } = options;

  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const originalMethod = descriptor.value;

    if (typeof originalMethod !== "function") {
      throw new TypeError(
        `@Cacheable só pode ser usado em métodos. "${String(propertyKey)}" não é uma função.`,
      );
    }

    const className = target.constructor.name;
    const methodName = String(propertyKey);
    const defaultKeyPrefix = `${className}:${methodName}`;
    const resolvedKeyPrefix = keyPrefix ?? defaultKeyPrefix;

    descriptor.value = async function (...args: unknown[]) {
      const cacheKey = generateCacheKey(key, resolvedKeyPrefix, args);

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

      const pending = inFlight.get(cacheKey);

      if (pending) {
        return pending;
      }

      const execution = (async () => {
        try {
          const result = await originalMethod.apply(this, args);

          await storeInCache(globalCacheProvider, cacheKey, result, ttl);

          return result;
        } finally {
          inFlight.delete(cacheKey);
        }
      })();

      inFlight.set(cacheKey, execution);

      return execution;
    };

    return descriptor;
  };
}

function generateCacheKey(
  keyFn: CacheableOptions["key"],
  keyPrefix: string,
  args: unknown[],
): string {
  if (keyFn) {
    const rawKey = keyFn(...args);

    if (typeof rawKey === "string") {
      return `${keyPrefix}:${rawKey}`;
    }

    return `${keyPrefix}:${hash(rawKey)}`;
  }

  return `${keyPrefix}:${hash(args)}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(serialize(value)).digest("hex");
}

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "bigint") {
      return `${current}n`;
    }

    if (typeof current !== "object" || current === null) {
      return current;
    }

    if (seen.has(current)) {
      return "[Circular]";
    }

    seen.add(current);

    if (current instanceof Uint8Array) {
      return {
        type: current.constructor.name,
        values: [...current],
      };
    }

    if (current instanceof Set) {
      return {
        type: "Set",
        values: [...current],
      };
    }

    if (current instanceof Map) {
      return {
        type: "Map",
        entries: [...current.entries()],
      };
    }

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
