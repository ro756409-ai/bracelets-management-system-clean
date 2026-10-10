import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { MESSAGING_LIMITS, MESSAGING_TABLES, PRIVACY_NOTICE, REACTIONS, conversationUniqueKey, type ConversationKind } from "../shared/messagingSpec";
import { getDb } from "./db";
import { canonicalHash } from "./orderEvents.service";
import { OWNER_ROLES } from "./permissions";
import { MESSAGE_KEY_PATTERN, keyBelongsToTenant } from "./messagingStorage";

/**
 * مركز الرسائل (0043) — خلف العلم `MESSAGING_ENABLED` (افتراضيًا معطل).
 *
 *  • كل عملية داخل معاملة تبدأ بـ`SET time_zone = '+00:00'` ثم فحص وجود الجداول التسعة (غيابها والعلم مفعّل
 *    = PRECONDITION_FAILED). الطوابع تُقرأ بـUNIX_TIMESTAMP (ms) — لا اعتماد على timezone الاتصال.
 *  • الهوية (tenant/الموظف) من الجلسة فقط ويُعاد التحقق منها من الـDB (نشط + نفس الشركة)؛ الدور المعتمد للاطلاع
 *    هو دور الـDB لا ما يمرّره العميل.
 *  • الاطلاع على المحادثات الخاصة (direct/group): للمالك فقط ومع صلاحية `viewPrivate`، قراءة فقط، وكل فتح
 *    يُسجَّل في msg_access_audit (مرة كل 30 دقيقة لكل محادثة حتى لا يُغرق الـPolling السجل)، وكل استماع لصوت يُسجَّل.
 *  • التعديل والحذف لصاحب الرسالة فقط؛ النسخة السابقة تُحفظ في msg_message_edits؛ الحذف ناعم. الصوت لا يُعدَّل.
 *  • Idempotency للإرسال: نفس المفتاح + نفس الـhash = Replay، hash مختلف = CONFLICT.
 *  • لا كتابة خارج جداول msg_*.
 */
export const messagingEnabled = () => process.env.MESSAGING_ENABLED === "true";

export type MessagingActor = { tenantId: number; employeeId: number; role: string | null; businessId: number | null };
/** صلاحيات يحسبها الراوتر من نظام الصلاحيات ويمرّرها كقيم منطقية. */
export type MessagingPerms = { announce: boolean; manageGroups: boolean; viewPrivate: boolean; voice: boolean };

const OP = z.string().regex(/^[A-Za-z0-9_:-]{8,100}$/);
const ID = z.number().int().positive();
const rows = (r: any): any[] => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []);
const one = async (tx: any, q: any) => rows(await tx.execute(q))[0];
const insertId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId);
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message });
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });
const notFound = (message = "المحادثة غير موجودة") => new TRPCError({ code: "NOT_FOUND", message });
const ms = (col: string) => sql.raw(`CAST(UNIX_TIMESTAMP(${col}) * 1000 AS UNSIGNED)`);
const num = (v: any) => (v == null ? null : Number(v));

/** أنواع المحادثات الخاصة التي يجوز للمالك الاطلاع عليها (قراءة فقط). */
const MONITORABLE: ConversationKind[] = ["direct", "group"];
const AUDIT_DEDUPE_MINUTES = 30;

async function assertMessagingReady(tx: any): Promise<void> {
  const r = rows(await tx.execute(sql`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${sql.join(MESSAGING_TABLES.map(t => sql`${t}`), sql`, `)})`));
  if (Number(r[0]?.n ?? 0) !== MESSAGING_TABLES.length)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الرسائل مفعّلة لكن جداولها غير موجودة (0043 غير مطبّقة) — لم يُنفَّذ أي تغيير" });
}

function requireEnabled() {
  if (!messagingEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مركز الرسائل غير مفعّل" });
}

/** معاملة رسائل: UTC صريح + فحص الجاهزية. */
export async function runMessagingTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  requireEnabled();
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  return db.transaction(async tx => {
    await tx.execute(sql`SET time_zone = '+00:00'`);
    await assertMessagingReady(tx);
    return fn(tx);
  });
}

type Me = { id: number; role: string; businessId: number | null; canMonitor: boolean };
/** الموظف من الـDB: نشط وفي نفس الشركة؛ صلاحية الاطلاع = دور مالك فعلي + الصلاحية. */
async function loadMe(tx: any, actor: MessagingActor, perms?: Partial<MessagingPerms>): Promise<Me> {
  const e = await one(tx, sql`SELECT id, role, businessId, isActive FROM employees WHERE id = ${actor.employeeId} AND tenantId = ${actor.tenantId}`);
  if (!e || !Number(e.isActive)) throw forbidden("حساب الموظف غير نشط");
  return { id: Number(e.id), role: e.role, businessId: num(e.businessId), canMonitor: Boolean(perms?.viewPrivate) && (OWNER_ROLES as readonly string[]).includes(e.role) };
}

type Access = { conv: any; member: any | null; monitor: boolean };
/** عضو فعّال، أو مالك يطّلع على محادثة خاصة (قراءة فقط)، وإلا مرفوض. شركة أخرى = غير موجودة. */
async function access(tx: any, actor: MessagingActor, me: Me, conversationId: number, lock = false): Promise<Access> {
  const conv = await one(tx, sql`SELECT id, kind, businessId, title, uniqueKey, createdByEmployeeId, lastMessageId, isArchived FROM msg_conversations WHERE id = ${conversationId} AND tenantId = ${actor.tenantId}${lock ? sql` FOR UPDATE` : sql``}`);
  if (!conv) throw notFound();
  const member = await one(tx, sql`SELECT id, role, lastReadMessageId FROM msg_members WHERE tenantId = ${actor.tenantId} AND conversationId = ${conv.id} AND employeeId = ${me.id} AND leftAt IS NULL`);
  if (member) return { conv, member, monitor: false };
  if (me.canMonitor && MONITORABLE.includes(conv.kind)) return { conv, member: null, monitor: true };
  throw forbidden("لست عضوًا في هذه المحادثة");
}
const requireMember = (a: Access) => { if (!a.member) throw forbidden("عرض للقراءة فقط — لا يمكنك المشاركة في هذه المحادثة"); };

async function messageInTenant(tx: any, actor: MessagingActor, messageId: number, lock = false) {
  const m = await one(tx, sql`SELECT id, conversationId, senderEmployeeId, kind, title, body, isPinned, deletedAt FROM msg_messages WHERE id = ${messageId} AND tenantId = ${actor.tenantId}${lock ? sql` FOR UPDATE` : sql``}`);
  if (!m) throw notFound("الرسالة غير موجودة");
  return m;
}

