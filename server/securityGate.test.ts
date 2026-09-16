import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { eq } from "drizzle-orm";
import {
  getDb,
  getBusinessIdsForTenant,
  findEvidenceOwnerBusinessIds,
  createOrder,
} from "./db";
import { getWebhookLog } from "./easyorderWebhook";
import { webhookLogs, expenses, orders, orderItems } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * Phase 0.5 — Security Gate. قفل ثغرات العزل الحرجة قبل أي عميل جديد:
 *   1) Bosta AWB IDOR            — عزل tenant server-side + 403 لأي id خارج النطاق.
 *   2) easyorder webhook-log     — مسار REST غير المحمي اتشال؛ tRPC مقيّد بالنطاق؛ ستمب businessId.
 *   3) REST export/authMiddleware — رفض tenantId=null؛ scopeToAllowed fail-closed.
 *   4) Evidence download IDOR    — resolveScope + بادئة tenant + reverse-lookup (fail-closed).
 *   5) fail-open في scope        — تعذّر تحديد النطاق = رفض/صفر، مش ثقة في العميل.
 *
 * القسم الأول حراس نصّية على الكود؛ القسم الثاني سلوكي فعلي cross-tenant على TEST_DATABASE_URL.
 */

const bosta = fs.readFileSync("server/bosta.service.ts", "utf-8");
const webhook = fs.readFileSync("server/easyorderWebhook.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const authMw = fs.readFileSync("server/authMiddleware.ts", "utf-8");
const evidence = fs.readFileSync("server/evidenceUpload.ts", "utf-8");
const exportExcel = fs.readFileSync("server/exportExcel.ts", "utf-8");

describe("🔑 1) Bosta AWB — عزل tenant server-side (source guards)", () => {
  const single = bosta.slice(bosta.indexOf("async function handleSingleAwb"), bosta.indexOf("async function handleBulkAwb"));
  const bulk = bosta.slice(bosta.indexOf("async function handleBulkAwb"), bosta.indexOf("export function registerBostaAwbRoutes"));
  it("🔑 المصدر: النطاق المسموح من authInfo (مش العميل)", () => {
    expect(bosta).toContain("allowedBusinessIdsForReq");
    expect(bosta).toContain("getBusinessIdsForTenant(auth.tenantId)");
    expect(bosta).toContain('type RequestWithAuth } from "./authMiddleware"');
  });
  it("🔑 فردي: يرفض أوردر خارج نطاق المستخدم (IDOR)", () => {
    expect(single).toContain("allowedBusinessIdsForReq(req)");
    expect(single).toContain("!allowed.includes(order.businessId)");
    expect(single).toContain("status(403)");
  });
  it("🔑 جماعي: رفض كامل لو أي id غير مملوك", () => {
    expect(bulk).toContain("allowedBusinessIdsForReq(req)");
    expect(bulk).toContain("owned.length !== ids.length");
    expect(bulk).toContain("status(403)");
    // مش بيبني shipmentIds من كل الصفوف — بس المملوكة.
    expect(bulk).toContain("owned\n      .map");
  });
});

describe("🔑 2) webhook-log — لا مسار REST مكشوف + tRPC مقيّد بالنطاق", () => {
  it("🔑 مسار REST القديم /webhooks/easyorder/log اتشال", () => {
    expect(webhook).not.toContain('app.get("/api/webhooks/easyorder/log"');
  });
  it("🔑 getWebhookLog بياخد businessIds إلزامية ويفلتر بيها", () => {
    expect(webhook).toContain("export async function getWebhookLog(businessIds: number[]");
    expect(webhook).toContain("inArray(webhookLogs.businessId, scope)");
  });
  it("🔑 السجلات تُختم بنشاط القناة (logWebhook)", () => {
    expect(webhook).toContain("businessId: channel?.businessId");
    expect(webhook).toContain("logWebhook(");
  });
  it("🔑 tRPC webhook.log/stats مقيّدة بالنطاق (fail-closed)", () => {
    const block = routers.slice(routers.indexOf("webhook: router({"), routers.indexOf("// ==================== REPORTS"));
    expect((block.match(/scopeBusinessIds\(ctx, \{\}\)\) \?\? \[NO_BUSINESS\]/g) ?? []).length).toBe(2);
    expect(block).not.toContain("getWebhookLog();");
  });
});

