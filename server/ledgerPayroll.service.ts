import { and, asc, desc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { businesses, employeeSalaryProfiles, employees, orders, payrollSettings } from "../drizzle/schema";
import { ledgerAccounts } from "../drizzle/ledgerV3.schema";
import { ledgerAdvanceInstallments, ledgerAdvances, ledgerPayrollLines, ledgerPayrollRuns } from "../drizzle/ledgerPhases.schema";
import { allocateEvenly, fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { businessDateKey, businessDayRange } from "../shared/businessTime";
import { LEDGER_PAYROLL_ACCOUNTS } from "../shared/ledgerDailyAccounts";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import { computePayrollV3, type PayrollV3Input, type PayrollV3Result } from "../shared/payrollV3";
import { monthBounds, monthlyAttendanceSummary } from "./attendanceSummary.service";
import { getCarrierSettingValues, tablesPresent } from "./ledgerCarrierOps.service";
import { ledgerKindsSupported } from "./ledgerKindsMigration.service";
import { createLedgerAccount, getLedgerStatus, grantLedgerAccountBusiness, postLedgerTransaction, rawRows, resolveDb, reverseLedgerTransaction, type LedgerDb } from "./ledgerV3.service";

/**
 * المرحلة 5 — المرتبات والسلف في Ledger V3 (بعد 0046 + 0048). لا كتابة في payroll_* أو employee_advances القديمة؛ ملفات
 * الراتب (employee_salary_profiles) وإعدادات المرتبات (payroll_settings) والحضور تُقرأ فقط كمدخلات.
 *
 *  • الدورة: مسودة (حساب مجمّد لكل موظف: الملف الساري نهاية الشهر + إعدادات النشاط + ملخص الحضور المعتمد + العمولة + بونص/خصم
 *    يدوي بسبب + أقساط السلف المستحقة) → اعتماد = قيد استحقاق (مرتبات/عمولات مدين؛ سلف + رواتب مستحقة دائن) → دفع = رواتب
 *    مستحقة مدين / خزنة دائن. تغيير الحالة وتحديث الأقساط داخل transaction القيد نفسه (guard) — لا قيد بلا حالة ولا العكس،
 *    والاعتماد/الدفع المتزامن لا يتكرر.
 *  • الإلغاء بالعكس فقط وللدورة الأحدث فقط (ترتيب الأشهر): مدفوعة → عكس الدفع (تعود معتمدة) ثم عكس الاستحقاق (ملغاة)؛ الأقساط
 *    المخصومة تعود «مستحقة» والباقي المرحّل منها يُلغى — فتخصمها الدورة التالية مرة واحدة فقط.
 *  • العمولة (قاعدة معلنة): نفس إسناد الموظف وأساس الاستحقاق في ملفه (تأكيد/تجهيز/شحن/توصيل) خلال الشهر، **ولا عمولة** لأوردر
 *    مرتجع/ملغي وقت الحساب، ولا عمولة مرتين؛ أوردر صُرفت عمولته ثم ارتد/أُلغي = استرداد بنفس المبلغ مرة واحدة في الدورة التالية.
 *  • التأخير يُخصم فقط إن أُدخل سماح التأخير للنشاط؛ الأوفرتايم المعتمد فقط؛ أي يوم حضور يحتاج مراجعة = سطر «مراجعة» يمنع الاعتماد.
 */
export const PAYROLL_TABLES = ["ledger_payroll_runs", "ledger_payroll_lines", "ledger_advances", "ledger_advance_installments"] as const;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const OP_RE = /^[A-Za-z0-9_:-]{8,80}$/;
const TZ = "Africa/Cairo";
const today = () => businessDateKey(new Date(), TZ);
const nextMonth = (p: string) => { const [y, m] = p.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
const affected = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const insertId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? 0);
const json = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
const employeeOf = (actor: LedgerActor) => { if (actor.type !== "employee") throw new LedgerError("actorEmployee"); return actor.employeeId; };

export async function payrollAvailability(d: LedgerDb) {
  const kinds = await ledgerKindsSupported({ query: (q: string) => d.execute(sql.raw(q)) as any });
  const tables = await tablesPresent(d, PAYROLL_TABLES);
  return { kinds, tables, ok: kinds && tables };
}

async function requireReady(d: LedgerDb, tenantId: number) {
  const a = await payrollAvailability(d);
  if (!a.ok) throw new LedgerError("unavailable", !a.kinds ? "أنواع الحسابات (0046) غير مطبّقة" : "جداول المرتبات (0048) غير مطبّقة");
  const s = await getLedgerStatus(tenantId, d);
  if (!s.enabled || !s.goLiveDate) throw new LedgerError("disabled");
  return { goLiveDate: s.goLiveDate };
}

async function accountIds(d: LedgerDb, tenantId: number, codes: string[]) {
  const rows = await d.select({ id: ledgerAccounts.id, code: ledgerAccounts.code, isActive: ledgerAccounts.isActive }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, tenantId), inArray(ledgerAccounts.code, codes)));
  const out: Record<string, number> = {};
  for (const r of rows) if (r.isActive === 1) out[r.code] = r.id;
  const missing = codes.filter(c => out[c] == null);
  if (missing.length) throw new LedgerError("account", `حسابات المرتبات ناقصة: ${missing.join("، ")} — جهّزها من شاشة المرتبات`);
  return out;
}

