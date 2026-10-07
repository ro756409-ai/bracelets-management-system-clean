import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  LedgerError, applyToBalance, assertActorShape, canonicalPayloadHash, computeBalanceFromEntries, postingPeriodOf, reconcileAccount, validateEntries,
} from "./ledgerV3Core";

const code = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return e instanceof LedgerError ? e.code : "ERR"; } };

describe("🧮 Ledger V3 — القواعد النقية", () => {
  it("قيد متوازن بسطرين على حسابين → يمر، والمبالغ تُطبَّع إلى 4 خانات بلا float", () => {
    const v = validateEntries([{ accountId: 1, side: "debit", amount: "0.1" }, { accountId: 2, side: "credit", amount: "0.10" }], null);
    expect(v.map(e => e.amount)).toEqual(["0.1000", "0.1000"]);
    expect(v[0].amountMinor).toBe(1000n);
  });
  it("0.1 + 0.2 = 0.3 بالضبط (لا 0.30000000000000004)", () => {
    expect(code(() => validateEntries([{ accountId: 1, side: "debit", amount: "0.1" }, { accountId: 1, side: "debit", amount: "0.2" }, { accountId: 2, side: "credit", amount: "0.3" }], null))).toBe("ok");
  });
  it.each([
    ["غير متوازن", [{ accountId: 1, side: "debit", amount: "100" }, { accountId: 2, side: "credit", amount: "99.9999" }], "unbalanced"],
    ["صفر", [{ accountId: 1, side: "debit", amount: "0" }, { accountId: 2, side: "credit", amount: "0" }], "amount"],
    ["سالب", [{ accountId: 1, side: "debit", amount: "-5" }, { accountId: 2, side: "credit", amount: "-5" }], "amount"],
    ["رقم float غير نصي", [{ accountId: 1, side: "debit", amount: 5 as any }, { accountId: 2, side: "credit", amount: "5" }], "amount"],
    ["أكثر من 4 خانات", [{ accountId: 1, side: "debit", amount: "1.00001" }, { accountId: 2, side: "credit", amount: "1.00001" }], "amount"],
    ["سطر واحد", [{ accountId: 1, side: "debit", amount: "1" }], "entriesMin"],
    ["حساب واحد مكرر", [{ accountId: 1, side: "debit", amount: "1" }, { accountId: 1, side: "credit", amount: "1" }], "entriesMin"],
  ] as const)("%s → مرفوض بكود صحيح", (_label, entries, expected) => {
    expect(code(() => validateEntries(entries as any, null))).toBe(expected);
  });
  it("الرصيد حسب normalSide: مدين يزيد بالمدين، دائن يزيد بالدائن", () => {
    expect(applyToBalance(1000n, "debit", "debit", 500n)).toBe(1500n);
    expect(applyToBalance(1000n, "debit", "credit", 500n)).toBe(500n);
    expect(applyToBalance(1000n, "credit", "credit", 500n)).toBe(1500n);
    expect(applyToBalance(1000n, "credit", "debit", 500n)).toBe(500n);
    expect(computeBalanceFromEntries("credit", [{ side: "credit", amount: "750" }, { side: "debit", amount: "50" }])).toBe(7000000n);
  });
  it("postingPeriod من التاريخ فقط، والتاريخ غير الصالح مرفوض", () => {
    expect(postingPeriodOf("2026-10-07")).toBe("2026-10");
    for (const bad of ["2026-13-01", "2026-10-32", "07/10/2026", "2026-10", ""]) expect(code(() => postingPeriodOf(bad))).toBe("date");
  });
  it("payloadHash قانوني: ترتيب القيود/تطبيع الوصف لا يغيّرانه؛ أي تغيير مالي أو وصف أو مصدر أو فاعل يغيّره", () => {
    const base = { kind: "expense", sourceBusinessId: 1, effectiveDate: "2026-10-07", currency: "EGP", reversalOfTransactionId: null, sourceType: "expense", sourceReference: "E-1", description: "إيجار  أكتوبر", actorType: "employee" as const, actorEmployeeId: 7 };
    const a = validateEntries([{ accountId: 1, side: "debit", amount: "100" }, { accountId: 2, side: "credit", amount: "100" }], 1);
    const b = validateEntries([{ accountId: 2, side: "credit", amount: "100.0" }, { accountId: 1, side: "debit", amount: "100" }], 1);
    const h = canonicalPayloadHash({ ...base, entries: a });
    expect(canonicalPayloadHash({ ...base, entries: b })).toBe(h);
    expect(canonicalPayloadHash({ ...base, entries: a, description: "  إيجار أكتوبر " })).toBe(h); // تطبيع المسافات
    const c = validateEntries([{ accountId: 1, side: "debit", amount: "100.01" }, { accountId: 2, side: "credit", amount: "100.01" }], 1);
    expect(canonicalPayloadHash({ ...base, entries: c })).not.toBe(h);
    expect(canonicalPayloadHash({ ...base, entries: a, effectiveDate: "2026-10-08" })).not.toBe(h);
    expect(canonicalPayloadHash({ ...base, entries: a, description: "إيجار نوفمبر" })).not.toBe(h);
    expect(canonicalPayloadHash({ ...base, entries: a, sourceReference: "E-2" })).not.toBe(h);
    expect(canonicalPayloadHash({ ...base, entries: a, sourceType: "manual" })).not.toBe(h);
    expect(canonicalPayloadHash({ ...base, entries: a, actorEmployeeId: 8 })).not.toBe(h);
    expect(canonicalPayloadHash({ ...base, entries: a, actorType: "system", actorEmployeeId: null })).not.toBe(h);
  });
  it("شكل الفاعل: موظف بمعرّف؛ نظام/webhook بلا معرّف", () => {
    expect(code(() => assertActorShape({ type: "employee", employeeId: 5 }))).toBe("ok");
    expect(code(() => assertActorShape({ type: "employee", employeeId: 0 }))).toBe("actorEmployee");
    expect(code(() => assertActorShape({ type: "system" }))).toBe("ok");
    expect(code(() => assertActorShape({ type: "webhook", employeeId: 5 as any }))).toBe("actorSystem");
  });
  it("مطابقة حساب: مخزّن = محسوب حسب normalSide، والفرق يُبلَّغ", () => {
    const acc = { id: 1, code: "REVENUE", name: "إيراد", normalSide: "credit" as const, currentBalance: "700.0000" };
    const entries = [{ side: "credit" as const, amount: "750", createdAt: new Date("2026-10-07") }, { side: "debit" as const, amount: "50", createdAt: new Date("2026-10-08") }];
    expect(reconcileAccount(acc, entries)).toMatchObject({ stored: "700.0000", computed: "700.0000", difference: "0.0000", entries: 2, ok: true, lastEntryAt: "2026-10-08T00:00:00.000Z" });
    expect(reconcileAccount({ ...acc, currentBalance: "710" }, entries)).toMatchObject({ difference: "10.0000", ok: false });
  });
});

