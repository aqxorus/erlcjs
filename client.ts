import * as Sentry from '@sentry/node';
import { MemoryCache, RedisCache } from './cache.js';
import { PRCAPIError } from './errors.js';
import { RequestQueue } from './queue.js';
import { RateLimiter } from './rateLimiter.js';
import {
  ClientOptions,
  ERLCServerDataV2,
  MethodOptions,
  V2ServerQueryOptions,
  getFriendlyErrorMessage,
} from './types.js';

interface CachedValue {
  found: boolean;
  value?: any;
  isStale?: boolean;
}

interface RequestContext {
  method?: string;
  path?: string;
  url?: string;
}

interface CacheStore {
  store: MemoryCache | RedisCache;
  ttl: number;
  staleIfError: boolean;
  prefix: string;
}

class ERLCClient {
  private apiKey: string;
  private baseURLV1: string;
  private baseURLV2: string;
  private timeout: number;
  private keepAlive: boolean;
  private globalKey?: string;
  private rateLimiter: RateLimiter;
  private queue: RequestQueue | null;
  public cache: CacheStore | null;

  /**
   * Create a new ERLC API client
   * @param apiKey - The API key for authentication
   * @param options - Client configuration options
   */
  constructor(apiKey: string, options: ClientOptions = {}) {
    if (!apiKey) {
      throw new Error('API key is required');
    }

    this.apiKey = apiKey;
    this.baseURLV1 =
      options.baseURL || 'https://api.policeroleplay.community/v1';
    this.baseURLV2 =
      options.baseURL2 || 'https://api.policeroleplay.community/v2';
    this.timeout = options.timeout || 10000;
    this.keepAlive = options.keepAlive !== false;
    this.globalKey = options.globalKey;

    this.rateLimiter = new RateLimiter();

    this.queue = null;
    if (options.requestQueue) {
      this.queue = new RequestQueue(
        options.requestQueue.workers,
        options.requestQueue.interval
      );
      this.queue.start();
    }

    this.cache = null;
    if (options.cache && options.cache.enabled) {
      const redisUrl = options.cache.redisUrl;
      const redisKeyPrefix = options.cache.redisKeyPrefix;

      const store = redisUrl
        ? new RedisCache({
            url: redisUrl,
            keyPrefix: redisKeyPrefix || '',
          })
        : new MemoryCache(options.cache.maxItems);

      this.cache = {
        store,
        ttl: options.cache.ttl || 60000,
        staleIfError: options.cache.staleIfError || false,
        prefix: options.cache.prefix || 'erlc:',
      };
    }
  }

  /**
   * Get current server status (erlc.ts parity)
   * @returns Server information
   */
  async getServerStatus(options?: MethodOptions): Promise<any> {
    return this.getServer({}, options);
  }

  /**
   * Get server data from v2 endpoint
   * @param query - v2 include flags
   * @param options - Request options
   * @returns Server information
   */
  async getServer(
    query: V2ServerQueryOptions = {},
    options?: MethodOptions
  ): Promise<ERLCServerDataV2> {
    const path = this.buildV2ServerPath(query);
    const data = await this.get(path, options, 'v2');
    return this.normalizeServerV2Data(data);
  }

  /**
   * Get server ban information
   * @returns Ban information
   */
  async getBans(options?: MethodOptions): Promise<any> {
    return this.get('/server/bans', options, 'v1');
  }

  /**
   * Execute a server command
   * @param command - The command to execute (with leading slash)
   */
  async executeCommand(command: string): Promise<void> {
    const data = { command };
    return this.post('/server/command', data, 'v2');
  }

