/**
 * الحسابات القياسية للاستخدام اليومي (المرحلة 2) — تُنشأ بطلب صريح من صاحب ledger.manage_accounts (idempotent بالكود).
 *  • تصنيفات المصروفات التشغيلية: حسابات kind=expense.
 *  • شراء البضاعة والخامات: حسابات kind=inventory (أصل) — ليست مصروفًا؛ تكلفة المبيعات COGS تُسجَّل عند البيع من لقطة
 *    تكلفة الأوردر (المرحلة 4)، فلا يُحسب الدفع مصروفًا ثم تتكرر التكلفة عند البيع.
 */
export type DailyAccountSpec = { code: string; name: string; kind: "expense" | "inventory" | "cogs" | "revenue" | "carrier_receivable" | "customer_advance" | "employee_receivable" | "payroll_payable" | "supplier_payable" | "supplier_advance"; normalSide: "debit" | "credit"; group: "expense" | "stock" | "revenue" | "carrier" | "liability"; allowNegative?: boolean;
  /** يُرحَّل آليًا فقط (تسليم/تسوية/مرتجع/جرد/تغليف) — ممنوع في الإدخال اليدوي، وإلا تتكرر القيمة. */
  systemPosted?: true };

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
  { code: "COGS", name: "تكلفة البضاعة المباعة", kind: "cogs", normalSide: "debit", group: "stock", systemPosted: true },
  // المرحلة 3/4: الشحن الذي دفعه العميل منفصل عن إيراد المنتج؛ وخسارة المرتجع بعد التسليم منفصلة عن تكلفة المبيعات
  { code: "REV_SHIPPING", name: "إيراد شحن محصّل من العميل", kind: "revenue", normalSide: "credit", group: "revenue", systemPosted: true },
  { code: "RETURN_LOSS", name: "خسائر المرتجعات (التالف والفاقد فقط)", kind: "expense", normalSide: "debit", group: "expense", systemPosted: true },
  // المرتجع بعد التسليم: التكلفة تنتظر الفحص والاستلام الفعلي؛ والمبلغ المحصَّل لمرتجع = التزام رد للعميل
  { code: "RETURNS_PENDING", name: "مرتجعات قيد الفحص", kind: "inventory", normalSide: "debit", group: "stock", systemPosted: true },
  { code: "REFUND_PAYABLE", name: "مبالغ مستحقة للعملاء (مرتجعات)", kind: "customer_advance", normalSide: "credit", group: "liability", systemPosted: true },
  { code: "REV_RETURN_RETAINED", name: "مبالغ محتجزة من مرتجعات (بسبب معلن)", kind: "revenue", normalSide: "credit", group: "revenue", systemPosted: true },
  { code: "INV_VARIANCE", name: "فروقات الجرد", kind: "expense", normalSide: "debit", group: "expense", systemPosted: true },
  // BUG-89A: زيادة الجرد ربح مستقل (إيرادات أخرى) — لا تخصم من «فروقات الجرد» ولا تشترط رصيدًا سابقًا فيه. الاسم والقيود
  // التاريخية لـ«فروقات الجرد» كما هي (يبقى للعجز فقط من الآن).
  { code: "INV_GAIN", name: "أرباح فروقات الجرد", kind: "revenue", normalSide: "credit", group: "revenue", systemPosted: true },
  // المرحلة 3: رسوم شركة الشحن الفعلية من كشف التسوية (لا تقدير)، و«مستحقات بوسطة قيد الصرف» بين التسوية والتحويل الفعلي
  // (حساب تسوية مؤقت يُسمح بسالبه حين تزيد رسوم المرتجعات في الكشف عن الصافي)
  { code: "EXP_CARRIER_FEES", name: "رسوم شركة الشحن", kind: "expense", normalSide: "debit", group: "expense", systemPosted: true },
  { code: "COD_PAYOUT", name: "مستحقات بوسطة قيد الصرف", kind: "carrier_receivable", normalSide: "debit", group: "carrier", allowNegative: true, systemPosted: true },
  // المرحلة 4: التغليف — شراؤه أصل («مخزون تغليف»)، واستهلاكه تكلفة أوردر عند التسليم لمندوب الشحن من الإعداد المُدخل،
  // مرة واحدة لكل أوردر (لا مصروف يدوي للتغليف ولا تكلفة مكررة)
  { code: "INV_PACKAGING", name: "مخزون مواد التغليف", kind: "inventory", normalSide: "debit", group: "stock" },
  { code: "COGS_PACKAGING", name: "تكلفة تغليف الأوردرات", kind: "cogs", normalSide: "debit", group: "stock", systemPosted: true },
] as const;

