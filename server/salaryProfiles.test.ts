import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * مرتبات الموظفين.
 *
 * `payroll.profileCreate` كان في السيرفر من غير أي شاشة بتناديه، فالمالك مكانش يقدر
 * يقول «أحمد راتبه ٥٠٠٠» — ومن غير الرقم ده «تجهيز المرتبات» بيطلع فاضي. الاختبارات
 * دي بتقفل إن الطريق اتفتح، وإن رفع المرتب مابيعيدش كتابة الشهور اللي فاتت.
 */

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
const read = (f: string) => codeOnly(fs.readFileSync(f, "utf-8"));

const page = fs.readFileSync("client/src/pages/SalaryProfiles.tsx", "utf-8");
const code = codeOnly(page);
const db = read("server/db.ts");
const routers = read("server/routers.ts");
const sidebar = fs.readFileSync(
  "client/src/components/DashboardLayout.tsx",
  "utf-8"
);
const app = fs.readFileSync("client/src/App.tsx", "utf-8");

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, start).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j > -1 ? j : undefined);
};

describe("🔑 الطريق اللي مكانش موجود", () => {
  it("🔑 فيه شاشة بتنادي profileCreate دلوقتي", () => {
    expect(code).toContain("trpc.payroll.profileCreate.useMutation");
  });

  it("🔑 ومتوصلة بتاب المرتبات في الحسابات", () => {
    // بقت تاب جوه الحسابات مش بند في القايمة الجنبية — القايمة فيها «الحسابات» بس.
    const accounting = fs.readFileSync("client/src/pages/Accounting.tsx", "utf-8");
    expect(accounting).toContain('path: "/salary-profiles"');
    expect(accounting).toContain('label: "المرتبات"');
    expect(app).toContain('<Route path="/salary-profiles">');
  });

  it("🔑 والمسار لسه بيفتح — أي رابط قديم شغّال", () => {
    expect(app).toContain('<Route path="/salary-preparation">');
  });
});

describe("🔑 الحقول اللي التاجر بيسأل عنها", () => {
  it("اسم الموظف وبياخد كام", () => {
    expect(page).toContain("الموظف *");
    expect(page).toContain("الراتب الأساسي في الشهر *");
  });

  it("🔑 وأنواع الراتب الأربعة بالعربي", () => {
    for (const text of ["شهري", "باليومية", "بالعمولة", "أساسي + عمولة"]) {
      expect(page, text).toContain(`"${text}"`);
    }
  });

  it("🔑 والحقول بتتغيّر مع نوع الراتب — مش كلها ظاهرة مرة واحدة", () => {
    expect(code).toContain('const needsBase = draft.salaryType === "monthly" || draft.salaryType === "mixed"');
    expect(code).toContain('const needsDaily = draft.salaryType === "daily"');
    expect(code).toContain("{needsBase && (");
    expect(code).toContain("{needsDaily && (");
    expect(code).toContain("{needsCommission && (");
  });

  it("🔑 والعمولة موصوفة باللي بتتحسب عليه — مش بكود", () => {
    // «delivered» في قاعدة البيانات، «الأوردر اللي اتسلّم» في الشاشة.
    for (const text of [
      "الأوردر اللي اتسلّم",
      "الأوردر اللي اتشحن",
      "مبلغ ثابت لكل أوردر",
      "نسبة من قيمة الأوردر",
    ]) {
      expect(page, text).toContain(`"${text}"`);
    }
  });

  it("والقايمة الفاضية بتقول للتاجر يعمل إيه وليه", () => {
    expect(page).toContain("لسه مافيش مرتبات متسجّلة");
    expect(page).toContain("مالوش أرقام يحسب عليها");
  });

});

