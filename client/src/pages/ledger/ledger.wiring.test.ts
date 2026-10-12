import { describe, it, expect } from "vitest";
import fs from "fs";

/** حراس نصّية: المسارات والتنقل والصلاحيات وقواعد الموبايل لواجهة دفتر V3. */
const app = fs.readFileSync("client/src/App.tsx", "utf-8");
const guard = fs.readFileSync("client/src/components/shell/FinancialRoute.tsx", "utf-8"); // المرحلة 7C: الحارس انتقل من App.tsx
const nav = fs.readFileSync("client/src/config/navigation.ts", "utf-8");
const daily = fs.readFileSync("client/src/pages/ledger/LedgerDaily.tsx", "utf-8");
const txs = fs.readFileSync("client/src/pages/ledger/LedgerTransactions.tsx", "utf-8");
const ui = fs.readFileSync("client/src/pages/ledger/ledgerUi.ts", "utf-8");
const perms = fs.readFileSync("client/src/components/PermissionSettings.tsx", "utf-8");

describe("🔑 واجهة دفتر V3 — الربط", () => {
  it("المسارات خلف ledger.view داخل LedgerLayout (المالك: لوحة التحكم، المحاسب: قشرة الموظف)، وصفحة الصلاحيات للمالك، ولا Router/شاشة تفعيل", () => {
    expect(app).toContain('<FinancialRoute permission="ledger.view" bare><LedgerLayout><LedgerDaily /></LedgerLayout></FinancialRoute>');
    expect(app).toContain('<FinancialRoute permission="ledger.view" bare><LedgerLayout><LedgerTransactions /></LedgerLayout></FinancialRoute>');
    expect(app).toContain("<PermissionsPage />");
    // لا شاشة تفعيل: ledger.activate يظهر مرة واحدة فقط كبوابة مالك لصفحة «تجهيز الأرصدة الافتتاحية» (تحقق قراءة فقط)
    expect(app).not.toMatch(/activateLedger/);
    expect(app.match(/ledger\.activate/g)).toHaveLength(1);
    expect(app).toContain('<FinancialRoute permission="ledger.activate" bare><LedgerLayout><LedgerOpening /></LedgerLayout></FinancialRoute>');
    const opening = fs.readFileSync("client/src/pages/ledger/LedgerOpening.tsx", "utf-8");
    expect(opening).toContain("trpc.ledger.opening.validate.useMutation()");
    expect(opening).not.toMatch(/activateLedger|trpc\.ledger\.activate|localStorage\.|sessionStorage\.|indexedDB/);
    for (const p of ["accounts", "periods", "report"]) expect(app).toContain(`<Route path="/ledger/${p}">`);
    expect(daily + txs).not.toMatch(/activate/i);
    // المحاسب (جلسة موظف بلا user) يهبط على الدفتر، والحارس يحوّله لصفحة التجميد الآمنة لو بلا ledger.view
    const login = fs.readFileSync("client/src/pages/EmployeeLogin.tsx", "utf-8");
    expect(login).toMatch(/role === 'accountant'\) \{[\s\S]*?setLocation\("\/ledger"\)/);
    expect(guard).toContain('if (perms.includes("ledger.view")) return "/ledger";');
    expect(guard).toContain('if (hasUser && perms.includes("dashboard.view")) return "/dashboard";');
    // الأنشطة من الدفتر نفسه (نطاق السيرفر) لا من BusinessContext الذي يشترط جلسة مالك
    const ledgerHook = fs.readFileSync("client/src/pages/ledger/useLedgerBusinesses.ts", "utf-8");
    expect(ledgerHook).toContain("trpc.ledger.businesses.list.useQuery(");
    expect(daily).toContain("useLedgerBusinesses(initial?.businessId)");
    expect(txs).toContain("trpc.ledger.businesses.list.useQuery(");
    expect(daily + txs).not.toMatch(/useBrandOptions|useBusinessContext/);
  });
  it("وجهة «الحسابات» في التنقل بصلاحية ledger.view، ورابط صلاحيات الأدوار للمالك", () => {
    expect(nav).toContain('key: "ledger"');
    expect(nav).toContain('permission: "ledger.view"');
    expect(nav).toContain('{ label: "صلاحيات الأدوار", path: "/permissions", icon: ShieldCheck, adminOnly: true }');
  });
  it("الواجهة اليومية لا تعرض مدين/دائن ولا owner_drawing، وتستخدم operationId ثابتًا لكل فتح", () => {
    const dailyCode = daily.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, ""); // بلا تعليقات
    expect(dailyCode).not.toMatch(/owner_drawing|مدين|دائن/);
    expect(ui).toContain('kind: moneyAccount.code === "COD_BOSTA" ? "revenue_cod" : "revenue_prepaid"');
    expect(ui).not.toContain("owner_drawing\"");
    expect(daily).toContain("const [operationId] = useState(newOperationId);");
    expect(daily).toContain("idempotencyKey: operationId");
    expect(daily).toContain("if (submitting || post.isPending) return;");
  });
  it("الموبايل: بطاقات وجدول للشاشات الواسعة عبر ResponsiveDataTable (نسخة واحدة في DOM)، حقول/أزرار ≥ 44px، زر حفظ ثابت لا يغطي الحقول", () => {
    // المرحلة 7E: بدل md:hidden/md:block (نسختان في DOM) — ResponsiveDataTable تعرض البطاقات أو الجدول فقط
    expect(txs).toContain("<ResponsiveDataTable<Row>");
    expect(txs).toContain('cardsBelow="md"');
    expect(txs).not.toMatch(/md:hidden|md:block|<table/);
    expect(daily).toContain('className="sticky bottom-0 flex items-center gap-2 border-t bg-card px-4 py-3"');
    expect(daily).toContain('const field = "min-h-11"');
    for (const src of [daily, txs]) expect((src.match(/min-h-1[12]/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(daily).toContain("w-[calc(100vw-1.5rem)]");
  });
  it("سجل الحركات: لا تعديل ولا حذف، والعكس بسبب إلزامي لمن لديه ledger.reverse", () => {
    expect(txs).not.toMatch(/update|delete/i);
    expect(txs).toContain('has("ledger.reverse")');
    expect(txs).toContain('if (reason.trim().length < 3) return toast.error');
  });
  it("شاشة الصلاحيات تعرض ledger.* بأسماء عربية وتقفل ما هو للمالك فقط", () => {
    expect(perms).toContain('permissionLabel(permission)');
    expect(perms).toContain('new Set(["ledger.period.reopen", "ledger.activate"])');
    const labels = fs.readFileSync("shared/permissionLabels.ts", "utf-8");
    for (const p of ["ledger.view", "ledger.post", "ledger.reverse", "ledger.manage_accounts", "ledger.period.lock", "ledger.period.reopen", "ledger.activate"]) expect(labels).toContain(`"${p}":`);
  });
});
