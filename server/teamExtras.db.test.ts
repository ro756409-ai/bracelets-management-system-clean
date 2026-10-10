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
import { WEEKDAYS } from "@shared/attendanceSpec";
import { csvSafeCell } from "@shared/employeePerformance";
import * as teams from "./teams.service";
import * as attendance from "./attendance.service";

/**
 * الإضافات الأربع المعتمدة (2026-10-11) على MySQL حقيقي: تحذيرات ورديات الأعضاء للمالك، ورديات الأعضاء للقائد،
 * سجل العضويات للقائد (أسماء بلا معرّفات)، وتصدير أداء الفريق CSV (صلاحيتان، نفس الشاشة، آمن من Formula Injection).
 * Tenant A/B، قائد لفريقين، فريق لا يقوده، سحب القيادة والصلاحية، بلا وردية/تعارض/ليلية، والأعلام المغلقة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `tx${Date.now().toString(36)}${++seq}xx`;
const Z = (iso: string) => new Date(iso).toISOString().replace("T", " ").replace("Z", "");
const FLAGS = ["TEAMS_ENABLED", "ATTENDANCE_ENABLED", "ORDER_EVENTS_ENABLED"] as const;
const ALL_DAYS = WEEKDAYS.map(d => d.key);
const RANGE = { dateFrom: "2026-10-01", dateTo: "2026-10-09" };
/** محلل CSV صغير (اقتباس مزدوج قياسي) للتحقق من مطابقة الشاشة. */
const parseCsv = (csv: string) => csv.replace(/^﻿/, "").split("\n").map(line => {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
});

