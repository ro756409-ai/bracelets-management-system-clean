import { describe, it, expect } from "vitest";
import fs from "fs";
import { buildBalanceReport, reconcileFinancialAccount, reconcileTreasury, looksLikeProductionTarget } from "./balanceReconciliation";

/** الحساب النقي يكتشف الأرقام المكسورة عمدًا؛ والسكربت وطبقة القراءة لا يكتبان حرفًا. */
describe("🧮 مطابقة الأرصدة — الحساب النقي", () => {
  const t = (id: number, businessId: number, direction: "in" | "out", amount: number, balanceAfter: number) =>
    ({ id, businessId, direction, amount, balanceAfter, transactionDate: new Date(2026, 0, id) });

  it("خزنة سليمة: المخزّن = المحسوب والسلسلة متصلة", () => {
    const line = reconcileTreasury(1, [t(1, 1, "in", 500, 500), t(2, 1, "out", 120.5, 379.5), t(3, 1, "in", 20, 399.5)]);
    expect(line).toMatchObject({ stored: 399.5, computed: 399.5, difference: 0, movements: 3, chainBreaks: [], ok: true });
    expect(line.lastMovementAt).toContain("2026-01-0");
  });
  it("كسر في السلسلة (إدخال متوازٍ بلا قفل) يُكتشف ولو تطابق الرصيد الأخير بالصدفة", () => {
    const line = reconcileTreasury(1, [t(1, 1, "in", 100, 100), t(2, 1, "in", 50, 100), t(3, 1, "in", 50, 200)]);
    // الصف 2 مكسور، والصف 3 لا يساوي سابقه المخزّن ± مبلغه أيضًا (السلسلة تُفحص صفًا بصف)
    expect(line.ok).toBe(false); expect(line.chainBreaks).toEqual([2, 3]);
    expect(line.difference).toBe(0);
  });
  it("رصيد أخير معدَّل يدويًا → فرق", () => {
    const line = reconcileTreasury(1, [t(1, 1, "in", 100, 100), t(2, 1, "out", 30, 90)]);
    expect(line.difference).toBe(20); expect(line.chainBreaks).toEqual([2]); expect(line.ok).toBe(false);
  });
  it("نشاط بلا حركات → صفر/صفر سليم، وصفوف نشاط آخر لا تدخل", () => {
    expect(reconcileTreasury(2, [t(1, 1, "in", 100, 100)])).toMatchObject({ stored: 0, computed: 0, movements: 0, ok: true });
  });
  it("حساب مالي: الافتتاحي + داخل − خارج = الحالي", () => {
    const acc = { id: 9, businessId: 1, code: "CASH-MAIN", name: "الخزنة", accountType: "cash", openingBalance: "1000", currentBalance: "1250", isActive: true };
    const entries = [
      { accountId: 9, direction: "in" as const, amount: "500", createdAt: new Date("2026-02-01"), transactionId: 1 },
      { accountId: 9, direction: "out" as const, amount: "250", createdAt: new Date("2026-02-03"), transactionId: 2 },
      { accountId: 8, direction: "in" as const, amount: "999", createdAt: new Date("2026-02-04"), transactionId: 3 }, // حساب آخر
    ];
    const line = reconcileFinancialAccount(acc, entries);
    expect(line).toMatchObject({ stored: 1250, computed: 1250, difference: 0, movements: 2, ok: true, key: "CASH-MAIN" });
    expect(line.lastMovementAt).toBe("2026-02-03T00:00:00.000Z");
    expect(reconcileFinancialAccount({ ...acc, currentBalance: "1300" }, entries)).toMatchObject({ difference: 50, ok: false });
  });
  it("فرق أقل من قرش يُهمل", () => {
    const acc = { id: 1, businessId: 1, code: "A", name: "a", accountType: "cash", openingBalance: "0", currentBalance: "10.004", isActive: true };
    expect(reconcileFinancialAccount(acc, [{ accountId: 1, direction: "in", amount: "10", createdAt: null, transactionId: 1 }]).ok).toBe(true);
  });
  it("التقرير المجمّع يرتّب لكل نشاط: الخزنة ثم حساباته بالكود، ويجمع عدم التطابق", () => {
    const r = buildBalanceReport({
      businessIds: [1, 2],
      treasury: [t(1, 1, "in", 10, 10), t(2, 2, "in", 5, 7)],
      accounts: [
        { id: 1, businessId: 1, code: "B", name: "b", accountType: "bank", openingBalance: "0", currentBalance: "0", isActive: true },
        { id: 2, businessId: 1, code: "A", name: "a", accountType: "cash", openingBalance: "3", currentBalance: "3", isActive: true },
      ],
      entries: [],
    });
    expect(r.lines.map(l => `${l.businessId}:${l.key}`)).toEqual(["1:treasury", "1:A", "1:B", "2:treasury"]);
    expect(r.ok).toBe(false); expect(r.mismatches.map(l => l.businessId)).toEqual([2]);
  });
});

describe("🔒 حارس الإنتاج — بلا طباعة أسرار", () => {
  it.each([
    ["mysql://u:p@127.0.0.1:3306/matjarak_test", false],
    ["mysql://u:p@localhost/matjarak", false],
    ["mysql://u:p@db.example.com/matjarak_test", false],
    ["mysql://u:p@db.example.com/matjarak_staging", false],
    ["mysql://u:p@db.example.com/matjarak", true],
    ["not-a-url", true],
  ])("%s → production=%s", (url, prod) => {
    const r = looksLikeProductionTarget(url);
    expect(r.production).toBe(prod);
    expect(JSON.stringify(r)).not.toContain(":p@"); // لا كلمة سر في الناتج
  });
});

describe("🔒 السكربت وطبقة القراءة قراءة فقط", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  it.each(["scripts/reconcile-balances.ts", "server/balanceReconciliation.service.ts", "shared/balanceReconciliation.ts"])("%s بلا أي كتابة", file => {
    const code = strip(fs.readFileSync(file, "utf-8"));
    for (const forbidden of [".insert(", ".update(", ".delete(", "INSERT ", "UPDATE ", "DELETE ", "ALTER ", "DROP ", "TRUNCATE", "db:push"]) expect(code, forbidden).not.toContain(forbidden);
  });
  it("الاتصال READ ONLY والمنفّذ يرفض غير SELECT؛ الإنتاج يتطلب تأكيدًا صريحًا؛ لا يُطبع DATABASE_URL", () => {
    const svc = fs.readFileSync("server/balanceReconciliation.service.ts", "utf-8");
    expect(svc).toContain("SET SESSION TRANSACTION READ ONLY");
    expect(svc).toContain('if (!/^\\s*select\\b/i.test(sql)) throw new Error("Refusing to run a non-SELECT statement")');
    const cli = fs.readFileSync("scripts/reconcile-balances.ts", "utf-8");
    expect(cli).toContain("--i-understand-production");
    expect(cli).toContain("target.production && !confirmProduction");
    expect(cli).not.toMatch(/console\.(log|error)\([^)]*\burl\b/);
  });
});
