import { QuotaStorage, QuotaResult } from "../types";

/**
 * Redis driver for express-quota-limiter.
 *
 * Uses a Redis pipeline (MULTI/EXEC) to atomically:
 *   1. SET the key to `limit` only if it does NOT already exist (NX), with a TTL.
 *   2. DECR the key.
 *
 * This guarantees no race conditions without requiring a Lua script.
 *
 * Compatible with `ioredis` and `node-redis` (v4+).
 *
 * @example
 * import { createClient } from "redis";
 * import { RedisDriver } from "express-quota-limiter";
 *
 * const redis = createClient();
 * await redis.connect();
 *
 * const driver = new RedisDriver(redis);
 */
export class RedisDriver implements QuotaStorage {
  constructor(
    private client: any,
    private options: RedisDriverOptions = {}
  ) {}

  async decrement(key: string, limit: number = 100): Promise<QuotaResult> {
    const ttlSeconds = this.options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    /**
     * Pipeline:
     *  - SET key limit NX EX ttl  → initialises ONLY if missing
     *  - DECR key                 → atomically subtracts 1
     *
     * Both ioredis and node-redis v4 support .multi().exec().
     * For node-redis the pipeline API differs slightly; we handle both.
     */
    let remaining: number;

    if (isNodeRedisClient(this.client)) {
      // node-redis v4 style
      const results = await this.client
        .multi()
        .set(key, limit, { NX: true, EX: ttlSeconds })
        .decr(key)
        .exec();

      remaining = results[1] as number;
    } else {
      // ioredis style
      const results = await this.client
        .multi()
        .set(key, limit, "NX", "EX", ttlSeconds)
        .decr(key)
        .exec();

      // ioredis returns [error, value] tuples
      remaining = (results[1] as [Error | null, number])[1];
    }

    return {
      success: remaining >= 0,
      remaining: Math.max(0, remaining),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 30 days in seconds — a sensible default for monthly quotas */
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Detects node-redis v4 by checking for the `isReady` boolean (absent in ioredis) */
function isNodeRedisClient(client: any): boolean {
  return typeof client.isReady === "boolean";
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface RedisDriverOptions {
  /**
   * TTL (in seconds) applied when a new quota key is first created.
   * @default 2592000 (30 days)
   */
  ttlSeconds?: number;
}