async function auditOpen(tx: any, actor: MessagingActor, me: Me, conversationId: number) {
  const recent = await one(tx, sql`SELECT id FROM msg_access_audit WHERE tenantId = ${actor.tenantId} AND viewerEmployeeId = ${me.id} AND conversationId = ${conversationId} AND action = 'open' AND viewedAt > NOW(3) - INTERVAL ${AUDIT_DEDUPE_MINUTES} MINUTE LIMIT 1`);
  if (!recent) await tx.execute(sql`INSERT INTO msg_access_audit (tenantId, viewerEmployeeId, conversationId, action) VALUES (${actor.tenantId}, ${me.id}, ${conversationId}, 'open')`);
}

/** Replay/Conflict بمفتاح العملية — قراءة قافلة قبل أي تغيير. */
async function replayCheck(tx: any, tenantId: number, key: string, hash: string): Promise<number | null> {
  const ex = await one(tx, sql`SELECT id, payloadHash FROM msg_messages WHERE tenantId = ${tenantId} AND idempotencyKey = ${key} FOR UPDATE`);
  if (!ex) return null;
  if (ex.payloadHash === hash) return Number(ex.id);
  throw conflict("نفس معرّف العملية استُخدم لرسالة مختلفة — لم يُنفَّذ أي تغيير");
}

/**
 * سباق نفس معرّف العملية: قراءتان قافلتان لمفتاح غير موجود تأخذان قفل فجوة متوافقًا ثم يتعارض الإدراجان
 * (Deadlock 1213 أو Duplicate 1062 على فهرس الـidempotency). نعيد المحاولة مرة فتتحول للـReplay/CONFLICT.
 */
async function withIdempotentRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e: any) {
    if (isIdempotencyRace(e)) return attempt();
    throw e;
  }
}
function isIdempotencyRace(e: any): boolean {
  for (let c = e; c; c = c.cause) {
    if (c.errno === 1213 || c.code === "ER_LOCK_DEADLOCK") return true;
    if ((c.errno === 1062 || c.code === "ER_DUP_ENTRY") && /_idempotency_unique/.test(String(c.sqlMessage ?? c.message ?? ""))) return true;
  }
  return false;
}

async function touchConversation(tx: any, actor: MessagingActor, conversationId: number, messageId: number, senderId: number | null) {
  await tx.execute(sql`UPDATE msg_conversations SET lastMessageId = ${messageId}, lastMessageAt = NOW(3) WHERE id = ${conversationId} AND tenantId = ${actor.tenantId}`);
  if (senderId != null) await tx.execute(sql`UPDATE msg_members SET lastReadMessageId = GREATEST(COALESCE(lastReadMessageId, 0), ${messageId}) WHERE tenantId = ${actor.tenantId} AND conversationId = ${conversationId} AND employeeId = ${senderId}`);
}

// ==================== القنوات الافتراضية ====================
async function upsertConversation(tx: any, tenantId: number, kind: ConversationKind, uniqueKey: string, extra: { businessId?: number | null; createdBy?: number | null } = {}): Promise<number> {
  // LAST_INSERT_ID(id) يعيد معرّف الموجود عند التكرار — آمن مع التزامن بلا استثناء Duplicate.
  const r = await tx.execute(sql`INSERT INTO msg_conversations (tenantId, kind, businessId, uniqueKey, createdByEmployeeId) VALUES (${tenantId}, ${kind}, ${extra.businessId ?? null}, ${uniqueKey}, ${extra.createdBy ?? null})
    ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`);
  return insertId(r);
}

/**
 * يضمن قنوات الشركة (الإعلانات، الفريق، قناة لكل نشاط) وعضوياتها، ورسالة سياسة الخصوصية مرة واحدة.
 * Idempotent — يُستدعى عند فتح المركز. الإعلانات والفريق: كل الموظفين النشطين. النشاط: موظفوه + المالك.
 */
export async function ensureDefaults(actor: MessagingActor) {
  return runMessagingTx(async tx => {
    await loadMe(tx, actor);
    await tx.execute(sql`SELECT id FROM tenants WHERE id = ${actor.tenantId} FOR UPDATE`);
    const t = actor.tenantId;
    const ann = await upsertConversation(tx, t, "announcement", conversationUniqueKey.announcement());
    const team = await upsertConversation(tx, t, "team", conversationUniqueKey.team());
    const owners = sql.join((OWNER_ROLES as readonly string[]).map(r => sql`${r}`), sql`, `);
    for (const c of [ann, team])
      await tx.execute(sql`INSERT INTO msg_members (tenantId, conversationId, employeeId) SELECT ${t}, ${c}, e.id FROM employees e WHERE e.tenantId = ${t} AND e.isActive = 1
        ON DUPLICATE KEY UPDATE msg_members.id = msg_members.id`);
    const businesses = rows(await tx.execute(sql`SELECT id FROM businesses WHERE tenantId = ${t} ORDER BY id`));
    for (const b of businesses) {
      const c = await upsertConversation(tx, t, "business", conversationUniqueKey.business(Number(b.id)), { businessId: Number(b.id) });
      await tx.execute(sql`INSERT INTO msg_members (tenantId, conversationId, employeeId) SELECT ${t}, ${c}, e.id FROM employees e
        WHERE e.tenantId = ${t} AND e.isActive = 1 AND (e.businessId = ${b.id} OR e.role IN (${owners}))
        ON DUPLICATE KEY UPDATE msg_members.id = msg_members.id`);
    }
    const key = "sys:policy";
    const hash = canonicalHash({ system: "policy", text: PRIVACY_NOTICE });
    if ((await replayCheck(tx, t, key, hash)) == null) {
      const id = insertId(await tx.execute(sql`INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body, idempotencyKey, payloadHash) VALUES (${t}, ${ann}, NULL, 'system', ${PRIVACY_NOTICE}, ${key}, ${hash})`));
      await touchConversation(tx, actor, ann, id, null);
    }
    return { announcementId: ann, teamId: team, businessChannels: businesses.length };
  });
}

