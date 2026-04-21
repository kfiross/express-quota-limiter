import { QuotaStorage, QuotaResult } from "../types";

interface MemoryEntry {
  remaining: number;
  expiresAt: number;
}

/**
 * In-memory driver for express-quota-limiter.
 *
 * Ideal for:
 *   - Unit tests and integration tests (no external dependencies)
 *   - Local development
 *   - Single-process applications with non-critical quota needs
 *
 * ⚠️  NOT suitable for multi-process or multi-server deployments —
 *     each process maintains its own isolated store.
 *
 * @example
 * import { MemoryDriver } from "express-quota-limiter";
 *
 * const driver = new MemoryDriver({ ttlSeconds: 3600 }); // 1-hour window
 */
export class MemoryDriver implements QuotaStorage {
  private store = new Map<string, MemoryEntry>();

  constructor(private options: MemoryDriverOptions = {}) {}

  async decrement(key: string, limit: number = 100, weight: number = 1): Promise<QuotaResult> {
    const ttlSeconds = this.options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const now = Date.now();

    const entry = this.store.get(key);

    if (!entry || entry.expiresAt <= now) {
      // Key is new or expired — initialise, then decrement
      this.store.set(key, {
        remaining: limit - weight,
        expiresAt: now + ttlSeconds * 1000,
      });

      return { success: true, remaining: limit - weight };
    }

    const remaining = entry.remaining - weight;
    this.store.set(key, { ...entry, remaining });

    return {
      success: remaining >= 0,
      remaining: Math.max(0, remaining),
    };
  }

  async increment(key: string, weight: number = 1): Promise<void> {
    const entry = this.store.get(key);
    if (entry) {
      this.store.set(key, { ...entry, remaining: entry.remaining + weight });
    }
  }

  /**
   * Clears all stored quota data.
   * Useful for resetting state between tests.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the raw store entry for a key, or undefined if it doesn't exist.
   * Useful for inspecting state in tests.
   */
  inspect(key: string): Readonly<MemoryEntry> | undefined {
    return this.store.get(key);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// ─── Options ─────────────────────────────────────────────────────────────────

export interface MemoryDriverOptions {
  /**
   * TTL (in seconds) for each quota window.
   * @default 2592000 (30 days)
   */
  ttlSeconds?: number;
}