describe.runIf(CAN)("🧩 إضافات الفرق المعتمدة", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const names: Record<string, string> = {};
  let A2 = 0, A3 = 0, T1 = 0, T2 = 0, T3 = 0, TB = 0;
  const saved: Record<string, string | undefined> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const grant = (role: string, permission: string, allowed: boolean) =>
    q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE isAllowed = VALUES(isAllowed)", [A.tenantId, role, permission, allowed ? 1 : 0, e.owner]);
  const ungrant = (role: string, permission: string) => q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = ? AND permission = ?", [A.tenantId, role, permission]);
  const owner = (tenantId: number, id: number): teams.TeamsActor => ({ tenantId, employeeId: id, role: "super_admin" });
  const add = (teamId: number, employeeId: number, tenantId = A.tenantId, ownerId = e.owner) => teams.addMember(owner(tenantId, ownerId), { teamId, employeeId, operationId: op() });
  const lead = async (teamId: number, employeeId: number, tenantId = A.tenantId, ownerId = e.owner) => { await add(teamId, employeeId, tenantId, ownerId); await teams.setLeader(owner(tenantId, ownerId), { teamId, employeeId, operationId: op() }); };
  let evSeq = 0;
  const event = (businessId: number, orderId: number, type: string, by: number, at: string, backfill?: "partial") =>
    q(`INSERT INTO order_activity_events (tenantId, businessId, orderId, orderNumberSnapshot, eventType, actorType, actorEmployeeId, attributedEmployeeId, source, backfillConfidence, idempotencyKey, payloadHash, occurredAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [A.tenantId, businessId, orderId, `N-${orderId}`, type, backfill ? "backfill" : "employee", backfill ? null : by, by, backfill ? "backfill" : "manual", backfill ?? null, `tx:ev${++evSeq}`, "f".repeat(64), Z(at)]);
  /** عضوية تاريخية بأوقات ثابتة (الخدمة لا تسمح بالتأريخ الرجعي) — لإسناد أحداث الأداء المؤرخة. */
  const rawMember = (teamId: number, employeeId: number, fromIso: string, toIso: string) => q(`INSERT INTO team_memberships (tenantId, teamId, employeeId, membershipRole, effectiveFromAt, effectiveToAt, assignedByEmployeeId, idempotencyKey, payloadHash, endedAt, endedByEmployeeId, endIdempotencyKey, endPayloadHash)
    VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [A.tenantId, teamId, employeeId, Z(fromIso), Z(toIso), e.owner, `rawextra:${++seq}xx`, "d".repeat(64), Z(toIso), e.owner, `rawextraend:${++seq}xx`, "d".repeat(64)]);

  beforeAll(async () => {
    tmp = await createTempSchema("team_extras");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"], [TEAMS_MIGRATION, "drizzle/0044_teams.sql", "0044"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    await tmp.raw.query("SET time_zone = '+00:00'");
    __setDbForTests(drizzle(tmp.url));
    for (const f of FLAGS) { saved[f] = process.env[f]; process.env[f] = "true"; }
    A = await createCoreTestFixture("tx-a"); B = await createCoreTestFixture("tx-b");
    const biz = async (nm: string) => insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [A.tenantId, nm, `${nm}-${tmp.name}`.slice(0, 50)]));
    A2 = await biz("farhat"); A3 = await biz("third");
    const mk = async (k: string, role: string, f: CoreTestFixture, name = `${k}-tx`) => { names[k] = name; e[k] = insId(await createEmployee({ name, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("owner", "super_admin", A, "المالكة سارة"); await mk("manager", "manager", A);
    await mk("L", "moderator", A, "القائد كريم"); await mk("L2", "moderator", A); await mk("outsider", "moderator", A);
    await mk("m1", "agent", A, "منى"); await mk("mNight", "agent", A, "نادية الليلية"); await mk("mConf", "agent", A, "سلمى المتعارضة");
    await mk("mNone", "agent", A, "هالة بلا وردية"); await mk("m2", "agent", A, "مها فرحات");
    await mk("evil", "agent", A, "=HYPERLINK(\"http://x\",\"اضغط\")"); await mk("evil2", "agent", A, "@SUM(1,2)");
    await mk("ownerB", "super_admin", B); await mk("LB", "moderator", B); await mk("mB", "agent", B);
    const oA = owner(A.tenantId, e.owner);
    const scope = [A.businessId, A2, A3];
    T1 = (await teams.createTeam(oA, { businessId: A.businessId, name: "فريق أفندي", operationId: op() }, scope)).id;
    T2 = (await teams.createTeam(oA, { businessId: A2, name: "+فريق فرحات", operationId: op() }, scope)).id;
    T3 = (await teams.createTeam(oA, { businessId: A3, name: "فريق ثالث", operationId: op() }, scope)).id;
    TB = (await teams.createTeam(owner(B.tenantId, e.ownerB), { businessId: B.businessId, name: "فريق B", operationId: op() }, [B.businessId])).id;
    // أعضاء T1 الحاليون + أعضاء تاريخيون لأحداث الأداء
    for (const k of ["m1", "mNight", "mConf", "mNone"]) await add(T1, e[k]);
    // أعضاء تاريخيون (مغلقون) في T1: evil/evil2 لأحداث الأداء، وm2 قبل انتقاله إلى T2
    await rawMember(T1, e.evil, "2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z"); await rawMember(T1, e.evil2, "2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z");
    await rawMember(T1, e.m2, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
    await add(T2, e.m2);
    await lead(T1, e.L); await lead(T2, e.L); // قائد لفريقين
    await lead(T3, e.L2); await lead(TB, e.LB, B.tenantId, e.ownerB); await add(TB, e.mB, B.tenantId, e.ownerB);
    // الورديات (منطق الحضور القائم): نهارية، ليلية، وتعارض تعيينين بنفس أعلى أولوية لنفس الموظف
    const aA: attendance.AttendanceActor = { tenantId: A.tenantId, employeeId: e.owner, role: "super_admin", businessId: A.businessId };
    const shift = (name: string, startTime: string, endTime: string) => attendance.createShift(aA, { name, businessId: null, startTime, endTime, workDays: [...ALL_DAYS], graceMinutes: 10, allowedBreakMinutes: 60, overtimeStartsAfterMinutes: 0, earlyClockInLimitMinutes: 60, earlyLeaveToleranceMinutes: 0, timezone: "Africa/Cairo", effectiveFrom: "2026-01-01", effectiveTo: null }, scope);
    const day = await shift("صباحي", "09:00", "17:00"), night = await shift("ليلي", "22:00", "06:00"), other = await shift("مسائي", "14:00", "22:00");
    const assign = (shiftId: number, employeeId: number, from = "2026-01-01") => attendance.assignShift(aA, { shiftId, targetType: "employee", employeeId, effectiveFrom: from }, scope);
    await assign(day.id, e.m1); await assign(night.id, e.mNight); await assign(day.id, e.mConf, "2026-01-01");
    // تعيين ثانٍ متداخل لنفس الموظف (بيانات قديمة/شاذة لا يسمح بها assignShift) ⇒ تعارض
    await q("INSERT INTO attendance_assignments (tenantId, shiftId, targetType, employeeId, effectiveFrom, assignedByEmployeeId) VALUES (?, ?, 'employee', ?, '2026-02-01', ?)", [A.tenantId, other.id, e.mConf, e.owner]);
    await assign(day.id, e.m2);
  }, 300_000);
  afterAll(async () => {
    for (const f of FLAGS) { if (saved[f] == null) delete process.env[f]; else process.env[f] = saved[f]; }
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("1) المالك: ورديات الأعضاء — بلا وردية / فعالة / ليلية / تعارض، بنفس منطق الحضور، بلا بيانات مالية، ونطاق الشركة", async () => {
    const r = await (await web(e.owner)).teams.memberShifts({ teamId: T1 });
    expect(r.enabled).toBe(true);
    const rows = r.enabled ? (r as any).members : [];
    const by = (k: string) => rows.find((m: any) => m.employeeId === e[k]);
    expect(rows.map((m: any) => m.employeeId).sort()).toEqual([e.m1, e.mNight, e.mConf, e.mNone, e.L].sort()); // الحاليون فقط (لا evil/m2 التاريخيين)
    expect(by("m1")).toMatchObject({ status: "active", shift: { name: "صباحي", startTime: "09:00", endTime: "17:00", crossesMidnight: false, timezone: "Africa/Cairo", worksOnDate: true }, conflictingShiftNames: [] });
    expect(by("m1").shift.workDays).toEqual([...ALL_DAYS]);
    expect(by("mNight")).toMatchObject({ status: "active", shift: { name: "ليلي", startTime: "22:00", endTime: "06:00", crossesMidnight: true } });
    expect(by("mNone")).toMatchObject({ status: "none", shift: null, conflictingShiftNames: [] });
    expect(by("mConf").status).toBe("conflict");
    expect([...by("mConf").conflictingShiftNames].sort()).toEqual(["صباحي", "مسائي"]);
    // نفس منطق الحضور حرفيًا: الوردية المعروضة = ما يطبّقه الحضور فعلًا عند التسجيل
    const workDate = (r as any).workDate as string;
    await (await web(e.owner)).attendance.adminCorrect({ employeeId: e.mConf, workDate, punchType: "clock_in", at: new Date().toISOString(), reason: "تحقق المنطق", operationId: op() });
    const [d] = await q("SELECT s.name FROM attendance_days d JOIN attendance_shifts s ON s.id = d.shiftId WHERE d.employeeId = ? AND d.workDate = ?", [e.mConf, workDate]);
    expect(by("mConf").shift.name).toBe(d.name);
    // لا بيانات مالية ولا حقول زائدة
    expect(Object.keys(by("m1")).sort()).toEqual(["conflictingShiftNames", "employeeId", "employeeName", "membershipRole", "shift", "status"]);
    expect(Object.keys(by("m1").shift).sort()).toEqual(["crossesMidnight", "endTime", "name", "startTime", "timezone", "workDays", "worksOnDate"]);
    expect(JSON.stringify(r)).not.toMatch(/salary|cost|wage|price|amount|راتب/i);
    // شركة أخرى = غير موجود؛ المدير بلا منح = مرفوض
    expect(await code(async () => (await web(e.ownerB)).teams.memberShifts({ teamId: T1 }))).toBe("NOT_FOUND");
    expect(await code(async () => (await web(e.manager)).teams.memberShifts({ teamId: T1 }))).toBe("FORBIDDEN");
    expect(await code(async () => (await web(e.owner)).teams.memberShifts({ teamId: T1, tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
  });

  it("2) القائد: ورديات أعضاء فريقه الحالي فقط (قائد لفريقين يرى كل فريق بأعضائه)، وفريق لا يقوده = FORBIDDEN", async () => {
    const t1 = await (await portal(e.L)).employeePortal.team.memberShifts({ teamId: T1 });
    const t2 = await (await portal(e.L)).employeePortal.team.memberShifts({ teamId: T2 });
    expect(t1.enabled && (t1 as any).members.map((m: any) => m.employeeId).sort()).toEqual([e.m1, e.mNight, e.mConf, e.mNone, e.L].sort());
    expect(t2.enabled && (t2 as any).members.map((m: any) => m.employeeId).sort()).toEqual([e.m2, e.L].sort());
    expect(t2.enabled && (t2 as any).members.find((m: any) => m.employeeId === e.m2).shift.name).toBe("صباحي");
    expect(await code(async () => (await portal(e.L2)).employeePortal.team.memberShifts({ teamId: T1 }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.outsider)).employeePortal.team.memberShifts({ teamId: T1 }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.LB)).employeePortal.team.memberShifts({ teamId: T1 }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.m1)).employeePortal.team.memberShifts({ teamId: T1 }))).toBe("FORBIDDEN"); // agent بلا صلاحية
  });

  it("3) سجل القائد: الفريق الحالي كاملًا بالأسماء (من أضاف/أنهى)، بلا معرّفات خام أو username، ولا تسريب لفريق آخر", async () => {
    // إنهاء عضوية للتحقق من اسم المنهي
    const mNoneRow = (await q("SELECT id FROM team_memberships WHERE teamId = ? AND employeeId = ? AND effectiveToAt IS NULL", [T1, e.mNone]))[0].id;
    await teams.endMembership(owner(A.tenantId, e.owner), { membershipId: mNoneRow, operationId: op() });
    const h = await (await portal(e.L)).employeePortal.team.history({ teamId: T1 });
    expect(h.enabled).toBe(true);
    const rows = h.enabled ? (h as any).history : [];
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["addedByName", "endedByName", "fromMs", "memberName", "membershipRole", "toMs"]);
    const ended = rows.find((r: any) => r.memberName === names.mNone);
    expect(ended).toMatchObject({ membershipRole: "member", addedByName: "المالكة سارة", endedByName: "المالكة سارة" });
    expect(ended.toMs).toBeGreaterThan(ended.fromMs);
    expect(rows.find((r: any) => r.memberName === names.L && r.membershipRole === "leader")).toMatchObject({ toMs: null, endedByName: null });
    expect(rows.some((r: any) => r.memberName === names.m2)).toBe(true); // عضوية T1 التاريخية المنتهية لـm2 تظهر في سجل T1
    const json = JSON.stringify(h);
    expect(json).not.toMatch(/"[A-Za-z]*Id"|username|password/);
    for (const k of Object.keys(e)) expect(json).not.toContain(`${k}_${tmp.name}`.slice(0, 50));
    // لا تسريب: سجل T2 لا يحتوي أعضاء T1 فقط
    const h2 = await (await portal(e.L)).employeePortal.team.history({ teamId: T2 });
    const n2 = h2.enabled ? (h2 as any).history.map((r: any) => r.memberName) : [];
    expect(n2).toContain(names.m2); expect(n2).not.toContain(names.m1); expect(n2).not.toContain(names.mNone);
    expect(await code(async () => (await portal(e.L2)).employeePortal.team.history({ teamId: T1 }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.LB)).employeePortal.team.history({ teamId: T1 }))).toBe("FORBIDDEN");
    // المالك ما زال يرى التاريخ الكامل بمعرّفاته من teams.history
    const oh = await (await web(e.owner)).teams.history({ teamId: T1 });
    expect(oh.enabled && (oh as any).history.every((r: any) => typeof r.employeeId === "number")).toBe(true);
  });

  it("4) التصدير: الصلاحيتان معًا، يطابق الشاشة حرفيًا، لا ترتيب تحت 20، بلا Backfill جزئي، وآمن من Formula Injection", async () => {
    for (let i = 0; i < 20; i++) await event(A.businessId, 5000 + i, "confirm", e.m1, "2026-10-03T08:00:00Z");
    await event(A.businessId, 6001, "confirm", e.evil, "2026-10-03T08:00:00Z");
    await event(A.businessId, 6002, "cancel", e.evil2, "2026-10-03T08:00:00Z");
    await event(A.businessId, 6003, "no_answer", e.m1, "2026-10-03T09:00:00Z", "partial");
    await event(A2, 6004, "confirm", e.m1, "2026-10-03T08:00:00Z"); // نشاط آخر لا يُحسب في T1
    // m1 عضو T1 من الآن فقط (بالخدمة) ⇒ نضيف عضوية تاريخية مغلقة تغطي أحداثه
    await rawMember(T1, e.m1, "2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z");
    const L = await portal(e.L);
    // team_performance.view وحدها لا تكفي
    expect(await code(() => L.employeePortal.team.performanceCsv({ teamId: T1, ...RANGE }))).toBe("FORBIDDEN");
    await grant("moderator", "employee_performance.export", true);
    try {
      const screen = await L.employeePortal.team.performance({ teamId: T1, ...RANGE });
      const out = await L.employeePortal.team.performanceCsv({ teamId: T1, ...RANGE });
      expect(screen.enabled && out.enabled).toBe(true);
      const sRows = screen.enabled ? (screen as any).rows : [];
      const csv = out.enabled ? (out as any).csv as string : "";
      expect(out.enabled && (out as any).filename).toBe("team-performance-2026-10-01_2026-10-09.csv");
      const lines = parseCsv(csv);
      expect(lines[0]).toEqual(["الفريق", "فريق أفندي"]);
      expect(lines[1]).toEqual(["الفترة", "2026-10-01 إلى 2026-10-09", "المنطقة الزمنية", "Africa/Cairo", "حد الترتيب (قرارات)", "20"]);
      expect(lines[3][0]).toBe("الموظف");
      const body = lines.slice(4).filter(l => l.length > 1);
      expect(body).toHaveLength(sRows.length);
      // مطابقة الشاشة: كل صف بنفس الأرقام، والاسم الخطر مسبوق بـ'
      for (const r of sRows) {
        const cells = body.find(l => l[0] === r.employeeName || l[0] === `'${r.employeeName}`)!;
        expect(cells, r.employeeName).toBeTruthy();
        expect(cells.slice(1).map(String)).toEqual([r.decisionEligibleOrders, r.confirmedOrders, r.confirmationRate ?? "", r.noAnswerOrders, r.noAnswerAttempts, r.postponedOrders, r.cancelledOrders, r.workloadOrders, r.assignedOrders, r.activeDays, r.rank ?? "عينة أقل من الحد"].map(String));
      }
      const m1 = sRows.find((r: any) => r.employeeId === e.m1);
      expect(m1).toMatchObject({ decisionEligibleOrders: 20, rank: 1, noAnswerOrders: 0 }); // بلا Backfill جزئي، وبلا حدث نشاط آخر
      expect(sRows.filter((r: any) => r.decisionEligibleOrders < 20).every((r: any) => r.rank === null)).toBe(true);
      // Formula Injection: لا خلية نصية تبدأ بـ= + - @
      for (const l of lines) for (const c of l) if (c && Number.isNaN(Number(c))) expect(c, c).not.toMatch(/^\s*[=+\-@]/);
      expect(body.some(l => l[0] === `'=HYPERLINK("http://x","اضغط")`)).toBe(true);
      expect(body.some(l => l[0] === "'@SUM(1,2)")).toBe(true);
      expect(csvSafeCell("+فريق")).toBe("'+فريق"); expect(csvSafeCell(-5)).toBe("-5"); expect(csvSafeCell("\t=1")).toBe("'\t=1");
      // T2 اسمه يبدأ بـ+ ⇒ خلية الرأس آمنة
      const t2 = await L.employeePortal.team.performanceCsv({ teamId: T2, ...RANGE });
      expect(t2.enabled && parseCsv((t2 as any).csv)[0]).toEqual(["الفريق", "'+فريق فرحات"]);
      // سحب team_performance.view يمنع رغم export
      await grant("moderator", "team_performance.view", false);
      expect(await code(() => L.employeePortal.team.performanceCsv({ teamId: T1, ...RANGE }))).toBe("FORBIDDEN");
      await ungrant("moderator", "team_performance.view");
      expect(await code(async () => (await portal(e.L2)).employeePortal.team.performanceCsv({ teamId: T1, ...RANGE }))).toBe("FORBIDDEN");
      expect(await code(async () => (await portal(e.outsider)).employeePortal.team.performanceCsv({ teamId: T1, ...RANGE }))).toBe("FORBIDDEN");
    } finally { await ungrant("moderator", "employee_performance.export"); await ungrant("moderator", "team_performance.view"); }
  });

  it("الأعلام المغلقة: لا بيانات (enabled:false) لكل الإضافات", async () => {
    await grant("moderator", "employee_performance.export", true);
    try {
      process.env.TEAMS_ENABLED = "false";
      expect(await (await web(e.owner)).teams.memberShifts({ teamId: T1 })).toEqual({ enabled: false });
      expect(await (await portal(e.L)).employeePortal.team.memberShifts({ teamId: T1 })).toEqual({ enabled: false });
      expect(await (await portal(e.L)).employeePortal.team.history({ teamId: T1 })).toEqual({ enabled: false });
      expect(await (await portal(e.L)).employeePortal.team.performanceCsv({ teamId: T1, ...RANGE })).toEqual({ enabled: false });
      process.env.TEAMS_ENABLED = "true"; process.env.ATTENDANCE_ENABLED = "false";
      expect(await (await web(e.owner)).teams.memberShifts({ teamId: T1 })).toEqual({ enabled: false });
      expect(await (await portal(e.L)).employeePortal.team.memberShifts({ teamId: T1 })).toEqual({ enabled: false });
      process.env.ATTENDANCE_ENABLED = "true"; process.env.ORDER_EVENTS_ENABLED = "false";
      expect(await (await portal(e.L)).employeePortal.team.performanceCsv({ teamId: T1, ...RANGE })).toEqual({ enabled: false });
    } finally { for (const f of FLAGS) process.env[f] = "true"; await ungrant("moderator", "employee_performance.export"); }
  });

  it("سحب القيادة/الصلاحية يمنع من الطلب التالي؛ والقائد لفريقين يحتفظ بالآخر", async () => {
    await grant("moderator", "teams.view_own", false);
    try { expect(await code(async () => (await portal(e.L)).employeePortal.team.history({ teamId: T1 }))).toBe("FORBIDDEN"); }
    finally { await ungrant("moderator", "teams.view_own"); }
    await grant("moderator", "team_attendance.view", false);
    try { expect(await code(async () => (await portal(e.L)).employeePortal.team.memberShifts({ teamId: T1 }))).toBe("FORBIDDEN"); }
    finally { await ungrant("moderator", "team_attendance.view"); }
    await teams.endLeadership(owner(A.tenantId, e.owner), { teamId: T1, operationId: op() });
    expect(await code(async () => (await portal(e.L)).employeePortal.team.memberShifts({ teamId: T1 }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.L)).employeePortal.team.history({ teamId: T1 }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.L)).employeePortal.team.history({ teamId: T2 }))).toBe("ok");
    expect(await code(async () => (await portal(e.L)).employeePortal.team.memberShifts({ teamId: T2 }))).toBe("ok");
  });
});