// ==================== القراءة ====================
/** محادثاتي مع غير المقروء وآخر رسالة، + قائمة الاطلاع للمالك (المحادثات الخاصة التي لست طرفًا فيها). */
export async function listConversations(actor: MessagingActor, perms: Partial<MessagingPerms> = {}) {
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const t = actor.tenantId;
    const mine = rows(await tx.execute(sql`
      SELECT c.id, c.kind, c.businessId, c.title, c.lastMessageId, ${ms("c.lastMessageAt")} AS lastMessageAt, m.lastReadMessageId,
        (SELECT COUNT(*) FROM msg_messages x WHERE x.tenantId = c.tenantId AND x.conversationId = c.id AND x.id > COALESCE(m.lastReadMessageId, 0)
           AND x.deletedAt IS NULL AND (x.senderEmployeeId IS NULL OR x.senderEmployeeId <> ${me.id})) AS unread,
        lm.kind AS lastKind, lm.title AS lastTitle, IF(lm.deletedAt IS NULL, LEFT(lm.body, 120), NULL) AS lastPreview, lm.deletedAt IS NOT NULL AS lastDeleted,
        ls.name AS lastSenderName, b.name AS businessName,
        (SELECT e.name FROM msg_members pm JOIN employees e ON e.id = pm.employeeId AND e.tenantId = pm.tenantId
           WHERE c.kind = 'direct' AND pm.tenantId = c.tenantId AND pm.conversationId = c.id AND pm.employeeId <> ${me.id} LIMIT 1) AS peerName,
        (SELECT pm.employeeId FROM msg_members pm WHERE c.kind = 'direct' AND pm.tenantId = c.tenantId AND pm.conversationId = c.id AND pm.employeeId <> ${me.id} LIMIT 1) AS peerEmployeeId
      FROM msg_members m
      JOIN msg_conversations c ON c.tenantId = m.tenantId AND c.id = m.conversationId
      LEFT JOIN msg_messages lm ON lm.tenantId = c.tenantId AND lm.id = c.lastMessageId
      LEFT JOIN employees ls ON ls.tenantId = lm.tenantId AND ls.id = lm.senderEmployeeId
      LEFT JOIN businesses b ON b.tenantId = c.tenantId AND b.id = c.businessId
      WHERE m.tenantId = ${t} AND m.employeeId = ${me.id} AND m.leftAt IS NULL AND c.isArchived = 0
      ORDER BY FIELD(c.kind, 'announcement', 'team', 'business', 'group', 'direct'), c.lastMessageAt DESC, c.id DESC`));
    const conversations = mine.map(r => ({
      id: Number(r.id), kind: r.kind as ConversationKind, businessId: num(r.businessId), title: r.title ?? r.businessName ?? r.peerName ?? null,
      peerEmployeeId: num(r.peerEmployeeId), lastMessageId: num(r.lastMessageId), lastMessageAt: num(r.lastMessageAt),
      unread: Number(r.unread), last: r.lastMessageId ? { kind: r.lastKind, title: r.lastTitle ?? null, preview: r.lastPreview ?? null, deleted: Boolean(Number(r.lastDeleted)), senderName: r.lastSenderName ?? null } : null,
    }));
    let monitor: { id: number; kind: ConversationKind; title: string | null; participants: string[]; lastMessageAt: number | null }[] = [];
    if (me.canMonitor) {
      const mon = rows(await tx.execute(sql`
        SELECT c.id, c.kind, c.title, ${ms("c.lastMessageAt")} AS lastMessageAt,
          (SELECT GROUP_CONCAT(e.name ORDER BY e.name SEPARATOR '\u001f') FROM msg_members pm JOIN employees e ON e.id = pm.employeeId AND e.tenantId = pm.tenantId
             WHERE pm.tenantId = c.tenantId AND pm.conversationId = c.id AND pm.leftAt IS NULL) AS names
        FROM msg_conversations c
        WHERE c.tenantId = ${t} AND c.kind IN ('direct', 'group')
          AND NOT EXISTS (SELECT 1 FROM msg_members m WHERE m.tenantId = c.tenantId AND m.conversationId = c.id AND m.employeeId = ${me.id} AND m.leftAt IS NULL)
        ORDER BY c.lastMessageAt DESC, c.id DESC LIMIT 200`));
      monitor = mon.map(r => ({ id: Number(r.id), kind: r.kind, title: r.title ?? null, participants: r.names ? String(r.names).split("\u001f") : [], lastMessageAt: num(r.lastMessageAt) }));
    }
    return { conversations, unreadTotal: conversations.reduce((s, c) => s + c.unread, 0), monitor, canMonitor: me.canMonitor };
  });
}

export const readInput = z.object({
  conversationId: ID,
  beforeId: ID.optional(),
  afterId: ID.optional(),
  limit: z.number().int().min(1).max(MESSAGING_LIMITS.pageSize).optional(),
}).strict();

/**
 * صفحة رسائل (الأحدث افتراضيًا، أو أقدم من beforeId، أو أحدث من afterId للـPolling).
 * المالك المطّلع: قراءة فقط + سجل اطلاع. المحذوف يظهر كعنصر نائب بلا نص.
 */
