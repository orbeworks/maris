import { createHash } from "crypto";
import CircularJSON from "circular-json";

interface CacheProvider {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlInSeconds?: number): Promise<unknown>;
  del?(key: string): Promise<unknown>;
}

let globalCacheProvider: CacheProvider | null = null;

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
      if (!globalCacheProvider) {
        throw new Error(
          "Você precisa configurar um provider de cache global usando setGlobalCacheProvider().",
        );
      }

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
    .update(CircularJSON.stringify(value))
    .digest("hex");
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
