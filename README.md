# express-quota-limiter

A flexible, driver-based quota limiter middleware for [Express.js](https://expressjs.com/), written in TypeScript.

Unlike traditional rate limiters that operate per-second or per-minute, `express-quota-limiter` is designed for **long-window quotas** (e.g. 500 emails/month, 1000 API calls/day). The storage backend is fully swappable — ship with Redis in production, and use the built-in in-memory driver for tests.

## Features

- 🔌 **Driver-based** — Redis, in-memory, or bring your own
- 🔒 **Atomic operations** — no race conditions (Redis pipeline / NX)
- 🏷 **Custom keys** — per-tenant, per-user, per-route, or any combination
- ⚖️ **Request weighting** — charge different amounts per request (e.g. bulk actions)
- ➕ **Manual increment API** — increment quota usage programmatically
- 📦 **Zero mandatory dependencies** — storage clients are peer-injected
- 🧪 **Testable** — built-in `MemoryDriver` needs no infrastructure
- 💬 **TypeScript-first** — full types, no `@types/` package needed
- 🚦 **Fail-open by default** — storage outages don't block your users
- 📡 **Callbacks** — hook into every check or just blocked requests

---

## Installation

```bash
npm install express-quota-limiter
```
```bash
yarn add express-quota-limiter
```

### Peer dependencies

```bash
# If using Redis (ioredis or node-redis v4)
npm install ioredis
# or
npm install redis
```

---

## Quick Start

```typescript
import express from "express";
import { createQuotaLimiter, RedisDriver } from "express-quota-limiter";
import { redis } from "./services/redis"; // your existing client

const app = express();

const emailQuota = createQuotaLimiter({
  storage: new RedisDriver(redis),
  limit: 500,
  keyGenerator: (req) => `quota:emails:${req.tenantId}`,
  errorMessage: "Monthly email quota exceeded",
});

app.post("/send-email", emailQuota, (req, res) => {
  res.json({ ok: true });
});
```

---

## Callbacks

Use callbacks to react to quota events without touching the middleware logic.
Both run **fire-and-forget** — errors inside them are caught and logged, and never affect the HTTP response.

### `onQuotaChecked` — fires on every request

Receives the full context after every check, whether the request was allowed or blocked.
Ideal for saving the current `remaining` value to your DB, sending metrics to Datadog/Prometheus, or building usage dashboards.

### `onQuotaExceeded` — fires only on blocked requests

Receives context only when a request is blocked (`remaining === 0`).
Ideal for logging violations, sending billing alerts, or notifying the tenant.

```typescript
const emailQuota = createQuotaLimiter({
  storage: new RedisDriver(redis),
  limit: 500,
  keyGenerator: (req) => `quota:emails:${req.tenantId}`,

  // runs on every request — keeps your DB in sync
  onQuotaChecked: async ({ remaining, req }) => {
    await db.query(
      "UPDATE tenants SET quota_remaining = $1 WHERE id = $2",
      [remaining, req.tenantId]
    );
  },

  // runs only when the quota is exhausted — sends an alert
  onQuotaExceeded: async ({ req }) => {
    await slack.send(`⚠️ Tenant ${req.tenantId} exhausted their email quota`);
  },
});
```

### Callback context

| Callback | Fields available |
|---|---|
| `onQuotaChecked` | `key`, `limit`, `success`, `remaining`, `req`, `weight` |
| `onQuotaExceeded` | `key`, `limit`, `req`, `weight` |

---

## Response Headers

Every request (allowed or blocked) receives these headers:

| Header | Description |
|---|---|
| `Quota-Remaining` | Remaining operations in the current window |
| `Quota-Limit` | The configured limit |

When the quota is exceeded, the middleware responds with `HTTP 429`:

```json
{
  "error": "Too Many Requests",
  "message": "Monthly email quota exceeded",
  "quota": { "limit": 500, "remaining": 0 }
}
```

---

## Drivers

### `RedisDriver`

Works with both **ioredis** and **node-redis v4**. Uses a MULTI/EXEC pipeline for atomic init + decrement.

```typescript
import { RedisDriver } from "express-quota-limiter";
import Redis from "ioredis";

const redis = new Redis();
const driver = new RedisDriver(redis, {
  ttlSeconds: 60 * 60 * 24 * 30, // 30 days (default)
});
```

### `MemoryDriver`

In-process store. No dependencies. Not suitable for multi-process deployments.

```typescript
import { MemoryDriver } from "express-quota-limiter";

const driver = new MemoryDriver({ ttlSeconds: 3600 }); // 1 hour window
```

### Custom Driver

Implement the `QuotaStorage` interface to add any backend:

```typescript
import { QuotaStorage, QuotaResult } from "express-quota-limiter";

class MySQLDriver implements QuotaStorage {
  async decrement(key: string, limit: number = 100): Promise<QuotaResult> {
    // your implementation
  }
}
```

## Request Weighting

You can charge different quota amounts per request using the `quotaWeight` option. This is useful for endpoints where some requests are more expensive than others (e.g. sending 1 vs 100 emails).

```typescript
const quota = createQuotaLimiter({
  storage: new RedisDriver(redis),
  limit: 1000,
  keyGenerator: (req) => req.userId,
  quotaWeight: (req) => req.body.count || 1, // charge by count
});
```

The calculated `weight` is passed to storage drivers and available in callbacks.

---

## Manual Increment

You can manually increment quota usage (e.g. for compensating failed actions or admin adjustments) using the driver's `increment` method:

```typescript
// Example: increment usage by 10 for a user
await driver.increment('quota:emails:user123', 10);
```

All built-in drivers support this method. The `weight` parameter lets you increment by any amount.


---

## API Reference

### `createQuotaLimiter(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `storage` | `QuotaStorage` | **required** | The storage driver to use |
| `keyGenerator` | `(req) => string` | **required** | Returns the quota key for a request |
| `limit` | `number \| (req) => number \| Promise<number>` | `100` | Max operations per window — static or per-request |
| `errorMessage` | `string` | `"Quota exceeded"` | Message returned on 429 |
| `failOpen` | `boolean` | `true` | Pass requests through on storage errors |
| `onQuotaChecked` | `(ctx) => void` | — | Fired after every check |
| `onQuotaExceeded` | `(ctx) => void` | — | Fired only when blocked |
| `quotaWeight` | `number \| (req) => number \| Promise<number>` | — | Calculate how much quota each request consumes (Like sending bulk emails) |

#### Dynamic limits

The `limit` option can resolve limits dynamically per-request — ideal for multi-tenant apps with different plans:

```typescript
const emailQuota = createQuotaLimiter({
  storage: new RedisDriver(redis),
  limit: async (req) => {
    const tenant = await db.query(
      "SELECT plan FROM tenants WHERE id = $1",
      [req.tenantId]
    );
    // Pro plan: 5000/month, free plan: 500/month
    return tenant.plan === "pro" ? 5000 : 500;
  },
  keyGenerator: (req) => `quota:emails:${req.tenantId}`,
});
```

---

## Testing

The built-in `MemoryDriver` makes unit testing straightforward:

```typescript
import { createQuotaLimiter, MemoryDriver } from "express-quota-limiter";

const driver = new MemoryDriver();
const middleware = createQuotaLimiter({
  storage: driver,
  limit: 5,
  keyGenerator: (req) => `test:${req.userId}`,
});

// Use driver.clear() between tests to reset state
afterEach(() => driver.clear());
```

---

## License

MIT
