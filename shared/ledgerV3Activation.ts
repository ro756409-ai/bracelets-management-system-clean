import { fromMinorUnits, toMinorUnits } from "./accountingMoney";

/**
 * ملف الأرصدة الافتتاحية لتفعيل Ledger V3 — تحليل **صارم** بلا تخمين:
 *   • المبالغ نصوص عشرية فقط (`"1000.50"`)؛ أي رقم JSON (float/int) يُرفض — لا تقريب ثنائي.
 *   • الأكواد مقصورة على الحسابات النقدية الأساسية؛ كود مجهول = رفض.
 *   • `openingEquity` اختياري: إن وُجد وجب أن يساوي مجموع النقديات (القيد الافتتاحي متوازن) وإلا رفض.
 *   • مفاتيح غير معروفة = رفض (تكشف الأخطاء الإملائية بدل تجاهلها بصمت).
 * لا يقرأ من قاعدة ولا يطبع شيئًا؛ يُختبر وحده.
 */
export const OPENING_AMOUNT_RE = /^\d{1,14}(\.\d{1,4})?$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TOP_KEYS = new Set(["goLiveDate", "currency", "openingBalances", "openingEquity", "businessIds", "safeGrants", "reconciliation"]);
const RECON_KEYS = new Set(["reportGeneratedAt", "approvedByEmployeeId", "approvedAt", "acknowledgedDifferences"]);

export type OpeningReconciliation = { reportGeneratedAt: string; approvedByEmployeeId: number; approvedAt: string; acknowledgedDifferences: boolean };
export type OpeningFile = {
  goLiveDate: string;
  currency: string;
  /** كود الحساب النقدي → مبلغ عشري نصي (قد يكون "0") */
  openingBalances: Record<string, string>;
  /** دائن الرصيد الافتتاحي إن ذُكر صراحةً — يجب أن يساوي مجموع النقديات */
  openingEquity: string | null;
  /** الأنشطة المفعَّلة؛ null = كل الأنشطة النشطة للشركة */
  businessIds: number[] | null;
  /** الخزن: كود → أنشطة؛ null = كل الأنشطة المفعَّلة لكل خزنة */
  safeGrants: Record<string, number[]> | null;
  reconciliation: OpeningReconciliation | null;
};
export type ParsedOpening = { ok: true; file: OpeningFile; total: string } | { ok: false; errors: string[] };

