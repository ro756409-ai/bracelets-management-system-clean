import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * shippingOperations.service — المنطق اللي اتنقل من employeePortal (سلوكي، DB متزيّفة).
 * بيقفل إن النقل ماغيّرش الكشف: الأوردرات المؤكدة بتتوزع على شركة الشحن حسب محافظة + يوم،
 * والشركة المجدولة من غير أوردرات بتظهر بصفر، والنطاق اللي جاي بيتمرّر زي ما هو.
 */

const state = vi.hoisted(() => ({
  routeRows: [] as { valueJson: string | null }[],
  orders: [] as any[],
  getOrdersArgs: [] as any[],
  dbAvailable: true,
}));

vi.mock("./db", () => {
  const rowsPromise = () => {
    const p: any = Promise.resolve(state.routeRows);
    p.orderBy = () => Promise.resolve(state.routeRows);
    return p;
  };
  const chain: any = { from: () => chain, where: () => rowsPromise() };
  return {
    getDb: vi.fn(async () => (state.dbAvailable ? { select: () => chain } : null)),
    getOrders: vi.fn(async (filters: any) => {
      state.getOrdersArgs.push(filters);
      return { orders: state.orders, total: state.orders.length };
    }),
  };
});

const { buildTodayShipments, loadShippingRouteRows } = await import("./shippingOperations.service");

const route = (providerName: string, dayOfWeek: number, governorates: string[], priority = 0) => ({
  valueJson: JSON.stringify({ providerName, dayOfWeek, governorates, priority }),
});

const order = (id: number, governorate: string, totalAmount = "100") => ({
  id, orderNumber: `${id}`, customerName: "عميل", customerPhone: "01000000000", customerAddress: "عنوان",
  governorate, productName: "اسورة", quantity: 1, totalAmount, notes: null, confirmedAt: null,
  businessId: 7, status: "confirmed",
});

beforeEach(() => {
  state.routeRows = [];
  state.orders = [];
  state.getOrdersArgs = [];
  state.dbAvailable = true;
});

describe("🔑 buildTodayShipments — نفس كشف البوابة", () => {
  it("🔑 بيجيب المؤكد بس، بالنطاق اللي اتبعت", async () => {
    await buildTodayShipments([7, 8], "2026-09-13");
    expect(state.getOrdersArgs[0]).toEqual({ status: "confirmed", limit: 10000, businessIds: [7, 8] });
  });

  it("🔑 التوزيع حسب محافظة + يوم الأسبوع، والإجماليات صح", async () => {
    // 2026-09-13 = الأحد (0)
    state.routeRows = [route("الشبح", 0, ["القاهرة"], 2), route("العالمية", 0, ["الجيزة"]), route("المتخصص", 1, ["القاهرة"])];
    state.orders = [order(1, "القاهرة", "150"), order(2, "القاهرة", "50"), order(3, "الجيزة"), order(4, "أسوان")];

    const result = await buildTodayShipments([7], "2026-09-13");
    // ملاحظة: `result.date` بيطلع يوم قبله في منطقة زمنية شرق UTC (منتصف ليل محلي →
    // toISOString). سلوك قديم اتنقل كما هو والواجهة مابتقراهوش — متسجّل كـbug، مش مقفول هنا.
    expect(result.dayOfWeek).toBe(0);
    expect(result.dayName).toBe("الأحد");
    expect(result.totalOrders).toBe(4);

    const byName = Object.fromEntries(result.agents.map(a => [a.agentName, a]));
    expect(byName["الشبح"].orders.map(o => o.id)).toEqual([1, 2]);
    expect(byName["الشبح"].totalAmount).toBe(200);
    expect(byName["الشبح"].governorates).toEqual(["القاهرة"]);
    expect(byName["العالمية"].orderCount).toBe(1);
    // محافظة مالهاش مسار النهارده → «غير محدد»، ومسار يوم تاني مايدخلش.
    expect(byName["غير محدد"].orders.map(o => o.id)).toEqual([4]);
    expect(byName["المتخصص"]).toBeUndefined();
  });

  it("🔑 شركة مجدولة النهارده من غير أوردرات بتظهر بصفر", async () => {
    state.routeRows = [route("الشبح", 0, ["القاهرة"]), route("العالمية", 0, ["الجيزة"])];
    state.orders = [order(1, "القاهرة")];
    const result = await buildTodayShipments([7], "2026-09-13");
    const empty = result.agents.find(a => a.agentName === "العالمية")!;
    expect(empty).toMatchObject({ orders: [], orderCount: 0, totalAmount: 0, governorates: ["الجيزة"] });
  });

  it("صف مسار تالف مايكسرش الكشف", async () => {
    state.routeRows = [{ valueJson: "{bad" }, route("الشبح", 0, ["القاهرة"])];
    state.orders = [order(1, "القاهرة")];
    const result = await buildTodayShipments([7], "2026-09-13");
    expect(result.agents.map(a => a.agentName)).toEqual(["الشبح"]);
  });
});

describe("loadShippingRouteRows", () => {
  it("🔑 نطاق فاضي → [] من غير ما يلمس الـDB", async () => {
    state.routeRows = [route("الشبح", 0, ["القاهرة"])];
    expect(await loadShippingRouteRows([])).toEqual([]);
  });
  it("بيرجّع الصفوف للنطاق", async () => {
    state.routeRows = [route("الشبح", 0, ["القاهرة"])];
    expect(await loadShippingRouteRows([7])).toEqual(state.routeRows);
  });
  it("DB مش متاحة → []", async () => {
    state.dbAvailable = false;
    expect(await loadShippingRouteRows([7])).toEqual([]);
  });
});
