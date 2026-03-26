interface CacheItem {
  value: any;
  expiration: Date | null;
  createdAt: Date;
}

interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
}

interface CacheGetResult {
  value: any;
  found: boolean;
  isStale?: boolean;
}

class MemoryCache {
  private items: Map<string, CacheItem>;
  private maxItems: number;
  private stats: CacheStats;
  private onEvict: ((key: string, value: any) => void) | null;
  private cleanupInterval: NodeJS.Timeout;

  constructor(maxItems: number = 1000) {
    this.items = new Map();
    this.maxItems = maxItems;
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
    };
    this.onEvict = null;

    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  get(key: string): CacheGetResult {
    const item = this.items.get(key);

    if (!item) {
      this.stats.misses++;
      return { value: null, found: false };
    }

    if (item.expiration && Date.now() > item.expiration.getTime()) {
      this.items.delete(key);
      this.stats.misses++;
      return { value: null, found: false };
    }

    this.stats.hits++;
    return { value: item.value, found: true };
  }

  getWithMeta(
    key: string,
    options: { allowStale?: boolean } = {}
  ): CacheGetResult {
    const item = this.items.get(key);
    if (!item) {
      this.stats.misses++;
      return { value: null, found: false, isStale: false };
    }

    const expired = item.expiration && Date.now() > item.expiration.getTime();
    if (expired && !options.allowStale) {
      this.items.delete(key);
      this.stats.misses++;
      return { value: null, found: false, isStale: false };
    }

    if (!expired) {
      this.stats.hits++;
      return { value: item.value, found: true, isStale: false };
    }

    this.stats.hits++;
    return { value: item.value, found: true, isStale: true };
  }

  set(key: string, value: any, ttl: number): void {
    let expiration: Date | null = null;
    if (ttl > 0) {
      expiration = new Date(Date.now() + ttl);
    }

    if (this.items.size >= this.maxItems && !this.items.has(key)) {
      this.evictOldest();
    }

    this.items.set(key, {
      value,
      expiration,
      createdAt: new Date(),
    });

    this.stats.sets++;
  }

  delete(key: string): void {
    const deleted = this.items.delete(key);
    if (deleted) {
      this.stats.deletes++;
    }
  }

  clear(): void {
    const count = this.items.size;
    this.items.clear();
    this.stats.deletes += count;
  }

  getStats(): CacheStats & { size: number; hitRate: number } {
    return {
      ...this.stats,
      size: this.items.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
    };
  }

  size(): number {
    return this.items.size;
  }

  getRawEntry(key: string): CacheItem | null {
    return this.items.get(key) || null;
  }

  getAllKeys(): string[] {
    return Array.from(this.items.keys());
  }

  setEvictionCallback(fn: (key: string, value: any) => void): void {
    this.onEvict = fn;
  }

  evictOldest(): void {
    if (this.items.size === 0) return;

    const firstKey = this.items.keys().next().value;
    if (typeof firstKey !== 'string') return;
    const item = this.items.get(firstKey);

    this.items.delete(firstKey);
    this.stats.evictions++;

    if (this.onEvict && item) {
      this.onEvict(firstKey, item.value);
    }
  }

  cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, item] of this.items) {
      if (item.expiration && now > item.expiration.getTime()) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.items.delete(key);
      this.stats.evictions++;
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clear();
  }
}

type ConnectionState =
  | 'idle'
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

interface RedisClient {
  isOpen: boolean;
  isReady: boolean;
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<any>;
  del(key: string | string[]): Promise<number>;
  flushDb(): Promise<string>;
  keys(pattern: string): Promise<string[]>;
  scanIterator(options: {
    MATCH: string;
    COUNT: number;
  }): AsyncIterable<string>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): void;
}

class RedisCache {
  private url?: string;
  private keyPrefix?: string;
  private _clientPromise: Promise<RedisClient> | null;
  private _client: RedisClient | null;
  private connectionState: ConnectionState;
  private lastError: Error | null;

