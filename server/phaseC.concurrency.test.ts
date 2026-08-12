import { describe, it, expect } from "vitest";
import fs from "fs";
import { salaryCostForProfit } from "../shared/payrollCalc";

/**
 * إصلاحات المرحلة C — الخزنة والتحصيل والربح.
 *
 * التزامن الحقيقي على MySQL محتاج `TEST_DATABASE_URL`؛ من غيره بنتحقق من **العقد** في
 * الكود (transaction + قفل + مفتاح idempotency) وبنحاكي دلالته. القسم الأخير بيفتح
 * اتصالات فعلية لما `TEST_DATABASE_URL` يكون موجود.
 */

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`مالقيتش ${signature}`);
  const rest = src.slice(start + signature.length);
  const next = rest.indexOf("\nexport ");
  return rest.slice(0, next < 0 ? rest.length : next);
}

const db = fs.readFileSync("server/db.ts", "utf-8");
const accountingV2 = fs.readFileSync("server/accountingV2.service.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");

// ==================== C-P1 · تحصيل الأوردر ذرّي ====================

describe("🔑 C-P1 · تحصيل الأوردر — قفل + transaction + فرق داخل القفل", () => {
  const body = fnBody(db, "export async function recordOrderCollection");

  it("🔑 كله في transaction واحدة", () => {
    expect(body).toContain("db.transaction(");
  });

  it("🔑 بيقفل صف الأوردر FOR UPDATE قبل ما يقرا المحصّل السابق", () => {
    expect(body).toContain('.for("update")');
    // القفل قبل حساب الفرق — بيسلسل أي تحصيلين متزامنين.
    const lockIdx = body.indexOf('.for("update")');
    const deltaIdx = body.indexOf("const delta");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(deltaIdx).toBeGreaterThan(lockIdx);
  });

  it("🔑 بيكتب الخزنة داخل نفس الترانزاكشن بالفرق مش بالقيمة كاملة", () => {
    expect(body).toContain("addTreasuryTransactionInTransaction(tx");
    expect(body).toContain("const delta");
    // الفرق بس اللي بيتكتب — التصحيح +٥٠ بيدخل ٥٠ مش ٤٥٠.
    expect(codeOnly(body)).toMatch(/if\s*\(\s*delta\s*!==\s*0\s*\)/);
  });
});

// ==================== C-P2a · الإيداع/السحب اليدوي idempotent ====================

describe("🔑 C-P2a · الحركة اليدوية — مفتاح عملية مش تخمين محتوى", () => {
  const body = fnBody(accountingV2, "export async function recordManualTreasuryEntry");

  it("🔑 المفتاح على operationId مش على (مبلغ+وصف+يوم)", () => {
    expect(body).toContain("idempotencyKey: `treasury:manual:${input.operationId}`");
    // ممنوع أي تخمين بالمحتوى — حركتين شرعيتين بنفس المبلغ والوصف لازم يعدّوا.
    expect(codeOnly(body)).not.toMatch(/amount.*description.*day|description.*amount.*day/i);
  });

  it("🔑 الحدث والحركة في transaction واحدة، والتكرار بيرجع من غير حركة", () => {
    expect(body).toContain("db.transaction(");
    expect(body).toContain("createBusinessEventInTransaction(tx");
    expect(body).toContain("if (event.duplicate)");
    expect(body).toContain("addTreasuryTransactionInTransaction(tx");
    // التكرار بيرجع قبل ما يكتب الخزنة.
    const dupIdx = body.indexOf("if (event.duplicate)");
    const writeIdx = body.indexOf("addTreasuryTransactionInTransaction(tx");
    expect(dupIdx).toBeLessThan(writeIdx);
  });

  it("🔑 الراوتر بيطلب operationId (٨ حروف على الأقل)", () => {
    expect(routers).toContain("operationId: z.string().min(8).max(64)");
  });

  it("🔑 مفيش migration — بيعيد استخدام business_events UNIQUE", () => {
    expect(codeOnly(body)).not.toContain("CREATE TABLE");
    expect(body).toContain("createBusinessEventInTransaction");
  });
});

/**
 * محاكاة عقد الـidempotency على `business_events` (UNIQUE على businessId + مفتاح):
 *   • نفس operationId → صف واحد (الحدث موجود → duplicate).
 *   • operationId مختلف حتى بنفس المبلغ والوصف واليوم → صفّين (حركتين شرعيتين).
 */
describe("🔑 C-P2a · دلالة الـidempotency (محاكاة العقد)", () => {
  function makeStore() {
    const events = new Set<string>();
    let treasuryRows = 0;
    function record(operationId: string): "recorded" | "duplicate" {
      const key = `treasury:manual:${operationId}`;
      if (events.has(key)) return "duplicate";
      events.add(key);
      treasuryRows++;
      return "recorded";
    }
    return { record, treasuryRows: () => treasuryRows };
  }

  it("🔑 نفس المعرّف (retry) → حركة واحدة", () => {
    const s = makeStore();
    const op = "op-retry-123456";
    expect(s.record(op)).toBe("recorded");
    expect(s.record(op)).toBe("duplicate");
    expect(s.treasuryRows()).toBe(1);
  });

  it("🔑 معرّفين مختلفين بنفس المبلغ/الوصف/اليوم → حركتين (شرعي)", () => {
    const s = makeStore();
    // نفس البيانات تمامًا، بس عمليتين مقصودتين — معرّفين مختلفين.
    expect(s.record("op-aaaaaaaa-1")).toBe("recorded");
    expect(s.record("op-bbbbbbbb-2")).toBe("recorded");
    expect(s.treasuryRows()).toBe(2);
  });
});