export function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseOpeningFile(raw: unknown, moneyCodes: readonly string[]): ParsedOpening {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ["الملف يجب أن يكون كائن JSON"] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) errors.push(`مفتاح غير معروف: ${k}`);

  const goLiveDate = raw.goLiveDate;
  if (!isValidIsoDate(goLiveDate)) errors.push("goLiveDate مطلوب بصيغة YYYY-MM-DD");

  let currency = "EGP";
  if (raw.currency !== undefined) {
    if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) errors.push("currency يجب أن يكون 3 أحرف كبيرة (مثل EGP)");
    else currency = raw.currency;
  }

  const openingBalances: Record<string, string> = {};
  let total = 0n;
  if (!isPlainObject(raw.openingBalances)) errors.push("openingBalances مطلوب (كائن: كود → مبلغ نصي)");
  else {
    for (const [code, value] of Object.entries(raw.openingBalances)) {
      if (!moneyCodes.includes(code)) { errors.push(`حساب مجهول في openingBalances: ${code} (المسموح: ${moneyCodes.join(", ")})`); continue; }
      if (typeof value !== "string") { errors.push(`${code}: المبلغ يجب أن يكون نصًا عشريًا مثل "1000.50" — لا أرقام JSON (float)`); continue; }
      if (!OPENING_AMOUNT_RE.test(value)) { errors.push(`${code}: مبلغ غير صالح "${value}" (حتى 14 خانة و4 كسور، بلا سالب)`); continue; }
      openingBalances[code] = value;
      total += toMinorUnits(value);
    }
  }

  let openingEquity: string | null = null;
  if (raw.openingEquity !== undefined && raw.openingEquity !== null) {
    if (typeof raw.openingEquity !== "string" || !OPENING_AMOUNT_RE.test(raw.openingEquity)) errors.push("openingEquity يجب أن يكون نصًا عشريًا");
    else {
      openingEquity = raw.openingEquity;
      if (toMinorUnits(openingEquity) !== total)
        errors.push(`القيد الافتتاحي غير متوازن: مجموع النقديات ${fromMinorUnits(total)} ≠ openingEquity ${fromMinorUnits(toMinorUnits(openingEquity))}`);
    }
  }

  let businessIds: number[] | null = null;
  if (raw.businessIds !== undefined && raw.businessIds !== null) {
    if (!Array.isArray(raw.businessIds) || raw.businessIds.length === 0 || !raw.businessIds.every(isPosInt)) errors.push("businessIds يجب أن تكون قائمة أعداد صحيحة موجبة غير فارغة");
    else businessIds = [...new Set(raw.businessIds as number[])];
  }

  let safeGrants: Record<string, number[]> | null = null;
  if (raw.safeGrants !== undefined && raw.safeGrants !== null) {
    if (!isPlainObject(raw.safeGrants)) errors.push("safeGrants يجب أن يكون كائنًا: كود خزنة → قائمة أنشطة");
    else {
      safeGrants = {};
      for (const [code, ids] of Object.entries(raw.safeGrants)) {
        if (!moneyCodes.includes(code)) { errors.push(`حساب مجهول في safeGrants: ${code}`); continue; }
        if (!Array.isArray(ids) || !ids.every(isPosInt)) { errors.push(`safeGrants.${code}: قائمة أعداد صحيحة موجبة`); continue; }
        safeGrants[code] = [...new Set(ids as number[])];
      }
    }
  }

  let reconciliation: OpeningReconciliation | null = null;
  if (raw.reconciliation !== undefined && raw.reconciliation !== null) {
    const r = raw.reconciliation;
    if (!isPlainObject(r)) errors.push("reconciliation يجب أن يكون كائنًا");
    else {
      for (const k of Object.keys(r)) if (!RECON_KEYS.has(k)) errors.push(`reconciliation: مفتاح غير معروف ${k}`);
      const okGen = typeof r.reportGeneratedAt === "string" && r.reportGeneratedAt.trim().length > 0;
      const okAt = typeof r.approvedAt === "string" && r.approvedAt.trim().length > 0;
      const okBy = isPosInt(r.approvedByEmployeeId);
      const okAck = r.acknowledgedDifferences === undefined || typeof r.acknowledgedDifferences === "boolean";
      if (!okGen) errors.push("reconciliation.reportGeneratedAt مطلوب (نص)");
      if (!okAt) errors.push("reconciliation.approvedAt مطلوب (نص)");
      if (!okBy) errors.push("reconciliation.approvedByEmployeeId مطلوب (معرّف موظف)");
      if (!okAck) errors.push("reconciliation.acknowledgedDifferences يجب أن يكون boolean");
      if (okGen && okAt && okBy && okAck)
        reconciliation = { reportGeneratedAt: r.reportGeneratedAt as string, approvedByEmployeeId: r.approvedByEmployeeId as number, approvedAt: r.approvedAt as string, acknowledgedDifferences: r.acknowledgedDifferences === true };
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, total: fromMinorUnits(total), file: { goLiveDate: goLiveDate as string, currency, openingBalances, openingEquity, businessIds, safeGrants, reconciliation } };
}

/** عبارة التأكيد الإلزامية لـ--apply: تتضمن tenantId وتاريخ Go-Live حرفيًا. */
export const confirmationPhrase = (tenantId: number, goLiveDate: string) => `ACTIVATE LEDGER V3 TENANT ${tenantId} GO-LIVE ${goLiveDate}`;
