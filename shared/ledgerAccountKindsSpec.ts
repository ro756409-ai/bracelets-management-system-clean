/**
 * مواصفة 0046 — نوعا حساب جديدان في `ledger_accounts.kind` (ENUM من 0040) وحده:
 *   • payroll_payable  — «رواتب مستحقة» (التزام بين استحقاق دورة المرتب ودفعها، المرحلة 5).
 *   • supplier_advance — «دفعات مقدمة لموردين» (أصل يُخصم من فواتير المورد، المرحلة 6).
 * القيم الأربع عشرة القديمة وترتيبها كما هي حرفيًا، والجديدتان في **آخر** القائمة فقط (لا تتغير قيمة مخزّنة، وتعديل
 * تعريف بلا إعادة بناء). خصائص العمود: NOT NULL، بلا افتراضي، charset/collation الحالي، بلا تعليق.
 * تحقق 0040 (ledgerV3Spec) يقارن ENUM بالبادئة فقط ⇒ لا يتأثر.
 */
export const LEDGER_ACCOUNT_KINDS_BEFORE_0046 = [
  "cash", "bank", "wallet", "carrier_receivable", "employee_receivable", "supplier_payable", "customer_advance",
  "owner_current", "revenue", "expense", "cogs", "inventory", "equity", "suspense",
] as const;
export const LEDGER_ACCOUNT_KINDS_NEW_0046 = ["payroll_payable", "supplier_advance"] as const;
export const LEDGER_ACCOUNT_KINDS_AFTER_0046 = [...LEDGER_ACCOUNT_KINDS_BEFORE_0046, ...LEDGER_ACCOUNT_KINDS_NEW_0046] as const;
