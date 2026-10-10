import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { businessDateKey } from "../shared/businessTime";
import { intervalsOverlap, TEAMS_LIMITS, TEAMS_TABLES, type MembershipInterval } from "../shared/teamsSpec";
import { getDb } from "./db";
import { canonicalHash } from "./orderEvents.service";

/**
 * الفرق التشغيلية والقيادة المؤرخة (0044) — خلف العلم `TEAMS_ENABLED` (افتراضيًا معطل). خدمات فقط، بلا واجهة.
 *
 *  • كل كتابة داخل معاملة تبدأ بـ`SET time_zone = '+00:00'` ثم فحص وجود الجدولين. الأوقات epoch ms من ساعة
 *    القاعدة (NOW(3))، تُكتب كنص UTC وتُقرأ بـUNIX_TIMESTAMP — لا وقت من العميل ولا تأريخ رجعي.
 *  • ترتيب الأقفال ثابت: tenants (للإنشاء) ← teams ← team_memberships. كل كتابات فريق واحد تتسلسل بقفل صفه
 *    FOR UPDATE، فيُفحص التداخل التاريخي (طبقة 2) على صفوف مقفولة؛ والأعمدة المولّدة + UNIQUE خط الدفاع الأخير.
 *  • الفترات نصف مفتوحة [from, to). كل انتقال (تسليم قيادة، إغلاق، إيقاف) لحظة واحدة لكل الصفوف المتأثرة:
 *    max(ساعة القاعدة، آخر بداية متأثرة + 1ms) — فلا فترة فارغة ولا تداخل حتى في نفس الملّي ثانية.
 *  • Idempotency: نفس المفتاح + نفس البصمة = Replay بلا أي تغيير (لا إغلاق ولا تاريخ جديد)، بصمة مختلفة =
 *    CONFLICT. المفتاح من operationId بادئة لكل عملية؛ الصفوف التابعة لنفس العملية بلاحقة `#…`.
 *  • الهوية (tenant/الفاعل) من الجلسة فقط ويُتحقق منها في القاعدة: موظف حقيقي موجب ونشط في نفس الشركة.
 *  • الفريق الموقوف نهائي: أي كتابة لاحقة عليه CONFLICT. لا حذف لأي صف في أي مسار.
 *  • لا كتابة على orders أو tasks أو أي جدول خارج teams/team_memberships.
 */
export const teamsEnabled = () => process.env.TEAMS_ENABLED === "true";

export type TeamsActor = { tenantId: number; employeeId: number; role: string | null };
export const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, "معرّف العملية غير صالح");
const teamName = z.string().trim().min(1, "اكتب اسم الفريق").max(TEAMS_LIMITS.nameMaxChars).refine(s => /\S/u.test(s), "اكتب اسم الفريق");
const id = z.number().int().positive();

const rows = (r: any): any[] => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []);
const one = async (tx: any, q: any) => rows(await tx.execute(q))[0];
const insertId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId);
const affected = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const num = (v: any) => (v == null ? null : Number(v));
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message });
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });
const notFound = (message = "الفريق غير موجود") => new TRPCError({ code: "NOT_FOUND", message });
/** epoch ms ⇒ نص timestamp(3) لجلسة UTC (المعاملة تضبط time_zone='+00:00'). */
const ts = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
const MS = (col: string) => sql.raw(`UNIX_TIMESTAMP(${col}) * 1000`);

async function assertTeamsReady(tx: any): Promise<void> {
  const r = rows(await tx.execute(sql`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${sql.join(TEAMS_TABLES.map(t => sql`${t}`), sql`, `)})`));
  if (Number(r[0]?.n ?? 0) !== TEAMS_TABLES.length)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفرق مفعّلة لكن جداولها غير موجودة (0044 غير مطبّقة) — لم يُنفَّذ أي تغيير" });
}

function requireEnabled() {
  if (!teamsEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "نظام الفرق غير مفعّل" });
}

/** معاملة فرق: العلم + UTC صريح + فحص الجاهزية. */
export async function runTeamsTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  requireEnabled();
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  return db.transaction(async tx => {
    await tx.execute(sql`SET time_zone = '+00:00'`);
    await assertTeamsReady(tx);
    return fn(tx);
  });
}

/**
 * سباق نفس معرّف العملية على فريقين مختلفين (قفلا صفين مختلفين): يتعارض الإدراجان على فهرس الـidempotency
 * (1062) أو Deadlock (1213). نعيد المحاولة مرة فتتحول للـReplay/CONFLICT.
 */