/** تجهيز حسابات المرتبات والسلف (idempotent بالكود) ومنحها لكل الأنشطة — بعد 0046 فقط. */
export async function ensurePayrollAccounts(input: { tenantId: number; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  const biz = await d.select({ id: businesses.id }).from(businesses).where(eq(businesses.tenantId, input.tenantId));
  const created: string[] = [];
  for (const spec of LEDGER_PAYROLL_ACCOUNTS) {
    const r = await createLedgerAccount({ tenantId: input.tenantId, code: spec.code, name: spec.name, kind: spec.kind as any, normalSide: spec.normalSide, actor: input.actor }, d);
    if (!r.replay) created.push(spec.code);
    for (const b of biz) await grantLedgerAccountBusiness({ tenantId: input.tenantId, accountId: r.id, businessId: b.id, actor: input.actor }, d);
  }
  return { created };
}

// ───────────── السلف ─────────────

/** صرف سلفة: مدين «سلف الموظفين» / دائن خزنة؛ أقساط متساوية (آخرها يمتص فرق التقريب) من شهر البداية. مرة واحدة بمفتاح العملية. */
export async function issueAdvance(input: { tenantId: number; employeeId: number; principal: string; issuedOn: string; installmentsCount: number; firstDueMonth: string; fromAccountCode: string; operationId: string; note?: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  const { goLiveDate } = await requireReady(d, input.tenantId);
  const creator = employeeOf(input.actor);
  if (!OP_RE.test(input.operationId)) throw new LedgerError("conflict", "معرّف العملية");
  if (!DATE_RE.test(input.issuedOn) || input.issuedOn < goLiveDate || input.issuedOn > today()) throw new LedgerError("date", input.issuedOn);
  if (!PERIOD_RE.test(input.firstDueMonth) || input.firstDueMonth < input.issuedOn.slice(0, 7)) throw new LedgerError("date", "شهر أول قسط لا يسبق شهر الصرف");
  if (!Number.isInteger(input.installmentsCount) || input.installmentsCount < 1 || input.installmentsCount > 60) throw new LedgerError("amount", "عدد الأقساط من 1 إلى 60");
  const principal = toMinorUnits(input.principal);
  if (principal <= 0n) throw new LedgerError("amount", input.principal);
  const [emp] = await d.select({ id: employees.id, businessId: employees.businessId, isActive: employees.isActive }).from(employees).where(and(eq(employees.id, input.employeeId), eq(employees.tenantId, input.tenantId))).limit(1);
  if (!emp || !emp.isActive) throw new LedgerError("actorEmployee", "الموظف غير موجود أو غير نشط في الشركة");
  const key = `advance:${input.operationId}`;
  const [existing] = await d.select().from(ledgerAdvances).where(and(eq(ledgerAdvances.tenantId, input.tenantId), eq(ledgerAdvances.idempotencyKey, key))).limit(1);
  if (existing) return { advanceId: existing.id, replay: true };
  const [cash] = await d.select({ id: ledgerAccounts.id, kind: ledgerAccounts.kind }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.code, input.fromAccountCode))).limit(1);
  if (!cash || !["cash", "bank", "wallet"].includes(cash.kind)) throw new LedgerError("account", "السلفة تُصرف من خزنة أو بنك أو محفظة");
  const acc = await accountIds(d, input.tenantId, ["EMP_ADVANCES"]);
  const businessId = emp.businessId ?? null;
  const parts = allocateEvenly(fromMinorUnits(principal), input.installmentsCount);
  let advanceId = 0;
  try {
    await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: businessId, kind: "advance", idempotencyKey: key, effectiveDate: input.issuedOn, currency: "EGP", actor: input.actor,
      entries: [{ accountId: acc.EMP_ADVANCES, side: "debit", amount: fromMinorUnits(principal), businessId }, { accountId: cash.id, side: "credit", amount: fromMinorUnits(principal), businessId }],
      description: `سلفة موظف #${input.employeeId}${input.note ? ` — ${input.note.trim()}` : ""}`, sourceType: "advance", sourceReference: String(input.employeeId),
      guard: async (tx: any, { transactionId }: { transactionId: number }) => {
        advanceId = insertId(await tx.insert(ledgerAdvances).values({ tenantId: input.tenantId, employeeId: input.employeeId, businessId, principal: fromMinorUnits(principal), issuedOn: input.issuedOn,
          installmentsCount: input.installmentsCount, issueTransactionId: transactionId, idempotencyKey: key, createdByEmployeeId: creator }));
        let month = input.firstDueMonth;
        for (let i = 0; i < parts.length; i++) {
          await tx.insert(ledgerAdvanceInstallments).values({ tenantId: input.tenantId, advanceId, seq: i + 1, dueMonth: month, amount: fromMinorUnits(parts[i]) });
          month = nextMonth(month);
        }
      } } as any, d);
  } catch (e) {
    const [again] = await d.select().from(ledgerAdvances).where(and(eq(ledgerAdvances.tenantId, input.tenantId), eq(ledgerAdvances.idempotencyKey, key))).limit(1);
    if (again) return { advanceId: again.id, replay: true };
    throw e;
  }
  if (!advanceId) {
    const [row] = await d.select().from(ledgerAdvances).where(and(eq(ledgerAdvances.tenantId, input.tenantId), eq(ledgerAdvances.idempotencyKey, key))).limit(1);
    return { advanceId: row?.id ?? 0, replay: true };
  }
  return { advanceId, replay: false };
}

