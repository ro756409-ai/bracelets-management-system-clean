import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس أمان استيراد Excel (Phase D — D1).
 *
 * الاستيراد كان بيثق في `businessId` من العميل (وافتراضيًا 1)، وبيحمّل أوردرات كل الشركات
 * للـdedup، وبيكتب صف صف بلا transaction. الاختبارات دي بتقفل على الإصلاح:
 * عزل tenant، dedup مقيّد، والكل-أو-لا-شيء. حارس نصّي لأن المسار Express مش tRPC.
 */
const src = fs.readFileSync("server/importExcel.ts", "utf-8");
const auth = fs.readFileSync("server/authMiddleware.ts", "utf-8");

function executeRoute(): string {
  const i = src.indexOf('"/api/import/execute"');
  expect(i).toBeGreaterThan(-1);
  // لحد نهاية المسار — أول تسجيل مسار تاني أو نهاية registerImportRoutes.
  const rest = src.slice(i);
  const end = rest.indexOf('app.post(\n    "/api/import/whatsapp');
  return rest.slice(0, end < 0 ? 6000 : end);
}

describe("🔑 D1 · استيراد Excel — عزل الـtenant", () => {
  const route = executeRoute();

  it("🔑 مفيش default صامت businessId = 1", () => {
    expect(route).not.toMatch(/businessId\s*=\s*req\.body[^\n]*:\s*1\b/);
    expect(src).not.toContain("? parseInt(req.body.businessId) : 1");
  });

  it("🔑 بياخد الهوية من req.authInfo مش من العميل", () => {
    expect(route).toContain("(req as RequestWithAuth).authInfo");
    expect(route).toContain("auth.tenantId == null");
  });

  it("🔑 بيتحقق إن النشاط تابع للـtenant عبر getBusinessIdsForTenant + includes", () => {
    expect(route).toContain("getBusinessIdsForTenant(auth.tenantId)");
    expect(route).toContain("allowed.includes(requestedBusinessId)");
    // النطاق الفاضي (allowed = []) → includes = false → مرفوض.
  });

  it("🔑 بيرفض بوضوح لو النشاط مش محدّد أو مش مسموح", () => {
    expect(route).toContain("لازم تحدد النشاط");
    expect(route).toContain("مش تابع لحسابك");
  });
});

describe("🔑 D1 · dedup مقيّد بالنشاط ومحدود الحجم", () => {
  const route = executeRoute();

  it("🔑 مافيش getOrders({ limit: 100000 }) — مش تحميل كل الشركات", () => {
    expect(src).not.toContain("getOrders({ limit: 100000 })");
  });

  it("🔑 بيستخدم getImportDedupOrders المقيّد بالنشاط", () => {
    expect(route).toContain("db.getImportDedupOrders(");
    expect(route).toContain("businessId");
  });
});

describe("🔑 D1 · الاستيراد الكل-أو-لا-شيء", () => {
  const route = executeRoute();

  it("🔑 التصنيف بلا كتابة ثم importOrdersAtomic", () => {
    expect(route).toContain("db.importOrdersAtomic(");
    // على الفشل: imported = 0 وتقرير واضح، مفيش نصف استيراد.
    expect(route).toContain("allOrNothing: true");
  });
});

describe("🔑 D1 · requireAdminOrManager بيعلّق الهوية", () => {
  it("🔑 بيعلّق authInfo فيه tenantId على req بعد التحقّق", () => {
    expect(auth).toContain("authInfo");
    expect(auth).toContain("tenantId");
    expect(auth).toContain("attachAuth(req");
  });
});
