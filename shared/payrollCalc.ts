/**
 * محرّك حساب الراتب — دوال نقية بلا قاعدة بيانات ولا شبكة.
 *
 * منفصل عن `server/db.ts` عن قصد: ده الجزء اللي بيقرر كام يقبض الموظف، وهو أكتر جزء
 * محتاج اختبارات، وأقل جزء المفروض يعتمد على اتصال بقاعدة بيانات. الفصل ده بيخلي كل
 * حالة حدية (غياب أكتر من الشهر، عمولة بالنسبة، تقريب) تتغطّى باختبار حقيقي بيشغّل
 * نفس الكود اللي بيشتغل في الإنتاج — مش نسخة منه.
 */

export type SalaryType = "monthly" | "daily" | "commission" | "mixed";
export type CommissionType = "per_order" | "percentage";
export type CommissionBasis = "confirmed" | "prepared" | "shipped" | "delivered";
export type AbsenceBasis = "calendar_days" | "working_days";
export type RoundingMode = "none" | "nearest_1" | "nearest_5" | "nearest_10";
export type OvertimeMode = "manual" | "hourly_multiplier";

/** حالة الأوردر اللي بتستحق العمولة → اسم عمود الطابع الزمني المقابل في جدول orders. */
export const COMMISSION_BASIS_STATUS: Record<CommissionBasis, string> = {
  confirmed: "confirmed",
  prepared: "preparing",
  shipped: "shipped",
  delivered: "delivered",
};

export type SalaryProfileInput = {
  salaryType: SalaryType;
  baseSalary?: string | number | null;
  dailyRate?: string | number | null;
  commissionType?: CommissionType | null;
  commissionValue?: string | number | null;
  commissionBasis?: CommissionBasis;
};

export type PayrollSettingsInput = {
  workingDaysPerMonth: number;
  absenceDeductionBasis: AbsenceBasis;
  overtimeMode: OvertimeMode;
  overtimeMultiplier: string | number;
  workHoursPerDay: string | number;
  roundingMode: RoundingMode;
};

export type PayrollLineInput = {
  attendanceDays: number;
  absenceDays: number;
  overtimeHours: number;
  /** يُستخدم كما هو عندما تكون طريقة الأوفرتايم يدوية */
  overtimeAmount: number;
  bonuses: number;
  deductions: number;
  advances: number;
  /** عدد الأوردرات المستحقة للعمولة، أو إجماليها لو العمولة بالنسبة */
  commissionOrderCount: number;
  commissionOrderTotal: number;
};

export type PayrollLineResult = {
  baseSalary: number;
  absenceDeduction: number;
  overtimeAmount: number;
  commissions: number;
  netSalary: number;
};

/** يقبل النص الراجع من decimal في drizzle وكذلك الرقم، ويحوّل أي شيء آخر لصفر. */
export function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * الحقول اللازمة لحساب تكلفة المرتب في الربح — مجموعة فرعية من صف `payroll_items`.
 * أي صف من الجدول بيلبّي الشكل ده (decimals بترجع نصوص، فبنقبل نص أو رقم).
 */
export type SalaryCostInput = {
  baseSalary: string | number | null;
  overtimeAmount: string | number | null;
  bonuses: string | number | null;
  commissions: string | number | null;
  absenceDeduction: string | number | null;
  deductions: string | number | null;
};

/**
 * **التعريف الوحيد المعتمد لتكلفة المرتب في الربح** — استخدمه في كل مكان، مافيش صيغة
 * تانية للمرتب في أي شاشة أو محرّك.
 *
 *   تكلفة المرتب = الأساسي + الأوفرتايم + البونص + العمولة − خصم الغياب − الخصومات
 *
 * **السُلفة مابتتخصمش هنا.** السُلفة مش مصروف مرتب جديد — هي كاش اتدفع للموظف مقدّمًا
 * وبيقلّل *المتبقّي* اللي هيتصرف من المرتب، مش تكلفة العمالة. طرحها كان هيخصم المرتب
 * مرتين: مرة كسُلفة ومرة كجزء من المرتب. التكلفة دي بتظهر **مرة واحدة** في الربح.
 *
 * مثال: أساسي ٥٠٠٠، بونص ٥٠٠، غياب ٣٠٠، خصم ٢٠٠ ⇒ التكلفة ٥٠٠٠. لو فيه سُلفة ٱلف،
 * التكلفة تفضل ٥٠٠٠ (المتبقّي للموظف ٤٠٠٠، لكن تكلفة النشاط ٥٠٠٠).
 */