  /**
   * Make a GET request to the API
   * @param path - API endpoint path
   * @param options - Request options
   * @returns Response data
   */
  async get(
    path: string,
    options: MethodOptions = {},
    apiVersion: 'v1' | 'v2' = 'v2'
  ): Promise<any> {
    const cacheKey = this.cache
      ? `${this.cache.prefix}${apiVersion}:${path}`
      : null;
    const shouldCache = !!this.cache && options.cache !== false;
    const ttlOverride = Number(options.cacheMaxAge);
    const ttl =
      Number.isFinite(ttlOverride) && ttlOverride >= 0
        ? ttlOverride
        : this.cache?.ttl;

    let staleValue: any = null;

    if (shouldCache && cacheKey) {
      const store = this.cache!.store;
      const cached: CachedValue =
        store instanceof MemoryCache
          ? store.getWithMeta(cacheKey, {
              allowStale: this.cache!.staleIfError,
            })
          : await store.get(cacheKey);

      if (cached?.found && !cached?.isStale) {
        return cached.value;
      }
      if (cached?.found && cached?.isStale) {
        staleValue = cached.value;
      }
    }

    const execute = async () => {
      const response = await this.makeRequest('GET', path, null, apiVersion);

      if (shouldCache && cacheKey && response.ok) {
        const data = await response.json();
        const ttlMs = typeof ttl === 'number' ? ttl : 0;
        try {
          if (this.cache!.store instanceof MemoryCache) {
            this.cache!.store.set(cacheKey, data, ttlMs);
          } else {
            await this.cache!.store.set(cacheKey, data, ttlMs);
          }
        } catch {}
        return data;
      }

      return this.handleResponse(response, {
        method: 'GET',
        path,
        url: response?.url || `${this.resolveBaseURL(apiVersion)}${path}`,
      });
    };

    const run = this.queue ? () => this.queue!.enqueue(execute) : execute;

    try {
      return await run();
    } catch (err) {
      if (this.cache && this.cache.staleIfError && staleValue !== null) {
        return staleValue;
      }
      throw err;
    }
  }

  /**
   * Make a POST request to the API
   * @param path - API endpoint path
   * @param data - Request body data
   * @returns Response data
   */
  async post(
    path: string,
    data: any,
    apiVersion: 'v1' | 'v2' = 'v2'
  ): Promise<any> {
    const execute = async () => {
      const response = await this.makeRequest('POST', path, data, apiVersion);
      return this.handleResponse(response, {
        method: 'POST',
        path,
        url: response?.url || `${this.resolveBaseURL(apiVersion)}${path}`,
      });
    };

    if (this.queue) {
      return this.queue.enqueue(execute);
    }

    return execute();
  }

  /**
   * Make an HTTP request to the API
   * @param method - HTTP method
   * @param path - API endpoint path
   * @param data - Request body data
   * @returns Fetch response
   */
  async makeRequest(
    method: string,
    path: string,
    data: any = null,
    apiVersion: 'v1' | 'v2' = 'v2'
  ): Promise<Response> {
    return this.makeRequestWithRetry(method, path, data, apiVersion, 3);
  }

