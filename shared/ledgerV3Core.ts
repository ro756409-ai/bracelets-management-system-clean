import { createHash } from "crypto";
import { fromMinorUnits, toMinorUnits } from "./accountingMoney";

/**
 * Ledger V3 — القواعد النقية (بلا قاعدة بيانات): التحقق من القيود، التوازن بدقة Decimal (BigInt
 * بمقياس 4 خانات)، معادلة الرصيد حسب `normalSide`، الفترة المشتقة من التاريخ، والـpayloadHash
 * القانوني. تُختبر وحدها بأرقام مكسورة عمدًا.
 */
export const LEDGER_KINDS = [
  "opening_balance", "revenue_cod", "revenue_prepaid", "expense", "payroll", "advance", "transfer",
  "bosta_settlement", "owner_drawing", "owner_contribution", "adjustment", "reversal",
  // المرحلة 2: شراء بضاعة/خامات = أصل مخزون (لا مصروف) — التكلفة تُعترف بها عند البيع من لقطة التكلفة
  "inventory_purchase",
  // المرحلة 3/4: تكلفة المبيعات عند التسليم من لقطة تكلفة الأوردر، وخسارة مرتجع بعد التسليم (لا تضخيم للربح)
  "cost_of_sales", "return_loss",
  // مرتجع بعد التسليم: التزام رد للعميل (بعد التحصيل)، ونقل التكلفة لـ«مرتجعات قيد الفحص»، ورد المبلغ للعميل
  "return_refund", "return_cost", "customer_refund",
  // المرحلة 4: استهلاك التغليف عند التسليم لمندوب الشحن (تكلفة أوردر من مخزون التغليف)
  "packaging_consumption",
  // المرحلة 6: مستندات الموردين وأحداث الورشة
  "supplier_invoice", "supplier_payment", "supplier_advance", "supplier_advance_apply", "supplier_return", "workshop",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export type LedgerSide = "debit" | "credit";
export type LedgerActor =
  | { type: "employee"; employeeId: number }
  | { type: "system"; employeeId?: null }
  | { type: "webhook"; employeeId?: null };

export type LedgerEntryInput = { accountId: number; side: LedgerSide; amount: string; businessId?: number | null };

/** رسائل عربية ثابتة لكل رفض. */
export const LEDGER_MESSAGES = {
  disabled: "دفتر الحسابات V3 غير مفعّل لهذه الشركة",
  unavailable: "جداول دفتر الحسابات V3 غير موجودة — لم تُطبَّق الترحيلة 0040",
  kind: "نوع الحركة غير مسموح",
  entriesMin: "القيد يحتاج سطرين على الأقل على حسابين مختلفين",
  amount: "كل مبلغ يجب أن يكون رقمًا عشريًا موجبًا حتى 4 خانات",
  unbalanced: "القيد غير متوازن: مجموع المدين لا يساوي مجموع الدائن",
  currency: "العملة غير صالحة أو لا تطابق عملة الحسابات",
  date: "تاريخ الحركة غير صالح (YYYY-MM-DD)",
  periodLocked: "الفترة المحاسبية مقفولة — لا تُقبل حركات بتاريخ داخلها ولا يُعاد تأريخها",
  conflict: "نفس معرّف العملية أُعيد استخدامه ببيانات مختلفة — رُفض لمنع تسجيل حركة خاطئة",
  business: "النشاط غير تابع لهذه الشركة أو غير موجود",
  account: "حساب غير موجود أو غير تابع لهذه الشركة",
  accountInactive: "الحساب موقوف ولا يقبل حركات",
  grant: "النشاط غير مصرح له باستخدام هذا الحساب",
  outOfScope: "الحساب أو النشاط خارج نطاق صلاحياتك — لا يمكنك الترحيل أو التحويل أو العكس عليه",
  beforeGoLive: "تاريخ الحركة قبل تاريخ بداية العمل بالدفتر (Go-live) — غير مسموح",
  futurePeriod: "لا يمكن إقفال شهر لم يبدأ بعد بتوقيت الشركة",
  negative: "الرصيد لا يسمح بأن يكون سالبًا لهذا الحساب",
  actorEmployee: "الفاعل من نوع موظف يتطلب موظفًا فعّالًا تابعًا لنفس الشركة",
  actorSystem: "فاعل النظام أو الـwebhook لا يحمل معرّف موظف",
  reason: "السبب إلزامي ولا يجوز أن يكون فارغًا",
  reopenRole: "إعادة فتح الفترة وتعطيل الدفتر يتطلبان فاعلًا موظفًا معتمدًا (الصلاحية تُفحص على السيرفر)",
  reversedAlready: "هذه الحركة معكوسة بالفعل — لا تُعكس مرتين",
  transaction: "الحركة غير موجودة أو غير تابعة لهذه الشركة",
  periodNotFound: "الفترة غير موجودة",
  alreadyEnabled: "دفتر V3 مفعّل بالفعل لهذه الشركة بتاريخ بدء مختلف",
  activationInput: "التفعيل يتطلب اعتماد تقرير المطابقة وأرصدة افتتاحية صريحة",
  // التفعيل على مستوى الشركة كلها (العلم في ledger_tenant_flags): كل نشاط فعّال يجب أن يكون في الخطة
  activationScope: "لا يمكن تفعيل دفتر الشركة",
  kindShape: "بنية القيد لا تطابق نوع الحركة",
  setting: "قيمة الإعداد غير صالحة",
  invalid: "بيانات ناقصة أو غير صالحة",
} as const;

export class LedgerError extends Error {
  constructor(public readonly code: keyof typeof LEDGER_MESSAGES, detail?: string) {
    super(detail ? `${LEDGER_MESSAGES[code]}: ${detail}` : LEDGER_MESSAGES[code]);
    this.name = "LedgerError";
  }
}

const AMOUNT_RE = /^\d{1,14}(\.\d{1,4})?$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function parseAmountMinor(raw: string): bigint {
  if (typeof raw !== "string" || !AMOUNT_RE.test(raw)) throw new LedgerError("amount", String(raw));
  const minor = toMinorUnits(raw);
  if (minor <= 0n) throw new LedgerError("amount", raw);
  return minor;
}

export function assertEffectiveDate(d: string): void {
  if (typeof d !== "string" || !DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new LedgerError("date", String(d));
}

/** الفترة مشتقة على السيرفر من التاريخ — لا تُقبل من العميل أبدًا. */
export function postingPeriodOf(effectiveDate: string): string {
  assertEffectiveDate(effectiveDate);
  return effectiveDate.slice(0, 7);
}

export function assertCurrency(c: string): void {
  if (!CURRENCY_RE.test(c)) throw new LedgerError("currency", c);
}

export type ValidatedEntry = { accountId: number; side: LedgerSide; amountMinor: bigint; amount: string; businessId: number | null };

/** سطران مختلفان على الأقل، كل مبلغ > 0، والتوازن حرفيًا بالـBigInt. */
export function validateEntries(entries: LedgerEntryInput[], defaultBusinessId: number | null): ValidatedEntry[] {
  if (!Array.isArray(entries) || entries.length < 2) throw new LedgerError("entriesMin");
  const out: ValidatedEntry[] = [];
  let debit = 0n, credit = 0n;
  for (const e of entries) {
    if (!Number.isInteger(e.accountId) || e.accountId <= 0) throw new LedgerError("account", String(e.accountId));
    if (e.side !== "debit" && e.side !== "credit") throw new LedgerError("entriesMin");
    const amountMinor = parseAmountMinor(e.amount);
    if (e.side === "debit") debit += amountMinor; else credit += amountMinor;
    const businessId = e.businessId === undefined ? defaultBusinessId : e.businessId;
    if (businessId != null && (!Number.isInteger(businessId) || businessId <= 0)) throw new LedgerError("business", String(businessId));
    out.push({ accountId: e.accountId, side: e.side, amountMinor, amount: fromMinorUnits(amountMinor), businessId });
  }
  if (new Set(out.map(e => e.accountId)).size < 2) throw new LedgerError("entriesMin");
  if (debit !== credit) throw new LedgerError("unbalanced", `${fromMinorUnits(debit)} ≠ ${fromMinorUnits(credit)}`);
  return out;
}

/** الرصيد الجديد حسب الجانب الطبيعي للحساب. */
export function applyToBalance(balanceMinor: bigint, normalSide: LedgerSide, side: LedgerSide, amountMinor: bigint): bigint {
  return side === normalSide ? balanceMinor + amountMinor : balanceMinor - amountMinor;
}

/** الرصيد المحسوب من القيود (للمطابقة). */
export function computeBalanceFromEntries(normalSide: LedgerSide, entries: { side: LedgerSide; amount: string }[]): bigint {
  let b = 0n;
  for (const e of entries) b = applyToBalance(b, normalSide, e.side, toMinorUnits(e.amount));
  return b;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
}

/** تطبيع الوصف قبل الهاش: تشذيب الطرفين وضغط المسافات المتتالية إلى مسافة واحدة. */
export function normalizeDescription(d: string | null | undefined): string {
  return String(d ?? "").replace(/\s+/g, " ").trim();
}

/**
 * الحمولة القانونية = النوع، النشاط، التاريخ، العملة، القيود بترتيب ثابت، الأصل المعكوس، المصدر،
 * **الوصف المطبَّع، ونوع الفاعل ومعرّفه**. لا تشمل postingPeriod/balanceAfter/currentBalance (مشتقة
 * من السيرفر). النتيجة: نفس المفتاح ونفس كل البيانات = replay؛ أي اختلاف (مالي أو وصف أو مصدر أو
 * فاعل) = CONFLICT.
 */
export function canonicalPayloadHash(p: {
  kind: string; sourceBusinessId: number | null; effectiveDate: string; currency: string;
  entries: ValidatedEntry[]; reversalOfTransactionId: number | null; sourceType: string | null; sourceReference: string | null;
  description: string; actorType: LedgerActor["type"]; actorEmployeeId: number | null;
}): string {
  const entries = p.entries
    .map(e => ({ a: e.accountId, s: e.side, m: e.amount, b: e.businessId }))
    .sort((x, y) => x.a - y.a || x.s.localeCompare(y.s) || x.m.localeCompare(y.m) || (x.b ?? 0) - (y.b ?? 0));
  return createHash("sha256").update(stableJson({
    kind: p.kind, sourceBusinessId: p.sourceBusinessId, effectiveDate: p.effectiveDate, currency: p.currency,
    entries, reversalOfTransactionId: p.reversalOfTransactionId, sourceType: p.sourceType, sourceReference: p.sourceReference,
    description: normalizeDescription(p.description), actorType: p.actorType, actorEmployeeId: p.actorEmployeeId,
  })).digest("hex");
}

export function assertActorShape(actor: LedgerActor): void {
  if (actor.type === "employee") {
    if (!Number.isInteger(actor.employeeId) || actor.employeeId <= 0) throw new LedgerError("actorEmployee");
  } else if (actor.type === "system" || actor.type === "webhook") {
    if (actor.employeeId != null) throw new LedgerError("actorSystem");
  } else throw new LedgerError("actorSystem");
}

/** سطر مطابقة لحساب واحد. */
export type LedgerReconLine = {
  accountId: number; code: string; name: string; normalSide: LedgerSide; stored: string; computed: string; difference: string;
  entries: number; lastEntryAt: string | null; ok: boolean;
};
export function reconcileAccount(
  account: { id: number; code: string; name: string; normalSide: LedgerSide; currentBalance: string },
  entries: { side: LedgerSide; amount: string; createdAt: Date | string | null }[]
): LedgerReconLine {
  const computed = computeBalanceFromEntries(account.normalSide, entries);
  const stored = toMinorUnits(account.currentBalance);
  let lastAt: Date | null = null;
  for (const e of entries) if (e.createdAt != null) { const d = new Date(e.createdAt); if (!lastAt || d > lastAt) lastAt = d; }
  return {
    accountId: account.id, code: account.code, name: account.name, normalSide: account.normalSide,
    stored: fromMinorUnits(stored), computed: fromMinorUnits(computed), difference: fromMinorUnits(stored - computed),
    entries: entries.length, lastEntryAt: lastAt ? lastAt.toISOString() : null, ok: stored === computed,
  };
}

/** حسابات المخزون/التكلفة لا تُستخدم إلا بأنواع حركة محددة — يمنع تسجيل الشراء كمصروف أو المصروف كمخزون. */
const STOCK_KINDS = new Set(["inventory", "cogs"]);
const PURCHASE_CREDIT_KINDS = new Set(["cash", "bank", "wallet", "supplier_payable"]);

/**
 * فحص بنية القيد حسب نوع الحركة (على السيرفر، بعد تحميل الحسابات):
 *  • expense: لا يلمس مخزونًا ولا تكلفة مبيعات — شراء البضاعة/الخامات ليس مصروفًا تشغيليًا.
 *  • inventory_purchase: كل المدين على حسابات مخزون، وكل الدائن من خزن/بنوك/محافظ أو مستحقات مورد؛ بلا مصروف أو إيراد.
 * لا يمس الأنواع الأخرى (عكس/افتتاحي/تحويل…) — قواعدها كما هي.
 */
export function assertKindShape(kind: string, entries: { accountId: number; side: LedgerSide }[], kindOf: (accountId: number) => string | undefined): void {
  if (kind === "expense") {
    for (const e of entries) if (STOCK_KINDS.has(kindOf(e.accountId) ?? "")) throw new LedgerError("kindShape", "المصروف لا يُسجَّل على حساب مخزون أو تكلفة — استخدم «شراء بضاعة/خامات»");
  }
  if (kind === "packaging_consumption") {
    for (const e of entries) {
      const k = kindOf(e.accountId) ?? "";
      if (e.side === "debit" && k !== "cogs") throw new LedgerError("kindShape", "استهلاك التغليف مدين على حساب تكلفة فقط");
      if (e.side === "credit" && k !== "inventory") throw new LedgerError("kindShape", "استهلاك التغليف دائن على حساب مخزون فقط");
    }
  }
  if (kind === "inventory_purchase") {
    for (const e of entries) {
      const k = kindOf(e.accountId) ?? "";
      if (e.side === "debit" && k !== "inventory") throw new LedgerError("kindShape", "الشراء يُسجَّل مدينًا على حساب مخزون فقط");
      if (e.side === "credit" && !PURCHASE_CREDIT_KINDS.has(k)) throw new LedgerError("kindShape", "الشراء يُدفع من خزنة/بنك/محفظة أو يُسجَّل مستحقًا لمورد");
    }
  }
}