export async function readMessages(actor: MessagingActor, perms: Partial<MessagingPerms>, input: z.infer<typeof readInput>) {
  const v = readInput.parse(input);
  if (v.beforeId && v.afterId) throw bad("حدّد اتجاهًا واحدًا للصفحة");
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const a = await access(tx, actor, me, v.conversationId);
    if (a.monitor) await auditOpen(tx, actor, me, a.conv.id);
    const t = actor.tenantId, limit = v.limit ?? MESSAGING_LIMITS.pageSize;
    const cursor = v.afterId ? sql` AND m.id > ${v.afterId}` : v.beforeId ? sql` AND m.id < ${v.beforeId}` : sql``;
    const order = v.afterId ? sql`ASC` : sql`DESC`;
    const list = rows(await tx.execute(sql`
      SELECT m.id, m.senderEmployeeId, s.name AS senderName, m.kind, m.title, m.body, m.replyToMessageId, m.orderId, m.isPinned,
        ${ms("m.editedAt")} AS editedAt, ${ms("m.deletedAt")} AS deletedAt, ${ms("m.createdAt")} AS createdAt
      FROM msg_messages m LEFT JOIN employees s ON s.tenantId = m.tenantId AND s.id = m.senderEmployeeId
      WHERE m.tenantId = ${t} AND m.conversationId = ${a.conv.id}${cursor}
      ORDER BY m.id ${order} LIMIT ${limit + 1}`));
    const hasMore = list.length > limit;
    const page = list.slice(0, limit);
    if (!v.afterId) page.reverse();
    const ids = page.map(m => Number(m.id));
    const inIds = ids.length ? sql.join(ids.map(i => sql`${i}`), sql`, `) : sql`NULL`;
    const atts = ids.length ? rows(await tx.execute(sql`SELECT messageId, kind, mime, bytes, width, height, durationMs, waveformJson, purgedAt IS NOT NULL AS purged FROM msg_attachments WHERE tenantId = ${t} AND messageId IN (${inIds}) ORDER BY id`)) : [];
    const rx = ids.length ? rows(await tx.execute(sql`SELECT messageId, reaction, COUNT(*) AS n, SUM(employeeId = ${me.id}) AS mine FROM msg_reactions WHERE tenantId = ${t} AND messageId IN (${inIds}) GROUP BY messageId, reaction`)) : [];
    const listens = ids.length ? rows(await tx.execute(sql`SELECT messageId, COUNT(*) AS n, SUM(employeeId = ${me.id}) AS mine FROM msg_voice_listens WHERE tenantId = ${t} AND messageId IN (${inIds}) GROUP BY messageId`)) : [];
    const acks = ids.length ? rows(await tx.execute(sql`SELECT messageId, COUNT(*) AS n, SUM(employeeId = ${me.id}) AS mine FROM msg_announcement_acks WHERE tenantId = ${t} AND messageId IN (${inIds}) GROUP BY messageId`)) : [];
    const by = <T extends { messageId: any }>(xs: T[]) => (id: number) => xs.filter(x => Number(x.messageId) === id);
    const attOf = by(atts), rxOf = by(rx), lsOf = by(listens), akOf = by(acks);
    const messages = page.map(m => {
      const id = Number(m.id), deleted = m.deletedAt != null;
      const l = lsOf(id)[0], k = akOf(id)[0];
      return {
        id, senderEmployeeId: num(m.senderEmployeeId), senderName: m.senderName ?? null, kind: m.kind, mine: num(m.senderEmployeeId) === me.id,
        title: deleted ? null : m.title ?? null, body: deleted ? null : m.body ?? null,
        replyToMessageId: num(m.replyToMessageId), orderId: num(m.orderId), isPinned: Boolean(Number(m.isPinned)),
        editedAt: num(m.editedAt), deletedAt: num(m.deletedAt), createdAt: Number(m.createdAt),
        attachments: deleted ? [] : attOf(id).map(x => ({ kind: x.kind, mime: x.mime, bytes: Number(x.bytes), width: num(x.width), height: num(x.height), durationMs: num(x.durationMs), waveform: x.waveformJson ?? null, purged: Boolean(Number(x.purged)) })),
        reactions: rxOf(id).map(x => ({ reaction: x.reaction, count: Number(x.n), mine: Number(x.mine) > 0 })),
        listens: l ? { count: Number(l.n), mine: Number(l.mine) > 0 } : { count: 0, mine: false },
        acks: k ? { count: Number(k.n), mine: Number(k.mine) > 0 } : { count: 0, mine: false },
      };
    });
    // «تمت القراءة» للمحادثة الخاصة فقط: مؤشر قراءة الطرف الآخر (msg_members.lastReadMessageId — يتقدم فقط،
    // ويتحرك بـmarkRead أو عند إرساله هو). للعضو فقط: المطّلع والمجموعات والقنوات = null (لا قراءة جماعية).
    // قراءة المالك المطّلع لا تكتب أي مؤشر، فلا تجعل رسالة «مقروءة».
    let peerLastReadMessageId: number | null = null;
    if (a.member && a.conv.kind === "direct") {
      const peer = await one(tx, sql`SELECT lastReadMessageId FROM msg_members WHERE tenantId = ${t} AND conversationId = ${a.conv.id} AND employeeId <> ${me.id} AND leftAt IS NULL LIMIT 1`);
      peerLastReadMessageId = num(peer?.lastReadMessageId);
    }
    return {
      conversation: { id: Number(a.conv.id), kind: a.conv.kind as ConversationKind, title: a.conv.title ?? null, businessId: num(a.conv.businessId) },
      readOnly: a.monitor, privacyNotice: MONITORABLE.includes(a.conv.kind) ? PRIVACY_NOTICE : null,
      messages, hasMore, lastReadMessageId: num(a.member?.lastReadMessageId), peerLastReadMessageId,
    };
  });
}

/** للـPolling: أعلى معرّف رسالة في محادثاتي + المحادثات التي تغيّرت بعد المؤشر. */
export async function changesSince(actor: MessagingActor, cursor: number) {
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor);
    const r = rows(await tx.execute(sql`SELECT c.id, c.lastMessageId FROM msg_members m JOIN msg_conversations c ON c.tenantId = m.tenantId AND c.id = m.conversationId
      WHERE m.tenantId = ${actor.tenantId} AND m.employeeId = ${me.id} AND m.leftAt IS NULL AND c.lastMessageId > ${Math.max(0, Math.floor(cursor))}`));
    const top = rows(await tx.execute(sql`SELECT MAX(c.lastMessageId) AS top FROM msg_members m JOIN msg_conversations c ON c.tenantId = m.tenantId AND c.id = m.conversationId
      WHERE m.tenantId = ${actor.tenantId} AND m.employeeId = ${me.id} AND m.leftAt IS NULL`))[0];
    return { cursor: Math.max(cursor, Number(top?.top ?? 0)), changedConversationIds: r.map(x => Number(x.id)) };
  });
}

// ==================== الإرسال ====================
export const sendInput = z.object({
  conversationId: ID,
  body: z.string().trim().min(1, "الرسالة فارغة").max(MESSAGING_LIMITS.bodyMaxChars),
  title: z.string().trim().min(1).max(MESSAGING_LIMITS.titleMaxChars).optional(),
  replyToMessageId: ID.optional(),
  orderId: ID.optional(),
  isPinned: z.boolean().optional(),
  idempotencyKey: OP,
}).strict();

async function assertOrderInTenant(tx: any, tenantId: number, orderId: number) {
  const o = await one(tx, sql`SELECT o.id FROM orders o JOIN businesses b ON b.id = o.businessId WHERE o.id = ${orderId} AND b.tenantId = ${tenantId}`);
  if (!o) throw bad("الطلب غير موجود");
}

