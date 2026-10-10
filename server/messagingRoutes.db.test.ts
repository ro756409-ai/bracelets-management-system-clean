import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { MESSAGING_MIGRATION } from "./messagingMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { registerMessagingUploadRoutes } from "./messagingUpload";
import { __setMessagingStorageForTests, memoryMessagingStorage } from "./messagingStorage";
import { fakeWebm, fakeOgg, fakeMp4 } from "./testAudioFixtures";
import { COOKIE_NAME } from "@shared/const";

/**
 * مسارات الرسائل (tRPC + رفع/تشغيل الصوت) على قاعدة Docker مؤقتة: العلم، عزل A/B للرسائل والملفات والمجموعات
 * والإعلانات واطلاع المالك، الصلاحيات من الـDB (السحب يسري فورًا)، view_private المقفولة، الملفات المزورة والحدود،
 * فشل التخزين بلا صف أو ملف يتيم، والضغط المزدوج.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portalCaller = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const webCaller = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const op = () => `op${Math.random().toString(36).slice(2, 14)}`;

describe.runIf(CAN)("🛂 مسارات الرسائل", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const saved = { flag: process.env.MESSAGING_ENABLED, deploy: process.env.DEPLOY_ENV };
  const store = memoryMessagingStorage();
  const app = express(); app.use(cookieParser()); registerMessagingUploadRoutes(app);
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const portal = (id: number) => portalCaller(id).then(c => c.employeePortal.messages);
  const upload = (id: number, fields: Record<string, string | number>, file: Buffer, name = "voice.webm", type = "audio/webm") => {
    let r = request(app).post("/api/messages/voice?via=portal").set("Cookie", `employee_token=${sign(id)}`);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
    return r.attach("file", file, { filename: name, contentType: type });
  };
  const play = (id: number, messageId: number, range?: string) => {
    const r = request(app).get(`/api/messages/voice/${messageId}?via=portal`).set("Cookie", `employee_token=${sign(id)}`).buffer(true).parse((res2, cb) => { const c: Buffer[] = []; res2.on("data", d => c.push(d)); res2.on("end", () => cb(null, Buffer.concat(c))); });
    return range ? r.set("Range", range) : r;
  };
  const grant = (role: string, permission: string, isAllowed: boolean, tenantId = A.tenantId) =>
    q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE isAllowed = VALUES(isAllowed)", [tenantId, role, permission, isAllowed ? 1 : 0, emp.owner]);
  let teamA = 0, annA = 0, dmA = 0, voiceA = 0;

  beforeAll(async () => {
    tmp = await createTempSchema("msg_r");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [MESSAGING_MIGRATION, "drizzle/0043_messaging.sql", "0043"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("mr-a"); B = await createCoreTestFixture("mr-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { emp[k] = insId(await createEmployee({ name: `${k}-mr`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("a1", "agent", A); await mk("a2", "agent", A); await mk("a3", "warehouse", A); await mk("owner", "super_admin", A); await mk("admin", "admin", A); await mk("mgr", "manager", A); await mk("gone", "agent", A);
    await mk("ownerB", "super_admin", B); await mk("bE", "agent", B);
    __setMessagingStorageForTests(store);
  }, 240_000);
  afterAll(async () => {
    if (saved.flag == null) delete process.env.MESSAGING_ENABLED; else process.env.MESSAGING_ENABLED = saved.flag;
    if (saved.deploy == null) delete process.env.DEPLOY_ENV; else process.env.DEPLOY_ENV = saved.deploy;
    __setMessagingStorageForTests(null); __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("العلم معطّل افتراضيًا: الحالة enabled=false، القوائم فارغة، الكتابة والرفع مرفوضان بلا أثر", async () => {
    delete process.env.MESSAGING_ENABLED;
    const p = await portal(emp.a1);
    expect((await p.status()).enabled).toBe(false);
    expect(await p.conversations()).toEqual({ enabled: false });
    expect(await code(() => p.bootstrap())).toBe("PRECONDITION_FAILED");
    expect((await upload(emp.a1, { conversationId: 1, durationMs: 1000, operationId: op() }, fakeWebm(1000))).status).toBe(412);
    expect((await play(emp.a1, 1)).status).toBe(404);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_conversations"))[0].n)).toBe(0);
    process.env.MESSAGING_ENABLED = "true";
  });

  it("الأساس عبر البوابة + المدخلات strict (لا tenantId/employeeId من العميل)", async () => {
    const p = await portal(emp.a1);
    const d = await p.bootstrap(); teamA = d.teamId; annA = d.announcementId;
    await (await portal(emp.ownerB)).bootstrap();
    const s = await p.send({ conversationId: teamA, body: "صباح الخير", idempotencyKey: op() });
    expect((await (await portal(emp.a2)).read({ conversationId: teamA })).messages.some(m => m.id === s.messageId)).toBe(true);
    expect(await code(() => p.send({ conversationId: teamA, body: "x", idempotencyKey: op(), tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
    expect(await code(() => p.startDirect({ employeeId: emp.a2, senderEmployeeId: emp.a3 } as any))).toBe("BAD_REQUEST");
    expect((await p.directory()).map(e => e.id)).not.toContain(emp.bE);
    dmA = (await p.startDirect({ employeeId: emp.a2 })).conversationId;
    await p.send({ conversationId: dmA, body: "خاص بيننا", idempotencyKey: op() });
    // نفس الإجراءات عبر جلسة الويب للمالك
    const w = await webCaller(emp.owner);
    expect((await w.messages.conversations() as any).conversations.map((c: any) => c.id)).toContain(teamA);
  });

  it("«تمت القراءة» عبر البوابة: لا قبل قراءة الطرف الآخر، تظهر بعد markRead، ولا تُكشف لشركة أخرى", async () => {
    const p1 = await portal(emp.a1), p2 = await portal(emp.a2);
    const before = await p1.read({ conversationId: dmA });
    const myLast = before.messages.filter(m => m.mine).at(-1)!.id;
    expect(before.peerLastReadMessageId ?? 0).toBeLessThan(myLast);
    await p2.markRead({ conversationId: dmA, messageId: myLast });
    expect((await p1.read({ conversationId: dmA })).peerLastReadMessageId).toBe(myLast);
    expect(await code(async () => (await portal(emp.bE)).read({ conversationId: dmA }))).toBe("NOT_FOUND");
  });

  it("عزل A/B: الرسائل والمجموعات والإعلانات والخاص", async () => {
    const b = await portal(emp.bE);
    expect(await code(() => b.read({ conversationId: teamA }))).toBe("NOT_FOUND");
    expect(await code(() => b.read({ conversationId: dmA }))).toBe("NOT_FOUND");
    expect(await code(() => b.send({ conversationId: teamA, body: "تسلل", idempotencyKey: op() }))).toBe("NOT_FOUND");
    expect(await code(() => b.startDirect({ employeeId: emp.a1 }))).toBe("NOT_FOUND");
    expect((await b.conversations() as any).conversations.map((c: any) => c.id)).not.toContain(teamA);
    const ob = await portal(emp.ownerB);
    expect(await code(() => ob.createGroup({ title: "مزيج", memberIds: [emp.a1], operationId: op() }))).toBe("BAD_REQUEST");
    const ann = await (await portal(emp.owner)).send({ conversationId: annA, title: "اجتماع", body: "10 ص", idempotencyKey: op() });
    expect(await code(() => ob.announcementReads({ messageId: ann.messageId }))).toBe("NOT_FOUND");
    expect(await code(() => ob.history({ messageId: ann.messageId }))).toBe("NOT_FOUND");
    expect(await code(() => ob.react({ messageId: ann.messageId, reaction: "like" }))).toBe("NOT_FOUND");
  });

  it("الصلاحيات من الـDB: الافتراضي، والسحب يسري في الطلب التالي، والمنح لشركة واحدة", async () => {
    const a = await portal(emp.a1);
    expect(await code(() => a.createGroup({ title: "ج", memberIds: [emp.a2], operationId: op() }))).toBe("FORBIDDEN");
    expect(await code(() => a.send({ conversationId: annA, title: "ع", body: "ن", idempotencyKey: op() }))).toBe("FORBIDDEN");
    expect(await code(() => a.announcementReads({ messageId: 1 }))).toBe("FORBIDDEN");
    expect((await (await portal(emp.mgr)).createGroup({ title: "الإدارة", memberIds: [emp.a1], operationId: op() })).replay).toBe(false);
    await grant("agent", "messages.use", false);
    expect(await code(() => a.conversations())).toBe("FORBIDDEN"); // نفس الـcaller — الطلب التالي
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op() }, fakeWebm(1000))).status).toBe(403);
    expect((await (await portal(emp.bE)).conversations() as any).enabled).toBe(true); // شركة B لم تتأثر
    await grant("agent", "messages.use", true);
    expect((await a.conversations() as any).enabled).toBe(true);
    await grant("agent", "messages.voice", false);
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op() }, fakeWebm(1000))).status).toBe(403);
    await grant("agent", "messages.voice", true);
    await grant("agent", "messages.manage_groups", true);
    expect((await a.createGroup({ title: "منح", memberIds: [emp.a2], operationId: op() })).replay).toBe(false);
    await grant("agent", "messages.manage_groups", false);
  });

  it("createGroup: ضغطتان متزامنتان عبر المسار = مجموعة واحدة", async () => {
    const m = await portal(emp.mgr);
    const input = { title: "ضغط مزدوج", memberIds: [emp.a1, emp.a2], operationId: op() };
    const [r1, r2] = await Promise.all([m.createGroup(input), m.createGroup(input)]);
    expect(r1.conversationId).toBe(r2.conversationId);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_conversations WHERE idempotencyKey = ?", [input.operationId]))[0].n)).toBe(1);
  });

  it("view_private: مقفولة افتراضيًا حتى للمالك، لا تُمنح لدور آخر (حفظًا ولا تقييمًا)، والمطّلع قراءة فقط ومسجَّل", async () => {
    const owner = await portal(emp.owner);
    expect((await owner.status()).permissions.viewPrivate).toBe(false);
    expect((await owner.conversations() as any).monitor).toEqual([]);
    expect(await code(() => owner.read({ conversationId: dmA }))).toBe("FORBIDDEN");
    const ow = await webCaller(emp.owner);
    for (const role of ["admin", "manager", "agent", "accountant"] as const)
      expect(await code(() => ow.accountingV2.rolePermissionSave({ role, permission: "messages.view_private", isAllowed: true }))).toBe("FORBIDDEN");
    expect(Number((await q("SELECT COUNT(*) n FROM tenant_role_permissions WHERE permission = 'messages.view_private'"))[0].n)).toBe(0);
    // صف منح مزروع مباشرة لدور admin يُتجاهل في التقييم
    await grant("admin", "messages.view_private", true);
    expect((await (await portal(emp.admin)).status()).permissions.viewPrivate).toBe(false);
    expect(await code(async () => (await portal(emp.admin)).read({ conversationId: dmA }))).toBe("FORBIDDEN");
    expect((await ow.auth.myPermissions()).includes("messages.view_private" as any)).toBe(false);
    // المالك بمنح صريح لشركته
    await ow.accountingV2.rolePermissionSave({ role: "super_admin", permission: "messages.view_private", isAllowed: true });
    const page = await owner.read({ conversationId: dmA });
    expect(page.readOnly).toBe(true); expect(page.messages.at(-1)?.body).toBe("خاص بيننا");
    expect(Number((await q("SELECT COUNT(*) n FROM msg_access_audit WHERE viewerEmployeeId = ? AND conversationId = ? AND action = 'open'", [emp.owner, dmA]))[0].n)).toBe(1);
    const mid = page.messages.at(-1)!.id;
    expect(await code(() => owner.send({ conversationId: dmA, body: "تدخّل", idempotencyKey: op() }))).toBe("FORBIDDEN");
    expect(await code(() => owner.remove({ messageId: mid }))).toBe("FORBIDDEN");
    expect(await code(() => owner.edit({ messageId: mid, body: "تعديل" }))).toBe("FORBIDDEN");
    expect(await code(() => owner.react({ messageId: mid, reaction: "like" }))).toBe("FORBIDDEN");
    expect(await owner.markRead({ conversationId: dmA, messageId: mid })).toEqual({ lastReadMessageId: null });
    expect((await q("SELECT body, deletedAt FROM msg_messages WHERE id = ?", [mid]))[0]).toEqual({ body: "خاص بيننا", deletedAt: null });
    // مالك شركة B بمنح لشركته لا يرى خاص A
    await grant("super_admin", "messages.view_private", true, B.tenantId);
    expect(await code(async () => (await portal(emp.ownerB)).read({ conversationId: dmA }))).toBe("NOT_FOUND");
    // السحب يسري فورًا
    await ow.accountingV2.rolePermissionSave({ role: "super_admin", permission: "messages.view_private", isAllowed: false });
    expect(await code(() => owner.read({ conversationId: dmA }))).toBe("FORBIDDEN");
  });

  it("رفع الصوت: النوع والمدة من المحتوى، الحجم، الاسم المولَّد، والتخزين الخاص", async () => {
    const ok = await upload(emp.a1, { conversationId: dmA, durationMs: 1, operationId: op() }, fakeWebm(3_200), "rec.webm", "audio/webm;codecs=opus");
    expect(ok.status).toBe(201);
    voiceA = ok.body.messageId;
    const [att] = await q("SELECT storageKey, mime, durationMs, bytes FROM msg_attachments WHERE messageId = ?", [voiceA]);
    expect(att.mime).toBe("audio/webm"); expect(Number(att.durationMs)).toBe(3_200); // المدة المقاسة لا المُعلنة
    expect(att.storageKey).toMatch(new RegExp(`^msg/${A.tenantId}/voice/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.webm$`));
    expect(att.storageKey).not.toContain("rec");
    expect(store.files.has(att.storageKey)).toBe(true);
    expect(JSON.stringify(ok.body)).not.toContain("msg/"); // لا مفتاح تخزين للعميل
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1, operationId: op() }, fakeOgg(2_000), "a.ogg", "audio/ogg")).status).toBe(201);
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1, operationId: op() }, fakeMp4(2_000, true), "a.m4a", "audio/mp4")).status).toBe(201);
    const before = store.files.size, rows = Number((await q("SELECT COUNT(*) n FROM msg_messages"))[0].n);
    // مزوّر: SVG/HTML بامتداد وContent-Type صوتي، وصوت حقيقي باسم .svg/.html، وتنفيذي، وContent-Type غير متسق
    for (const [buf, name, type] of [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "x.webm", "audio/webm"],
      [Buffer.from("<!doctype html><script>alert(1)</script>"), "x.ogg", "audio/ogg"],
      [Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff", "latin1"), "x.m4a", "audio/mp4"],
      [fakeWebm(1000), "evil.svg", "image/svg+xml"],
      [fakeWebm(1000), "page.html", "audio/webm"],
      [fakeWebm(1000), "x.webm", "text/html"],
    ] as const) expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op() }, buf, name, type)).status, name).toBe(415);
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op() }, fakeWebm(1000, { padTo: 10 * 1024 * 1024 + 64 }))).status).toBe(413);
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op() }, fakeWebm(301_000))).status).toBe(413); // أطول من 5 دقائق رغم إعلان ثانية
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 300_001, operationId: op() }, fakeWebm(1000))).status).toBe(400);
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op() }, fakeWebm(2000).subarray(0, 40))).status).toBe(415); // تالف
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op(), tenantId: B.tenantId }, fakeWebm(1000))).status).toBe(400);
    expect((await upload(emp.a1, { conversationId: annA, durationMs: 1000, operationId: op() }, fakeWebm(1000))).status).toBe(400); // الإعلانات نصية
    expect((await upload(emp.bE, { conversationId: dmA, durationMs: 1000, operationId: op() }, fakeWebm(1000))).status).toBe(404); // شركة أخرى
    expect((await request(app).post("/api/messages/voice?via=portal").attach("file", fakeWebm(1000), "a.webm")).status).toBe(401);
    expect(store.files.size).toBe(before);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_messages"))[0].n)).toBe(rows);
  });

  it("فشل التخزين أو فشل التسجيل بعد الرفع = لا صف رسالة ولا ملف يتيم", async () => {
    const files = store.files.size, rows = Number((await q("SELECT COUNT(*) n FROM msg_messages"))[0].n);
    store.fail.put = true;
    expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op() }, fakeWebm(1000))).status).toBe(502);
    store.fail.put = false;
    // رد على رسالة من محادثة أخرى: يُكتشف بعد الرفع داخل المعاملة → يُحذف الملف المرفوع
    const r = await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op(), replyToMessageId: voiceA + 100000 }, fakeWebm(1000));
    expect(r.status).toBe(400);
    expect(store.files.size).toBe(files);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_messages"))[0].n)).toBe(rows);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_attachments WHERE messageId NOT IN (SELECT id FROM msg_messages)"))[0].n)).toBe(0);
  });

  it("الرفع المكرر: نفس operationId = Replay بلا ملف جديد، والضغط المزدوج المتزامن = رسالة وملف واحد", async () => {
    const operationId = op(), file = fakeWebm(1500);
    const first = await upload(emp.a2, { conversationId: dmA, durationMs: 1500, operationId }, file);
    const files = store.files.size;
    const again = await upload(emp.a2, { conversationId: dmA, durationMs: 1500, operationId }, file);
    expect(again.status).toBe(200); expect(again.body).toEqual({ messageId: first.body.messageId, replay: true });
    expect(store.files.size).toBe(files);
    expect((await upload(emp.a2, { conversationId: dmA, durationMs: 1500, operationId }, fakeWebm(1600))).status).toBe(409);
    const op2 = op(), file2 = fakeWebm(1700);
    const [x, y] = await Promise.all([upload(emp.a2, { conversationId: dmA, durationMs: 1700, operationId: op2 }, file2), upload(emp.a2, { conversationId: dmA, durationMs: 1700, operationId: op2 }, file2)]);
    expect(x.body.messageId).toBe(y.body.messageId);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_messages WHERE idempotencyKey = ?", [op2]))[0].n)).toBe(1);
    expect(store.files.size).toBe(files + 1);
  });

  it("التشغيل: العضو فقط (Range مدعوم)، شركة أخرى 404 حتى بمعرفة الـID، والمالك بالمنح مسجَّل", async () => {
    const full = await play(emp.a2, voiceA);
    expect(full.status).toBe(200);
    expect(full.headers["content-type"]).toBe("audio/webm");
    expect(full.headers["x-content-type-options"]).toBe("nosniff");
    expect(full.headers["cache-control"]).toBe("private, no-store");
    expect((full.body as Buffer).equals(fakeWebm(3_200))).toBe(true);
    const part = await play(emp.a2, voiceA, "bytes=0-9");
    expect(part.status).toBe(206); expect((part.body as Buffer).length).toBe(10);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_voice_listens WHERE messageId = ? AND employeeId = ?", [voiceA, emp.a2]))[0].n)).toBe(1);
    expect((await play(emp.bE, voiceA)).status).toBe(404);
    expect((await play(emp.ownerB, voiceA)).status).toBe(404);
    expect((await play(emp.a3, voiceA)).status).toBe(403); // نفس الشركة لكن ليس عضوًا
    expect((await play(emp.owner, voiceA)).status).toBe(403); // المالك بلا منح
    expect((await request(app).get(`/api/messages/voice/${voiceA}?via=portal`)).status).toBe(404);
    expect((await request(app).get(`/api/messages/voice/..%2F..%2Fetc%2Fpasswd?via=portal`).set("Cookie", `employee_token=${sign(emp.a2)}`)).status).toBe(404);
    await grant("super_admin", "messages.view_private", true);
    expect((await play(emp.owner, voiceA)).status).toBe(200);
    await play(emp.owner, voiceA, "bytes=0-1");
    expect(Number((await q("SELECT COUNT(*) n FROM msg_access_audit WHERE viewerEmployeeId = ? AND messageId = ? AND action = 'listen'", [emp.owner, voiceA]))[0].n)).toBe(1);
    expect(Number((await q("SELECT COUNT(*) n FROM msg_voice_listens WHERE messageId = ? AND employeeId = ?", [voiceA, emp.owner]))[0].n)).toBe(0);
    await grant("super_admin", "messages.view_private", false);
    // بعد حذف صاحبها: لا تشغيل
    await (await portal(emp.a1)).remove({ messageId: voiceA });
    expect((await play(emp.a2, voiceA)).status).toBe(404);
  });

  it("الموظف المعطّل: لا رفع ولا إرسال (الطلب التالي)", async () => {
    const g = await portal(emp.gone);
    await g.bootstrap();
    await q("UPDATE employees SET isActive = 0 WHERE id = ?", [emp.gone]);
    expect((await upload(emp.gone, { conversationId: teamA, durationMs: 1000, operationId: op() }, fakeWebm(1000))).status).toBe(401);
    // نفس الـcaller: البوابة تعيد قراءة الموظف من الـDB في كل طلب
    expect(await code(() => g.send({ conversationId: teamA, body: "بعد التعطيل", idempotencyKey: op() }))).toBe("UNAUTHORIZED");
    expect(await code(async () => (await portal(emp.gone)).send({ conversationId: teamA, body: "x", idempotencyKey: op() }))).toBe("UNAUTHORIZED");
  });

  it("بيئة منشورة بلا تخزين دائم: الرفع 503 ولا قرص محلي", async () => {
    __setMessagingStorageForTests(null);
    const env = { ...process.env };
    process.env.DEPLOY_ENV = "staging"; delete process.env.S3_BUCKET; delete process.env.S3_ACCESS_KEY_ID; delete process.env.S3_SECRET_ACCESS_KEY;
    // عدّ الملفات قبل/بعد (لا الاعتماد على غياب المجلد): مسار 503 لا يكتب أي ملف محلي
    const localFiles = () => (fs.existsSync("uploads/messages") ? fs.readdirSync("uploads/messages", { recursive: true }).filter(f => fs.statSync(`uploads/messages/${f}`).isFile()).length : 0);
    const before = localFiles();
    try {
      expect((await upload(emp.a1, { conversationId: dmA, durationMs: 1000, operationId: op() }, fakeWebm(1000))).status).toBe(503);
      expect(localFiles()).toBe(before);
    } finally {
      for (const k of ["DEPLOY_ENV", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) { if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
      __setMessagingStorageForTests(store);
    }
  });
});