async function withIdempotentRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try { return await attempt(); }
  catch (e: any) {
    if (!isIdempotencyRace(e)) throw mapUniqueViolation(e);
    try { return await attempt(); } catch (e2: any) { throw mapUniqueViolation(e2); }
  }
}
function causes(e: any): any[] { const out: any[] = []; for (let c = e; c; c = c.cause) out.push(c); return out; }
function isIdempotencyRace(e: any): boolean {
  return causes(e).some(c => c.errno === 1213 || c.code === "ER_LOCK_DEADLOCK"
    || ((c.errno === 1062 || c.code === "ER_DUP_ENTRY") && /_idem_unique/.test(String(c.sqlMessage ?? c.message ?? ""))));
}
/** خط الدفاع الأخير (طبقة 1) برسالة واضحة بدل خطأ قاعدة خام. */
function mapUniqueViolation(e: any): any {
  const msg = causes(e).map(c => String(c.sqlMessage ?? c.message ?? "")).join(" ");
  if (/tm_tenant_active_business_unique/.test(msg)) return conflict("يوجد فريق نشط لهذا النشاط — أوقفه أولًا");
  if (/tmb_tenant_open_leader_unique/.test(msg)) return conflict("للفريق قائد فعّال بالفعل");
  if (/tmb_tenant_employee_open_unique/.test(msg)) return conflict("الموظف عضو فعّال في الفريق بالفعل");
  return e;
}

/** الفاعل من القاعدة: معرّف موجب لموظف نشط في نفس الشركة — لا الهوية السالبة ولا موظف شركة أخرى. */
async function assertActor(tx: any, actor: TeamsActor): Promise<void> {
  if (!Number.isInteger(actor.employeeId) || actor.employeeId <= 0 || !Number.isInteger(actor.tenantId) || actor.tenantId <= 0)
    throw forbidden("تعذّر تحديد الموظف المنفّذ");
  const e = await one(tx, sql`SELECT id, isActive FROM employees WHERE id = ${actor.employeeId} AND tenantId = ${actor.tenantId}`);
  if (!e || !Number(e.isActive)) throw forbidden("حساب الموظف المنفّذ غير نشط أو خارج الشركة");
}

async function dbNowMs(tx: any): Promise<number> {
  return Number((await one(tx, sql`SELECT UNIX_TIMESTAMP(NOW(3)) * 1000 AS ms`)).ms);
}

const TEAM_COLS = sql`id, tenantId, businessId, name, isActive, version, ${MS("activatedAt")} AS activatedMs, ${MS("deactivatedAt")} AS deactivatedMs, deactivationIdempotencyKey, deactivationPayloadHash`;
type TeamRow = { id: number; tenantId: number; businessId: number; name: string; isActive: boolean; version: number; activatedMs: number; deactivatedMs: number | null };
const toTeam = (r: any): TeamRow => ({ id: Number(r.id), tenantId: Number(r.tenantId), businessId: Number(r.businessId), name: r.name, isActive: Boolean(Number(r.isActive)), version: Number(r.version), activatedMs: Number(r.activatedMs), deactivatedMs: num(r.deactivatedMs) });

/** قفل صف الفريق داخل شركة الفاعل — فريق شركة أخرى = غير موجود (لا نكشف وجوده). */
async function lockTeam(tx: any, tenantId: number, teamId: number) {
  const t = await one(tx, sql`SELECT ${TEAM_COLS} FROM teams WHERE id = ${teamId} AND tenantId = ${tenantId} FOR UPDATE`);
  if (!t) throw notFound();
  return t;
}
const requireActiveTeam = (t: any) => { if (!Number(t.isActive)) throw conflict("الفريق موقوف — لا يمكن تعديله"); };

const MEM_COLS = sql`id, teamId, employeeId, membershipRole, ${MS("effectiveFromAt")} AS fromMs, ${MS("effectiveToAt")} AS toMs, idempotencyKey, payloadHash, endIdempotencyKey, endPayloadHash`;
type MemRow = { id: number; teamId: number; employeeId: number; membershipRole: "member" | "leader"; fromMs: number; toMs: number | null };
const toMem = (r: any): MemRow => ({ id: Number(r.id), teamId: Number(r.teamId), employeeId: Number(r.employeeId), membershipRole: r.membershipRole, fromMs: Number(r.fromMs), toMs: num(r.toMs) });

async function lockTeamMemberships(tx: any, tenantId: number, teamId: number): Promise<MemRow[]> {
  return rows(await tx.execute(sql`SELECT ${MEM_COLS} FROM team_memberships WHERE tenantId = ${tenantId} AND teamId = ${teamId} ORDER BY id FOR UPDATE`)).map(toMem);
}

/** موظف نشط في نفس الشركة — غيره = غير موجود. */
async function activeEmployee(tx: any, tenantId: number, employeeId: number) {
  const e = await one(tx, sql`SELECT id, name, isActive FROM employees WHERE id = ${employeeId} AND tenantId = ${tenantId}`);
  if (!e) throw notFound("الموظف غير موجود");
  if (!Number(e.isActive)) throw bad("الموظف غير نشط");
  return e;
}

/**
 * لحظة الانتقال: ساعة القاعدة، وبعد كل بداية متأثرة بملّي ثانية على الأقل (CHECK effectiveToAt > effectiveFromAt)،
 * ولا قبل تفعيل الفريق.
 */
function transitionMs(nowMs: number, team: { activatedMs: number }, affected: { fromMs: number }[]): number {
  return Math.max(nowMs, team.activatedMs, ...affected.map(m => m.fromMs + 1));
}

