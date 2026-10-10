import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { orders } from "../drizzle/schema";
import { businessDayRange } from "../shared/businessTime";
import { isActiveAt, scopeEventsToTeam } from "../shared/teamsSpec";
import { daysForEmployees, reviewCorrection, type AttendanceActor } from "./attendance.service";
import { assignOrderToEmployee, getDb, getOrders } from "./db";
import { loadPerformance } from "./employeePerformance.service";
import { canonicalHash } from "./orderEvents.service";
import type { OrderEventContext } from "./orderEvents.service";
import { assertAssignableTeamMember, operationIdSchema, requireLeaderOf, requireLeaderOfTx, runTeamsTx, teamAttributionScope, teamMembersAt, type LeaderTeam, type TeamsActor } from "./teams.service";

/**
 * مسارات القائد (حضور/أداء/مهام/أوردرات) — خدمات قراءة وكتابة **داخل نطاق فريقه فقط**، خلف TEAMS_ENABLED.
 *  • كل دالة تبدأ بقيادة فعّالة لهذا الفريق (requireLeaderOf) — الصلاحية يفرضها الراوتر، والقيادة هنا؛ الاثنان معًا.
 *  • التاريخ بالعضوية لحظة الحدث: يوم الحضور بلحظة أول حضور (أو بداية الوردية المجدولة، أو بداية اليوم بتوقيته)،
 *    والأداء بـoccurredAt بالضبط (scopeEventsToTeam). العضوية المنتهية تظهر في التاريخ لا في الحالي.
 *  • الكتابة: إسناد الأوردر عبر المسار القائم (assignOrderToEmployee ⇒ سجل الأحداث) بلا تغيير حالات ولا عقود؛
 *    المهام بلا حذف، والمستلم عضو فعّال الآن، وIdempotency بـoperationId في team_task_operations. لا teamId في
 *    orders ولا تعديل لمخطط orders/tasks.
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TZ = "Africa/Cairo";
const DAY_MS = 86_400_000;
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });
const notFound = (message: string) => new TRPCError({ code: "NOT_FOUND", message });
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message });
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
  // الطلبات المعلّقة حالية — تُحمَّل لأعضاء الفريق الفعّالين **الآن** مهما كان نطاق العرض. كانت تُحمَّل فقط لمن تتقاطع
  // عضويته مع النطاق (±يوم)، فعضو بدأت عضويته بعد نهاية النطاق (مثل القائد بعد منتصف ليل القاهرة) كانت طلباته تختفي.
  // الأيام تبقى مقيّدة بالعضوية لحظة كل يوم (الفلتر أدناه)، فإضافة الأعضاء الحاليين لا تُظهر أيامًا خارج عضويتهم.
  const data = await daysForEmployees(actor.tenantId, [...new Set([...ids, ...nowMembers])], fromDate, toDate);
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

/**
 * المنشئ صريحًا: مهام القائد لها سجل في team_task_operations (actorEmployeeId ⇒ اسم الموظف من employees)، وغيرها
 * «legacy» باسمها المحفوظ فقط — لا يُفسَّر tasks.createdBy أبدًا (مزدوج المعنى: users.id موجب / -employeeId).
 */
export type TeamTaskCreator = { kind: "employee"; employeeId: number; name: string } | { kind: "legacy"; name: string };
export type TeamTaskRow = { id: number; businessId: number | null; title: string; description: string | null; assignedTo: number | null; assignedToName: string | null; status: string; createdAtMs: number; updatedAtMs: number; creator: TeamTaskCreator };

/** مهام الفريق: داخل نشاط الفريق، لأعضائه الفعّالين أو عامة (بلا مستلم). */
export async function listTeamTasks(actor: TeamsActor, teamId: number, status?: "new" | "in_progress" | "done"): Promise<TeamTaskRow[]> {
  const team = await requireLeaderOf(actor, teamId);
  return runTeamsTx(async tx => {
    const members = await memberIdsNow(tx, actor.tenantId, teamId);
    const inMembers = sql.join((members.length ? members : [-1]).map(m => sql`${m}`), sql`, `);
    return rows(await tx.execute(sql`SELECT t.id, t.businessId, t.title, t.description, t.assignedTo, t.assignedToName, t.taskStatus AS status, t.createdByName,
        UNIX_TIMESTAMP(t.createdAt) * 1000 AS createdAtMs, UNIX_TIMESTAMP(t.updatedAt) * 1000 AS updatedAtMs, o.actorEmployeeId, e.name AS actorName
      FROM tasks t
      LEFT JOIN team_task_operations o ON o.taskId = t.id AND o.tenantId = ${actor.tenantId}
      LEFT JOIN employees e ON e.id = o.actorEmployeeId AND e.tenantId = o.tenantId
      WHERE t.businessId = ${team.businessId} AND (t.assignedTo IS NULL OR t.assignedTo IN (${inMembers}))${status ? sql` AND t.taskStatus = ${status}` : sql``}
      ORDER BY t.createdAt DESC, t.id DESC LIMIT 100`)).map(r => ({
        id: Number(r.id), businessId: num(r.businessId), title: r.title, description: r.description ?? null, assignedTo: num(r.assignedTo), assignedToName: r.assignedToName ?? null,
        status: r.status, createdAtMs: Number(r.createdAtMs), updatedAtMs: Number(r.updatedAtMs),
        creator: r.actorEmployeeId != null
          ? { kind: "employee" as const, employeeId: Number(r.actorEmployeeId), name: r.actorName ?? r.createdByName }
          : { kind: "legacy" as const, name: r.createdByName },
      }));
  });
}

