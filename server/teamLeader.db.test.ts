import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { TEAMS_MIGRATION } from "./teamsMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { COOKIE_NAME } from "@shared/const";
import * as teams from "./teams.service";

/**
 * مسارات القائد على MySQL حقيقي: Tenant A/B، فريقان في نفس الشركة على نشاطين (أفندي/فرحات)، موظفة في الفريقين،
 * عضوية منتهية (تاريخ لا حالي)، قائد بلا قيادة لفريق آخر، صلاحية بلا قيادة، قيادة بلا صلاحية، سحب الصلاحية من
 * الطلب التالي، الضغط المزدوج يكتب مرة، والإسناد خارج الفريق مرفوض بلا كتابة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `tl${Date.now().toString(36)}${++seq}xx`;
const Z = (iso: string) => new Date(iso).toISOString().replace("T", " ").replace("Z", "");
const RANGE = { dateFrom: "2026-10-01", dateTo: "2026-10-09" };
const FLAGS = ["TEAMS_ENABLED", "ATTENDANCE_ENABLED", "ORDER_EVENTS_ENABLED"] as const;

describe.runIf(CAN)("🧭 مسارات القائد", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let farhat = 0, third = 0, T1 = 0, T2 = 0, T3 = 0, TB = 0;
  const saved: Record<string, string | undefined> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const n = async (s: string, p: unknown[] = []) => Number((await q(s, p))[0].n);
  const owner = (tenantId: number, id: number): teams.TeamsActor => ({ tenantId, employeeId: id, role: "super_admin" });
  const grant = (role: string, permission: string, allowed: boolean, tenantId = A.tenantId) =>
    q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE isAllowed = VALUES(isAllowed)", [tenantId, role, permission, allowed ? 1 : 0, e.owner]);
  const ungrant = (role: string, permission: string) => q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = ? AND permission = ?", [A.tenantId, role, permission]);
  /** عضوية تاريخية مباشرة (بيانات اختبار): الخدمة لا تسمح بالتأريخ الرجعي، فالتاريخ المعروف يُبنى هنا. */
  const rawMember = async (tenantId: number, teamId: number, employeeId: number, fromIso: string, toIso: string | null) => {
    const H = "d".repeat(64), by = tenantId === A.tenantId ? e.owner : e.ownerB;
    await q(`INSERT INTO team_memberships (tenantId, teamId, employeeId, membershipRole, effectiveFromAt, effectiveToAt, assignedByEmployeeId, idempotencyKey, payloadHash, endedAt, endedByEmployeeId, endIdempotencyKey, endPayloadHash)
      VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, teamId, employeeId, Z(fromIso), toIso ? Z(toIso) : null, by, `rawmember:${++seq}xx`, H,
      toIso ? Z(toIso) : null, toIso ? by : null, toIso ? `rawmemberend:${++seq}xx` : null, toIso ? H : null]);
  };
  const lead = async (tenantId: number, ownerId: number, teamId: number, employeeId: number) => {
    await teams.addMember(owner(tenantId, ownerId), { teamId, employeeId, operationId: op() });
    await teams.setLeader(owner(tenantId, ownerId), { teamId, employeeId, operationId: op() });
  };
  const punch = async (employeeId: number, workDate: string, hm: string) =>
    (await web(e.owner)).attendance.adminCorrect({ employeeId, workDate, punchType: "clock_in", at: new Date(`${workDate}T${hm}:00+03:00`).toISOString(), reason: "بيانات اختبار", operationId: op() });
  let evSeq = 0;
  const event = async (o: { tenantId?: number; businessId: number; orderId: number; type: string; by?: number | null; assignee?: number | null; at: string; backfill?: "partial" | "confirmed" }) => {
    const tenantId = o.tenantId ?? A.tenantId;
    const actorType = o.backfill ? "backfill" : o.by != null ? "employee" : "system";
    await q(`INSERT INTO order_activity_events (tenantId, businessId, orderId, orderNumberSnapshot, eventType, actorType, actorEmployeeId, attributedEmployeeId, assigneeEmployeeIdAtEvent, source, backfillConfidence, idempotencyKey, payloadHash, occurredAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, o.businessId, o.orderId, `N-${o.orderId}`, o.type, actorType, o.backfill ? null : o.by ?? null, o.by ?? null, o.assignee ?? null,
      o.backfill ? "backfill" : "manual", o.backfill ?? null, `t:ev${++evSeq}`, "e".repeat(64), Z(o.at)]);
  };
  const order = async (businessId: number, assignedEmployeeId: number | null = null) =>
    insId(await q("INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, governorate, customerAddress, productName, quantity, totalAmount, source, assignedEmployeeId) VALUES (?, ?, 'c', '01000000000', 'القاهرة', 'عنوان طويل', 'p', 1, 1, 'manual', ?)",
      [businessId, `TL-${Math.random().toString(36).slice(2, 10)}`, assignedEmployeeId]));

  beforeAll(async () => {
    tmp = await createTempSchema("team_ldr");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"], [TEAMS_MIGRATION, "drizzle/0044_teams.sql", "0044"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    await tmp.raw.query("SET time_zone = '+00:00'");
    __setDbForTests(drizzle(tmp.url));
    for (const f of FLAGS) { saved[f] = process.env[f]; process.env[f] = "true"; }
    A = await createCoreTestFixture("tl-a"); B = await createCoreTestFixture("tl-b");
    const biz = async (nm: string) => insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [A.tenantId, nm, `${nm}-${tmp.name}`.slice(0, 50)]));
    farhat = await biz("farhat"); third = await biz("third");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-ldr`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("owner", "super_admin", A);
    for (const k of ["L1", "L2", "m1", "m2", "m3", "outsider"]) await mk(k, "moderator", A);
    await mk("agentLeader", "agent", A);
    await mk("ownerB", "super_admin", B); await mk("LB", "moderator", B); await mk("mB", "moderator", B);
    const oA = owner(A.tenantId, e.owner);
    T1 = (await teams.createTeam(oA, { businessId: A.businessId, name: "فريق أفندي", operationId: op() }, [A.businessId, farhat, third])).id;
    T2 = (await teams.createTeam(oA, { businessId: farhat, name: "فريق فرحات", operationId: op() }, [A.businessId, farhat, third])).id;
    T3 = (await teams.createTeam(oA, { businessId: third, name: "فريق بقائد بلا صلاحية", operationId: op() }, [A.businessId, farhat, third])).id;
    TB = (await teams.createTeam(owner(B.tenantId, e.ownerB), { businessId: B.businessId, name: "فريق B", operationId: op() }, [B.businessId])).id;
    // تاريخ العضوية: m1 وm2 في أفندي منذ 10-01؛ m2 أيضًا في فرحات؛ m3 في أفندي من 10-01 حتى 10-05 فقط
    await rawMember(A.tenantId, T1, e.m1, "2026-10-01T00:00:00Z", null);
    await rawMember(A.tenantId, T1, e.m2, "2026-10-01T00:00:00Z", null);
    await rawMember(A.tenantId, T2, e.m2, "2026-10-01T00:00:00Z", null);
    await rawMember(A.tenantId, T1, e.m3, "2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z");
    await rawMember(B.tenantId, TB, e.mB, "2026-10-01T00:00:00Z", null);
    await lead(A.tenantId, e.owner, T1, e.L1); await lead(A.tenantId, e.owner, T2, e.L2);
    await lead(A.tenantId, e.owner, T3, e.agentLeader); await lead(B.tenantId, e.ownerB, TB, e.LB);
  }, 300_000);
  afterAll(async () => {
    for (const f of FLAGS) { if (saved[f] == null) delete process.env[f]; else process.env[f] = saved[f]; }
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("الحراس: صلاحية بلا قيادة = صفر/FORBIDDEN، قيادة بلا صلاحية = FORBIDDEN، فريق لا يقوده = FORBIDDEN، شركة أخرى = FORBIDDEN", async () => {
    expect((await (await portal(e.outsider)).employeePortal.team.myTeams()).teams).toEqual([]);
    for (const f of [
      (c: any) => c.employeePortal.team.attendance({ teamId: T1, ...RANGE }),
      (c: any) => c.employeePortal.team.performance({ teamId: T1, ...RANGE }),
      (c: any) => c.employeePortal.team.tasks.list({ teamId: T1 }),
      (c: any) => c.employeePortal.team.orders.list({ teamId: T1 }),
    ]) {
      expect(await code(async () => f(await portal(e.outsider)))).toBe("FORBIDDEN"); // صلاحية بلا قيادة
      expect(await code(async () => f(await portal(e.L2)))).toBe("FORBIDDEN"); // قائد فريق آخر
      expect(await code(async () => f(await portal(e.LB)))).toBe("FORBIDDEN"); // قائد شركة أخرى
      expect(await code(async () => f(await portal(e.L1)))).toBe("ok");
    }
    // قيادة فعّالة بلا صلاحيات الفريق (دور agent) = مرفوض
    expect(await code(async () => (await portal(e.agentLeader)).employeePortal.team.myTeams())).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.agentLeader)).employeePortal.team.tasks.list({ teamId: T3 }))).toBe("FORBIDDEN");
    // strict: لا هوية من العميل
    expect(await code(async () => (await portal(e.L1)).employeePortal.team.orders.list({ teamId: T1, tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
  });

  it("سحب الصلاحية يعمل من الطلب التالي، وإعادتها تفتح فورًا", async () => {
    await grant("moderator", "team_orders.view", false);
    try { expect(await code(async () => (await portal(e.L1)).employeePortal.team.orders.list({ teamId: T1 }))).toBe("FORBIDDEN"); }
    finally { await ungrant("moderator", "team_orders.view"); }
    expect(await code(async () => (await portal(e.L1)).employeePortal.team.orders.list({ teamId: T1 }))).toBe("ok");
  });

  it("الحضور: أعضاء الفريق لحظة اليوم فقط — العضوية المنتهية تظهر تاريخيًا لا بعدها، ولا موظف خارج الفريق", async () => {
    await punch(e.m1, "2026-10-08", "09:00"); await punch(e.m2, "2026-10-08", "09:10");
    await punch(e.m3, "2026-10-03", "09:00"); await punch(e.m3, "2026-10-07", "09:00");
    await punch(e.outsider, "2026-10-08", "09:00");
    const r = await (await portal(e.L1)).employeePortal.team.attendance({ teamId: T1, ...RANGE });
    const seen = r.enabled ? r.days.map((d: any) => `${d.employeeId}@${d.workDate}`).sort() : [];
    expect(seen).toEqual([`${e.m1}@2026-10-08`, `${e.m2}@2026-10-08`, `${e.m3}@2026-10-03`].sort());
    // الموظفة في فريقين تظهر في حضور الفريقين (الحضور للموظف لا للنشاط)، وm3 ليس في فرحات
    const r2 = await (await portal(e.L2)).employeePortal.team.attendance({ teamId: T2, ...RANGE });
    expect(r2.enabled && r2.days.map((d: any) => d.employeeId)).toEqual([e.m2]);
    // الحالي: m3 ليس عضوًا الآن
    const members = await (await portal(e.L1)).employeePortal.team.members({ teamId: T1 });
    expect(members.members.map((m: any) => m.employeeId)).not.toContain(e.m3);
  });

  it("اعتماد التصحيح: approve_corrections إلزامية بالمنح، صاحب الطلب داخل الفريق الآن، لا طلبه الشخصي، الإجازة تحتاج manage_leaves، والضغط المزدوج مرة واحدة", async () => {
    const req = async (id: number, workDate: string, requestType: string, requestedValue: any) =>
      (await portal(id)).employeePortal.attendanceRequestCorrection({ workDate, requestType: requestType as any, requestedValue, reason: "سبب الاختبار هنا", operationId: op() });
    const at = (d: string, hm: string) => ({ at: new Date(`${d}T${hm}:00+03:00`).toISOString() });
    const r1 = await req(e.m1, "2026-10-08", "missing_clock_out", at("2026-10-08", "17:00"));
    const mine = await req(e.L1, "2026-10-08", "missing_clock_in", at("2026-10-08", "09:00"));
    const rOut = await req(e.outsider, "2026-10-08", "missing_clock_out", at("2026-10-08", "17:00"));
    const rEnded = await req(e.m3, "2026-10-03", "missing_clock_out", at("2026-10-03", "17:00"));
    const rLeave = await req(e.m2, "2026-10-09", "absence_to_leave", {});
    const review = async (requestId: number, decision: "approve" | "reject" = "approve") => (await portal(e.L1)).employeePortal.team.reviewCorrection({ teamId: T1, requestId, decision, reviewReason: decision === "reject" ? "مرفوض للاختبار" : null });
    // افتراضيًا القائد لا يعتمد
    expect(await code(() => review(r1.id))).toBe("FORBIDDEN");
    await grant("moderator", "attendance.approve_corrections", true);
    try {
      const list = await (await portal(e.L1)).employeePortal.team.attendance({ teamId: T1, ...RANGE });
      const pend = list.enabled ? list.pending.map((p: any) => p.id) : [];
      expect(pend).toContain(r1.id); expect(pend).toContain(mine.id);
      expect(pend).not.toContain(rOut.id); expect(pend).not.toContain(rEnded.id);
      expect(list.enabled && list.pending.find((p: any) => p.id === mine.id)?.isMine).toBe(true);
      expect(await code(() => review(mine.id))).toBe("FORBIDDEN"); // طلبه الشخصي
      expect(await code(() => review(rOut.id))).toBe("FORBIDDEN"); // خارج الفريق
      expect(await code(() => review(rEnded.id))).toBe("FORBIDDEN"); // عضوية منتهية
      expect(await code(() => review(rLeave.id))).toBe("FORBIDDEN"); // إجازة بلا manage_leaves
      // الضغط المزدوج: يكتب مرة واحدة
      const events = async () => n("SELECT COUNT(*) n FROM attendance_events WHERE correctionRequestId = ?", [r1.id]);
      const both = await Promise.allSettled([review(r1.id), review(r1.id)]);
      expect(both.filter(x => x.status === "fulfilled")).toHaveLength(1);
      expect(both.filter(x => x.status === "rejected").map(x => (x as any).reason.code)).toEqual(["CONFLICT"]);
      expect(await events()).toBe(1);
      expect((await q("SELECT status, reviewedByEmployeeId FROM attendance_correction_requests WHERE id = ?", [r1.id]))[0]).toMatchObject({ status: "approved", reviewedByEmployeeId: e.L1 });
      // الإجازة بعد منح manage_leaves
      await grant("moderator", "attendance.manage_leaves", true);
      expect((await review(rLeave.id)).status).toBe("approved");
      // سحب approve_corrections يمنع من الطلب التالي
      await grant("moderator", "attendance.approve_corrections", false);
      expect(await code(() => review(rEnded.id, "reject"))).toBe("FORBIDDEN");
    } finally { await ungrant("moderator", "attendance.approve_corrections"); await ungrant("moderator", "attendance.manage_leaves"); }
  });

  it("الأداء: نفس الشركة + نشاط الفريق + عضوية لحظة occurredAt؛ «فرحات» لا تظهر في «أفندي»؛ إعادة الإسناد لا تنقل التاريخ؛ حد 20؛ Backfill الجزئي خارج الحساب", async () => {
    const A1 = A.businessId;
    for (let i = 0; i < 20; i++) await event({ businessId: A1, orderId: 1000 + i, type: "confirm", by: e.m1, at: "2026-10-03T08:00:00Z" });
    await event({ businessId: A1, orderId: 2001, type: "confirm", by: e.m2, at: "2026-10-03T08:00:00Z" });
    await event({ businessId: farhat, orderId: 2002, type: "confirm", by: e.m2, at: "2026-10-03T08:00:00Z" });
    await event({ businessId: farhat, orderId: 2003, type: "cancel", by: e.m2, at: "2026-10-03T09:00:00Z" });
    await event({ businessId: A1, orderId: 2004, type: "confirm", by: e.m3, at: "2026-10-04T23:59:59.999Z" }); // داخل عضويته
    await event({ businessId: A1, orderId: 2005, type: "confirm", by: e.m3, at: "2026-10-05T00:00:00Z" }); // لحظة الانتهاء = خارجها
    await event({ businessId: A1, orderId: 2006, type: "confirm", by: e.outsider, at: "2026-10-03T08:00:00Z" });
    await event({ businessId: A1, orderId: 2007, type: "no_answer", by: e.m1, at: "2026-10-03T10:00:00Z", backfill: "partial" });
    await event({ tenantId: B.tenantId, businessId: B.businessId, orderId: 2008, type: "confirm", by: e.mB, at: "2026-10-03T08:00:00Z" });
    // إعادة إسناد لاحقة لأوردر أكّده m1: التأكيد يبقى لـm1
    await event({ businessId: A1, orderId: 1000, type: "reassign", by: e.owner, assignee: e.m2, at: "2026-10-06T08:00:00Z" });

    const p1 = await (await portal(e.L1)).employeePortal.team.performance({ teamId: T1, ...RANGE });
    expect(p1.enabled).toBe(true);
    const rows1 = p1.enabled ? (p1 as any).rows : [];
    const by1 = new Map(rows1.map((r: any) => [r.employeeId, r]));
    expect([...by1.keys()].sort()).toEqual([e.m1, e.m2, e.m3].sort());
    expect(by1.get(e.m1)).toMatchObject({ decisionEligibleOrders: 20, confirmedOrders: 20, rankable: true, rank: 1, noAnswerOrders: 0 });
    expect(by1.get(e.m2)).toMatchObject({ decisionEligibleOrders: 1, confirmedOrders: 1, cancelledOrders: 0, rankable: false, rank: null, assignedOrders: 1 });
    expect(by1.get(e.m3)).toMatchObject({ decisionEligibleOrders: 1, confirmedOrders: 1 });

    const p2 = await (await portal(e.L2)).employeePortal.team.performance({ teamId: T2, ...RANGE });
    const rows2 = p2.enabled ? (p2 as any).rows : [];
    expect(rows2.map((r: any) => r.employeeId)).toEqual([e.m2]);
    expect(rows2[0]).toMatchObject({ decisionEligibleOrders: 2, confirmedOrders: 1, cancelledOrders: 1 });
  });

  it("المهام: لأعضاء الفريق الفعّالين أو عامة في نشاط الفريق؛ لا إسناد خارج الفريق؛ مهمة فريق آخر غير موجودة", async () => {
    const L1 = await portal(e.L1);
    const count = () => n("SELECT COUNT(*) n FROM tasks WHERE businessId IN (?, ?)", [A.businessId, farhat]);
    const before = await count();
    const mine = await L1.employeePortal.team.tasks.create({ teamId: T1, title: "اتصل بعملاء الأمس", assignedTo: e.m1, operationId: op() });
    const general = await L1.employeePortal.team.tasks.create({ teamId: T1, title: "مهمة عامة للفريق", operationId: op() });
    expect(Number((await q("SELECT businessId FROM tasks WHERE id = ?", [general.id]))[0].businessId)).toBe(A.businessId);
    // خارج الفريق / عضوية منتهية / شركة أخرى = مرفوض بلا كتابة (لا مهمة ولا سجل عملية)
    const ops = () => n("SELECT COUNT(*) n FROM team_task_operations WHERE tenantId = ?", [A.tenantId]);
    const opsBefore = await ops();
    for (const assignedTo of [e.outsider, e.m3, e.mB]) expect(await code(() => L1.employeePortal.team.tasks.create({ teamId: T1, title: "لا يجب أن تُنشأ", assignedTo, operationId: op() }))).toBe("FORBIDDEN");
    expect(await count()).toBe(before + 2); expect(await ops()).toBe(opsBefore);
    // مهام لا تخص الفريق
    const otherBiz = insId(await q("INSERT INTO tasks (businessId, title, assignedTo, createdBy, createdByName) VALUES (?, 'مهمة فرحات', ?, ?, 'x')", [farhat, e.m2, e.owner]));
    const outsiderTask = insId(await q("INSERT INTO tasks (businessId, title, assignedTo, createdBy, createdByName) VALUES (?, 'مهمة خارجية', ?, ?, 'x')", [A.businessId, e.outsider, e.owner]));
    const list = await L1.employeePortal.team.tasks.list({ teamId: T1 });
    const ids = list.enabled ? list.rows.map((t: any) => t.id) : [];
    expect(ids).toContain(mine.id); expect(ids).toContain(general.id);
    expect(ids).not.toContain(otherBiz); expect(ids).not.toContain(outsiderTask);
    expect(await code(() => L1.employeePortal.team.tasks.updateStatus({ teamId: T1, taskId: otherBiz, status: "done" }))).toBe("NOT_FOUND");
    expect(await code(() => L1.employeePortal.team.tasks.updateStatus({ teamId: T1, taskId: outsiderTask, status: "done" }))).toBe("FORBIDDEN");
    expect((await q("SELECT taskStatus s FROM tasks WHERE id IN (?, ?)", [otherBiz, outsiderTask])).map((r: any) => r.s)).toEqual(["new", "new"]);
    expect(await L1.employeePortal.team.tasks.updateStatus({ teamId: T1, taskId: mine.id, status: "in_progress" })).toMatchObject({ changed: true });
    expect(await L1.employeePortal.team.tasks.updateStatus({ teamId: T1, taskId: mine.id, status: "in_progress" })).toMatchObject({ changed: false });
    expect(await code(async () => (await portal(e.L2)).employeePortal.team.tasks.updateStatus({ teamId: T1, taskId: mine.id, status: "done" }))).toBe("FORBIDDEN");
  });

  it("المهام — Idempotency حتمية بـoperationId: ضغط متزامن = مهمة واحدة، عمليتان بنفس المحتوى = مهمتان، بصمة مختلفة = CONFLICT، والحذف لا يُعيد الإنشاء", async () => {
    const L1 = await portal(e.L1);
    const tasksCount = () => n("SELECT COUNT(*) n FROM tasks WHERE businessId = ?", [A.businessId]);
    const before = await tasksCount();
    const input = { teamId: T1, title: "راجع أوردرات اليوم", assignedTo: e.m2, operationId: op() };
    // (1) ضغط متزامن بنفس operationId (6 طلبات) ⇒ مهمة واحدة وسجل عملية واحد، والباقي Replay بنفس المهمة
    const burst = await Promise.all(Array.from({ length: 6 }, () => L1.employeePortal.team.tasks.create(input)));
    expect(new Set(burst.map(x => x.id)).size).toBe(1);
    expect(burst.filter(x => !x.replay)).toHaveLength(1);
    expect(await tasksCount()).toBe(before + 1);
    expect(await n("SELECT COUNT(*) n FROM team_task_operations WHERE tenantId = ? AND operationId = ?", [A.tenantId, input.operationId])).toBe(1);
    // (2) نفس المحتوى بعملية مختلفة ⇒ مهمة ثانية حقيقية (لا دمج بالمحتوى ولا بالوقت)
    const twin = await L1.employeePortal.team.tasks.create({ ...input, operationId: op() });
    expect(twin.replay).toBe(false); expect(twin.id).not.toBe(burst[0].id);
    expect(await tasksCount()).toBe(before + 2);
    // (3) نفس العملية ببيانات مختلفة ⇒ CONFLICT بلا كتابة
    expect(await code(() => L1.employeePortal.team.tasks.create({ ...input, title: "عنوان مختلف" }))).toBe("CONFLICT");
    expect(await code(() => L1.employeePortal.team.tasks.create({ ...input, assignedTo: e.m1 }))).toBe("CONFLICT");
    // (4) مفتاح عملية قائد آخر لا يكشف مهمته (نفس البصمة مستحيلة لفريق آخر، ونفس الفريق يتطلب القيادة)
    expect(await code(async () => (await portal(e.L2)).employeePortal.team.tasks.create({ ...input, teamId: T2, assignedTo: e.m2 }))).toBe("CONFLICT");
    expect(await tasksCount()).toBe(before + 2);
    // (5) حذف المهمة من المسار القديم ينجح، وسجل العملية يبقى (taskId = NULL)، والـReplay لا ينشئ بديلًا
    await q("DELETE FROM tasks WHERE id = ?", [burst[0].id]);
    expect((await q("SELECT taskId FROM team_task_operations WHERE tenantId = ? AND operationId = ?", [A.tenantId, input.operationId]))[0].taskId).toBeNull();
    expect(await code(() => L1.employeePortal.team.tasks.create(input))).toBe("NOT_FOUND");
    expect(await tasksCount()).toBe(before + 1);
  });

  it("المهام — الفاعل صريح: اسم القائد الصحيح من سجل العملية، وcreatedBy لا يحمل employeeId موجبًا؛ userId وemployeeId بنفس الرقم في شركتين لا يختلطان", async () => {
    const L1 = await portal(e.L1);
    const t = await L1.employeePortal.team.tasks.create({ teamId: T1, title: "مهمة لاختبار الفاعل", assignedTo: e.m1, operationId: op() });
    const [row] = await q("SELECT createdBy, createdByName FROM tasks WHERE id = ?", [t.id]);
    expect(Number(row.createdBy)).toBe(-e.L1); // عقد جلسة الإدارة القائم: السالب = موظف، لا users.id
    expect(row.createdByName).toBe("L1-ldr");
    expect((await q("SELECT actorEmployeeId FROM team_task_operations WHERE taskId = ?", [t.id]))[0].actorEmployeeId).toBe(e.L1);
    // مهمة قديمة في الشركة B أنشأها users.id يساوي رقم موظف القائد في A (تصادم أرقام مقصود)
    const legacyB = insId(await q("INSERT INTO tasks (businessId, title, assignedTo, createdBy, createdByName) VALUES (?, 'مهمة مستخدم B', ?, ?, 'مستخدم B')", [B.businessId, e.mB, e.L1]));
    // قراءة بالرقم الموجب تجد مهمة B وحدها — مهمة القائد لا تُفسَّر كـusers.id
    expect((await q("SELECT id FROM tasks WHERE createdBy = ?", [e.L1])).map((r: any) => r.id)).toEqual([legacyB]);
    // قائمة الفريق: المنشئ موظف باسمه الصحيح؛ ومهمة B غير ظاهرة
    const list = await L1.employeePortal.team.tasks.list({ teamId: T1 });
    const rows = list.enabled ? list.rows : [];
    expect(rows.find((r: any) => r.id === t.id)?.creator).toEqual({ kind: "employee", employeeId: e.L1, name: "L1-ldr" });
    expect(rows.some((r: any) => r.id === legacyB)).toBe(false);
    expect(rows.every((r: any) => !("createdBy" in r))).toBe(true); // لا يُعاد الرقم الخام الملتبس
    // مهمة قديمة في نشاط الفريق بلا سجل عملية = legacy باسمها المحفوظ فقط
    const legacyA = insId(await q("INSERT INTO tasks (businessId, title, assignedTo, createdBy, createdByName) VALUES (?, 'مهمة قديمة', ?, ?, 'المدير القديم')", [A.businessId, e.m1, e.L1]));
    const list2 = await L1.employeePortal.team.tasks.list({ teamId: T1 });
    expect((list2.enabled ? list2.rows : []).find((r: any) => r.id === legacyA)?.creator).toEqual({ kind: "legacy", name: "المدير القديم" });
    // مسارات المهام القديمة كما هي: مالك B يرى مهمته باسمها، ولا يرى مهمة القائد في A
    const ownerB = (await (await web(e.ownerB)).tasks.list({})) as any[];
    expect(ownerB.find(r => r.id === legacyB)?.createdByName).toBe("مستخدم B");
    expect(ownerB.some(r => r.id === t.id)).toBe(false);
    // ومالك A يرى مهمة القائد باسم القائد في المسار القديم (createdByName)
    const ownerA = (await (await web(e.owner)).tasks.list({})) as any[];
    expect(ownerA.find(r => r.id === t.id)?.createdByName).toBe("L1-ldr");
    expect(ownerA.some(r => r.id === legacyB)).toBe(false);
  });

  it("الأوردرات: كل أوردرات نشاط الفريق ومنها غير المسندة؛ الإسناد لعضو فعّال عبر سجل الأحداث مرة واحدة؛ خارج الفريق/النشاط مرفوض بلا كتابة", async () => {
    const un = await order(A.businessId), asg = await order(A.businessId, e.m1), fr = await order(farhat), ob = await order(B.businessId);
    const L1 = await portal(e.L1);
    const list = await L1.employeePortal.team.orders.list({ teamId: T1, limit: 100 });
    const ids = list.enabled ? (list as any).orders.map((o: any) => o.id) : [];
    expect(ids).toContain(un); expect(ids).toContain(asg);
    expect(ids).not.toContain(fr); expect(ids).not.toContain(ob);
    const unOnly = await L1.employeePortal.team.orders.list({ teamId: T1, unassignedOnly: true, limit: 100 });
    expect(unOnly.enabled && (unOnly as any).orders.every((o: any) => o.assignedEmployeeId == null)).toBe(true);

    const state = async (id: number) => ({
      assignee: (await q("SELECT assignedEmployeeId a FROM orders WHERE id = ?", [id]))[0].a,
      events: await n("SELECT COUNT(*) n FROM order_activity_events WHERE orderId = ? AND eventType IN ('assign','reassign')", [id]),
    });
    // خارج الفريق / عضوية منتهية / شركة أخرى ⇒ FORBIDDEN بلا كتابة؛ أوردر نشاط آخر ⇒ NOT_FOUND بلا كتابة
    for (const employeeId of [e.outsider, e.m3, e.mB]) expect(await code(() => L1.employeePortal.team.orders.assign({ teamId: T1, orderId: un, employeeId, operationId: op() }))).toBe("FORBIDDEN");
    expect(await code(() => L1.employeePortal.team.orders.assign({ teamId: T1, orderId: fr, employeeId: e.m2, operationId: op() }))).toBe("NOT_FOUND");
    expect(await code(() => L1.employeePortal.team.orders.assign({ teamId: T1, orderId: ob, employeeId: e.m1, operationId: op() }))).toBe("NOT_FOUND");
    expect(await code(async () => (await portal(e.L2)).employeePortal.team.orders.assign({ teamId: T1, orderId: un, employeeId: e.m1, operationId: op() }))).toBe("FORBIDDEN");
    expect(await state(un)).toEqual({ assignee: null, events: 0 });
    expect(await state(fr)).toEqual({ assignee: null, events: 0 });
    // الضغط المزدوج بنفس operationId ⇒ حدث واحد
    const o = op();
    await Promise.all([L1.employeePortal.team.orders.assign({ teamId: T1, orderId: un, employeeId: e.m2, operationId: o }), L1.employeePortal.team.orders.assign({ teamId: T1, orderId: un, employeeId: e.m2, operationId: o })]);
    expect(await state(un)).toEqual({ assignee: e.m2, events: 1 });
    const ev = (await q("SELECT eventType, actorEmployeeId, assigneeEmployeeIdAtEvent, businessId FROM order_activity_events WHERE orderId = ?", [un]))[0];
    expect(ev).toMatchObject({ eventType: "assign", actorEmployeeId: e.L1, assigneeEmployeeIdAtEvent: e.m2, businessId: A.businessId });
    // إعادة الإسناد لعضو آخر = reassign بلا تغيير حالة الأوردر
    const statusBefore = (await q("SELECT status FROM orders WHERE id = ?", [asg]))[0].status;
    await L1.employeePortal.team.orders.assign({ teamId: T1, orderId: asg, employeeId: e.m2, operationId: op() });
    expect(await state(asg)).toEqual({ assignee: e.m2, events: 1 });
    expect((await q("SELECT status FROM orders WHERE id = ?", [asg]))[0].status).toBe(statusBefore);
  });
});