describe("🔑 التحقق قبل الحفظ", () => {
  const submit = between(code, "const submit = () => {", "\n  };");

  it("🔑 الراتب المطلوب حسب النوع بس", () => {
    expect(submit).toContain("if (needsBase && !(base > 0))");
    expect(submit).toContain("if (needsDaily && !(daily > 0))");
    expect(submit).toContain("if (needsCommission && !(commission > 0))");
  });

  it("🔑 والنسبة ماتزيدش عن ١٠٠٪", () => {
    expect(submit).toContain("commission > 100");
  });

  it("🔑 وبيتبعت اللي يخص النوع بس — مش كل الحقول", () => {
    // بعت `dailyRate` مع راتب شهري كان هيخلي الحساب ياخد الاتنين.
    expect(submit).toContain("...(needsBase ? { baseSalary: base } : {})");
    expect(submit).toContain("...(needsDaily ? { dailyRate: daily } : {})");
  });
});

describe("🔑 رفع المرتب مابيعيدش كتابة الشهور اللي فاتت", () => {
  it("🔑 التعديل بيبدأ من النهاردة مش من تاريخ الإصدار القديم", () => {
    const edit = between(code, "const startEdit = (row: any) => {", "\n  };");
    expect(edit).toContain("effectiveFrom: todayKey()");
    expect(edit).not.toContain("effectiveFrom: row.effectiveFrom");
  });

  it("🔑 والشاشة بتقول ده صراحة", () => {
    expect(page).toContain("الدورات المتحسبة قبله");
  });

  it("🔑 والقايمة بتعرض الساري بس — مش كل الإصدارات", () => {
    const fn = between(
      db,
      "export async function listBusinessSalaryProfiles",
      "export async function deleteSalaryProfile"
    );
    expect(fn).toContain("if (row.effectiveFrom > now) continue");
    expect(fn).toContain("if (!current.has(row.employeeId))");
  });

  it("والإصدارات القديمة مابتتمسحش", () => {
    const fn = between(
      db,
      "export async function listBusinessSalaryProfiles",
      "export async function deleteSalaryProfile"
    );
    expect(fn).not.toContain(".delete(");
    expect(fn).not.toContain(".update(");
  });
});

describe("🔑 نطاق النشاط", () => {
  it("🔑 القراءة مقيّدة بالنشاط بتاع المستخدم", () => {
    const endpoint = between(
      routers,
      "profileListByBusiness: adminProcedure",
      "profileCreate:"
    );
    expect(endpoint).toContain("requireScopedBusinessId(ctx.tenantId, input.businessId)");
  });

  it("🔑 وقايمة الموظفين **مش** مفلترة على النشاط — وده مقصود", () => {
    // `employees.businessId` عمود nullable. الفلترة عليه كانت بتخفي كل موظف مااتربطش
    // بنشاط صراحةً — التاجر شاف اسم واحد وهو عنده عشرة. النطاق محفوظ على السيرفر
    // عن طريق `scopeBusinessId` بتاع الـtenant.
    expect(code).toContain("trpc.employees.list.useQuery({ isActive: true })");
    expect(code).not.toContain("employees.list.useQuery({ businessId");
  });
});

// ───────────────── اللي اتصلّح في الجولة دي ─────────────────

describe("🔑 الاسم بيتكتب هنا — من غير حساب دخول", () => {
  it("🔑 فيه إضافة اسم جوه الشاشة", () => {
    // كتير من اللي بياخدوا مرتب مالهمش حساب في النظام. `username` و`passwordHash`
    // عمودين nullable و`employees.create` مش بيطلب غير الاسم — فمفيش سبب يخلي التاجر
    // يسيب الشاشة ويعمل حساب دخول لواحد مش هيدخل أصلاً.
    expect(code).toContain("trpc.employees.create.useMutation");
    expect(page).toContain("أو اكتب اسم جديد...");
    expect(page).toContain("مش لازم يبقى ليه حساب دخول");
  });

  it("🔑 وبيتعمل بدور مايشوفش حاجة", () => {
    expect(code).toContain('role: "viewer"');
  });

  it("🔑 والاسم الجديد بيتختار لوحده بعد الإضافة", () => {
    // من غيرها التاجر يضيف الاسم ويدوّر عليه في القايمة تاني.
    expect(code).toContain("setDraft(d => ({ ...d, employeeId: String(created.id) }))");
  });
});