  /**
   * Make an HTTP request with retry logic for transient network errors
   * @param method - HTTP method
   * @param path - API endpoint path
   * @param data - Request body data
   * @param maxRetries - Maximum number of retry attempts
   * @param baseDelay - Base delay in milliseconds for exponential backoff
   * @returns Fetch response
   */
  async makeRequestWithRetry(
    method: string,
    path: string,
    data: any = null,
    apiVersion: 'v1' | 'v2' = 'v2',
    maxRetries = 3,
    baseDelay = 1000
  ): Promise<Response> {
    const url = `${this.resolveBaseURL(apiVersion)}${path}`;
    let lastError: Error | undefined;
    const perAttemptTimeout = Math.max(2000, Number(this.timeout) || 0);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (this.rateLimiter) {
          const { duration, shouldWait } =
            this.rateLimiter.shouldWait('global');
          if (shouldWait) {
            await this.sleep(duration);
          }
        }

        const options: RequestInit = {
          method,
          headers: {
            'Server-Key': this.apiKey,
            'Content-Type': 'application/json',
            ...(!this.keepAlive || attempt > 0 ? { Connection: 'close' } : {}),
            ...(this.globalKey ? { Authorization: this.globalKey } : {}),
          },
          signal: AbortSignal.timeout(perAttemptTimeout),
        };

        if (data && method !== 'GET') {
          options.body = JSON.stringify(data);
        }

        const response = await Sentry.startSpan(
          {
            op: 'http.client',
            name: `${method} ${path}`,
          },
          async (span) => {
            span.setAttribute('http.method', method);
            span.setAttribute('http.target', path);
            span.setAttribute('http.url', url);
            span.setAttribute('retry.attempt', attempt);
            span.setAttribute('timeout.ms', perAttemptTimeout);

            try {
              const res = await fetch(url, options);
              span.setAttribute('http.status_code', res.status);
              span.setAttribute('http.ok', res.ok);
              return res;
            } catch (err) {
              span.setAttribute('error', true);
              span.setAttribute('error.name', (err as any)?.name || 'Error');
              span.setAttribute('error.message', (err as any)?.message || '');
              throw err;
            }
          }
        );

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('Retry-After');
          const resetHeader = response.headers.get('X-RateLimit-Reset');

          let bodyRetryAfterMs = 0;
          try {
            const cloned = response.clone();
            const body: unknown = await cloned.json().catch(() => null);
            if (
              body &&
              typeof body === 'object' &&
              'retry_after' in body &&
              typeof (body as { retry_after?: unknown }).retry_after ===
                'number' &&
              (body as { retry_after: number }).retry_after > 0
            ) {
              bodyRetryAfterMs = Math.max(
                0,
                Math.round((body as { retry_after: number }).retry_after * 1000)
              );
            }
          } catch {}

          let retryAfterMs = bodyRetryAfterMs || 0;
          if (retryAfterHeader) {
            const asNumber = Number(retryAfterHeader);
            if (!Number.isNaN(asNumber)) {
              retryAfterMs = Math.max(0, asNumber * 1000);
            } else {
              const date = new Date(retryAfterHeader);
              const diff = date.getTime() - Date.now();
              if (!Number.isNaN(date.getTime())) {
                retryAfterMs = Math.max(0, diff);
              }
            }
          }

          if (!retryAfterMs && resetHeader) {
            const resetEpoch = Number(resetHeader);
            if (!Number.isNaN(resetEpoch)) {
              const diff = resetEpoch * 1000 - Date.now();
              retryAfterMs = Math.max(0, diff);
            }
          }

          if (!retryAfterMs) {
            retryAfterMs = 5000;
          }

          if (this.rateLimiter) {
            this.rateLimiter.updateFromHeaders(
              'global',
              0,
              0,
              new Date(Date.now() + retryAfterMs)
            );
          }

          if (attempt < maxRetries) {
            console.warn(
              `[ERLC Client] HTTP 429 received. Respecting Retry-After and retrying in ${Math.round(
                retryAfterMs
              )}ms (attempt ${attempt + 1}/${maxRetries + 1}).`
            );
            await this.sleep(retryAfterMs);
            continue;
          }

          return response;
        }

        if (
          (response.status === 502 ||
            response.status === 503 ||
            response.status === 504) &&
          attempt < maxRetries
        ) {
          const delay = this.calculateBackoffDelay(attempt, baseDelay);
          console.warn(
            `[ERLC Client] HTTP ${
              response.status
            } received. Retrying in ${Math.round(delay)}ms (attempt ${
              attempt + 1
            }/${maxRetries + 1}).`
          );
          await this.sleep(delay);
          continue;
        }

        if (this.rateLimiter && response.headers) {
          const limit =
            parseInt(response.headers.get('X-RateLimit-Limit') || '0') || 0;
          const remaining =
            parseInt(response.headers.get('X-RateLimit-Remaining') || '0') || 0;
          const reset =
            parseInt(response.headers.get('X-RateLimit-Reset') || '0') || 0;

          if (limit > 0) {
            this.rateLimiter.updateFromHeaders(
              'global',
              limit,
              remaining,
              new Date(reset * 1000)
            );
          }
        }