/** طبقة 2: فترة جديدة [atMs, ∞) لا تتداخل مع أي فترة سابقة لنفس الموظف في نفس الفريق، ولا قيادتين متداخلتين. */
function assertNoHistoricalOverlap(all: MemRow[], employeeId: number, role: "member" | "leader", atMs: number, ignoreIds: number[] = []) {
  const candidate: MembershipInterval = { fromMs: atMs, toMs: null };
  const effective = (m: MemRow) => (ignoreIds.includes(m.id) ? { fromMs: m.fromMs, toMs: atMs } : { fromMs: m.fromMs, toMs: m.toMs });
  const clash = all.find(m => m.employeeId === employeeId && intervalsOverlap(effective(m), candidate));
  if (clash) throw conflict("تداخل تاريخي مع عضوية سابقة لنفس الموظف في هذا الفريق — لم يُنفَّذ أي تغيير");
  if (role === "leader") {
    const lead = all.find(m => m.membershipRole === "leader" && intervalsOverlap(effective(m), candidate));
    if (lead) throw conflict("تداخل تاريخي مع قيادة أخرى لهذا الفريق — لم يُنفَّذ أي تغيير");
  }
}

async function insertMembership(tx: any, actor: TeamsActor, m: { teamId: number; employeeId: number; role: "member" | "leader"; fromMs: number; key: string; hash: string }) {
  const r = await tx.execute(sql`INSERT INTO team_memberships (tenantId, teamId, employeeId, membershipRole, effectiveFromAt, assignedByEmployeeId, idempotencyKey, payloadHash)
    VALUES (${actor.tenantId}, ${m.teamId}, ${m.employeeId}, ${m.role}, ${ts(m.fromMs)}, ${actor.employeeId}, ${m.key}, ${m.hash})`);
  return insertId(r);
}

async function closeMembership(tx: any, actor: TeamsActor, membershipId: number, atMs: number, endKey: string, endHash: string) {
  const r = await tx.execute(sql`UPDATE team_memberships SET effectiveToAt = ${ts(atMs)}, endedAt = NOW(3), endedByEmployeeId = ${actor.employeeId}, endIdempotencyKey = ${endKey}, endPayloadHash = ${endHash}
    WHERE id = ${membershipId} AND tenantId = ${actor.tenantId} AND effectiveToAt IS NULL`);
  if (affected(r) !== 1) throw conflict("تغيّرت العضوية أثناء التنفيذ — أعد المحاولة");
}

/** Replay/Conflict بمفتاح — قراءة قافلة قبل أي تغيير. يرجع الصف عند Replay. */
async function replayByKey(tx: any, table: "teams" | "team_memberships", keyCol: string, hashCol: string, tenantId: number, key: string, hash: string): Promise<any | null> {
  const ex = await one(tx, sql`SELECT id, ${sql.raw(hashCol)} AS h FROM ${sql.raw(table)} WHERE tenantId = ${tenantId} AND ${sql.raw(keyCol)} = ${key} FOR UPDATE`);
  if (!ex) return null;
  if (ex.h === hash) return ex;
  throw conflict("نفس معرّف العملية استُخدم لطلب مختلف — لم يُنفَّذ أي تغيير");
}

// ==================== الكتابة (المالك/الإدارة: teams.manage) ====================

export const createTeamInput = z.object({ businessId: id, name: teamName, operationId: operationIdSchema }).strict();
/** إنشاء فريق: قفل صف الشركة يسلسل الإنشاء ← Replay ← النشاط من نفس الشركة وضمن نطاق الجلسة ← لا فريق نشط له. */
export async function createTeam(actor: TeamsActor, input: z.infer<typeof createTeamInput>, allowedBusinessIds: number[]) {
  const v = createTeamInput.parse(input);
  if (!allowedBusinessIds.includes(v.businessId)) throw forbidden("النشاط خارج نطاقك");
  const key = `tcreate:${v.operationId}`;
  const hash = canonicalHash({ op: "create_team", businessId: v.businessId, name: v.name });
  return withIdempotentRetry(() => runTeamsTx(async tx => {
    await assertActor(tx, actor);
    await tx.execute(sql`SELECT id FROM tenants WHERE id = ${actor.tenantId} FOR UPDATE`);
    const replay = await replayByKey(tx, "teams", "idempotencyKey", "payloadHash", actor.tenantId, key, hash);
    if (replay) return { id: Number(replay.id), replay: true };
    const biz = await one(tx, sql`SELECT id FROM businesses WHERE id = ${v.businessId} AND tenantId = ${actor.tenantId}`);
    if (!biz) throw notFound("النشاط غير موجود");
    const active = await one(tx, sql`SELECT id FROM teams WHERE tenantId = ${actor.tenantId} AND businessId = ${v.businessId} AND isActive = 1 FOR UPDATE`);
    if (active) throw conflict("يوجد فريق نشط لهذا النشاط — أوقفه أولًا");
    const nowMs = await dbNowMs(tx);
    const r = await tx.execute(sql`INSERT INTO teams (tenantId, businessId, name, activatedAt, createdByEmployeeId, idempotencyKey, payloadHash)
      VALUES (${actor.tenantId}, ${v.businessId}, ${v.name}, ${ts(nowMs)}, ${actor.employeeId}, ${key}, ${hash})`);
    return { id: insertId(r), replay: false };
  }));
}

