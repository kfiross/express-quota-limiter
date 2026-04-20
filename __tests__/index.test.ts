import { createQuotaLimiter } from "../src/core";
import { MemoryDriver } from "../src/drivers/memory-driver";
import { Request, Response, NextFunction } from "express";

const mockReq = (overrides: any = {}): Request =>
  ({ tenantId: "tenant_1", ...overrides } as any);

const mockRes = () => {
  const headers: Record<string, string> = {};
  const state = { body: null as any, status: 200 };
  const res: any = {
    setHeader: jest.fn((k: string, v: string) => { headers[k] = v; return res; }),
    status: jest.fn((code: number) => { state.status = code; return res; }),
    json: jest.fn((data: any) => { state.body = data; return res; }),
  };
  return { res, headers, state };
};

const mockNext: NextFunction = jest.fn();

describe("createQuotaLimiter — core middleware", () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = new MemoryDriver();
    jest.clearAllMocks();
  });

  it("allows requests within quota and sets correct headers", async () => {
    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 3,
      keyGenerator: (req: any) => `quota:${req.tenantId}`,
    });
    const { res, headers } = mockRes();
    await middleware(mockReq(), res, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(headers["Quota-Remaining"]).toBe("2");
    expect(headers["Quota-Limit"]).toBe("3");
  });

  it("blocks requests when quota is exceeded and returns 429", async () => {
    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 2,
      keyGenerator: (req: any) => `quota:${req.tenantId}`,
      errorMessage: "Custom quota message",
    });
    const req = mockReq();
    for (let i = 0; i < 2; i++) {
      const { res } = mockRes();
      await middleware(req, res, mockNext);
    }
    const { res, state } = mockRes();
    await middleware(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(state.body.message).toBe("Custom quota message");
    expect(mockNext).toHaveBeenCalledTimes(2);
  });

  it("decrements correctly across multiple tenants independently", async () => {
    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 2,
      keyGenerator: (req: any) => `quota:${req.tenantId}`,
    });
    const { res: r1, headers: h1 } = mockRes();
    await middleware(mockReq({ tenantId: "A" }), r1, mockNext);
    const { res: r2, headers: h2 } = mockRes();
    await middleware(mockReq({ tenantId: "B" }), r2, mockNext);
    expect(h1["Quota-Remaining"]).toBe("1");
    expect(h2["Quota-Remaining"]).toBe("1");
    expect(mockNext).toHaveBeenCalledTimes(2);
  });

  it("fails open when storage throws and failOpen=true", async () => {
    const broken = { decrement: jest.fn().mockRejectedValue(new Error("Redis down")) };
    const middleware = createQuotaLimiter({ storage: broken, limit: 10, keyGenerator: () => "k", failOpen: true });
    const { res } = mockRes();
    await middleware(mockReq(), res, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 500 when storage throws and failOpen=false", async () => {
    const broken = { decrement: jest.fn().mockRejectedValue(new Error("Redis down")) };
    const middleware = createQuotaLimiter({ storage: broken, limit: 10, keyGenerator: () => "k", failOpen: false });
    const { res } = mockRes();
    await middleware(mockReq(), res, mockNext);
    expect(mockNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("skips quota check when keyGenerator returns empty string", async () => {
    const middleware = createQuotaLimiter({ storage: driver, limit: 10, keyGenerator: () => "" });
    const { res } = mockRes();
    await middleware(mockReq(), res, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
  });
});

describe("MemoryDriver", () => {
  it("initialises a key with limit and decrements in one call", async () => {
    const driver = new MemoryDriver();
    const result = await driver.decrement("k", 10);
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("keeps decrementing on subsequent calls", async () => {
    const driver = new MemoryDriver();
    await driver.decrement("k", 3);
    await driver.decrement("k", 3);
    const result = await driver.decrement("k", 3);
    expect(result.remaining).toBe(0);
    expect(result.success).toBe(true);
  });

  it("returns success=false when remaining goes below zero", async () => {
    const driver = new MemoryDriver();
    await driver.decrement("k", 1);
    const result = await driver.decrement("k", 1);
    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("clear() resets all state", async () => {
    const driver = new MemoryDriver();
    await driver.decrement("k", 5);
    driver.clear();
    const result = await driver.decrement("k", 5);
    expect(result.remaining).toBe(4);
  });
});


describe("onQuotaExceeded callback", () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = new MemoryDriver();
    jest.clearAllMocks();
  });

  it("is called when quota is exceeded with correct context", async () => {
    const onQuotaExceeded = jest.fn().mockResolvedValue(undefined);

    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 1,
      keyGenerator: (req: any) => `quota:${req.tenantId}`,
      onQuotaExceeded,
    });

    const req = mockReq({ tenantId: "tenant_99" });

    // First request: within quota
    const { res: r1 } = mockRes();
    await middleware(req, r1, mockNext);

    // Second request: exceeds quota → callback fires
    const { res: r2 } = mockRes();
    await middleware(req, r2, mockNext);

    // Give the fire-and-forget a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(onQuotaExceeded).toHaveBeenCalledTimes(1);
    expect(onQuotaExceeded).toHaveBeenCalledWith(
      expect.objectContaining({ key: "quota:tenant_99", limit: 1, req })
    );
  });

  it("is NOT called when request is within quota", async () => {
    const onQuotaExceeded = jest.fn();

    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 5,
      keyGenerator: () => "k",
      onQuotaExceeded,
    });

    const { res } = mockRes();
    await middleware(mockReq(), res, mockNext);

    await new Promise((r) => setTimeout(r, 10));

    expect(onQuotaExceeded).not.toHaveBeenCalled();
  });

  it("does not crash the middleware if the callback throws", async () => {
    const onQuotaExceeded = jest.fn().mockRejectedValue(new Error("pg connection lost"));

    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 1,
      keyGenerator: () => "k",
      onQuotaExceeded,
    });

    // Use up quota
    const { res: r1 } = mockRes();
    await middleware(mockReq(), r1, mockNext);

    // Exceed quota — callback throws, but 429 should still be returned cleanly
    const { res: r2 } = mockRes();
    await middleware(mockReq(), r2, mockNext);

    await new Promise((r) => setTimeout(r, 10));

    expect(r2.status).toHaveBeenCalledWith(429);
    expect(mockNext).toHaveBeenCalledTimes(1); // only first request passed
  });
});