/** رسالة نصية — أو إعلان (عنوان + نص، ويمكن تثبيته) في قناة الإعلانات لمن يملك صلاحية النشر فقط. */
export async function sendMessage(actor: MessagingActor, perms: Partial<MessagingPerms>, input: z.infer<typeof sendInput>) {
  const v = sendInput.parse(input);
  return withIdempotentRetry(() => runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const a = await access(tx, actor, me, v.conversationId, true);
    requireMember(a);
    const isAnn = a.conv.kind === "announcement";
    if (isAnn && !perms.announce) throw forbidden("النشر في الإعلانات لمن يملك صلاحية الإعلانات فقط");
    if (isAnn && !v.title) throw bad("الإعلان يحتاج عنوانًا");
    if (!isAnn && (v.title || v.isPinned)) throw bad("العنوان والتثبيت للإعلانات فقط");
    const hash = canonicalHash({ c: a.conv.id, s: me.id, body: v.body, title: v.title ?? null, r: v.replyToMessageId ?? null, o: v.orderId ?? null, p: Boolean(v.isPinned) });
    const replay = await replayCheck(tx, actor.tenantId, v.idempotencyKey, hash);
    if (replay != null) return { messageId: replay, replay: true };
    if (v.replyToMessageId) {
      const r = await one(tx, sql`SELECT id FROM msg_messages WHERE id = ${v.replyToMessageId} AND tenantId = ${actor.tenantId} AND conversationId = ${a.conv.id}`);
      if (!r) throw bad("الرسالة المردود عليها ليست في هذه المحادثة");
    }
    if (v.orderId) await assertOrderInTenant(tx, actor.tenantId, v.orderId);
    const id = insertId(await tx.execute(sql`INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, title, body, replyToMessageId, orderId, isPinned, idempotencyKey, payloadHash)
      VALUES (${actor.tenantId}, ${a.conv.id}, ${me.id}, ${isAnn ? "announcement" : "text"}, ${isAnn ? v.title! : null}, ${v.body}, ${v.replyToMessageId ?? null}, ${v.orderId ?? null}, ${isAnn && v.isPinned ? 1 : 0}, ${v.idempotencyKey}, ${hash})`));
    await touchConversation(tx, actor, a.conv.id, id, me.id);
    return { messageId: id, replay: false };
  }));
}

export const voiceInput = z.object({
  conversationId: ID,
  storageKey: z.string().regex(MESSAGE_KEY_PATTERN, "مسار الملف غير صالح"),
  /** يحدده السيرفر من محتوى الملف (audioProbe) — لا من المتصفح. */
  mime: z.enum(["audio/webm", "audio/ogg", "audio/mp4"]),
  bytes: z.number().int().min(1).max(MESSAGING_LIMITS.attachmentMaxBytes, "الملف أكبر من 10 ميجا"),
  durationMs: z.number().int().min(1).max(MESSAGING_LIMITS.voiceMaxMs, "الحد الأقصى للتسجيل 5 دقائق"),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  waveform: z.array(z.number().min(0).max(1)).max(128).optional(),
  replyToMessageId: ID.optional(),
  idempotencyKey: OP,
}).strict();
export type VoiceInput = z.infer<typeof voiceInput>;

/** بصمة الرسالة الصوتية: المحتوى (sha256) لا مفتاح التخزين — فإعادة رفع نفس الملف بنفس المعرّف = Replay. */
const voiceHash = (conversationId: number, senderId: number, v: Pick<VoiceInput, "contentSha256" | "durationMs" | "bytes" | "replyToMessageId">) =>
  canonicalHash({ c: conversationId, s: senderId, voice: v.contentSha256, d: v.durationMs, b: v.bytes, r: v.replyToMessageId ?? null });

/**
 * فحص مسبق قبل الرفع للتخزين (لا يكتب شيئًا): الصلاحية والعضوية، وهل المعرّف مستخدم مسبقًا؟
 * نفس الحمولة → messageId (Replay بلا رفع جديد)، حمولة مختلفة → CONFLICT، غير مستخدم → null.
 */
export async function precheckVoice(actor: MessagingActor, perms: Partial<MessagingPerms>, input: Omit<VoiceInput, "storageKey" | "mime">) {
  if (!perms.voice) throw forbidden("الرسائل الصوتية غير متاحة لك");
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const a = await access(tx, actor, me, input.conversationId);
    requireMember(a);
    if (a.conv.kind === "announcement") throw bad("الإعلانات نصية فقط");
    const ex = await one(tx, sql`SELECT id, payloadHash FROM msg_messages WHERE tenantId = ${actor.tenantId} AND idempotencyKey = ${input.idempotencyKey}`);
    if (!ex) return null;
    if (ex.payloadHash === voiceHash(a.conv.id, me.id, input)) return Number(ex.id);
    throw conflict("نفس معرّف العملية استُخدم لرسالة مختلفة — لم يُنفَّذ أي تغيير");
  });
}

/** رسالة صوتية (الملف مرفوع مسبقًا للتخزين الخاص) — تنتهي بعد 6 أشهر؛ لا تُعدَّل، تُحذف فقط. */
export async function sendVoice(actor: MessagingActor, perms: Partial<MessagingPerms>, input: VoiceInput) {
  const v = voiceInput.parse(input);
  if (!perms.voice) throw forbidden("الرسائل الصوتية غير متاحة لك");
  if (!keyBelongsToTenant(v.storageKey, actor.tenantId)) throw bad("مسار الملف غير صالح");
  return withIdempotentRetry(() => runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const a = await access(tx, actor, me, v.conversationId, true);
    requireMember(a);
    if (a.conv.kind === "announcement") throw bad("الإعلانات نصية فقط");
    const hash = voiceHash(a.conv.id, me.id, v);
    const replay = await replayCheck(tx, actor.tenantId, v.idempotencyKey, hash);
    if (replay != null) return { messageId: replay, replay: true };
    if (v.replyToMessageId) {
      const r = await one(tx, sql`SELECT id FROM msg_messages WHERE id = ${v.replyToMessageId} AND tenantId = ${actor.tenantId} AND conversationId = ${a.conv.id}`);
      if (!r) throw bad("الرسالة المردود عليها ليست في هذه المحادثة");
    }
    const id = insertId(await tx.execute(sql`INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, replyToMessageId, idempotencyKey, payloadHash)
      VALUES (${actor.tenantId}, ${a.conv.id}, ${me.id}, 'voice', ${v.replyToMessageId ?? null}, ${v.idempotencyKey}, ${hash})`));
    await tx.execute(sql`INSERT INTO msg_attachments (tenantId, messageId, kind, storageKey, mime, bytes, durationMs, waveformJson, expiresAt)
      VALUES (${actor.tenantId}, ${id}, 'voice', ${v.storageKey}, ${v.mime}, ${v.bytes}, ${v.durationMs}, ${v.waveform ? JSON.stringify(v.waveform) : null}, NOW(3) + INTERVAL ${MESSAGING_LIMITS.attachmentRetentionDays} DAY)`);
    await touchConversation(tx, actor, a.conv.id, id, me.id);
    return { messageId: id, replay: false };
  }));
}

