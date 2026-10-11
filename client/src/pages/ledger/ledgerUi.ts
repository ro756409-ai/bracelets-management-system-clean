import { fromMinorUnits, toMinorUnits } from "@shared/accountingMoney";

/**
 * منطق واجهة دفتر V3 — نقي (بلا React/tRPC) ليُختبر وحده:
 *   • العمليات اليومية الثلاث فقط (إيراد / مصروف / تحويل) وتكوين القيد الصحيح لكل منها — المستخدم
 *     لا يرى مدين/دائن ولا يختار kind؛ لا owner_drawing ولا أي نوع آخر من هنا.
 *   • عرض الحركة: المبلغ (مجموع المدين)، من/إلى من القيود، تسميات الأنواع.
 */
export type DailyOperation = "revenue" | "expense" | "transfer";

export type UiAccount = { id: number; code: string; name: string; kind: string; normalSide: "debit" | "credit"; isActive: number | boolean; currentBalance: string; isSystem: boolean };

/** حسابات يمكن أن تستقبل/تُخرج فلوسًا في العمليات اليومية (منها COD بوسطة كوجهة «إيراد تحصيل بوسطة»). */
export const MONEY_KINDS = new Set(["cash", "bank", "wallet", "carrier_receivable"]);
/** النقدية المتاحة فعلًا: خزنة + بنك + محافظ. COD بوسطة **ذمة على شركة الشحن** لا تُحسب ضمنها. */
export const CASH_KINDS = new Set(["cash", "bank", "wallet"]);
export const CARRIER_RECEIVABLE_KINDS = new Set(["carrier_receivable"]);
/** بطاقات الأرصدة بالترتيب المطلوب. */
export const BALANCE_CARD_CODES = ["OFFICE_CASH", "BANK_MAIN", "VF_CASH", "INSTAPAY", "COD_BOSTA"] as const;

export const OPERATION_META: Record<DailyOperation, { label: string; money: string; counter: string; kind: string }> = {
  revenue: { label: "تسجيل إيراد", money: "يدخل إلى", counter: "نوع الإيراد", kind: "revenue_prepaid" },
  expense: { label: "تسجيل مصروف", money: "يُدفع من", counter: "تصنيف المصروف", kind: "expense" },
  transfer: { label: "تحويل بين الخزن", money: "من", counter: "إلى", kind: "transfer" },
};

export const KIND_LABELS: Record<string, string> = {
  opening_balance: "رصيد افتتاحي", revenue_cod: "إيراد تحصيل بوسطة", revenue_prepaid: "إيراد", expense: "مصروف", payroll: "رواتب",
  advance: "سلفة", transfer: "تحويل", bosta_settlement: "تسوية بوسطة", owner_drawing: "مسحوبات المالك", owner_contribution: "إيداع المالك",
  adjustment: "تسوية", reversal: "عكس حركة",
};
export const kindLabel = (k: string) => KIND_LABELS[k] ?? k;

export const isActiveAccount = (a: UiAccount) => a.isActive === 1 || a.isActive === true;
export const moneyAccounts = (accounts: UiAccount[]) => accounts.filter(a => MONEY_KINDS.has(a.kind) && isActiveAccount(a));
export const cashAccounts = (accounts: UiAccount[]) => accounts.filter(a => CASH_KINDS.has(a.kind) && isActiveAccount(a));
export const carrierReceivables = (accounts: UiAccount[]) => accounts.filter(a => CARRIER_RECEIVABLE_KINDS.has(a.kind) && isActiveAccount(a));
/** مجموع النقدية المتاحة (4 خانات، BigInt — بلا أخطاء float) من أرصدة الدفتر نفسها. */
export function availableCash(accounts: UiAccount[]): string {
  const total = cashAccounts(accounts).reduce((sum, a) => sum + toMinorUnits(a.currentBalance), 0n);
  return fromMinorUnits(total);
}
export const revenueAccounts = (accounts: UiAccount[]) => accounts.filter(a => a.kind === "revenue" && isActiveAccount(a));
export const expenseAccounts = (accounts: UiAccount[]) => accounts.filter(a => a.kind === "expense" && isActiveAccount(a));

export const AMOUNT_RE = /^\d{1,14}(\.\d{1,4})?$/;

