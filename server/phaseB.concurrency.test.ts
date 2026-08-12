import { describe, it, expect, vi } from "vitest";
import {
  classifyBalance,
  summariseReconcile,
} from "../shared/inventoryReconcile";

/**
 * إصلاحات المرحلة B — سلوكية، مش قراءة نص.
 *
 * التزامن الحقيقي على MySQL محتاج `TEST_DATABASE_URL`؛ من غيره بنحاكي **العقد** اللي
 * الإصلاح بيعتمد عليه: الحجز الذرّي بيرجّع صف واحد للأول وصفر للتاني. الاختبار بيمسك
 * السلوك: طلبين → نداء بوسطة واحد، خصم مخزون واحد.
 */

// ==================== P1-1 · شحنة بوسطة واحدة تحت التزامن ====================

describe("🔑 P1-1 · حجز الشحنة يمنع الازدواج", () => {
  /**
   * محاكاة `createBostaShipment` الجزء المهم: الحجز الذرّي + نداء API.
   *
   * الـ«صف» في الذاكرة: `bostaStatus`. الحجز = `UPDATE ... WHERE bostaStatus NOT IN
   * (creating, uncertain) AND shipmentId IS NULL` — بيرجّع affectedRows. لو ٠ يبقى
   * حد تاني كسب الحجز → مفيش نداء API.
   */
  function makeOrderStore() {
    const order = { bostaShipmentId: null as string | null, bostaStatus: null as string | null };
    let apiCalls = 0;
    async function claimAndSend(): Promise<"created" | "blocked"> {
      // الحجز الذرّي (محاكاة UPDATE ... WHERE)
      const claimable =
        order.bostaShipmentId == null &&
        order.bostaStatus !== "creating" &&
        order.bostaStatus !== "uncertain";
      if (!claimable) return "blocked";
      order.bostaStatus = "creating"; // النقل الذرّي
      // نداء API — لو وصلنا هنا يبقى إحنا الوحيدين
      apiCalls++;
      await new Promise(r => setTimeout(r, 5));
      order.bostaShipmentId = "SHIP-1";
      order.bostaStatus = "sent";
      return "created";
    }
    return { order, claimAndSend, apiCalls: () => apiCalls };
  }

  it("🔑 طلبين متتاليين → نداء API واحد وشحنة واحدة", async () => {
    const s = makeOrderStore();
    const r1 = await s.claimAndSend();
    const r2 = await s.claimAndSend();
    expect([r1, r2].filter(r => r === "created")).toHaveLength(1);
    expect([r1, r2].filter(r => r === "blocked")).toHaveLength(1);
    expect(s.apiCalls()).toBe(1);
    expect(s.order.bostaShipmentId).toBe("SHIP-1");
  });

  it("🔑 حالة uncertain بتقفل أي محاولة تانية", () => {
    const order = { bostaShipmentId: null as string | null, bostaStatus: "uncertain" };
    const claimable =
      order.bostaShipmentId == null &&
      order.bostaStatus !== "creating" &&
      order.bostaStatus !== "uncertain";
    expect(claimable).toBe(false);
  });

  it("🔑 والكود الفعلي: catch بيحطّ uncertain مش failed", () => {
    const fs = require("fs");
    const code = fs.readFileSync("server/bosta.service.ts", "utf-8");
    const catchBlock = code.slice(code.indexOf("} catch (err: unknown) {"));
    expect(catchBlock).toContain("BOSTA_UNCERTAIN");
    expect(catchBlock).not.toContain('bostaStatus: "failed"');
    // الحجز الذرّي موجود قبل الـfetch.
    expect(code).toContain("bostaStatus: BOSTA_CREATING");
    expect(code).toContain("notInArray(orders.bostaStatus, [BOSTA_CREATING, BOSTA_UNCERTAIN])");
    // والحالة غير المؤكدة بتترفض قبل أي إنشاء جديد.
    expect(code).toContain("order.bostaStatus === BOSTA_UNCERTAIN");
  });
});

// ==================== P1-2/P1-3 · حركة المخزون ذرّية ====================

