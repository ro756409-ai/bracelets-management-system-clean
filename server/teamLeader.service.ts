import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, or, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { orders, tasks } from "../drizzle/schema";
import { businessDayRange } from "../shared/businessTime";
import { isActiveAt, scopeEventsToTeam } from "../shared/teamsSpec";
import { daysForEmployees, reviewCorrection, type AttendanceActor } from "./attendance.service";
import { assignOrderToEmployee, getDb, getOrders } from "./db";
import { loadPerformance } from "./employeePerformance.service";
import type { OrderEventContext } from "./orderEvents.service";
import { assertAssignableTeamMember, operationIdSchema, requireLeaderOf, requireLeaderOfTx, runTeamsTx, teamAttributionScope, teamMembersAt, type LeaderTeam, type TeamsActor } from "./teams.service";

/**
 * مسارات القائد (حضور/أداء/مهام/أوردرات) — خدمات قراءة وكتابة **داخل نطاق فريقه فقط**، خلف TEAMS_ENABLED.
 *  • كل دالة تبدأ بقيادة فعّالة لهذا الفريق (requireLeaderOf) — الصلاحية يفرضها الراوتر، والقيادة هنا؛ الاثنان معًا.
 *  • التاريخ بالعضوية لحظة الحدث: يوم الحضور بلحظة أول حضور (أو بداية الوردية المجدولة، أو بداية اليوم بتوقيته)،
 *    والأداء بـoccurredAt بالضبط (scopeEventsToTeam). العضوية المنتهية تظهر في التاريخ لا في الحالي.
 *  • الكتابة: إسناد الأوردر عبر المسار القائم (assignOrderToEmployee ⇒ سجل الأحداث) بلا تغيير حالات ولا عقود؛
 *    المهام بلا حذف، والمستلم عضو فعّال الآن. لا teamId في orders ولا تعديل لجداول orders/tasks.
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TZ = "Africa/Cairo";
const DAY_MS = 86_400_000;
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });
const notFound = (message: string) => new TRPCError({ code: "NOT_FOUND", message });
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const rows = (r: any): any[] => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []);
const num = (v: any) => (v == null ? null : Number(v));

function rangeMs(fromDate: string, toDate: string, tz = DEFAULT_TZ) {
  if (!ISO.test(fromDate) || !ISO.test(toDate) || fromDate > toDate) throw bad("نطاق تاريخ غير صالح");
  return { fromMs: businessDayRange(fromDate, tz).from.getTime(), toMs: businessDayRange(toDate, tz).toExclusive.getTime() };
}
const attendanceActor = (a: TeamsActor): AttendanceActor => ({ tenantId: a.tenantId, employeeId: a.employeeId, role: a.role, businessId: null });

// ==================== الحضور ====================

/**
 * حضور الفريق: أيام كل من كان عضوًا/قائدًا **لحظة يوم الحضور** فقط (عضوية منتهية تظهر في أيامها، لا بعدها)،
 * والطلبات المعلّقة لأعضائه الفعّالين الآن (isMine = طلب القائد نفسه — لا يراجعه).
 */
export async function teamAttendance(actor: TeamsActor, teamId: number, fromDate: string, toDate: string) {
  const team = await requireLeaderOf(actor, teamId);
  const r = rangeMs(fromDate, toDate);
  // هامش يوم من الجهتين لاختلاف توقيت الأيام عن القاهرة
  const scope = await teamAttributionScope(actor.tenantId, teamId, r.fromMs - DAY_MS, r.toMs + DAY_MS);
  const ids = [...new Set(scope.intervals.map(i => i.employeeId))];
  const nowMembers = (await teamMembersAt(actor.tenantId, teamId)).map(m => m.employeeId);
  const data = await daysForEmployees(actor.tenantId, ids, fromDate, toDate);
  const anchor = (d: any) => num(d.firstInMs) ?? num(d.scheduledStartMs) ?? businessDayRange(d.workDate, d.timezone || DEFAULT_TZ).from.getTime();
  const days = data.days.filter(d => scope.intervals.some(i => i.employeeId === Number(d.employeeId) && isActiveAt(i, anchor(d))));
  const pending = data.pending.filter(p => nowMembers.includes(Number(p.employeeId))).map(p => ({ ...p, isMine: Number(p.employeeId) === actor.employeeId }));
  return { team, days, pending };
}

export const teamReviewInput = z.object({
  teamId: z.number().int().positive(), requestId: z.number().int().positive(),
  decision: z.enum(["approve", "reject"]), reviewReason: z.string().max(500).nullable().optional(),
}).strict();
/**
 * مراجعة طلب تصحيح من القائد: قيادة فعّالة + صاحب الطلب عضو فعّال الآن في نفس الفريق + لا طلبه الشخصي
 * (يفرضها reviewCorrection نفسه) + الصلاحيات (approve_corrections، وmanage_leaves للإجازة/المأمورية).
 * الضغط المزدوج: الثاني يجد الطلب غير معلّق تحت FOR UPDATE ⇒ CONFLICT، فالكتابة مرة واحدة.
 */
