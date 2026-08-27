import { describe, it, expect, vi } from "vitest";
import fs from "fs";

/**
 * P0 — تقييد الموظف بالنشاط.
 *
 * الـtenant عنده نشاطين: A=1، B=2. الاختبار بيشغّل مسار `requireScopedBusinessId`
 * الحقيقي عبر endpoint (stocktakeList) بجلسات مختلفة، ويتأكد:
 *   • موظف نشاط A (accountant, businessId=1) ممنوع من B، مسموح له A.
 *   • المالك (admin) والمدير (admin-tier) مسموح لهم A و B.
 *   • موظف بلا نشاط (businessId=null) ممنوع من الكل.
 * الـswitcher والجرد بيتقيّدوا تلقائيًا لأنهم بيمرّوا من نفس الطبقة.
 */

// نشاطا الـtenant. mock عشان مانحتاجش DB حقيقي.
vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getBusinessIdsForTenant: vi.fn(async () => [1, 2]) };
});

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const req = { protocol: "https", headers: {} } as TrpcContext["req"];
const res = { clearCookie: () => {} } as TrpcContext["res"];

const ownerCtx = (): any => ({ user: { id: 1, role: "admin" }, employee: null, tenantId: 1, req, res });
const managerCtx = (): any => ({ user: { id: 3, role: "admin" }, employee: { id: 3, role: "manager", businessId: 1 }, tenantId: 1, req, res });
const employeeCtx = (businessId: number | null): any => ({
  user: null,
  employee: { id: 9, role: "accountant", businessId },
  tenantId: 1, req, res,
});

/** بيرجّع "forbidden" لو الوصول للنشاط اترفض، غير كده "ok" (بغضّ النظر عن الداتا). */
async function accessBusiness(ctx: any, businessId: number): Promise<"ok" | "forbidden"> {
  try {
    await appRouter.createCaller(ctx).accountingV2.stocktakeList({ businessId });
    return "ok";
  } catch (e: any) {
    if (e?.code === "FORBIDDEN") return "forbidden";
    throw e;
  }
}

describe("🔑 P0: تقييد الموظف بالنشاط (المسار الحقيقي)", () => {
  it("🔑 موظف نشاط A ممنوع من B، ومسموح له A", async () => {
    expect(await accessBusiness(employeeCtx(1), 2)).toBe("forbidden");
    expect(await accessBusiness(employeeCtx(1), 1)).toBe("ok");
  });

  it("🔑 المالك (admin) مسموح له A و B", async () => {
    expect(await accessBusiness(ownerCtx(), 1)).toBe("ok");
    expect(await accessBusiness(ownerCtx(), 2)).toBe("ok");
  });

  it("🔑 المدير (admin-tier) مسموح له A و B", async () => {
    expect(await accessBusiness(managerCtx(), 1)).toBe("ok");
    expect(await accessBusiness(managerCtx(), 2)).toBe("ok");
  });

  it("🔑 موظف بلا نشاط (businessId=null) ممنوع من الكل", async () => {
    expect(await accessBusiness(employeeCtx(null), 1)).toBe("forbidden");
    expect(await accessBusiness(employeeCtx(null), 2)).toBe("forbidden");
  });

  it("🔑 موظف نشاط B ممنوع من A (عكس الاتجاه)", async () => {
    expect(await accessBusiness(employeeCtx(2), 1)).toBe("forbidden");
    expect(await accessBusiness(employeeCtx(2), 2)).toBe("ok");
  });
});

// ───────────────── العزل مركزي (source guards) ─────────────────

describe("🔑 العزل من نقطة واحدة", () => {
  const routers = fs.readFileSync("server/routers.ts", "utf-8");

  it("🔑 sessionBusinessIds هي المصدر: admin=كل الأنشطة، موظف=نشاطه، null=deny", () => {
    const fn = routers.slice(
      routers.indexOf("async function sessionBusinessIds"),
      routers.indexOf("async function scopeBusinessIds")
    );
    expect(fn).toContain('ctx.user?.role === "admin"'); // مالك/مدير → all
    expect(fn).toContain("ctx.employee?.businessId ?? null"); // الموظف → نشاطه
    expect(fn).toContain("if (bid == null) return []"); // بلا نشاط → deny
    expect(fn).toContain("all.includes(bid) ? [bid] : []"); // لازم تابع للـtenant
  });

  it("🔑 getBusinessIdsForTenant بقى بس جوه sessionBusinessIds (نقطة واحدة)", () => {
    const outside = routers
      .split("getBusinessIdsForTenant(")
      .length - 1;
    // مرة في الاستيراد/الاستدعاء الوحيد جوه sessionBusinessIds (+ ممكن التعليق) — مش منتشر.
    expect(outside).toBeLessThanOrEqual(2);
  });

  it("🔑 الـswitcher (activeList/groups/groupsWithBusinesses) بيمرّ بـsessionBusinessIds", () => {
    const block = routers.slice(routers.indexOf("activeList: authenticatedProcedure"), routers.indexOf("businessIdsByGroup"));
    expect(block).toContain("sessionBusinessIds(ctx)");
    expect(block).not.toContain("getBusinessIdsForTenant(ctx.tenantId)");
  });

  it("🔑 الجرد بيتقيّد تلقائيًا (بيمرّر ctx لـrequireScopedBusinessId)", () => {
    const block = routers.slice(routers.indexOf("stocktakeCreate:"), routers.indexOf("returnInspectionSubmit:"));
    expect((block.match(/requireScopedBusinessId\(ctx,/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
