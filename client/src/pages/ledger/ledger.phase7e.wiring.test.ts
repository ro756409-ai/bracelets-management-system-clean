/**
 * المرحلة 7E — حارس نصّي لدفتر V3 والحسابات: الاستعلامات/الـmutations قبل وبعد (الإضافات قراءة فقط أو
 * إجراءات موجودة على السيرفر بصلاحياتها)، لا تفعيل/لا ترحيل 0040/لا تعديل رصيد/لا تعديل أو حذف قيود،
 * الشعارات الرسمية على حسابها الصحيح فقط، مساحة زر الإغلاق في كل حوار، والصفحات المجمّدة بلا كتابة.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const read = (p: string) => strip(readFileSync(path.join(root, p), "utf8"));
const hooks = (src: string) => [...src.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);

describe("🔌 Queries/Mutations قبل → بعد", () => {
  it("LedgerDaily: الثلاثة الأصلية (status / accounts.list / post) + تجهيز الحسابات القياسية في المرحلة 2 (حالة للقراءة + إجراء خلف ledger.manage_accounts)", () => {
    expect(hooks(read("pages/ledger/LedgerDaily.tsx"))).toEqual([
      "trpc.ledger.status.useQuery", "trpc.ledger.accounts.list.useQuery",
      "trpc.ledger.setup.dailyAccountsStatus.useQuery", "trpc.ledger.setup.ensureDailyAccounts.useMutation",
      "trpc.ledger.post.useMutation",
    ]);
  });
  it("LedgerTransactions: قبل = status/transactions.list/businesses.list/reverse؛ بعد + periods.list (قراءة) و period.lock/reopen (موجودان على السيرفر بصلاحيتهما)", () => {
    const h = hooks(read("pages/ledger/LedgerTransactions.tsx"));
    for (const s of ["trpc.ledger.status.useQuery", "trpc.ledger.transactions.list.useQuery", "trpc.ledger.businesses.list.useQuery", "trpc.ledger.reverse.useMutation"]) expect(h).toContain(s);
    expect(h.filter(x => x.endsWith("useMutation")).sort()).toEqual(["trpc.ledger.period.lock.useMutation", "trpc.ledger.period.reopen.useMutation", "trpc.ledger.reverse.useMutation"]);
    expect(h).toContain("trpc.ledger.periods.list.useQuery");
    expect(h).not.toContain("trpc.ledger.transaction.get.useQuery"); // التفاصيل من بيانات الصف نفسه
  });
  it("LedgerLayout: employeePortal.me فقط كما كان؛ AccountingDisabled بلا أي hook", () => {
    expect(hooks(read("pages/ledger/LedgerLayout.tsx"))).toEqual(["trpc.employeePortal.me.useQuery"]);
    expect(hooks(read("pages/AccountingDisabled.tsx"))).toEqual([]);
  });
});

describe("🚫 الممنوعات", () => {
  const daily = read("pages/ledger/LedgerDaily.tsx"), txs = read("pages/ledger/LedgerTransactions.tsx");
  it("لا activate ولا 0040 كإجراء ولا account.create/updateName/setActive (لا تعديل رصيد ولا حساب من الواجهة)", () => {
    expect(daily + txs).not.toMatch(/ledger\.activate|activateLedger|migrate|account\.(create|updateName|setActive|grantBusiness|revokeBusiness)/);
  });
  it("لا تعديل ولا حذف قيود — العكس فقط، بسبب إلزامي وحارس ضغط مكرر", () => {
    expect(txs).not.toMatch(/\.(update|delete)\.useMutation/);
    expect(txs).toContain('has("ledger.reverse")');
    expect(txs).toContain("if (submitting || reverse.isPending) return;");
    expect(txs).toContain("if (pending) return;");
    // الإقفال يحتاج ملاحظة مراجعة إلزامية (الاعتماد = مراجعة ثم إقفال)، وإعادة الفتح سببًا إلزاميًا — كلاهما 3 أحرف على الأقل
    expect(txs).toContain('if (reason.trim().length < 3) return toast.error(action === "lock" ? "اكتب ملاحظة المراجعة قبل الإقفال');
  });
  it("القفل بـledger.period.lock وإعادة الفتح بـledger.period.reopen (للمالك على السيرفر)", () => {
    expect(txs).toContain('canLock={has("ledger.period.lock")}');
    expect(txs).toContain('canReopen={has("ledger.period.reopen")}');
    expect(txs).toContain('p.status === "open" && canLock &&');
    expect(txs).toContain('p.status === "locked" && canReopen &&');
    const server = readFileSync(path.resolve(root, "../../server/permissions.ts"), "utf8");
    expect(server).toContain('LEDGER_OWNER_ONLY_PERMISSIONS: readonly Permission[] = ["ledger.period.reopen", "ledger.activate"]');
  });
  it("الواجهة اليومية بلا مدين/دائن، والـpayload كما كان", () => {
    expect(daily).not.toMatch(/مدين|دائن|owner_drawing/);
    expect(daily).toContain('sourceType: "daily_ui"');
    expect(daily).toContain("idempotencyKey: operationId");
  });
});

describe("🎨 الهوية", () => {
  it("شعارات Bosta/Vodafone/InstaPay على حسابها الصحيح فقط (COD_BOSTA/VF_CASH/INSTAPAY)", () => {
    const daily = read("pages/ledger/LedgerDaily.tsx");
    expect(daily).toContain('const CARD_LOGOS: Record<string, PartnerId> = { VF_CASH: "vodafone_cash", INSTAPAY: "instapay", COD_BOSTA: "bosta" };');
    // بطاقات النقدية + بطاقة ذمة شركة الشحن (المرحلة 0: COD منفصل عن النقدية) + قائمة الحسابات — كلها عبر CARD_LOGOS[a.code]
    expect((daily.match(/<PartnerLogo /g) ?? []).length).toBe(3);
    expect(daily.match(/<PartnerLogo [^>]*>/g)?.every(t => t.includes("partner={logo}"))).toBe(true);
    expect(daily).not.toMatch(/partner="(bosta|vodafone_cash|instapay)"/); // لا شعار ثابت خارج الخريطة
  });
  it("كل DialogHeader يحفظ مساحة زر الإغلاق (لا px-4 يلغيها) في LedgerDaily/LedgerTransactions/DailyLedger", () => {
    for (const f of ["pages/ledger/LedgerDaily.tsx", "pages/ledger/LedgerTransactions.tsx", "pages/DailyLedger.tsx"]) {
      const p = read(f);
      const headers = p.match(/<DialogHeader[^>]*>/g) ?? [];
      expect(headers.length, f).toBeGreaterThan(0);
      for (const h of headers) { expect(h, f + " " + h).not.toMatch(/\bpx-4\b|\bpx-6\b/); expect(h, f + " " + h).toMatch(/pr-16/); }
    }
  });
  it("لا ألوان Tailwind خام ولا rounded-xl يدوي في صفحات الدفتر؛ أزرار 44px", () => {
    for (const f of ["pages/ledger/LedgerDaily.tsx", "pages/ledger/LedgerTransactions.tsx", "pages/ledger/LedgerLayout.tsx", "pages/AccountingDisabled.tsx"]) {
      const p = read(f);
      expect(p, f).not.toMatch(/\b(bg|text|border)-(gray|stone|slate|blue|amber|emerald|green|red|purple|violet)-\d{2,3}\b/);
      expect(p, f).not.toMatch(/rounded-xl\b/);
      const buttons = p.match(/<Button\b(?:=>|> 0|[^>])*>/gs) ?? [];
      for (const b of buttons) expect(b, f + " " + b.slice(0, 70)).toMatch(/min-h-11|min-h-12|h-11/);
    }
  });
  it("الصفحات المحاسبية القديمة كلها على AccountingDisabled (حالة واضحة، لا كتابة) و<main> واحد فيها", () => {
    const app = readFileSync(path.join(root, "App.tsx"), "utf8");
    for (const p of ["/accounting", "/treasury", "/expenses", "/collections", "/payroll", "/closings", "/daily-ledger", "/daily-collections", "/accounting-settings", "/shipping-finance"]) expect(app).toContain(`<Route path="${p}"><AccountingDisabled /></Route>`);
    const dis = read("pages/AccountingDisabled.tsx");
    expect((dis.match(/<main\b/g) ?? []).length).toBe(1);
    expect(dis).toContain('data-testid="accounting-disabled-ledger-link"');
  });
});
