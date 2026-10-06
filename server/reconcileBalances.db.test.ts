import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb, addTreasuryTransaction } from "./db";
import { createFinancialAccount, postFinancialTransaction } from "./accountingV2.service";
import { financialAccounts, financialTransactionEntries, financialTransactions, treasuryTransactions } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { loadBalanceReport, listBusinessIds, openReadOnlyExecutor, type ReadOnlyExecutor } from "./balanceReconciliation.service";

/**
 * مطابقة الأرصدة على قاعدة اختبار حقيقية: الحركات تُكتب بمسارات النظام نفسها (الخزنة + الحسابات
 * المالية)، ثم السكربت (قراءة فقط) يثبت التطابق، ويكتشف العبث المباشر بالرصيد، ويحترم النطاق.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🧮 مطابقة الأرصدة — DB حقيقية", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  let exec: ReadOnlyExecutor;
  let cashA = 0, bankA = 0, cashB = 0;
  const actor = { id: 1, name: "owner" };
  const db = async () => (await getDb())!;

  beforeAll(async () => {
    A = await createCoreTestFixture("recon-a"); B = await createCoreTestFixture("recon-b");
    exec = await openReadOnlyExecutor(process.env.TEST_DATABASE_URL as string);
    // خزنة النشاط A (سلسلة balanceAfter) — بالمسار الوحيد الكاتب في النظام
    const base = { performedBy: 1, performedByName: "owner", description: "اختبار", referenceType: "manual" as const };
    await addTreasuryTransaction({ businessId: A.businessId, type: "deposit", direction: "in", amount: "1000.0000", ...base });
    await addTreasuryTransaction({ businessId: A.businessId, type: "expense", direction: "out", amount: "250.5000", ...base });
    await addTreasuryTransaction({ businessId: A.businessId, type: "collection", direction: "in", amount: "99.2500", ...base });
    await addTreasuryTransaction({ businessId: B.businessId, type: "deposit", direction: "in", amount: "40.0000", ...base });
    // حسابات مالية: افتتاحي + قيود بالمسار الوحيد الكاتب (postFinancialTransaction)
    cashA = (await createFinancialAccount({ businessId: A.businessId, code: "CASH-T", name: "خزنة اختبار", accountType: "cash", currencyCode: "EGP", openingBalance: "500" })).id;
    bankA = (await createFinancialAccount({ businessId: A.businessId, code: "BANK-T", name: "بنك اختبار", accountType: "bank", currencyCode: "EGP", openingBalance: "0" })).id;
    cashB = (await createFinancialAccount({ businessId: B.businessId, code: "CASH-T", name: "خزنة B", accountType: "cash", currencyCode: "EGP", openingBalance: "10" })).id;
    await postFinancialTransaction({ businessId: A.businessId, transactionType: "test_in", targetAccountId: cashA, amount: "300", currencyCode: "EGP", description: "دخول", evidenceUrl: "https://x/1", occurredAt: new Date(), actor });
    await postFinancialTransaction({ businessId: A.businessId, transactionType: "transfer", sourceAccountId: cashA, targetAccountId: bankA, amount: "120.75", currencyCode: "EGP", description: "تحويل", evidenceUrl: "https://x/2", occurredAt: new Date(), actor });
  });

  afterAll(async () => {
    await exec?.close();
    const d = await getDb(); if (!d) return;
    const bids = [A.businessId, B.businessId];
    await d.delete(financialTransactionEntries).where(inArray(financialTransactionEntries.businessId, bids));
    await d.delete(financialTransactions).where(inArray(financialTransactions.businessId, bids));
    await d.delete(financialAccounts).where(inArray(financialAccounts.businessId, bids));
    await d.delete(treasuryTransactions).where(inArray(treasuryTransactions.businessId, bids));
    await B?.cleanup(); await A?.cleanup();
  });

  it("✓ الأرصدة المكتوبة بمسارات النظام مطابقة: الخزنة (سلسلة) والحسابات (افتتاحي + قيود)", async () => {
    const r = await loadBalanceReport(exec, [A.businessId]);
    expect(r.ok).toBe(true);
    const byKey = Object.fromEntries(r.lines.map(l => [l.key, l]));
    expect(byKey.treasury).toMatchObject({ stored: 848.75, computed: 848.75, difference: 0, movements: 3, chainBreaks: [] });
    expect(byKey.treasury.lastMovementAt).not.toBeNull();
    expect(byKey["CASH-T"]).toMatchObject({ stored: 679.25, computed: 679.25, movements: 2, ok: true }); // 500 + 300 − 120.75
    expect(byKey["BANK-T"]).toMatchObject({ stored: 120.75, computed: 120.75, movements: 1, ok: true });
  });

  it("✗ تعديل الرصيد المخزّن مباشرة (بلا حركة) يُكتشف بالفرق الصحيح — ثم يُعاد", async () => {
    const d = await db();
    await d.update(financialAccounts).set({ currentBalance: "700.0000" }).where(eq(financialAccounts.id, cashA));
    try {
      const r = await loadBalanceReport(exec, [A.businessId]);
      expect(r.ok).toBe(false);
      const line = r.mismatches.find(l => l.key === "CASH-T")!;
      expect(line.difference).toBe(20.75); // 700 − 679.25
      expect(r.mismatches).toHaveLength(1);
    } finally {
      await d.update(financialAccounts).set({ currentBalance: "679.2500" }).where(eq(financialAccounts.id, cashA));
    }
  });

  it("✗ كسر سلسلة الخزنة (balanceAfter لا يساوي السابق ± المبلغ) يُكتشف برقم الصف", async () => {
    const d = await db();
    const [row] = await d.select().from(treasuryTransactions).where(eq(treasuryTransactions.businessId, A.businessId)).orderBy(treasuryTransactions.id).limit(1);
    await d.update(treasuryTransactions).set({ balanceAfter: "999.00" }).where(eq(treasuryTransactions.id, row.id));
    try {
      const r = await loadBalanceReport(exec, [A.businessId]);
      const t = r.lines.find(l => l.key === "treasury")!;
      expect(t.ok).toBe(false);
      expect(t.chainBreaks).toEqual([row.id, row.id + 1]); // الصف المعدَّل والذي يليه (يبدأ من رصيد خاطئ)
    } finally {
      await d.update(treasuryTransactions).set({ balanceAfter: "1000.00" }).where(eq(treasuryTransactions.id, row.id));
    }
  });

  it("🔒 النطاق: التشغيل على A لا يحمل أي سطر لـB، وB وحده سليم", async () => {
    const onlyA = await loadBalanceReport(exec, [A.businessId]);
    expect(onlyA.lines.every(l => l.businessId === A.businessId)).toBe(true);
    const onlyB = await loadBalanceReport(exec, [B.businessId]);
    expect(onlyB.lines.map(l => l.key)).toEqual(["treasury", "CASH-T"]);
    expect(onlyB.ok).toBe(true);
    expect(onlyB.lines[0]).toMatchObject({ stored: 40, computed: 40, movements: 1 });
    const all = await listBusinessIds(exec);
    expect(all).toEqual(expect.arrayContaining([A.businessId, B.businessId]));
  });

  it("🔒 المنفّذ يرفض أي عبارة غير SELECT، وMySQL نفسه يرفض الكتابة على هذا الاتصال", async () => {
    await expect(exec.query("UPDATE financial_accounts SET currentBalance = 0 WHERE id = ?", [cashB])).rejects.toThrow(/non-SELECT/);
    await expect(exec.query(" select 1 ; update financial_accounts set currentBalance = 0")).rejects.toThrow();
    const [{ v }] = await exec.query<{ v: number }>("SELECT currentBalance AS v FROM financial_accounts WHERE id = ?", [cashB]);
    expect(Number(v)).toBe(10);
  });
});
