import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openReadOnlyExecutor } from "./balanceReconciliation.service";
import { checkExternalOrderIds, PROPOSED_INDEX } from "./externalOrderIdPrecheck.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";

/**
 * فحص 0053 المسبق (قراءة فقط) على قاعدة مؤقتة محلية: يطابق توقّعه سلوك القيد الفريد الفعلي — يُجرَّب القيد هنا على القاعدة المؤقتة
 * فقط للتحقق من التوقّع (ليس Migration): NULL لا يتعارض، القيمة الفارغة تتعارض لو تكررت، الحالة/التشكيل لا يفرّقان (ai_ci)،
 * المسافة الطرفية تفرّق (NO PAD)، ونفس المفتاح في نشاطين مسموح. والمنفّذ لا يكتب شيئًا.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL);

describe.runIf(CAN)("🔎 فحص 0053 المسبق — orders(businessId, externalOrderId)", () => {
  let tmp: TempSchema; let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const order = (businessId: number, key: string | null, status = "new", source = "easyorder") => q(
    "INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, quantity, totalAmount, source, status, externalOrderId) VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'منتج', 1, '100.00', ?, ?, ?)",
    [businessId, `T${++seq}`, source, status, key]);
  const check = async () => { const exec = await openReadOnlyExecutor(tmp.url); try { return await checkExternalOrderIds(exec); } finally { await exec.close(); } };
  const addIndex = () => q(`ALTER TABLE orders ADD UNIQUE INDEX ${PROPOSED_INDEX} (businessId, externalOrderId)`);

  beforeAll(async () => {
    tmp = await createTempSchema("ext_pre");
    await q("DELETE FROM order_items"); await q("DELETE FROM orders");
  }, 120_000);
  afterAll(async () => { await tmp?.drop(); }, 120_000);

  it("بيانات نظيفة (NULL متعددة + نفس المفتاح في نشاطين + مسافة طرفية) = جاهز، والقيد الفعلي يُنشأ بنجاح", async () => {
    await order(1, null); await order(1, null); await order(1, "A-1"); await order(2, "A-1"); await order(1, "B-1"); await order(1, "B-1 ");
    const r = await check();
    expect(r.ready).toBe(true);
    if (!r.column) throw new Error("column");
    expect(r.totals).toMatchObject({ orders: 6, nullKeys: 2, blankKeys: 0, paddedKeys: 1 });
    expect([r.duplicates.groups, r.crossBusinessKeys, r.proposedIndex]).toEqual([0, 1, "absent"]);
    await addIndex();
    const after = await check();
    expect([after.ready, after.proposedIndex]).toEqual([true, "present"]);
    await q(`ALTER TABLE orders DROP INDEX ${PROPOSED_INDEX}`);
  });

  it("تكرار حقيقي + اختلاف حالة أحرف فقط + فارغ مكرر = غير جاهز بعدد مجموعات صحيح، والقيد الفعلي يفشل بنفس السبب", async () => {
    await order(1, "DUP-1", "confirmed"); await order(1, "DUP-1", "new", "facebook");   // تكرار حقيقي
    await order(1, "case-x"); await order(1, "CASE-X");                                  // ai_ci: نفس المفتاح
    await order(3, ""); await order(3, "");                                              // فارغ مكرر
    const r = await check();
    if (!r.column) throw new Error("column");
    expect(r.ready).toBe(false);
    expect(r.duplicates).toMatchObject({ groups: 3, rowsInGroups: 6, blankGroups: 1, caseOrAccentVariantGroups: 1 });
    expect(r.totals.blankKeys).toBe(2);
    const dup = r.duplicates.samples.find(s => s.key === "DUP-1")!;
    expect([dup.businessId, dup.count, dup.statuses, dup.sources]).toEqual([1, 2, ["confirmed", "new"], ["easyorder", "facebook"]]);
    await expect(addIndex()).rejects.toThrow(/Duplicate entry/);
    // بعد حسم كل مجموعة (هنا اختبارًا فقط: إعادة تسمية النسخ الزائدة وتحويل الفارغ إلى NULL) يصبح جاهزًا ويُنشأ القيد
    await q("UPDATE orders SET externalOrderId = CONCAT(externalOrderId, '#dup', id) WHERE externalOrderId IN ('DUP-1') AND source = 'facebook'");
    await q("UPDATE orders SET externalOrderId = CONCAT(externalOrderId, '#dup', id) WHERE BINARY externalOrderId = 'CASE-X'");
    await q("UPDATE orders SET externalOrderId = NULL WHERE TRIM(externalOrderId) = ''");
    expect((await check()).ready).toBe(true);
    await addIndex();
    await expect(order(1, "dup-1")).rejects.toThrow(/Duplicate entry/); // القيد نفسه لا يفرّق الحالة
  });

  it("المنفّذ للقراءة فقط: أي كتابة مرفوضة", async () => {
    const exec = await openReadOnlyExecutor(tmp.url);
    try { await expect(exec.query("UPDATE orders SET status = 'new'")).rejects.toThrow(/non-SELECT/); } finally { await exec.close(); }
  });
});