/** إلغاء سلفة بالعكس — فقط إن لم يُخصم منها شيء في أي دورة. */
export async function cancelAdvance(input: { tenantId: number; advanceId: number; reason: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  if (!input.reason || input.reason.trim().length < 3) throw new LedgerError("reason");
  const [adv] = await d.select().from(ledgerAdvances).where(and(eq(ledgerAdvances.id, input.advanceId), eq(ledgerAdvances.tenantId, input.tenantId))).limit(1);
  if (!adv) throw new LedgerError("transaction", "السلفة غير موجودة");
  if (adv.status === "cancelled") return { replay: true };
  return reverseLedgerTransaction({ tenantId: input.tenantId, transactionId: adv.issueTransactionId, idempotencyKey: `advance:${adv.id}:cancel`, effectiveDate: today(), reason: `إلغاء سلفة: ${input.reason.trim()}`, actor: input.actor,
    guard: async (tx: any, { transactionId }: { transactionId: number }) => {
      const [deducted] = rawRows(await tx.execute(sql`SELECT COUNT(*) AS n FROM ledger_advance_installments WHERE advanceId = ${adv.id} AND status = 'deducted' FOR UPDATE`));
      if (Number(deducted?.n ?? 0) > 0) throw new LedgerError("conflict", "خُصم من السلفة قسط في دورة مرتب — لا تُلغى (ألغِ الدورة أولًا أو اتركها تُسدَّد)");
      if (affected(await tx.update(ledgerAdvances).set({ status: "cancelled", cancelTransactionId: transactionId }).where(and(eq(ledgerAdvances.id, adv.id), eq(ledgerAdvances.status, "active")))) !== 1) throw new LedgerError("conflict", "حالة السلفة تغيّرت");
      await tx.update(ledgerAdvanceInstallments).set({ status: "cancelled" }).where(and(eq(ledgerAdvanceInstallments.advanceId, adv.id), eq(ledgerAdvanceInstallments.status, "pending")));
    } }, d).then(r => ({ replay: r.replay }));
}

export async function listAdvances(tenantId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  if (!(await payrollAvailability(d)).ok) return { available: false as const, advances: [] };
  const rows = rawRows(await d.execute(sql`SELECT a.id, a.employeeId, e.name AS employeeName, a.principal, DATE_FORMAT(a.issuedOn, '%Y-%m-%d') AS issuedOn, a.installmentsCount, a.status,
      COALESCE((SELECT SUM(i.deductedAmount) FROM ledger_advance_installments i WHERE i.advanceId = a.id AND i.status = 'deducted'), 0) AS repaid,
      (SELECT MIN(i.dueMonth) FROM ledger_advance_installments i WHERE i.advanceId = a.id AND i.status = 'pending') AS nextDue
    FROM ledger_advances a JOIN employees e ON e.id = a.employeeId WHERE a.tenantId = ${tenantId} ORDER BY a.id DESC LIMIT 300`));
  return {
    available: true as const,
    advances: rows.map((r: any) => {
      const principal = toMinorUnits(String(r.principal)), repaid = toMinorUnits(String(r.repaid));
      return { id: Number(r.id), employeeId: Number(r.employeeId), employeeName: String(r.employeeName), principal: fromMinorUnits(principal), repaid: fromMinorUnits(repaid),
        balance: r.status === "cancelled" ? "0.0000" : fromMinorUnits(principal - repaid), issuedOn: String(r.issuedOn), installmentsCount: Number(r.installmentsCount), status: String(r.status), nextDue: r.nextDue ?? null };
    }),
  };
}

// ───────────── حساب سطر الموظف ─────────────

type LineInputs = { profileId: number | null; businessId: number | null; engine: PayrollV3Input | null; review: string | null; adjustments: { bonuses: { label: string; amount: string }[]; deductions: { label: string; amount: string }[] }; installments: { id: number; advanceId: number; amount: string }[] };
type LineResult = PayrollV3Result & { carriedInstallmentIds?: number[] };

const BASIS_COLUMN = { confirmed: orders.confirmedAt, prepared: orders.preparedAt, shipped: orders.shippedAt, delivered: orders.deliveredAt } as const;

/** العمولة المصروفة والمستردة سابقًا لموظف (من دورات معتمدة/مدفوعة فقط — المسودة والملغاة لا تُحسب). */
async function commissionHistory(d: LedgerDb, tenantId: number, employeeId: number, excludeRunId: number) {
  const rows = await d.select({ inputs: ledgerPayrollLines.inputsJson, result: ledgerPayrollLines.resultJson }).from(ledgerPayrollLines)
    .innerJoin(ledgerPayrollRuns, eq(ledgerPayrollRuns.id, ledgerPayrollLines.runId))
    .where(and(eq(ledgerPayrollLines.tenantId, tenantId), eq(ledgerPayrollLines.employeeId, employeeId), inArray(ledgerPayrollRuns.status, ["approved", "paid"]), ne(ledgerPayrollRuns.id, excludeRunId)));
  const paid = new Map<number, string>(); const clawed = new Set<number>();
  for (const r of rows) {
    const res = json<LineResult>(r.result); const inp = json<LineInputs>(r.inputs);
    if (res.status === "ok") for (const o of res.commissionOrders) paid.set(o.orderId, o.amount);
    for (const c of inp.engine?.commission.clawback ?? []) clawed.add(c.orderId);
  }
  return { paid, clawed };
}

async function computeLine(d: LedgerDb, tenantId: number, runId: number, period: string, employeeId: number, adjustments: LineInputs["adjustments"]) {
  const { to } = monthBounds(period);
  const end = businessDayRange(to, TZ).toExclusive;
  const start = businessDayRange(`${period}-01`, TZ).from;
  const [profile] = await d.select().from(employeeSalaryProfiles)
    .where(and(eq(employeeSalaryProfiles.employeeId, employeeId), eq(employeeSalaryProfiles.isActive, true), lt(employeeSalaryProfiles.effectiveFrom, end)))
    .orderBy(desc(employeeSalaryProfiles.effectiveFrom), desc(employeeSalaryProfiles.id)).limit(1);
  const base: LineInputs = { profileId: profile?.id ?? null, businessId: profile?.businessId ?? null, engine: null, review: null, adjustments, installments: [] };
  const finish = (inputs: LineInputs, result: LineResult) => ({ inputs, result });
  if (!profile) return finish({ ...base, review: "لا ملف راتب ساري" }, { status: "review", reason: "لا ملف راتب ساري لهذا الموظف في نهاية الشهر" });
  const [settings] = await d.select().from(payrollSettings).where(eq(payrollSettings.businessId, profile.businessId)).limit(1);
  if (!settings) return finish({ ...base, review: "إعدادات المرتبات" }, { status: "review", reason: "إعدادات المرتبات غير محددة لنشاط الموظف" });
  let att: Awaited<ReturnType<typeof monthlyAttendanceSummary>>[number] | undefined;
  try { [att] = await monthlyAttendanceSummary({ tenantId, period, employeeIds: [employeeId] }); }
  catch (e) {
    for (let x: any = e, i = 0; x && i < 6; x = x.cause, i++) if (x.code === "ER_NO_SUCH_TABLE") return finish({ ...base, review: "الحضور" }, { status: "review", reason: "جداول الحضور غير مطبّقة — لا حساب بلا حضور" });
    throw e;
  }
  const attendance = att ?? { presentDays: 0, absentDays: 0, lateMinutes: 0, approvedOvertimeMinutes: 0, reviewDays: 0 };
  if ((att?.reviewDays ?? 0) > 0) return finish({ ...base, review: "حضور يحتاج مراجعة" }, { status: "review", reason: `${att!.reviewDays} يوم حضور يحتاج مراجعة قبل الدورة` });
  // العمولة
  let eligible: { orderId: number; amount: string }[] = [], clawback: { orderId: number; amount: string }[] = [];
  const commissionType = profile.commissionType === "percentage" ? "percent" : profile.commissionType === "per_order" ? "per_order" : null;
  const hist = await commissionHistory(d, tenantId, employeeId, runId);
  if (commissionType && (profile.salaryType === "commission" || profile.salaryType === "mixed")) {
    const col = BASIS_COLUMN[(profile.commissionBasis as keyof typeof BASIS_COLUMN) ?? "delivered"] ?? orders.deliveredAt;
    const rows = await d.select({ id: orders.id, total: orders.totalAmount, status: orders.status }).from(orders)
      .where(and(eq(orders.assignedEmployeeId, employeeId), eq(orders.businessId, profile.businessId), gte(col, start), lt(col, end)));
    eligible = rows.filter(o => !["returned", "cancelled"].includes(String(o.status)) && !hist.paid.has(o.id)).map(o => ({ orderId: o.id, amount: String(o.total) }));
  }
  const paidIds = [...hist.paid.keys()].filter(id => !hist.clawed.has(id));
  if (paidIds.length > 0) {
    const back = await d.select({ id: orders.id }).from(orders).where(and(inArray(orders.id, paidIds), inArray(orders.status, ["returned", "cancelled"])));
    clawback = back.map(o => ({ orderId: o.id, amount: hist.paid.get(o.id)! }));
  }
  // أقساط السلف المستحقة (حتى هذا الشهر، لسلف نشطة)
  const inst = await d.select({ id: ledgerAdvanceInstallments.id, advanceId: ledgerAdvanceInstallments.advanceId, amount: ledgerAdvanceInstallments.amount }).from(ledgerAdvanceInstallments)
    .innerJoin(ledgerAdvances, eq(ledgerAdvances.id, ledgerAdvanceInstallments.advanceId))
    .where(and(eq(ledgerAdvanceInstallments.tenantId, tenantId), eq(ledgerAdvances.employeeId, employeeId), eq(ledgerAdvances.status, "active"), eq(ledgerAdvanceInstallments.status, "pending"), lte(ledgerAdvanceInstallments.dueMonth, period)))
    .orderBy(asc(ledgerAdvanceInstallments.dueMonth), asc(ledgerAdvanceInstallments.id));
  const grace = (await getCarrierSettingValues(d, tenantId, profile.businessId))["payroll.late_grace_minutes"];
  const engine: PayrollV3Input = {
    salaryType: profile.salaryType as any, baseSalary: String(profile.baseSalary ?? "0"), dailyRate: profile.dailyRate == null ? null : String(profile.dailyRate),
    workingDaysPerMonth: Number(settings.workingDaysPerMonth), workHoursPerDay: Math.round(Number(settings.workHoursPerDay) * 60) / 60, overtimeMultiplier: String(settings.overtimeMultiplier),
    lateDeductionEnabled: grace != null, lateGraceMinutesPerMonth: grace == null ? 0 : Number(grace),
    attendance: { presentDays: attendance.presentDays, absentDays: attendance.absentDays, lateMinutes: attendance.lateMinutes, approvedOvertimeMinutes: attendance.approvedOvertimeMinutes },
    commission: { type: commissionType, value: String(profile.commissionValue ?? "0"), eligible, clawback },
    bonuses: adjustments.bonuses, deductions: adjustments.deductions,
    // كل قسط بمعرّفه (المحرك يعيد نفس المعرّف في المخصوم/المرحّل)
    advanceInstallments: inst.map(i => ({ advanceId: i.id, amount: String(i.amount) })),
  };
  const result = computePayrollV3(engine) as LineResult;
  return finish({ ...base, engine, installments: inst.map(i => ({ id: i.id, advanceId: i.advanceId, amount: String(i.amount) })) }, result);
}

const lineAmounts = (r: LineResult) => r.status === "ok" ? { gross: r.gross, totalDeductions: r.totalDeductions, net: r.net } : { gross: "0.0000", totalDeductions: "0.0000", net: "0.0000" };

async function writeLines(d: LedgerDb, tenantId: number, runId: number, period: string, employeeIds: number[], adjustmentsBy: Map<number, LineInputs["adjustments"]>) {
  for (const employeeId of employeeIds) {
    const { inputs, result } = await computeLine(d, tenantId, runId, period, employeeId, adjustmentsBy.get(employeeId) ?? { bonuses: [], deductions: [] });
    await d.delete(ledgerPayrollLines).where(and(eq(ledgerPayrollLines.runId, runId), eq(ledgerPayrollLines.employeeId, employeeId)));
    await d.insert(ledgerPayrollLines).values({ tenantId, runId, employeeId, businessId: inputs.businessId, inputsJson: inputs, resultJson: result, ...lineAmounts(result) });
  }
  await refreshTotals(d, runId);
}

async function refreshTotals(d: LedgerDb, runId: number) {
  const lines = await d.select({ gross: ledgerPayrollLines.gross, totalDeductions: ledgerPayrollLines.totalDeductions, net: ledgerPayrollLines.net }).from(ledgerPayrollLines).where(eq(ledgerPayrollLines.runId, runId));
  const sum = (k: "gross" | "totalDeductions" | "net") => fromMinorUnits(lines.reduce((s, l) => s + toMinorUnits(String(l[k])), 0n));
  await d.update(ledgerPayrollRuns).set({ gross: sum("gross"), totalDeductions: sum("totalDeductions"), net: sum("net") }).where(and(eq(ledgerPayrollRuns.id, runId), eq(ledgerPayrollRuns.status, "draft")));
}

/** موظفو الدورة: نشطون في الشركة ولهم ملف راتب نشط ساري قبل نهاية الشهر. */
async function runEmployees(d: LedgerDb, tenantId: number, period: string) {
  const end = businessDayRange(monthBounds(period).to, TZ).toExclusive;
  const rows = await d.selectDistinct({ id: employees.id }).from(employees)
    .innerJoin(employeeSalaryProfiles, eq(employeeSalaryProfiles.employeeId, employees.id))
    .where(and(eq(employees.tenantId, tenantId), eq(employees.isActive, true), eq(employeeSalaryProfiles.isActive, true), lt(employeeSalaryProfiles.effectiveFrom, end)));
  return rows.map(r => r.id).sort((a, b) => a - b);
}

// ───────────── دورة المرتب ─────────────

async function getRun(d: LedgerDb, tenantId: number, runId: number) {
  const [run] = await d.select().from(ledgerPayrollRuns).where(and(eq(ledgerPayrollRuns.id, runId), eq(ledgerPayrollRuns.tenantId, tenantId))).limit(1);
  if (!run) throw new LedgerError("transaction", "دورة المرتب غير موجودة");
  return run;
}

/** مسودة دورة لشهر (دورة نشطة واحدة لكل شهر — الفهرس الفريد)؛ نفس معرّف العملية = نفس الدورة. */
export async function createPayrollRun(input: { tenantId: number; period: string; operationId: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  const { goLiveDate } = await requireReady(d, input.tenantId);
  const creator = employeeOf(input.actor);
  if (!PERIOD_RE.test(input.period)) throw new LedgerError("date", input.period);
  if (!OP_RE.test(input.operationId)) throw new LedgerError("conflict", "معرّف العملية");
  if (monthBounds(input.period).to < goLiveDate) throw new LedgerError("beforeGoLive", input.period);
  if (input.period > today().slice(0, 7)) throw new LedgerError("date", "لا دورة لشهر لم يبدأ");
  const key = `payroll-run:${input.operationId}`;
  const [same] = await d.select().from(ledgerPayrollRuns).where(and(eq(ledgerPayrollRuns.tenantId, input.tenantId), eq(ledgerPayrollRuns.idempotencyKey, key))).limit(1);
  if (same) return { runId: same.id, replay: true };
  let runId: number;
  try {
    runId = insertId(await d.insert(ledgerPayrollRuns).values({ tenantId: input.tenantId, period: input.period, createdByEmployeeId: creator, idempotencyKey: key }));
  } catch (e: any) {
    const [again] = await d.select().from(ledgerPayrollRuns).where(and(eq(ledgerPayrollRuns.tenantId, input.tenantId), eq(ledgerPayrollRuns.idempotencyKey, key))).limit(1);
    if (again) return { runId: again.id, replay: true };
    throw new LedgerError("conflict", `توجد دورة نشطة لشهر ${input.period} — ألغِها أولًا لإعادتها`);
  }
  await writeLines(d, input.tenantId, runId, input.period, await runEmployees(d, input.tenantId, input.period), new Map());
  return { runId, replay: false };
}

/** إعادة حساب المسودة (بعد تعديل حضور/ملف/سلفة) مع الإبقاء على البونص والخصومات اليدوية. */
export async function recomputePayrollRun(input: { tenantId: number; runId: number }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  const run = await getRun(d, input.tenantId, input.runId);
  if (run.status !== "draft") throw new LedgerError("conflict", "تُعاد حسابات المسودة فقط");
  const prev = await d.select({ employeeId: ledgerPayrollLines.employeeId, inputs: ledgerPayrollLines.inputsJson }).from(ledgerPayrollLines).where(eq(ledgerPayrollLines.runId, run.id));
  const adj = new Map(prev.map(p => [p.employeeId, json<LineInputs>(p.inputs).adjustments]));
  const ids = await runEmployees(d, input.tenantId, run.period);
  await d.delete(ledgerPayrollLines).where(and(eq(ledgerPayrollLines.runId, run.id), sql`${ledgerPayrollLines.employeeId} NOT IN (${sql.join((ids.length ? ids : [0]).map(i => sql`${i}`), sql`, `)})`));
  await writeLines(d, input.tenantId, run.id, run.period, ids, adj);
  return { runId: run.id };
}

/** بونص/خصم يدوي بسبب لسطر موظف في المسودة — يعيد حساب سطره وحده. */
export async function setPayrollAdjustments(input: { tenantId: number; runId: number; employeeId: number; bonuses: { label: string; amount: string }[]; deductions: { label: string; amount: string }[] }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  const run = await getRun(d, input.tenantId, input.runId);
  if (run.status !== "draft") throw new LedgerError("conflict", "التعديل على المسودة فقط");
  for (const x of [...input.bonuses, ...input.deductions]) {
    if (!x.label || x.label.trim().length < 3) throw new LedgerError("reason", "سبب كل بونص/خصم إلزامي");
    if (toMinorUnits(x.amount) <= 0n) throw new LedgerError("amount", x.amount);
  }
  const [line] = await d.select({ id: ledgerPayrollLines.id }).from(ledgerPayrollLines).where(and(eq(ledgerPayrollLines.runId, run.id), eq(ledgerPayrollLines.employeeId, input.employeeId))).limit(1);
  if (!line) throw new LedgerError("transaction", "الموظف ليس في هذه الدورة");
  const clean = (xs: { label: string; amount: string }[]) => xs.map(x => ({ label: x.label.trim(), amount: fromMinorUnits(toMinorUnits(x.amount)) }));
  await writeLines(d, input.tenantId, run.id, run.period, [input.employeeId], new Map([[input.employeeId, { bonuses: clean(input.bonuses), deductions: clean(input.deductions) }]]));
}

/** اعتماد: قيد الاستحقاق + الحالة + الأقساط في transaction واحد. المُنشئ لا يعتمد دورته إلا المالك. */
export async function approvePayrollRun(input: { tenantId: number; runId: number; actor: LedgerActor; isOwner: boolean }, db?: LedgerDb) {
  const d = await resolveDb(db);
  const { goLiveDate } = await requireReady(d, input.tenantId);
  const approver = employeeOf(input.actor);
  const run = await getRun(d, input.tenantId, input.runId);
  if (run.status === "approved" || run.status === "paid") return { runId: run.id, replay: true, transactionId: run.accrualTransactionId };
  if (run.status !== "draft") throw new LedgerError("conflict", "الدورة ملغاة");
  if (run.createdByEmployeeId === approver && !input.isOwner) throw new LedgerError("conflict", "منشئ الدورة لا يعتمدها — يعتمدها مدير الحسابات الآخر أو المالك");
  const lines = await d.select().from(ledgerPayrollLines).where(eq(ledgerPayrollLines.runId, run.id)).orderBy(asc(ledgerPayrollLines.employeeId));
  if (lines.length === 0) throw new LedgerError("conflict", "دورة بلا موظفين");
  const review = lines.filter(l => json<LineResult>(l.resultJson).status !== "ok");
  if (review.length) throw new LedgerError("conflict", `${review.length} سطر يحتاج مراجعة — لا اعتماد على بيانات ناقصة`);
  const acc = await accountIds(d, input.tenantId, ["EXP_SALARIES", "EXP_COMMISSIONS", "EMP_ADVANCES", "PAYROLL_PAYABLE"]);
  // قيود مجمّعة لكل (حساب، نشاط) بإشارة
  const agg = new Map<string, bigint>();
  const add = (code: string, businessId: number | null, signedDebit: bigint) => { const k = `${code}|${businessId ?? ""}`; agg.set(k, (agg.get(k) ?? 0n) + signedDebit); };
  for (const l of lines) {
    const r = json<LineResult>(l.resultJson) as Extract<LineResult, { status: "ok" }>;
    const m = (xs: { key: string; amount: string }[], keys: string[]) => xs.filter(x => keys.includes(x.key)).reduce((s, x) => s + toMinorUnits(x.amount), 0n);
    const commission = m(r.earnings, ["commission"]) - m(r.deductions, ["commission_clawback"]);
    const salary = m(r.earnings, ["base", "overtime", "bonus"]) - m(r.deductions, ["absence", "late", "deduction"]);
    const adv = m(r.deductions, ["advance"]);
    add("EXP_SALARIES", l.businessId, salary); add("EXP_COMMISSIONS", l.businessId, commission);
    add("EMP_ADVANCES", l.businessId, -adv); add("PAYROLL_PAYABLE", l.businessId, -toMinorUnits(r.net));
  }
  const entries = [...agg].filter(([, v]) => v !== 0n).map(([k, v]) => {
    const [code, biz] = k.split("|");
    return { accountId: acc[code], side: v > 0n ? "debit" as const : "credit" as const, amount: fromMinorUnits(v > 0n ? v : -v), businessId: biz === "" ? null : Number(biz) };
  });
  if (entries.length === 0) throw new LedgerError("conflict", "دورة بلا مبالغ");
  const periodEnd = monthBounds(run.period).to;
  const date = periodEnd <= today() ? periodEnd : today();
  if (date < goLiveDate) throw new LedgerError("beforeGoLive", date);
  try {
    const r = await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: null, kind: "payroll", idempotencyKey: `payroll:${run.id}:accrual`, effectiveDate: date, currency: "EGP", actor: input.actor, entries,
      description: `استحقاق مرتبات ${run.period} (${lines.length} موظف)`, sourceType: "payroll_run", sourceReference: String(run.id),
      guard: async (tx: any, { transactionId }: { transactionId: number }) => {
        const [locked] = await tx.select({ status: ledgerPayrollRuns.status }).from(ledgerPayrollRuns).where(eq(ledgerPayrollRuns.id, run.id)).for("update");
        if (locked?.status !== "draft") throw new LedgerError("conflict", "حالة الدورة تغيّرت");
        await tx.update(ledgerPayrollRuns).set({ status: "approved", approvedByEmployeeId: approver, approvedAt: new Date(), accrualTransactionId: transactionId }).where(eq(ledgerPayrollRuns.id, run.id));
        // الأقساط: المخصوم بالكامل/جزئيًا يرتبط بالدورة؛ الباقي الجزئي قسط جديد للشهر التالي (يُلغى إن أُلغيت الدورة)
        for (const l of lines) {
          const r2 = json<LineResult>(l.resultJson) as Extract<LineResult, { status: "ok" }>;
          const inputs = json<LineInputs>(l.inputsJson);
          const byId = new Map(inputs.installments.map(i => [i.id, i]));
          const carried: number[] = [];
          for (const ded of r2.advancesDeducted) {
            const inst = byId.get(ded.advanceId)!;
            if (affected(await tx.update(ledgerAdvanceInstallments).set({ status: "deducted", payrollRunId: run.id, deductedAmount: ded.amount })
              .where(and(eq(ledgerAdvanceInstallments.id, inst.id), eq(ledgerAdvanceInstallments.status, "pending")))) !== 1)
              throw new LedgerError("conflict", "قسط سلفة تغيّر منذ حساب المسودة — أعد الحساب");
            const rest = toMinorUnits(inst.amount) - toMinorUnits(ded.amount);
            if (rest > 0n) {
              const [mx] = rawRows(await tx.execute(sql`SELECT MAX(seq) AS s FROM ledger_advance_installments WHERE advanceId = ${inst.advanceId} FOR UPDATE`));
              carried.push(insertId(await tx.insert(ledgerAdvanceInstallments).values({ tenantId: input.tenantId, advanceId: inst.advanceId, seq: Number(mx?.s ?? 0) + 1, dueMonth: nextMonth(run.period), amount: fromMinorUnits(rest) })));
            }
          }
          for (const inst of inputs.installments) {
            if (r2.advancesDeducted.some(x => x.advanceId === inst.id)) continue;
            const [still] = await tx.select({ status: ledgerAdvanceInstallments.status }).from(ledgerAdvanceInstallments).where(eq(ledgerAdvanceInstallments.id, inst.id)).for("update");
            if (still?.status !== "pending") throw new LedgerError("conflict", "قسط سلفة تغيّر منذ حساب المسودة — أعد الحساب");
          }
          if (carried.length) await tx.update(ledgerPayrollLines).set({ resultJson: { ...r2, carriedInstallmentIds: carried } }).where(eq(ledgerPayrollLines.id, l.id));
        }
        await tx.execute(sql`UPDATE ledger_advances a SET a.status = 'settled' WHERE a.tenantId = ${input.tenantId} AND a.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM ledger_advance_installments i WHERE i.advanceId = a.id AND i.status = 'pending')
          AND EXISTS (SELECT 1 FROM ledger_advance_installments i WHERE i.advanceId = a.id AND i.payrollRunId = ${run.id})`);
      } } as any, d);
    return { runId: run.id, replay: r.replay, transactionId: r.transactionId };
  } catch (e) {
    const now = await getRun(d, input.tenantId, run.id);
    if (now.status === "approved" || now.status === "paid") return { runId: run.id, replay: true, transactionId: now.accrualTransactionId };
    throw e;
  }
}