describe("🔑 حذف سطر المرتب", () => {
  it("🔑 فيه زرار حذف جنب التعديل", () => {
    expect(code).toContain("trpc.payroll.profileDelete.useMutation");
    expect(page).toContain("حذف");
  });

  it("🔑 والتأكيد بيقول إن الكشوف القديمة مش هتتغيّر", () => {
    expect(page).toContain("كشوف الرواتب المتحسبة قبل كده مابتتغيّرش");
  });

  it("🔑 والحذف مقيّد بالنشاط", () => {
    const fn = db.slice(db.indexOf("export async function deleteSalaryProfile"));
    expect(fn).toContain("eq(employeeSalaryProfiles.businessId, input.businessId)");
    expect(fn).toContain("مش تابع للنشاط ده");
  });
});

describe("🔑 الحسابات بند واحد في القايمة", () => {
  const sidebar = fs.readFileSync(
    "client/src/components/DashboardLayout.tsx",
    "utf-8"
  );
  const group = sidebar.slice(
    sidebar.indexOf('label: "الحسابات"'),
    sidebar.indexOf('label: "التقارير"')
  );

  it("🔑 وجهة واحدة — مش تمن بنود تحت بعض", () => {
    // التاجر كان بيدوّر في القايمة بدل ما يدوّر جوه الحسابات.
    const paths = [...group.matchAll(/path: "([^"]+)"/g)].map(m => m[1]);
    expect(paths).toEqual(["/accounting"]);
  });

  it("🔑 وشغل المخزون رجع للمخزون", () => {
    // استلام البضاعة ومرتجعات الورشة شغل عدّ قطع، مش شغل فلوس.
    const inventory = sidebar.slice(
      sidebar.indexOf('label: "المخزون"'),
      sidebar.indexOf('label: "الموظفون"')
    );
    expect(inventory).toContain('path: "/goods-receipt"');
    expect(inventory).toContain('path: "/workshop-returns"');
  });
});

describe("🔑 مفيش شاشتين لنفس الحركة", () => {
  const sidebar = fs.readFileSync(
    "client/src/components/DashboardLayout.tsx",
    "utf-8"
  );
  const transfer = fs.readFileSync("client/src/pages/StockTransfer.tsx", "utf-8");
  const returns = fs.readFileSync("client/src/pages/WorkshopReturns.tsx", "utf-8");

  it("🔑 «تحويل مخزون» و«مرتجعات الورشة» بينادوا نفس الـendpoint", () => {
    for (const src of [transfer, returns]) {
      expect(src).toContain("trpc.accountingV2.stockTransfer.useMutation");
    }
  });

  it("🔑 فاتشال من القايمة — ومرتجعات الورشة بتعمل نفس الحاجة وزيادة", () => {
    expect(sidebar).not.toContain('path: "/stock-transfer"');
    expect(sidebar).toContain('path: "/workshop-returns"');
    // الزيادة: بتوريك القطع اللي راحت ولسه مرجعتش
    expect(returns).toContain("trpc.accountingV2.workshopReturns.useQuery");
  });

  it("والمسار لسه شغّال لأي رابط قديم", () => {
    const app = fs.readFileSync("client/src/App.tsx", "utf-8");
    expect(app).toContain('<Route path="/stock-transfer">');
  });
});

