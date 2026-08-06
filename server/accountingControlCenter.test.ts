import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * مركز الحسابات — المرحلة الأولى.
 *
 * الخطر الأساسي في اللوحة دي مش رقم غلط، ده **رقم متعدّ مرتين**. الإعلان بيتسجّل كمصروف
 * (`ad_spend_entries.expenseId` فريد) والمرتب بيتسجّل كمصروف بتصنيف «رواتب وأجور»، فلو
 * التلاتة اتعرضوا كأرقام مستقلة من غير فصل، اللي يجمعهم بيعدّ نفس الجنيه تلات مرات.
 *
 * الاختبارات دي بتقفل الفصل، وبتقفل إن المرحلة قراءة بحتة، وبتقفل إن معادلة الربح
 * فضلت في محرك واحد.
 */

const db = fs.readFileSync("server/db.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const dash = fs.readFileSync("client/src/pages/accounting/ControlCenter.tsx", "utf-8");
const history = fs.readFileSync("client/src/pages/accounting/TreasuryHistory.tsx", "utf-8");
const page = fs.readFileSync("client/src/pages/Accounting.tsx", "utf-8");

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

// النهاية على أول دالة بعدها مباشرة — أي دالة جديدة تتزرع بينهم كانت هتدخل القصّة
// وتخلّي التأكيدات تقيس كود مش بتاعها.
const controlCenterFn = codeOnly(db).slice(
  codeOnly(db).indexOf("export async function getAccountingControlCenter"),
  codeOnly(db).indexOf("export async function listAdCampaigns")
);
// النهاية لازم تكون كود مش تعليق: codeOnly بتشيل الـ`//`، فعلامة القسم بتختفي و
// indexOf بترجّع -1 والقصّة بتاخد نص الملف.
const historyFn = codeOnly(db).slice(
  codeOnly(db).indexOf("export async function getTreasuryHistoryWithBalances"),
  codeOnly(db).indexOf("const PAYROLL_EXPENSE_CATEGORY")
);

// ───────────────────────── الرصيد قبل الحركة ─────────────────────────

/** نفس معادلة السيرفر، متكررة هنا عن قصد عشان الاختبار يقيس الناتج مش يعيد نداء الكود. */
const balanceBefore = (direction: "in" | "out", after: number, amount: number) =>
  direction === "in" ? after - amount : after + amount;

describe("الرصيد قبل الحركة", () => {
  it("🔑 حركة داخلة: اللي قبلها = بعدها ناقص المبلغ", () => {
    // رصيد كان 1000، دخل 250، بقى 1250
    expect(balanceBefore("in", 1250, 250)).toBe(1000);
  });

  it("🔑 حركة خارجة: اللي قبلها = بعدها زائد المبلغ", () => {
    // رصيد كان 1000، خرج 250، بقى 750
    expect(balanceBefore("out", 750, 250)).toBe(1000);
  });

  it("الرصيد السالب مابيكسرش الحساب", () => {
    expect(balanceBefore("out", -50, 200)).toBe(150);
  });

  it("🔑 والسيرفر بيستخدم نفس المعادلة مش عمود مخزّن", () => {
    expect(historyFn).toContain('row.direction === "in" ? after - amount : after + amount');
    expect(db).not.toContain('balanceBefore: decimal("balanceBefore"');
  });
});

// ───────────────────────── الفصل بين السلال ─────────────────────────

/** نفس منطق الـCASE على السيرفر: أول شرط بيمسك الصف بياخده. */
function bucketOf(row: { hasAdEntry: boolean; categoryName: string | null }): "ads" | "salary" | "other" {
  if (row.hasAdEntry) return "ads";
  if (row.categoryName === "رواتب وأجور") return "salary";
  return "other";
}

describe("🔑 الإعلانات والمرتبات والمصروفات مانعة للتداخل", () => {
  const payments = [
    { amount: 500, hasAdEntry: true, categoryName: "إعلانات" },
    { amount: 300, hasAdEntry: true, categoryName: null },
    { amount: 900, hasAdEntry: false, categoryName: "رواتب وأجور" },
    { amount: 120, hasAdEntry: false, categoryName: "إيجار" },
    { amount: 80, hasAdEntry: false, categoryName: null },
  ];

  const sum = (b: string) =>
    payments.filter(p => bucketOf(p) === b).reduce((s, p) => s + p.amount, 0);

  it("كل دفعة في سلة واحدة بالظبط", () => {
    for (const p of payments) {
      const hits = ["ads", "salary", "other"].filter(b => bucketOf(p) === b);
      expect(hits).toHaveLength(1);
    }
  });

  it("🔑 المجموع = الإجمالي المدفوع، بدون زيادة ولا نقصان", () => {
    const total = payments.reduce((s, p) => s + p.amount, 0);
    expect(sum("ads") + sum("salary") + sum("other")).toBe(total);
    expect(total).toBe(1900);
  });

  it("🔑 الإعلان مابيدخلش في المصروفات الأخرى حتى لو تصنيفه فاضي", () => {
    expect(sum("ads")).toBe(800);
    expect(sum("other")).toBe(200); // 120 + 80 — من غير الـ800 ولا الـ900
  });

  it("🔑 المرتب مابيدخلش في المصروفات الأخرى", () => {
    expect(sum("salary")).toBe(900);
    expect(sum("other")).not.toContain(900);
  });

  it("🔑 إعلان بتصنيف رواتب بيتحسب إعلان مرة واحدة بس", () => {
    // الترتيب مهم: الإعلان بيتفحص الأول، فمابيتعدّش مرتين
    expect(bucketOf({ hasAdEntry: true, categoryName: "رواتب وأجور" })).toBe("ads");
  });

  it("🔑 والسيرفر بيطبّق نفس الترتيب: إعلان ← مرتب ← غيره", () => {
    expect(controlCenterFn).toContain(`CASE WHEN ${"${adSpendEntries.id}"} IS NOT NULL`);
    expect(controlCenterFn).toContain(`IS NULL AND ${"${expenseCategories.name}"} = ${"${PAYROLL_EXPENSE_CATEGORY}"}`);
    expect(controlCenterFn).toContain("IS NULL OR");
  });

  it("🔑 والإجمالي بيترجع كمان عشان الفصل يتحسب مش يتصدّق", () => {
    expect(controlCenterFn).toContain("total: sql<string>");
    expect(controlCenterFn).toContain("expensesTotalPaidToday");
    expect(dash).toContain("expensesTotalPaidToday");
  });
});

describe("🔑 تصنيف الرواتب مربوط بثابت واحد", () => {
  it("الثابت موجود وبقيمته المتوقعة", () => {
    // مفيش عمود code في expense_categories — الاسم هو المُعرِّف الوحيد المتاح دلوقتي.
    // الاختبار ده بيفشل لو الاسم اتغيّر في مكان من غير التاني.
    expect(db).toContain('const PAYROLL_EXPENSE_CATEGORY = "رواتب وأجور"');
  });

  it("🔑 اللوحة بتستخدم الثابت مش نص مكتوب فيها", () => {
    expect(controlCenterFn).toContain("${PAYROLL_EXPENSE_CATEGORY}");
    expect(controlCenterFn).not.toContain('"رواتب وأجور"');
  });

  it("🔑 ونفس الثابت هو اللي مسار المرتبات بيكتب بيه", () => {
    const usages = (db.match(/PAYROLL_EXPENSE_CATEGORY/g) ?? []).length;
    expect(usages).toBeGreaterThanOrEqual(4);
  });
});

// ───────────────────────── النطاقات الزمنية ─────────────────────────

describe("اليوم مش الشهر، والشهر مش شهر تاني", () => {
  it("🔑 أرقام اليوم على نافذة يوم واحد مقفولة من فوق", () => {
    expect(controlCenterFn).toContain("businessDayRange(dayKey, CAIRO_TIMEZONE)");
    expect(controlCenterFn).toContain("gte(expensePayments.paidAt, from)");
    expect(controlCenterFn).toContain("lt(expensePayments.paidAt, toExclusive)");
  });

  it("🔑 الشهر بيبدأ من أول يوم في نفس شهر اليوم المختار", () => {
    expect(controlCenterFn).toContain(
      "const monthFrom = new Date(from.getFullYear(), from.getMonth(), 1)"
    );
  });

  it("🔑 ربح اليوم وربح الشهر بنطاقين مختلفين", () => {
    expect(controlCenterFn).toContain("dateFrom: from, dateTo: toExclusive");
    expect(controlCenterFn).toContain("dateFrom: monthFrom, dateTo: toExclusive");
  });

  it("المستحق للورشة مش محدود باليوم — التزام مش حركة يوم", () => {
    const due = controlCenterFn.slice(controlCenterFn.indexOf("const dueQuery"));
    expect(due.slice(0, due.indexOf("const stockQuery"))).not.toContain("toExclusive");
  });
});

// ───────────────────────── الفلوس اللي خرجت فعلًا ─────────────────────────

describe("🔑 المصروف غير المدفوع مش فلوس خرجت", () => {
  it("الأرقام بتتقرا من expense_payments مش من expenses", () => {
    expect(controlCenterFn).toContain(".from(expensePayments)");
    // expenses بتدخل join عشان التصنيف بس، مش كمصدر للمبلغ
    expect(controlCenterFn).toContain("innerJoin(expenses, eq(expenses.id, expensePayments.expenseId))");
    expect(controlCenterFn).not.toContain("SUM(${expenses.amount})");
  });

  it("والمبلغ المجمّع هو مبلغ الدفعة", () => {
    expect(controlCenterFn).toContain("SUM(${expensePayments.amount})");
  });
});

// ───────────────────────── قراءة بحتة ─────────────────────────

describe("🔑 المرحلة الأولى مابتكتبش حاجة", () => {
  it("مفيش insert ولا update ولا delete في الدالتين", () => {
    for (const fn of [controlCenterFn, historyFn]) {
      expect(fn).not.toContain(".insert(");
      expect(fn).not.toContain(".update(");
      expect(fn).not.toContain(".delete(");
      expect(fn).not.toContain("transaction(");
    }
  });

  it("🔑 ومفيش نداء لأي خدمة بتحرّك خزنة", () => {
    for (const forbidden of ["addTreasuryTransaction", "createExpense", "postFinancialTransaction"]) {
      expect(controlCenterFn, forbidden).not.toContain(forbidden);
    }
  });

  it("الـendpoints الجديدة query مش mutation", () => {
    const i = routers.indexOf("    controlCenter: permissionProcedure");
    const j = routers.indexOf("    dailySummary: permissionProcedure");
    const block = routers.slice(i, j);
    expect(block).toContain(".query(");
    expect(block).not.toContain(".mutation(");
  });

  it("🔑 والشاشتين مافيهمش ولا mutation", () => {
    for (const src of [dash, history]) {
      expect(src).not.toContain("useMutation");
    }
  });
});

describe("🔑 الربح من محرك واحد", () => {
  it("اللوحة بتنادي getAccountingDashboard مش بتحسب بنفسها", () => {
    expect(controlCenterFn).toContain("getAccountingDashboard({");
    expect(controlCenterFn).not.toMatch(/netProfit\s*=\s*[^;]*[-+]/);
  });

  it("🔑 والواجهة مابتحسبش ربح — بتعرض اللي جه", () => {
    expect(dash).toContain("d?.netProfitToday");
    expect(dash).toContain("d?.netProfitMonth");
    expect(codeOnly(dash)).not.toMatch(/netProfit\w*\s*=\s*[^;]*[-+*/]/);
  });
});

describe("الأداء", () => {
  it("🔑 كل الاستعلامات بالتوازي — مفيش انتظار متسلسل بلا داعي", () => {
    expect(controlCenterFn).toContain("await Promise.all([");
    // مفيش await منفرد على استعلام جوه الدالة غير اللي في Promise.all
    const awaits = (controlCenterFn.match(/await db\b/g) ?? []).length;
    expect(awaits).toBe(0);
  });

  it("🔑 مفيش cache — الأرقام بتتقري لحظة السؤال", () => {
    expect(controlCenterFn).not.toContain("cache");
    expect(dash).not.toContain("staleTime");
  });

  it("نداء واحد للوحة كلها مش نداء لكل كارت", () => {
    const queries = [...dash.matchAll(/trpc\.[a-zA-Z.]+\.useQuery/g)].map(m => m[0]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("accounting.controlCenter");
  });
});

// ───────────────────────── الواجهة ─────────────────────────

describe("اللوحة", () => {
  it("🔑 عربي RTL", () => {
    expect(dash).toContain('dir="rtl"');
    expect(history).toContain('dir="rtl"');
  });

  it("🔑 كل كارت بيقول فترته", () => {
    for (const p of ["اليوم", "الشهر", "الرصيد الحالي", "مستحق"]) {
      expect(dash, p).toContain(`period: "${p}"`);
    }
    expect(dash).toContain("{c.period}");
  });

  it("🔑 الصفر بيتعرض صفر مش خانة فاضية", () => {
    expect(dash).toContain("Number(n ?? 0).toLocaleString");
    expect(dash).toContain("const v = Number(c.value ?? 0);");
  });

  it("العملة بالجنيه المصري", () => {
    expect(dash).toContain('toLocaleString("ar-EG"');
    expect(dash).toContain("ج.م");
  });

  it("🔑 حالة تحميل واضحة", () => {
    expect(dash).toContain("q.isLoading ?");
    expect(dash).toContain("animate-pulse");
    expect(history).toContain("q.isLoading ?");
  });

  it("🔑 الخطأ بيتقال بالعربي — مفيش فشل صامت", () => {
    expect(dash).toContain("q.isError &&");
    expect(dash).toContain("مش قادر أجيب أرقام اليوم");
    expect(dash).toContain("q.error?.message");
    expect(history).toContain("مش قادر أجيب سجل الخزنة");
    // ولا بيعرض صفر وكأنه الحقيقة وقت الخطأ
    expect(dash).toContain('q.isError ? (');
  });

  it("🔑 موبايل: عمود واحد والجدول بيسكرول جوه نفسه", () => {
    expect(dash).toContain("grid-cols-1 gap-3 sm:grid-cols-2");
    expect(history).toContain("overflow-x-auto");
    expect(history).toContain("min-w-[52rem]");
  });
});

describe("سجل الخزنة بيعرض التمن أعمدة", () => {
  it("🔑 كلهم موجودين", () => {
    for (const col of [
      "التاريخ والوقت", "النوع", "الاتجاه", "المبلغ",
      "الرصيد قبل", "الرصيد بعد", "المرجع", "ملاحظات",
    ]) {
      expect(history, col).toContain(col);
    }
  });

  it("الاتجاه بيتقري داخل/خارج مش in/out", () => {
    expect(history).toContain('{isIn ? "داخل" : "خارج"}');
  });

  it("أنواع الحركة كلها متترجمة", () => {
    for (const t of ["collection", "refund", "expense", "deposit", "withdrawal", "adjustment"]) {
      expect(history, t).toContain(`${t}:`);
    }
  });
});

describe("التابات", () => {
  /**
   * الاختبار الأول كان بيدوّر على الاسم في **الملف** كله — وده كان بيعدّي حتى لو التاب
   * اتنقل للمخفي، لأن الاسم بيفضل مكتوب في الحالتين. فبقى بيقرا كل قايمة لوحدها.
   */
  const listOf = (name: string) => {
    const start = page.indexOf(`const ${name} = [`);
    expect(start, name).toBeGreaterThan(-1);
    return page.slice(start, page.indexOf("] as const;", start));
  };
  const bar = listOf("TABS");
  const hidden = listOf("HIDDEN_TABS");

  it("🔑 الشريط فيه اللي التاجر بيفتحه كل يوم وبس", () => {
    for (const label of ["اللوحة", "المخزون", "الإعلانات", "سجل الخزنة"]) {
      expect(bar, label).toContain(`label: "${label}"`);
    }
  });

  it("🔑 والقديم اتشال من الشريط فعلًا — مش مكتوب وسايب", () => {
    for (const label of ["التحصيلات", "المصروفات", "المرتبات"]) {
      expect(bar, label).not.toContain(`label: "${label}"`);
      expect(hidden, label).toContain(`label: "${label}"`);
    }
  });

  it("🔑 المخفية متعرّفة صراحة مش متمسوحة", () => {
    expect(page).toContain("const HIDDEN_TABS");
    for (const label of ["التقفيلات", "الشحن والتسويات", "الإعدادات"]) {
      expect(hidden, label).toContain(`label: "${label}"`);
    }
  });

  it("🔑 ومحدش اتشال من غير بديل", () => {
    // كل تاب اتخفي لازم يكون ليه شاشة تانية بتعمل نفس الشغل، وإلا يبقى التاجر خسر ميزة.
    const sidebar = fs.readFileSync("client/src/components/DashboardLayout.tsx", "utf-8");
    expect(sidebar).toContain('path: "/daily-collections"'); // بديل التحصيلات والمصروفات
    expect(sidebar).toContain('path: "/salary-preparation"'); // بديل المرتبات
  });

  it("🔑 ومساراتها لسه بتفتح", () => {
    expect(page).toContain("const all = [...TABS, ...HIDDEN_TABS];");
    expect(page).toContain("all.find(t => t.path === location)");
  });

  it("🔑 ولوحة الأرباح التفصيلية ما اتشالتش — اتنقلت للمتقدم", () => {
    expect(page).toContain("<OverviewSection />");
    expect(page).toContain("أقسام متقدمة");
  });
});