/**
 * تصريح تشغيل صوت (قبل قراءة الملف من التخزين): عضو، أو المالك المطّلع (قراءة فقط). المحذوف أو المنتهي = غير موجود.
 * المطّلع: سجل «listen» (مرة كل 30 دقيقة للرسالة — طلبات Range المتتالية لا تُغرق السجل). المستلم: «سمعها» أول مرة.
 * يعيد المفتاح للمتصل فقط (لا يُرسل للعميل ولا يُسجَّل في الـlogs).
 */
export async function authorizeVoicePlayback(actor: MessagingActor, perms: Partial<MessagingPerms>, messageId: number) {
  const id = ID.parse(messageId);
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const m = await messageInTenant(tx, actor, id);
    const a = await access(tx, actor, me, Number(m.conversationId));
    if (m.kind !== "voice" || m.deletedAt) throw notFound("الرسالة غير موجودة");
    const att = await one(tx, sql`SELECT storageKey, mime, bytes FROM msg_attachments WHERE tenantId = ${actor.tenantId} AND messageId = ${m.id} AND kind = 'voice' AND purgedAt IS NULL AND (expiresAt IS NULL OR expiresAt > NOW(3)) ORDER BY id LIMIT 1`);
    if (!att || !keyBelongsToTenant(att.storageKey, actor.tenantId)) throw notFound("الملف لم يعد متاحًا");
    if (a.monitor) {
      const recent = await one(tx, sql`SELECT id FROM msg_access_audit WHERE tenantId = ${actor.tenantId} AND viewerEmployeeId = ${me.id} AND messageId = ${m.id} AND action = 'listen' AND viewedAt > NOW(3) - INTERVAL ${AUDIT_DEDUPE_MINUTES} MINUTE LIMIT 1`);
      if (!recent) await tx.execute(sql`INSERT INTO msg_access_audit (tenantId, viewerEmployeeId, conversationId, action, messageId) VALUES (${actor.tenantId}, ${me.id}, ${a.conv.id}, 'listen', ${m.id})`);
    } else if (Number(m.senderEmployeeId) !== me.id) {
      await tx.execute(sql`INSERT INTO msg_voice_listens (tenantId, messageId, employeeId) VALUES (${actor.tenantId}, ${m.id}, ${me.id}) ON DUPLICATE KEY UPDATE id = id`);
    }
    return { storageKey: String(att.storageKey), mime: String(att.mime), bytes: Number(att.bytes), monitor: a.monitor };
  });
}

// ==================== حذف المرفقات المنتهية (مهمة صيانة) ====================
/**
 * يحذف ملفات المرفقات المنتهية (6 أشهر، أو فور حذف الرسالة) من التخزين ثم يعلّم الصف purgedAt.
 *   • Idempotent: purgedAt يمنع التكرار، وحذف ملف غير موجود = نجاح؛ إعادة التشغيل آمنة.
 *   • متزامن بأمان: كل صف يُطالب به بـFOR UPDATE SKIP LOCKED — نسختان من المهمة لا تعالجان نفس الصف.
 *   • لا يحذف إلا مفتاحًا بالشكل المولَّد وداخل بادئة **نفس شركة الصف** — غير ذلك يُتخطى ويُعدّ (لا حذف).
 *   • الإعلانات المثبّتة لا تُمس. لا يعتمد على علم التشغيل (الاحتفاظ يُحترم حتى لو أُطفئت الرسائل).
 *   • لا يطبع مفاتيح التخزين — أرقام فقط.
 */
export async function purgeExpiredAttachments(opts: { storage: { del(key: string): Promise<void> }; limit?: number; dryRun?: boolean }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const ready = rows(await db.execute(sql`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${sql.join(MESSAGING_TABLES.map(t => sql`${t}`), sql`, `)})`));
  if (Number(ready[0]?.n ?? 0) !== MESSAGING_TABLES.length) return { state: "not_applied" as const, due: 0, purged: 0, failed: 0, skippedForeignKey: 0 };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 500)), 5000);
  await db.execute(sql`SET time_zone = '+00:00'`);
  const due = rows(await db.execute(sql`SELECT a.id FROM msg_attachments a JOIN msg_messages m ON m.tenantId = a.tenantId AND m.id = a.messageId
    WHERE a.purgedAt IS NULL AND a.expiresAt IS NOT NULL AND a.expiresAt <= NOW(3) AND (m.isPinned = 0 OR m.deletedAt IS NOT NULL)
    ORDER BY a.id LIMIT ${limit}`)).map(r => Number(r.id));
  let purged = 0, failed = 0, skippedForeignKey = 0;
  if (opts.dryRun) return { state: "dry_run" as const, due: due.length, purged, failed, skippedForeignKey };
  for (const id of due) {
    try {
      const r = await db.transaction(async tx => {
        await tx.execute(sql`SET time_zone = '+00:00'`);
        const row = await one(tx, sql`SELECT id, tenantId, storageKey FROM msg_attachments WHERE id = ${id} AND purgedAt IS NULL AND expiresAt <= NOW(3) FOR UPDATE SKIP LOCKED`);
        if (!row) return "gone";
        if (!keyBelongsToTenant(String(row.storageKey), Number(row.tenantId))) return "foreign";
        await opts.storage.del(String(row.storageKey));
        await tx.execute(sql`UPDATE msg_attachments SET purgedAt = NOW(3) WHERE id = ${id} AND tenantId = ${row.tenantId} AND purgedAt IS NULL`);
        return "purged";
      });
      if (r === "purged") purged++;
      else if (r === "foreign") skippedForeignKey++;
    } catch {
      failed++; // يبقى الصف بلا purgedAt فيُعاد في التشغيل التالي
    }
  }
  return { state: "done" as const, due: due.length, purged, failed, skippedForeignKey };
}

// ==================== التعديل والحذف ====================
export const editInput = z.object({
  messageId: ID,
  body: z.string().trim().min(1, "الرسالة فارغة").max(MESSAGING_LIMITS.bodyMaxChars),
  title: z.string().trim().min(1).max(MESSAGING_LIMITS.titleMaxChars).optional(),
}).strict();