describe("🔑 سجل الخزنة بيقول الرصيد الحقيقي", () => {
  const history = fs.readFileSync(
    "client/src/pages/accounting/TreasuryHistory.tsx",
    "utf-8"
  );

  it("🔑 الرصيد الحالي فوق — مش آخر صف في الفلتر", () => {
    // `balanceAfter` بيتجمّد وقت الإدخال، فحركة بتاريخ قديم بتتضاف آخر السلسلة.
    // يعني آخر صف في فترة مفلترة ممكن مايكونش الرصيد الحقيقي.
    expect(history).toContain("رصيد الخزنة الحالي");
    expect(history).toContain("trpc.accounting.controlCenter.useQuery");
  });

  it("🔑 وبيحذّر لما يبقى فيه حركات بره الفترة", () => {
    expect(history).toContain("مش نفس الرصيد الحالي");
    expect(history).toContain("وسّع التاريخ من فوق");
    expect(history).toContain("Number(rows[0]?.balanceAfter ?? 0)");
  });
});

// ───────────────── الفجوات اللي زي فجوة المرتبات ─────────────────

describe("🔑 إضافة مخزن — نفس الفجوة", () => {
  const receipt = fs.readFileSync("client/src/pages/GoodsReceipt.tsx", "utf-8");

  it("🔑 createWarehouse كان في السيرفر من غير شاشة", () => {
    // نفس قصة `profileCreate`: endpoint موجود، مفيش أي طريق ليه. النتيجة إن «مكان
    // الاستلام» بيطلع فاضي وإذن الاستلام كله مقفول ومفيش مكان تعمل منه مخزن.
    expect(routers).toContain("createWarehouse: adminProcedure");
    expect(receipt).toContain("trpc.businesses.createWarehouse.useMutation");
  });

  it("🔑 وبيقول للتاجر لما مايكونش فيه مخازن", () => {
    expect(receipt).toContain("مفيش مخازن لسه");
    expect(receipt).toContain("أو اكتب مخزن جديد...");
  });

  it("🔑 والمخزن الجديد بيتختار لوحده", () => {
    expect(codeOnly(receipt)).toContain("setWarehouseId(String(added.id))");
  });
});

describe("🔑 حذف الحملة", () => {
  const ads = fs.readFileSync("client/src/pages/Advertising.tsx", "utf-8");
  const svc = read("server/expensesV2.service.ts");

  it("🔑 فيه زرار حذف جنب التعديل", () => {
    expect(ads).toContain("trpc.accountingV2.adSpendDelete.useMutation");
    expect(ads).toContain("تمسح حملة");
  });

  it("🔑 والمسودة بس — زي التعديل بالظبط", () => {
    const fn = svc.slice(svc.indexOf("export async function deleteAdSpendDraft"));
    expect(fn).toContain('if (expense && expense.status !== "draft")');
  });

  it("🔑 وبيمسح الحملة ومصروفها مع بعض", () => {
    // لو مسح الحملة وساب المصروف، كان هيفضل مصروف يتيم في التقارير مالوش حملة
    // والتاجر مش لاقي طريقة يشيله.
    const fn = svc.slice(svc.indexOf("export async function deleteAdSpendDraft"));
    expect(fn).toContain("tx.delete(adSpendEntries)");
    expect(fn).toContain("tx.delete(expenses)");
  });
});

describe("🔑 إجماليات التحصيلات", () => {
  const page = fs.readFileSync("client/src/pages/DailyCollections.tsx", "utf-8");

  it("🔑 فيه سطر إجمالي للأوردرات والتحصيل والرسوم والصافي", () => {
    const foot = page.slice(page.indexOf("<tfoot>"));
    for (const key of ["totals.orders", "totals.gross", "totals.charges", "totals.net"]) {
      expect(foot, key).toContain(key);
    }
  });

  it("🔑 وبيجمع اللي معروض بس — مش كل التاريخ", () => {
    // القايمة محدودة بآخر التسويات، فمجموع كل حاجة كان هيبقى رقم مالوش علاقة
    // بالسطور اللي تحته.
    expect(codeOnly(page)).toContain("rows.reduce(");
    expect(page).toContain("الإجمالي ({rows.length})");
  });
});

// ───────────────── السُلف ─────────────────

