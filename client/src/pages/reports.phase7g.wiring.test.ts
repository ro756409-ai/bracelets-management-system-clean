/**
 * المرحلة 7G — حارس نصّي للتقارير: نفس الاستعلامات الثلاثة والفترات والحارس enabled: isAdmin، كل رقم له
 * مصدر مذكور، رسوم بألوان tokens (لا hex ولا أحمر افتراضي) مع جدول بديل لقارئ الشاشة، لا حساب نِسَب جديد،
 * ولا <table> يدوي للأداء (ResponsiveDataTable).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const src = strip(readFileSync(path.join(root, "pages/Reports.tsx"), "utf8"));
const hooks = [...src.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);

describe("🔌 التقارير — الاستعلامات والفترات كما هي", () => {
  it("نفس الثلاثة بالترتيب، كلها خلف enabled: isAdmin، ولا mutation", () => {
    expect(hooks).toEqual(["trpc.reports.employeePerformance.useQuery", "trpc.reports.cancellationReasons.useQuery", "trpc.reports.dailyChart.useQuery"]);
    expect((src.match(/enabled: isAdmin/g) ?? []).length).toBe(3);
  });
  it("الفترات الثلاث ونطاق الأنشطة كما كانت", () => {
    expect(src).toContain('type DateRange = "today" | "week" | "month";');
    expect(src).toContain("start.setDate(now.getDate() - 7)");
    expect(src).toContain("start.setDate(now.getDate() - 30)");
    expect(src).toContain("days: dateRange === 'today' ? 1 : dateRange === 'week' ? 7 : 30, businessIds: currentBusinessIds");
    expect(src).toContain("businessIds: currentBusinessIds,");
  });
  it("لا حساب جديد: النِّسَب من السيرفر (confirmRate/cancelRate) والعتبات كما كانت؛ الترتيب على نسخة", () => {
    expect(src).toContain("rate={e.confirmRate}");
    expect(src).toContain("cancelBadge(e.cancelRate)");
    expect(src).toContain("rate >= 70 ?");
    expect(src).toContain("rate <= 20 ?");
    expect(src).toContain("[...(perfData ?? [])].sort((a, b) => b.confirmRate - a.confirmRate)");
    expect(src).not.toMatch(/perfData\s*\.sort\(/);
  });
});

describe("🎨 الرسوم والهوية", () => {
  it("ألوان الرسوم من tokens فقط — لا hex ولا ألوان Tailwind خام ولا أحمر افتراضي", () => {
    expect(src).not.toMatch(/"#[0-9a-fA-F]{3,6}"/);
    expect(src).not.toMatch(/\b(bg|text|border|fill|stroke)-(gray|stone|slate|blue|amber|emerald|green|red|purple|violet|indigo|yellow|orange|rose|sky|cyan|teal)-\d{2,3}\b/);
    expect(src).toContain('fill="var(--chart-2)"'); expect(src).toContain('fill="var(--chart-3)"'); expect(src).toContain('fill="var(--chart-4)"');
    expect(src).toContain('const CANCEL_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];');
  });
  it("لكل رسم جدول بديل sr-only، والرسم نفسه aria-hidden", () => {
    expect(src).toContain('data-testid="reports-daily-table"');
    expect(src).toContain('data-testid="reports-cancel-table"');
    expect((src.match(/<table className="sr-only"/g) ?? []).length).toBe(2);
    expect((src.match(/<div aria-hidden="true">\s*<ResponsiveContainer/g) ?? []).length).toBe(2);
  });
  it("كل رقم يذكر مصدره (hint/description بالاستعلام)", () => {
    expect(src).toContain('hint="مجموع أيام الفترة من reports.dailyChart"');
    expect(src).toContain('description="حسب تاريخ الإنشاء — المصدر reports.dailyChart"');
    expect(src).toContain('description="المصدر reports.cancellationReasons"');
    expect(src).toContain('description="المصدر reports.employeePerformance — مرتّب بنسبة التأكيد"');
  });
  it("جدول الأداء عبر ResponsiveDataTable (بطاقات على الهاتف) بلا <table> يدوي؛ أزرار الفترة 44px؛ غير المدير PermissionDenied", () => {
    expect(src).toContain("<ResponsiveDataTable<any>");
    expect(src).toContain('cardsBelow="md"');
    expect(src).not.toMatch(/<table className="w-full/);
    const buttons = src.match(/<Button\b(?:=>|> 0|[^>])*>/gs) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b).toMatch(/\{TOUCH\}|\$\{TOUCH\}|min-h-11/);
    expect(src).toContain("<PermissionDeniedState");
  });
});