/** تعديل رسالتي فقط (نص أو إعلان) — النسخة السابقة تُحفظ. */
export async function editMessage(actor: MessagingActor, input: z.infer<typeof editInput>) {
  const v = editInput.parse(input);
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor);
    const m = await messageInTenant(tx, actor, v.messageId, true);
    requireMember(await access(tx, actor, me, Number(m.conversationId)));
    if (Number(m.senderEmployeeId) !== me.id) throw forbidden("يمكنك تعديل رسائلك فقط");
    if (m.deletedAt) throw bad("الرسالة محذوفة");
    if (m.kind !== "text" && m.kind !== "announcement") throw bad("هذا النوع من الرسائل لا يُعدَّل — يمكن حذفه فقط");
    if (m.kind === "text" && v.title) throw bad("العنوان للإعلانات فقط");
    const title = m.kind === "announcement" ? v.title ?? m.title : null;
    if (v.body === m.body && title === (m.title ?? null)) return { changed: false };
    await tx.execute(sql`INSERT INTO msg_message_edits (tenantId, messageId, editorEmployeeId, action, previousTitle, previousBody) VALUES (${actor.tenantId}, ${m.id}, ${me.id}, 'edit', ${m.title ?? null}, ${m.body ?? null})`);
    await tx.execute(sql`UPDATE msg_messages SET body = ${v.body}, title = ${title}, editedAt = NOW(3) WHERE id = ${m.id} AND tenantId = ${actor.tenantId}`);
    return { changed: true };
  });
}

/** حذف ناعم لرسالتي فقط — النص يبقى في سجل النسخ؛ مرفقاتها تُعلَّم للحذف من التخزين. */
export async function deleteMessage(actor: MessagingActor, input: { messageId: number }) {
  const messageId = ID.parse(input.messageId);
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor);
    const m = await messageInTenant(tx, actor, messageId, true);
    requireMember(await access(tx, actor, me, Number(m.conversationId)));
    if (Number(m.senderEmployeeId) !== me.id) throw forbidden("يمكنك حذف رسائلك فقط");
    if (m.deletedAt) return { changed: false };
    await tx.execute(sql`INSERT INTO msg_message_edits (tenantId, messageId, editorEmployeeId, action, previousTitle, previousBody) VALUES (${actor.tenantId}, ${m.id}, ${me.id}, 'delete', ${m.title ?? null}, ${m.body ?? null})`);
    await tx.execute(sql`UPDATE msg_messages SET deletedAt = NOW(3), deletedByEmployeeId = ${me.id}, body = NULL, title = NULL, isPinned = 0 WHERE id = ${m.id} AND tenantId = ${actor.tenantId}`);
    await tx.execute(sql`UPDATE msg_attachments SET expiresAt = NOW(3) WHERE tenantId = ${actor.tenantId} AND messageId = ${m.id} AND purgedAt IS NULL`);
    return { changed: true };
  });
}

/** سجل نسخ الرسالة (للأعضاء وللمالك المطّلع). */
export async function messageHistory(actor: MessagingActor, perms: Partial<MessagingPerms>, input: { messageId: number }) {
  const messageId = ID.parse(input.messageId);
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const m = await messageInTenant(tx, actor, messageId);
    const a = await access(tx, actor, me, Number(m.conversationId));
    if (a.monitor) await auditOpen(tx, actor, me, a.conv.id);
    const list = rows(await tx.execute(sql`SELECT h.action, h.previousTitle, h.previousBody, e.name AS editorName, ${ms("h.createdAt")} AS at
      FROM msg_message_edits h LEFT JOIN employees e ON e.tenantId = h.tenantId AND e.id = h.editorEmployeeId
      WHERE h.tenantId = ${actor.tenantId} AND h.messageId = ${m.id} ORDER BY h.id`));
    return list.map(h => ({ action: h.action as "edit" | "delete", previousTitle: h.previousTitle ?? null, previousBody: h.previousBody ?? null, editorName: h.editorName ?? null, at: Number(h.at) }));
  });
}

// ==================== التفاعل والقراءة ====================
export async function react(actor: MessagingActor, input: { messageId: number; reaction: (typeof REACTIONS)[number] }) {
  const v = z.object({ messageId: ID, reaction: z.enum(REACTIONS) }).strict().parse(input);
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor);
    const m = await messageInTenant(tx, actor, v.messageId);
    requireMember(await access(tx, actor, me, Number(m.conversationId)));
    if (m.deletedAt || m.kind === "system") throw bad("لا يمكن التفاعل مع هذه الرسالة");
    const ex = await one(tx, sql`SELECT id FROM msg_reactions WHERE tenantId = ${actor.tenantId} AND messageId = ${m.id} AND employeeId = ${me.id} AND reaction = ${v.reaction} FOR UPDATE`);
    if (ex) { await tx.execute(sql`DELETE FROM msg_reactions WHERE id = ${ex.id} AND tenantId = ${actor.tenantId}`); return { active: false }; }
    await tx.execute(sql`INSERT INTO msg_reactions (tenantId, messageId, employeeId, reaction) VALUES (${actor.tenantId}, ${m.id}, ${me.id}, ${v.reaction})`);
    return { active: true };
  });
}

/** مؤشر القراءة يتقدّم فقط (لا يرجع للخلف). */
export async function markRead(actor: MessagingActor, input: { conversationId: number; messageId: number }, perms: Partial<MessagingPerms> = {}) {
  const v = z.object({ conversationId: ID, messageId: ID }).strict().parse(input);
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const a = await access(tx, actor, me, v.conversationId);
    if (!a.member) return { lastReadMessageId: null }; // المطّلع لا يترك أثر قراءة
    const m = await one(tx, sql`SELECT id FROM msg_messages WHERE id = ${v.messageId} AND tenantId = ${actor.tenantId} AND conversationId = ${a.conv.id}`);
    if (!m) throw bad("الرسالة ليست في هذه المحادثة");
    await tx.execute(sql`UPDATE msg_members SET lastReadMessageId = GREATEST(COALESCE(lastReadMessageId, 0), ${m.id}) WHERE id = ${a.member.id} AND tenantId = ${actor.tenantId}`);
    const r = await one(tx, sql`SELECT lastReadMessageId FROM msg_members WHERE id = ${a.member.id}`);
    return { lastReadMessageId: Number(r.lastReadMessageId) };
  });
}

/** «اطّلعت» على إعلان — مرة واحدة. */
export async function ackAnnouncement(actor: MessagingActor, input: { messageId: number }) {
  const messageId = ID.parse(input.messageId);
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor);
    const m = await messageInTenant(tx, actor, messageId);
    requireMember(await access(tx, actor, me, Number(m.conversationId)));
    if (m.kind !== "announcement" || m.deletedAt) throw bad("ليست إعلانًا");
    await tx.execute(sql`INSERT INTO msg_announcement_acks (tenantId, messageId, employeeId) VALUES (${actor.tenantId}, ${m.id}, ${me.id}) ON DUPLICATE KEY UPDATE id = id`);
    return { ok: true };
  });
}

