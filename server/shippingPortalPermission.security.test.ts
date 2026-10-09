import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { getDb, createEmployee } from "./db";
import { employees, tenantRolePermissions } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { ALL_PERMISSIONS, hasTenantPermission, tenantPermissionsForRole } from "./permissions";
import { COOKIE_NAME } from "@shared/const";

/**
 * روابط الشحن في لوحة الموظف: الواجهة بتخفيها حسب `employeePortal.myPermissions` (هوية البوابة +
 * تجاوزات الشركة)، والسيرفر هو الحارس النهائي على employeePortal.todayShipments/shippingRoutes — والاتنين
 * على نفس المصدر. منح الصلاحية بيفتح فورًا، وسحبها بيقفل السيرفر في الطلب التالي. ولو فيه جلسة مالك على
 * الويب في نفس المتصفح، الصلاحيات بتفضل صلاحيات الموظف (مش المالك).
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");
const dash = fs.readFileSync("client/src/pages/EmployeeDashboard.tsx", "utf-8");

describe("🔒 روابط الشحن — حراس نصّية", () => {
  it("حارس البوابة لشاشات الشحن بتجاوزات الشركة", () => {
    const fn = routers.slice(routers.indexOf("function requireEmployeeTenantPermission("), routers.indexOf("function requireEmployeeTenantPermission(") + 600);
    expect(fn).toContain("hasTenantPermission(tenantId, emp.role, permission)");
    expect(fn).toContain("requireTenantId(emp)");
  });
  it("الواجهة بتخفي الرابطين لما الصلاحية مش موجودة، ومن غير ما تستنتج من الدور", () => {
    expect(dash).toContain("trpc.employeePortal.myPermissions.useQuery(");
    expect(dash).toContain('const canViewShipping = (portalPermissions ?? []).includes("shipping_ops.view");');
    expect(dash).not.toContain("usePermissions(");
    const gated = dash.slice(dash.indexOf("{canViewShipping && ("), dash.indexOf("{canViewShipping && (") + 2200);
    expect(gated).toContain('setLocation("/today-shipments")');
    expect(gated).toContain('setLocation("/shipping-schedule")');
    expect(dash.match(/setLocation\("\/today-shipments"\)/g)!.length).toBe(1);
    expect(dash).not.toMatch(/role\s*===\s*["']shipping["']/);
    expect(dash).toContain("utils.employeePortal.myPermissions.invalidate()");
    const portal = routers.slice(routers.indexOf("myPermissions: employeePortalProcedure"), routers.indexOf("myPermissions: employeePortalProcedure") + 200);
    expect(portal).toContain("tenantPermissionsForRole(requireTenantId(emp), emp.role)");
  });
});

const CAN_E2E = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN_E2E)("🔒 صلاحية الشحن — منح وسحب فوري، ومعزولة لكل Tenant (DB)", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = `sp${Date.now().toString(36)}`;
  const emp: Record<string, number> = {};
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
  const res = { cookie: () => {}, clearCookie: () => {} } as any;
  const portal = async (id: number) =>
    appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
  async function code(fn: () => Promise<any>): Promise<string> {
    try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; }
  }
  const can = async (id: number) => (await (await portal(id)).employeePortal.myPermissions()).includes("shipping_ops.view");
  const setOverride = async (tenantId: number, role: string, isAllowed: boolean | null) => {
    const d = (await getDb())!;
    await d.delete(tenantRolePermissions).where(and(eq(tenantRolePermissions.tenantId, tenantId), eq(tenantRolePermissions.role, role), eq(tenantRolePermissions.permission, "shipping_ops.view")));
    if (isAllowed != null) await d.insert(tenantRolePermissions).values({ tenantId, role, permission: "shipping_ops.view", isAllowed, updatedBy: 0 });
  };

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("ship-a");
    B = await createCoreTestFixture("ship-b");
    const mk = async (key: string, role: string, f: CoreTestFixture) => {
      emp[key] = insId(await createEmployee({ name: `${key}-${tag}`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${key}_${tag}`.slice(0, 50) } as any));
    };
    await mk("agentA", "agent", A);
    await mk("shipA", "shipping", A);
    await mk("agentB", "agent", B);
    await mk("ownerA", "super_admin", A);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    await d.delete(tenantRolePermissions).where(inArray(tenantRolePermissions.tenantId, [A.tenantId, B.tenantId]));
    const ids = Object.values(emp);
    if (ids.length) await d.delete(employees).where(inArray(employees.id, ids));
    await B?.cleanup(); await A?.cleanup();
  });

  it("موظف تأكيدات بلا الصلاحية: الرابط مخفي والسيرفر يرفض", async () => {
    expect(await can(emp.agentA)).toBe(false);
    const c = await portal(emp.agentA);
    expect(await code(() => c.employeePortal.todayShipments({}))).toBe("FORBIDDEN");
    expect(await code(() => c.employeePortal.shippingRoutes())).toBe("FORBIDDEN");
  });

  it("منح الصلاحية لدور agent في شركة A: يظهر ويُسمح فورًا — وشركة B لا تتأثر", async () => {
    await setOverride(A.tenantId, "agent", true);
    expect(await can(emp.agentA)).toBe(true);
    expect(await code(async () => (await portal(emp.agentA)).employeePortal.todayShipments({}))).toBe("ok");
    expect(await can(emp.agentB)).toBe(false);
    expect(await code(async () => (await portal(emp.agentB)).employeePortal.todayShipments({}))).toBe("FORBIDDEN");
  });

  it("سحب المنح: يختفي ويُمنع فورًا في الطلب التالي", async () => {
    await setOverride(A.tenantId, "agent", false);
    expect(await can(emp.agentA)).toBe(false);
    expect(await code(async () => (await portal(emp.agentA)).employeePortal.todayShipments({}))).toBe("FORBIDDEN");
  });

  it("جلسة مالك على الويب في نفس المتصفح: صلاحيات البوابة تفضل صلاحيات الموظف", async () => {
    const both = appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(emp.ownerA), employee_token: sign(emp.agentA) } }, res } as any));
    expect((await both.auth.myPermissions()).includes("shipping_ops.view")).toBe(true); // مصدر الويب = المالك
    expect((await both.employeePortal.myPermissions()).includes("shipping_ops.view")).toBe(false); // البوابة = الموظف
    expect(await code(() => both.employeePortal.todayShipments({}))).toBe("FORBIDDEN");
  });

  it("الاستعلام الواحد = نفس نتيجة hasTenantPermission لكل صلاحية (مع تجاوز ومن غيره)", async () => {
    await setOverride(A.tenantId, "agent", true);
    for (const role of ["agent", "shipping", "manager"]) {
      const bulk = await tenantPermissionsForRole(A.tenantId, role);
      const each = (await Promise.all(ALL_PERMISSIONS.map(async p => (await hasTenantPermission(A.tenantId, role, p)) ? p : null))).filter(Boolean);
      expect(bulk, role).toEqual(each);
    }
    await setOverride(A.tenantId, "agent", null);
  });

  it("دور الشحن بالافتراضي مسموح، وسحبه من الشركة يقفل البوابة", async () => {
    expect(await can(emp.shipA)).toBe(true);
    expect(await code(async () => (await portal(emp.shipA)).employeePortal.todayShipments({}))).toBe("ok");
    await setOverride(A.tenantId, "shipping", false);
    expect(await can(emp.shipA)).toBe(false);
    expect(await code(async () => (await portal(emp.shipA)).employeePortal.shippingRoutes())).toBe("FORBIDDEN");
    await setOverride(A.tenantId, "shipping", null);
  });
});
