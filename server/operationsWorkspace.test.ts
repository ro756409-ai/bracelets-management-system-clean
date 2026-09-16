import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import type { TrpcContext } from "./_core/context";
import { hasPermission, isFinancialPermission } from "./permissions";

/**
 * Stage D — Operations workspace: قراءات شحنات اليوم + جدول الشحن لجلسة الداشبورد.
 *
 * بتنادي الراوتر الحقيقي (`appRouter.createCaller`) وبتلقط النطاق اللي بيوصل للـservice:
 *   • المالك/المدير يوصلوا `operations.*` من غير كوكي employee_token (ده كان سبب الطرد).
 *   • الصلاحية shipping_ops.view — أدوار التأكيدات/المحاسب مرفوضة قبل أي قراءة.
 *   • النطاق من scopeBusinessIds، وعمره ما بيوصل للـservice فاضي (فاضي = من غير فلتر).
 *   • بوابة الموظفين بحارسها القديم ومفوّضة لنفس الـservice (مصدر منطق واحد).
 */

const calls = vi.hoisted(() => ({
  today: [] as { businessIds: number[]; date?: string }[],
  routes: [] as number[][],
}));

vi.mock("./shippingOperations.service", () => ({
  buildTodayShipments: vi.fn(async (businessIds: number[], date?: string) => {
    calls.today.push({ businessIds, date });
    return { date: date ?? "2026-09-13", dayName: "الأحد", dayOfWeek: 0, agents: [], totalOrders: 0 };
  }),
  loadShippingRouteRows: vi.fn(async (businessIds: number[]) => {
    calls.routes.push(businessIds);
    return [];
  }),
}));

const { appRouter } = await import("./routers");

function employeeRow(role: string, id = 5) {
  return {
    id, name: `موظف ${role}`, role, tenantId: 1, businessId: 7, isActive: true,
    email: null, username: `emp-${id}`, userId: null, createdAt: new Date(), updatedAt: new Date(),
  } as any;
}

const baseReqRes = () => ({
  req: { protocol: "https", headers: {}, cookies: {} } as TrpcContext["req"],
  res: { clearCookie: () => {} } as TrpcContext["res"],
});

/** جلسة /login — synthetic admin، ومفيش كوكي employee_token. */
function dashboardContext(role: "super_admin" | "manager"): TrpcContext {
  return {
    ...baseReqRes(),
    user: { id: -1, openId: "employee-manager-1", name: "المالك", loginMethod: "employee", role: "admin" } as any,
    employee: employeeRow(role, 1),
    tenantId: 1,
  } as TrpcContext;
}

function employeeContext(role: string): TrpcContext {
  return { ...baseReqRes(), user: null, employee: employeeRow(role), tenantId: 1 } as TrpcContext;
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (error: any) {
    return error?.code ?? String(error?.message ?? error);
  }
}

beforeEach(() => {
  calls.today.length = 0;
  calls.routes.length = 0;
});

describe("🔑 جلسة الداشبورد توصل شاشات الشحن (مش بتتطرد)", () => {
  it("🔑 السبب القديم: بوابة الموظفين بترفض جلسة /login (مفيش employee_token)", async () => {
    const caller = appRouter.createCaller(dashboardContext("super_admin"));
    expect(await code(() => caller.employeePortal.todayShipments({}))).toBe("UNAUTHORIZED");
    expect(await code(() => caller.employeePortal.shippingRoutes())).toBe("UNAUTHORIZED");
  });

  it("🔑 المالك والمدير يوصلوا operations.* بنفس الجلسة", async () => {
    for (const role of ["super_admin", "manager"] as const) {
      const caller = appRouter.createCaller(dashboardContext(role));
      expect(await code(() => caller.operations.todayShipments({})), role).toBe("OK");
      expect(await code(() => caller.operations.shippingRoutes()), role).toBe("OK");
    }
  });

  it("shipping_ops.view تشغيلية مش مالية — المدير مايتحجبش عنها", () => {
    expect(isFinancialPermission("shipping_ops.view")).toBe(false);
    expect(hasPermission("manager", "shipping_ops.view")).toBe(true);
  });
});

describe("🔑 الصلاحية على السيرفر — مش مجرد إخفاء", () => {
  it("🔑 أدوار من غير shipping_ops.view مرفوضة قبل ما الـservice يتنادى", async () => {
    for (const role of ["order_confirmation", "agent", "accountant", "data_entry", "viewer"]) {
      const caller = appRouter.createCaller(employeeContext(role));
      expect(await code(() => caller.operations.todayShipments({})), role).toBe("FORBIDDEN");
      expect(await code(() => caller.operations.shippingRoutes()), role).toBe("FORBIDDEN");
    }
    expect(calls.today).toHaveLength(0);
    expect(calls.routes).toHaveLength(0);
  });

  it("موظف الشحن (نفس الصلاحية) مسموح", async () => {
    const caller = appRouter.createCaller(employeeContext("shipping"));
    expect(await code(() => caller.operations.todayShipments({}))).toBe("OK");
  });

  it("🔑 التاريخ لازم YYYY-MM-DD (مش أي نص يوقّع new Date)", async () => {
    const caller = appRouter.createCaller(dashboardContext("super_admin"));
    expect(await code(() => caller.operations.todayShipments({ date: "13/09/2026" }))).toBe("BAD_REQUEST");
    expect(await code(() => caller.operations.todayShipments({ date: "2026-09-13" }))).toBe("OK");
    expect(calls.today.at(-1)?.date).toBe("2026-09-13");
  });
});

