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
  decrement(key: string, limit?: number, weight?: number): Promise<QuotaResult>;
  /**
   * Increments the quota for a given key by the specified weight.
   * This is used to "refund" quota when requests are successful.
   * @param key The quota key.
   * @param weight The amount to increment by.
   */
  increment(key: string, weight: number): Promise<void>;
}

/**
 * A limit value — either a static number or a (possibly async) function
 * that receives the request and returns the limit for that specific request.
 *
 * @example Static
 * limit: 500
 *
 * @example Dynamic — per-tenant plan
 * limit: async (req) => {
 *   const tenant = await db.query("SELECT plan FROM tenants WHERE id = $1", [req.tenantId]);
 *   return tenant.plan === "pro" ? 10_000 : 500;
 * }
 */
export type LimitResolver = number | ((req: Request) => number | Promise<number>);

/**
 * Context passed to the onQuotaExceeded callback.
 */
export interface QuotaExceededContext {
  /** The quota key that was exceeded (e.g. "quota:emails:tenant_42") */
  key: string;
  /** The resolved limit for this request */
  limit: number;
  /** The calculated weight of the current request */
  weight: number;
  /** The incoming request */
  req: Request;
}

export interface QuotaWeightOptions {
  getWeight: ((req: Request) => number | Promise<number>);
  defaultWeight?: number
}

/**
 * Context passed to the onQuotaChecked callback — fired after every check, pass or fail.
 */
export interface QuotaCheckedContext {
  /** The quota key that was checked */
  key: string;
  /** The resolved limit for this request */
  limit: number;
  /** The calculated weight of the current request */
  weight: number;
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
   * Can be a static number or an async function for dynamic per-request limits.
   * @default 100
   *
   * @example Static
   * limit: 500
   *
   * @example Dynamic — different limit per tenant plan
   * limit: async (req) => {
   *   const { plan } = await db.query("SELECT plan FROM tenants WHERE id = $1", [req.tenantId]);
   *   return plan === "pro" ? 10_000 : 500;
   * }
   */
  limit?: LimitResolver;

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
   */
  onQuotaChecked?: (ctx: QuotaCheckedContext) => Promise<void> | void;

  /**
   * Callback invoked only when a request is **blocked** due to quota exhaustion.
   * Runs fire-and-forget — errors are caught and logged, never bubble up.
   *
   * Ideal for: logging violations to a DB, sending billing alerts, notifying the tenant, etc.
   */
  onQuotaExceeded?: (ctx: QuotaExceededContext) => Promise<void> | void;

  /**
   * Options for configuring quota weighting.
   */
  quotaWeight: QuotaWeightOptions
}
