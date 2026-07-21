/**
 * Shipping schedules for الشبح (The Ghost) and العالمية (El-Alamia Express)
 * 
 * Each agent has a weekly schedule mapping day-of-week to governorates they serve.
 * Days: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
 */

export interface ShippingAgent {
  id: string;
  name: string;
  nameEn: string;
  /** day-of-week (0-6, 0=Sun) → list of governorates served that day */
  schedule: Record<number, string[]>;
  /** Governorates that are always served (every day except maybe Friday) */
  notes: string;
}

// Normalized governorate names matching the existing SHIPPING_AGENTS map
const COMMON_GHOST = [
  "الإسكندرية", "المنوفية", "الشرقية", "بني سويف",
  "الإسماعيلية", "السويس", "بور سعيد", "الغربية",
  "الدقهلية", "كفر الشيخ",
];

const COMMON_ALAMIA = [
  "الإسكندرية", "المنوفية", "الشرقية", "بني سويف", "الغربية",
];

export const SHIPPING_SCHEDULES: ShippingAgent[] = [
  {
    id: "ghost",
    name: "الشبح",
    nameEn: "The Ghost",
    schedule: {
      // 0 = Sunday (الأحد)
      0: [...COMMON_GHOST, "البحيرة"],
      // 1 = Monday (الاثنين)
      1: [...COMMON_GHOST, "الفيوم", "دمياط"],
      // 2 = Tuesday (الثلاثاء)
      2: [...COMMON_GHOST, "البحيرة"],
      // 3 = Wednesday (الأربعاء)
      3: [...COMMON_GHOST, "البحيرة", "مرسى مطروح"],
      // 4 = Thursday (الخميس)
      4: [...COMMON_GHOST, "الفيوم", "دمياط"],
      // 5 = Friday (الجمعة) — no service
      // 6 = Saturday (السبت)
      6: [...COMMON_GHOST, "الفيوم", "البحيرة"],
    },
    notes: "محافظات الصعيد: الأحد والأربعاء. الحساب: 12ظ - 5م يومياً ماعدا الجمعة. استلام الشحنات: 5م - 10م.",
  },
  {
    id: "alamia",
    name: "العالمية",
    nameEn: "El-Alamia Express",
    schedule: {
      // 0 = Sunday (الأحد)
      0: [...COMMON_ALAMIA, "الإسماعيلية", "السويس", "بور سعيد", "دمياط", "الفيوم", "الدقهلية"],
      // 1 = Monday (الاثنين)
      1: [...COMMON_ALAMIA, "الإسماعيلية", "السويس", "بور سعيد", "البحيرة", "الفيوم", "الدقهلية"],
      // 2 = Tuesday (الثلاثاء)
      2: [...COMMON_ALAMIA, "كفر الشيخ"],
      // 3 = Wednesday (الأربعاء)
      3: [...COMMON_ALAMIA, "الإسماعيلية", "السويس", "بور سعيد", "دمياط", "الفيوم", "الدقهلية"],
      // 4 = Thursday (الخميس) — no data shown, assume no service
      // 5 = Friday (الجمعة)
      5: [...COMMON_ALAMIA, "الإسماعيلية", "السويس", "بور سعيد", "البحيرة", "الفيوم", "الدقهلية"],
      // 6 = Saturday (السبت)
      6: [...COMMON_ALAMIA, "الإسماعيلية", "السويس", "بور سعيد", "كفر الشيخ"],
    },
    notes: "استلام الصعيد: السبت والأربعاء من كل أسبوع.",
  },
];

// Saeed / Upper Egypt governorates
const UPPER_EGYPT_GOVS = [
  "المنيا", "الفيوم", "بني سويف", "أسيوط", "سوهاج",
  "قنا", "الأقصر", "أسوان", "الوادي الجديد", "البحر الأحمر",
];

// Cairo/Giza area — handled separately (المتخصص)
const CAIRO_AREA_GOVS = [
  "القاهرة", "الجيزة", "القليوبية", "6 أكتوبر",
];

/** Day names in Arabic */
export const DAY_NAMES_AR: Record<number, string> = {
  0: "الأحد",
  1: "الاثنين",
  2: "الثلاثاء",
  3: "الأربعاء",
  4: "الخميس",
  5: "الجمعة",
  6: "السبت",
};