export async function reviewTeamCorrection(actor: TeamsActor, input: z.infer<typeof teamReviewInput>, perms: { approveCorrections: boolean; manageLeaves: boolean }) {
  const v = teamReviewInput.parse(input);
  await requireLeaderOf(actor, v.teamId);
  const members = (await teamMembersAt(actor.tenantId, v.teamId)).map(m => m.employeeId);
  return reviewCorrection(attendanceActor(actor), { requestId: v.requestId, decision: v.decision, reviewReason: v.reviewReason ?? null }, perms, [], { onlyEmployeeIds: members });
}

// ==================== الأداء ====================

/**
 * أداء الفريق من order_activity_events فقط: نفس الشركة + نشاط الفريق + عضوية فعّالة لحظة occurredAt. إعادة
 * الإسناد لا تنقل التاريخ؛ الترتيب لمن قراراته ≥ 20؛ Backfill غير المؤكد خارج الحساب (computePerformance).
 */
export async function teamPerformance(actor: TeamsActor, teamId: number, fromDate: string, toDate: string, timeZone = DEFAULT_TZ) {
  const team = await requireLeaderOf(actor, teamId);
  const r = rangeMs(fromDate, toDate, timeZone);
  const scope = await teamAttributionScope(actor.tenantId, teamId, r.fromMs, r.toMs);
  const report = await loadPerformance({
    tenantId: actor.tenantId, businessIds: [team.businessId], fromDate, toDate, timeZone,
    scopeEvents: ev => scopeEventsToTeam(ev, scope.team, scope.intervals, actor.tenantId),
  });
  return { team, report };
}

// ==================== المهام ====================

const memberIdsNow = async (tx: any, tenantId: number, teamId: number) => rows(await tx.execute(sql`SELECT employeeId FROM team_memberships
  WHERE tenantId = ${tenantId} AND teamId = ${teamId} AND effectiveToAt IS NULL`)).map(r => Number(r.employeeId));

/** مهام الفريق: داخل نشاط الفريق، لأعضائه الفعّالين أو عامة (بلا مستلم). */
export async function listTeamTasks(actor: TeamsActor, teamId: number, status?: "new" | "in_progress" | "done") {
  const team = await requireLeaderOf(actor, teamId);
  const members = (await teamMembersAt(actor.tenantId, teamId)).map(m => m.employeeId);
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const conds: any[] = [eq(tasks.businessId, team.businessId), or(isNull(tasks.assignedTo), inArray(tasks.assignedTo, members.length ? members : [-1]))];
  if (status) conds.push(eq(tasks.status, status));
  return db.select().from(tasks).where(and(...conds)).orderBy(desc(tasks.createdAt)).limit(100);
}

