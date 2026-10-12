import { fromMinorUnits, toMinorUnits } from "./accountingMoney";

/**
 * محرك حساب المرتب لدورة Ledger V3 (المرحلة 5) — نقي، بوحدات صغرى (BigInt بأربع خانات) بلا float، وبقواعد معلنة:
 *
 *  1) شهري: الأساسي = المرتب الأساسي؛ خصم الغياب = (الأساسي ÷ أيام العمل في الشهر) × أيام الغياب، بحد أقصى الأساسي.
 *  2) يومي: الأساسي = أجر اليوم × أيام الحضور الفعلي؛ لا خصم غياب (الغياب غير مدفوع أصلًا).
 *  3) عمولة: لا أساسي؛ مختلط: أساسي شهري + عمولة.
 *  4) التأخير: إن فُعّل، الدقائق فوق سماح الشهر تُخصم بأجر الدقيقة = الأساسي ÷ أيام العمل ÷ (ساعات اليوم × 60).
 *  5) الأوفرتايم: الدقائق **المعتمدة فقط** × أجر الدقيقة × المضاعف.
 *  6) العمولة: لكل أوردر مُسلَّم ومؤهل في الدورة (بالعدد أو بنسبة من القيمة)؛ وأوردر صُرفت عمولته في دورة سابقة ثم ارتد في
 *     هذه الدورة = استرداد بنفس القيمة المصروفة (سطر سالب صريح) — لا تُحسب العمولة مرتين ولا تُترك بعد المرتجع.
 *  7) البونص والخصومات اليدوية بأسبابها؛ الخصومات (غياب + تأخير + يدوية + استرداد عمولة) لا تتجاوز الإجمالي — وإلا
 *     «مراجعة» بلا حساب صافٍ مخمّن.
 *  8) أقساط السلف بعد كل ما سبق وبحد الصافي المتاح؛ الباقي يُرحّل للدورة التالية صراحةً (لا يُسقط ولا يُخصم مرتين).
 *  9) الصافي لا يكون سالبًا أبدًا.
 */
export type SalaryType = "monthly" | "daily" | "commission" | "mixed";

export type PayrollV3Input = {
  salaryType: SalaryType;
  baseSalary: string;
  dailyRate?: string | null;
  workingDaysPerMonth: number;
  workHoursPerDay: number;
  overtimeMultiplier: string;
  lateDeductionEnabled: boolean;
  lateGraceMinutesPerMonth: number;
  attendance: { presentDays: number; absentDays: number; lateMinutes: number; approvedOvertimeMinutes: number };
  commission: { type: "per_order" | "percent" | null; value: string; eligible: { orderId: number; amount: string }[]; clawback: { orderId: number; amount: string }[] };
  bonuses: { label: string; amount: string }[];
  deductions: { label: string; amount: string }[];
  advanceInstallments: { advanceId: number; amount: string }[];
};

export type PayrollV3Line = { key: string; label: string; amount: string };
export type PayrollV3Result =
  | {
      status: "ok";
      earnings: PayrollV3Line[];
      deductions: PayrollV3Line[];
      gross: string; totalDeductions: string; net: string;
      advancesDeducted: { advanceId: number; amount: string }[];
      advancesCarried: { advanceId: number; amount: string }[];
      commissionOrders: { orderId: number; amount: string }[];
    }
  | { status: "review"; reason: string };

const SCALE = 10000n;
const m = (v: string | null | undefined) => toMinorUnits(v == null || v === "" ? "0" : v);
const f = (v: bigint) => fromMinorUnits(v);
/** قسمة بتقريب لأقرب وحدة صغرى (نصف لأعلى) */
const div = (a: bigint, b: bigint) => (b === 0n ? 0n : (a * 2n + b) / (2n * b));

