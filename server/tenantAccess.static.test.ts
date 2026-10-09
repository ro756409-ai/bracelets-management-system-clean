import { describe, it, expect } from "vitest";
import fs from "fs";

/** حارس نصّي: نقطة دخول واحدة لكل طبقة، وترتيب التسجيل، واستثناء المنصة. */
const trpc = fs.readFileSync("server/_core/trpc.ts", "utf-8");
const index = fs.readFileSync("server/_core/index.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const access = fs.readFileSync("server/tenantAccess.ts", "utf-8");

describe("🔒 إنفاذ حالة الشركة — نقطة واحدة لكل طبقة", () => {
  it("tRPC: كل العائلات مبنية على publicProcedure المحروس؛ لا t.procedure خام غيره", () => {
    expect(trpc).toContain("export const publicProcedure = t.procedure.use(tenantAccessGuard);");
    const code = trpc.replace(/\/\/.*$/gm, "");
    expect(code.match(/t\.procedure\b/g)!.length).toBe(1);
    expect(trpc).toContain("export const protectedProcedure = publicProcedure.use(requireUser);");
    expect(trpc).toContain("export const authenticatedProcedure = publicProcedure.use(requireAuthenticatedIdentity);");
  });
  it("البوابة تُفحص بشركة الموظف (الكوكي)", () => {
    const portal = routers.slice(routers.indexOf("const employeePortalProcedure = publicProcedure.use("), routers.indexOf("const managerPortalProcedure"));
    expect(portal).toContain("await assertTrpcTenantAccess(emp.tenantId, type, path);");
  });
  it("Express: الحارس قبل كل المسارات، والمنصة/الدخول/الويبهوك مستثناة", () => {
    const guard = index.indexOf("app.use(tenantAccessExpressGuard(");
    expect(guard).toBeGreaterThan(-1);
    for (const reg of ["registerEvidenceUploadRoutes(app)", "registerImportRoutes(app)", "registerExportRoutes(app)", "registerBrandingRoutes(app)", "registerPlatformAdminRoutes(app)", '"/api/trpc"'])
      expect(guard, reg).toBeLessThan(index.indexOf(reg));
    for (const p of ["\\/api\\/platform\\/", "\\/api\\/auth\\/", "\\/api\\/employee\\/", "\\/api\\/webhooks\\/"]) expect(access, p).toContain(p);
  });
  it("العلم معطل = لا قراءة: كل دالة تبدأ بفحص العلم", () => {
    expect(access).toContain('process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED === "true"');
    expect(access).toMatch(/resolveTenantAccess\(tenantId: number, now = new Date\(\)\): Promise<TenantAccess> \{\n  if \(!tenantAccessEnforcementEnabled\(\)\) return FULL;/);
    expect(trpc).toContain("if (!tenantAccessEnforcementEnabled() || ctx.tenantId == null) return next();");
  });
  it("لا تغيير لحالة الشركة في كود الإنفاذ", () => {
    for (const f of ["server/tenantAccess.ts", "server/tenantAccessDrain.ts", "shared/tenantAccess.ts"])
      expect(fs.readFileSync(f, "utf-8"), f).not.toMatch(/update\(tenants\)|UPDATE tenants/);
  });
});