describe("🔑 السُلفة فلوس خرجت من الدُرج", () => {
  const svc = read("server/advancesV2.service.ts");
  const fn = svc.slice(svc.indexOf("export async function issueEmployeeAdvance"));

  it("🔑 بتنزّل حركة خزنة خارجة — مكانتش بتنزّل", () => {
    // نفس فجوة دفع المصروف: كانت بتكتب القيد المالي وبس، فالتاجر يدي سُلفة ٥٠٠
    // ويلاقي رصيد الخزنة زي ما هو ويفتكر الفلوس لسه عنده.
    expect(fn).toContain("addTreasuryTransactionInTransaction(tx, {");
    expect(fn).toContain('direction: "out"');
    expect(fn).toContain("تعذر تسجيل حركة الخزنة — السُلفة اترجعت");
  });

  it("🔑 وفي نفس الترانزاكشن — يا الاتنين يا ولا واحد", () => {
    const open = fn.indexOf("db.transaction(async tx =>");
    expect(open).toBeGreaterThan(-1);
    expect(fn.indexOf("addTreasuryTransactionInTransaction")).toBeGreaterThan(open);
  });

  it("🔑 والحسابين بيتحلّوا لوحدهم — التاجر مالوش دعوة بيهم", () => {
    expect(fn).toContain("resolveDefaultTreasuryAccountInTransaction(tx, input.businessId)");
    expect(fn).toContain("resolveEmployeeAdvancesAccountInTransaction(tx, input.businessId)");
    const routerBlock = routers.slice(
      routers.indexOf("advanceCreate: adminProcedure"),
      routers.indexOf("advanceCreate: adminProcedure") + 700
    );
    expect(routerBlock).toContain("sourceAccountId: z.number().optional()");
    expect(routerBlock).toContain("receivableAccountId: z.number().optional()");
  });

  it("🔑 وحساب السُلف مش نقدي — وإلا الجنيه بيتعدّ مرتين", () => {
    const accounting = read("server/accountingV2.service.ts");
    const resolver = accounting.slice(
      accounting.indexOf("export async function resolveEmployeeAdvancesAccountInTransaction")
    );
    expect(resolver).toContain("isCashEquivalent: false");
    expect(resolver).toContain('accountType: "receivable"');
  });

  it("🔑 والموظف اللي مالوش نشاط بياخد سُلفة برضه", () => {
    // `employees.businessId` nullable، والشرط القديم كان بيرفض كل اللي NULL.
    expect(fn).toContain("if (employee.businessId != null && employee.businessId !== input.businessId)");
  });

  it("والشاشة بتقول إن التكلفة مابتتحسبش مرتين", () => {
    expect(page).toContain("مابتتحسبش تكلفة مرتين");
    expect(page).toContain("اصرف من الخزنة");
  });
});

describe("🔑 نموذج المرتب بيبان لما تدوس تعديل", () => {
  it("🔑 نافذة فوق الشاشة مش كارت تحت جدول طوله ١٨ سطر", () => {
    // كان بيترسم بعد الجدول، فالتاجر يدوس «تعديل» والنموذج يفتح خارج المنظر —
    // وشكله إن الزرار مكسور.
    const modal = page.slice(page.indexOf("{open && ("), page.indexOf("مرتب موظف"));
    expect(modal).toContain("fixed inset-0");
    expect(modal).toContain("z-50");
  });

  it("والضغط بره بيقفلها، وجوه لأ", () => {
    const modal = page.slice(page.indexOf("{open && ("));
    expect(modal).toContain("onClick={() => setOpen(false)}");
    expect(modal).toContain("event.stopPropagation()");
  });
});

// ───────────────── مساحة المرتبات الواحدة ─────────────────

