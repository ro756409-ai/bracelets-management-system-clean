import { SYSTEM_POSTED_CODES } from "@shared/ledgerDailyAccounts";
import { fromMinorUnits, toMinorUnits } from "@shared/accountingMoney";

/**
 * منطق واجهة دفتر V3 — نقي (بلا React/tRPC) ليُختبر وحده:
 *   • العمليات اليومية الثلاث فقط (إيراد / مصروف / تحويل) وتكوين القيد الصحيح لكل منها — المستخدم
 *     لا يرى مدين/دائن ولا يختار kind؛ لا owner_drawing ولا أي نوع آخر من هنا.
 *   • عرض الحركة: المبلغ (مجموع المدين)، من/إلى من القيود، تسميات الأنواع.
 */
export type DailyOperation = "revenue" | "expense" | "transfer" | "purchase";

/** currentBalance = null حين يحجبه السيرفر عن نطاق المحاسب (حساب مشترك مع نشاط آخر أو عليه قيود الشركة). */
export type UiAccount = { id: number; code: string; name: string; kind: string; normalSide: "debit" | "credit"; isActive: number | boolean; currentBalance: string | null; balanceHidden?: boolean; isSystem: boolean };

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
  // المرحلة 2: شراء بضاعة/خامات = أصل مخزون (ليس مصروفًا) — التكلفة تُعترف بها عند البيع
  purchase: { label: "شراء بضاعة/خامات", money: "يُدفع من", counter: "نوع المخزون", kind: "inventory_purchase" },
};

export const KIND_LABELS: Record<string, string> = {
  opening_balance: "رصيد افتتاحي", revenue_cod: "إيراد تحصيل بوسطة", revenue_prepaid: "إيراد", expense: "مصروف", payroll: "رواتب",
  advance: "سلفة", transfer: "تحويل", bosta_settlement: "تسوية بوسطة", owner_drawing: "مسحوبات المالك", owner_contribution: "إيداع المالك",
  adjustment: "تسوية", reversal: "عكس حركة", inventory_purchase: "شراء بضاعة/خامات", cost_of_sales: "تكلفة مبيعات", return_loss: "خسارة مرتجع", return_refund: "التزام رد مرتجع", return_cost: "تكلفة مرتجع قيد الفحص", customer_refund: "رد مبلغ لعميل", packaging_consumption: "استهلاك تغليف", supplier_invoice: "فاتورة مورد", supplier_payment: "دفعة لمورد", supplier_advance: "دفعة مقدمة لمورد", supplier_advance_apply: "تطبيق مقدّم مورد", supplier_return: "مرتجع لمورد", workshop: "ورشة",
};
export const kindLabel = (k: string) => KIND_LABELS[k] ?? k;

export const isActiveAccount = (a: UiAccount) => a.isActive === 1 || a.isActive === true;
export const moneyAccounts = (accounts: UiAccount[]) => accounts.filter(a => MONEY_KINDS.has(a.kind) && isActiveAccount(a));
export const cashAccounts = (accounts: UiAccount[]) => accounts.filter(a => CASH_KINDS.has(a.kind) && isActiveAccount(a));
export const carrierReceivables = (accounts: UiAccount[]) => accounts.filter(a => CARRIER_RECEIVABLE_KINDS.has(a.kind) && isActiveAccount(a));
/** مجموع النقدية المتاحة (4 خانات، BigInt — بلا أخطاء float) من أرصدة الدفتر نفسها. null = أحد الأرصدة محجوب عن النطاق فلا إجمالي. */
export function availableCash(accounts: UiAccount[]): string | null {
  const list = cashAccounts(accounts);
  if (list.some(a => a.currentBalance == null)) return null;
  return fromMinorUnits(list.reduce((sum, a) => sum + toMinorUnits(a.currentBalance as string), 0n));
}
/** عرض رصيد/إجمالي: المحجوب يظهر «محجوب عن نطاقك» لا صفرًا. */
export const HIDDEN_BALANCE_LABEL = "محجوب عن نطاقك";
export const balanceText = (v: string | null) => (v == null ? HIDDEN_BALANCE_LABEL : `${money(v)} ج.م`);
/** ذمة COD على شركات الشحن (BigInt) — تُعرض منفصلة ولا تدخل في النقدية المتاحة. */
export function codReceivableTotal(accounts: UiAccount[]): string | null {
  const list = carrierReceivables(accounts);
  if (list.some(a => a.currentBalance == null)) return null;
  return fromMinorUnits(list.reduce((sum, a) => sum + toMinorUnits(a.currentBalance as string), 0n));
}
// الحسابات التي تُرحَّل آليًا (رسوم الشحن، خسائر المرتجع، فروق الجرد، إيراد الشحن، مرتجعات قيد الفحص…) لا تظهر للإدخال اليدوي
const manual = (a: UiAccount) => !SYSTEM_POSTED_CODES.has(a.code) && isActiveAccount(a);
export const revenueAccounts = (accounts: UiAccount[]) => accounts.filter(a => a.kind === "revenue" && manual(a));
export const expenseAccounts = (accounts: UiAccount[]) => accounts.filter(a => a.kind === "expense" && manual(a));
export const inventoryAccounts = (accounts: UiAccount[]) => accounts.filter(a => a.kind === "inventory" && manual(a));

