/**
 * منطق عرض شاشات الشحن (شحنات اليوم + جدول الشحن) — pure، من غير DOM ولا API.
 *
 * مشترك بين صفحات بوابة الموظفين (TodayShipments / ShippingSchedule) وتبويبات Operations
 * workspace بتاع المالك، فالفلترة والتحليل نسخة واحدة. اتنقل من الصفحتين كما هو.
 */

export type ShipmentOrder = {
  id: number;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  governorate: string;
  productName: string;
  quantity: number;
  totalAmount: string;
  notes?: string | null;
  confirmedAt?: Date | null;
};

export type AgentGroup = {
  agentName: string;
  governorates: string[];
  orders: ShipmentOrder[];
  orderCount: number;
  totalAmount: number;
};

/** بحث كشف الشحنات (اسم/تليفون/رقم أوردر/محافظة) — شركات الشحن اللي مفيهاش نتائج بتختفي. */
export function filterShipmentAgents(agents: AgentGroup[] | undefined, search: string): AgentGroup[] {
  if (!agents) return [];
  if (!search.trim()) return agents;

  const s = search.trim().toLowerCase();
  const matches = (o: ShipmentOrder) =>
    o.customerName.toLowerCase().includes(s) ||
    o.customerPhone.includes(s) ||
    o.orderNumber.includes(s) ||
    o.governorate.toLowerCase().includes(s);

  return agents
    .map(agent => {
      const orders = agent.orders.filter(matches);
      return { ...agent, orders, orderCount: orders.length };
    })
    .filter(a => a.orderCount > 0);
}

export function totalShipmentOrders(agents: AgentGroup[]): number {
  return agents.reduce((sum, a) => sum + a.orderCount, 0);
}

export const SHIPPING_DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export type ShippingRouteView = {
  providerName: string;
  dayOfWeek: number;
  governorates: string[];
  priority: number;
  notes?: string;
};

/** صفوف `shipping_schedule_route` → مسارات صالحة للعرض (الصف التالف بيتجاهل بدل ما يكسر الشاشة). */
export function parseShippingRouteRows(rows: { valueJson?: string | null }[] | undefined): ShippingRouteView[] {
  return (rows ?? []).flatMap(row => {
    try {
      const value = JSON.parse(row.valueJson ?? "{}") as Partial<ShippingRouteView>;
      return value.providerName && Number.isInteger(value.dayOfWeek) && Array.isArray(value.governorates)
        ? [{ ...value, dayOfWeek: value.dayOfWeek!, providerName: value.providerName!, governorates: value.governorates!, priority: value.priority ?? 0 }]
        : [];
    } catch {
      return [];
    }
  });
}