export function computePayrollV3(i: PayrollV3Input): PayrollV3Result {
  if (i.workingDaysPerMonth <= 0 || i.workHoursPerDay <= 0) return { status: "review", reason: "أيام العمل وساعات اليوم يجب أن تكون أكبر من صفر في إعدادات المرتبات" };
  const a = i.attendance;
  if ([a.presentDays, a.absentDays, a.lateMinutes, a.approvedOvertimeMinutes].some(x => !Number.isInteger(x) || x < 0)) return { status: "review", reason: "بيانات الحضور غير صالحة" };
  const base = m(i.baseSalary);
  const days = BigInt(i.workingDaysPerMonth);
  const minutesPerDay = BigInt(i.workHoursPerDay * 60);
  const monthly = i.salaryType === "monthly" || i.salaryType === "mixed";
  const earnings: { key: string; label: string; amount: bigint }[] = [];
  const deductions: { key: string; label: string; amount: bigint }[] = [];

  // 1–3 الأساسي
  if (monthly) earnings.push({ key: "base", label: "المرتب الأساسي", amount: base });
  if (i.salaryType === "daily") {
    if (i.dailyRate == null) return { status: "review", reason: "أجر اليوم غير محدد لراتب يومي" };
    earnings.push({ key: "base", label: `أجر ${a.presentDays} يوم حضور`, amount: m(i.dailyRate) * BigInt(a.presentDays) });
  }
  const dayRate = monthly ? div(base, days) : i.salaryType === "daily" ? m(i.dailyRate) : 0n;
  const minuteRate = div(dayRate, minutesPerDay);
  if (monthly && a.absentDays > 0) {
    const ded = dayRate * BigInt(a.absentDays);
    deductions.push({ key: "absence", label: `غياب ${a.absentDays} يوم`, amount: ded > base ? base : ded });
  }
  // 4 التأخير
  if (i.lateDeductionEnabled && dayRate > 0n) {
    const over = Math.max(0, a.lateMinutes - Math.max(0, i.lateGraceMinutesPerMonth));
    if (over > 0) deductions.push({ key: "late", label: `تأخير ${over} دقيقة بعد السماح`, amount: minuteRate * BigInt(over) });
  }
  // 5 الأوفرتايم المعتمد فقط
  if (a.approvedOvertimeMinutes > 0 && minuteRate > 0n) {
    const mult = m(i.overtimeMultiplier);
    earnings.push({ key: "overtime", label: `أوفرتايم معتمد ${a.approvedOvertimeMinutes} دقيقة`, amount: div(minuteRate * BigInt(a.approvedOvertimeMinutes) * mult, SCALE) });
  }
  // 6 العمولة واستردادها
  const commissionOrders: { orderId: number; amount: bigint }[] = [];
  if (i.commission.type && (i.salaryType === "commission" || i.salaryType === "mixed")) {
    const seen = new Set<number>();
    for (const o of i.commission.eligible) {
      if (seen.has(o.orderId)) continue; seen.add(o.orderId);
      const amt = i.commission.type === "per_order" ? m(i.commission.value) : div(m(o.amount) * m(i.commission.value), 100n * SCALE);
      commissionOrders.push({ orderId: o.orderId, amount: amt });
    }
    const total = commissionOrders.reduce((s, o) => s + o.amount, 0n);
    if (total > 0n) earnings.push({ key: "commission", label: `عمولة ${commissionOrders.length} أوردر`, amount: total });
  }
  const clawback = i.commission.clawback.reduce((s, o) => s + m(o.amount), 0n);
  if (clawback > 0n) deductions.push({ key: "commission_clawback", label: `استرداد عمولة ${i.commission.clawback.length} أوردر مرتجع`, amount: clawback });
  // 7 بونص وخصومات يدوية
  for (const b of i.bonuses) if (m(b.amount) > 0n) earnings.push({ key: "bonus", label: b.label || "بونص", amount: m(b.amount) });
  for (const d of i.deductions) if (m(d.amount) > 0n) deductions.push({ key: "deduction", label: d.label || "خصم", amount: m(d.amount) });

  const gross = earnings.reduce((s, x) => s + x.amount, 0n);
  const preAdvance = deductions.reduce((s, x) => s + x.amount, 0n);
  if (preAdvance > gross) return { status: "review", reason: `الخصومات (${f(preAdvance)}) أكبر من الإجمالي (${f(gross)}) — راجع البنود قبل الدورة` };
  // 8 أقساط السلف بحد المتاح
  let available = gross - preAdvance;
  const advancesDeducted: { advanceId: number; amount: bigint }[] = [];
  const advancesCarried: { advanceId: number; amount: bigint }[] = [];
  for (const inst of i.advanceInstallments) {
    const due = m(inst.amount);
    if (due <= 0n) continue;
    const take = due <= available ? due : available;
    if (take > 0n) { advancesDeducted.push({ advanceId: inst.advanceId, amount: take }); available -= take; }
    if (due - take > 0n) advancesCarried.push({ advanceId: inst.advanceId, amount: due - take });
  }
  const advTotal = advancesDeducted.reduce((s, x) => s + x.amount, 0n);
  if (advTotal > 0n) deductions.push({ key: "advance", label: `قسط سلفة (${advancesDeducted.length})`, amount: advTotal });
  const totalDeductions = preAdvance + advTotal;
  const net = gross - totalDeductions;
  const line = (x: { key: string; label: string; amount: bigint }) => ({ key: x.key, label: x.label, amount: f(x.amount) });
  return {
    status: "ok",
    earnings: earnings.map(line), deductions: deductions.map(line),
    gross: f(gross), totalDeductions: f(totalDeductions), net: f(net < 0n ? 0n : net),
    advancesDeducted: advancesDeducted.map(x => ({ advanceId: x.advanceId, amount: f(x.amount) })),
    advancesCarried: advancesCarried.map(x => ({ advanceId: x.advanceId, amount: f(x.amount) })),
    commissionOrders: commissionOrders.map(x => ({ orderId: x.orderId, amount: f(x.amount) })),
  };
}

/**
 * أهلية العمولة من حالة الأوردرات (قاعدة معلنة): مؤهل = سُلّم في الدورة ولم يرتد ولم تُصرف عمولته من قبل؛
 * استرداد = صُرفت عمولته في دورة سابقة ثم ارتد في هذه الدورة (بالمبلغ المصروف نفسه).
 */
export function commissionEligibility(orders: { orderId: number; amount: string; deliveredInPeriod: boolean; returnedInPeriod: boolean; paidCommission: string | null }[]) {
  return {
    eligible: orders.filter(o => o.deliveredInPeriod && !o.returnedInPeriod && o.paidCommission == null).map(o => ({ orderId: o.orderId, amount: o.amount })),
    clawback: orders.filter(o => o.returnedInPeriod && o.paidCommission != null && m(o.paidCommission) > 0n).map(o => ({ orderId: o.orderId, amount: o.paidCommission as string })),
  };
}