export const teamTaskInput = z.object({
  teamId: z.number().int().positive(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  assignedTo: z.number().int().positive().nullable().optional(),
  operationId: operationIdSchema,
}).strict();
/** نافذة منع التكرار (لا عمود مفتاح في tasks): نفس المنشئ + نفس المحتوى خلالها = Replay بلا صف جديد. */
export const TEAM_TASK_DEDUPE_SECONDS = 120;
/**
 * إنشاء مهمة من القائد: قفل صف الفريق يسلسل الطلبات ← القيادة داخل نفس المعاملة ← المستلم عضو فعّال الآن
 * (أو مهمة عامة لنشاط الفريق) ← منع التكرار بالمحتوى خلال النافذة ← إدراج. لا إسناد لموظف خارج الفريق.
 */
export async function createTeamTask(actor: TeamsActor, input: z.infer<typeof teamTaskInput>) {
  const v = teamTaskInput.parse(input);
  return runTeamsTx(async tx => {
    const t = rows(await tx.execute(sql`SELECT id, isActive FROM teams WHERE id = ${v.teamId} AND tenantId = ${actor.tenantId} FOR UPDATE`))[0];
    if (!t) throw forbidden("لست قائدًا فعّالًا لهذا الفريق");
    const team = await requireLeaderOfTx(tx, actor, v.teamId);
    const assignedTo = v.assignedTo ?? null;
    let assignedToName: string | null = null;
    if (assignedTo != null) {
      if (!(await memberIdsNow(tx, actor.tenantId, v.teamId)).includes(assignedTo)) throw forbidden("الموظف ليس عضوًا فعّالًا في فريقك");
      assignedToName = rows(await tx.execute(sql`SELECT name FROM employees WHERE id = ${assignedTo} AND tenantId = ${actor.tenantId}`))[0]?.name ?? null;
    }
    const description = v.description ? v.description : null;
    const dup = rows(await tx.execute(sql`SELECT id FROM tasks WHERE businessId = ${team.businessId} AND createdBy = ${actor.employeeId} AND title = ${v.title}
      AND description <=> ${description} AND assignedTo <=> ${assignedTo} AND createdAt >= NOW() - INTERVAL ${TEAM_TASK_DEDUPE_SECONDS} SECOND ORDER BY id DESC LIMIT 1 FOR UPDATE`))[0];
    if (dup) return { id: Number(dup.id), replay: true };
    const me = rows(await tx.execute(sql`SELECT name FROM employees WHERE id = ${actor.employeeId} AND tenantId = ${actor.tenantId}`))[0];
    const r = await tx.execute(sql`INSERT INTO tasks (businessId, title, description, assignedTo, assignedToName, createdBy, createdByName)
      VALUES (${team.businessId}, ${v.title}, ${description}, ${assignedTo}, ${assignedToName}, ${actor.employeeId}, ${me?.name ?? "قائد الفريق"})`);
    return { id: Number((Array.isArray(r) ? r[0] : r)?.insertId), replay: false };
  });
}

export const teamTaskStatusInput = z.object({ teamId: z.number().int().positive(), taskId: z.number().int().positive(), status: z.enum(["new", "in_progress", "done"]) }).strict();
/** تحديث حالة مهمة في نشاط الفريق لعضو فعّال (أو عامة). نفس الحالة = بلا تغيير. مهمة فريق آخر = غير موجودة. */
export async function updateTeamTaskStatus(actor: TeamsActor, input: z.infer<typeof teamTaskStatusInput>) {
  const v = teamTaskStatusInput.parse(input);
  return runTeamsTx(async tx => {
    const t = rows(await tx.execute(sql`SELECT id FROM teams WHERE id = ${v.teamId} AND tenantId = ${actor.tenantId} FOR UPDATE`))[0];
    if (!t) throw forbidden("لست قائدًا فعّالًا لهذا الفريق");
    const team = await requireLeaderOfTx(tx, actor, v.teamId);
    const task = rows(await tx.execute(sql`SELECT id, assignedTo, taskStatus AS status FROM tasks WHERE id = ${v.taskId} AND businessId = ${team.businessId} FOR UPDATE`))[0];
    if (!task) throw notFound("المهمة غير موجودة");
    if (task.assignedTo != null && !(await memberIdsNow(tx, actor.tenantId, v.teamId)).includes(Number(task.assignedTo))) throw forbidden("المهمة لموظف خارج فريقك");
    if (task.status === v.status) return { id: v.taskId, status: v.status, changed: false };
    await tx.execute(sql`UPDATE tasks SET taskStatus = ${v.status} WHERE id = ${v.taskId} AND businessId = ${team.businessId}`);
    return { id: v.taskId, status: v.status, changed: true };
  });
}

// ==================== الأوردرات ====================

export const teamOrdersInput = z.object({
  teamId: z.number().int().positive(),
  status: z.string().max(40).optional(),
  unassignedOnly: z.boolean().optional(),
  assignedEmployeeId: z.number().int().positive().optional(),
  search: z.string().max(100).optional(),
  page: z.number().int().positive().max(10_000).optional(),
  limit: z.number().int().positive().max(100).optional(),
}).strict();
/** كل أوردرات نشاط الفريق (ومنها غير المسندة) — بنفس قارئ الأوردرات القائم، مقيّدًا بنشاط الفريق وحده. */
export async function listTeamOrders(actor: TeamsActor, input: z.infer<typeof teamOrdersInput>) {
  const v = teamOrdersInput.parse(input);
  const team = await requireLeaderOf(actor, v.teamId);
  const { teamId: _t, ...filters } = v;
  return { team, ...(await getOrders({ ...filters, businessId: undefined, businessIds: [team.businessId], limit: v.limit ?? 50 } as any)) };
}

export const teamAssignInput = z.object({ teamId: z.number().int().positive(), orderId: z.number().int().positive(), employeeId: z.number().int().positive(), operationId: operationIdSchema }).strict();
/**
 * إسناد أوردر من القائد: الأوردر في نشاط الفريق (وإلا غير موجود) + المستلم عضو فعّال الآن في نفس الفريق — قبل
 * أي كتابة. ثم المسار القائم assignOrderToEmployee (سجل الأحداث + Replay بـoperationId)؛ لا تغيير حالة.
 */
export async function assignTeamOrder(actor: TeamsActor, input: z.infer<typeof teamAssignInput>, eventCtx?: OrderEventContext): Promise<{ success: true; team: LeaderTeam }> {
  const v = teamAssignInput.parse(input);
  const team = await requireLeaderOf(actor, v.teamId);
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const [o] = await db.select({ id: orders.id, businessId: orders.businessId }).from(orders).where(eq(orders.id, v.orderId)).limit(1);
  if (!o || Number(o.businessId) !== team.businessId) throw notFound("الأوردر غير موجود في نشاط فريقك");
  await assertAssignableTeamMember(actor.tenantId, v.teamId, v.employeeId);
  await assignOrderToEmployee(v.orderId, v.employeeId, actor.employeeId, eventCtx);
  return { success: true, team };
}
