import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { runHandMigration, confirmPhrase, describeStatements } from "./handMigration.service";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { maskFromDays, daysFromMask, isWorkDay, WEEKDAYS } from "../shared/attendanceSpec";

/**
 * Migration 0042 على قواعد Docker محلية مؤقتة: يشترط الفهرسين → apply بعد 0041 → verify → replay →
 * كل FK ثلاثي (لا ربط بيوم/طلب/حدث موظف آخر) → CHECK الفاعل بكل التركيبات → قيود الوردية/المراجعة/التعيين →
 * rollback قبل الاستخدام (يُسقط FK اللاحق أولًا) ويرفض مع بيانات → partial يرفض.
 */
const SQL42 = fs.readFileSync("drizzle/0042_attendance.sql", "utf-8");
const SQL41 = fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const run = (db: TempSchema, mode: "check" | "apply" | "rollback", extra: Record<string, unknown> = {}) =>
  runHandMigration(ATTENDANCE_MIGRATION, { databaseUrl: db.url, mode, sqlText: SQL42, deployEnv: "test", confirm: mode === "check" ? null : confirmPhrase("0042", mode, db.name), ...extra });

describe("0042 — نص الملف والثوابت", () => {
  it("5 جداول بالترتيب ثم FK لاحق يكسر الدورة، ولا فهارس مركّبة داخله", () => {
    expect(describeStatements(SQL42).map(s => `${s.kind}:${s.name}`)).toEqual([
      "table:attendance_shifts", "table:attendance_assignments", "table:attendance_days",
      "table:attendance_correction_requests", "table:attendance_events", "late_fk:fk_acr_tenant_employee_target_event",
    ]);
  });
  it("workDaysMask: bit0=السبت … bit6=الجمعة، بلا Default في الـDDL", () => {
    expect(WEEKDAYS.map(d => d.label)).toEqual(["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"]);
    expect(maskFromDays(["sat"])).toBe(1);
    expect(maskFromDays(["fri"])).toBe(64);
    expect(daysFromMask(maskFromDays(["sun", "mon", "thu"]))).toEqual(["sun", "mon", "thu"]);
    expect(isWorkDay(maskFromDays(["fri"]), "2026-10-09")).toBe(true); // 2026-10-09 = الجمعة
    expect(isWorkDay(maskFromDays(["sat"]), "2026-10-09")).toBe(false);
    expect(SQL42).toMatch(/`workDaysMask` tinyint unsigned NOT NULL,/);
  });
});

