export interface ShippingRouteRule {
  providerName: string;
  dayOfWeek: number;
  governorates: string[];
  priority: number;
  notes?: string;
}

export const DAY_NAMES_AR: Record<number, string> = {
  0: "الأحد",
  1: "الاثنين",
  2: "الثلاثاء",
  3: "الأربعاء",
  4: "الخميس",
  5: "الجمعة",
  6: "السبت",
};

function normalized(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function getAgentsForGovernorateOnDay(
  governorate: string,
  dayOfWeek: number,
  routes: ShippingRouteRule[]
): string[] {
  const target = normalized(governorate);
  return routes
    .filter(
      route =>
        route.dayOfWeek === dayOfWeek &&
        route.governorates.some(value => normalized(value) === target)
    )
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.providerName.localeCompare(b.providerName, "ar")
    )
    .map(route => route.providerName);
}

export function getTodaySchedule(
  dayOfWeek: number,
  routes: ShippingRouteRule[]
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const route of routes
    .filter(row => row.dayOfWeek === dayOfWeek)
    .sort((a, b) => b.priority - a.priority)) {
    result[route.providerName] = [
      ...new Set([
        ...(result[route.providerName] ?? []),
        ...route.governorates,
      ]),
    ];
  }
  return result;
}

export function groupOrdersByAgent<T extends { governorate: string }>(
  orders: T[],
  dayOfWeek: number,
  routes: ShippingRouteRule[]
): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const order of orders) {
    const primaryAgent =
      getAgentsForGovernorateOnDay(order.governorate, dayOfWeek, routes)[0] ??
      "غير محدد";
    (groups[primaryAgent] ??= []).push(order);
  }
  return groups;
}