describe("🔑 multi-business — النطاق عمره ما بيوصل فاضي", () => {
  it("🔑 نشاط محدد بدون DB يتحقق منه → fail-closed [NO_BUSINESS] (مش ثقة عمياء في id العميل)", async () => {
    // Phase 0.5: النطاق بقى fail-closed بالكامل. من غير DB، sessionBusinessIds مايقدرش يتأكد
    // إن نشاط 7 تابع للتينانت فبيرجّع null → scopeBusinessIds يرفض [-1] بدل ما يمرّر [7] بثقة
    // العميل. (تمرير نشاط صحيح فعليًا متحقّق في اختبارات cross-tenant على DB.)
    const caller = appRouter.createCaller(dashboardContext("super_admin"));
    await caller.operations.todayShipments({ businessIds: [7] });
    await caller.operations.shippingRoutes({ businessIds: [7] });
    expect(calls.today.at(-1)?.businessIds).toEqual([-1]);
    expect(calls.routes.at(-1)).toEqual([-1]);
  });

  it("🔑 نطاق مش متحدد → NO_BUSINESS (مش [] اللي معناها كل الأوردرات في getOrders)", async () => {
    // من غير DB، sessionBusinessIds مش قادر يتحقق فبيرجع null؛ من غير طلب نشاط = undefined.
    const caller = appRouter.createCaller(dashboardContext("super_admin"));
    await caller.operations.todayShipments({});
    await caller.operations.shippingRoutes();
    expect(calls.today.at(-1)?.businessIds).toEqual([-1]);
    expect(calls.routes.at(-1)).toEqual([-1]);
  });
});

describe("🔑 مصدر منطق واحد — البوابة ماتغيرتش", () => {
  const routers = fs.readFileSync("server/routers.ts", "utf-8");
  const compact = routers.replace(/\s+/g, " ");
  const ops = routers.slice(routers.indexOf("  operations: router({"), routers.indexOf("  employeePortal: router({"));

  it("🔑 operations.* = permissionProcedure(shipping_ops.view) + scopeBusinessIds + NO_BUSINESS", () => {
    expect(ops).toContain('todayShipments: permissionProcedure("shipping_ops.view")');
    expect(ops).toContain('shippingRoutes: permissionProcedure("shipping_ops.view")');
    expect(ops.match(/scopeBusinessIds\(ctx, input\)/g)).toHaveLength(2);
    expect(ops.match(/NO_BUSINESS/g)?.length).toBeGreaterThanOrEqual(2);
    // قراءة بس — مفيش mutation في الراوتر ده.
    expect(ops).not.toContain(".mutation(");
  });

  it("🔑 البوابة بحارسها القديم ونطاقها fail-closed، ومفوّضة للـservice", () => {
    expect(compact).toContain('todayShipments: requireEmployeePermission("shipping_ops.view")');
    expect(compact).toContain('shippingRoutes: requireEmployeePermission("shipping_ops.view")');
    const portal = routers.slice(routers.indexOf("// ==================== SHIPMENTS TODAY"), routers.indexOf("// مسح QR للموظف"));
    // security: النطاق بقى fail-closed — scopeBusinessIds (denyWhenEmpty) + [NO_BUSINESS]،
    // مش الأنماط القديمة اللي فاضيها كان بيتحوّل لكل الأوردرات.
    expect((portal.match(/\(await scopeBusinessIds\(empScope\(ctx\), \{\}\)\) \?\? \[NO_BUSINESS\]/g) ?? []).length).toBe(2);
    expect(portal).not.toContain("sessionBusinessIds(ctx)) ?? []");
    expect(portal).not.toContain("?? [];");
    expect(portal).toContain("buildTodayShipments(businessIds, input.date)");
    expect(portal).toContain("loadShippingRouteRows(businessIds)");
    // المنطق مابقاش متكرر جوه routers.ts.
    expect(routers).not.toContain("groupOrdersByAgent(allConfirmed");
  });

  it("الـservice مابيقررش نطاق (بياخد businessIds جاهزة)", () => {
    const service = fs.readFileSync("server/shippingOperations.service.ts", "utf-8");
    // الفحص على النداء/الـimport مش على النص — تعليق الملف بيشرح مين بيحسب النطاق.
    expect(service).not.toContain("sessionBusinessIds(");
    expect(service).not.toContain("scopeBusinessIds(");
    expect(service).not.toContain('from "./routers"');
    expect(service).not.toMatch(/\bctx\b/);
  });
});