export function salaryCostForProfit(item: SalaryCostInput): number {
  return (
    toNumber(item.baseSalary) +
    toNumber(item.overtimeAmount) +
    toNumber(item.bonuses) +
    toNumber(item.commissions) -
    toNumber(item.absenceDeduction) -
    toNumber(item.deductions)
  );
}

/**
 * تصنيف دورة رواتب تاريخية مقابل التعريف المعتمد الجديد — **تشخيص، مش تعديل**.
 *
 * المحرّك القديم كان بيستحق `totalGross` في أحداث `expense.accrued`. التعريف الجديد
 * (`salaryCostForProfit`) = إجمالي − غياب − خصومات. الفرق المتوقّع بين الاتنين هو
 * بالظبط (الغياب + الخصومات). التصنيف بيفرّق التلات حالات من غير ما يلمس أي حدث تاريخي:
 *
 *  • MATCHES: القديم = الجديد (مفيش غياب ولا خصومات في الدورة).
 *  • LEGACY_DIFFERENCE: الفرق = (غياب + خصومات) بالظبط — الفرق المنهجي المعروف، مفهوم.
 *  • AMBIGUOUS: الفرق حاجة تانية — محتاج نظرة بشرية (أحداث ناقصة، تعديل يدوي، ترحيل جزئي).
 *
 * القرار: مافيش backfill ولا كتابة على الأحداث دلوقتي. ده بيكتشف الفروقات ويصنّفها بس.
 */
export type PayrollHistoryVerdict =
  | "MATCHES"
  | "LEGACY_DIFFERENCE"
  | "AMBIGUOUS";

export function classifyPayrollHistory(input: {
  /** مجموع `salaryCostForProfit` لبنود الدورة (التعريف الجديد). */
  canonicalCost: number;
  /** مجموع مبالغ أحداث `expense.accrued` القديمة للدورة (totalGross). */
  legacyAccrued: number;
  /** مجموع (خصم الغياب + الخصومات) لبنود الدورة — الفرق المنهجي المتوقّع. */
  absencePlusDeductions: number;
  /** هامش التقريب. */
  tolerance?: number;
}): { verdict: PayrollHistoryVerdict; difference: number } {
  const tol = input.tolerance ?? 0.01;
  const difference =
    Math.round((input.legacyAccrued - input.canonicalCost) * 100) / 100;
  if (Math.abs(difference) < tol) return { verdict: "MATCHES", difference };
  if (Math.abs(difference - input.absencePlusDeductions) < tol)
    return { verdict: "LEGACY_DIFFERENCE", difference };
  return { verdict: "AMBIGUOUS", difference };
}

/**
 * أجر اليوم للمرتب الشهري.
 *
 * الأساس إعداد مش رقم ثابت: ٣٠٠٠ ÷ ٣٠ = ١٠٠، و٣٠٠٠ ÷ ٢٦ = ١١٥.٣٨. الفرق ده بيوصل
 * لفلوس حقيقية في جيب الموظف على مدار السنة، فالتاجر هو اللي بيقرره.
 */
export function dailyRateFromMonthly(
  baseSalary: number,
  settings: Pick<PayrollSettingsInput, "absenceDeductionBasis" | "workingDaysPerMonth">,
): number {
  const divisor = settings.absenceDeductionBasis === "calendar_days"
    ? 30
    : Math.max(1, settings.workingDaysPerMonth); // القسمة على صفر لو الإعداد اتساب فاضي
  return baseSalary / divisor;
}

/**
 * خصم الغياب.
 *
 * مسقوف بالمرتب الأساسي: غياب ٤٠ يوم في شهر ٢٦ يوم عمل كان هيطلع خصمًا أكبر من المرتب
 * نفسه وصافيًا سالبًا. الغياب الزيادة مسألة إدارية (إنهاء خدمة، إجازة بدون أجر) مش
 * رقم بيتحسب على المرتب ده.
 */
export function calcAbsenceDeduction(
  baseSalary: number,
  absenceDays: number,
  settings: Pick<PayrollSettingsInput, "absenceDeductionBasis" | "workingDaysPerMonth">,
): number {
  if (absenceDays <= 0 || baseSalary <= 0) return 0;
  const raw = dailyRateFromMonthly(baseSalary, settings) * absenceDays;
  return Math.min(raw, baseSalary);
}

