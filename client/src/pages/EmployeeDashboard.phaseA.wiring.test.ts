/**
 * Phase A — بوابة تأكيد الموظف على نظام التصميم المشترك (عرض فقط): لا <button> خام خارج الهيدر،
 * لا <table> يدوي، لا <input type="date"> خام؛ حالة خطأ للأوردرات بإعادة محاولة (لا «لا توجد أوردرات»
 * عند الخطأ)، OfflineState، SearchInput، ResponsiveDataTable للمخزون؛ والـ23 hook بنفس الترتيب.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const src = strip(readFileSync(path.join(root, "pages/EmployeeDashboard.tsx"), "utf8"));
const hooks = (s: string) => [...s.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);

describe("EmployeeDashboard — Phase A view layer", () => {
  it("no raw <button> outside the header (the 8 header buttons stay raw, pinned by qa.phase8)", () => {
    const header = src.slice(src.indexOf("<header"), src.indexOf("</header>"));
    expect((header.match(/<button\b/g) ?? []).length).toBe(8);
    const outside = src.slice(0, src.indexOf("<header")) + src.slice(src.indexOf("</header>"));
    expect(outside).not.toMatch(/<button\b/);
  });

  it("no hand-rolled <table> and no raw <input type=\"date\">", () => {
    expect(src).not.toContain("<table");
    expect(src).not.toMatch(/<input\b[^>]*type="date"/s);
    expect((src.match(/<Input\s[^>]*type="date"/gs) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("myOrders error → ErrorState with retry, checked before the empty state", () => {
    expect(src).toContain("isError: ordersIsError");
    const list = src.slice(src.indexOf("ordersIsError && !ordersData ? ("));
    const errorAt = list.indexOf("<ErrorState");
    const emptyAt = list.indexOf('title="لا توجد أوردرات"');
    expect(errorAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(errorAt);
    expect(list.slice(errorAt, emptyAt)).toContain("onRetry={() => refetch()}");
  });

  it("OfflineState shown while offline (useOnlineStatus is not a tRPC hook)", () => {
    expect(src).toContain('import { useOnlineStatus } from "@/hooks/useOnlineStatus";');
    expect(src).toContain("const online = useOnlineStatus();");
    expect(src).toMatch(/\{!online && \(\s*<OfflineState/);
  });

  it("search uses the shared SearchInput with the same client-side filter", () => {
    expect(src).toMatch(/<SearchInput\s[^>]*value=\{search\}/s);
    expect(src).toContain("onChange={setSearch}");
    expect(src).toContain("o.customerName.toLowerCase().includes(q) ||");
  });

  it("stock variants via ResponsiveDataTable (cards below md), with loading/error states", () => {
    expect(src).toMatch(/<ResponsiveDataTable[\s\S]*?cardsBelow="md"[\s\S]*?mobileRow=/);
    expect(src).toContain('title="تعذّر تحميل المخزون"');
    expect(src).toContain('<LoadingSkeleton variant="cards" rows={4} />');
  });

  it("the 23 original tRPC hooks are unchanged and in the same order (+1 deliberate: portal permissions for the shipping links)", () => {
    expect(hooks(src)).toEqual([
      // أُضيف عن قصد (روابط الشحن): صلاحيات هوية البوابة — قراءة بس، قبل باقي الـhooks.
      "trpc.employeePortal.myPermissions.useQuery",
      "trpc.employeePortal.me.useQuery",
      "trpc.businesses.groupsWithBusinesses.useQuery",
      "trpc.employeePortal.stats.useQuery",
      "trpc.employeePortal.activeBroadcast.useQuery",
      "trpc.employeePortal.stockLevels.useQuery",
      "trpc.employeePortal.stockLevels.useQuery",
      "trpc.employeePortal.stockVariants.useQuery",
      "trpc.employeePortal.orderItems.useQuery",
      "trpc.employeePortal.myOrders.useQuery",
      "trpc.employeePortal.confirm.useMutation",
      "trpc.employeePortal.postpone.useMutation",
      "trpc.employeePortal.cancel.useMutation",
      "trpc.employeePortal.markNoAnswer.useMutation",
      "trpc.employeePortal.updateStatus.useMutation",
      "trpc.employeePortal.updateNotes.useMutation",
      "trpc.employeePortal.editOrder.useMutation",
      "trpc.employeePortal.editOrderItems.useMutation",
      "trpc.employeePortal.markDuplicate.useMutation",
      "trpc.employeePortal.unmarkDuplicate.useMutation",
      "trpc.employeePortal.scan.useMutation",
      "trpc.employeePortal.getOrderEditHistory.useQuery",
      "trpc.tasks.list.useQuery",
      "trpc.tasks.updateStatus.useMutation",
    ]);
  });

  it("no white/black utilities and no hard-coded rounded-xl/2xl", () => {
    expect(src).not.toMatch(/\b(text|bg|border)-(white|black)\b/);
    expect(src).not.toMatch(/\brounded-(xl|2xl)\b/);
  });
});

describe("روابط الهيدر لمسارات الشحن — صفحة المنع عليها <main> واحد", () => {
  // زرّا «شحنات اليوم» و«جدول توزيع المحافظات» يظهران لكل موظف (إخفاؤهما يحتاج صلاحيات الجلسة من السيرفر — قرار Backend
  // موثّق). لذلك حالة المنع/التحميل في الصفحتين لازم تكون landmark صحيح: <main> مش <div>.
  it("TodayShipments: حالة «مش من مهامك» داخل <main>", () => {
    const s = readFileSync(path.join(root, "pages/TodayShipments.tsx"), "utf8");
    const denied = s.slice(s.indexOf("if (shipmentsError)"), s.indexOf("شحنات اليوم مش من مهامك"));
    expect(denied).toContain('<main className="flex min-h-screen');
  });
  it("ShippingSchedule: التحميل وعدم الجلسة والمنع كلها داخل <main>", () => {
    const s = readFileSync(path.join(root, "pages/ShippingSchedule.tsx"), "utf8");
    for (const guard of ["if (isLoading || routes.isLoading) return <main", "if (!employee) return <main", "if (routes.error) return <main"]) expect(s, guard).toContain(guard);
  });
});