export type ComposedPost = {
  kind: "revenue_cod" | "revenue_prepaid" | "expense" | "transfer";
  sourceBusinessId: number | null;
  entries: { accountId: number; side: "debit" | "credit"; amount: string; businessId?: number | null }[];
};

/**
 * يكوّن القيد المتوازن من اختيار المستخدم:
 *   إيراد: مدين الحساب النقدي / دائن حساب الإيراد (نوع revenue_cod لو الحساب النقدي مستحقات بوسطة).
 *   مصروف: مدين تصنيف المصروف / دائن الحساب النقدي.
 *   تحويل: مدين الخزنة المستلمة / دائن الخزنة المصدر — على مستوى الشركة (بلا نشاط).
 */
export function composeDailyPost(
  op: DailyOperation,
  input: { businessId: number | null; moneyAccount: UiAccount; counterAccount: UiAccount; amount: string }
): ComposedPost {
  if (!AMOUNT_RE.test(input.amount) || Number(input.amount) <= 0) throw new Error("المبلغ رقم عشري موجب حتى 4 خانات");
  const { moneyAccount, counterAccount, amount } = input;
  if (moneyAccount.id === counterAccount.id) throw new Error("اختر حسابين مختلفين");
  if (!MONEY_KINDS.has(moneyAccount.kind)) throw new Error("الحساب النقدي غير صالح");
  if (op === "revenue") {
    if (counterAccount.kind !== "revenue") throw new Error("اختر نوع إيراد");
    if (input.businessId == null) throw new Error("اختر النشاط");
    return { kind: moneyAccount.code === "COD_BOSTA" ? "revenue_cod" : "revenue_prepaid", sourceBusinessId: input.businessId,
      entries: [{ accountId: moneyAccount.id, side: "debit", amount }, { accountId: counterAccount.id, side: "credit", amount }] };
  }
  if (op === "expense") {
    if (counterAccount.kind !== "expense") throw new Error("اختر تصنيف مصروف");
    if (input.businessId == null) throw new Error("اختر النشاط");
    return { kind: "expense", sourceBusinessId: input.businessId,
      entries: [{ accountId: counterAccount.id, side: "debit", amount }, { accountId: moneyAccount.id, side: "credit", amount }] };
  }
  if (!MONEY_KINDS.has(counterAccount.kind)) throw new Error("اختر خزنة مستلمة");
  return { kind: "transfer", sourceBusinessId: null,
    entries: [{ accountId: counterAccount.id, side: "debit", amount, businessId: null }, { accountId: moneyAccount.id, side: "credit", amount, businessId: null }] };
}

export type UiEntry = { accountId: number; side: "debit" | "credit"; amount: string; code?: string; name?: string };

/** مبلغ الحركة = مجموع المدين (BigInt بمقياس 4 خانات → نص). */
export function transactionAmount(entries: UiEntry[]): string {
  let total = 0n;
  for (const e of entries) if (e.side === "debit") total += toMinor(e.amount);
  return fromMinor(total);
}
/** من (الدائن) → إلى (المدين) — للعرض. */
export function transactionFlow(entries: UiEntry[]): { from: string[]; to: string[] } {
  return {
    from: entries.filter(e => e.side === "credit").map(e => e.name ?? e.code ?? `#${e.accountId}`),
    to: entries.filter(e => e.side === "debit").map(e => e.name ?? e.code ?? `#${e.accountId}`),
  };
}

const SCALE = 10000n;
function toMinor(v: string): bigint {
  const [w, f = ""] = String(v).split(".");
  return BigInt(w || "0") * SCALE + BigInt((f + "0000").slice(0, 4));
}
function fromMinor(v: bigint): string {
  const whole = v / SCALE, frac = (v % SCALE).toString().padStart(4, "0");
  return `${whole}.${frac}`;
}

export const money = (v: string | number) => Number(v || 0).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** اليوم بتوقيت القاهرة YYYY-MM-DD. */
export function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** معرّف عملية ثابت لكل فتح للنموذج — إعادة الضغط/الإرسال ترسل نفس المفتاح فلا تتكرر الحركة. */
export function newOperationId(): string {
  const c = (globalThis as any).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `ui:${id}`;
}