describe("🔑 المرتبات مساحة واحدة", () => {
  const code = codeOnly(page);

  it("🔑 دورة الشهر والمرتبات والسُلف في صفحة واحدة", () => {
    for (const section of ["<PeriodWorkspace", "<ProfilesSection", "<AdvancesSection"]) {
      expect(code, section).toContain(section);
    }
  });

  it("🔑 والأعمدة اللي طلبها التاجر كلها موجودة بالترتيب", () => {
    // العناوين اتقصّرت («المرتب» بدل «المرتب الأساسي»، «المستحق» بدل «الصافي») عشان
    // الصف يفضل في سطر واحد، واتزاد عمود «الإجراء». الفحص بقى على الترتيب نفسه —
    // ده اللي التاجر بيقرا بيه — مش على شكل الـclass.
    const head = page.slice(page.indexOf("<th>الموظف</th>"));
    const order = [...head.slice(0, head.indexOf("</tr>")).matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map(
      m => m[1]
    );
    expect(order).toEqual([
      "الموظف", "المرتب", "الأيام", "السلف",
      "البونص", "الخصم", "المستحق", "المدفوع", "المتبقي", "الحالة",
    ]);
  });

  it("🔑 والمحرّك زي ما هو — نفس الـendpoints مش مسار جديد", () => {
    // القاعدة: الواجهة اتغيّرت، المحرك تحتها ما اتلمسش.
    for (const call of [
      "trpc.payroll.periodCreate",
      "trpc.payroll.periodRecalculate",
      "trpc.payroll.itemUpdate",
      "trpc.payroll.periodApprove",
      "trpc.payroll.periodPay",
      "trpc.payroll.advanceCreate",
    ]) {
      expect(code, call).toContain(call);
    }
  });

  it("🔑 ومفيش مسار دفع جديد اتعمل", () => {
    expect(code).not.toContain("treasuryCreate");
    expect(code).not.toContain("expensePay");
  });

  it("🔑 البونص والخصم بيتعدّلوا في الجدول — مش نافذة لكل موظف", () => {
    // دول أكتر حقلين بيتغيّروا كل شهر؛ نافذة لكل واحد كانت بتخلي قفل الشهر رحلة.
    expect(code).toContain('editNumber(row, "bonuses"');
    expect(code).toContain('editNumber(row, "deductions"');
  });

  it("🔑 والتعديل مفتوح في المسودة بس", () => {
    expect(code).toContain('const isPaid = period?.status === "paid"');
    expect(code).toContain('const isDraft = period?.status === "draft"');
    // كان `disabled={isPaid}` — يعني الدورة المعتمدة (قبل الصرف) كانت لسه بتتعدّل
    // والأرقام المعتمدة تتغيّر تحت. دلوقتي الإدخال في المسودة بس.
    expect(code).toContain("disabled={!isDraft}");
  });

  it("🔑 إجراء أساسي واحد واضح — والباقي أهدى", () => {
    const actions = code.slice(code.indexOf('<Panel\n            title="متابعة الموظفين"'));
    const header = actions.slice(0, actions.indexOf("<TableScroll>"));
    expect(header).toContain('variant="outline"');
    // «اصرف» هو الوحيد من غير outline، وبيقول الرقم اللي هيخرج فعلًا (المتبقي).
    expect(header).toContain("اصرف {formatMoney(totals.remaining)}");
  });

  it("🔑 ودليل الصرف بقى جوه الدرج مش ثابت فوق الصفحة", () => {
    expect(code).toContain("!evidence.trim()");
    // الحقل جوه `PayrollActionDialog` — مش في جسم الشاشة.
    const dialog = code.slice(code.indexOf("function PayrollActionDialog("));
    expect(dialog).toContain("دليل الصرف");
    // على الكود بدون التعليقات: الشرح اللي فوق الدرج بيذكر اسم الحقل نفسه.
    const workspace = code.slice(
      code.indexOf("function PeriodWorkspace("),
      code.indexOf("function PayrollActionDialog(")
    );
    expect(workspace).not.toContain("دليل الصرف");
  });
});