/** الدفع: رواتب مستحقة مدين / خزنة دائن بصافي كل نشاط، مرة واحدة. */
export async function payPayrollRun(input: { tenantId: number; runId: number; paidOn: string; fromAccountCode: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  const payer = employeeOf(input.actor);
  const run = await getRun(d, input.tenantId, input.runId);
  if (run.status === "paid") return { runId: run.id, replay: true, transactionId: run.paymentTransactionId };
  if (run.status !== "approved") throw new LedgerError("conflict", "الدفع لدورة معتمدة فقط");
  if (!DATE_RE.test(input.paidOn) || input.paidOn > today()) throw new LedgerError("date", input.paidOn);
  const [accrual] = rawRows(await d.execute(sql`SELECT DATE_FORMAT(effectiveDate, '%Y-%m-%d') AS d FROM ledger_transactions WHERE id = ${run.accrualTransactionId}`));
  if (accrual && input.paidOn < accrual.d) throw new LedgerError("date", `الدفع لا يسبق الاستحقاق (${accrual.d})`);
  const [cash] = await d.select({ id: ledgerAccounts.id, kind: ledgerAccounts.kind }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.code, input.fromAccountCode))).limit(1);
  if (!cash || !["cash", "bank", "wallet"].includes(cash.kind)) throw new LedgerError("account", "الدفع من خزنة أو بنك أو محفظة");
  const acc = await accountIds(d, input.tenantId, ["PAYROLL_PAYABLE"]);
  const byBiz = rawRows(await d.execute(sql`SELECT businessId AS b, SUM(net) AS n FROM ledger_payroll_lines WHERE runId = ${run.id} GROUP BY businessId`)).filter((r: any) => toMinorUnits(String(r.n)) > 0n);
  if (byBiz.length === 0) throw new LedgerError("conflict", "صافي الدورة صفر — لا دفع");
  const entries = byBiz.flatMap((r: any) => {
    const b = r.b == null ? null : Number(r.b); const n = fromMinorUnits(toMinorUnits(String(r.n)));
    return [{ accountId: acc.PAYROLL_PAYABLE, side: "debit" as const, amount: n, businessId: b }, { accountId: cash.id, side: "credit" as const, amount: n, businessId: b }];
  });
  try {
    const r = await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: null, kind: "payroll", idempotencyKey: `payroll:${run.id}:payment`, effectiveDate: input.paidOn, currency: "EGP", actor: input.actor, entries,
      description: `صرف مرتبات ${run.period}`, sourceType: "payroll_run", sourceReference: String(run.id),
      guard: async (tx: any, { transactionId }: { transactionId: number }) => {
        if (affected(await tx.update(ledgerPayrollRuns).set({ status: "paid", paidByEmployeeId: payer, paidAt: new Date(), paymentTransactionId: transactionId }).where(and(eq(ledgerPayrollRuns.id, run.id), eq(ledgerPayrollRuns.status, "approved")))) !== 1)
          throw new LedgerError("conflict", "حالة الدورة تغيّرت");
      } } as any, d);
    return { runId: run.id, replay: r.replay, transactionId: r.transactionId };
  } catch (e) {
    const now = await getRun(d, input.tenantId, run.id);
    if (now.status === "paid") return { runId: run.id, replay: true, transactionId: now.paymentTransactionId };
    throw e;
  }
}