/** حسابات إيراد تُعرض في «إيرادات أخرى» بقائمة الدخل — خارج إيراد المبيعات ومجمل الربح، وداخل صافي الربح. */
export const OTHER_INCOME_CODES: readonly string[] = ["INV_GAIN"];

/**
 * المرحلة 5 — حسابات المرتبات والسلف، تُنشأ منفصلة بعد 0046 (نوع payroll_payable). كلها آلية: المرتبات والعمولات من
 * اعتماد دورة المرتب فقط، والسلف من شاشة السلف فقط، والرواتب المستحقة بين الاعتماد والدفع — لا إدخال يدوي يكررها.
 */
export const LEDGER_PAYROLL_ACCOUNTS: readonly DailyAccountSpec[] = [
  { code: "EXP_SALARIES", name: "مرتبات وأجور", kind: "expense", normalSide: "debit", group: "expense", systemPosted: true },
  { code: "EXP_COMMISSIONS", name: "عمولات الموظفين", kind: "expense", normalSide: "debit", group: "expense", systemPosted: true },
  { code: "EMP_ADVANCES", name: "سلف الموظفين", kind: "employee_receivable", normalSide: "debit", group: "liability", systemPosted: true },
  { code: "PAYROLL_PAYABLE", name: "رواتب مستحقة", kind: "payroll_payable", normalSide: "credit", group: "liability", systemPosted: true },
] as const;

/**
 * المرحلة 6 — الموردون والورشة (بعد 0046 + 0049). كلها آلية من مستندات المورد وأحداث الورشة فقط: المستحق لكل مورد يُحسب من
 * مستنداته وأحداثه، فأي قيد يدوي على هذه الحسابات يفسد كشف المورد.
 */
export const LEDGER_SUPPLIER_ACCOUNTS: readonly DailyAccountSpec[] = [
  { code: "SUPPLIER_PAYABLE", name: "موردون — مستحق لهم", kind: "supplier_payable", normalSide: "credit", group: "liability", systemPosted: true },
  { code: "SUPPLIER_ADVANCES", name: "دفعات مقدمة لموردين", kind: "supplier_advance", normalSide: "debit", group: "liability", systemPosted: true },
  { code: "WORKSHOP_CUSTODY", name: "خامات لدى الورشة (عهدة)", kind: "inventory", normalSide: "debit", group: "stock", systemPosted: true },
  { code: "EXP_WORKSHOP_SHORTAGE", name: "عجز خامات الورشة", kind: "expense", normalSide: "debit", group: "expense", systemPosted: true },
  { code: "EXP_REPAIRS", name: "تكاليف تصليح لدى الورشة", kind: "expense", normalSide: "debit", group: "expense", systemPosted: true },
] as const;

/** أكواد الحسابات التي تُرحَّل آليًا فقط — يرفضها مسار الإدخال اليدوي. */
export const SYSTEM_POSTED_CODES: ReadonlySet<string> = new Set([...LEDGER_DAILY_ACCOUNTS, ...LEDGER_PAYROLL_ACCOUNTS, ...LEDGER_SUPPLIER_ACCOUNTS].filter(a => a.systemPosted).map(a => a.code));
