import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { TRPCError } from "@trpc/server";

const JWT_SECRET = "test-secret-for-auth-context";
process.env.JWT_SECRET = JWT_SECRET;

const managerEmployee = {
  id: 5,
  name: "Owner",
  email: "owner@example.com",
  username: "owner",
  role: "manager" as const,
  isActive: true,
  passwordHash: "hashed",
  tenantId: 1,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function mockDbReturning(row: unknown) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
  };
}

const mockGetDb = vi.fn();

vi.mock("./db", () => ({
  getDb: (...args: any[]) => mockGetDb(...args),
}));

const { createContext } = await import("./_core/context");
const { appRouter } = await import("./routers");
const { COOKIE_NAME } = await import("../shared/const");

function fakeReqRes(cookies: Record<string, string> = {}) {
  return {
    req: { cookies, headers: {} } as any,
    res: { clearCookie: vi.fn(), cookie: vi.fn() } as any,
  };
}

describe("createContext (local auth, replaces Manus OAuth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("populates ctx.user as admin from a valid /login session cookie (true owner, no employeeManager flag)", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning(managerEmployee));
    const token = jwt.sign({ employeeId: managerEmployee.id, role: "manager" }, JWT_SECRET);

    const ctx = await createContext({ req: fakeReqRes({ [COOKIE_NAME]: token }).req, res: fakeReqRes().res } as any);

    expect(ctx.user).not.toBeNull();
    expect(ctx.user?.role).toBe("admin");
    expect(ctx.employeeManager).toBeUndefined();
    expect(ctx.realEmployeeId).toBe(managerEmployee.id);
  });

  it("populates ctx.user as admin from a valid employee_token session for a manager (employeeManager flag set)", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning(managerEmployee));
    const token = jwt.sign({ employeeId: managerEmployee.id, role: "manager" }, JWT_SECRET);

    const ctx = await createContext({ req: fakeReqRes({ employee_token: token }).req, res: fakeReqRes().res } as any);

    expect(ctx.user).not.toBeNull();
    expect(ctx.user?.role).toBe("admin");
    expect(ctx.employeeManager).toBe(true);
  });

  it("does not authenticate a non-manager employee via the /login cookie", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning({ ...managerEmployee, role: "agent" }));
    const token = jwt.sign({ employeeId: managerEmployee.id, role: "agent" }, JWT_SECRET);

    const ctx = await createContext({ req: fakeReqRes({ [COOKIE_NAME]: token }).req, res: fakeReqRes().res } as any);

    expect(ctx.user).toBeNull();
  });

  it("does not authenticate an inactive manager", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning({ ...managerEmployee, isActive: false }));
    const token = jwt.sign({ employeeId: managerEmployee.id, role: "manager" }, JWT_SECRET);

    const ctx = await createContext({ req: fakeReqRes({ [COOKIE_NAME]: token }).req, res: fakeReqRes().res } as any);

    expect(ctx.user).toBeNull();
  });

  it("leaves ctx.user null with no cookies at all", async () => {
    const ctx = await createContext({ req: fakeReqRes().req, res: fakeReqRes().res } as any);
    expect(ctx.user).toBeNull();
  });

  it("leaves ctx.user null with a malformed/invalid token", async () => {
    const ctx = await createContext({ req: fakeReqRes({ [COOKIE_NAME]: "not-a-real-jwt" }).req, res: fakeReqRes().res } as any);
    expect(ctx.user).toBeNull();
  });

  it("never puts passwordHash on ctx.user", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning(managerEmployee));
    const token = jwt.sign({ employeeId: managerEmployee.id, role: "manager" }, JWT_SECRET);

    const ctx = await createContext({ req: fakeReqRes({ [COOKIE_NAME]: token }).req, res: fakeReqRes().res } as any);

    expect(JSON.stringify(ctx.user)).not.toContain("passwordHash");
  });

  // Multi-tenancy: no fallback allowed. An admin-tier employee whose tenantId hasn't been
  // backfilled yet must be rejected outright — never silently treated as tenant #1 or any
  // other tenant.
  it("rejects an admin-tier employee with no resolvable tenantId (/login cookie) instead of defaulting to tenant #1", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning({ ...managerEmployee, tenantId: null }));
    const token = jwt.sign({ employeeId: managerEmployee.id, role: "manager" }, JWT_SECRET);

    await expect(
      createContext({ req: fakeReqRes({ [COOKIE_NAME]: token }).req, res: fakeReqRes().res } as any)
    ).rejects.toThrow(TRPCError);
  });

  it("rejects an admin-tier employee with no resolvable tenantId (employee_token cookie) instead of defaulting to tenant #1", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning({ ...managerEmployee, tenantId: null }));
    const token = jwt.sign({ employeeId: managerEmployee.id, role: "manager" }, JWT_SECRET);

    await expect(
      createContext({ req: fakeReqRes({ employee_token: token }).req, res: fakeReqRes().res } as any)
    ).rejects.toThrow(TRPCError);
  });

  it("a genuinely anonymous request (no cookies at all) gets tenantId: null, not a default tenant", async () => {
    const ctx = await createContext({ req: fakeReqRes().req, res: fakeReqRes().res } as any);
    expect(ctx.user).toBeNull();
    expect(ctx.tenantId).toBeNull();
  });

  it("a resolved admin-tier session carries the employee's actual tenantId, not a hardcoded constant", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning({ ...managerEmployee, tenantId: 42 }));
    const token = jwt.sign({ employeeId: managerEmployee.id, role: "manager" }, JWT_SECRET);

    const ctx = await createContext({ req: fakeReqRes({ [COOKIE_NAME]: token }).req, res: fakeReqRes().res } as any);

    expect(ctx.tenantId).toBe(42);
  });
});

describe("protectedProcedure protection", () => {
  it("rejects calls with no authenticated user (UNAUTHORIZED)", async () => {
    const caller = appRouter.createCaller({
      user: null,
      req: fakeReqRes().req,
      res: fakeReqRes().res,
    } as any);

    await expect(caller.seed.init()).rejects.toThrow(TRPCError);
  });

  it("allows calls once ctx.user is populated", async () => {
    mockGetDb.mockResolvedValue(mockDbReturning([]));
    const caller = appRouter.createCaller({
      user: {
        id: -managerEmployee.id,
        openId: `employee-manager-${managerEmployee.id}`,
        name: managerEmployee.name,
        email: managerEmployee.email,
        loginMethod: "employee",
        role: "admin",
        createdAt: managerEmployee.createdAt,
        updatedAt: managerEmployee.updatedAt,
        lastSignedIn: new Date(),
      },
      req: fakeReqRes().req,
      res: fakeReqRes().res,
    } as any);

    await expect(caller.auth.me()).resolves.not.toThrow();
  });
});
