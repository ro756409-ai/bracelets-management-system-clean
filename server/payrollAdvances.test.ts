import { describe, it, expect } from "vitest";
import fs from "fs";
import { netFromComponents, applyRounding } from "../shared/payrollCalc";

/**
 * قاعدة السلفة — تتخصم مرة واحدة، والخزنة تنقص مرة واحدة.
 *
 * السلفة بتخرج من الدرج يوم ما تتصرف. وقت المرتب هي بتقلّل **المتبقي للموظف** بس،
 * ووقت الدفع الخزنة بتنقص بالصافي لوحده. الخطأ اللي القواعد دي بتقفله إن الجنيه
 * الواحد يتحسب مرتين: مرة يوم السلفة ومرة يوم المرتب.
 */

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
}

const line = (over: Partial<Parameters<typeof netFromComponents>[0]> = {}) =>
  netFromComponents({
    baseSalary: 5000,
    overtimeAmount: 0,
    bonuses: 0,
    commissions: 0,
    absenceDeduction: 0,
    deductions: 0,
    advances: 0,
    ...over,
  });

// ==================== ١ · المعادلة ====================

describe("🔑 مثال التاجر بالحرف", () => {
  it("٥٠٠٠ + ٥٠٠ بونص − ٢٠٠ خصم − ١٠٠٠ سلفة = ٤٣٠٠", () => {
    expect(line({ bonuses: 500, deductions: 200, advances: 1000 })).toBe(4300);
  });

  it("ولو اتدفع ٢٠٠٠ يبقى المتبقي ٢٣٠٠", () => {
    const due = line({ bonuses: 500, deductions: 200, advances: 1000 });
    expect(due - 2000).toBe(2300);
  });

  it("🔑 السلفة بتتخصم مرة واحدة — مش مرتين", () => {
    const once = line({ advances: 1000 });
    expect(once).toBe(4000);
    // لو اتخصمت مرتين كان الرقم هيبقى ٣٠٠٠ — الاختبار ده هو اللي بيمسك الرجوع.
    expect(once).not.toBe(3000);
  });

  it("السلفة الأكبر من المستحق بتطلع صافي سالب — مابتتخبّاش ورا صفر", () => {
    expect(line({ advances: 7000 })).toBe(-2000);
  });

  it("سلفة سالبة مابتتحوّلش لإضافة", () => {
    expect(line({ advances: -1000 })).toBe(5000);
  });
});

// ==================== ٢ · الخزنة ====================

