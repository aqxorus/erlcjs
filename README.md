# ERLC API Wrapper

TypeScript/Node.js wrapper for the Emergency Response: Liberty County API.

This README documents the current implementation in this folder.

## Features

- v1 + v2 API support
- Automatic retries with exponential backoff for transient failures
- Automatic 429 handling using Retry-After/X-RateLimit-Reset
- Optional request queue
- Optional cache (in-memory or Redis)
- Optional stale-if-error cache fallback
- Structured API errors via `PRCAPIError`
- Optional Sentry span + exception instrumentation

## Import

```javascript
const {
  createClient,
  newClient,
  newClientWithQueue,
  newClientWithCache,
  newClientWithQueueAndCache,
  PRCAPIError,
  ErrorCode,
  getFriendlyErrorMessage,
  isPrivateServerOfflineError,
} = require('./src/API');
```

## Quick Start

```javascript
const { newClient, getFriendlyErrorMessage } = require('./src/API');

async function main() {
  const client = newClient('your-server-key', {
    timeout: 15000,
  });

  try {
    const data = await client.getServer({ Players: true, Staff: true });
    console.log('Players:', data.Players || []);
    console.log('Staff:', data.Staff || {});

    await client.executeCommand(':h API online');
  } catch (error) {
    console.error(getFriendlyErrorMessage(error));
  } finally {
    client.destroy();
  }
}

main();
```

## Client Factories

### `newClient(apiKey, options?)`

Creates a standard client.

### `newClientWithQueue(apiKey, workers?, interval?, options?)`

Creates a client with request queueing enabled.

### `newClientWithCache(apiKey, ttl?, options?)`

Creates a client with cache enabled.

Defaults applied by this helper:

- `enabled: true`
- `ttl: <ttl argument or 60000>`
- `staleIfError: true`
- `maxItems: 1000`
- `prefix: 'erlc:'`

### `newClientWithQueueAndCache(apiKey, config?, options?)`

Creates a client with queue + cache.

`config` supports:

- `workers?: number` (default `1`)
- `interval?: number` (default `1000`)
- `ttl?: number` (default `60000`)
- `redisUrl?: string`
- `redisKeyPrefix?: string`

### `createClient(apiKey, options?)`

Full-control constructor.

```javascript
const { createClient } = require('./src/API');

const client = createClient('your-server-key', {
  timeout: 30000,
  baseURL: 'https://api.erlc.gg/v1',
  baseURL2: 'https://api.erlc.gg/v2',
  keepAlive: true,
  globalKey: 'optional-global-key',
  requestQueue: {
    workers: 2,
    interval: 500,
  },
  cache: {
    enabled: true,
    ttl: 60000,
    staleIfError: true,
    maxItems: 1000,
    prefix: 'erlc:',
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'hbot:',
  },
});
```

If Redis is configured, install `redis` (`pnpm add redis`).

## API Methods

### `getServer(query?, options?)`

Calls v2 `/server` with optional include flags.

Supported include flags:

- `Players`
- `Staff`
- `JoinLogs`
- `Queue`
- `KillLogs`
- `CommandLogs`
- `ModCalls`
- `EmergencyCalls`
- `Vehicles`

```javascript
const server = await client.getServer({
  Players: true,
  Queue: true,
  EmergencyCalls: true,
  Vehicles: true,
});
```

Per-call options:

- `cache?: boolean` (`false` disables cache for that call)
- `cacheMaxAge?: number` (TTL override in milliseconds)

```javascript
const uncached = await client.getServer({ Players: true }, { cache: false });
const shortLived = await client.getServer(
  { Players: true },
  { cacheMaxAge: 5000 }
);
```

### `getServerStatus(options?)`

Alias for `getServer({}, options)`.

### `getBans(options?)`

Calls v1 `/server/bans`.

### `executeCommand(command)`

Calls v2 `/server/command`.

```javascript
await client.executeCommand(':pm PlayerName Hello');
await client.executeCommand(':kick PlayerName Reason');
```

### Low-level methods

- `get(path, options?, apiVersion?)`
- `post(path, data, apiVersion?)`

These are available on the client for direct endpoint usage.

## Error Handling

Non-2xx responses are thrown as `PRCAPIError`.

```javascript
const {
  PRCAPIError,
  ErrorCode,
  isPrivateServerOfflineError,
} = require('./src/API');

try {
  await client.getServer({ Players: true });
} catch (error) {
  if (error instanceof PRCAPIError) {
    console.error('Status:', error.status);
    console.error('Code:', error.code);
    console.error('Message:', error.message);

    if (error.isRateLimit) {
      console.log('Retry after (ms):', error.retryAfter);
    }

    if (
      error.code === ErrorCode.SERVER_OFFLINE ||
      isPrivateServerOfflineError(error)
    ) {
      console.log('Private server is offline.');
    }
  }
}
```

Common error code groups:

- `2000-2004` authentication/config errors
- `3001-3002` command/server state errors
- `4001-4003` rate limiting/restriction errors
- `9998-9999` access/outdated module errors

## Retries, Timeouts, and Rate Limits

- Timeout is per HTTP attempt (`timeout`, default `10000` ms)
- Retries up to 3 times after the first attempt (4 total attempts)
- Retries include transient network failures and `502/503/504`
- `429` uses `retry_after` body value, `Retry-After`, or `X-RateLimit-Reset`
- Backoff is exponential with jitter

## Queue and Cache Behavior

- Queue runs requests through configured worker count + interval delay
- Cache key format is `<prefix><apiVersion>:<path>`
- `staleIfError: true` allows expired cache fallback when request fails
- `getStatus()` exposes queue/cache/rate-limiter status

```javascript
console.log(client.getStatus());

await client.clearCache();
console.log(await client.getCacheSize());
```

In-memory cache only:

- `getCacheKeys()`
- `getCacheEntry(key)`

## Notes

- `EventType` is exported, but this wrapper does not currently provide subscribe/polling methods.
- `destroy()` should be called when the client is no longer needed.

## License

MIT - see [LICENSE](./LICENSE).
