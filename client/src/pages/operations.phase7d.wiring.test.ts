/**
 * المرحلة 7D — حارس نصّي لصفحات التشغيل والشحن والورشة: الاستعلامات والـmutations كما كانت قبل تغيير
 * العرض (commit 9f0ea04)، قواعد التحقق والتصنيف كما هي، شعار Bosta فقط حيث الناقل Bosta، لا ألوان خام،
 * أهداف لمس 44px، وحارس الضغط المكرر على الطباعة/الإرسال.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const read = (p: string) => strip(readFileSync(path.join(root, p), "utf8"));
const hooks = (src: string) => [...src.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);

const PAGES: Record<string, { file: string; before: string[] }> = {
  Preparation: { file: "pages/Preparation.tsx", before: ["trpc.orders.list.useQuery", "trpc.orders.statusCounts.useQuery", "trpc.printLogs.create.useMutation"] },
  TodayShipments: { file: "pages/TodayShipments.tsx", before: ["trpc.employeePortal.me.useQuery", "trpc.employeePortal.todayShipments.useQuery"] },
  ShippingSchedule: { file: "pages/ShippingSchedule.tsx", before: ["trpc.employeePortal.me.useQuery", "trpc.employeePortal.shippingRoutes.useQuery"] },
  BostaOrders: { file: "pages/BostaOrders.tsx", before: ["trpc.orders.bostaOrdersSummary.useQuery", "trpc.orders.bostaOrders.useQuery"] },
  Returns: { file: "pages/Returns.tsx", before: ["trpc.returns.list.useQuery", "trpc.returns.stats.useQuery"] },
  WorkshopReturns: { file: "pages/WorkshopReturns.tsx", before: ["trpc.accountingV2.workshopSetup.useQuery", "trpc.products.list.useQuery", "trpc.variants.all.useQuery", "trpc.accountingV2.workshopBatches.useQuery", "trpc.accountingV2.workshopSend.useMutation", "trpc.accountingV2.workshopReceive.useMutation", "trpc.accountingV2.workshopSetWarehouse.useMutation"] },
  PrintedOrders: { file: "pages/PrintedOrders.tsx", before: ["trpc.orders.list.useQuery"] },
  PrintLogs: { file: "pages/PrintLogs.tsx", before: ["trpc.printLogs.list.useQuery"] },
  ScanOrders: { file: "pages/ScanOrders.tsx", before: ["trpc.orders.scan.useMutation"] },
  TodayShipmentsWorkspace: { file: "pages/operations/TodayShipmentsWorkspace.tsx", before: ["trpc.operations.todayShipments.useQuery"] },
  ShippingScheduleWorkspace: { file: "pages/operations/ShippingScheduleWorkspace.tsx", before: ["trpc.operations.shippingRoutes.useQuery"] },
};

describe("🔌 Queries/Mutations قبل = بعد (12 صفحة)", () => {
  for (const [name, { file, before }] of Object.entries(PAGES)) {
    it(`${name}: نفس الـhooks بالترتيب نفسه`, () => {
      expect(hooks(read(file))).toEqual(before);
    });
  }
  it("ScanLogs: orders.scanLogsReport مكتوب النوع (من غير cast يخبّي مسار غلط → 404)", () => {
    const page = read("pages/ScanLogs.tsx");
    expect(page).toContain("trpc.orders.scanLogsReport.useQuery(");
    expect(page).not.toContain("employeePortal as any");
  });
});

describe("📋 القواعد كما هي", () => {
  it("التجهيز: التحقق من البيانات الناقصة قبل شيت الشحن + سجل الطباعة + الروابط نفسها", () => {
    const p = read("pages/Preparation.tsx");
    for (const s of ["!o.customerPhone || String(o.customerPhone).length < 10", "window.open(`/api/export/print-labels?", "window.open(`/api/export/shipping?", 'savePrintLogMutation.mutate({ type: "labels"', 'savePrintLogMutation.mutate({ type: "shipping_sheet"', 'statuses: filterStatus === "all" ? ["confirmed", "printed"] : [filterStatus]']) expect(p, s).toContain(s);
    // حارس الضغط المكرر على الطباعة/الشيت
    expect(p).toContain("const [printing, setPrinting] = useState(false)");
    expect(p).toContain("if (printing || savePrintLogMutation.isPending) return;");
    expect(p).toContain("selectedKeys={selectedKeys}");
  });
  it("المطبوعات: قاعدة «في بوسطة» كما كانت (bostaLastError) وشعار Bosta فقط عندها؛ إعادة الطباعة بحارس", () => {
    const p = read("pages/PrintedOrders.tsx");
    expect(p).toContain("o.bostaLastError?.includes('successfully')");
    expect(p).toContain('<PartnerLogo partner="bosta"');
    expect(p).toContain("isBosta ?");
    expect(p).toContain("if (printing) return;");
    expect(p).toContain("window.open(`/api/export/print-labels?");
  });
  it("الورشة: التحقق كما هو، الإرسال/الاستلام بنفس الـpayload، وحارس ضغط مكرر", () => {
    const p = read("pages/WorkshopReturns.tsx");
    for (const s of ['if (!reason.trim()) next.reason = "سبب الإرسال مطلوب";', "repairCostPerPiece: repairCost ? Number(repairCost).toFixed(4) : undefined,", "sendReference: batch.reference,", "lines: batch.lines,"]) expect(p, s).toContain(s);
    expect(p).toContain("createInFlightGuard");
  });
  it("Bosta: الصفحة مخصصة لبوسطة فالشعار في الرأس؛ التصنيف كما كان", () => {
    const p = read("pages/BostaOrders.tsx");
    expect(p).toContain('<PartnerLogo partner="bosta"');
    expect(p).toContain('if (order.bostaLastError && !order.bostaShipmentId) return "send_failed";');
    expect(p).toContain('cardsBelow="md"');
  });
  it("كشف الشحنات: لا ألوان Tailwind خام — ألوان الوكلاء من tokens الرسوم", () => {
    const m = readFileSync(path.join(root, "components/operations/ShipmentsManifest.tsx"), "utf8");
    expect(m).not.toMatch(/\b(bg|text|border|from|to)-(blue|emerald|amber|gray|stone|slate)-\d{2,3}\b/);
    expect(m).toContain("--chart-"); expect(m).toContain("var(${token})");
  });
  it("بوابة الموظف (شحنات اليوم/جدول الشحن): بلا ألوان خام، أزرار 44px", () => {
    for (const f of ["pages/TodayShipments.tsx", "pages/ShippingSchedule.tsx"]) {
      const p = read(f);
      expect(p, f).not.toMatch(/\b(bg|text|border)-(stone|amber|slate)-\d{2,3}\b/);
      const buttons = p.match(/<Button\b(?:=>|> 0|[^>])*>/gs) ?? [];
      for (const b of buttons) expect(b, f + " " + b.slice(0, 60)).toMatch(/min-h-11|h-11/);
    }
  });
});

describe("📱 جدول Desktop / بطاقات Mobile + حالات مشتركة", () => {
  for (const f of ["pages/Preparation.tsx", "pages/PrintedOrders.tsx", "pages/ScanLogs.tsx", "pages/Returns.tsx", "pages/WorkshopReturns.tsx"]) {
    it(`${f}: ResponsiveDataTable بـcardsBelow="md" وmobileRow، بلا <table> يدوي`, () => {
      const p = read(f);
      expect(p).toContain("<ResponsiveDataTable");
      expect(p).toContain('cardsBelow="md"');
      expect(p).toContain("mobileRow=");
      expect(p).not.toContain("<table");
    });
  }
  for (const f of ["pages/Preparation.tsx", "pages/PrintedOrders.tsx", "pages/PrintLogs.tsx", "pages/ScanLogs.tsx", "pages/Returns.tsx", "pages/WorkshopReturns.tsx", "pages/ScanOrders.tsx", "pages/BostaOrders.tsx"]) {
    it(`${f}: كل Button بهدف لمس 44px على الهاتف`, () => {
      const p = read(f);
      const buttons = p.match(/<Button\b(?:=>|> 0|[^>])*>/gs) ?? [];
      expect(buttons.length).toBeGreaterThan(0);
      for (const b of buttons) expect(b, f + " " + b.slice(0, 70)).toMatch(/min-h-11|h-11|\{TOUCH\}|\$\{TOUCH\}/);
    });
  }
  it("لا ألوان Tailwind خام ولا emoji في صفحات 7D", () => {
    for (const f of ["pages/Preparation.tsx", "pages/PrintedOrders.tsx", "pages/PrintLogs.tsx", "pages/ScanLogs.tsx", "pages/Returns.tsx", "pages/WorkshopReturns.tsx", "pages/BostaOrders.tsx"]) {
      const p = read(f);
      expect(p, f).not.toMatch(/\b(bg|text|border)-(gray|stone|slate|blue|amber|emerald|green|red)-\d{2,3}\b/);
    }
    expect(read("pages/Returns.tsx")).not.toContain("📦");
  });
});