describe("onQuotaChecked callback", () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = new MemoryDriver();
    jest.clearAllMocks();
  });

  it("is called on every request with full context", async () => {
    const onQuotaChecked = jest.fn().mockResolvedValue(undefined);

    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 3,
      keyGenerator: () => "k",
      onQuotaChecked,
    });

    const { res: r1 } = mockRes();
    await middleware(mockReq(), r1, mockNext);
    await new Promise((r) => setTimeout(r, 10));

    expect(onQuotaChecked).toHaveBeenCalledTimes(1);
    expect(onQuotaChecked).toHaveBeenCalledWith(
      expect.objectContaining({ key: "k", limit: 3, success: true, remaining: 2 })
    );
  });

  it("is called with success=false when quota is exceeded", async () => {
    const onQuotaChecked = jest.fn().mockResolvedValue(undefined);

    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 1,
      keyGenerator: () => "k",
      onQuotaChecked,
    });

    // use up quota
    const { res: r1 } = mockRes();
    await middleware(mockReq(), r1, mockNext);

    // exceed
    const { res: r2 } = mockRes();
    await middleware(mockReq(), r2, mockNext);
    await new Promise((r) => setTimeout(r, 10));

    expect(onQuotaChecked).toHaveBeenCalledTimes(2);
    const secondCall = onQuotaChecked.mock.calls[1][0];
    expect(secondCall.success).toBe(false);
    expect(secondCall.remaining).toBe(0);
  });

  it("both callbacks fire together when quota is exceeded", async () => {
    const onQuotaChecked = jest.fn().mockResolvedValue(undefined);
    const onQuotaExceeded = jest.fn().mockResolvedValue(undefined);

    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 1,
      keyGenerator: () => "k",
      onQuotaChecked,
      onQuotaExceeded,
    });

    const { res: r1 } = mockRes();
    await middleware(mockReq(), r1, mockNext);
    const { res: r2 } = mockRes();
    await middleware(mockReq(), r2, mockNext);
    await new Promise((r) => setTimeout(r, 10));

    expect(onQuotaChecked).toHaveBeenCalledTimes(2);
    expect(onQuotaExceeded).toHaveBeenCalledTimes(1);
  });

  it("does not crash the middleware if onQuotaChecked throws", async () => {
    const onQuotaChecked = jest.fn().mockRejectedValue(new Error("db error"));

    const middleware = createQuotaLimiter({
      storage: driver,
      limit: 5,
      keyGenerator: () => "k",
      onQuotaChecked,
    });

    const { res } = mockRes();
    await middleware(mockReq(), res, mockNext);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockNext).toHaveBeenCalledTimes(1);
  });
});