/**
 * الأوفرتايم.
 *
 * في الوضع اليدوي بيتاخد المبلغ زي ما المستخدم كتبه — مفيش نظام حضور بيسجّل ساعات لسه.
 * في وضع المضاعف بيتحسب من أجر الساعة، وأجر الساعة نفسه مشتق من أجر اليوم.
 */
export function calcOvertime(
  baseSalary: number,
  line: Pick<PayrollLineInput, "overtimeHours" | "overtimeAmount">,
  settings: PayrollSettingsInput,
): number {
  if (settings.overtimeMode === "manual") return Math.max(0, line.overtimeAmount);
  const hours = Math.max(0, line.overtimeHours);
  if (hours === 0) return 0;
  const perDay = dailyRateFromMonthly(baseSalary, settings);
  const perHour = perDay / Math.max(1, toNumber(settings.workHoursPerDay));
  return perHour * hours * toNumber(settings.overtimeMultiplier);
}

/**
 * العمولة.
 *
 * `per_order` = مبلغ ثابت لكل أوردر مستحق. `percentage` = نسبة من إجمالي قيمة الأوردرات
 * المستحقة. أي حالة تانية (نوع مش متحدد، أو قيمة صفر) بترجّع صفر بدل ما ترمي — سطر
 * راتب بينهار لأن إعداد العمولة ناقص أسوأ من سطر عمولته صفر ومكتوب.
 */
export function calcCommission(
  profile: SalaryProfileInput,
  line: Pick<PayrollLineInput, "commissionOrderCount" | "commissionOrderTotal">,
): number {
  const value = toNumber(profile.commissionValue);
  if (value <= 0 || !profile.commissionType) return 0;
  if (profile.commissionType === "per_order") {
    return value * Math.max(0, line.commissionOrderCount);
  }
  return (Math.max(0, line.commissionOrderTotal) * value) / 100;
}

/** المرتب الأساسي المستحق قبل أي خصم — بيختلف باختلاف نوع الراتب. */
export function calcBaseSalary(profile: SalaryProfileInput, line: Pick<PayrollLineInput, "attendanceDays">): number {
  switch (profile.salaryType) {
    case "daily":
      return toNumber(profile.dailyRate) * Math.max(0, line.attendanceDays);
    case "commission":
      // العمولة الصافية مالهاش أساسي — الدخل كله من العمولة
      return 0;
    case "monthly":
    case "mixed":
    default:
      return toNumber(profile.baseSalary);
  }
}

export function applyRounding(amount: number, mode: RoundingMode): number {
  switch (mode) {
    case "nearest_1": return Math.round(amount);
    case "nearest_5": return Math.round(amount / 5) * 5;
    case "nearest_10": return Math.round(amount / 10) * 10;
    case "none":
    default:
      // منزلتان عشريتان — نفس دقة عمود decimal(10,2)، عشان الرقم المحفوظ يساوي المحسوب
      return Math.round(amount * 100) / 100;
  }
}

/**
 * حساب سطر راتب كامل.
 *
 * الصيغة معروضة كما هي في الواجهة، وده مقصود: الموظف لازم يقدر يراجع الرقم بنفسه.
 *
 *   الأساسي + الأوفرتايم + الحوافز + العمولة − خصم الغياب − خصومات أخرى − السُلف
 *
 * الصافي مش مسقوف عند الصفر: صافي سالب رقم صحيح (سُلف أكبر من المستحق) ولازم يبان
 * عشان يتسوّى، مش يتخبّى وراء صفر.
 */
/**
 * الصافي من مكوّناته — التعريف الوحيد للمعادلة في المشروع كله.
 *
 * اتفصلت من `calcPayrollLine` عشان شاشة تجهيز المرتبات تعرض نفس الرقم اللي السيرفر
 * هيحسبه بالظبط. لو كل واحدة كتبت المعادلة عندها، أول تعديل في واحدة بيخلي الشاشة
 * توري رقم والدفع ينزّل رقم تاني — والفرق مايظهرش غير بعد ما الفلوس تطلع.
 *
 * البونص والخصومات والسلف بتتقص عند صفر: قيمة سالبة معناها الخصم بقى إضافة، وده
 * بيقلب معنى الحقل من غير ما حد ياخد باله.
 */
