import { and, eq, inArray } from "drizzle-orm";
import { businessConfigurationValues } from "../drizzle/schema";
import { getDb, getOrders } from "./db";
import {
  groupOrdersByAgent,
  getTodaySchedule,
  DAY_NAMES_AR,
  type ShippingRouteRule,
} from "./shippingSchedules";

/**
 * قراءات شاشات الشحن (شحنات اليوم + جدول الشحن) — مصدر واحد لجمهورين:
 *   • بوابة الموظفين (`employeePortal.*` — كوكي employee_token، موظف الشحن).
 *   • Operations workspace بتاع المالك/المدير (`operations.*` — جلسة الداشبورد).
 *
 * الدوال دي **مابتقررش النطاق**: بتاخد `businessIds` محسوبة ومتحقّق منها من الـprocedure
 * اللي بتناديها (sessionBusinessIds / scopeBusinessIds). المنطق اتنقل من routers.ts كما هو
 * بالظبط — مفيش تغيير سلوك للبوابة.
 */

/** مسارات جدول الشحن الفعّالة للأنشطة المحددة (مرتبة بـsortOrder ثم الاسم). */
export async function loadShippingRouteRows(businessIds: number[]) {
  const db = await getDb();
  if (!db || businessIds.length === 0) return [];
  const rows = await db
    .select()
    .from(businessConfigurationValues)
    .where(
      and(
        inArray(businessConfigurationValues.businessId, businessIds),
        eq(businessConfigurationValues.namespace, "shipping_schedule_route"),
        eq(businessConfigurationValues.isActive, true)
      )
    )
    .orderBy(
      businessConfigurationValues.sortOrder,
      businessConfigurationValues.displayName
    );
  return rows;
}

/** كشف شحنات يوم معيّن: الأوردرات المؤكدة موزّعة على شركات الشحن حسب جدول اليوم. */
export async function buildTodayShipments(
  businessIds: number[],
  date: string | undefined
) {
  // Determine target date
  const targetDate = date ? new Date(date + "T00:00:00") : new Date();
  const dayOfWeek = targetDate.getDay(); // 0=Sun, 6=Sat

  // Fetch confirmed orders (no date filter — we want all confirmed orders ready for shipping)
  const result = await getOrders({
    status: "confirmed",
    limit: 10000,
    businessIds,
  });
  const allConfirmed = result.orders;

  const db = await getDb();
  const routeRows =
    db && businessIds.length
      ? await db
          .select()
          .from(businessConfigurationValues)
          .where(
            and(
              inArray(businessConfigurationValues.businessId, businessIds),
              eq(
                businessConfigurationValues.namespace,
                "shipping_schedule_route"
              ),
              eq(businessConfigurationValues.isActive, true)
            )
          )
      : [];
  const routes = routeRows.flatMap(row => {
    try {
      const value = JSON.parse(row.valueJson ?? "{}") as ShippingRouteRule;
      return value.providerName &&
        Number.isInteger(value.dayOfWeek) &&
        Array.isArray(value.governorates)
        ? [value]
        : [];
    } catch {
      return [];
    }
  });

  // Group by shipping agent based on governorate + day schedule
  const grouped = groupOrdersByAgent(allConfirmed, dayOfWeek, routes);

  // Get today's schedule
  const schedule = getTodaySchedule(dayOfWeek, routes);

  // Build response with agent info
  const agents = Object.entries(grouped).map(([agentName, agentOrders]) => {
    const totalAmount = agentOrders.reduce(
      (sum, o) => sum + Number(o.totalAmount || 0),
      0
    );
    return {
      agentName,
      governorates: schedule[agentName] || [],
      orders: agentOrders.map(o => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        customerAddress: o.customerAddress,
        governorate: o.governorate,
        productName: o.productName,
        quantity: o.quantity,
        totalAmount: o.totalAmount,
        notes: o.notes,
        confirmedAt: o.confirmedAt,
      })),
      orderCount: agentOrders.length,
      totalAmount,
    };
  });

  // Also include agents from schedule that have 0 orders
  for (const agentName of Object.keys(schedule)) {
    if (!grouped[agentName]) {
      agents.push({
        agentName,
        governorates: schedule[agentName],
        orders: [],
        orderCount: 0,
        totalAmount: 0,
      });
    }
  }

  return {
    date: targetDate.toISOString().split("T")[0],
    dayName: DAY_NAMES_AR[dayOfWeek] || "",
    dayOfWeek,
    agents,
    totalOrders: allConfirmed.length,
  };
}