describe("🔒 حراس المصدر — الخدمة لا تقبل من العميل ما يجب أن يحسبه السيرفر، ولا تسقط على V2", () => {
  const svc = fs.readFileSync("server/ledgerV3.service.ts", "utf-8");
  it("tenantId/payloadHash/postingPeriod/balanceAfter ليست في مدخلات الترحيل العامة", () => {
    const inputType = svc.slice(svc.indexOf("export type PostLedgerTransactionInput"), svc.indexOf("export type PostResult"));
    expect(inputType).not.toMatch(/payloadHash|postingPeriod|balanceAfter|currentBalance/);
    expect(svc).toContain("canonicalPayloadHash(");
    expect(svc).toContain("postingPeriodOf(input.effectiveDate)");
  });
  it("حجز المفتاح بالإدراج (القيد الفريد) لا بـSELECT غير مقفول، والقراءة الموجودة مقفولة", () => {
    expect(svc).toContain('isMysqlError(err, "ER_DUP_ENTRY", "ledger_transactions_tenant_idem_unique")');
    expect(svc).toContain('.limit(1).for("share");\n      if (!existing) throw err;');
  });
  it("الحسابات تُقفل FOR UPDATE بترتيب id، والفترة FOR UPDATE، والعلم FOR SHARE؛ غياب الجداول = خطأ واضح", () => {
    expect(svc).toContain('.orderBy(asc(ledgerAccounts.id)).for("update")');
    expect(svc).toContain('ledgerPeriods.period, period))).limit(1).for("share")'); // الترحيل يشارك القفل
    expect(svc).toContain('eq(ledgerPeriods.period, input.period))).limit(1).for("update")'); // القفل/الفتح حصري
    expect(svc).not.toContain("accounting_manager");
    expect(svc).toContain('eq(ledgerTenantFlags.tenantId, tenantId)).for("share")');
    expect(svc).toContain('throw new LedgerError("unavailable")');
    for (const v2 of ["treasuryTransactions", "financialTransactions", "financialAccounts", "businessEvents", "addTreasuryTransaction"]) expect(svc).not.toContain(v2);
  });
  it("الجداول ليست في مخطط drizzle-kit (لا إنشاء تلقائي) والترحيلة ليست في الـjournal", () => {
    expect(fs.readFileSync("drizzle/schema.ts", "utf-8")).not.toContain("ledger_accounts");
    expect(fs.readFileSync("drizzle.config.ts", "utf-8")).toContain('schema: "./drizzle/schema.ts"');
    expect(fs.readFileSync("drizzle/meta/_journal.json", "utf-8")).not.toContain("0040");
  });
});
