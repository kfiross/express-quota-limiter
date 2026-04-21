import { Request, Response, NextFunction } from "express";
import { QuotaOptions, LimitResolver } from "./types";

const resolveLimit = async (limit: LimitResolver, req: Request): Promise<number> => {
  return typeof limit === "function" ? await limit(req) : limit;
};

const fireAndForget = (label: string, fn: () => Promise<void> | void) => {
  Promise.resolve()
    .then(() => fn())
    .catch((err) => console.error(`[express-quota-limiter] ${label} threw:`, err));
};

export const createQuotaLimiter = (options: QuotaOptions) => {
  const {
    storage,
    keyGenerator,
    limit: limitOption = 100,
    errorMessage = "Quota exceeded",
    failOpen = true,
    onQuotaChecked,
    onQuotaExceeded,
    quotaWeight,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = keyGenerator(req);

      if (!key) {
        console.warn("[express-quota-limiter] keyGenerator returned an empty key — skipping quota check.");
        next();
        return;
      }

      // Resolve the limit — static number or async function
      const limit = await resolveLimit(limitOption, req);

      const weight = await quotaWeight.getWeight(req) || quotaWeight.defaultWeight || 1;

      const { success, remaining } = await storage.decrement(key, limit, weight);

      res.setHeader("Quota-Remaining", remaining.toString());
      res.setHeader("Quota-Limit", limit.toString());

      if (onQuotaChecked) {
        fireAndForget("onQuotaChecked", () =>
          onQuotaChecked({ key, limit, success, remaining, req, weight })
        );
      }

      if (!success) {
        if (onQuotaExceeded) {
          fireAndForget("onQuotaExceeded", () =>
            onQuotaExceeded({ key, limit, req, weight })
          );
        }

        res.status(429).json({
          error: "Too Many Requests",
          message: errorMessage,
          quota: { limit, remaining: 0 },
        });
        return;
      }

      next();
    } catch (error) {
      console.error("[express-quota-limiter] Storage error:", error);

      if (failOpen) {
        next();
      } else {
        res.status(500).json({
          error: "Internal Server Error",
          message: "Quota service unavailable",
        });
      }
    }
  };
};