  constructor(options?: { url?: string; keyPrefix?: string }) {
    this.url = options?.url;
    this.keyPrefix = options?.keyPrefix;
    this._clientPromise = null;
    this._client = null;
    this.connectionState = this.url ? 'idle' : 'disabled';
    this.lastError = null;
  }

  private _fullKey(rawKey: string): string {
    return this.keyPrefix ? `${this.keyPrefix}${rawKey}` : rawKey;
  }

  private async _getClient(): Promise<RedisClient> {
    if (this._clientPromise) return this._clientPromise;

    this._clientPromise = (async () => {
      let redis: any;
      try {
        redis = await import('redis');
      } catch (err) {
        this.connectionState = 'error';
        this.lastError = err as Error;
        throw new Error(
          "Redis cache configured but 'redis' dependency is not installed. Install it with `pnpm add redis`."
        );
      }

      this.connectionState = 'connecting';
      this.lastError = null;
      const client = redis.createClient({ url: this.url }) as RedisClient;
      this._client = client;

      client.on('ready', () => {
        this.connectionState = 'connected';
      });
      client.on('end', () => {
        if (this.connectionState !== 'disabled') {
          this.connectionState = 'disconnected';
        }
      });
      client.on('reconnecting', () => {
        this.connectionState = 'connecting';
      });
      client.on('error', (e: Error) => {
        this.lastError = e;
        this.connectionState = 'error';
      });

      await client.connect();
      this.connectionState = client.isReady ? 'connected' : 'connecting';
      return client;
    })();

    return this._clientPromise;
  }

  getConnectionStatus(): {
    enabled: boolean;
    state: ConnectionState;
    isOpen: boolean | null;
    isReady: boolean | null;
    error: string | null;
  } {
    return {
      enabled: Boolean(this.url),
      state: this.connectionState,
      isOpen: this._client ? Boolean(this._client.isOpen) : null,
      isReady: this._client ? Boolean(this._client.isReady) : null,
      error: this.lastError
        ? String(this.lastError?.message || this.lastError)
        : null,
    };
  }

  async get(rawKey: string): Promise<CacheGetResult> {
    const client = await this._getClient();
    const key = this._fullKey(rawKey);
    const data = await client.get(key);
    if (!data) return { value: null, found: false, isStale: false };
    try {
      return { value: JSON.parse(data), found: true, isStale: false };
    } catch {
      return { value: null, found: false, isStale: false };
    }
  }

  async set(rawKey: string, value: any, ttlMs: number): Promise<void> {
    const client = await this._getClient();
    const key = this._fullKey(rawKey);
    const ttlSeconds = Math.max(1, Math.ceil((Number(ttlMs) || 0) / 1000));
    await client.setEx(key, ttlSeconds, JSON.stringify(value));
  }

  async delete(rawKey: string): Promise<void> {
    const client = await this._getClient();
    const key = this._fullKey(rawKey);
    await client.del(key);
  }

  async clear(): Promise<void> {
    const client = await this._getClient();

    if (!this.keyPrefix) {
      await client.flushDb();
      return;
    }

    const pattern = `${this.keyPrefix}*`;
    const keys: string[] = [];
    for await (const key of client.scanIterator({
      MATCH: pattern,
      COUNT: 200,
    })) {
      keys.push(key);
    }
    if (keys.length > 0) {
      await client.del(keys);
    }
  }

  async size(): Promise<number> {
    const client = await this._getClient();
    if (!this.keyPrefix) {
      const keys = await client.keys('*');
      return keys.length;
    }

    const pattern = `${this.keyPrefix}*`;
    let count = 0;
    for await (const _ of client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      count++;
    }
    return count;
  }

  getRawEntry(): never {
    throw new Error('Cannot get raw entry from Redis cache');
  }

  getAllKeys(): never {
    throw new Error('Cannot get all keys from Redis cache');
  }

  async disconnect(): Promise<void> {
    if (!this._clientPromise) return;
    const client = await this._clientPromise;
    await client.disconnect();
    this.connectionState = 'disconnected';
  }
}

export { MemoryCache, RedisCache };
