import { Request } from "express";

/**
 * The result returned by the storage driver after a decrement operation.
 */
export interface QuotaResult {
  /** Whether the operation was within quota (true = allowed, false = exceeded) */
  success: boolean;
  /** How many requests remain in the current window. Always >= 0. */
  remaining: number;
}

/**
 * The interface every storage driver must implement.
 */
export interface QuotaStorage {
  decrement(key: string, limit?: number): Promise<QuotaResult>;
}

/**
 * Context passed to the onQuotaExceeded callback.
 */
export interface QuotaExceededContext {
  /** The quota key that was exceeded (e.g. "quota:emails:tenant_42") */
  key: string;
  /** The configured limit */
  limit: number;
  /** The incoming request */
  req: Request;
}

/**
 * Context passed to the onQuotaChecked callback — fired after every check, pass or fail.
 */
export interface QuotaCheckedContext {
  /** The quota key that was checked */
  key: string;
  /** The configured limit */
  limit: number;
  /** Whether the request was allowed (true) or blocked (false) */
  success: boolean;
  /** Remaining quota after this operation. Always >= 0. */
  remaining: number;
  /** The incoming request */
  req: Request;
}

/**
 * Options passed to `createQuotaLimiter`.
 */
export interface QuotaOptions {
  /** The storage backend (Redis, SQL, in-memory, etc.) */
  storage: QuotaStorage;

  /**
   * A function that derives a unique quota key from the incoming request.
   * @example (req) => `quota:emails:${req.tenantId}`
   */
  keyGenerator: (req: Request) => string;

  /**
   * The maximum number of allowed operations per window.
   * @default 100
   */
  limit?: number;

  /**
   * Custom error message sent to the client when the quota is exceeded.
   */
  errorMessage?: string;

  /**
   * When true, errors in the storage layer do NOT block the request (fail-open).
   * When false, a 500 is returned on storage errors.
   * @default true
   */
  failOpen?: boolean;

  /**
   * Callback invoked after **every** quota check — both allowed and blocked requests.
   * Runs fire-and-forget — errors are caught and logged, never bubble up.
   *
   * Ideal for: saving remaining quota to your DB, sending metrics to Datadog/Prometheus,
   * building usage dashboards, alerting when a tenant is running low, etc.
   *
   * @example
   * onQuotaChecked: async ({ key, success, remaining, req }) => {
   *   await db.query(
   *     "UPDATE tenants SET quota_remaining = $1 WHERE id = $2",
   *     [remaining, req.tenantId]
   *   );
   *   if (remaining < 50) await alertSlack(`Tenant ${req.tenantId} is low on quota`);
   * }
   */
  onQuotaChecked?: (ctx: QuotaCheckedContext) => Promise<void> | void;

  /**
   * Callback invoked only when a request is **blocked** due to quota exhaustion.
   * Runs fire-and-forget — errors are caught and logged, never bubble up.
   *
   * Ideal for: logging violations to a DB, sending billing alerts, notifying the tenant, etc.
   *
   * @example
   * onQuotaExceeded: async ({ key, limit, req }) => {
   *   await db.query(
   *     "INSERT INTO quota_violations (tenant_id, key, at) VALUES ($1, $2, NOW())",
   *     [req.tenantId, key]
   *   );
   * }
   */
  onQuotaExceeded?: (ctx: QuotaExceededContext) => Promise<void> | void;
}