describe("🔑 إجمالي اللي خرج من الخزنة = المرتب، مش المرتب + السلفة", () => {
  it("سلفة ١٠٠٠ ثم صرف ٤٠٠٠ = ٥٠٠٠ خرجوا إجمالًا", () => {
    const advance = 1000;
    const due = line({ advances: advance });
    expect(due).toBe(4000);
    // وقت السلفة: −١٠٠٠ · وقت المرتب: −٤٠٠٠
    const treasuryOut = advance + due;
    expect(treasuryOut).toBe(5000);
    expect(treasuryOut).not.toBe(6000);
  });

  it("🔑 والصرف بيخرج الصافي (totalNet) مش الإجمالي (totalGross)", () => {
    const service = codeOnly(fs.readFileSync("server/payrollV2.service.ts", "utf-8"));
    const fn = service.slice(service.indexOf("export async function payPayrollPeriodV2"));
    const treasury = fn.slice(fn.indexOf("addTreasuryTransactionInTransaction"));
    const block = treasury.slice(0, treasury.indexOf("});"));
    expect(block).toContain("amount: period.totalNet");
    expect(block).not.toContain("amount: period.totalGross");
    expect(block).toContain('direction: "out"');
  });

  it("🔑 وحركة خزنة واحدة بس في مسار الصرف", () => {
    const service = codeOnly(fs.readFileSync("server/payrollV2.service.ts", "utf-8"));
    const fn = service.slice(service.indexOf("export async function payPayrollPeriodV2"));
    expect((fn.match(/addTreasuryTransactionInTransaction\(/g) ?? []).length).toBe(1);
  });

  it("🔑 والسلفة بتخرج من الخزنة مرة واحدة وقت صرفها", () => {
    const service = codeOnly(fs.readFileSync("server/advancesV2.service.ts", "utf-8"));
    const fn = service.slice(service.indexOf("export async function issueEmployeeAdvance"));
    const body = fn.slice(0, fn.indexOf("export async function cancelEmployeeAdvance"));
    expect((body.match(/addTreasuryTransactionInTransaction\(/g) ?? []).length).toBe(1);
    expect(body).toContain('direction: "out"');
  });

  it("🔑 والصرف مابيتكررش — مفتاح ثابت للدورة", () => {
    const service = codeOnly(fs.readFileSync("server/payrollV2.service.ts", "utf-8"));
    const fn = service.slice(service.indexOf("export async function payPayrollPeriodV2"));
    expect(fn).toContain("payroll-period:${period.id}:paid");
    expect(fn).toContain("if (event.duplicate)");
  });
});

// ==================== ٣ · مفيش إدخال يدوي للسلفة ====================

describe("🔑 السلفة بتتقرا تلقائيًا — ومفيش خانة إدخال ليها", () => {
  const routers = codeOnly(fs.readFileSync("server/routers.ts", "utf-8"));
  const page = codeOnly(fs.readFileSync("client/src/pages/SalaryProfiles.tsx", "utf-8"));

  it("🔑 itemUpdate مابيقبلش advances — فمستحيل تتكتب بالإيد", () => {
    const start = routers.indexOf("itemUpdate: adminProcedure");
    const input = routers.slice(start, routers.indexOf(".mutation", start));
    expect(input).toContain("bonuses:");
    expect(input).toContain("deductions:");
    expect(input).not.toContain("advances:");
  });

  it("🔑 والاعتماد بيكتب السلف على السطر — بالاستبدال مش بالجمع", () => {
    const db = codeOnly(fs.readFileSync("server/db.ts", "utf-8"));
    const fn = db.slice(
      db.indexOf("export async function approvePayrollPeriodInTransaction"),
      db.indexOf("export async function", db.indexOf("export async function approvePayrollPeriodInTransaction") + 10)
    );
    expect(fn).toContain('eq(employeeAdvances.status, "pending")');
    // `set` بيحطّ الإجمالي مكان اللي كان — لو كان بيجمع، التكرار كان بيخصم مرتين.
    expect(fn).toContain("advances: totalAdvances.toFixed(2)");
    expect(fn).not.toContain("advances: sql`");
    // والسلفة بتتعلّم مُسوّاة، فمابتتخصمش في دورة تانية.
    expect(fn).toContain('status: "settled"');
    expect(fn).toContain("settledPeriodId: periodId");
  });

  it("🔑 والشاشة بتعرضها من غير Input", () => {
    const workspace = page.slice(
      page.indexOf("function PeriodWorkspace("),
      page.indexOf("function PayrollActionDialog(")
    );
    const cell = workspace.slice(workspace.indexOf("<td className=\"tabular-nums\" title="));
    expect(cell.slice(0, 200)).toContain("money(advances");
    expect(cell.slice(0, 200)).not.toContain("<Input");
    // والمعلّق بيتقرا من نفس مصدر السُلف.
    expect(workspace).toContain('status: "pending"');
  });

  it("🔑 والمعاينة بتستخدم نفس دالة السيرفر — مش معادلة مكتوبة في الشاشة", () => {
    expect(page).toContain("netFromComponents({");
    const workspace = page.slice(page.indexOf("function PeriodWorkspace("));
    // مفيش جمع/طرح يدوي للمكوّنات جوه الشاشة.
    expect(workspace).not.toContain("baseSalary) + Number(row.overtimeAmount)");
  });
});

// ==================== ٤ · كروت الملخص ====================

describe("🔑 كروت المرتبات الأربعة", () => {
  const page = fs.readFileSync("client/src/pages/SalaryProfiles.tsx", "utf-8");

  it("الأربعة موجودين وأهمهم «المطلوب دفعه»", () => {
    for (const label of [
      "إجمالي المرتبات الأساسية",
      "إجمالي السلف",
      "البونص والخصومات",
      "إجمالي المطلوب دفعه للموظفين",
    ]) {
      expect(page, label).toContain(label);
    }
  });

  it("🔑 و«المطلوب دفعه» هو المتبقي بعد السلف والمدفوع — مش مجموع المرتبات", () => {
    const card = page.slice(page.indexOf('label="إجمالي المطلوب دفعه للموظفين"'));
    expect(card.slice(0, 260)).toContain("formatMoney(totals.remaining)");
    expect(card.slice(0, 260)).not.toContain("totals.base");
  });

  it("🔑 والألوان مشتقّة من المعنى: السلفة كهرماني، المدفوع أخضر، المتبقي حسب اتجاهه", () => {
    expect(page).toContain('label="إجمالي السلف"');
    const advancesCard = page.slice(page.indexOf('label="إجمالي السلف"'));
    expect(advancesCard.slice(0, 200)).toContain('tone="due"');
    expect(page).toContain('toneColor("in")');
    expect(page).toContain('totals.remaining > 0 ? "out" : "in"');
  });

  it("وصف الصرف بيقول إنه الصافي مش الإجمالي", () => {
    expect(page).toContain("الصافي بعد السلف، مش إجمالي المرتبات");
  });
});

// ==================== ٥ · صف الإجماليات ====================

describe("صف الإجمالي في آخر الجدول", () => {
  it("الستة كلهم", () => {
    const page = fs.readFileSync("client/src/pages/SalaryProfiles.tsx", "utf-8");
    // محدود بجدول دورة المرتب — الصفحة فيها أكتر من جدول، وأول `<tfoot>` بتاع جدول تاني.
    const workspace = page.slice(page.indexOf("function PeriodWorkspace("));
    const foot = workspace.slice(workspace.indexOf("<tfoot>"), workspace.indexOf("</tfoot>"));
    for (const total of [
      "totals.base",
      "totals.advances",
      "totals.bonuses",
      "totals.deductions",
      "totals.paid",
      "totals.remaining",
    ]) {
      expect(foot, total).toContain(total);
    }
  });

  it("والتقريب بمنزلتين — نفس دقة العمود", () => {
    expect(applyRounding(4300.004, "none")).toBe(4300);
    expect(applyRounding(4300.006, "none")).toBe(4300.01);
  });
});
