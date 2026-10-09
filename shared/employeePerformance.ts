import { businessDateKey } from "./businessTime";
import { ASSIGNMENT_EVENT_TYPES, DECISION_EVENT_TYPES, PERFORMANCE_RANKING_MIN_SAMPLE } from "./orderEventsSpec";

/**
 * مقاييس أداء الموظفين من سجل الأحداث (0041) — دوال نقية (لا قاعدة بيانات) تُختبر مباشرة.
 *
 *  • «القرارات المسجلة» (decisionEligibleOrders) = أوردرات مختلفة سجّل عليها الموظف (المنسوب إليه)
 *    confirm / no_answer / postpone / cancel داخل الفترة.
 *  • «نسبة التأكيد من القرارات المسجلة» = أوردرات أكّدها ÷ القرارات المسجلة — ≤ 100% بالتعريف.
 *    no_answer ثم confirm لنفس الأوردر = أوردر واحد في المقام وواحد في البسط.
 *  • حجم العمل والإسنادات مقاييس **منفصلة** (لا تدخل النسبة).
 *  • الترتيب فقط لمن قراراته ≥ 20؛ الأقل تظهر أرقامهم ونسبتهم بلا ترتيب. لا Leaderboard عام.
 *  • Backfill الجزئي لا يدخل الحساب الافتراضي.
 */
export type PerformanceEventRow = {
  orderId: number;
  eventType: string;
  attributedEmployeeId: number | null;
  assigneeEmployeeIdAtEvent: number | null;
  callAttempt: number | null;
  occurredAtMs: number;
  source: string;
  backfillConfidence: string | null;
};

export type EmployeePerformanceRow = {
  employeeId: number;
  decisionEligibleOrders: number;
  confirmedOrders: number;
  /** نسبة مئوية بمنزلة عشرية واحدة؛ null لو لا قرارات */
  confirmationRate: number | null;
  noAnswerOrders: number;
  noAnswerAttempts: number;
  postponedOrders: number;
  cancelledOrders: number;
  workloadOrders: number;
  assignedOrders: number;
  activeDays: number;
  rankable: boolean;
  rank: number | null;
};

const DECISIONS = new Set<string>(DECISION_EVENT_TYPES);
const ASSIGNMENTS = new Set<string>(ASSIGNMENT_EVENT_TYPES);

export function computePerformance(
  events: PerformanceEventRow[],
  opts: { timeZone: string; minSample?: number; includePartialBackfill?: boolean }
): EmployeePerformanceRow[] {
  const minSample = opts.minSample ?? PERFORMANCE_RANKING_MIN_SAMPLE;
  type Acc = { decisions: Set<number>; confirmed: Set<number>; noAnswer: Set<number>; noAnswerAttempts: number; postponed: Set<number>; cancelled: Set<number>; workload: Set<number>; assigned: Set<number>; days: Set<string> };
  const acc = new Map<number, Acc>();
  const get = (id: number) => {
    let a = acc.get(id);
    if (!a) { a = { decisions: new Set(), confirmed: new Set(), noAnswer: new Set(), noAnswerAttempts: 0, postponed: new Set(), cancelled: new Set(), workload: new Set(), assigned: new Set(), days: new Set() }; acc.set(id, a); }
    return a;
  };
  for (const e of events) {
    if (e.source === "backfill" && e.backfillConfidence !== "confirmed" && !opts.includePartialBackfill) continue;
    if (ASSIGNMENTS.has(e.eventType) && e.assigneeEmployeeIdAtEvent != null) get(e.assigneeEmployeeIdAtEvent).assigned.add(e.orderId);
    if (e.attributedEmployeeId == null) continue;
    const a = get(e.attributedEmployeeId);
    a.workload.add(e.orderId);
    a.days.add(businessDateKey(new Date(e.occurredAtMs), opts.timeZone));
    if (!DECISIONS.has(e.eventType)) continue;
    a.decisions.add(e.orderId);
    if (e.eventType === "confirm") a.confirmed.add(e.orderId);
    else if (e.eventType === "no_answer") { a.noAnswer.add(e.orderId); a.noAnswerAttempts += Math.max(1, e.callAttempt ?? 1); }
    else if (e.eventType === "postpone") a.postponed.add(e.orderId);
    else if (e.eventType === "cancel") a.cancelled.add(e.orderId);
  }
  const rows: EmployeePerformanceRow[] = [...acc.entries()].map(([employeeId, a]) => ({
    employeeId,
    decisionEligibleOrders: a.decisions.size,
    confirmedOrders: a.confirmed.size,
    confirmationRate: a.decisions.size ? Math.round((a.confirmed.size / a.decisions.size) * 1000) / 10 : null,
    noAnswerOrders: a.noAnswer.size,
    noAnswerAttempts: a.noAnswerAttempts,
    postponedOrders: a.postponed.size,
    cancelledOrders: a.cancelled.size,
    workloadOrders: a.workload.size,
    assignedOrders: a.assigned.size,
    activeDays: a.days.size,
    rankable: a.decisions.size >= minSample,
    rank: null,
  }));
  const ranked = rows.filter(r => r.rankable).sort((x, y) =>
    (y.confirmationRate ?? 0) - (x.confirmationRate ?? 0) || y.decisionEligibleOrders - x.decisionEligibleOrders || x.employeeId - y.employeeId);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return rows.sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity) || x.employeeId - y.employeeId);
}

/** CSV للتصدير — نفس الأعمدة الظاهرة، أرقام كما هي. */
export function performanceCsv(rows: (EmployeePerformanceRow & { employeeName: string })[]): string {
  const head = ["الموظف", "القرارات المسجلة", "المؤكدة", "نسبة التأكيد من القرارات المسجلة %", "لم يرد (أوردرات)", "لم يرد (محاولات)", "مؤجل", "ملغي", "حجم العمل", "الإسنادات", "أيام النشاط", "الترتيب"];
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = rows.map(r => [r.employeeName, r.decisionEligibleOrders, r.confirmedOrders, r.confirmationRate ?? "", r.noAnswerOrders, r.noAnswerAttempts, r.postponedOrders, r.cancelledOrders, r.workloadOrders, r.assignedOrders, r.activeDays, r.rank ?? "عينة أقل من الحد"].map(esc).join(","));
  return "﻿" + [head.join(","), ...lines].join("\n");
}
