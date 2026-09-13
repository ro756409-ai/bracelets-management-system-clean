import { describe, it, expect } from "vitest";
import {
  filterShipmentAgents,
  totalShipmentOrders,
  parseShippingRouteRows,
  type AgentGroup,
} from "./shippingOperations";

/**
 * منطق شاشات الشحن المشترك (بوابة الموظفين + Operations workspace) — سلوكي مش نصّي.
 * الفلترة والتحليل اتنقلوا من الصفحتين كما هم؛ الاختبارات دي بتقفل نفس السلوك.
 */

const order = (id: number, over: Partial<AgentGroup["orders"][number]> = {}) => ({
  id,
  orderNumber: `10${id}`,
  customerName: `عميل ${id}`,
  customerPhone: `0100000000${id}`,
  customerAddress: "شارع",
  governorate: "القاهرة",
  productName: "اسورة",
  quantity: 1,
  totalAmount: "100",
  ...over,
});

const agents: AgentGroup[] = [
  { agentName: "الشبح", governorates: ["القاهرة"], orders: [order(1), order(2, { governorate: "الجيزة" })], orderCount: 2, totalAmount: 200 },
  { agentName: "العالمية", governorates: ["أسيوط"], orders: [order(3, { customerName: "Ahmed", governorate: "أسيوط" })], orderCount: 1, totalAmount: 100 },
  { agentName: "المتخصص", governorates: ["سوهاج"], orders: [], orderCount: 0, totalAmount: 0 },
];

describe("🔑 filterShipmentAgents — نفس بحث كشف الشحنات", () => {
  it("من غير بحث بيرجّع الكل زي ما هو (حتى شركة من غير أوردرات)", () => {
    expect(filterShipmentAgents(agents, "   ")).toBe(agents);
    expect(filterShipmentAgents(undefined, "x")).toEqual([]);
  });

  it("🔑 بيفلتر بالاسم/التليفون/رقم الأوردر/المحافظة ويعيد حساب orderCount", () => {
    const byGov = filterShipmentAgents(agents, "الجيزة");
    expect(byGov).toHaveLength(1);
    expect(byGov[0].agentName).toBe("الشبح");
    expect(byGov[0].orders.map(o => o.id)).toEqual([2]);
    expect(byGov[0].orderCount).toBe(1);

    expect(filterShipmentAgents(agents, "ahmed")[0].agentName).toBe("العالمية"); // case-insensitive
    expect(filterShipmentAgents(agents, "01000000001")[0].orders[0].id).toBe(1);
    expect(filterShipmentAgents(agents, "103")[0].orders[0].id).toBe(3);
  });

  it("🔑 الشركات اللي مالهاش نتائج بتختفي", () => {
    expect(filterShipmentAgents(agents, "مش موجود")).toEqual([]);
  });

  it("totalShipmentOrders = مجموع orderCount", () => {
    expect(totalShipmentOrders(agents)).toBe(3);
    expect(totalShipmentOrders([])).toBe(0);
  });
});

describe("🔑 parseShippingRouteRows — الصف التالف مايكسرش الشاشة", () => {
  it("🔑 بيقبل الصالح بس ويكمّل priority الناقصة بصفر", () => {
    const parsed = parseShippingRouteRows([
      { valueJson: JSON.stringify({ providerName: "الشبح", dayOfWeek: 0, governorates: ["القاهرة"] }) },
      { valueJson: JSON.stringify({ providerName: "العالمية", dayOfWeek: 2, governorates: ["أسيوط"], priority: 5, notes: "صباحي" }) },
      { valueJson: "{not json" },
      { valueJson: JSON.stringify({ providerName: "ناقص يوم", governorates: [] }) },
      { valueJson: JSON.stringify({ providerName: "محافظات مش مصفوفة", dayOfWeek: 1, governorates: "القاهرة" }) },
      { valueJson: null },
    ]);
    expect(parsed).toEqual([
      { providerName: "الشبح", dayOfWeek: 0, governorates: ["القاهرة"], priority: 0 },
      { providerName: "العالمية", dayOfWeek: 2, governorates: ["أسيوط"], priority: 5, notes: "صباحي" },
    ]);
  });
  it("undefined → فاضي", () => {
    expect(parseShippingRouteRows(undefined)).toEqual([]);
  });
});