export const teamTaskInput = z.object({
  teamId: z.number().int().positive(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  assignedTo: z.number().int().positive().nullable().optional(),
  operationId: operationIdSchema,
}).strict();
/**
 * إنشاء مهمة من القائد — Idempotency حتمية بـoperationId (team_task_operations، UNIQUE(tenantId, operationId)):
 * قفل صف الفريق ← القيادة داخل نفس المعاملة ← قراءة قافلة للعملية: نفس البصمة ونفس الفاعل = Replay بنفس المهمة،
 * غير ذلك = CONFLICT ← المستلم عضو فعّال الآن (أو مهمة عامة لنشاط الفريق) ← المهمة + سجل العملية معًا.
 * لا مدة زمنية ولا مقارنة نص: مهمتان متطابقتان بعمليتين مختلفتين = مهمتان. tasks.createdBy = -employeeId (عقد
 * جلسة الإدارة القائم: السالب = موظف) فلا يُفسَّر users.id؛ والمنشئ الحقيقي في سجل العملية.
 */
export async function createTeamTask(actor: TeamsActor, input: z.infer<typeof teamTaskInput>) {
  const v = teamTaskInput.parse(input);
  const assignedTo = v.assignedTo ?? null;
  const description = v.description ? v.description : null;
  const hash = canonicalHash({ op: "team_task_create", teamId: v.teamId, title: v.title, description, assignedTo });
  return withTaskOpRetry(() => runTeamsTx(async tx => {
    const t = rows(await tx.execute(sql`SELECT id FROM teams WHERE id = ${v.teamId} AND tenantId = ${actor.tenantId} FOR UPDATE`))[0];
    if (!t) throw forbidden("لست قائدًا فعّالًا لهذا الفريق");
    const team = await requireLeaderOfTx(tx, actor, v.teamId);
    const ex = rows(await tx.execute(sql`SELECT taskId, payloadHash, actorEmployeeId FROM team_task_operations WHERE tenantId = ${actor.tenantId} AND operationId = ${v.operationId} FOR UPDATE`))[0];
    if (ex) {
      // Replay لنفس الفاعل ونفس البصمة فقط — مفتاح عملية شخص آخر لا يكشف مهمته
      if (ex.payloadHash !== hash || Number(ex.actorEmployeeId) !== actor.employeeId) throw conflict("نفس معرّف العملية استُخدم لمهمة مختلفة — لم يُنفَّذ أي تغيير");
      if (ex.taskId == null) throw notFound("المهمة المنشأة بهذه العملية حُذفت — لم يُنشأ بديل");
      return { id: Number(ex.taskId), replay: true };
    }
    let assignedToName: string | null = null;
    if (assignedTo != null) {
      if (!(await memberIdsNow(tx, actor.tenantId, v.teamId)).includes(assignedTo)) throw forbidden("الموظف ليس عضوًا فعّالًا في فريقك");
      assignedToName = rows(await tx.execute(sql`SELECT name FROM employees WHERE id = ${assignedTo} AND tenantId = ${actor.tenantId}`))[0]?.name ?? null;
    }
    const me = rows(await tx.execute(sql`SELECT name FROM employees WHERE id = ${actor.employeeId} AND tenantId = ${actor.tenantId}`))[0];
    const r = await tx.execute(sql`INSERT INTO tasks (businessId, title, description, assignedTo, assignedToName, createdBy, createdByName)
      VALUES (${team.businessId}, ${v.title}, ${description}, ${assignedTo}, ${assignedToName}, ${-actor.employeeId}, ${me?.name ?? "قائد الفريق"})`);
    const taskId = Number((Array.isArray(r) ? r[0] : r)?.insertId);
    await tx.execute(sql`INSERT INTO team_task_operations (tenantId, teamId, taskId, operationId, payloadHash, actorEmployeeId)
      VALUES (${actor.tenantId}, ${v.teamId}, ${taskId}, ${v.operationId}, ${hash}, ${actor.employeeId})`);
    return { id: taskId, replay: false };
  }));
}

/** سباق نفس العملية على فريقين مختلفين: تعارض فهرس العملية (1062) أو Deadlock ⇒ محاولة ثانية تتحول Replay/CONFLICT. */
async function withTaskOpRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try { return await attempt(); }
  catch (e: any) {
    let race = false;
    for (let c = e; c; c = c.cause) if (c.errno === 1213 || ((c.errno === 1062 || c.code === "ER_DUP_ENTRY") && /tto_tenant_op_idem_unique/.test(String(c.sqlMessage ?? c.message ?? "")))) race = true;
    if (!race) throw e;
    return attempt();
  }
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
