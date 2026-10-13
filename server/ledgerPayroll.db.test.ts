import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { runLedgerKindsMigration } from "./ledgerKindsMigration.service";
import { LEDGER_PAYROLL_MIGRATION } from "./ledgerPhaseMigrations";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { activateLedgerV3 } from "./ledgerV3.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلة 5 على قاعدة حقيقية مؤقتة (0040/0041/0042/0045 ثم 0046/0048 بأدواتها الرسمية):
 * توفر قبل الـMigrations، السلف (مرة واحدة تحت التزامن)، حساب الدورة (غياب، أوفرتايم معتمد فقط، عمولة بلا مرتجع)، بونص بسبب،
 * فصل المُنشئ عن المعتمِد، الاعتماد والدفع مرة واحدة تحت التزامن، الإلغاء بالعكس (مدفوعة → معتمدة → ملغاة) والأقساط تعود
 * مستحقة فتُخصم مرة واحدة فقط، الباقي المرحّل والإلغاء من الأحدث، استرداد العمولة مرة واحدة، والصلاحيات وعزل الشركات.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("💼 المرحلة 5 — المرتبات والسلف في V3", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let o1 = 0, o3 = 0, augRun = 0, sepRun = 0, advW1 = 0, seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const bal = async (c: string) => (await q("SELECT currentBalance b FROM ledger_accounts WHERE tenantId = ? AND code = ?", [A.tenantId, c]))[0]?.b;
  const lines = async (key: string) => (await q("SELECT a.code, e.side, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId JOIN ledger_transactions t ON t.id = e.transactionId WHERE t.tenantId = ? AND t.idempotencyKey = ? ORDER BY a.code", [A.tenantId, key])).map((r: any) => [r.code, r.side, r.amount]);
  const inst = async (employeeId: number) => (await q("SELECT i.seq, i.dueMonth, i.amount, i.status, i.deductedAmount d, i.payrollRunId r FROM ledger_advance_installments i JOIN ledger_advances a ON a.id = i.advanceId WHERE a.employeeId = ? AND a.status <> 'cancelled' ORDER BY a.id, i.seq", [employeeId]));
  const line = async (runId: number, employeeId: number) => (await (await call(e.amA)).payroll.run({ runId })).lines.find((l: any) => l.employeeId === employeeId)!;
  const day = (emp: number, date: string, status: string, ot = 0, approved: number | null = null) =>
    q(`INSERT INTO attendance_days (tenantId, employeeId, workDate, timezone, status, workedMinutes, breakMinutes, excessBreakMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, requiresReview, approvedByEmployeeId, approvedAt, version)
       VALUES (?, ?, ?, 'Africa/Cairo', ?, 480, 0, 0, 0, 0, ?, 0, ?, IF(? IS NULL, NULL, NOW(3)), 1)`, [A.tenantId, emp, date, status, ot, approved, approved]);
  const order = async (emp: number, deliveredAt: string, status: string) => insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, shippingFees, status, source, assignedEmployeeId, deliveredAt)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', '500', '0', ?, 'manual', ?, ?)`, [A.businessId, `PR-${tmp.name.slice(-4)}-${++seq}`, status, emp, new Date(`${deliveredAt}T12:00:00Z`)]));

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_pay");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) {
      try { await tmp.raw.query(stmt); } catch (err: any) { if (err?.code !== "ER_DUP_KEYNAME") throw err; } // الفهرسان المركّبان من 0041
    }
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("pr-a"); B = await createCoreTestFixture("pr-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-pr`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("amB", "accounts_manager", A); await mk("accA", "accountant", A);
    await mk("W1", "agent", A); await mk("W2", "agent", A); await mk("ownerB", "super_admin", B);
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.post', 1, ?)", [A.tenantId, e.ownerA]);
    await q("INSERT INTO payroll_settings (businessId, workingDaysPerMonth, workHoursPerDay, overtimeMultiplier) VALUES (?, 25, '8.00', '1.50')", [A.businessId]);
    const profile = (emp: number, type: string, base: string, ct: string | null, cv: string | null) => q(`INSERT INTO employee_salary_profiles (businessId, employeeId, salaryType, baseSalary, commissionType, commissionValue, commissionBasis, effectiveFrom, isActive, createdBy, createdByName)
      VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, 1, ?, 'مالك')`, [A.businessId, emp, type, base, ct, cv, new Date("2026-07-01T00:00:00Z"), e.ownerA]);
    await profile(e.W1, "monthly", "3000", null, null);
    await profile(e.W2, "mixed", "1000", "per_order", "20");
    await day(e.W1, "2026-08-10", "absent");
    await day(e.W1, "2026-08-11", "closed", 120, e.ownerA); // أوفرتايم معتمد
    await day(e.W1, "2026-08-12", "closed", 60, null);      // مسجّل غير معتمد — لا يُدفع
    o1 = await order(e.W2, "2026-08-15", "delivered");
    await order(e.W2, "2026-08-16", "returned");           // مرتجع وقت الحساب — لا عمولة
    o3 = await order(e.W2, "2026-09-05", "delivered");
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-08-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-07-31T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-07-31T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "10000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("قبل 0046/0048: «غير متاح» بلا خطأ؛ بعدهما تجهيز الحسابات لمدير الحسابات فقط ومرة واحدة", async () => {
    const am = await call(e.amA);
    expect(await am.payroll.runs()).toMatchObject({ available: false });
    expect(await code(() => am.payroll.ensureAccounts())).toBe("PRECONDITION_FAILED");
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0046", "apply", tmp.name) })).ok).toBe(true);
    expect((await runHandMigration(LEDGER_PAYROLL_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0048_ledger_payroll.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0048", "apply", tmp.name) } as any)).ok).toBe(true);
    expect(await code(async () => (await call(e.accA)).payroll.ensureAccounts())).toBe("FORBIDDEN");
    expect((await am.payroll.ensureAccounts()).created.sort()).toEqual(["EMP_ADVANCES", "EXP_COMMISSIONS", "EXP_SALARIES", "PAYROLL_PAYABLE"]);
    expect((await am.payroll.ensureAccounts()).created).toEqual([]);
    expect((await q("SELECT kind FROM ledger_accounts WHERE tenantId = ? AND code = 'PAYROLL_PAYABLE'", [A.tenantId]))[0].kind).toBe("payroll_payable");
  });

  it("السلفة: مرة واحدة تحت 3 طلبات متزامنة بنفس العملية، أقساط متساوية، من خزنة فقط؛ والإدخال اليدوي على حسابها مرفوض", async () => {
    const am = await call(e.amA);
    const args = { employeeId: e.W1, principal: "900", issuedOn: "2026-08-05", installmentsCount: 3, firstDueMonth: "2026-08", fromAccountCode: "OFFICE_CASH", operationId: "ui:adv-w1-0001" };
    const runs = await Promise.all([1, 2, 3].map(() => am.payroll.advances.issue(args)));
    expect(new Set(runs.map(r => r.advanceId)).size).toBe(1);
    advW1 = runs[0].advanceId;
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_advances WHERE tenantId = ?", [A.tenantId]))[0].n)).toBe(1);
    expect((await inst(e.W1)).map((i: any) => [i.dueMonth, i.amount, i.status])).toEqual([["2026-08", "300.0000", "pending"], ["2026-09", "300.0000", "pending"], ["2026-10", "300.0000", "pending"]]);
    expect([await bal("EMP_ADVANCES"), await bal("OFFICE_CASH")]).toEqual(["900.0000", "9100.0000"]);
    expect(await code(() => am.payroll.advances.issue({ ...args, operationId: "ui:adv-w1-0002", fromAccountCode: "EXP_SALARIES" }))).toBe("NOT_FOUND");
    const accs = Object.fromEntries((await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])).map((r: any) => [r.code, r.id]));
    expect(await code(() => am.post({ sourceBusinessId: A.businessId, kind: "advance", idempotencyKey: "manual-adv-0001", effectiveDate: "2026-08-06", currency: "EGP", description: "يدوي",
      entries: [{ accountId: accs.EMP_ADVANCES, side: "debit", amount: "10", businessId: A.businessId }, { accountId: accs.OFFICE_CASH, side: "credit", amount: "10", businessId: A.businessId }] } as any))).toBe("BAD_REQUEST");
  });

  it("دورة أغسطس: غياب يوم، أوفرتايم معتمد فقط، قسط سلفة، عمولة الأوردر المسلَّم فقط (المرتجع لا)، وبونص بسبب؛ دورة نشطة واحدة للشهر", async () => {
    const am = await call(e.amA);
    const created = await Promise.all([1, 2].map(() => am.payroll.create({ period: "2026-08", operationId: "ui:run-aug-0001" })));
    augRun = created[0].runId;
    expect(created[1].runId).toBe(augRun);
    expect(await code(() => am.payroll.create({ period: "2026-08", operationId: "ui:run-aug-0002" }))).toBe("CONFLICT");
    const w1 = await line(augRun, e.W1);
    // أجر اليوم 3000/25 = 120؛ الدقيقة 120/480 = 0.25؛ أوفرتايم 120 × 0.25 × 1.5 = 45 (الـ60 غير المعتمدة لا تُحسب)
    expect([w1.gross, w1.totalDeductions, w1.net]).toEqual(["3045.0000", "420.0000", "2625.0000"]);
    expect(w1.result.deductions.map((x: any) => [x.key, x.amount])).toEqual([["absence", "120.0000"], ["advance", "300.0000"]]);
    const w2 = await line(augRun, e.W2);
    expect(w2.result.commissionOrders).toEqual([{ orderId: o1, amount: "20.0000" }]);
    expect(await code(() => am.payroll.adjust({ runId: augRun, employeeId: e.W2, bonuses: [{ label: "x", amount: "50" }], deductions: [] }))).toBe("BAD_REQUEST");
    await am.payroll.adjust({ runId: augRun, employeeId: e.W2, bonuses: [{ label: "حافز تارجت", amount: "50" }], deductions: [] });
    expect((await line(augRun, e.W2)).net).toBe("1070.0000");
    expect((await am.payroll.run({ runId: augRun })).run.net).toBe("3695.0000");
  });

  it("الاعتماد: المُنشئ لا يعتمد، المحاسب ممنوع، مدير آخر يعتمد مرة واحدة تحت التزامن — قيد استحقاق صحيح والقسط مرتبط بالدورة", async () => {
    expect(await code(async () => (await call(e.amA)).payroll.approve({ runId: augRun }))).toBe("CONFLICT");
    expect(await code(async () => (await call(e.accA)).payroll.approve({ runId: augRun }))).toBe("FORBIDDEN");
    const amB = await call(e.amB);
    const runs = await Promise.allSettled([1, 2, 3].map(() => amB.payroll.approve({ runId: augRun })));
    expect(runs.every(r => r.status === "fulfilled")).toBe(true);
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE idempotencyKey = ?", [`payroll:${augRun}:accrual`]))[0].n)).toBe(1);
    expect(await lines(`payroll:${augRun}:accrual`)).toEqual([["EMP_ADVANCES", "credit", "300.0000"], ["EXP_COMMISSIONS", "debit", "20.0000"], ["EXP_SALARIES", "debit", "3975.0000"], ["PAYROLL_PAYABLE", "credit", "3695.0000"]]);
    expect((await q("SELECT DATE_FORMAT(effectiveDate,'%Y-%m-%d') d FROM ledger_transactions WHERE idempotencyKey = ?", [`payroll:${augRun}:accrual`]))[0].d).toBe("2026-08-31");
    expect((await inst(e.W1))[0]).toMatchObject({ status: "deducted", d: "300.0000", r: augRun });
    expect(await code(async () => (await call(e.amA)).payroll.adjust({ runId: augRun, employeeId: e.W2, bonuses: [], deductions: [] }))).toBe("CONFLICT"); // لا تعديل بعد الاعتماد
  });

  it("الدفع: لا يسبق الاستحقاق، من خزنة، مرة واحدة تحت التزامن", async () => {
    const am = await call(e.amA);
    expect(await code(() => am.payroll.pay({ runId: augRun, paidOn: "2026-08-30", fromAccountCode: "OFFICE_CASH" }))).toBe("BAD_REQUEST");
    const runs = await Promise.allSettled([1, 2].map(() => am.payroll.pay({ runId: augRun, paidOn: "2026-09-01", fromAccountCode: "OFFICE_CASH" })));
    expect(runs.every(r => r.status === "fulfilled")).toBe(true);
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE idempotencyKey = ?", [`payroll:${augRun}:payment`]))[0].n)).toBe(1);
    expect([await bal("PAYROLL_PAYABLE"), await bal("OFFICE_CASH")]).toEqual(["0.0000", "5405.0000"]);
  });

  it("إلغاء دورة مدفوعة بالعكس فقط: يعود النقد والقسط مستحقًا؛ الدورة الجديدة لنفس الشهر تخصم القسط مرة واحدة", async () => {
    const owner = await call(e.ownerA);
    expect(await code(() => owner.payroll.cancel({ runId: augRun, reason: "x" }))).toBe("BAD_REQUEST");
    await owner.payroll.cancel({ runId: augRun, reason: "خطأ في البونص" });
    expect((await owner.payroll.run({ runId: augRun })).run.status).toBe("cancelled");
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE idempotencyKey IN (?, ?)", [`payroll:${augRun}:cancel-payment`, `payroll:${augRun}:cancel-accrual`]))[0].n)).toBe(2);
    expect([await bal("OFFICE_CASH"), await bal("EXP_SALARIES"), await bal("EXP_COMMISSIONS"), await bal("PAYROLL_PAYABLE"), await bal("EMP_ADVANCES")]).toEqual(["9100.0000", "0.0000", "0.0000", "0.0000", "900.0000"]);
    expect((await inst(e.W1))[0]).toMatchObject({ status: "pending", d: "0.0000", r: null });
    expect((await owner.payroll.cancel({ runId: augRun, reason: "مرة ثانية" })).replay).toBe(true);
    // دورة جديدة لنفس الشهر بعد الإلغاء
    const am = await call(e.amA);
    augRun = (await am.payroll.create({ period: "2026-08", operationId: "ui:run-aug-0003" })).runId;
    expect((await line(augRun, e.W2)).result.commissionOrders).toEqual([{ orderId: o1, amount: "20.0000" }]); // الملغاة لا تُعد صرفًا
    await (await call(e.amB)).payroll.approve({ runId: augRun });
    expect((await inst(e.W1)).filter((i: any) => i.status === "deducted").map((i: any) => i.r)).toEqual([augRun]);
    expect(await bal("EMP_ADVANCES")).toBe("600.0000");
  });

  it("الباقي المرحّل: قسط أكبر من الصافي يُخصم بقدر المتاح ويُرحَّل الباقي للشهر التالي؛ الإلغاء من الأحدث يلغي المرحّل ويعيد القسط كاملًا", async () => {
    const am = await call(e.amA), amB = await call(e.amB);
    await am.payroll.advances.issue({ employeeId: e.W2, principal: "2000", issuedOn: "2026-09-01", installmentsCount: 1, firstDueMonth: "2026-09", fromAccountCode: "OFFICE_CASH", operationId: "ui:adv-w2-0001" });
    sepRun = (await am.payroll.create({ period: "2026-09", operationId: "ui:run-sep-0001" })).runId;
    const w2 = await line(sepRun, e.W2); // 1000 + عمولة o3 20 = 1020 كلها للقسط
    expect([w2.gross, w2.net]).toEqual(["1020.0000", "0.0000"]);
    expect(w2.result.advancesCarried.map((x: any) => x.amount)).toEqual(["980.0000"]);
    await amB.payroll.approve({ runId: sepRun });
    expect((await inst(e.W2)).map((i: any) => [i.seq, i.dueMonth, i.amount, i.status, i.d])).toEqual([[1, "2026-09", "2000.0000", "deducted", "1020.0000"], [2, "2026-10", "980.0000", "pending", "0.0000"]]);
    // أغسطس لا يُلغى قبل سبتمبر
    expect(await code(async () => (await call(e.ownerA)).payroll.cancel({ runId: augRun, reason: "ترتيب خاطئ" }))).toBe("CONFLICT");
    await (await call(e.ownerA)).payroll.cancel({ runId: sepRun, reason: "إعادة حساب سبتمبر" });
    expect((await inst(e.W2)).map((i: any) => [i.seq, i.status, i.d])).toEqual([[1, "pending", "0.0000"], [2, "cancelled", "0.0000"]]);
    expect(await code(async () => (await call(e.ownerA)).payroll.advances.cancel({ advanceId: advW1, reason: "لا يصح" }))).toBe("CONFLICT"); // خُصم منها في أغسطس
  });

  it("استرداد العمولة: أوردر صُرفت عمولته ثم ارتد = خصم بنفس المبلغ مرة واحدة فقط", async () => {
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [o1]);
    const am = await call(e.amA);
    sepRun = (await am.payroll.create({ period: "2026-09", operationId: "ui:run-sep-0002" })).runId;
    const w2 = await line(sepRun, e.W2);
    expect(w2.inputs.engine.commission.clawback).toEqual([{ orderId: o1, amount: "20.0000" }]);
    expect(w2.result.deductions.find((x: any) => x.key === "commission_clawback")?.amount).toBe("20.0000");
    await (await call(e.amB)).payroll.approve({ runId: sepRun });
    expect(await bal("EXP_COMMISSIONS")).toBe("20.0000"); // أغسطس 20 + سبتمبر (20 − 20) = 20
    const octRun = (await am.payroll.create({ period: "2026-10", operationId: "ui:run-oct-0001" })).runId;
    expect((await line(octRun, e.W2)).inputs.engine.commission.clawback).toEqual([]); // لا استرداد مرتين
  });

  it("الصلاحيات والعزل: المحاسب لا يرى المرتبات ولا السلف؛ الشركة B لا ترى دورات A", async () => {
    const acc = await call(e.accA);
    expect(await code(() => acc.payroll.runs())).toBe("FORBIDDEN");
    expect(await code(() => acc.payroll.advances.list())).toBe("FORBIDDEN");
    const ob = await call(e.ownerB);
    expect((await ob.payroll.runs()).runs).toEqual([]);
    expect(await code(() => ob.payroll.run({ runId: augRun }))).toBe("NOT_FOUND");
    expect(await code(() => ob.payroll.cancel({ runId: augRun, reason: "شركة أخرى" }))).not.toBe("ok");
    expect((await (await call(e.amA)).payroll.run({ runId: augRun })).run.status).toBe("approved");
  });
});