describe.runIf(CAN)("🏗️ 0042 على قواعد مؤقتة", () => {
  let db: TempSchema, partial: TempSchema;
  beforeAll(async () => { db = await createTempSchema("att_m"); partial = await createTempSchema("att_p"); }, 180_000);
  afterAll(async () => { await db?.drop(); await partial?.drop(); }, 180_000);

  it("بدون الفهرسين المركّبين: preflight غير مستوفى و--apply يرفض بلا DDL", async () => {
    const chk = await run(db, "check");
    expect(chk.state).toBe("not_applied");
    expect(chk.preflight.find(p => p.label.includes("الفهرسان"))?.ok).toBe(false);
    const ap = await run(db, "apply");
    expect(ap.refused).toBe("preflight"); expect(ap.applied).toBe(0);
  });

  it("بعد 0041: apply → verify → replay → القيود بالحالات الدقيقة → rollback", async () => {
    expect((await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: db.url, mode: "apply", sqlText: SQL41, deployEnv: "test", confirm: confirmPhrase("0041", "apply", db.name) })).ok).toBe(true);
    expect((await run(db, "apply", { confirm: "APPLY 0042 TO x" })).refused).toMatch(/عبارة التأكيد/);
    const ap = await run(db, "apply");
    expect(ap.ok).toBe(true); expect(ap.applied).toBe(6); expect(ap.issues).toEqual([]);
    expect((await run(db, "apply")).replay).toBe(true);

    const q = async (s: string, p: unknown[] = []) => ((await db.raw.query(s, p)) as any)[0];
    const id = async (s: string, p: unknown[] = []) => (await q(s, p)).insertId as number;
    const ta = await id("INSERT INTO tenants (name, slug, status) VALUES ('A', ?, 'active')", [`a-${db.name}`.slice(0, 60)]);
    const tb = await id("INSERT INTO tenants (name, slug, status) VALUES ('B', ?, 'active')", [`b-${db.name}`.slice(0, 60)]);
    const ba = await id("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'A1', ?)", [ta, `ba-${db.name}`.slice(0, 50)]);
    const emp = async (t: number, b: number | null, n: string) => id("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES (?, 'agent', 1, ?, ?, ?)", [n, t, b, `${n}-${db.name}`.slice(0, 50)]);
    const e1 = await emp(ta, ba, "e1"), e2 = await emp(ta, ba, "e2"), eb = await emp(tb, null, "eb");
    const count = async (t: string) => Number((await q(`SELECT COUNT(*) n FROM ${t}`))[0].n);
    const rejected = async (t: string, s: string, p: unknown[], re: RegExp) => { const n = await count(t); await expect(db.raw.query(s, p)).rejects.toThrow(re); expect(await count(t)).toBe(n); };
    const H = "a".repeat(64);

    // ── الورديات ──
    const shift = (cols: Record<string, unknown>) => {
      const base = { tenantId: ta, businessId: ba, name: "صباحي", startTime: "11:00:00", endTime: "18:00:00", crossesMidnight: 0, workDaysMask: maskFromDays(["sat", "sun", "mon", "tue", "wed", "thu"]), graceMinutes: 10, allowedBreakMinutes: 60, overtimeStartsAfterMinutes: 30, earlyClockInLimitMinutes: 60, timezone: "Africa/Cairo", effectiveFrom: "2026-10-01", createdByEmployeeId: e1, ...cols };
      const k = Object.keys(base);
      return db.raw.query(`INSERT INTO attendance_shifts (${k.map(x => `\`${x}\``).join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map(x => (base as any)[x]));
    };
    const [s1] = (await shift({})) as any;
    const sid = s1.insertId;
    await shift({ name: "ليلي", startTime: "22:00:00", endTime: "06:00:00", crossesMidnight: 1 });
    await rejected("attendance_shifts", "INSERT INTO attendance_shifts (tenantId,name,startTime,endTime,crossesMidnight,workDaysMask,graceMinutes,allowedBreakMinutes,overtimeStartsAfterMinutes,earlyClockInLimitMinutes,timezone,effectiveFrom,createdByEmployeeId) VALUES (?, 'x', '10:00:00', '10:00:00', 0, 1, 0,0,0,0,'Africa/Cairo','2026-10-01',?)", [ta, e1], /chk_ash_times/);
    await expect(shift({ startTime: "22:00:00", endTime: "06:00:00", crossesMidnight: 0 })).rejects.toThrow(/chk_ash_times/);
    await expect(shift({ crossesMidnight: 1 })).rejects.toThrow(/chk_ash_times/);
    await expect(shift({ workDaysMask: 0 })).rejects.toThrow(/chk_ash_days/);
    await expect(shift({ businessId: null, createdByEmployeeId: eb })).rejects.toThrow(/foreign key/i);

    // ── التعيينات: دور داخل نشاط مسموح، والأهداف الخاطئة مرفوضة ──
    const asg = (cols: Record<string, unknown>) => { const base = { tenantId: ta, shiftId: sid, effectiveFrom: "2026-10-01", assignedByEmployeeId: e1, ...cols }; const k = Object.keys(base); return db.raw.query(`INSERT INTO attendance_assignments (${k.map(x => `\`${x}\``).join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map(x => (base as any)[x])); };
    await asg({ targetType: "employee", employeeId: e1 });
    await asg({ targetType: "role", role: "agent", businessId: ba });
    await asg({ targetType: "role", role: "agent" });
    await asg({ targetType: "business", businessId: ba });
    await asg({ targetType: "tenant_default" });
    await expect(asg({ targetType: "employee", employeeId: e1, role: "agent" })).rejects.toThrow(/chk_aas_target/);
    await expect(asg({ targetType: "role" })).rejects.toThrow(/chk_aas_target/);
    await expect(asg({ targetType: "business" })).rejects.toThrow(/chk_aas_target/);
    await expect(asg({ targetType: "tenant_default", role: "agent" })).rejects.toThrow(/chk_aas_target/);
    await expect(asg({ targetType: "employee", employeeId: eb })).rejects.toThrow(/foreign key/i);

    // ── الأيام والأحداث: FK الثلاثي ──
    const d1 = await id("INSERT INTO attendance_days (tenantId, employeeId, businessId, workDate, timezone) VALUES (?, ?, ?, '2026-10-05', 'Africa/Cairo')", [ta, e1, ba]);
    const d2 = await id("INSERT INTO attendance_days (tenantId, employeeId, businessId, workDate, timezone) VALUES (?, ?, ?, '2026-10-05', 'Africa/Cairo')", [ta, e2, ba]);
    await rejected("attendance_days", "INSERT INTO attendance_days (tenantId, employeeId, workDate, timezone) VALUES (?, ?, '2026-10-05', 'Africa/Cairo')", [ta, e1], /Duplicate entry/);
    await rejected("attendance_days", "INSERT INTO attendance_days (tenantId, employeeId, workDate, timezone, status) VALUES (?, ?, '2026-10-06', 'Africa/Cairo', 'on_break')", [ta, e1], /chk_ad_break/);
    await rejected("attendance_days", "INSERT INTO attendance_days (tenantId, employeeId, workDate, timezone, shiftId) VALUES (?, ?, '2026-10-07', 'Africa/Cairo', ?)", [ta, e1, sid], /chk_ad_snapshot/);
    const evt = (cols: Record<string, unknown>) => { const base = { tenantId: ta, attendanceDayId: d1, employeeId: e1, eventType: "clock_in", actorType: "self", actorEmployeeId: e1, source: "web", idempotencyKey: `k-${Math.random()}`, payloadHash: H, ...cols }; const k = Object.keys(base); return db.raw.query(`INSERT INTO attendance_events (${k.map(x => `\`${x}\``).join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map(x => (base as any)[x])); };
    const [ev1] = (await evt({})) as any;
    const e1Event = ev1.insertId;
    const [ev2] = (await evt({ attendanceDayId: d2, employeeId: e2, actorEmployeeId: e2 })) as any;
    const e2Event = ev2.insertId;
    const evCount = () => count("attendance_events");
    const evRejected = async (cols: Record<string, unknown>, re: RegExp) => { const n = await evCount(); await expect(evt(cols)).rejects.toThrow(re); expect(await evCount()).toBe(n); };
    await evRejected({ attendanceDayId: d2 }, /foreign key/i);                                  // حدث e1 على يوم e2
    await evRejected({ actorType: "admin", actorEmployeeId: e2, reason: "تصحيح", attendanceDayId: d2 }, /foreign key/i); // حتى من المدير
    // CHECK الفاعل — كل التركيبات الخاطئة
    await evRejected({ actorType: "self", actorEmployeeId: null }, /chk_ae_actor/);
    await evRejected({ actorType: "self", actorEmployeeId: e2 }, /chk_ae_actor/);
    await evRejected({ actorType: "admin", actorEmployeeId: null, reason: "سبب واضح" }, /chk_ae_actor/);
    await evRejected({ actorType: "admin", actorEmployeeId: e2, reason: null }, /chk_ae_actor/);
    await evRejected({ actorType: "admin", actorEmployeeId: e2, reason: "  " }, /chk_ae_actor/);
    await evRejected({ actorType: "system", actorEmployeeId: e1 }, /chk_ae_actor/);
    await evt({ actorType: "admin", actorEmployeeId: e2, reason: "نسي التسجيل", eventType: "clock_out" });
    await evt({ actorType: "system", actorEmployeeId: null, eventType: "day_close" });
    await evRejected({ eventType: "correction" }, /chk_ae_correction/);
    await evRejected({ eventType: "correction", correctionOfEventId: e2Event }, /foreign key/i); // تصحيح حدث موظف آخر
    await evt({ eventType: "correction", correctionOfEventId: e1Event, actorType: "admin", actorEmployeeId: e2, reason: "تصحيح وقت" });
    await evRejected({ payloadHash: "zz" }, /chk_ae_hash/);

    // ── طلبات التصحيح ──
    const req = (cols: Record<string, unknown>) => { const base = { tenantId: ta, employeeId: e1, workDate: "2026-10-05", requestType: "wrong_time", reason: "سبب واضح", idempotencyKey: `r-${Math.random()}`, payloadHash: H, ...cols }; const k = Object.keys(base); return db.raw.query(`INSERT INTO attendance_correction_requests (${k.map(x => `\`${x}\``).join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map(x => (base as any)[x])); };
    const rqCount = () => count("attendance_correction_requests");
    const rqRejected = async (cols: Record<string, unknown>, re: RegExp) => { const n = await rqCount(); await expect(req(cols)).rejects.toThrow(re); expect(await rqCount()).toBe(n); };
    const [rq1] = (await req({ attendanceDayId: d1, targetEventId: e1Event, requestedValueJson: JSON.stringify({ time: "11:05" }) })) as any;
    const [rq2] = (await req({ employeeId: e2, attendanceDayId: d2 })) as any;
    await rqRejected({ attendanceDayId: d2 }, /foreign key/i);          // طلب e1 على يوم e2
    await rqRejected({ targetEventId: e2Event }, /foreign key/i);       // طلب e1 يستهدف حدث e2
    await rqRejected({ reason: "ab" }, /chk_acr_reason/);
    await rqRejected({ status: "approved" }, /chk_acr_review/);
    await rqRejected({ status: "approved", reviewedByEmployeeId: e2 }, /chk_acr_review/);             // بلا reviewedAt
    await rqRejected({ status: "pending", reviewedByEmployeeId: e2, reviewedAt: new Date() }, /chk_acr_review/);
    await rqRejected({ status: "rejected", reviewedByEmployeeId: e2, reviewedAt: new Date() }, /chk_acr_reject/);
    await rqRejected({ status: "approved", reviewedByEmployeeId: e1, reviewedAt: new Date() }, /chk_acr_no_self/);
    await req({ status: "rejected", reviewedByEmployeeId: e2, reviewedAt: new Date(), reviewReason: "الوقت صحيح" });
    // حدث يرتبط بطلب موظف آخر → مرفوض
    await evRejected({ eventType: "correction", correctionRequestId: rq2.insertId, actorType: "admin", actorEmployeeId: e2, reason: "اعتماد" }, /foreign key/i);
    await evt({ eventType: "correction", correctionRequestId: rq1.insertId, actorType: "admin", actorEmployeeId: e2, reason: "اعتماد" });

    // rollback مع بيانات → مرفوض بلا تغيير
    expect((await run(db, "rollback")).refused).toBe("not_empty");
    expect((await run(db, "check")).state).toBe("applied");
    await q("SET foreign_key_checks = 0");
    for (const t of ["attendance_events", "attendance_correction_requests", "attendance_days", "attendance_assignments", "attendance_shifts"]) await q(`DELETE FROM ${t}`); // قاعدة اختبار مؤقتة فقط
    await q("SET foreign_key_checks = 1");
    const rb = await run(db, "rollback");
    expect(rb.ok).toBe(true);
    const after = await run(db, "check");
    expect(after.state).toBe("not_applied"); expect(after.compositeIndexes).toBe("present");
  }, 240_000);

  it("partial: جدول من الخمسة فقط → check partial و--apply يرفض", async () => {
    expect((await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: partial.url, mode: "apply", sqlText: SQL41, deployEnv: "test", confirm: confirmPhrase("0041", "apply", partial.name) })).ok).toBe(true);
    await partial.raw.query(describeStatements(SQL42)[0].sql);
    const chk = await run(partial, "check");
    expect(chk.state).toBe("partial");
    const ap = await run(partial, "apply");
    expect(ap.refused).toBe("partial"); expect(ap.applied).toBe(0);
  }, 120_000);
});
