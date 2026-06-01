import { ERLCClient, createClient, getFriendlyErrorMessage } from './client.js';
import { ErrorCode, EventType, isPrivateServerOfflineError } from './types.js';
import { RateLimiter } from './rateLimiter.js';
import { RequestQueue } from './queue.js';
import { MemoryCache } from './cache.js';
import { PRCAPIError } from './errors.js';
import type { ClientOptions } from './types.js';

function newClient(apiKey: string, options: ClientOptions = {}): any {
  return createClient(apiKey, options);
}

function newClientWithQueue(
  apiKey: string,
  workers: number = 1,
  interval: number = 1000,
  options: ClientOptions = {}
): any {
  return createClient(apiKey, {
    ...options,
    requestQueue: {
      workers,
      interval,
    },
  });
}

function newClientWithCache(
  apiKey: string,
  ttl: number = 60000,
  options: ClientOptions = {}
): any {
  return createClient(apiKey, {
    ...options,
    cache: {
      enabled: true,
      ttl,
      staleIfError: true,
      maxItems: 1000,
      prefix: 'erlc:',
      ...(options.cache && typeof options.cache === 'object'
        ? {
            redisUrl: options.cache.redisUrl,
            redisKeyPrefix: options.cache.redisKeyPrefix,
          }
        : {}),
    },
  });
}

interface QueueCacheConfig {
  workers?: number;
  interval?: number;
  ttl?: number;
  redisUrl?: string;
  redisKeyPrefix?: string;
}

function newClientWithQueueAndCache(
  apiKey: string,
  config: QueueCacheConfig = {},
  options: ClientOptions = {}
): any {
  const {
    workers = 1,
    interval = 1000,
    ttl = 60000,
    redisUrl,
    redisKeyPrefix,
  } = config;

  return createClient(apiKey, {
    ...options,
    requestQueue: {
      workers,
      interval,
    },
    cache: {
      enabled: true,
      ttl,
      staleIfError: true,
      maxItems: 1000,
      prefix: 'erlc:',
      ...(redisUrl ? { redisUrl } : {}),
      ...(redisKeyPrefix ? { redisKeyPrefix } : {}),
    },
  });
}

export {
  ERLCClient,
  createClient,
  newClient,
  newClientWithQueue,
  newClientWithCache,
  newClientWithQueueAndCache,
  getFriendlyErrorMessage,
  isPrivateServerOfflineError,
  EventType,
  ErrorCode,
  PRCAPIError,
  RateLimiter,
  RequestQueue,
  MemoryCache,
};
