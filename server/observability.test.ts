import { describe, it, expect, vi } from "vitest";
import {
  requestIdMiddleware,
  logError,
  makeHealthHandler,
  type RequestWithId,
} from "./observability";

function mockRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: (k: string, v: string) => (headers[k] = v),
    _headers: headers,
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: any) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("requestIdMiddleware", () => {
  it("بيولّد معرّف ويحطّه على req وفي الرد", () => {
    const req = { headers: {} } as RequestWithId;
    const res = mockRes();
    const next = vi.fn();
    requestIdMiddleware(req, res, next);
    expect(req.requestId).toBeTruthy();
    expect(res._headers["x-request-id"]).toBe(req.requestId);
    expect(next).toHaveBeenCalledOnce();
  });

  it("بيستخدم الهيدر الجاي لو موجود (correlation)", () => {
    const req = { headers: { "x-request-id": "abc-123" } } as any;
    const res = mockRes();
    requestIdMiddleware(req, res, vi.fn());
    expect(req.requestId).toBe("abc-123");
  });
});

describe("logError — معرّفات آمنة بس", () => {
  it("بيسجّل JSON بالمعرّفات وبيتجاهل null", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError({ requestId: "r1", code: "INTERNAL_SERVER_ERROR", tenantId: 5, businessId: null });
    const line = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("error");
    expect(parsed.requestId).toBe("r1");
    expect(parsed.tenantId).toBe(5);
    expect("businessId" in parsed).toBe(false); // null اتشال
    spy.mockRestore();
  });

  it("🔑 بيحجب أي مفتاح فيه password/token/secret", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError({ requestId: "r2", password: "x", apiToken: "y", secret: "z" } as any);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect("password" in parsed).toBe(false);
    expect("apiToken" in parsed).toBe(false);
    expect("secret" in parsed).toBe(false);
    expect(parsed.requestId).toBe("r2");
    spy.mockRestore();
  });
});

describe("makeHealthHandler", () => {
  it("200/ok لما الداتابيز واصلة", async () => {
    const getDb = async () => ({ execute: async () => [[{ 1: 1 }]] });
    const res = mockRes();
    await makeHealthHandler(getDb)({} as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.db).toBe("up");
  });

  it("503/degraded لما مفيش داتابيز", async () => {
    const getDb = async () => null;
    const res = mockRes();
    await makeHealthHandler(getDb)({} as any, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.db).toBe("down");
  });

  it("🔑 مفيش أي إعداد حسّاس في الرد", async () => {
    const getDb = async () => ({ execute: async () => [[{ 1: 1 }]] });
    const res = mockRes();
    await makeHealthHandler(getDb)({} as any, res);
    const keys = Object.keys(res.body);
    expect(keys.sort()).toEqual(["db", "status", "ts", "uptimeSeconds"]);
  });
});