export const renameTeamInput = z.object({ teamId: id, name: teamName, expectedVersion: z.number().int().positive(), operationId: operationIdSchema }).strict();
/**
 * إعادة التسمية: Idempotent بالحالة (لا عمود مفتاح لها في 0044) — الاسم نفسه = Replay بلا تغيير؛ نسخة قديمة
 * لاسم مختلف = CONFLICT (قفل تفاؤلي). الفريق الموقوف لا يُعدَّل.
 */
export async function renameTeam(actor: TeamsActor, input: z.infer<typeof renameTeamInput>) {
  const v = renameTeamInput.parse(input);
  return runTeamsTx(async tx => {
    await assertActor(tx, actor);
    const t = await lockTeam(tx, actor.tenantId, v.teamId);
    requireActiveTeam(t);
    if (t.name === v.name) return { id: v.teamId, version: Number(t.version), replay: true };
    if (Number(t.version) !== v.expectedVersion) throw conflict("الفريق تغيّر منذ فتحه — أعد التحميل");
    await tx.execute(sql`UPDATE teams SET name = ${v.name}, version = version + 1 WHERE id = ${v.teamId} AND tenantId = ${actor.tenantId}`);
    return { id: v.teamId, version: v.expectedVersion + 1, replay: false };
  });
}

export const deactivateTeamInput = z.object({ teamId: id, operationId: operationIdSchema }).strict();
/**
 * إيقاف نهائي: في معاملة واحدة وبنفس اللحظة — الفريق isActive=0 وكل عضوياته وقيادته المفتوحة تُغلق
 * بـeffectiveToAt = deactivatedAt. لا حذف. Replay يرجع النتيجة المخزنة بلا أي تغيير.
 */