export const AMOUNT_RE = /^\d{1,14}(\.\d{1,4})?$/;

export type ComposedPost = {
  kind: "revenue_cod" | "revenue_prepaid" | "expense" | "transfer" | "inventory_purchase";
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
  if (op === "purchase") {
    if (counterAccount.kind !== "inventory") throw new Error("اختر حساب مخزون (بضاعة أو خامات)");
    if (moneyAccount.kind === "carrier_receivable") throw new Error("الشراء يُدفع من خزنة أو بنك أو محفظة");
    if (input.businessId == null) throw new Error("اختر النشاط");
    return { kind: "inventory_purchase", sourceBusinessId: input.businessId,
      entries: [{ accountId: counterAccount.id, side: "debit", amount }, { accountId: moneyAccount.id, side: "credit", amount }] };
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

/* ───────────── المرحلة 1: إدارة الحسابات ───────────── */

/** أنواع الحسابات التي تُنشأ من الواجهة (الجانب الطبيعي مشتق من النوع — المستخدم لا يختار مدين/دائن). */
export const CREATABLE_ACCOUNT_KINDS = [
  { kind: "expense", label: "تصنيف مصروف", prefix: "EXP" },
  { kind: "revenue", label: "نوع إيراد", prefix: "REV" },
  { kind: "cash", label: "خزنة نقدية", prefix: "CASH" },
  { kind: "bank", label: "حساب بنكي", prefix: "BANK" },
  { kind: "wallet", label: "محفظة إلكترونية", prefix: "WALLET" },
  { kind: "carrier_receivable", label: "مستحقات شركة شحن (COD)", prefix: "COD" },
] as const;
export type CreatableAccountKind = (typeof CREATABLE_ACCOUNT_KINDS)[number]["kind"];

export const ACCOUNT_KIND_LABELS: Record<string, string> = {
  cash: "خزنة نقدية", bank: "بنك", wallet: "محفظة", carrier_receivable: "ذمة شركة شحن (COD)", revenue: "إيراد", expense: "مصروف",
  equity: "حقوق ملكية", suspense: "حساب معلّق", employee_receivable: "ذمم موظفين", supplier_payable: "موردون", customer_advance: "مقدمات عملاء",
  owner_current: "جاري المالك", cogs: "تكلفة مبيعات", inventory: "مخزون", payroll_payable: "رواتب مستحقة", supplier_advance: "دفعات مقدمة لموردين",
};
export const accountKindLabel = (k: string) => ACCOUNT_KIND_LABELS[k] ?? k;

/** الإيراد بطبيعته دائن؛ الأصول والمصروفات مدينة. */
export const normalSideForKind = (kind: CreatableAccountKind): "debit" | "credit" => (kind === "revenue" ? "credit" : "debit");

/** كود مقترح ثابت لكل فتح للنموذج (لاتيني كبير) — نفس الكود عند إعادة الإرسال = replay على السيرفر لا حساب مكرر. */
export function suggestAccountCode(kind: CreatableAccountKind, rand: () => number = Math.random): string {
  const prefix = CREATABLE_ACCOUNT_KINDS.find(k => k.kind === kind)?.prefix ?? "ACC";
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let tail = "";
  for (let i = 0; i < 5; i++) tail += alphabet[Math.floor(rand() * alphabet.length) % alphabet.length];
  return `${prefix}_${tail}`;
}
export const ACCOUNT_CODE_RE = /^[A-Z][A-Z0-9_]{1,49}$/;

/** مجموعات صفحة الحسابات: النقدية المتاحة منفصلة عن ذمة COD (ليست نقدية). */
export const ACCOUNT_GROUPS = [
  { key: "cash", title: "النقدية المتاحة", kinds: ["cash", "bank", "wallet"] },
  { key: "cod", title: "ذمة شركات الشحن (COD) — ليست نقدية", kinds: ["carrier_receivable"] },
  { key: "revenue", title: "الإيرادات", kinds: ["revenue"] },
  { key: "expense", title: "المصروفات", kinds: ["expense"] },
] as const;
export function groupAccounts<T extends { kind: string }>(accounts: T[]): { key: string; title: string; accounts: T[] }[] {
  const known = new Set<string>(ACCOUNT_GROUPS.flatMap(g => g.kinds as readonly string[]));
  const groups = ACCOUNT_GROUPS.map(g => ({ key: g.key as string, title: g.title as string, accounts: accounts.filter(a => (g.kinds as readonly string[]).includes(a.kind)) }));
  const other = accounts.filter(a => !known.has(a.kind));
  return [...groups, { key: "other", title: "حسابات أخرى", accounts: other }].filter(g => g.accounts.length > 0);
}

/* ───────────── المرحلة 1: الأرصدة الافتتاحية (مسودة الجلسة فقط) ───────────── */

/** نفس حسابات الأرصدة الافتتاحية على السيرفر (OPENING_MONEY_ACCOUNTS) — اختبار عقد يمنع الانحراف. */
export const OPENING_ACCOUNTS = [
  { code: "OFFICE_CASH", name: "خزنة المكتب", group: "cash_available" },
  { code: "BANK_MAIN", name: "البنك", group: "cash_available" },
  { code: "VF_CASH", name: "فودافون كاش", group: "cash_available" },
  { code: "INSTAPAY", name: "إنستا باي", group: "cash_available" },
  { code: "COD_BOSTA", name: "مستحقات بوسطة", group: "cod_receivable" },
] as const;
export type OpeningRow = { amount: string; reference: string; countedBy: string; note: string };
export const emptyOpeningRow = (): OpeningRow => ({ amount: "", reference: "", countedBy: "", note: "" });

/**
 * مسودة الواجهة → مدخل `ledger.opening.validate` (نفس عقد الخادم الصارم). المبلغ الفارغ لا يُرسل (= صفر في الملف)؛
 * الدليل يُرسل لأي حساب كُتب له مرجع أو قائم بالعد. يرجّع أخطاء محلية واضحة قبل أي طلب.
 */
export function buildOpeningDraft(goLiveDate: string, rows: Record<string, OpeningRow>, acknowledgeV2Differences: boolean) {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(goLiveDate)) errors.push("اختر تاريخ Go-live");
  const balances: Record<string, string> = {};
  const evidence: Record<string, { reference: string; countedBy: string; note?: string }> = {};
  for (const a of OPENING_ACCOUNTS) {
    const r = rows[a.code] ?? emptyOpeningRow();
    const amount = r.amount.trim();
    if (amount) {
      if (!AMOUNT_RE.test(amount)) errors.push(`${a.name}: المبلغ رقم عشري موجب حتى 4 خانات (بلا فواصل)`);
      else balances[a.code] = amount;
    }
    const hasEvidence = r.reference.trim() || r.countedBy.trim();
    const nonZero = amount && AMOUNT_RE.test(amount) && toMinor(amount) !== 0n;
    if (nonZero || hasEvidence) {
      if (r.reference.trim().length < 2) errors.push(`${a.name}: اذكر مرجع الجرد أو الكشف`);
      if (r.countedBy.trim().length < 2) errors.push(`${a.name}: اذكر القائم بالعد`);
      evidence[a.code] = { reference: r.reference.trim(), countedBy: r.countedBy.trim(), ...(r.note.trim() ? { note: r.note.trim() } : {}) };
    }
  }
  return { errors, draft: { goLiveDate, balances, evidence, acknowledgeV2Differences } };
}

/** مجموعات المسودة بالوحدات الصغرى (BigInt): النقدية المتاحة منفصلة عن ذمة COD. */
export function openingGroupTotals(rows: Record<string, OpeningRow>): { cashAvailable: string; codReceivable: string } {
  let cash = 0n, cod = 0n;
  for (const a of OPENING_ACCOUNTS) {
    const v = (rows[a.code]?.amount ?? "").trim();
    if (!v || !AMOUNT_RE.test(v)) continue;
    if (a.group === "cod_receivable") cod += toMinor(v); else cash += toMinor(v);
  }
  return { cashAvailable: fromMinor(cash), codReceivable: fromMinor(cod) };
}

/** ملف التنزيل = كائن الخادم كما هو (لا إعادة بناء على العميل) — اسم ثابت بتاريخ Go-live. */
export function openingFileDownload(file: { goLiveDate: string } & Record<string, unknown>): { filename: string; json: string } {
  return { filename: `ledger-v3-opening-${file.goLiveDate}.json`, json: `${JSON.stringify(file, null, 2)}\n` };
}