describe("🔑 3) REST export / authMiddleware — رفض tenant فاضي + fail-closed", () => {
  it("🔑 requireAdminOrManager يرفض tenantId=null", () => {
    expect(authMw).toContain("rejectUnresolvedTenant");
    expect(authMw).toContain("owner.tenantId == null");
    expect(authMw).toContain("emp.tenantId == null");
  });
  it("🔑 scopeToAllowed(null) → fail-closed (مش الكل)", () => {
    expect(exportExcel).toContain("if (allowed == null) return [NO_BUSINESS]");
    // ما بقاش فيه رجوع النطاق المطلوب كما هو عند null.
    expect(exportExcel).not.toContain("if (allowed == null) return requested;");
  });
});

describe("🔑 4) Evidence — عزل tenant عند التنزيل + بادئة الاسم", () => {
  it("🔑 التنزيل يمرّ عبر resolveScope (مش مجرد authenticated)", () => {
    const route = evidence.slice(evidence.indexOf('app.get("/api/evidence/files'), evidence.length);
    expect(route).toContain("resolveScope(req)");
    expect(route).toContain("Number(prefixMatch[1]) !== scope.tenantId");
    expect(route).toContain("findEvidenceOwnerBusinessIds(filename)");
  });
  it("🔑 الرفع يضمّن tenant في اسم الملف", () => {
    expect(evidence).toContain("`t${scope.tenantId}-${randomUUID()}${extension}`");
  });
  it("🔑 regex الاسم يقبل بادئة tenant اختيارية", () => {
    expect(evidence).toContain("/^(t\\d+-)?[a-f0-9-]+\\.(pdf|jpg|png|webp)$/");
  });
});

describe("🔑 5) fail-open في scope اتقفل (routers)", () => {
  it("🔑 scopeBusinessIds: allowed==null → [NO_BUSINESS] (مش ids العميل)", () => {
    const fn = routers.slice(routers.indexOf("async function scopeBusinessIds"), routers.indexOf("async function scopeBusinessId("));
    expect(fn).toContain("if (allowed == null) return [NO_BUSINESS];");
    expect(fn).not.toContain("if (allowed == null) return requestedIds;");
  });
  it("🔑 scopeBusinessId: allowed==null → يرفض (مش يمرّر id)", () => {
    const fn = routers.slice(routers.indexOf("async function scopeBusinessId("), routers.indexOf("async function scopeBusinessId(") + 900);
    expect(fn).toContain('message: "تعذّر تحديد نطاق النشاط"');
    expect(fn).not.toContain("if (allowed == null) return businessId;");
  });
});

