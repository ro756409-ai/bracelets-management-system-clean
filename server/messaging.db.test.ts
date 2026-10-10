import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests, createEmployee } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { MESSAGING_MIGRATION } from "./messagingMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import * as msg from "./messaging.service";
import { PRIVACY_NOTICE, MESSAGING_LIMITS } from "../shared/messagingSpec";
import { memoryMessagingStorage, newVoiceKey } from "./messagingStorage";

/**
 * خدمات الرسائل على قاعدة Docker مؤقتة (نسخة المخطط + 0041 + 0043): العلم/الجداول، القنوات الافتراضية،
 * العزل بين الشركات، الخاص بين أي موظفين، اطلاع المالك (قراءة فقط + سجل)، الإعلانات، التعديل/الحذف بالسجل،
 * Idempotency، الصوت، غير المقروء.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const op = () => `op${Math.random().toString(36).slice(2, 14)}`;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? e?.name ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const ALL = { announce: true, manageGroups: true, viewPrivate: true, voice: true };
const BASIC = { announce: false, manageGroups: false, viewPrivate: false, voice: true };

describe("🔒 الرسائل — حراس نصّية", () => {
  const src = fs.readFileSync("server/messaging.service.ts", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("لا كتابة خارج جداول msg_* ولا حذف للرسائل أو سجل النسخ أو سجل الاطلاع", () => {
    for (const m of src.matchAll(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+(\w+)(?=\s+(?:SET|\(|WHERE|SELECT|VALUES))/g)) expect(m[1]).toMatch(/^msg_/);
    expect(src).not.toMatch(/DELETE FROM msg_(messages|message_edits|access_audit|conversations)/);
  });
  it("كل معاملة تضبط UTC وتتحقق من الجداول، والعلم معطّل افتراضيًا", () => {
    expect(src).toContain("SET time_zone = '+00:00'");
    expect(src).toContain("assertMessagingReady(tx)");
    expect(src).toContain('process.env.MESSAGING_ENABLED === "true"');
  });
});

describe.runIf(CAN)("💬 خدمات الرسائل", () => {
  let tmp: TempSchema, bare: TempSchema;
  let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const saved = process.env.MESSAGING_ENABLED;
  const actor = (key: string, f: CoreTestFixture, role = "agent") => ({ tenantId: f.tenantId, employeeId: emp[key], role, businessId: f.businessId });
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  let a1: ReturnType<typeof actor>, a2: ReturnType<typeof actor>, a3: ReturnType<typeof actor>, boss: ReturnType<typeof actor>, mgr: ReturnType<typeof actor>, bE: ReturnType<typeof actor>;
  let annA = 0, teamA = 0, teamB = 0;

  beforeAll(async () => {
    tmp = await createTempSchema("msg_s"); bare = await createTempSchema("msg_bare");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [MESSAGING_MIGRATION, "drizzle/0043_messaging.sql", "0043"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("msg-a"); B = await createCoreTestFixture("msg-b");
    const mk = async (key: string, role: string, f: CoreTestFixture, active = true) => { emp[key] = insId(await createEmployee({ name: `${key}-msg`, role, isActive: active, tenantId: f.tenantId, businessId: f.businessId, username: `${key}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("e1", "agent", A); await mk("e2", "agent", A); await mk("e3", "warehouse", A); await mk("boss", "super_admin", A); await mk("mgr", "manager", A); await mk("off", "agent", A, false); await mk("eb", "agent", B); await mk("eb2", "agent", B);
    a1 = actor("e1", A); a2 = actor("e2", A); a3 = actor("e3", A, "warehouse"); boss = actor("boss", A, "super_admin"); mgr = actor("mgr", A, "manager"); bE = actor("eb", B);
    process.env.MESSAGING_ENABLED = "true";
  }, 240_000);
  afterAll(async () => {
    process.env.MESSAGING_ENABLED = saved;
    __setDbForTests(null as any);
    await tmp?.drop(); await bare?.drop();
  }, 180_000);

  it("العلم معطّل → PRECONDITION_FAILED؛ مفعّل بلا جداول → PRECONDITION_FAILED بلا تغيير", async () => {
    process.env.MESSAGING_ENABLED = "false";
    expect(await code(() => msg.listConversations(a1))).toBe("PRECONDITION_FAILED");
    process.env.MESSAGING_ENABLED = "true";
    __setDbForTests(drizzle(bare.url));
    expect(await code(() => msg.ensureDefaults(a1))).toBe("PRECONDITION_FAILED");
    __setDbForTests(drizzle(tmp.url));
  });

  it("القنوات الافتراضية idempotent: إعلانات + فريق + قناة نشاط، ورسالة سياسة واحدة", async () => {
    const r1 = await msg.ensureDefaults(a1);
    const r2 = await msg.ensureDefaults(boss);
    expect(r2.announcementId).toBe(r1.announcementId); expect(r2.teamId).toBe(r1.teamId);
    annA = r1.announcementId; teamA = r1.teamId;
    teamB = (await msg.ensureDefaults(bE)).teamId;
    expect(teamB).not.toBe(teamA);
    const sys = await q("SELECT body FROM msg_messages WHERE tenantId = ? AND kind = 'system'", [A.tenantId]);
    expect(sys).toHaveLength(1); expect(sys[0].body).toBe(PRIVACY_NOTICE);
    // الموظف غير النشط ليس عضوًا
    expect(await q("SELECT id FROM msg_members WHERE employeeId = ?", [emp.off])).toHaveLength(0);
    const list = await msg.listConversations(a1);
    expect(list.conversations.map(c => c.kind)).toEqual(["announcement", "team", "business"]);
    expect(list.monitor).toEqual([]);
    expect(list.conversations[0].unread).toBe(1); // تنبيه السياسة
  });

  it("العزل: موظف شركة B لا يرى ولا يكتب في قنوات A (غير موجودة)", async () => {
    expect(await code(() => msg.readMessages(bE, BASIC, { conversationId: teamA }))).toBe("NOT_FOUND");
    expect(await code(() => msg.sendMessage(bE, BASIC, { conversationId: teamA, body: "x", idempotencyKey: op() }))).toBe("NOT_FOUND");
    expect(await code(() => msg.startDirect(bE, { employeeId: emp.e1 }))).toBe("NOT_FOUND");
    // هوية مزوّرة: موظف B بـtenant A
    expect(await code(() => msg.listConversations({ ...bE, tenantId: A.tenantId }))).toBe("FORBIDDEN");
  });

  it("الإرسال + Idempotency (Replay بنفس الـhash، CONFLICT بمحتوى مختلف) + غير المقروء", async () => {
    const key = op();
    const s1 = await msg.sendMessage(a1, BASIC, { conversationId: teamA, body: "صباح الخير", idempotencyKey: key });
    const s2 = await msg.sendMessage(a1, BASIC, { conversationId: teamA, body: "صباح الخير", idempotencyKey: key });
    expect(s2).toEqual({ messageId: s1.messageId, replay: true });
    expect(await code(() => msg.sendMessage(a1, BASIC, { conversationId: teamA, body: "مختلف", idempotencyKey: key }))).toBe("CONFLICT");
    expect(await code(() => msg.sendMessage(a1, BASIC, { conversationId: teamA, body: "x", title: "عنوان", idempotencyKey: op() }))).toBe("BAD_REQUEST");
    expect(Number((await q("SELECT COUNT(*) n FROM msg_messages WHERE conversationId = ?", [teamA]))[0].n)).toBe(1);
    const l2 = await msg.listConversations(a2);
    const t2 = l2.conversations.find(c => c.id === teamA)!;
    expect(t2.unread).toBe(1); expect(t2.last?.preview).toBe("صباح الخير");
    expect((await msg.listConversations(a1)).conversations.find(c => c.id === teamA)!.unread).toBe(0); // المرسل قرأها
    // markRead يتقدّم فقط
    await msg.markRead(a2, { conversationId: teamA, messageId: s1.messageId });
    expect((await msg.listConversations(a2)).conversations.find(c => c.id === teamA)!.unread).toBe(0);
    const sys = (await q("SELECT id FROM msg_messages WHERE kind = 'system' AND tenantId = ?", [A.tenantId]))[0].id;
    expect(await code(() => msg.markRead(a2, { conversationId: teamA, messageId: sys }))).toBe("BAD_REQUEST"); // ليست في المحادثة
    // رد على رسالة من محادثة أخرى مرفوض
    expect(await code(() => msg.sendMessage(a1, BASIC, { conversationId: teamA, body: "رد", replyToMessageId: sys, idempotencyKey: op() }))).toBe("BAD_REQUEST");
    // ربط بطلب من شركة أخرى مرفوض
    expect(await code(() => msg.sendMessage(a1, BASIC, { conversationId: teamA, body: "طلب", orderId: 999999999, idempotencyKey: op() }))).toBe("BAD_REQUEST");
  });

  it("الإعلانات: النشر بالصلاحية فقط + عنوان إلزامي + اطلاع وإحصاء", async () => {
    expect(await code(() => msg.sendMessage(a1, BASIC, { conversationId: annA, body: "x", title: "y", idempotencyKey: op() }))).toBe("FORBIDDEN");
    expect(await code(() => msg.sendMessage(mgr, { ...BASIC, announce: true }, { conversationId: annA, body: "بدون عنوان", idempotencyKey: op() }))).toBe("BAD_REQUEST");
    const { messageId } = await msg.sendMessage(mgr, { ...BASIC, announce: true }, { conversationId: annA, title: "اجتماع", body: "الساعة 10", isPinned: true, idempotencyKey: op() });
    await msg.ackAnnouncement(a1, { messageId }); await msg.ackAnnouncement(a1, { messageId });
    const r = await msg.announcementReads(mgr, { ...BASIC, announce: true }, { messageId });
    expect(r.acked.map(p => p.employeeId)).toEqual([emp.e1]);
    expect(r.pending.map(p => p.employeeId).sort()).toEqual([emp.e2, emp.e3, emp.boss].sort());
    expect(await code(() => msg.announcementReads(a1, BASIC, { messageId }))).toBe("FORBIDDEN");
    const page = await msg.readMessages(a1, BASIC, { conversationId: annA });
    const ann = page.messages.find(m => m.id === messageId)!;
    expect(ann).toMatchObject({ kind: "announcement", title: "اجتماع", isPinned: true, acks: { count: 1, mine: true } });
    expect(page.readOnly).toBe(false); expect(page.privacyNotice).toBeNull();
  });

  it("الخاص: أي موظف ↔ أي موظف، نفس المحادثة من الطرفين، لا مع النفس ولا مع غير النشط", async () => {
    const d1 = await msg.startDirect(a1, { employeeId: emp.e3 });
    const d2 = await msg.startDirect(a3, { employeeId: emp.e1 });
    expect(d2.conversationId).toBe(d1.conversationId);
    expect(await code(() => msg.startDirect(a1, { employeeId: emp.e1 }))).toBe("BAD_REQUEST");
    expect(await code(() => msg.startDirect(a1, { employeeId: emp.off }))).toBe("NOT_FOUND");
    await msg.sendMessage(a1, BASIC, { conversationId: d1.conversationId, body: "سر بسيط", idempotencyKey: op() });
    const l3 = await msg.listConversations(a3);
    expect(l3.conversations.find(c => c.id === d1.conversationId)).toMatchObject({ kind: "direct", title: "e1-msg", peerEmployeeId: emp.e1, unread: 1 });
    // طرف ثالث (ليس مالكًا) مرفوض حتى لو مُرِّرت viewPrivate
    expect(await code(() => msg.readMessages(a2, ALL, { conversationId: d1.conversationId }))).toBe("FORBIDDEN");
    expect(await code(() => msg.readMessages(mgr, ALL, { conversationId: d1.conversationId }))).toBe("FORBIDDEN");
    const page = await msg.readMessages(a3, BASIC, { conversationId: d1.conversationId });
    expect(page.privacyNotice).toBe(PRIVACY_NOTICE);
  });

  it("اطلاع المالك: قراءة فقط + سجل اطلاع (بلا إغراق) + لا أثر قراءة؛ بدون الصلاحية مرفوض", async () => {
    const dm = (await msg.startDirect(a1, { employeeId: emp.e2 })).conversationId;
    await msg.sendMessage(a2, BASIC, { conversationId: dm, body: "خاص", idempotencyKey: op() });
    expect(await code(() => msg.readMessages(boss, BASIC, { conversationId: dm }))).toBe("FORBIDDEN");
    const list = await msg.listConversations(boss, ALL);
    expect(list.canMonitor).toBe(true);
    expect(list.monitor.find(c => c.id === dm)?.participants.sort()).toEqual(["e1-msg", "e2-msg"]);
    const page = await msg.readMessages(boss, ALL, { conversationId: dm });
    expect(page.readOnly).toBe(true); expect(page.messages.at(-1)?.body).toBe("خاص");
    await msg.readMessages(boss, ALL, { conversationId: dm }); // Polling لا يكرر السجل
    expect(await q("SELECT action FROM msg_access_audit WHERE conversationId = ? AND viewerEmployeeId = ?", [dm, emp.boss])).toEqual([{ action: "open" }]);
    expect(await code(() => msg.sendMessage(boss, ALL, { conversationId: dm, body: "تدخل", idempotencyKey: op() }))).toBe("FORBIDDEN");
    const mid = page.messages.at(-1)!.id;
    expect(await code(() => msg.react(boss, { messageId: mid, reaction: "like" }))).toBe("FORBIDDEN");
    expect(await msg.markRead(boss, { conversationId: dm, messageId: mid }, ALL)).toEqual({ lastReadMessageId: null });
    expect(await q("SELECT id FROM msg_members WHERE conversationId = ? AND employeeId = ?", [dm, emp.boss])).toHaveLength(0);
    // المالك لا يرى قنوات شركة أخرى
    expect(await code(() => msg.readMessages(boss, ALL, { conversationId: teamB }))).toBe("NOT_FOUND");
  });

  it("التعديل والحذف: صاحب الرسالة فقط، النسخ محفوظة، المحذوف بلا نص في القراءة", async () => {
    const { messageId } = await msg.sendMessage(a1, BASIC, { conversationId: teamA, body: "النسخة 1", idempotencyKey: op() });
    expect(await code(() => msg.editMessage(a2, { messageId, body: "تلاعب" }))).toBe("FORBIDDEN");
    expect(await msg.editMessage(a1, { messageId, body: "النسخة 1" })).toEqual({ changed: false });
    await msg.editMessage(a1, { messageId, body: "النسخة 2" });
    await msg.editMessage(a1, { messageId, body: "النسخة 3" });
    let m = (await msg.readMessages(a2, BASIC, { conversationId: teamA })).messages.find(x => x.id === messageId)!;
    expect(m.body).toBe("النسخة 3"); expect(m.editedAt).toBeGreaterThan(0);
    expect(await code(() => msg.deleteMessage(a2, { messageId }))).toBe("FORBIDDEN");
    expect(await msg.deleteMessage(a1, { messageId })).toEqual({ changed: true });
    expect(await msg.deleteMessage(a1, { messageId })).toEqual({ changed: false });
    m = (await msg.readMessages(a2, BASIC, { conversationId: teamA })).messages.find(x => x.id === messageId)!;
    expect(m.body).toBeNull(); expect(m.deletedAt).toBeGreaterThan(0);
    expect(await code(() => msg.editMessage(a1, { messageId, body: "إحياء" }))).toBe("BAD_REQUEST");
    const h = await msg.messageHistory(a2, BASIC, { messageId });
    expect(h.map(x => `${x.action}:${x.previousBody}`)).toEqual(["edit:النسخة 1", "edit:النسخة 2", "delete:النسخة 3"]);
  });

  it("التفاعلات toggle", async () => {
    const { messageId } = await msg.sendMessage(a2, BASIC, { conversationId: teamA, body: "تم الشحن", idempotencyKey: op() });
    expect(await msg.react(a1, { messageId, reaction: "done" })).toEqual({ active: true });
    expect(await msg.react(a3, { messageId, reaction: "done" })).toEqual({ active: true });
    let m = (await msg.readMessages(a1, BASIC, { conversationId: teamA })).messages.find(x => x.id === messageId)!;
    expect(m.reactions).toEqual([{ reaction: "done", count: 2, mine: true }]);
    expect(await msg.react(a1, { messageId, reaction: "done" })).toEqual({ active: false });
    m = (await msg.readMessages(a1, BASIC, { conversationId: teamA })).messages.find(x => x.id === messageId)!;
    expect(m.reactions).toEqual([{ reaction: "done", count: 1, mine: false }]);
  });

  it("الصوت: حدود المدة والحجم والمسار، انتهاء بعد 6 أشهر، «سمعها»، لا يُعدَّل، واستماع المالك مسجَّل", async () => {
    const dm = (await msg.startDirect(a1, { employeeId: emp.e3 })).conversationId;
    const sha = (n: string) => n.repeat(64).slice(0, 64);
    const base = { conversationId: dm, mime: "audio/webm" as const, bytes: 48_000, durationMs: 12_000, contentSha256: sha("a") };
    const key = () => newVoiceKey(A.tenantId, ".webm");
    expect(await code(() => msg.sendVoice(a1, { ...BASIC, voice: false }, { ...base, storageKey: key(), idempotencyKey: op() }))).toBe("FORBIDDEN");
    expect(await code(() => msg.sendVoice(a1, BASIC, { ...base, durationMs: MESSAGING_LIMITS.voiceMaxMs + 1, storageKey: key(), idempotencyKey: op() }))).toBe("ZodError");
    expect(await code(() => msg.sendVoice(a1, BASIC, { ...base, bytes: MESSAGING_LIMITS.attachmentMaxBytes + 1, storageKey: key(), idempotencyKey: op() }))).toBe("ZodError");
    expect(await code(() => msg.sendVoice(a1, BASIC, { ...base, mime: "image/svg+xml" as any, storageKey: key(), idempotencyKey: op() }))).toBe("ZodError");
    expect(await code(() => msg.sendVoice(a1, BASIC, { ...base, storageKey: newVoiceKey(B.tenantId, ".webm"), idempotencyKey: op() }))).toBe("BAD_REQUEST");
    expect(await code(() => msg.sendVoice(a1, BASIC, { ...base, storageKey: `msg/${A.tenantId}/voice/../../x.webm`, idempotencyKey: op() }))).toBe("ZodError");
    expect(await code(() => msg.sendVoice(mgr, BASIC, { ...base, conversationId: annA, storageKey: key(), idempotencyKey: op() }))).toBe("BAD_REQUEST");
    const idem = op();
    const { messageId } = await msg.sendVoice(a1, BASIC, { ...base, storageKey: key(), waveform: [0.1, 0.5, 0.9], idempotencyKey: idem });
    // إعادة الرفع بنفس المعرّف ونفس المحتوى = Replay حتى لو اختلف مفتاح التخزين؛ محتوى مختلف = CONFLICT
    expect(await msg.precheckVoice(a1, BASIC, { ...base, idempotencyKey: idem })).toBe(messageId);
    expect((await msg.sendVoice(a1, BASIC, { ...base, storageKey: key(), idempotencyKey: idem })).replay).toBe(true);
    expect(await code(() => msg.precheckVoice(a1, BASIC, { ...base, contentSha256: sha("b"), idempotencyKey: idem }))).toBe("CONFLICT");
    expect(await msg.precheckVoice(a1, BASIC, { ...base, idempotencyKey: op() })).toBeNull();
    const [att] = await q("SELECT DATEDIFF(expiresAt, createdAt) AS days, durationMs FROM msg_attachments WHERE messageId = ?", [messageId]);
    expect(Number(att.days)).toBe(MESSAGING_LIMITS.attachmentRetentionDays); expect(Number(att.durationMs)).toBe(12_000);
    expect(await code(() => msg.editMessage(a1, { messageId, body: "نص" }))).toBe("BAD_REQUEST");
    // التشغيل: المرسل بلا «سمعها»، المستلم مرة واحدة، المالك المطّلع سجل listen واحد رغم طلبات Range المتكررة
    expect((await msg.authorizeVoicePlayback(a1, BASIC, messageId)).monitor).toBe(false);
    await msg.authorizeVoicePlayback(a3, BASIC, messageId); await msg.authorizeVoicePlayback(a3, BASIC, messageId);
    expect((await msg.authorizeVoicePlayback(boss, ALL, messageId)).monitor).toBe(true);
    await msg.authorizeVoicePlayback(boss, ALL, messageId);
    expect(await code(() => msg.authorizeVoicePlayback(boss, BASIC, messageId))).toBe("FORBIDDEN");
    expect(await code(() => msg.authorizeVoicePlayback(a2, BASIC, messageId))).toBe("FORBIDDEN");
    expect(await code(() => msg.authorizeVoicePlayback(bE, ALL, messageId))).toBe("NOT_FOUND");
    const v = (await msg.readMessages(a1, BASIC, { conversationId: dm })).messages.find(x => x.id === messageId)!;
    expect(v.listens).toEqual({ count: 1, mine: false });
    expect(v.attachments[0]).toMatchObject({ kind: "voice", durationMs: 12_000, waveform: [0.1, 0.5, 0.9], purged: false });
    expect(await q("SELECT action, messageId FROM msg_access_audit WHERE action = 'listen'", [])).toEqual([{ action: "listen", messageId }]);
    // الحذف يعلّم الملف للإزالة فورًا، ولا تشغيل بعده
    await msg.deleteMessage(a1, { messageId });
    const [after] = await q("SELECT expiresAt <= NOW(3) AS due FROM msg_attachments WHERE messageId = ?", [messageId]);
    expect(Number(after.due)).toBe(1);
    expect(await code(() => msg.authorizeVoicePlayback(a3, BASIC, messageId))).toBe("NOT_FOUND");
  });

  it("مهمة حذف المرفقات المنتهية: Idempotent، تتخطى مفاتيح شركة أخرى، ولا تلمس غير المنتهي", async () => {
    const store = memoryMessagingStorage();
    const dm = (await msg.startDirect(a2, { employeeId: emp.e3 })).conversationId;
    const send = async (k: string) => (await msg.sendVoice(a2, BASIC, { conversationId: dm, mime: "audio/ogg", bytes: 10, durationMs: 1000, contentSha256: "c".repeat(64), storageKey: k, idempotencyKey: op() })).messageId;
    const kOld = newVoiceKey(A.tenantId, ".ogg"), kNew = newVoiceKey(A.tenantId, ".ogg"), kB = newVoiceKey(B.tenantId, ".ogg");
    for (const k of [kOld, kNew, kB]) store.files.set(k, Buffer.from("x"));
    const old = await send(kOld); const fresh = await send(kNew); const forged = await send(newVoiceKey(A.tenantId, ".ogg"));
    await q("UPDATE msg_attachments SET expiresAt = NOW(3) - INTERVAL 1 DAY WHERE messageId IN (?, ?)", [old, forged]);
    await q("UPDATE msg_attachments SET storageKey = ? WHERE messageId = ?", [kB, forged]); // صف A يشير لمفتاح B (تلاعب مباشر بالقاعدة)
    // أي مرفقات منتهية متبقية من اختبارات سابقة (مثل الصوت المحذوف) تُحتسب كذلك
    const dry = await msg.purgeExpiredAttachments({ storage: store, dryRun: true });
    expect(dry.state).toBe("dry_run"); expect(store.files.size).toBe(3);
    store.fail.del = true;
    const failed = await msg.purgeExpiredAttachments({ storage: store });
    expect(failed.purged).toBe(0); expect(failed.skippedForeignKey).toBe(1);
    expect((await q("SELECT purgedAt FROM msg_attachments WHERE messageId = ?", [old]))[0].purgedAt).toBeNull();
    store.fail.del = false;
    const r1 = await msg.purgeExpiredAttachments({ storage: store });
    expect(r1.skippedForeignKey).toBe(1); expect(r1.failed).toBe(0);
    expect(store.files.has(kOld)).toBe(false); expect(store.files.has(kNew)).toBe(true); expect(store.files.has(kB)).toBe(true);
    expect((await q("SELECT purgedAt IS NOT NULL p FROM msg_attachments WHERE messageId = ?", [old]))[0].p).toBe(1);
    const r2 = await msg.purgeExpiredAttachments({ storage: store });
    expect(r2.purged).toBe(0); expect(r2.failed).toBe(0);
    const v = (await msg.readMessages(a3, BASIC, { conversationId: dm })).messages.find(m => m.id === old)!;
    expect(v.attachments[0].purged).toBe(true);
    expect(await code(() => msg.authorizeVoicePlayback(a3, BASIC, old))).toBe("NOT_FOUND");
    expect(fresh).toBeGreaterThan(0);
  });

  it("المجموعات: بالصلاحية فقط، أعضاء من نفس الشركة ونشطون، والمنشئ مشرف", async () => {
    expect(await code(() => msg.createGroup(a1, BASIC, { title: "الشحن", memberIds: [emp.e2], operationId: op() }))).toBe("FORBIDDEN");
    expect(await code(() => msg.createGroup(mgr, ALL, { title: "الشحن", memberIds: [emp.e2, emp.eb], operationId: op() }))).toBe("BAD_REQUEST");
    expect(await code(() => msg.createGroup(mgr, ALL, { title: "الشحن", memberIds: [emp.off], operationId: op() }))).toBe("BAD_REQUEST");
    expect(await code(() => msg.createGroup(mgr, ALL, { title: "الشحن", memberIds: [emp.e2] } as any))).toBe("ZodError");
    const { conversationId } = await msg.createGroup(mgr, ALL, { title: "الشحن", memberIds: [emp.e2, emp.e3, emp.e3], operationId: op() });
    expect(await q("SELECT employeeId, role FROM msg_members WHERE conversationId = ? ORDER BY employeeId", [conversationId]))
      .toEqual([{ employeeId: emp.e2, role: "member" }, { employeeId: emp.e3, role: "member" }, { employeeId: emp.mgr, role: "admin" }].sort((x, y) => x.employeeId - y.employeeId));
    expect(await code(() => msg.readMessages(a1, BASIC, { conversationId }))).toBe("FORBIDDEN");
    expect((await msg.readMessages(boss, ALL, { conversationId })).readOnly).toBe(true);
  });

  it("createGroup: ضغطتان متزامنتان بنفس operationId = مجموعة واحدة، وReplay لاحق، وحمولة مختلفة = CONFLICT", async () => {
    const operationId = op();
    const input = { title: "التغليف", memberIds: [emp.e3, emp.e1], operationId };
    const before = Number((await q("SELECT COUNT(*) n FROM msg_conversations WHERE kind = 'group'"))[0].n);
    const [r1, r2] = await Promise.all([msg.createGroup(mgr, ALL, input), msg.createGroup(mgr, ALL, input)]);
    expect(r1.conversationId).toBe(r2.conversationId);
    expect([r1.replay, r2.replay].sort()).toEqual([false, true]);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_conversations WHERE kind = 'group'"))[0].n)).toBe(before + 1);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_members WHERE conversationId = ?", [r1.conversationId]))[0].n)).toBe(3);
    // نفس الأعضاء بترتيب مختلف = نفس الحمولة
    expect(await msg.createGroup(mgr, ALL, { ...input, memberIds: [emp.e1, emp.e3] })).toEqual({ conversationId: r1.conversationId, replay: true });
    expect(await code(() => msg.createGroup(mgr, ALL, { ...input, title: "اسم آخر" }))).toBe("CONFLICT");
    // نفس المفتاح في شركة أخرى مستقل
    const other = await msg.createGroup(bE, ALL, { title: "B", memberIds: [emp.eb2], operationId });
    expect(other.replay).toBe(false); expect(other.conversationId).not.toBe(r1.conversationId);
  });

  it("sendMessage: ضغطتان متزامنتان بنفس المفتاح = رسالة واحدة", async () => {
    const idempotencyKey = op();
    const [r1, r2] = await Promise.all([1, 2].map(() => msg.sendMessage(a1, BASIC, { conversationId: teamA, body: "مرة واحدة", idempotencyKey })));
    expect(r1.messageId).toBe(r2.messageId);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_messages WHERE idempotencyKey = ?", [idempotencyKey]))[0].n)).toBe(1);
  });

  it("الصفحات: beforeId/afterId للـPolling + changesSince", async () => {
    const before = await msg.changesSince(a2, 0);
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await msg.sendMessage(a1, BASIC, { conversationId: teamA, body: `رسالة ${i}`, idempotencyKey: op() })).messageId);
    const latest = await msg.readMessages(a2, BASIC, { conversationId: teamA, limit: 2 });
    expect(latest.messages.map(m => m.id)).toEqual(ids.slice(2)); expect(latest.hasMore).toBe(true);
    const older = await msg.readMessages(a2, BASIC, { conversationId: teamA, beforeId: ids[2], limit: 2 });
    expect(older.messages.map(m => m.id)).toEqual(ids.slice(0, 2));
    const newer = await msg.readMessages(a2, BASIC, { conversationId: teamA, afterId: ids[1] });
    expect(newer.messages.map(m => m.id)).toEqual(ids.slice(2)); expect(newer.hasMore).toBe(false);
    const ch = await msg.changesSince(a2, before.cursor);
    expect(ch.changedConversationIds).toEqual([teamA]); expect(ch.cursor).toBe(ids[3]);
    expect((await msg.changesSince(bE, 0)).changedConversationIds).not.toContain(teamA);
  });
});