        return response;
      } catch (err) {
        lastError = err as Error;

        if (attempt < maxRetries && this.isRetryableError(err)) {
          const delay = this.calculateBackoffDelay(attempt, baseDelay);

          console.warn(
            `[ERLC Client] Request failed (attempt ${attempt + 1}/${
              maxRetries + 1
            }): ${(err as Error).message}. Retrying in ${Math.round(
              delay
            )}ms...`
          );
          await this.sleep(delay);
          continue;
        }

        try {
          Sentry.captureException(err, {
            tags: { module: 'ERLCClient', op: 'http.client' },
            extra: {
              method,
              path,
              url,
              attempt,
              maxRetries,
              message: (err as any)?.message,
              name: (err as any)?.name,
              code: (err as any)?.code,
            },
          });
        } catch {}

        throw err;
      }
    }

    throw lastError!;
  }

  /**
   * Check if an error is retryable
   * @param error - The error to check
   * @returns Whether the error is retryable
   */
  isRetryableError(error: any): boolean {
    if (
      error.code === 'ECONNRESET' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EAI_AGAIN'
    ) {
      return true;
    }

    if (error.name === 'TypeError' && error.message === 'fetch failed') {
      return true;
    }

    if (
      error.name === 'SocketError' ||
      (typeof error.message === 'string' &&
        (error.message.includes('other side closed') ||
          error.message.includes('socket hang up') ||
          error.message.includes('reset by peer')))
    ) {
      return true;
    }

    if (error.name === 'TimeoutError') {
      return true;
    }

    if (error.cause && this.isRetryableError(error.cause)) {
      return true;
    }

    if (error.status >= 500 && error.status < 600) {
      return true;
    }

    return false;
  }

  /**
   * Calculate exponential backoff delay with jitter
   * @param attempt - Current attempt number (0-based)
   * @param baseDelay - Base delay in milliseconds
   * @returns Delay in milliseconds
   */
  calculateBackoffDelay(attempt: number, baseDelay: number): number {
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = exponentialDelay * 0.25 * (Math.random() - 0.5);
    return Math.max(500, exponentialDelay + jitter);
  }

  /**
   * Handle API response and errors
   * @param response - Fetch response
   * @param request - Request context
   * @returns Parsed response data
   */
  async handleResponse(
    response: Response,
    request: RequestContext = {}
  ): Promise<any> {
    const tryParseJson = (text: string | null): any => {
      if (!text || typeof text !== 'string') return null;
      const trimmed = text.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    };

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const resetHeader = response.headers.get('X-RateLimit-Reset');

      let retryAfterMs = 0;
      if (retryAfterHeader) {
        const asNumber = Number(retryAfterHeader);
        if (!Number.isNaN(asNumber)) {
          retryAfterMs = Math.max(0, asNumber * 1000);
        } else {
          const date = new Date(retryAfterHeader);
          const diff = date.getTime() - Date.now();
          if (!Number.isNaN(date.getTime())) {
            retryAfterMs = Math.max(0, diff);
          }
        }
      }

      if (!retryAfterMs && resetHeader) {
        const resetEpoch = Number(resetHeader);
        if (!Number.isNaN(resetEpoch)) {
          const diff = resetEpoch * 1000 - Date.now();
          retryAfterMs = Math.max(0, diff);
        }
      }

      if (!retryAfterMs) {
        retryAfterMs = 5000;
      }

      if (this.rateLimiter) {
        this.rateLimiter.updateFromHeaders(
          'global',
          0,
          0,
          new Date(Date.now() + retryAfterMs)
        );
      }

      let rawText: string;
      try {
        rawText = await response.text();
      } catch {
        rawText = '';
      }

      const parsed = tryParseJson(rawText);
      const errorData =
        parsed && typeof parsed === 'object'
          ? parsed
          : { code: 4001, message: 'Rate limited' };

      const err = PRCAPIError.fromResponse(
        response,
        errorData,
        request,
        rawText
      );
      if (!err.retryAfter) {
        err.retryAfter = retryAfterMs;
      }
      throw err;
    }

    if (!response.ok) {
      let rawText: string;
      try {
        rawText = await response.text();
      } catch {
        rawText = '';
      }

      const parsed = tryParseJson(rawText);
      const errorData =
        parsed && typeof parsed === 'object'
          ? parsed
          : {
              code: 0,
              message: `HTTP ${response.status}: ${
                response.statusText || 'Error'
              }`,
            };

      throw PRCAPIError.fromResponse(response, errorData, request, rawText);
    }

    try {
      return await response.json();
    } catch (_err) {
      const error: any = new Error('Failed to parse response JSON');
      error.status = response.status;
      error.statusText = response.statusText;
      error.method = request?.method;
      error.path = request?.path;
      error.url = request?.url || response?.url;
      throw error;
    }
  }

  /**
   * Sleep for specified milliseconds
   * @param ms - Milliseconds to sleep
   */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildV2ServerPath(query: V2ServerQueryOptions = {}): string {
    const params = new URLSearchParams();

    const includeFlags: Array<keyof V2ServerQueryOptions> = [
      'Players',
      'Staff',
      'JoinLogs',
      'Queue',
      'KillLogs',
      'CommandLogs',
      'ModCalls',
      'EmergencyCalls',
      'Vehicles',
    ];

    for (const key of includeFlags) {
      if (query[key]) {
        params.set(key, 'true');
      }
    }

    const queryString = params.toString();
    return queryString ? `/server?${queryString}` : '/server';
  }

  normalizeServerV2Data(data: ERLCServerDataV2): ERLCServerDataV2 {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid v2 server response payload');
    }

    return data;
  }

  resolveBaseURL(apiVersion: 'v1' | 'v2'): string {
    return apiVersion === 'v1' ? this.baseURLV1 : this.baseURLV2;
  }

  /**
   * Destroy the client and cleanup resources
   */
  destroy(): void {
    if (this.queue) {
      this.queue.stopQueue();
      this.queue.clear();
    }

    if (this.cache) {
      try {
        if (this.cache.store instanceof MemoryCache) {
          this.cache.store.destroy();
        } else if ((this.cache.store as any).disconnect) {
          (this.cache.store as any).disconnect().catch(() => undefined);
        }
      } catch (_err) {}
    }

    if (this.rateLimiter) {
      this.rateLimiter.clearAll();
    }
  }

  /**
   * Get client status and statistics
   * @returns Client status information
   */
  getStatus(): any {
    const status = {
      rateLimiter: this.rateLimiter
        ? {
            globalStatus: this.rateLimiter.getStatus('global'),
          }
        : null,
      queue: this.queue ? this.queue.getStatus() : null,
      cache:
        this.cache && this.cache.store instanceof MemoryCache
          ? this.cache.store.getStats()
          : null,
    };

    return status;
  }

  /**
   * Clear the client cache (erlc.ts parity)
   */
  async clearCache(): Promise<void> {
    if (!this.cache) return;
    try {
      if (this.cache.store instanceof MemoryCache) {
        this.cache.store.clear();
      } else {
        await (this.cache.store as any).clear();
      }
    } catch {}
  }

  /**
   * Get cache size (erlc.ts parity)
   * @returns Cache size
   */
  async getCacheSize(): Promise<number> {
    if (!this.cache) return 0;
    try {
      if (this.cache.store instanceof MemoryCache) {
        return this.cache.store.size();
      }
      return await (this.cache.store as any).size();
    } catch {
      return 0;
    }
  }

  /**
   * Get a cache entry directly (in-memory only)
   * @param key - Cache key
   */
  getCacheEntry(key: string): any {
    if (!this.cache) return null;
    if (!(this.cache.store instanceof MemoryCache)) return null;
    const entry = this.cache.store.getRawEntry(key);
    return entry ? entry.value : null;
  }

  /**
   * Get cache keys (in-memory only)
   * @returns Array of cache keys
   */
  getCacheKeys(): string[] {
    if (!this.cache) return [];
    if (!(this.cache.store instanceof MemoryCache)) return [];
    return this.cache.store.getAllKeys();
  }
}

/**
 * Create a new ERLC client with options
 * @param apiKey - The API key
 * @param options - Client options
 * @returns New client instance
 */
function createClient(apiKey: string, options: ClientOptions = {}): ERLCClient {
  return new ERLCClient(apiKey, options);
}

export { ERLCClient, createClient, getFriendlyErrorMessage };
