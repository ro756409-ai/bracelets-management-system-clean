import { divideRounded, fromMinorUnits, percentageOf, toMinorUnits } from "./accountingMoney";

/**
 * إعدادات الدفتر المُدخلة (جدول ledger_settings من 0047) — لا قيمة افتراضية مخمّنة أبدًا: الإعداد الغائب = «غير مُدخل»،
 * وكل حساب يعتمد عليه يرجع null (لا توقع) بدل صفر. الكشف الفعلي هو الحقيقة دائمًا؛ الإعداد للمقارنة والتنبيه فقط.
 */
export type LedgerSettingDef = {
  key: string;
  label: string;
  hint: string;
  type: "decimal" | "percent" | "weekdays" | "minutes";
  /** company = للشركة كلها (scopeBusinessId = 0)؛ business = لكل نشاط. */
  scope: "company" | "business";
};

export const LEDGER_SETTINGS: readonly LedgerSettingDef[] = [
  { key: "carrier.bosta.payout_weekdays", label: "أيام صرف بوسطة", hint: "الأيام التي تحوّل فيها بوسطة صافي الكشف", type: "weekdays", scope: "company" },
  { key: "carrier.bosta.fee_per_shipment", label: "رسوم الشحنة المسلَّمة", hint: "رسوم ثابتة لكل شحنة مسلَّمة كما في عقد بوسطة", type: "decimal", scope: "company" },
  { key: "carrier.bosta.return_fee", label: "رسوم الشحنة المرتجعة", hint: "رسوم الشحنة التي ترجع", type: "decimal", scope: "company" },
  { key: "carrier.bosta.cod_fee_percent", label: "نسبة رسوم التحصيل %", hint: "نسبة من مبلغ التحصيل (إن وُجدت في العقد)", type: "percent", scope: "company" },
  { key: "carrier.bosta.vat_percent", label: "ضريبة على الرسوم %", hint: "ضريبة القيمة المضافة على رسوم الشحن", type: "percent", scope: "company" },
  { key: "payroll.late_grace_minutes", label: "سماح التأخير الشهري (دقيقة)", hint: "وجوده يفعّل خصم التأخير بعد السماح؛ غيابه = لا خصم تأخير", type: "minutes", scope: "business" },
  { key: "packaging.cost_per_order", label: "تكلفة التغليف للأوردر", hint: "تُحمَّل عند تسليم الأوردر لمندوب الشحن، من مخزون التغليف", type: "decimal", scope: "business" },
] as const;

export const WEEKDAY_LABELS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] as const;

export const settingDef = (key: string): LedgerSettingDef | undefined => LEDGER_SETTINGS.find(s => s.key === key);

const DECIMAL_RE = /^\d{1,14}(\.\d{1,4})?$/;

/** تحقق قيمة إعداد → { valueDecimal } أو { valueInt }، أو رسالة خطأ عربية. */
export function validateSettingValue(def: LedgerSettingDef, raw: string | number): { valueDecimal: string | null; valueInt: number | null } | { error: string } {
  if (def.type === "minutes") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: "عدد دقائق صحيح من 0 إلى 10000" };
    return { valueDecimal: null, valueInt: n };
  }
  if (def.type === "weekdays") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 127) return { error: "اختر يومًا واحدًا على الأقل" };
    return { valueDecimal: null, valueInt: n };
  }
  const s = String(raw).trim();
  if (!DECIMAL_RE.test(s)) return { error: "قيمة عشرية موجبة حتى 4 خانات" };
  if (def.type === "percent" && toMinorUnits(s) > toMinorUnits("100")) return { error: "النسبة بين 0 و100" };
  return { valueDecimal: fromMinorUnits(toMinorUnits(s)), valueInt: null };
}

export type SettingValues = Partial<Record<string, string | number>>;

/**
 * الرسوم المتوقعة لسطر كشف من الإعدادات: (رسوم ثابتة للتسليم أو للمرتجع) + نسبة التحصيل، ثم الضريبة على المجموع.
 * null = لا توقع (الرسوم الثابتة المناسبة غير مُدخلة) — لا مقارنة ولا تخمين.
 */
export function expectedCarrierFees(values: SettingValues, cod: string, isReturn: boolean): string | null {
  const fixed = values[isReturn ? "carrier.bosta.return_fee" : "carrier.bosta.fee_per_shipment"];
  if (fixed == null) return null;
  let fee = toMinorUnits(String(fixed));
  const codPct = values["carrier.bosta.cod_fee_percent"];
  if (codPct != null && !isReturn) fee += percentageOf(cod, String(codPct));
  const vat = values["carrier.bosta.vat_percent"];
  if (vat != null) fee += percentageOf(fromMinorUnits(fee), String(vat));
  return fromMinorUnits(fee);
}

/** المقارنة بالقرش (خانتان): كشوف بوسطة مقرّبة لقرشين، فلا تنبيه على فرق أقل من نصف قرش. */
export const sameToPiaster = (a: string, b: string): boolean =>
  divideRounded(toMinorUnits(a), 100n) === divideRounded(toMinorUnits(b), 100n);

/** أول يوم صرف في/بعد تاريخ الكشف (YYYY-MM-DD) حسب قناع الأيام (bit0 = الأحد)؛ null بلا إعداد. */
export function nextPayoutDate(statementDate: string, weekdaysMask: number | null | undefined): string | null {
  if (!weekdaysMask) return null;
  const [y, m, d] = statementDate.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 7; i++) {
    const t = new Date(base + i * 86_400_000);
    if (weekdaysMask & (1 << t.getUTCDay())) return t.toISOString().slice(0, 10);
  }
  return null;
}

export const weekdaysText = (mask: number | null | undefined): string =>
  !mask ? "غير مُدخل" : WEEKDAY_LABELS.filter((_, i) => mask & (1 << i)).join("، ");