// ── سلوكي فعلي cross-tenant (بيشتغل مع TEST_DATABASE_URL؛ بيتخطّى بدونه) ──
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "🔑 cross-tenant فعلي — Phase 0.5",
  () => {
    let a: CoreTestFixture;
    let b: CoreTestFixture;
    const fileB = `sec05-${Date.now()}.pdf`; // اسم ملف إثبات legacy (بلا بادئة) لتينانت B
    let bOrderId: number;
    let logAId = 0;
    let logBId = 0;
    let expBId = 0;

    beforeAll(async () => {
      const db = await getDb();
      if (!db) return;
      a = await createCoreTestFixture("gate-a");
      b = await createCoreTestFixture("gate-b");

      // سجل ويبهوك لكل تينانت
      logAId = Number(
        (await db.insert(webhookLogs).values({ businessId: a.businessId, eventType: "order", status: "success", message: "A" }) as any).insertId ?? 0
      );
      logBId = Number(
        (await db.insert(webhookLogs).values({ businessId: b.businessId, eventType: "order", status: "success", message: "B" }) as any).insertId ?? 0
      );

      // مصروف في تينانت B بمرفق إثبات legacy (بلا بادئة tenant في الاسم)
      expBId = Number(
        (await db.insert(expenses).values({
          businessId: b.businessId,
          amount: "10",
          description: "gate B",
          expenseDate: new Date(),
          createdBy: 1,
          createdByName: "tester",
          attachmentUrl: `/api/evidence/files/${fileB}`,
        }) as any).insertId ?? 0
      );

      // أوردر مؤكّد في تينانت B (لاختبار IDOR على AWB/export)
      bOrderId = (await createOrder({
        businessId: b.businessId,
        orderNumber: `GATE${Date.now() % 100000000}`,
        customerName: "عميل B",
        customerPhone: "01000000088",
        governorate: "القاهرة",
        customerAddress: "عنوان B",
        productId: b.productId,
        productName: "صنف B",
        quantity: 1,
        totalAmount: "100",
        source: "manual",
      } as any)) as number;
      await db.update(orders).set({ status: "confirmed" }).where(eq(orders.id, bOrderId));
    });

    afterAll(async () => {
      const db = await getDb();
      if (!db) return;
      if (logAId) await db.delete(webhookLogs).where(eq(webhookLogs.id, logAId));
      if (logBId) await db.delete(webhookLogs).where(eq(webhookLogs.id, logBId));
      if (expBId) await db.delete(expenses).where(eq(expenses.id, expBId));
      if (bOrderId) {
        await db.delete(orderItems).where(eq(orderItems.orderId, bOrderId));
        await db.delete(orders).where(eq(orders.id, bOrderId));
      }
      await b?.cleanup();
      await a?.cleanup();
    });

    it("🔑 webhook log: نطاق A مايرجّعش سجل B", async () => {
      const rowsA = await getWebhookLog([a.businessId], 1000);
      expect(rowsA.some(r => r.id === logBId)).toBe(false);
      expect(rowsA.some(r => r.id === logAId)).toBe(true);
    });
    it("🔑 webhook log: نطاق فاضي [-1] → صفر سجلات (fail-closed)", async () => {
      const none = await getWebhookLog([-1], 1000);
      expect(none.some(r => r.id === logAId || r.id === logBId)).toBe(false);
    });

    it("🔑 evidence: reverse-lookup بيرجّع نشاط B المالك لملف B", async () => {
      const owners = await findEvidenceOwnerBusinessIds(fileB);
      expect(owners).toContain(b.businessId);
      expect(owners).not.toContain(a.businessId);
    });
    it("🔑 evidence: نطاق A ما يملكش ملف B (يُرفض التنزيل)", async () => {
      const owners = await findEvidenceOwnerBusinessIds(fileB);
      const allowedA = (await getBusinessIdsForTenant(a.tenantId)) ?? [];
      expect(owners.some(o => allowedA.includes(o))).toBe(false);
    });
    it("🔑 evidence: اسم غير موجود → لا مالك ([] = رفض)", async () => {
      expect(await findEvidenceOwnerBusinessIds("nonexistent-xyz.pdf")).toEqual([]);
    });

    it("🔑 Bosta/export IDOR: نطاق A مايشملش نشاط أوردر B", async () => {
      const db = await getDb();
      const [order] = await db!.select().from(orders).where(eq(orders.id, bOrderId)).limit(1);
      const allowedA = (await getBusinessIdsForTenant(a.tenantId)) ?? [];
      // نفس القرار اللي بتاخده handlers الـAWB/export: الأوردر لازم يكون ضمن أنشطة المستخدم.
      expect(allowedA.includes(order.businessId!)).toBe(false);
    });
  }
);