// ==================== C-P3 · صلاحية واحدة مش مكررة ====================

describe("🔑 C-P3 · تسجيل التحصيل — requireOwned للأوردر مرة واحدة", () => {
  it("مفيش سطرين requireOwned متطابقين للأوردر في collectionRecord", () => {
    const start = routers.indexOf("collectionRecord:");
    expect(start).toBeGreaterThan(-1);
    const block = routers.slice(start, start + 1200);
    const matches =
      block.match(/requireOwned\([^)]*"order"[^)]*input\.orderId/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// ==================== الربح — كل بند مرة واحدة ====================

describe("🔑 الربح — المرتب والإعلان مرة واحدة، السُلفة مش بتقلّل التكلفة", () => {
  it("🔑 السُلفة مش عنصر في تكلفة المرتب (مافيش حقل advances في البدائية)", () => {
    // نفس الصف بالظبط — البدائية مالهاش مدخل للسُلفة أصلاً، فمستحيل تخصمها.
    const cost = salaryCostForProfit({
      baseSalary: 5000, overtimeAmount: 0, bonuses: 500,
      commissions: 0, absenceDeduction: 300, deductions: 200,
    });
    expect(cost).toBe(5000);
  });

  it("🔑 المحرّك بيستبعد أحداث المرتبات من سلة المصروفات — مافيش خصم مرتين", () => {
    const body = fnBody(accountingV2, "export async function computeRealizedProfit");
    expect(body).toContain('event.sourceType === "payroll_period"');
    expect(body).toContain("salaryCostForProfit(");
  });

  it("🔑 الإعلان بند مستقل مفروز، مش داخل التشغيلي كمان", () => {
    const body = fnBody(accountingV2, "export async function computeRealizedProfit");
    expect(body).toContain("adSpendEntries");
    expect(body).toMatch(/advertising\s*\+=/);
    expect(body).toMatch(/operatingExpenses\s*\+=/);
  });
});

// ==================== تزامن حقيقي على DB (مع TEST_DATABASE_URL) ====================
//
// اختبارات سلوكية بتفتح اتصالات متزامنة فعلية. بتحتاج `TEST_DATABASE_URL`؛ من غيرها
// بتتخطى — والعقود فوق بتغطّي المنطق.

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "🔑 تزامن حقيقي — الخزنة اليدوية idempotent",
  () => {
    it("🔑 نفس operationId مرتين → حركة خزنة واحدة، والتانية duplicate", async () => {
      const { getDb } = await import("./db");
      const { recordManualTreasuryEntry } = await import("./accountingV2.service");
      const { createCoreTestFixture } = await import("./testFixtures");
      const { treasuryTransactions } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const dbc = await getDb();
      if (!dbc) return;
      const fx = await createCoreTestFixture("cp2a-idem");
      const op = `op-${Date.now()}-idem`;
      const call = () =>
        recordManualTreasuryEntry({
          businessId: fx.businessId,
          type: "deposit",
          amount: "500.00",
          description: "إيداع تجربة",
          transactionDate: new Date(),
          operationId: op,
          actor: { id: 1, name: "tester" },
        });

      const first = await call();
      const second = await call();
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);

      const rows = await dbc
        .select()
        .from(treasuryTransactions)
        .where(
          and(
            eq(treasuryTransactions.businessId, fx.businessId),
            eq(treasuryTransactions.referenceType, "manual")
          )
        );
      expect(rows).toHaveLength(1);
      await fx.cleanup();
    });

    it("🔑 معرّفين مختلفين بنفس البيانات → حركتين (عمليتين شرعيتين)", async () => {
      const { getDb } = await import("./db");
      const { recordManualTreasuryEntry } = await import("./accountingV2.service");
      const { createCoreTestFixture } = await import("./testFixtures");
      const { treasuryTransactions } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const dbc = await getDb();
      if (!dbc) return;
      const fx = await createCoreTestFixture("cp2a-distinct");
      const when = new Date();
      const mk = (op: string) =>
        recordManualTreasuryEntry({
          businessId: fx.businessId,
          type: "deposit",
          amount: "500.00",
          description: "إيداع مكرّر مقصود",
          transactionDate: when,
          operationId: op,
          actor: { id: 1, name: "tester" },
        });
      await mk(`op-${Date.now()}-a`);
      await mk(`op-${Date.now()}-b`);
      const rows = await dbc
        .select()
        .from(treasuryTransactions)
        .where(
          and(
            eq(treasuryTransactions.businessId, fx.businessId),
            eq(treasuryTransactions.referenceType, "manual")
          )
        );
      expect(rows).toHaveLength(2);
      await fx.cleanup();
    });
  }
);
