/**
 * المرحلة 3 — حراسة مصدرية: الحدود التي اتفقنا عليها تبقى ثابتة في الكود نفسه.
 *   • ResponsiveDataTable: تثبيت منطقي فقط (start/end)، لا نسختين مخفيتين بـCSS، الكسر الافتراضي lg كما كان.
 *   • المكوّنات الجديدة غير مربوطة بالصفحات بعد (الربط = المرحلة 4).
 *   • لا بيانات مزيفة: ReceiptPrediction/AttemptsCell لا يحسبان ولا يفترضان قيمًا.
 *   • كل زر داخل المكوّنات الجديدة type="button" (لا إرسال نماذج عرضيًا) وأهداف اللمس ≥44px.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname);
const read = (f: string) => readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const page = (f: string) => readFileSync(path.resolve(root, "..", "..", "pages", f), "utf8");

const NEW_FILES = ["UnderlineTabs.tsx", "ScopeBar.tsx", "ReviewAttentionBanner.tsx", "OrderToolbar.tsx", "CustomerCell.tsx", "TwoLineCell.tsx", "AttemptsCell.tsx", "ReceiptPrediction.tsx", "useMediaQuery.ts"];

describe("📊 ResponsiveDataTable — حدود المرحلة 3", () => {
  const src = read("ResponsiveDataTable.tsx");
  it("تثبيت منطقي فقط: start-0/end-0 ولا left-0/right-0 ولا text-left/text-right", () => {
    expect(src).toContain("start-0"); expect(src).toContain("end-0");
    expect(src).not.toMatch(/\b(left|right)-0\b/); expect(src).not.toMatch(/\btext-(left|right)\b/);
    expect(src).toContain("text-start"); expect(src).toContain("text-end");
  });
  it("لا نسختين في DOM: لا lg:hidden / hidden lg:block / lg:inline-flex — التبديل عبر useMediaQuery", () => {
    expect(src).not.toMatch(/\b(md|lg):hidden\b/); expect(src).not.toMatch(/hidden (md|lg):(block|inline-flex)/);
    expect(src).toContain('from "./useMediaQuery"'); expect(src).toContain("showCards");
  });
  it("الكسر الافتراضي يبقى lg (1024) والخيار md صريح — لا تغيير عام على المستهلكين", () => {
    expect(src).toContain('cardsBelow = "lg"'); expect(src).toContain("(min-width: 1024px)"); expect(src).toContain("(min-width: 768px)");
  });
  it("useMediaQuery يفترض الشاشة الواسعة عند غياب matchMedia (jsdom/SSR) فلا تتغيّر اختبارات المستهلكين", () => {
    expect(src).toMatch(/useMediaQuery\([\s\S]*?,\s*true\);/);
  });
});

describe("🔌 نطاق الربط — صفحة الأوردرات فقط (المرحلة 4)؛ باقي الصفحات لم تُلمس", () => {
  it("BostaOrders/Collections/Expenses/Treasury/Payroll لا تستورد UnderlineTabs/ScopeBar/ReviewAttentionBanner/OrderToolbar/…", () => {
    const names = ["UnderlineTabs", "ScopeBar", "ReviewAttentionBanner", "OrderToolbar", "CustomerCell", "TwoLineCell", "AttemptsCell", "ReceiptPrediction", "OfflineState"];
    for (const f of ["BostaOrders.tsx", "Collections.tsx", "Expenses.tsx", "Treasury.tsx", "Payroll.tsx"]) {
      const s = page(f);
      for (const n of names) expect(s, `${f} يستورد ${n}`).not.toMatch(new RegExp(`\\b${n}\\b`));
    }
  });
  it("كل المكوّنات الجديدة مُصدَّرة من index.ts", () => {
    const idx = read("index.ts");
    for (const n of ["UnderlineTabs", "ScopeBar", "ReviewAttentionBanner", "OrderToolbar", "CustomerCell", "TwoLineCell", "AttemptsCell", "ReceiptPrediction", "OfflineState", "useMediaQuery"]) expect(idx).toContain(n);
    for (const f of NEW_FILES) expect(existsSync(path.join(root, f)), f).toBe(true);
  });
});

describe("🚫 لا بيانات مزيفة ولا منطق أعمال داخل المكوّنات", () => {
  it("ReceiptPrediction لا يحسب احتمالًا ولا يملك قيمة افتراضية؛ «غير متاح» عند الغياب", () => {
    const s = read("ReceiptPrediction.tsx");
    expect(s).toContain('"غير متاح"'); expect(s).not.toMatch(/probability\s*=\s*\d/); expect(s).not.toMatch(/Math\.random/);
    expect(s).not.toMatch(/trpc|useQuery|fetch\(/);
  });
  it("AttemptsCell: محاولات التوصيل لا تُشتق من محاولات الاتصال؛ «غير متاح» عند الغياب", () => {
    const s = read("AttemptsCell.tsx");
    expect(s).toContain('"غير متاح"'); expect(s).not.toMatch(/deliveryAttempts\s*=\s*callAttempts|callAttempts\s*\?\?\s*deliveryAttempts|deliveryAttempts\s*\?\?\s*callAttempts/);
    expect(s).not.toMatch(/noAnswerCallAttempts/);
  });
  it("ReviewAttentionBanner لا يستعلم بنفسه — العدد يأتي من الصفحة", () => {
    expect(read("ReviewAttentionBanner.tsx")).not.toMatch(/trpc|useQuery|fetch\(/);
  });
  it("لا مكوّن جديد يستورد tRPC أو BusinessContext أو يحتوي businessId ثابتًا", () => {
    for (const f of NEW_FILES) { const s = read(f); expect(s, f).not.toMatch(/@\/lib\/trpc|BusinessContext|businessId\s*[:=]\s*\d/); }
  });
});

describe("👆 أهداف اللمس + type=button + أيقونات زخرفية", () => {
  it("كل <button داخل المكوّنات الجديدة يحمل type=", () => {
    for (const f of [...NEW_FILES.filter(f => f.endsWith(".tsx")), "MobileOrderCard.tsx", "States.tsx"]) {
      const s = read(f);
      // `=>` داخل ref={el => …} ليس نهاية الوسم
      const opens = s.match(/<button\b(?:=>|[^>])*>/gs) ?? [];
      for (const b of opens) expect(b, `${f}: ${b.slice(0, 60)}`).toMatch(/type=["{]/);
    }
  });
  it("المكوّنات التفاعلية الجديدة تستخدم min-h-11 (44px)", () => {
    for (const f of ["UnderlineTabs.tsx", "ScopeBar.tsx", "ReviewAttentionBanner.tsx", "OrderToolbar.tsx", "MobileOrderCard.tsx"]) expect(read(f), f).toContain("min-h-11");
    expect(read("States.tsx")).toContain("min-h-11");
  });
  it("StatusBadge: أيقونة لكل حالة أوردر + aria-hidden؛ الخصائص القديمة محفوظة", () => {
    const s = read("StatusBadge.tsx");
    for (const k of ["new", "confirmed", "printed", "preparing", "shipped", "delivered", "postponed", "no_answer", "cancelled", "returned"]) expect(s).toMatch(new RegExp(`${k}:\\s*\\{[^}]*icon:`));
    expect(s).toContain('aria-hidden="true"'); expect(s).toContain("data-status"); expect(s).toContain("title={text}");
    for (const p of ["status", "kind", "label", "tone", "size", "className"]) expect(s).toMatch(new RegExp(`\\b${p}\\??:`));
  });
  it("StatusBadge: أسماء/قيم حالات الأوردر لم تتغيّر", () => {
    const s = read("StatusBadge.tsx");
    const labels: Record<string, string> = { new: "جديد", confirmed: "مؤكد", printed: "مطبوع", preparing: "قيد التحضير", shipped: "تم الشحن", delivered: "تم التوصيل", postponed: "مؤجل", no_answer: "لم يرد", cancelled: "ملغي", returned: "مرتجع" };
    for (const [k, v] of Object.entries(labels)) expect(s).toMatch(new RegExp(`${k}:\\s*\\{\\s*label:\\s*"${v}"`));
  });
});