/**
 * إلغاء بالعكس للدورة الأحدث فقط، بسبب مكتوب: مسودة = إلغاء بلا قيود؛ مدفوعة = عكس الدفع (تعود معتمدة) ثم عكس الاستحقاق؛
 * معتمدة = عكس الاستحقاق: الأقساط المخصومة تعود مستحقة، الباقي المرحّل منها يُلغى، والسلف المسددة بها تعود نشطة.
 */
export async function cancelPayrollRun(input: { tenantId: number; runId: number; reason: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  const by = employeeOf(input.actor);
  if (!input.reason || input.reason.trim().length < 3) throw new LedgerError("reason");
  const reason = input.reason.trim().slice(0, 500);
  let run = await getRun(d, input.tenantId, input.runId);
  if (run.status === "cancelled") return { runId: run.id, replay: true };
  const [later] = await d.select({ id: ledgerPayrollRuns.id, period: ledgerPayrollRuns.period }).from(ledgerPayrollRuns)
    .where(and(eq(ledgerPayrollRuns.tenantId, input.tenantId), ne(ledgerPayrollRuns.status, "cancelled"), sql`${ledgerPayrollRuns.period} > ${run.period}`)).limit(1);
  if (later) throw new LedgerError("conflict", `توجد دورة أحدث (${later.period}) — تُلغى الدورات من الأحدث للأقدم`);
  if (run.status === "draft") {
    if (affected(await d.update(ledgerPayrollRuns).set({ status: "cancelled", cancelledByEmployeeId: by, cancelledAt: new Date(), cancelReason: reason }).where(and(eq(ledgerPayrollRuns.id, run.id), eq(ledgerPayrollRuns.status, "draft")))) !== 1)
      throw new LedgerError("conflict", "حالة الدورة تغيّرت");
    return { runId: run.id, replay: false };
  }
  if (run.status === "paid") {
    await reverseLedgerTransaction({ tenantId: input.tenantId, transactionId: run.paymentTransactionId!, idempotencyKey: `payroll:${run.id}:cancel-payment`, effectiveDate: today(), reason: `إلغاء دورة ${run.period}: ${reason}`, actor: input.actor,
      guard: async tx => {
        if (affected(await tx.update(ledgerPayrollRuns).set({ status: "approved", paidByEmployeeId: null, paidAt: null, paymentTransactionId: null }).where(and(eq(ledgerPayrollRuns.id, run.id), eq(ledgerPayrollRuns.status, "paid")))) !== 1)
          throw new LedgerError("conflict", "حالة الدورة تغيّرت");
      } }, d);
    run = await getRun(d, input.tenantId, run.id);
  }
  const lines = await d.select({ resultJson: ledgerPayrollLines.resultJson }).from(ledgerPayrollLines).where(eq(ledgerPayrollLines.runId, run.id));
  const carried = lines.flatMap(l => json<LineResult>(l.resultJson).carriedInstallmentIds ?? []);
  await reverseLedgerTransaction({ tenantId: input.tenantId, transactionId: run.accrualTransactionId!, idempotencyKey: `payroll:${run.id}:cancel-accrual`, effectiveDate: today(), reason: `إلغاء دورة ${run.period}: ${reason}`, actor: input.actor,
    guard: async tx => {
      if (affected(await tx.update(ledgerPayrollRuns).set({ status: "cancelled", cancelledByEmployeeId: by, cancelledAt: new Date(), cancelReason: reason }).where(and(eq(ledgerPayrollRuns.id, run.id), eq(ledgerPayrollRuns.status, "approved")))) !== 1)
        throw new LedgerError("conflict", "حالة الدورة تغيّرت");
      if (carried.length) {
        const n = affected(await tx.update(ledgerAdvanceInstallments).set({ status: "cancelled" }).where(and(inArray(ledgerAdvanceInstallments.id, carried), eq(ledgerAdvanceInstallments.status, "pending"))));
        if (n !== carried.length) throw new LedgerError("conflict", "الباقي المرحّل من قسط خُصم في دورة لاحقة — ألغِ اللاحقة أولًا");
      }
      const advIds = rawRows(await tx.execute(sql`SELECT DISTINCT advanceId AS a FROM ledger_advance_installments WHERE payrollRunId = ${run.id}`)).map((r: any) => Number(r.a));
      await tx.update(ledgerAdvanceInstallments).set({ status: "pending", payrollRunId: null, deductedAmount: "0" }).where(and(eq(ledgerAdvanceInstallments.payrollRunId, run.id), eq(ledgerAdvanceInstallments.status, "deducted")));
      if (advIds.length) await tx.update(ledgerAdvances).set({ status: "active" }).where(and(inArray(ledgerAdvances.id, advIds), eq(ledgerAdvances.status, "settled")));
    } }, d);
  return { runId: run.id, replay: false };
}

export async function listPayrollRuns(tenantId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  const a = await payrollAvailability(d);
  if (!a.ok) return { available: false as const, reason: !a.kinds ? "0046" : "0048", runs: [] };
  const runs = await d.select().from(ledgerPayrollRuns).where(eq(ledgerPayrollRuns.tenantId, tenantId)).orderBy(desc(ledgerPayrollRuns.period), desc(ledgerPayrollRuns.id)).limit(60);
  return { available: true as const, runs };
}

export async function getPayrollRun(tenantId: number, runId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  const run = await getRun(d, tenantId, runId);
  const lines = await d.select({ l: ledgerPayrollLines, name: employees.name }).from(ledgerPayrollLines).innerJoin(employees, eq(employees.id, ledgerPayrollLines.employeeId))
    .where(eq(ledgerPayrollLines.runId, run.id)).orderBy(asc(employees.name));
  return { run, lines: lines.map(x => ({ ...x.l, employeeName: x.name, result: json<LineResult>(x.l.resultJson), inputs: json<LineInputs>(x.l.inputsJson) })) };
}
