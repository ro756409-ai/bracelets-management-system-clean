import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { getDb, createEmployee } from "./db";
import { broadcastMessages, businesses, employees, tasks } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { COOKIE_NAME } from "@shared/const";

/**
 * P0 — الرسائل الجماعية والمهام: عزل الـTenant fail-closed.
 *
 * قبل الإصلاح: `sendBroadcast/clear` كانوا بيعطّلوا رسائل **كل** الشركات، `activeBroadcast/getActive`
 * بيرجّعوا آخر رسالة في النظام كله، `tasks.create` بيقبل مستلم من أي شركة ومابيكتبش businessId،
 * و`tasks.list` بلا employeeId بيرجّع مهام كل الشركات.
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");
const context = fs.readFileSync("server/_core/context.ts", "utf-8");
const section = (start: string, end: string) => routers.slice(routers.indexOf(start), routers.indexOf(end, routers.indexOf(start)));

describe("🔒 P0 الرسائل والمهام — حراس نصّية", () => {
  it("لا UPDATE عام على broadcast_messages (كل إلغاء تفعيل مقيّد بنطاق)", () => {
    expect(routers).not.toMatch(/update\(broadcastMessages\)\.set\(\{ isActive: false \}\);/);
    expect(routers.match(/broadcastScopeCondition\(scope\)/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("القراءة النشطة عبر نطاق الجلسة في البوابة والويب", () => {
    const portal = section("activeBroadcast: employeePortalProcedure", "markDuplicate:");
    expect(portal).toContain("portalTeamScope(ctx)");
    const web = section("broadcast: router({", "returns: router({");
    expect(web.match(/sessionTeamScope\(ctx\)/g)!.length).toBe(3);
  });
  it("كل إجراءات المهام تمر بنطاق البوابة، ولا WHERE بالمعرّف وحده", () => {
    const t = section("\n  tasks: router({", "سجل الطباعات");
    expect(t.match(/portalTeamScope\(ctx\)/g)!.length).toBe(4);
    expect(t).toContain("taskScopeCondition(scope)");
    expect(t).not.toMatch(/\.where\(eq\(tasks\.id, input\.taskId\)\)/);
    expect(t).toContain("employeeInTeamScope(assignee, scope)");
    expect(t).toContain("businessId,");
  });
  it("المدخلات strict — tenantId/businessId المزوّرة تترفض بدل ما تتجاهل بصمت", () => {
    const t = section("\n  tasks: router({", "سجل الطباعات");
    expect(t.match(/\.strict\(\)/g)!.length).toBe(4);
  });
  it("Platform Admin منفصل: context مابيقراش كوكي المنصة", () => {
    expect(context).not.toContain("platform_admin_session");
    expect(context).not.toContain("PLATFORM_COOKIE");
  });
});

const CAN_E2E = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN_E2E)("🔒 P0 الرسائل والمهام — Tenant A / Tenant B (DB)", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  let A2 = 0; // نشاط تاني داخل tenant A
  const tag = `ts${Date.now().toString(36)}`;
  const emp: Record<string, number> = {};
  const names: Record<string, string> = {};
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
  const res = { cookie: () => {}, clearCookie: () => {} } as any;
  const portal = async (id: number) =>
    appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
  const web = async (id: number) =>
    appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
  async function code(fn: () => Promise<any>): Promise<string> {
    try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; }
  }
  const db = async () => (await getDb())!;
  const taskCount = async () => Number((await (await db()).select({ n: sql<number>`COUNT(*)` }).from(tasks).where(like(tasks.title, `%${tag}%`)))[0].n);

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("team-a");
    B = await createCoreTestFixture("team-b");
    A2 = insId(await d.insert(businesses).values({ tenantId: A.tenantId, name: `A2 ${tag}`, slug: `a2-${tag}`, baseCurrency: "EGP", timezone: "Africa/Cairo" }));
    const mk = async (key: string, role: string, tenantId: number, businessId: number | null) => {
      names[key] = `${key}-${tag}`;
      emp[key] = insId(await createEmployee({ name: names[key], role, isActive: true, tenantId, businessId, username: `${key}_${tag}`.slice(0, 50) } as any));
    };
    await mk("mgrA", "manager", A.tenantId, A.businessId);
    await mk("agentA", "agent", A.tenantId, A.businessId);
    await mk("agentA2", "agent", A.tenantId, A2);
    await mk("mgrNone", "manager", A.tenantId, null);
    await mk("superA", "super_admin", A.tenantId, A.businessId);
    await mk("mgrB", "manager", B.tenantId, B.businessId);
    await mk("agentB", "agent", B.tenantId, B.businessId);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    await d.delete(tasks).where(like(tasks.title, `%${tag}%`));
    await d.delete(broadcastMessages).where(like(broadcastMessages.message, `%${tag}%`));
    const ids = Object.values(emp);
    if (ids.length) await d.delete(employees).where(inArray(employees.id, ids));
    if (A2) await d.delete(businesses).where(eq(businesses.id, A2));
    await B?.cleanup(); await A?.cleanup();
  });

  it("الرسالة الجماعية: A مايقراش رسالة B، وإرسال B مايعطّلش رسالة A", async () => {
    await (await portal(emp.mgrA)).employeePortal.sendBroadcast({ message: `msg-A ${tag}` });
    await (await portal(emp.mgrB)).employeePortal.sendBroadcast({ message: `msg-B ${tag}` });
    expect((await (await portal(emp.agentA)).employeePortal.activeBroadcast())?.message).toBe(`msg-A ${tag}`);
    expect((await (await portal(emp.agentB)).employeePortal.activeBroadcast())?.message).toBe(`msg-B ${tag}`);
    // رسالة مدير A لنشاطه بس — موظف النشاط التاني في نفس الـtenant مايشوفهاش
    expect((await (await portal(emp.agentA2)).employeePortal.activeBroadcast())?.message ?? null).not.toBe(`msg-A ${tag}`);
    // صف رسالة A لسه نشط (الإرسال القديم كان بيعطّل كل الصفوف)
    const [rowA] = await (await db()).select().from(broadcastMessages).where(eq(broadcastMessages.message, `msg-A ${tag}`));
    expect(rowA.isActive).toBe(true);
    expect(rowA.businessId).toBe(A.businessId);
  });

  it("الإلغاء: clear من B مايلمسش رسالة A", async () => {
    await (await portal(emp.mgrB)).employeePortal.clearBroadcast();
    expect((await (await portal(emp.agentB)).employeePortal.activeBroadcast())).toBeNull();
    expect((await (await portal(emp.agentA)).employeePortal.activeBroadcast())?.message).toBe(`msg-A ${tag}`);
  });

  it("Super admin يشوف شركته بس (مش المنصة)، وإرساله يوصل لأنشطة شركته بس", async () => {
    await (await portal(emp.mgrB)).employeePortal.sendBroadcast({ message: `msg-B2 ${tag}` });
    const owner = await web(emp.superA);
    expect((await owner.broadcast.getActive())?.message).not.toBe(`msg-B2 ${tag}`);
    await owner.broadcast.send({ message: `msg-owner ${tag}` });
    expect((await (await portal(emp.agentA)).employeePortal.activeBroadcast())?.message).toBe(`msg-owner ${tag}`);
    expect((await (await portal(emp.agentA2)).employeePortal.activeBroadcast())?.message).toBe(`msg-owner ${tag}`);
    expect((await (await portal(emp.agentB)).employeePortal.activeBroadcast())?.message).toBe(`msg-B2 ${tag}`);
    const rows = await (await db()).select().from(broadcastMessages).where(eq(broadcastMessages.message, `msg-owner ${tag}`));
    expect(rows.map(r => r.businessId).sort()).toEqual([A.businessId, A2].sort());
  });

  it("مدير بلا نشاط: لا قراءة عامة ولا إرسال", async () => {
    const none = await portal(emp.mgrNone);
    expect(await none.employeePortal.activeBroadcast()).toBeNull();
    expect(await code(() => none.employeePortal.sendBroadcast({ message: `msg-none ${tag}` }))).toBe("FORBIDDEN");
    expect(await code(() => none.employeePortal.clearBroadcast())).toBe("FORBIDDEN");
    const rows = await (await db()).select().from(broadcastMessages).where(eq(broadcastMessages.message, `msg-none ${tag}`));
    expect(rows).toHaveLength(0);
  });

  it("تزوير businessId/tenantId في مدخلات الرسالة يُرفض بلا كتابة", async () => {
    const mgrA = await portal(emp.mgrA);
    expect(await code(() => mgrA.employeePortal.sendBroadcast({ message: `msg-forge ${tag}`, businessId: B.businessId } as any))).toBe("BAD_REQUEST");
    expect(await code(() => mgrA.employeePortal.sendBroadcast({ message: `msg-forge ${tag}`, tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
    const rows = await (await db()).select().from(broadcastMessages).where(eq(broadcastMessages.message, `msg-forge ${tag}`));
    expect(rows).toHaveLength(0);
  });

  it("المهام: A مايقدرش ينشئ مهمة لموظف B ولا لنشاط تاني، والرفض بلا كتابة", async () => {
    const mgrA = await portal(emp.mgrA);
    const before = await taskCount();
    expect(await code(() => mgrA.tasks.create({ title: `t-cross ${tag}`, assignedTo: emp.agentB }))).toBe("FORBIDDEN");
    expect(await code(() => mgrA.tasks.create({ title: `t-a2 ${tag}`, assignedTo: emp.agentA2 }))).toBe("FORBIDDEN");
    expect(await code(() => mgrA.tasks.create({ title: `t-forge ${tag}`, businessId: B.businessId } as any))).toBe("BAD_REQUEST");
    expect(await code(() => mgrA.tasks.create({ title: `t-forge2 ${tag}`, tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
    expect(await taskCount()).toBe(before);
  });

  it("المهام: الإنشاء داخل النطاق بيكتب نشاط المستلم، والقائمة معزولة", async () => {
    const mgrA = await portal(emp.mgrA), mgrB = await portal(emp.mgrB);
    await mgrA.tasks.create({ title: `t-A-agent ${tag}`, assignedTo: emp.agentA });
    await mgrA.tasks.create({ title: `t-A-general ${tag}` });
    await mgrB.tasks.create({ title: `t-B-agent ${tag}`, assignedTo: emp.agentB });
    const rows = await (await db()).select().from(tasks).where(like(tasks.title, `%${tag}%`));
    expect(rows.find(r => r.title === `t-A-agent ${tag}`)?.businessId).toBe(A.businessId);
    expect(rows.find(r => r.title === `t-A-general ${tag}`)?.businessId).toBe(A.businessId);
    expect(rows.find(r => r.title === `t-B-agent ${tag}`)?.businessId).toBe(B.businessId);

    const listA = (await mgrA.tasks.list({})).map(t => t.title);
    expect(listA).toContain(`t-A-agent ${tag}`);
    expect(listA).toContain(`t-A-general ${tag}`);
    expect(listA).not.toContain(`t-B-agent ${tag}`);
    const listB = (await mgrB.tasks.list({})).map(t => t.title);
    expect(listB).toEqual(expect.arrayContaining([`t-B-agent ${tag}`]));
    expect(listB.some(t => t.startsWith("t-A-"))).toBe(false);
    expect(await code(() => mgrA.tasks.list({ employeeId: emp.agentB }))).toBe("FORBIDDEN");
  });

  it("المهام: A مايعدّلش ولا يحذفش مهمة B — بلا أي تغيير", async () => {
    const mgrA = await portal(emp.mgrA);
    const [taskB] = await (await db()).select().from(tasks).where(eq(tasks.title, `t-B-agent ${tag}`));
    expect(await code(() => mgrA.tasks.updateStatus({ taskId: taskB.id, status: "done" }))).toBe("FORBIDDEN");
    expect(await code(() => mgrA.tasks.delete({ taskId: taskB.id }))).toBe("FORBIDDEN");
    const [after] = await (await db()).select().from(tasks).where(eq(tasks.id, taskB.id));
    expect(after.status).toBe("new");
    expect(await code(() => mgrA.tasks.updateStatus({ taskId: 2_000_000_000, status: "done" }))).toBe("NOT_FOUND");
  });

  it("مدير بلا نشاط: صفر مهام (مش كل الشركات)، والإنشاء مرفوض", async () => {
    const none = await portal(emp.mgrNone);
    expect(await none.tasks.list({})).toEqual([]);
    expect(await code(() => none.tasks.create({ title: `t-none ${tag}` }))).toBe("FORBIDDEN");
  });

  it("الصفوف القديمة (businessId NULL) تظهر لشركتها بس — بإثبات المستلم أو المرسل", async () => {
    const d = await db();
    await d.insert(tasks).values({ title: `t-legacy-A ${tag}`, assignedTo: emp.agentA, assignedToName: names.agentA, createdBy: -emp.mgrA, createdByName: names.mgrA });
    await d.insert(tasks).values({ title: `t-legacy-unproven ${tag}`, assignedTo: null, createdBy: 999_999_999, createdByName: "غير معروف" });
    // عقد الفاعل: جلسة المدير على الويب تكتب sentBy = -employeeId (الموجب users.id فقط — اختباراته في legacyActorScope.db.test)
    await d.insert(broadcastMessages).values({ message: `msg-legacy-B ${tag}`, sentBy: -emp.mgrB, sentByName: names.mgrB, isActive: true });
    const mgrA = await portal(emp.mgrA), mgrB = await portal(emp.mgrB);
    const listA = (await mgrA.tasks.list({})).map(t => t.title);
    expect(listA).toContain(`t-legacy-A ${tag}`);
    expect(listA).not.toContain(`t-legacy-unproven ${tag}`);
    expect((await mgrB.tasks.list({})).map(t => t.title)).not.toContain(`t-legacy-A ${tag}`);
    const [legacy] = await d.select().from(tasks).where(eq(tasks.title, `t-legacy-A ${tag}`));
    expect(await code(() => mgrB.tasks.updateStatus({ taskId: legacy.id, status: "done" }))).toBe("FORBIDDEN");
    await mgrA.tasks.updateStatus({ taskId: legacy.id, status: "in_progress" });
    // الرسالة القديمة لمرسل من B: موظف B يشوفها لو مفيش أحدث، موظف A لأ
    await d.update(broadcastMessages).set({ isActive: false }).where(and(eq(broadcastMessages.businessId, B.businessId)));
    expect((await (await portal(emp.agentB)).employeePortal.activeBroadcast())?.message).toBe(`msg-legacy-B ${tag}`);
    expect((await (await portal(emp.agentA)).employeePortal.activeBroadcast())?.message).not.toBe(`msg-legacy-B ${tag}`);
  });

  it("الاستعلامات لا تكتب: القراءة مابتغيّرش أي صف", async () => {
    const d = await db();
    const snap = async () => JSON.stringify(await d.select().from(tasks).where(like(tasks.title, `%${tag}%`)).orderBy(tasks.id));
    const before = await snap();
    await (await portal(emp.mgrA)).tasks.list({});
    await (await portal(emp.mgrB)).tasks.list({ status: "new" });
    expect(await snap()).toBe(before);
  });
});