export async function deactivateTeam(actor: TeamsActor, input: z.infer<typeof deactivateTeamInput>) {
  const v = deactivateTeamInput.parse(input);
  const key = `tdeact:${v.operationId}`;
  const hash = canonicalHash({ op: "deactivate_team", teamId: v.teamId });
  return withIdempotentRetry(() => runTeamsTx(async tx => {
    await assertActor(tx, actor);
    const t = await lockTeam(tx, actor.tenantId, v.teamId);
    const replay = await replayByKey(tx, "teams", "deactivationIdempotencyKey", "deactivationPayloadHash", actor.tenantId, key, hash);
    if (replay) {
      const closed = Number((await one(tx, sql`SELECT COUNT(*) AS n FROM team_memberships WHERE tenantId = ${actor.tenantId} AND teamId = ${v.teamId} AND endIdempotencyKey LIKE ${`${key}#%`}`)).n);
      return { id: v.teamId, deactivatedAtMs: num(t.deactivatedMs), closedMemberships: closed, replay: true };
    }
    if (!Number(t.isActive)) throw conflict("الفريق موقوف مسبقًا");
    const open = (await lockTeamMemberships(tx, actor.tenantId, v.teamId)).filter(m => m.toMs === null);
    const atMs = transitionMs(await dbNowMs(tx), toTeam(t), open);
    const r = await tx.execute(sql`UPDATE teams SET isActive = 0, deactivatedAt = ${ts(atMs)}, deactivatedByEmployeeId = ${actor.employeeId}, deactivationIdempotencyKey = ${key}, deactivationPayloadHash = ${hash}, version = version + 1
      WHERE id = ${v.teamId} AND tenantId = ${actor.tenantId} AND isActive = 1`);
    if (affected(r) !== 1) throw conflict("تغيّر الفريق أثناء التنفيذ — أعد المحاولة");
    for (const m of open) await closeMembership(tx, actor, m.id, atMs, `${key}#c${m.id}`, hash);
    return { id: v.teamId, deactivatedAtMs: atMs, closedMemberships: open.length, replay: false };
  }));
}

export const addMemberInput = z.object({ teamId: id, employeeId: id, operationId: operationIdSchema }).strict();
/** إضافة عضو من الآن: الفريق نشط، الموظف نشط في نفس الشركة، لا عضوية مفتوحة ولا تداخل تاريخي. */
export async function addMember(actor: TeamsActor, input: z.infer<typeof addMemberInput>) {
  const v = addMemberInput.parse(input);
  const key = `tmember:${v.operationId}`;
  const hash = canonicalHash({ op: "add_member", teamId: v.teamId, employeeId: v.employeeId });
  return withIdempotentRetry(() => runTeamsTx(async tx => {
    await assertActor(tx, actor);
    const t = await lockTeam(tx, actor.tenantId, v.teamId);
    const replay = await replayByKey(tx, "team_memberships", "idempotencyKey", "payloadHash", actor.tenantId, key, hash);
    if (replay) return { membershipId: Number(replay.id), replay: true };
    requireActiveTeam(t);
    await activeEmployee(tx, actor.tenantId, v.employeeId);
    const all = await lockTeamMemberships(tx, actor.tenantId, v.teamId);
    if (all.some(m => m.employeeId === v.employeeId && m.toMs === null)) throw conflict("الموظف عضو فعّال في الفريق بالفعل");
    const atMs = transitionMs(await dbNowMs(tx), toTeam(t), []);
    assertNoHistoricalOverlap(all, v.employeeId, "member", atMs);
    const membershipId = await insertMembership(tx, actor, { teamId: v.teamId, employeeId: v.employeeId, role: "member", fromMs: atMs, key, hash });
    return { membershipId, fromMs: atMs, replay: false };
  }));
}

export const endMembershipInput = z.object({ membershipId: id, operationId: operationIdSchema }).strict();
/** إنهاء عضوية (أو قيادة) مفتوحة من الآن. Replay لا يغيّر effectiveToAt. */
export async function endMembership(actor: TeamsActor, input: z.infer<typeof endMembershipInput>) {
  const v = endMembershipInput.parse(input);
  const key = `tend:${v.operationId}`;
  const hash = canonicalHash({ op: "end_membership", membershipId: v.membershipId });
  return withIdempotentRetry(() => runTeamsTx(async tx => {
    await assertActor(tx, actor);
    const ref = await one(tx, sql`SELECT teamId FROM team_memberships WHERE id = ${v.membershipId} AND tenantId = ${actor.tenantId}`);
    if (!ref) throw notFound("العضوية غير موجودة");
    const t = await lockTeam(tx, actor.tenantId, Number(ref.teamId));
    const replay = await replayByKey(tx, "team_memberships", "endIdempotencyKey", "endPayloadHash", actor.tenantId, key, hash);
    if (replay) {
      const m = await one(tx, sql`SELECT ${MS("effectiveToAt")} AS toMs FROM team_memberships WHERE id = ${v.membershipId}`);
      return { membershipId: v.membershipId, toMs: num(m?.toMs), replay: true };
    }
    requireActiveTeam(t);
    const m = (await lockTeamMemberships(tx, actor.tenantId, Number(ref.teamId))).find(x => x.id === v.membershipId)!;
    if (m.toMs !== null) throw conflict("العضوية منتهية مسبقًا");
    const atMs = transitionMs(await dbNowMs(tx), toTeam(t), [m]);
    await closeMembership(tx, actor, m.id, atMs, key, hash);
    return { membershipId: m.id, toMs: atMs, replay: false };
  }));
}

export const setLeaderInput = z.object({ teamId: id, employeeId: id, operationId: operationIdSchema }).strict();
/**
 * تعيين القائد في لحظة واحدة T: إغلاق قيادة القائد الحالي (ويعود عضوًا من T إن كان نشطًا) وإغلاق عضوية القائد
 * الجديد العادية وفتح قيادته من T. القائد يجب أن يكون عضوًا فعّالًا. القائد الحالي نفسه = بلا تغيير.
 */
export async function setLeader(actor: TeamsActor, input: z.infer<typeof setLeaderInput>) {
  const v = setLeaderInput.parse(input);
  const key = `tleader:${v.operationId}`;
  const hash = canonicalHash({ op: "set_leader", teamId: v.teamId, employeeId: v.employeeId });
  return withIdempotentRetry(() => runTeamsTx(async tx => {
    await assertActor(tx, actor);
    const t = await lockTeam(tx, actor.tenantId, v.teamId);
    const replay = await replayByKey(tx, "team_memberships", "idempotencyKey", "payloadHash", actor.tenantId, key, hash);
    if (replay) return { membershipId: Number(replay.id), changed: true, replay: true };
    requireActiveTeam(t);
    await activeEmployee(tx, actor.tenantId, v.employeeId);
    const all = await lockTeamMemberships(tx, actor.tenantId, v.teamId);
    const mine = all.find(m => m.employeeId === v.employeeId && m.toMs === null);
    if (!mine) throw bad("القائد يجب أن يكون عضوًا فعّالًا في الفريق — أضفه عضوًا أولًا");
    if (mine.membershipRole === "leader") return { membershipId: mine.id, changed: false, replay: false };
    const oldLead = all.find(m => m.membershipRole === "leader" && m.toMs === null) ?? null;
    const atMs = transitionMs(await dbNowMs(tx), toTeam(t), oldLead ? [mine, oldLead] : [mine]);
    assertNoHistoricalOverlap(all, v.employeeId, "leader", atMs, oldLead ? [mine.id, oldLead.id] : [mine.id]);
    if (oldLead) {
      await closeMembership(tx, actor, oldLead.id, atMs, `${key}#old`, hash);
      const still = await one(tx, sql`SELECT isActive FROM employees WHERE id = ${oldLead.employeeId} AND tenantId = ${actor.tenantId}`);
      if (still && Number(still.isActive))
        await insertMembership(tx, actor, { teamId: v.teamId, employeeId: oldLead.employeeId, role: "member", fromMs: atMs, key: `${key}#demote`, hash });
    }
    await closeMembership(tx, actor, mine.id, atMs, `${key}#member`, hash);
    const membershipId = await insertMembership(tx, actor, { teamId: v.teamId, employeeId: v.employeeId, role: "leader", fromMs: atMs, key, hash });
    return { membershipId, fromMs: atMs, previousLeaderEmployeeId: oldLead?.employeeId ?? null, changed: true, replay: false };
  }));
}

export const endLeadershipInput = z.object({ teamId: id, operationId: operationIdSchema }).strict();
/** إنهاء القيادة بلا بديل: القائد يعود عضوًا من نفس اللحظة (إن كان نشطًا). */
export async function endLeadership(actor: TeamsActor, input: z.infer<typeof endLeadershipInput>) {
  const v = endLeadershipInput.parse(input);
  const key = `tunlead:${v.operationId}`;
  const hash = canonicalHash({ op: "end_leadership", teamId: v.teamId });
  return withIdempotentRetry(() => runTeamsTx(async tx => {
    await assertActor(tx, actor);
    const t = await lockTeam(tx, actor.tenantId, v.teamId);
    const replay = await replayByKey(tx, "team_memberships", "endIdempotencyKey", "endPayloadHash", actor.tenantId, key, hash);
    if (replay) return { membershipId: Number(replay.id), replay: true };
    requireActiveTeam(t);
    const all = await lockTeamMemberships(tx, actor.tenantId, v.teamId);
    const lead = all.find(m => m.membershipRole === "leader" && m.toMs === null);
    if (!lead) throw conflict("لا يوجد قائد فعّال لهذا الفريق");
    const atMs = transitionMs(await dbNowMs(tx), toTeam(t), [lead]);
    await closeMembership(tx, actor, lead.id, atMs, key, hash);
    const still = await one(tx, sql`SELECT isActive FROM employees WHERE id = ${lead.employeeId} AND tenantId = ${actor.tenantId}`);
    if (still && Number(still.isActive))
      await insertMembership(tx, actor, { teamId: v.teamId, employeeId: lead.employeeId, role: "member", fromMs: atMs, key: `${key}#demote`, hash });
    return { membershipId: lead.id, toMs: atMs, replay: false };
  }));
}

// ==================== القراءة (المالك/الإدارة: teams.view_all) ====================

const scopeFilter = (allowedBusinessIds: number[]) =>
  sql`t.businessId IN (${sql.join((allowedBusinessIds.length ? allowedBusinessIds : [-1]).map(b => sql`${b}`), sql`, `)})`;

/** الفرق داخل نطاق أنشطة الجلسة (النطاق الفارغ = صفر صفوف) مع القائد الحالي وعدد الأعضاء الفعّالين. */
export async function listTeams(tenantId: number, allowedBusinessIds: number[], opts: { includeInactive?: boolean } = {}) {
  return runTeamsTx(async tx => rows(await tx.execute(sql`SELECT t.id, t.businessId, b.name AS businessName, t.name, t.isActive, t.version,
      ${MS("t.activatedAt")} AS activatedMs, ${MS("t.deactivatedAt")} AS deactivatedMs,
      (SELECT m.employeeId FROM team_memberships m WHERE m.tenantId = t.tenantId AND m.teamId = t.id AND m.openLeaderTeamId IS NOT NULL) AS leaderEmployeeId,
      (SELECT e.name FROM team_memberships m JOIN employees e ON e.id = m.employeeId AND e.tenantId = m.tenantId WHERE m.tenantId = t.tenantId AND m.teamId = t.id AND m.openLeaderTeamId IS NOT NULL) AS leaderName,
      (SELECT COUNT(*) FROM team_memberships m WHERE m.tenantId = t.tenantId AND m.teamId = t.id AND m.effectiveToAt IS NULL) AS activeMembers
    FROM teams t JOIN businesses b ON b.id = t.businessId AND b.tenantId = t.tenantId
    WHERE t.tenantId = ${tenantId} AND ${scopeFilter(allowedBusinessIds)} ${opts.includeInactive ? sql`` : sql`AND t.isActive = 1`}
    ORDER BY t.isActive DESC, b.name, t.id DESC`)).map(r => ({
      id: Number(r.id), businessId: Number(r.businessId), businessName: r.businessName, name: r.name, isActive: Boolean(Number(r.isActive)), version: Number(r.version),
      activatedMs: Number(r.activatedMs), deactivatedMs: num(r.deactivatedMs), leaderEmployeeId: num(r.leaderEmployeeId), leaderName: r.leaderName ?? null, activeMembers: Number(r.activeMembers),
    })));
}

async function teamInScope(tx: any, tenantId: number, teamId: number, allowedBusinessIds: number[]) {
  const t = await one(tx, sql`SELECT ${TEAM_COLS} FROM teams t WHERE t.id = ${teamId} AND t.tenantId = ${tenantId} AND ${scopeFilter(allowedBusinessIds)}`);
  if (!t) throw notFound();
  return toTeam(t);
}

const memberView = (r: any) => ({ ...toMem(r), employeeName: r.employeeName ?? null });

/** فريق + أعضاؤه الفعّالون الآن (القائد بينهم بدوره). */
export async function getTeam(tenantId: number, teamId: number, allowedBusinessIds: number[]) {
  return runTeamsTx(async tx => {
    const team = await teamInScope(tx, tenantId, teamId, allowedBusinessIds);
    const members = rows(await tx.execute(sql`SELECT m.id, m.teamId, m.employeeId, m.membershipRole, ${MS("m.effectiveFromAt")} AS fromMs, ${MS("m.effectiveToAt")} AS toMs, e.name AS employeeName
      FROM team_memberships m JOIN employees e ON e.id = m.employeeId AND e.tenantId = m.tenantId
      WHERE m.tenantId = ${tenantId} AND m.teamId = ${teamId} AND m.effectiveToAt IS NULL ORDER BY m.membershipRole = 'leader' DESC, e.name`)).map(memberView);
    return { team, members };
  });
}

/** السجل الكامل (كل الفترات، بمن أسند ومن أنهى) — لا يُحذف شيء. */
export async function teamHistory(tenantId: number, teamId: number, allowedBusinessIds: number[]) {
  return runTeamsTx(async tx => {
    const team = await teamInScope(tx, tenantId, teamId, allowedBusinessIds);
    const history = rows(await tx.execute(sql`SELECT m.id, m.teamId, m.employeeId, m.membershipRole, ${MS("m.effectiveFromAt")} AS fromMs, ${MS("m.effectiveToAt")} AS toMs,
        e.name AS employeeName, m.assignedByEmployeeId, a.name AS assignedByName, m.endedByEmployeeId, x.name AS endedByName
      FROM team_memberships m
      JOIN employees e ON e.id = m.employeeId AND e.tenantId = m.tenantId
      JOIN employees a ON a.id = m.assignedByEmployeeId AND a.tenantId = m.tenantId
      LEFT JOIN employees x ON x.id = m.endedByEmployeeId AND x.tenantId = m.tenantId
      WHERE m.tenantId = ${tenantId} AND m.teamId = ${teamId} ORDER BY m.effectiveFromAt, m.id`)).map(r => ({
        ...memberView(r), assignedByEmployeeId: Number(r.assignedByEmployeeId), assignedByName: r.assignedByName, endedByEmployeeId: num(r.endedByEmployeeId), endedByName: r.endedByName ?? null,
      }));
    return { team, history };
  });
}

/**
 * سياق يوم العمل للفريق (قراءة فقط): أعضاؤه الحاليون بدور الموظف ونشاطه الأصلي (مدخلات منطق الورديات)، وتاريخ
 * العمل اليوم بتوقيت نشاط الفريق (businesses.timezone، وإلا Africa/Cairo).
 */
export async function teamWorkContext(tenantId: number, teamId: number) {
  return runTeamsTx(async tx => {
    const t = await one(tx, sql`SELECT t.id, t.name, t.businessId, COALESCE(b.timezone, 'Africa/Cairo') AS tz FROM teams t JOIN businesses b ON b.id = t.businessId AND b.tenantId = t.tenantId WHERE t.id = ${teamId} AND t.tenantId = ${tenantId}`);
    if (!t) throw notFound();
    const members = rows(await tx.execute(sql`SELECT m.employeeId, m.membershipRole, e.name AS employeeName, e.role, e.businessId
      FROM team_memberships m JOIN employees e ON e.id = m.employeeId AND e.tenantId = m.tenantId
      WHERE m.tenantId = ${tenantId} AND m.teamId = ${teamId} AND m.effectiveToAt IS NULL ORDER BY m.membershipRole = 'leader' DESC, e.name`))
      .map(r => ({ employeeId: Number(r.employeeId), membershipRole: r.membershipRole as "member" | "leader", employeeName: r.employeeName as string, role: (r.role ?? null) as string | null, businessId: num(r.businessId) }));
    const nowMs = await dbNowMs(tx);
    return { team: { teamId: Number(t.id), name: String(t.name), businessId: Number(t.businessId) }, timeZone: String(t.tz), workDate: businessDateKey(new Date(nowMs), String(t.tz)), members };
  });
}

/** تحقق نطاق المالك للفريق (نفس الشركة وأنشطة الجلسة) — بلا بيانات. */
export async function assertTeamInScope(tenantId: number, teamId: number, allowedBusinessIds: number[]): Promise<void> {
  await runTeamsTx(async tx => { await teamInScope(tx, tenantId, teamId, allowedBusinessIds); });
}

// ==================== نطاق القائد (البوابة) + Helpers قراءة/تحقق للمراحل اللاحقة ====================

/** businessName من علاقة الفريق ← النشاط الموثوقة (نفس الشركة)؛ مضمون غير فارغ بقيد FK (tenantId, businessId) RESTRICT + businesses.name NOT NULL — لا يُقبل من العميل. */
export type LeaderTeam = { teamId: number; businessId: number; name: string; businessName: string };

/**
 * فرق يقودها الموظف **فعليًا** لحظة atMs (افتراضيًا الآن): صف قيادة فعّال، فريق نشط، الموظف نشط، نفس الشركة.
 * غير القائد = [] (صفر بيانات) مهما كانت صلاحياته.
 */
export async function leaderTeams(actor: TeamsActor, atMs?: number): Promise<LeaderTeam[]> {
  return runTeamsTx(async tx => leaderTeamsTx(tx, actor, atMs));
}
async function leaderTeamsTx(tx: any, actor: TeamsActor, atMs?: number): Promise<LeaderTeam[]> {
  if (!Number.isInteger(actor.employeeId) || actor.employeeId <= 0) return [];
  const at = ts(atMs ?? (await dbNowMs(tx)));
  return rows(await tx.execute(sql`SELECT t.id AS teamId, t.businessId, t.name, b.name AS businessName
    FROM team_memberships m
    JOIN teams t ON t.id = m.teamId AND t.tenantId = m.tenantId
    JOIN businesses b ON b.id = t.businessId AND b.tenantId = t.tenantId
    JOIN employees e ON e.id = m.employeeId AND e.tenantId = m.tenantId
    WHERE m.tenantId = ${actor.tenantId} AND m.employeeId = ${actor.employeeId} AND m.membershipRole = 'leader'
      AND m.effectiveFromAt <= ${at} AND (m.effectiveToAt IS NULL OR ${at} < m.effectiveToAt)
      AND t.isActive = 1 AND e.isActive = 1
    ORDER BY t.id`)).map(r => ({ teamId: Number(r.teamId), businessId: Number(r.businessId), name: r.name, businessName: String(r.businessName) }));
}

/** نفس حارس القائد داخل معاملة قائمة (للكتابات التي تقفل صف الفريق أولًا ثم تتحقق من القيادة ذريًا). */
export async function requireLeaderOfTx(tx: any, actor: TeamsActor, teamId: number): Promise<LeaderTeam> {
  const t = (await leaderTeamsTx(tx, actor)).find(x => x.teamId === teamId);
  if (!t) throw forbidden("لست قائدًا فعّالًا لهذا الفريق");
  return t;
}

/** حارس القائد: قيادة فعّالة لهذا الفريق بالذات وإلا FORBIDDEN (لا نكشف وجود فرق الآخرين). */
export async function requireLeaderOf(actor: TeamsActor, teamId: number): Promise<LeaderTeam> {
  const mine = await leaderTeams(actor);
  const t = mine.find(x => x.teamId === teamId);
  if (!t) throw forbidden("لست قائدًا فعّالًا لهذا الفريق");
  return t;
}

/** أعضاء الفريق الفعّالون لحظة atMs (بما فيهم القائد) — قراءة فقط. */
export async function teamMembersAt(tenantId: number, teamId: number, atMs?: number) {
  return runTeamsTx(async tx => {
    const at = ts(atMs ?? (await dbNowMs(tx)));
    return rows(await tx.execute(sql`SELECT m.id, m.teamId, m.employeeId, m.membershipRole, ${MS("m.effectiveFromAt")} AS fromMs, ${MS("m.effectiveToAt")} AS toMs, e.name AS employeeName
      FROM team_memberships m JOIN employees e ON e.id = m.employeeId AND e.tenantId = m.tenantId
      WHERE m.tenantId = ${tenantId} AND m.teamId = ${teamId} AND m.effectiveFromAt <= ${at} AND (m.effectiveToAt IS NULL OR ${at} < m.effectiveToAt)
      ORDER BY m.membershipRole = 'leader' DESC, e.name`)).map(memberView);
  });
}

/**
 * Helper تحقق (للإسناد لاحقًا — غير موصول بأي واجهة): الموظف عضو فعّال الآن في فريق نشط، ونفس الشركة.
 * يُستخدم قبل إسناد أوردر/مهمة من القائد؛ لا يكتب شيئًا.
 */
export async function assertAssignableTeamMember(tenantId: number, teamId: number, employeeId: number): Promise<void> {
  const members = await teamMembersAt(tenantId, teamId);
  const team = await runTeamsTx(async tx => one(tx, sql`SELECT isActive FROM teams WHERE id = ${teamId} AND tenantId = ${tenantId}`));
  if (!team || !Number(team.isActive)) throw notFound();
  if (!members.some(m => m.employeeId === employeeId)) throw forbidden("الموظف ليس عضوًا فعّالًا في فريقك");
}

/**
 * Helper قراءة لنسب الأداء لاحقًا (غير موصول): نشاط الفريق + كل فترات العضوية/القيادة المتقاطعة مع [fromMs, toMs).
 * الحدث يُحسب للفريق بـeventCountsForTeam (shared/teamsSpec) — نفس tenant + نفس النشاط + فعّال لحظة occurredAt.
 */
export async function teamAttributionScope(tenantId: number, teamId: number, fromMs: number, toMs: number) {
  return runTeamsTx(async tx => {
    const t = await one(tx, sql`SELECT id, tenantId, businessId FROM teams WHERE id = ${teamId} AND tenantId = ${tenantId}`);
    if (!t) throw notFound();
    const intervals = rows(await tx.execute(sql`SELECT employeeId, ${MS("effectiveFromAt")} AS fromMs, ${MS("effectiveToAt")} AS toMs FROM team_memberships
      WHERE tenantId = ${tenantId} AND teamId = ${teamId} AND effectiveFromAt < ${ts(toMs)} AND (effectiveToAt IS NULL OR effectiveToAt > ${ts(fromMs)})`))
      .map(r => ({ employeeId: Number(r.employeeId), fromMs: Number(r.fromMs), toMs: num(r.toMs) }));
    return { team: { tenantId: Number(t.tenantId), businessId: Number(t.businessId) }, intervals };
  });
}