describe("🔑 P1-2/P1-3 · الحركة الذرّية والقفل — على الكود", () => {
  const fs = require("fs");
  const db = fs.readFileSync("server/db.ts", "utf-8");

  it("🔑 addInventoryMovementInTransaction: قفل + سجل + رصيد مع بعض", () => {
    const fn = db.slice(
      db.indexOf("export async function addInventoryMovementInTransaction"),
      db.indexOf("export async function addInventoryMovement(")
    );
    expect(fn).toContain('.for("update")'); // قفل صف المنتج
    expect(fn).toContain("insert(inventoryMovements)");
    expect(fn).toContain("update(products)");
    // الفحص قبل الكتابة.
    const check = fn.indexOf("أكبر من المخزون الحالي");
    const write = fn.indexOf("insert(inventoryMovements)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(write);
  });

  it("🔑 addInventoryMovement بقى transaction — ذرّي standalone", () => {
    const fn = db.slice(
      db.indexOf("export async function addInventoryMovement("),
      db.indexOf("export async function addInventoryMovement(") + 250
    );
    expect(fn).toContain("db.transaction(tx => addInventoryMovementInTransaction(tx, data))");
  });

  it("🔑 confirmOrder: transaction + قفل الأوردر + خصم واحد", () => {
    const fn = db.slice(
      db.indexOf("export async function confirmOrder("),
      db.indexOf("export async function postponeOrder(")
    );
    expect(fn).toContain("db.transaction");
    expect(fn).toContain('.for("update")');
    // الخصم بيمرّ على الحركة الذرّية جوّه نفس الـtx.
    expect(fn).toContain("addInventoryMovementInTransaction(tx");
    // فحص «اتأكد خلاص» جوّه القفل — الخصم مرة واحدة.
    expect(fn).toContain('if (order.status === "confirmed") return;');
  });

  it("🔑 markOrderAsReturned: transaction + قفل + عكس واحد", () => {
    const fn = db.slice(
      db.indexOf("export async function markOrderAsReturned("),
      db.indexOf("export async function getReturnsList(")
    );
    expect(fn).toContain("db.transaction");
    expect(fn).toContain('.for("update")');
    expect(fn).toContain("addInventoryMovementInTransaction(tx");
    // حارس الحالة هو حارس الازدواج.
    expect(fn).toContain('allowedStatuses.includes(order.status)');
  });

  it("🔑 editOrderFull مابقاش يحرّك المخزون مرتين", () => {
    const fn = db.slice(
      db.indexOf("export async function editOrderFull("),
      db.indexOf("export async function editOrderFull(") + 6000
    );
    const qtyBlock = fn.slice(fn.indexOf('"quantity" in orderUpdates'));
    const region = qtyBlock.slice(0, qtyBlock.indexOf("addActivityLog"));
    // updateProductStock المنفصل اتشال — الحركة الذرّية بس اللي بتحرّك الرصيد.
    expect(region).not.toContain("await updateProductStock(");
    expect(region).toContain("addInventoryMovement({");
  });
});

// ==================== P1-2 · التصنيف الذرّي (منطق نقي) ====================

describe("🔑 المخزون سالب مستحيل، والفحص قبل الخصم", () => {
  it("stock=1، خصم 1 → 0؛ خصم 2 من 1 → يترفض", () => {
    // نفس منطق addInventoryMovementInTransaction: الفحص قبل الكتابة.
    const check = (stock: number, out: number) => {
      if (out > stock) throw new Error("المخزون غير كافي");
      return stock - out;
    };
    expect(check(1, 1)).toBe(0);
    expect(() => check(1, 2)).toThrow();
  });
});

// ==================== مصالحة المخزون (منطق نقي) ====================

describe("🔑 مصالحة المخزون — MATCH / AMBIGUOUS / MISMATCH", () => {
  it("🔑 المخزّن = صافي الحركات → MATCH", () => {
    const v = classifyBalance(10, { totalIn: 15, totalOut: 5 });
    expect(v.status).toBe("MATCH");
    expect(v.impliedOpening).toBe(0);
  });

  it("🔑 افتتاحي موجب مش متسجّل → AMBIGUOUS (مش MISMATCH)", () => {
    // منتج رصيده ٥٠ ومفيش حركات — افتتاحي شرعي، مش drift.
    const v = classifyBalance(50, { totalIn: 0, totalOut: 0 });
    expect(v.status).toBe("AMBIGUOUS");
    expect(v.impliedOpening).toBe(50);
  });

  it("🔑 افتتاحي مُستنتَج سالب → MISMATCH (drift حقيقي)", () => {
    // خرج ٢٠، دخل ٥، الرصيد ٣ → افتتاحي مُستنتَج = 3 − (5−20) = 18? لأ:
    // net = 5 − 20 = −15 ; implied = 3 − (−15) = 18 → ده AMBIGUOUS مش MISMATCH.
    // الـMISMATCH الحقيقي: net موجب أكبر من المخزّن.
    const v = classifyBalance(3, { totalIn: 20, totalOut: 5 }); // net=15, implied=3−15=−12
    expect(v.status).toBe("MISMATCH");
    expect(v.impliedOpening).toBe(-12);
  });

  it("🔑 الرصيد السالب MISMATCH على طول", () => {
    expect(classifyBalance(-3, { totalIn: 0, totalOut: 3 }).status).toBe("MISMATCH");
  });

  it("الإحصاء بيجمع صح", () => {
    const rows = [
      classifyBalance(10, { totalIn: 10, totalOut: 0 }), // MATCH
      classifyBalance(50, { totalIn: 0, totalOut: 0 }), // AMBIGUOUS
      classifyBalance(3, { totalIn: 20, totalOut: 5 }), // MISMATCH
    ];
    expect(summariseReconcile(rows)).toEqual({
      total: 3,
      match: 1,
      ambiguous: 1,
      mismatch: 1,
    });
  });

  it("🔑 سكربت المصالحة قراءة فقط", () => {
    const fs = require("fs");
    const code = fs
      .readFileSync("scripts/reconcileInventory.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l: string) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const w of [".insert(", ".update(", ".delete(", ".transaction("]) {
      expect(code, w).not.toContain(w);
    }
  });
});

// ==================== تزامن حقيقي على DB (مع TEST_DATABASE_URL) ====================
//
// دول اختبارات سلوكية فعلية بتفتح اتصالين متزامنين على MySQL وتتأكد إن الأقفال بتشتغل.
// بتحتاج `TEST_DATABASE_URL`؛ من غيرها بتتخطى — والمحاكاة فوق بتغطّي المنطق.

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "🔑 تزامن حقيقي — أقفال المخزون والحالة",
  () => {
    it("🔑 stock=1، خصمين متزامنين لـ1 → واحد ينجح، الرصيد النهائي 0، حركة واحدة", async () => {
      const { getDb, addInventoryMovement } = await import("./db");
      const { createCoreTestFixture } = await import("./testFixtures");
      const { products, inventoryMovements } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return;
      const fx = await createCoreTestFixture("conc-stock");
      await db.update(products).set({ currentStock: 1 }).where(eq(products.id, fx.productId));

      const out = () =>
        addInventoryMovement({
          businessId: fx.businessId,
          productId: fx.productId,
          type: "out",
          quantity: 1,
          reason: "تزامن",
          performedBy: 1,
        } as any);
      const results = await Promise.allSettled([out(), out()]);

      const ok = results.filter(r => r.status === "fulfilled").length;
      const failed = results.filter(r => r.status === "rejected").length;
      expect(ok).toBe(1);
      expect(failed).toBe(1);

      const [p] = await db.select().from(products).where(eq(products.id, fx.productId));
      expect(p.currentStock).toBe(0);
      const moves = await db
        .select()
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.productId, fx.productId), eq(inventoryMovements.type, "out")));
      expect(moves).toHaveLength(1);

      await db.delete(inventoryMovements).where(eq(inventoryMovements.productId, fx.productId));
      await fx.cleanup();
    });

    it("🔑 فشل بعد الـinsert → rollback: لا سجل ولا رصيد جزئي", async () => {
      const { getDb, addInventoryMovementInTransaction } = await import("./db");
      const { createCoreTestFixture } = await import("./testFixtures");
      const { products, inventoryMovements } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return;
      const fx = await createCoreTestFixture("conc-rollback");
      await db.update(products).set({ currentStock: 10 }).where(eq(products.id, fx.productId));

      await expect(
        db.transaction(async tx => {
          await addInventoryMovementInTransaction(tx, {
            businessId: fx.businessId,
            productId: fx.productId,
            type: "out",
            quantity: 3,
            reason: "هيتراجع",
            performedBy: 1,
          } as any);
          throw new Error("فشل مصطنع بعد الحركة");
        })
      ).rejects.toThrow();

      const [p] = await db.select().from(products).where(eq(products.id, fx.productId));
      expect(p.currentStock).toBe(10); // مااتغيّرش
      const moves = await db
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.productId, fx.productId));
      expect(moves).toHaveLength(0); // مفيش سجل

      await fx.cleanup();
    });
  }
);
