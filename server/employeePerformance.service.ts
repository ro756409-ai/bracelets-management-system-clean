import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { employees } from "../drizzle/schema";
import { businessDayRange, isValidIanaTimeZone } from "../shared/businessTime";
import { computePerformance, type EmployeePerformanceRow, type PerformanceEventRow } from "../shared/employeePerformance";
import { PERFORMANCE_RANKING_MIN_SAMPLE } from "../shared/orderEventsSpec";
import { getDb } from "./db";
import { assertOrderEventsReady, orderEventsEnabled } from "./orderEvents.service";

/**
 * تقرير الأداء من سجل الأحداث — قراءة فقط.
 *  • العلم معطل ⇒ `{ enabled: false }` **بلا أي وصول للجدول** (الواجهة تعرض «غير مفعّل بعد»).
 *  • العلم مفعّل والجدول غائب ⇒ PRECONDITION_FAILED.
 *  • النطاق: tenant الجلسة + أنشطتها المسموحة (يمرّرهما المتصل من الجلسة)، والتصفية داخل SQL نفسه.
 *  • الوقت: الحدود من تواريخ بتوقيت النشاط (IANA) إلى UTC، والقراءة بالـepoch (UNIX_TIMESTAMP) — لا تعتمد
 *    على time_zone الجلسة ولا جداول المناطق في MySQL.
 */
export type PerformanceReport =
  | { enabled: false }
  | { enabled: true; fromDate: string; toDate: string; timeZone: string; minSample: number; rows: (EmployeePerformanceRow & { employeeName: string; isActive: boolean })[] };

const MAX_DAYS = 366;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function loadPerformance(opts: {
  tenantId: number;
  businessIds: number[];
  fromDate: string;
  toDate: string;
  timeZone?: string;
  /** تقييد للموظف نفسه (view_self) */
  onlyEmployeeId?: number;
  /**
   * نطاق الفريق (قائد): تحويل الأحداث قبل الحساب — يُبقي نسب الحدث فقط لعضو فعّال لحظة occurredAt (يُلغى
   * المنسوب/المُسنَد خارج العضوية). الحساب والترتيب (حد 20) بعدها كما هو، والصفوف لأعضاء الفريق فقط.
   */
  scopeEvents?: (rows: (PerformanceEventRow & { businessId: number })[]) => PerformanceEventRow[];
}): Promise<PerformanceReport> {
  if (!orderEventsEnabled()) return { enabled: false };
  const timeZone = opts.timeZone ?? "Africa/Cairo";
  if (!isValidIanaTimeZone(timeZone)) throw new TRPCError({ code: "BAD_REQUEST", message: "منطقة زمنية غير صالحة" });
  if (!ISO.test(opts.fromDate) || !ISO.test(opts.toDate) || opts.fromDate > opts.toDate)
    throw new TRPCError({ code: "BAD_REQUEST", message: "نطاق تاريخ غير صالح" });
  const from = businessDayRange(opts.fromDate, timeZone).from;
  const to = businessDayRange(opts.toDate, timeZone).toExclusive;
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_DAYS + 1) throw new TRPCError({ code: "BAD_REQUEST", message: "أقصى نطاق سنة واحدة" });

  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  await assertOrderEventsReady(db);
  const ids = opts.businessIds.length ? opts.businessIds : [-1];
  const self = opts.onlyEmployeeId != null
    ? sql`AND (attributedEmployeeId = ${opts.onlyEmployeeId} OR assigneeEmployeeIdAtEvent = ${opts.onlyEmployeeId})`
    : sql``;
  const res: any = await db.execute(sql`
    SELECT orderId, businessId, eventType, attributedEmployeeId, assigneeEmployeeIdAtEvent, callAttempt, source, backfillConfidence,
           UNIX_TIMESTAMP(occurredAt) * 1000 AS occurredAtMs
    FROM order_activity_events
    WHERE tenantId = ${opts.tenantId}
      AND businessId IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})
      AND occurredAt >= FROM_UNIXTIME(${from.getTime() / 1000})
      AND occurredAt < FROM_UNIXTIME(${to.getTime() / 1000})
      ${self}`);
  const rows = (Array.isArray(res) ? res[0] : res) as any[];
  const events = rows.map(r => ({
    orderId: Number(r.orderId), businessId: Number(r.businessId), eventType: String(r.eventType), attributedEmployeeId: r.attributedEmployeeId == null ? null : Number(r.attributedEmployeeId),
    assigneeEmployeeIdAtEvent: r.assigneeEmployeeIdAtEvent == null ? null : Number(r.assigneeEmployeeIdAtEvent), callAttempt: r.callAttempt == null ? null : Number(r.callAttempt),
    occurredAtMs: Number(r.occurredAtMs), source: String(r.source), backfillConfidence: r.backfillConfidence ?? null,
  }));
  let computed = computePerformance(opts.scopeEvents ? opts.scopeEvents(events) : events, { timeZone });
  if (opts.onlyEmployeeId != null) computed = computed.filter(r => r.employeeId === opts.onlyEmployeeId).map(r => ({ ...r, rank: null }));
  const empIds = computed.map(r => r.employeeId);
  const people = empIds.length
    ? await db.select({ id: employees.id, name: employees.name, isActive: employees.isActive }).from(employees).where(and(eq(employees.tenantId, opts.tenantId), inArray(employees.id, empIds)))
    : [];
  const byId = new Map(people.map(p => [p.id, p]));
  return {
    enabled: true, fromDate: opts.fromDate, toDate: opts.toDate, timeZone, minSample: PERFORMANCE_RANKING_MIN_SAMPLE,
    rows: computed.filter(r => byId.has(r.employeeId)).map(r => ({ ...r, employeeName: byId.get(r.employeeId)!.name, isActive: Boolean(byId.get(r.employeeId)!.isActive) })),
  };
}