// ==================== المحادثات الخاصة والمجموعات ====================
/** دليل الزملاء لبدء محادثة خاصة: موظفو نفس الشركة النشطون فقط (اسم ودور، بلا بيانات اتصال). */
export async function directory(actor: MessagingActor) {
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor);
    const list = rows(await tx.execute(sql`SELECT id, name, role, businessId FROM employees WHERE tenantId = ${actor.tenantId} AND isActive = 1 AND id <> ${me.id} ORDER BY name LIMIT 1000`));
    return list.map(e => ({ id: Number(e.id), name: String(e.name), role: String(e.role), businessId: num(e.businessId) }));
  });
}

/** محادثة خاصة مع أي موظف نشط في نفس الشركة — تُعاد نفس المحادثة لو موجودة. */
export async function startDirect(actor: MessagingActor, input: { employeeId: number }) {
  const target = ID.parse(input.employeeId);
  return runMessagingTx(async tx => {
    const me = await loadMe(tx, actor);
    if (target === me.id) throw bad("لا يمكنك مراسلة نفسك");
    const other = await one(tx, sql`SELECT id, isActive FROM employees WHERE id = ${target} AND tenantId = ${actor.tenantId}`);
    if (!other || !Number(other.isActive)) throw notFound("الموظف غير موجود");
    const id = await upsertConversation(tx, actor.tenantId, "direct", conversationUniqueKey.direct(me.id, target), { createdBy: me.id });
    for (const e of [me.id, target])
      await tx.execute(sql`INSERT INTO msg_members (tenantId, conversationId, employeeId) VALUES (${actor.tenantId}, ${id}, ${e}) ON DUPLICATE KEY UPDATE leftAt = NULL`);
    return { conversationId: id };
  });
}

export const groupInput = z.object({
  title: z.string().trim().min(1, "اسم المجموعة مطلوب").max(MESSAGING_LIMITS.groupTitleMaxChars),
  memberIds: z.array(ID).min(1, "اختر عضوًا واحدًا على الأقل").max(MESSAGING_LIMITS.groupMaxMembers - 1),
  operationId: OP,
}).strict();

/**
 * مجموعة جديدة (صلاحية إدارة المجموعات) — الأعضاء موظفون نشطون في نفس الشركة، والمنشئ مشرفها.
 * Idempotent بـoperationId: نفس المعرّف + نفس الحمولة = نفس المجموعة (Replay)، حمولة مختلفة = CONFLICT.
 * الضغطتان المتزامنتان تتسلسلان على القيد الفريد (tenantId, idempotencyKey) فتنشأ مجموعة واحدة.
 */
export async function createGroup(actor: MessagingActor, perms: Partial<MessagingPerms>, input: z.infer<typeof groupInput>) {
  const v = groupInput.parse(input);
  if (!perms.manageGroups) throw forbidden("إنشاء المجموعات لمن يملك صلاحية إدارة المجموعات");
  const attempt = () => runMessagingTx(async tx => {
    const me = await loadMe(tx, actor, perms);
    const ids = [...new Set(v.memberIds.filter(i => i !== me.id))].sort((a, b) => a - b);
    if (!ids.length) throw bad("اختر عضوًا واحدًا على الأقل");
    const hash = canonicalHash({ group: v.title, by: me.id, members: ids });
    const ex = await one(tx, sql`SELECT id, payloadHash FROM msg_conversations WHERE tenantId = ${actor.tenantId} AND idempotencyKey = ${v.operationId} FOR UPDATE`);
    if (ex) {
      if (ex.payloadHash !== hash) throw conflict("نفس معرّف العملية استُخدم لمجموعة مختلفة — لم يُنفَّذ أي تغيير");
      return { conversationId: Number(ex.id), replay: true };
    }
    const found = rows(await tx.execute(sql`SELECT id FROM employees WHERE tenantId = ${actor.tenantId} AND isActive = 1 AND id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`));
    if (found.length !== ids.length) throw bad("بعض الأعضاء غير موجودين أو غير نشطين");
    const id = insertId(await tx.execute(sql`INSERT INTO msg_conversations (tenantId, kind, title, createdByEmployeeId, idempotencyKey, payloadHash) VALUES (${actor.tenantId}, 'group', ${v.title}, ${me.id}, ${v.operationId}, ${hash})`));
    await tx.execute(sql`INSERT INTO msg_members (tenantId, conversationId, employeeId, role) VALUES (${actor.tenantId}, ${id}, ${me.id}, 'admin')`);
    for (const e of ids) await tx.execute(sql`INSERT INTO msg_members (tenantId, conversationId, employeeId) VALUES (${actor.tenantId}, ${id}, ${e})`);
    return { conversationId: id, replay: false };
  });
  return withIdempotentRetry(attempt);
}

/** من اطّلع على إعلان ومن لم يطّلع (لأصحاب صلاحية الإعلانات). */
export async function announcementReads(actor: MessagingActor, perms: Partial<MessagingPerms>, input: { messageId: number }) {
  const messageId = ID.parse(input.messageId);
  if (!perms.announce) throw forbidden("متاح لأصحاب صلاحية الإعلانات فقط");
  return runMessagingTx(async tx => {
    await loadMe(tx, actor, perms);
    const m = await messageInTenant(tx, actor, messageId);
    if (m.kind !== "announcement") throw bad("ليست إعلانًا");
    const list = rows(await tx.execute(sql`SELECT e.id, e.name, ${ms("k.ackedAt")} AS ackedAt FROM msg_members mm
      JOIN employees e ON e.tenantId = mm.tenantId AND e.id = mm.employeeId
      LEFT JOIN msg_announcement_acks k ON k.tenantId = mm.tenantId AND k.messageId = ${m.id} AND k.employeeId = mm.employeeId
      WHERE mm.tenantId = ${actor.tenantId} AND mm.conversationId = ${m.conversationId} AND mm.leftAt IS NULL AND e.isActive = 1 AND e.id <> ${m.senderEmployeeId}
      ORDER BY k.ackedAt IS NULL, e.name`));
    const people = list.map(r => ({ employeeId: Number(r.id), name: r.name, ackedAt: num(r.ackedAt) }));
    return { acked: people.filter(p => p.ackedAt != null), pending: people.filter(p => p.ackedAt == null) };
  });
}