/**
 * Normalize governorate name for schedule matching.
 * Handles common variations (with/without ال, abbreviations, etc.)
 */
function normalizeGovForSchedule(gov: string): string {
  const g = gov.trim();
  // Direct match first
  const allGovs = new Set<string>();
  for (const agent of SHIPPING_SCHEDULES) {
    for (const govList of Object.values(agent.schedule)) {
      govList.forEach(gv => allGovs.add(gv));
    }
  }
  UPPER_EGYPT_GOVS.forEach(gv => allGovs.add(gv));
  CAIRO_AREA_GOVS.forEach(gv => allGovs.add(gv));

  if (allGovs.has(g)) return g;
  // Fuzzy match
  for (const known of Array.from(allGovs)) {
    if (g.includes(known) || known.includes(g)) return known;
  }
  return g;
}

/**
 * Determine which shipping agent(s) serve a governorate on a given day.
 * Returns array of agent names that can ship to this governorate today.
 */
export function getAgentsForGovernorateOnDay(governorate: string, dayOfWeek: number): string[] {
  const normalizedGov = normalizeGovForSchedule(governorate);

  // Cairo area → المتخصص (always available, no schedule needed)
  if (CAIRO_AREA_GOVS.includes(normalizedGov)) {
    return ["المتخصص"];
  }

  // Upper Egypt → special schedule
  if (UPPER_EGYPT_GOVS.includes(normalizedGov)) {
    const agents: string[] = [];
    // الشبح: الصعيد يوم الأحد والأربعاء
    if (dayOfWeek === 0 || dayOfWeek === 3) agents.push("الشبح");
    // العالمية: الصعيد يوم السبت والأربعاء
    if (dayOfWeek === 6 || dayOfWeek === 3) agents.push("العالمية");
    return agents;
  }

  // Check each agent's schedule
  const agents: string[] = [];
  for (const agent of SHIPPING_SCHEDULES) {
    const dayGovs = agent.schedule[dayOfWeek];
    if (dayGovs && dayGovs.some(g => g === normalizedGov || normalizedGov.includes(g) || g.includes(normalizedGov))) {
      agents.push(agent.name);
    }
  }
  return agents;
}

/**
 * Get today's shipping schedule — which agents serve which governorates.
 * Returns a map: agentName → list of governorates served today.
 */
export function getTodaySchedule(dayOfWeek: number): Record<string, string[]> {
  const result: Record<string, string[]> = {
    "المتخصص": [...CAIRO_AREA_GOVS],
  };

  for (const agent of SHIPPING_SCHEDULES) {
    const dayGovs = agent.schedule[dayOfWeek];
    if (dayGovs && dayGovs.length > 0) {
      result[agent.name] = [...dayGovs];
    }
  }

  // Upper Egypt
  if (dayOfWeek === 0 || dayOfWeek === 3) {
    // الشبح serves upper egypt on Sun/Wed
    if (!result["الشبح"]) result["الشبح"] = [];
    result["الشبح"].push(...UPPER_EGYPT_GOVS);
  }
  if (dayOfWeek === 6 || dayOfWeek === 3) {
    // العالمية serves upper egypt on Sat/Wed
    if (!result["العالمية"]) result["العالمية"] = [];
    result["العالمية"].push(...UPPER_EGYPT_GOVS);
  }

  return result;
}

/**
 * Group confirmed orders by shipping agent for a given day.
 * Orders are matched to agents based on their governorate and the day's schedule.
 */
export function groupOrdersByAgent(
  orders: Array<{ governorate: string; [key: string]: any }>,
  dayOfWeek: number
): Record<string, Array<{ governorate: string; [key: string]: any }>> {
  const groups: Record<string, Array<any>> = {};

  for (const order of orders) {
    const agents = getAgentsForGovernorateOnDay(order.governorate, dayOfWeek);
    if (agents.length === 0) {
      // Fallback: unmatched governorate
      if (!groups["غير محدد"]) groups["غير محدد"] = [];
      groups["غير محدد"].push(order);
    } else {
      // Assign to first matching agent (primary)
      const primaryAgent = agents[0];
      if (!groups[primaryAgent]) groups[primaryAgent] = [];
      groups[primaryAgent].push(order);
    }
  }

  return groups;
}
