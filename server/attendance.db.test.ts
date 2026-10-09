import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { __setDbForTests, createEmployee } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { openReadOnlyExecutor } from "./balanceReconciliation.service";
import * as att from "./attendance.service";
import { businessDateKey } from "../shared/businessTime";

/**
 * خدمات الحضور على قاعدة Docker مؤقتة (نسخة المخطط + 0041 + 0042): العلم/الجداول، الورديات، التعيينات
 * (تداخل ومتزامن وأولوية)، التسجيل (تسلسل، Double-click، تزامن، معطّل)، التصحيح والمراجعة، العزل، UTC، Reconcile،
 * ولا كتابة Payroll/Ledger.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const op = () => `op${Math.random().toString(36).slice(2, 14)}`;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? e?.name ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const pad = (n: number) => String(n).padStart(2, "0");

describe("🔒 الحضور — حراس نصّية", () => {
  // الكود فقط (بلا التعليقات التي تذكر ما هو ممنوع)
  const src = fs.readFileSync("server/attendance.service.ts", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("لا كتابة على payroll/ledger ولا UPDATE/DELETE على attendance_events", () => {
    expect(src).not.toMatch(/payroll_|ledger_|employee_salary/i);
    expect(src).not.toMatch(/UPDATE attendance_events|DELETE FROM attendance_/);
  });
  it("كل معاملة حضور تضبط UTC وتتحقق من الجداول", () => {
    expect(src).toContain("SET time_zone = '+00:00'");
    expect(src).toContain("assertAttendanceReady(tx)");
  });
});

describe.runIf(CAN)("🕒 خدمات الحضور", () => {
  let tmp: TempSchema, bare: TempSchema;
  let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const saved = process.env.ATTENDANCE_ENABLED;
  const actor = (key: string, f: CoreTestFixture, role = "agent") => ({ tenantId: f.tenantId, employeeId: emp[key], role, businessId: f.businessId });
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  let nowCairo: { date: string; hour: number; minute: number };

  beforeAll(async () => {
    tmp = await createTempSchema("att_s"); bare = await createTempSchema("att_bare");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("att-a"); B = await createCoreTestFixture("att-b");
    const mk = async (key: string, role: string, f: CoreTestFixture, active = true) => { emp[key] = insId(await createEmployee({ name: `${key}-att`, role, isActive: active, tenantId: f.tenantId, businessId: f.businessId, username: `${key}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("e1", "agent", A); await mk("e2", "agent", A); await mk("e3", "warehouse", A); await mk("boss", "super_admin", A); await mk("off", "agent", A, false); await mk("eb", "agent", B);
    const [[t]] = (await tmp.raw.query("SELECT UNIX_TIMESTAMP(NOW(3)) * 1000 AS ms")) as any;
    const d = new Date(Number(t.ms));
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
    nowCairo = { date: businessDateKey(d, "Africa/Cairo"), hour: Number(parts.find(p => p.type === "hour")!.value), minute: Number(parts.find(p => p.type === "minute")!.value) };
    process.env.ATTENDANCE_ENABLED = "true";
  }, 240_000);

  afterAll(async () => {
    if (saved == null) delete process.env.ATTENDANCE_ENABLED; else process.env.ATTENDANCE_ENABLED = saved;
    __setDbForTests(null);
    await tmp?.drop(); await bare?.drop();
  }, 120_000);

  const shiftAroundNow = (name: string, extra: Record<string, unknown> = {}) => {
    const sh = (nowCairo.hour + 23) % 24, eh = (nowCairo.hour + 6) % 24;
    return { name, businessId: null, startTime: `${pad(sh)}:00`, endTime: `${pad(eh)}:00`, workDays: ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as any, graceMinutes: 10, allowedBreakMinutes: 60, overtimeStartsAfterMinutes: 30, earlyClockInLimitMinutes: 60, earlyLeaveToleranceMinutes: 0, timezone: "Africa/Cairo", effectiveFrom: "2026-01-01", effectiveTo: null, ...extra };
  };

  it("العلم معطل: رفض قبل أي وصول للقاعدة؛ مفعّل والجداول غائبة: PRECONDITION_FAILED", async () => {
    process.env.ATTENDANCE_ENABLED = "false";
    expect(await code(() => att.listShifts(A.tenantId))).toBe("PRECONDITION_FAILED");
    process.env.ATTENDANCE_ENABLED = "true";
    __setDbForTests(drizzle(bare.url));
    try { expect(await code(() => att.listShifts(1))).toBe("PRECONDITION_FAILED"); }
    finally { __setDbForTests(drizzle(tmp.url)); }
  });

  it("كل معاملة حضور بـtime_zone = +00:00", async () => {
    const tz = await att.runAttendanceTx(async tx => { const r: any = await tx.execute(sql`SELECT @@session.time_zone AS tz`); return (Array.isArray(r) ? r[0] : r)[0].tz; });
    expect(tz).toBe("+00:00");
  });

  it("الورديات: تحقق المدخلات، الليلية، النطاق، والقفل التفاؤلي", async () => {
    const a = actor("boss", A, "super_admin");
    expect(await code(() => att.createShift(a, { ...shiftAroundNow("x"), workDays: [] }, [A.businessId]))).not.toBe("ok");
    expect(await code(() => att.createShift(a, { ...shiftAroundNow("x"), startTime: "10:00", endTime: "10:00" }, [A.businessId]))).toBe("BAD_REQUEST");
    expect(await code(() => att.createShift(a, { ...shiftAroundNow("x"), businessId: B.businessId }, [A.businessId]))).toBe("FORBIDDEN");
    expect(await code(() => att.createShift(a, { ...shiftAroundNow("x"), timezone: "Mars/Base" }, [A.businessId]))).not.toBe("ok");
    const night = await att.createShift(a, { ...shiftAroundNow("ليلي"), startTime: "22:00", endTime: "06:00" }, [A.businessId]);
    expect(night.crossesMidnight).toBe(true);
    const s = await att.createShift(a, shiftAroundNow("مثال 11–18", { startTime: "11:00", endTime: "18:00" }), [A.businessId]);
    const [row] = await q("SELECT workDaysMask, crossesMidnight, version FROM attendance_shifts WHERE id = ?", [s.id]);
    expect(Number(row.workDaysMask)).toBe(127); expect(Number(row.crossesMidnight)).toBe(0);
    const upd = await att.updateShift(a, s.id, 1, shiftAroundNow("مثال 11–18 معدل", { startTime: "11:00", endTime: "18:00" }), [A.businessId]);
    expect(upd.version).toBe(2);
    expect(await code(() => att.updateShift(a, s.id, 1, shiftAroundNow("قديم", { startTime: "11:00", endTime: "18:00" }), [A.businessId]))).toBe("CONFLICT");
    expect(await code(() => att.updateShift(actor("eb", B), s.id, 2, shiftAroundNow("B"), [B.businessId]))).toBe("NOT_FOUND");
  });

  it("التعيينات: رفض التداخل، الاستبدال في نفس المعاملة، وطلبان متزامنان متداخلان = واحد فقط", async () => {
    const a = actor("boss", A, "super_admin");
    const s1 = await att.createShift(a, shiftAroundNow("s1"), [A.businessId]);
    const s2 = await att.createShift(a, shiftAroundNow("s2"), [A.businessId]);
    await att.assignShift(a, { shiftId: s1.id, targetType: "role", role: "warehouse", businessId: A.businessId, effectiveFrom: "2026-01-01" }, [A.businessId]);
    expect(await code(() => att.assignShift(a, { shiftId: s2.id, targetType: "role", role: "warehouse", businessId: A.businessId, effectiveFrom: "2026-06-01" }, [A.businessId]))).toBe("CONFLICT");
    const rep = await att.assignShift(a, { shiftId: s2.id, targetType: "role", role: "warehouse", businessId: A.businessId, effectiveFrom: "2026-06-01", replaceExisting: true }, [A.businessId]);
    expect(rep.replaced).toBe(1);
    const old = await q("SELECT DATE_FORMAT(effectiveTo, '%Y-%m-%d') t FROM attendance_assignments WHERE tenantId = ? AND shiftId = ?", [A.tenantId, s1.id]);
    expect(old[0].t).toBe("2026-05-31");
    const results = await Promise.allSettled([
      att.assignShift(a, { shiftId: s1.id, targetType: "employee", employeeId: emp.e2, effectiveFrom: "2026-01-01" }, [A.businessId]),
      att.assignShift(a, { shiftId: s2.id, targetType: "employee", employeeId: emp.e2, effectiveFrom: "2026-03-01" }, [A.businessId]),
    ]);
    expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("CONFLICT");
    expect(await code(() => att.assignShift(a, { shiftId: s1.id, targetType: "employee", employeeId: emp.eb, effectiveFrom: "2026-01-01" }, [A.businessId]))).toBe("FORBIDDEN");
  });

  it("التسجيل: تسلسل كامل، Double-click متزامن = حدث واحد، وتسلسل خاطئ مرفوض", async () => {
    const boss = actor("boss", A, "super_admin");
    const sh = await att.createShift(boss, shiftAroundNow("e1-shift"), [A.businessId]);
    await att.assignShift(boss, { shiftId: sh.id, targetType: "employee", employeeId: emp.e1, effectiveFrom: "2026-01-01" }, [A.businessId]);
    const me = actor("e1", A);
    expect(await code(() => att.clock(me, "clock_out", op()))).toBe("CONFLICT");
    const id = op();
    const r = await Promise.allSettled([att.clock(me, "clock_in", id), att.clock(me, "clock_in", id)]);
    expect(r.map(x => x.status === "fulfilled" ? "ok" : String((x as any).reason?.code ?? (x as any).reason?.message))).toEqual(["ok", "ok"]);
    expect(Number((await q("SELECT COUNT(*) n FROM attendance_events WHERE employeeId = ? AND eventType = 'clock_in'", [emp.e1]))[0].n)).toBe(1);
    const [day] = await q("SELECT id, DATE_FORMAT(workDate, '%Y-%m-%d') wd, shiftId, shiftSnapshotJson IS NOT NULL snap FROM attendance_days WHERE employeeId = ?", [emp.e1]);
    expect(Number(day.shiftId)).toBe(sh.id); expect(Number(day.snap)).toBe(1);
    expect(await code(() => att.clock(me, "clock_in", op()))).toBe("CONFLICT");
    expect(await code(() => att.clock(me, "break_end", op()))).toBe("CONFLICT");
    await att.clock(me, "break_start", op());
    expect(await code(() => att.clock(me, "clock_out", op()))).toBe("CONFLICT");
    await att.clock(me, "break_end", op());
    const out = await att.clock(me, "clock_out", op());
    expect(out.day.status).toBe("closed");
    expect(await code(() => att.clock(me, "clock_in", id + "x"))).toBe("CONFLICT"); // اليوم مُغلق
    // إعادة نفس عملية الحضور بعد إغلاق اليوم = Replay بلا حدث جديد (المفتاح يحدد الفعل، فلا «نفس المفتاح بطلب مختلف» هنا؛
    // حالة Conflict مغطاة في طلبات التصحيح)
    expect((await att.clock(me, "clock_in", id)).replay).toBe(true);
    expect(Number((await q("SELECT COUNT(*) n FROM attendance_events WHERE employeeId = ? AND eventType = 'clock_in'", [emp.e1]))[0].n)).toBe(1);
  });

  it("طلبان متزامنان بمعرّفين مختلفين لنفس الموظف = حضور واحد صحيح", async () => {
    const me = actor("e2", A);
    const r = await Promise.allSettled([att.clock(me, "clock_in", op()), att.clock(me, "clock_in", op())]);
    expect(r.filter(x => x.status === "fulfilled").length).toBe(1);
    expect(Number((await q("SELECT COUNT(*) n FROM attendance_events WHERE employeeId = ? AND eventType = 'clock_in'", [emp.e2]))[0].n)).toBe(1);
  });

  it("الموظف المعطّل مرفوض، والهوية من tenant الجلسة فقط", async () => {
    expect(await code(() => att.clock(actor("off", A), "clock_in", op()))).toBe("FORBIDDEN");
    expect(await code(() => att.clock({ tenantId: B.tenantId, employeeId: emp.e1, role: "agent", businessId: B.businessId }, "clock_in", op()))).toBe("FORBIDDEN");
  });

  it("طلب التصحيح والمراجعة: Zod صارم، لا مراجعة ذاتية، رفض بسبب، اعتماد يعيد حساب اليوم", async () => {
    const me = actor("e3", A, "warehouse");
    const boss = actor("boss", A, "super_admin");
    await att.clock(me, "clock_in", op());
    const day = (await q("SELECT DATE_FORMAT(workDate, '%Y-%m-%d') wd FROM attendance_days WHERE employeeId = ?", [emp.e3]))[0].wd;
    const outAt = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(await code(() => att.requestCorrection(me, { workDate: day, requestType: "missing_clock_out", requestedValue: { at: outAt, extra: 1 }, reason: "نسيت الانصراف", operationId: op() }))).toBe("BAD_REQUEST");
    const e2Event = Number((await q("SELECT id FROM attendance_events WHERE employeeId = ? LIMIT 1", [emp.e2]))[0].id);
    expect(await code(() => att.requestCorrection(me, { workDate: day, requestType: "wrong_time", targetEventId: e2Event, requestedValue: { at: outAt }, reason: "خطأ", operationId: op() }))).toBe("FORBIDDEN");
    const reqOp = op();
    const r1 = await att.requestCorrection(me, { workDate: day, requestType: "missing_clock_out", requestedValue: { at: outAt }, reason: "نسيت الانصراف", operationId: reqOp });
    expect((await att.requestCorrection(me, { workDate: day, requestType: "missing_clock_out", requestedValue: { at: outAt }, reason: "نسيت الانصراف", operationId: reqOp })).replay).toBe(true);
    expect(await code(() => att.requestCorrection(me, { workDate: day, requestType: "missing_clock_out", requestedValue: { at: outAt }, reason: "سبب آخر", operationId: reqOp }))).toBe("CONFLICT");
    const perms = { approveCorrections: true, manageLeaves: false };
    expect(await code(() => att.reviewCorrection(me, { requestId: r1.id, decision: "approve" }, perms, [A.businessId]))).toBe("FORBIDDEN"); // مراجعة ذاتية
    expect(await code(() => att.reviewCorrection(boss, { requestId: r1.id, decision: "reject", reviewReason: "" }, perms, [A.businessId]))).toBe("BAD_REQUEST");
    expect(await code(() => att.reviewCorrection(boss, { requestId: r1.id, decision: "approve" }, { approveCorrections: false, manageLeaves: true }, [A.businessId]))).toBe("FORBIDDEN");
    await att.reviewCorrection(boss, { requestId: r1.id, decision: "approve" }, perms, [A.businessId]);
    const [d] = await q("SELECT status, UNIX_TIMESTAMP(lastOutAt) * 1000 AS outMs FROM attendance_days WHERE employeeId = ?", [emp.e3]);
    expect(d.status).toBe("closed"); expect(Math.abs(Number(d.outMs) - Date.parse(outAt))).toBeLessThan(1000);
    expect(await code(() => att.reviewCorrection(boss, { requestId: r1.id, decision: "approve" }, perms, [A.businessId]))).toBe("CONFLICT");
    // إجازة: تحتاج manage_leaves
    const lv = await att.requestCorrection(me, { workDate: "2026-12-20", requestType: "absence_to_leave", requestedValue: {}, reason: "إجازة عارضة", operationId: op() });
    expect(await code(() => att.reviewCorrection(boss, { requestId: lv.id, decision: "approve" }, perms, [A.businessId]))).toBe("FORBIDDEN");
    await att.reviewCorrection(boss, { requestId: lv.id, decision: "approve" }, { approveCorrections: false, manageLeaves: true }, [A.businessId]);
    expect((await q("SELECT status FROM attendance_days WHERE employeeId = ? AND workDate = '2026-12-20'", [emp.e3]))[0].status).toBe("leave");
    // من tenant آخر: الطلب غير موجود
    expect(await code(() => att.reviewCorrection(actor("eb", B), { requestId: lv.id, decision: "reject", reviewReason: "x y z" }, perms, [B.businessId]))).toBe("NOT_FOUND");
  });

  it("التصحيح الإداري: سبب إلزامي، لا تصحيح ذاتي، ولا حدث موظف آخر", async () => {
    const boss = actor("boss", A, "super_admin");
    expect(await code(() => att.adminCorrect(boss, { employeeId: emp.e2, workDate: nowCairo.date, eventType: "clock_out", at: new Date().toISOString(), reason: " ", operationId: op() }, [A.businessId]))).toBe("BAD_REQUEST");
    expect(await code(() => att.adminCorrect(boss, { employeeId: emp.boss, workDate: nowCairo.date, eventType: "clock_out", at: new Date().toISOString(), reason: "سبب واضح", operationId: op() }, [A.businessId]))).toBe("FORBIDDEN");
    const e1Event = Number((await q("SELECT id FROM attendance_events WHERE employeeId = ? LIMIT 1", [emp.e1]))[0].id);
    expect(await code(() => att.adminCorrect(boss, { employeeId: emp.e2, workDate: nowCairo.date, eventType: "clock_in", correctionOfEventId: e1Event, at: new Date().toISOString(), reason: "سبب واضح", operationId: op() }, [A.businessId]))).toBe("FORBIDDEN");
    const r = await att.adminCorrect(boss, { employeeId: emp.e2, workDate: nowCairo.date, eventType: "clock_out", at: new Date(Date.now() + 5 * 60_000).toISOString(), reason: "نسي الانصراف", operationId: op() }, [A.businessId]);
    expect(r.projection?.status).toBe("closed");
  });

  it("Reconcile قراءة فقط: يطابق بعد كل العمليات، ويكشف العبث بـworkedMinutes", async () => {
    const ro = await openReadOnlyExecutor(tmp.url);
    try {
      const ok = await att.reconcileAttendance(ro, A.tenantId);
      expect(ok.checked).toBeGreaterThan(0);
      expect(ok.mismatches).toEqual([]);
      await q("UPDATE attendance_days SET workedMinutes = workedMinutes + 99 WHERE employeeId = ? LIMIT 1", [emp.e1]); // عبث متعمّد في قاعدة اختبار مؤقتة
      const bad = await att.reconcileAttendance(ro, A.tenantId);
      expect(bad.mismatches.some(m => m.field === "workedMinutes" && m.employeeId === emp.e1)).toBe(true);
      await expect(ro.query("UPDATE attendance_days SET workedMinutes = 0")).rejects.toThrow(/non-SELECT/);
    } finally { await ro.close(); }
  });

  it("لا كتابة Payroll/Ledger: صفر صفوف في جداول الرواتب والدفتر لهذه الشركات", async () => {
    const tables = (await q("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'payroll%' OR TABLE_NAME LIKE 'employee_salary%' OR TABLE_NAME LIKE 'ledger_%')")).map((r: any) => r.t);
    for (const t of tables) {
      const cols = (await q("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN ('businessId','tenantId')", [t])).map((r: any) => r.c);
      if (cols.includes("businessId")) expect(Number((await q(`SELECT COUNT(*) n FROM \`${t}\` WHERE businessId IN (?, ?)`, [A.businessId, B.businessId]))[0].n), t).toBe(0);
      else if (cols.includes("tenantId")) expect(Number((await q(`SELECT COUNT(*) n FROM \`${t}\` WHERE tenantId IN (?, ?)`, [A.tenantId, B.tenantId]))[0].n), t).toBe(0);
    }
  });
});