export function netFromComponents(c: {
  baseSalary: number;
  overtimeAmount: number;
  bonuses: number;
  commissions: number;
  absenceDeduction: number;
  deductions: number;
  advances: number;
}): number {
  return (
    c.baseSalary +
    c.overtimeAmount +
    Math.max(0, c.bonuses) +
    c.commissions -
    c.absenceDeduction -
    Math.max(0, c.deductions) -
    Math.max(0, c.advances)
  );
}

export function calcPayrollLine(
  profile: SalaryProfileInput,
  line: PayrollLineInput,
  settings: PayrollSettingsInput,
): PayrollLineResult {
  const baseSalary = calcBaseSalary(profile, line);
  // الغياب بيتخصم من الشهري والمختلط بس — اليومي مابيتحسبش أصلاً غير على أيام الحضور،
  // فخصم الغياب منه كان هيبقى عقابًا مزدوجًا.
  const absenceDeduction = (profile.salaryType === "monthly" || profile.salaryType === "mixed")
    ? calcAbsenceDeduction(baseSalary, line.absenceDays, settings)
    : 0;
  const overtimeAmount = calcOvertime(baseSalary, line, settings);
  const commissions = profile.salaryType === "monthly"
    ? 0 // الشهري الصافي مالوش عمولة — لو التاجر عايز الاتنين يستخدم "مختلط"
    : calcCommission(profile, line);

  const net = netFromComponents({
    baseSalary,
    overtimeAmount,
    bonuses: line.bonuses,
    commissions,
    absenceDeduction,
    deductions: line.deductions,
    advances: line.advances,
  });

  return {
    baseSalary: applyRounding(baseSalary, "none"),
    absenceDeduction: applyRounding(absenceDeduction, "none"),
    overtimeAmount: applyRounding(overtimeAmount, "none"),
    commissions: applyRounding(commissions, "none"),
    netSalary: applyRounding(net, settings.roundingMode),
  };
}

/**
 * الحقول المحسوبة اللي إعادة الحساب مسموح لها تلمسها.
 *
 * أي حقل اسمه في `manualFields` بيتقفل. ده تنفيذ شرط "لا تكتب فوق التعديلات اليدوية":
 * من غيره كان أول ضغط على "إعادة حساب" بيمسح ساعة شغل يدوي من غير سؤال.
 */
export const RECALCULABLE_FIELDS = [
  "baseSalary", "absenceDeduction", "overtimeAmount", "commissions", "netSalary",
] as const;

export function parseManualFields(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    // JSON تالف مايوقفش دورة رواتب — بنتعامل معاه كأنه مفيش تعديلات يدوية
    return [];
  }
}

/**
 * يدمج نتيجة الحساب مع القيم المحفوظة، مع احترام الحقول المقفولة.
 *
 * `netSalary` له معاملة خاصة: لو المستخدم قفل حقلًا مكوّنًا (العمولة مثلاً) لكن مقفلش
 * الصافي، الصافي لازم يتحسب من جديد بالقيمة اليدوية — يعني بيتجمع من الأرقام النهائية
 * مش من الحساب الخام، وإلا كان بيعرض رقمًا مش مطابقًا لسطوره.
 */
export function mergeWithManualEdits(
  computed: PayrollLineResult,
  stored: PayrollLineResult,
  manualFields: string[],
  line: Pick<PayrollLineInput, "bonuses" | "deductions" | "advances">,
  roundingMode: RoundingMode,
): PayrollLineResult {
  const locked = new Set(manualFields);
  const pick = (field: keyof PayrollLineResult) =>
    locked.has(field) ? stored[field] : computed[field];

  const merged: PayrollLineResult = {
    baseSalary: pick("baseSalary"),
    absenceDeduction: pick("absenceDeduction"),
    overtimeAmount: pick("overtimeAmount"),
    commissions: pick("commissions"),
    netSalary: 0,
  };

  if (locked.has("netSalary")) {
    merged.netSalary = stored.netSalary;
  } else {
    merged.netSalary = applyRounding(
      merged.baseSalary + merged.overtimeAmount + Math.max(0, line.bonuses) + merged.commissions
        - merged.absenceDeduction - Math.max(0, line.deductions) - Math.max(0, line.advances),
      roundingMode,
    );
  }
  return merged;
}
