type CacheEntry = {
  value: string;
  expiresAt: number;
};

export interface MemoryCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export class ReadThroughMemoryCache implements MemoryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }

  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    if (looksSensitive(value)) return;
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1_000
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  async deletePrefix(prefix: string) {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

export class OptionalRedisMemoryCache implements MemoryCache {
  private readonly fallback: MemoryCache;
  private readonly redisUrl: string | undefined;
  private readonly clientLoader: (url: string) => Promise<RedisLikeClient | undefined>;
  private redisUnavailable = false;
  private clientPromise?: Promise<RedisLikeClient | undefined>;

  constructor(options: {
    redisUrl?: string;
    fallback?: MemoryCache;
    clientLoader?: (url: string) => Promise<RedisLikeClient | undefined>;
  } = {}) {
    this.redisUrl = options.redisUrl ?? process.env.HIVO_REDIS_URL;
    this.fallback = options.fallback ?? new ReadThroughMemoryCache();
    this.clientLoader = options.clientLoader ?? loadRedisClient;
  }

  async get(key: string) {
    const client = await this.client();
    if (client) {
      try {
        const value = await client.get(key);
        if (typeof value === "string") return value;
      } catch {
        this.redisUnavailable = true;
      }
    }
    return this.fallback.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    if (looksSensitive(value)) return;
    await this.fallback.set(key, value, ttlSeconds);
    const client = await this.client();
    if (!client) return;
    try {
      await client.set(key, value, { EX: Math.max(1, ttlSeconds) });
    } catch {
      this.redisUnavailable = true;
    }
  }

  async deletePrefix(prefix: string) {
    await this.fallback.deletePrefix(prefix);
    const client = await this.client();
    if (!client) return;
    try {
      for await (const key of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
        await client.del(String(key));
      }
    } catch {
      this.redisUnavailable = true;
    }
  }

  private async client(): Promise<RedisLikeClient | undefined> {
    if (!this.redisUrl || this.redisUnavailable) return undefined;
    this.clientPromise ??= this.clientLoader(this.redisUrl).catch(() => {
      this.redisUnavailable = true;
      return undefined;
    });
    return this.clientPromise;
  }
}

export type RedisLikeClient = {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<unknown>;
};

async function loadRedisClient(url: string): Promise<RedisLikeClient | undefined> {
  // Keep Redis optional: deployments that want it can install the redis package,
  // while local/offline use continues with the bounded in-process cache.
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const module = await dynamicImport("redis") as { createClient?: (options: { url: string }) => RedisLikeClient };
  if (!module.createClient) return undefined;
  const client = module.createClient({ url });
  await client.connect();
  return client;
}

function looksSensitive(value: string) {
  return /(?:api[_-]?key|authorization|bearer\s+|password|private[_-]?key|secret)/i.test(value);
}

export const memoryCache = new OptionalRedisMemoryCache();
