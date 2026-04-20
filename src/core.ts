import { Request, Response, NextFunction } from "express";
import { QuotaOptions } from "./types";

const fireAndForget = (label: string, fn: () => Promise<void> | void) => {
  Promise.resolve()
    .then(() => fn())
    .catch((err) => console.error(`[express-quota-limiter] ${label} threw:`, err));
};

export const createQuotaLimiter = (options: QuotaOptions) => {
  const {
    storage,
    keyGenerator,
    limit = 100,
    errorMessage = "Quota exceeded",
    failOpen = true,
    onQuotaChecked,
    onQuotaExceeded,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = keyGenerator(req);

      if (!key) {
        console.warn("[express-quota-limiter] keyGenerator returned an empty key — skipping quota check.");
        next();
        return;
      }

      const { success, remaining } = await storage.decrement(key, limit);

      res.setHeader("Quota-Remaining", remaining.toString());
      res.setHeader("Quota-Limit", limit.toString());

      // Always fire onQuotaChecked — pass or fail
      if (onQuotaChecked) {
        fireAndForget("onQuotaChecked", () =>
          onQuotaChecked({ key, limit, success, remaining, req })
        );
      }

      if (!success) {
        // Fire onQuotaExceeded only on blocked requests
        if (onQuotaExceeded) {
          fireAndForget("onQuotaExceeded", () =>
            onQuotaExceeded({ key, limit, req })
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
