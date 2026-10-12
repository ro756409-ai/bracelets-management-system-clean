/**
 * الحسابات القياسية للاستخدام اليومي (المرحلة 2) — تُنشأ بطلب صريح من صاحب ledger.manage_accounts (idempotent بالكود).
 *  • تصنيفات المصروفات التشغيلية: حسابات kind=expense.
 *  • شراء البضاعة والخامات: حسابات kind=inventory (أصل) — ليست مصروفًا؛ تكلفة المبيعات COGS تُسجَّل عند البيع من لقطة
 *    تكلفة الأوردر (المرحلة 4)، فلا يُحسب الدفع مصروفًا ثم تتكرر التكلفة عند البيع.
 */
export type DailyAccountSpec = { code: string; name: string; kind: "expense" | "inventory" | "cogs"; normalSide: "debit"; group: "expense" | "stock" };

export const LEDGER_DAILY_ACCOUNTS: readonly DailyAccountSpec[] = [
  { code: "EXP_FLYERS", name: "فلاير ومطبوعات", kind: "expense", normalSide: "debit", group: "expense" },
  { code: "EXP_OFFICE", name: "مصروفات المكتب", kind: "expense", normalSide: "debit", group: "expense" },
  { code: "EXP_CLEANING", name: "نظافة", kind: "expense", normalSide: "debit", group: "expense" },
  { code: "EXP_RENT", name: "إيجار", kind: "expense", normalSide: "debit", group: "expense" },
  { code: "EXP_INTERNET", name: "إنترنت", kind: "expense", normalSide: "debit", group: "expense" },
  { code: "EXP_MOBILE", name: "باقات واتصالات", kind: "expense", normalSide: "debit", group: "expense" },
  { code: "EXP_ADS", name: "إعلانات", kind: "expense", normalSide: "debit", group: "expense" },
  { code: "INV_GOODS", name: "مخزون بضاعة جاهزة", kind: "inventory", normalSide: "debit", group: "stock" },
  { code: "INV_RAW", name: "مخزون خامات", kind: "inventory", normalSide: "debit", group: "stock" },
  { code: "COGS", name: "تكلفة البضاعة المباعة", kind: "cogs", normalSide: "debit", group: "stock" },
] as const;
