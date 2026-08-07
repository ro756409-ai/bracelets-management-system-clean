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

  it("🔑 ومتوصلة بالقايمة والمسار", () => {
    expect(sidebar).toContain('path: "/salary-profiles"');
    expect(sidebar).toContain('label: "مرتبات الموظفين"');
    expect(app).toContain('<Route path="/salary-profiles">');
  });

  it("🔑 وقبل «تجهيز المرتبات» في القايمة", () => {
    // التجهيز بيحسب على الأرقام دي. لو التاجر فتحه الأول هيلاقيه فاضي ومايعرفش ليه.
    expect(sidebar.indexOf('path: "/salary-profiles"')).toBeLessThan(
      sidebar.indexOf('path: "/salary-preparation"')
    );
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
      "export async function getSalaryProfiles"
    );
    expect(fn).toContain("if (row.effectiveFrom > now) continue");
    expect(fn).toContain("if (!current.has(row.employeeId))");
  });

  it("والإصدارات القديمة مابتتمسحش", () => {
    const fn = between(
      db,
      "export async function listBusinessSalaryProfiles",
      "export async function getSalaryProfiles"
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

  it("🔑 وقايمة الموظفين مفلترة على نفس النشاط", () => {
    expect(code).toContain(
      "trpc.employees.list.useQuery({ businessId, isActive: true })"
    );
  });
});
