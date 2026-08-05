import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * إجراءات مركز التسجيل اليومي.
 *
 * كل إجراء ليه عقد مختلف على السيرفر، فكل واحد لازم يكون ليه مجموعة تحقق خاصة بيه
 * وحقول مطابقة لعقده. الاختبارات دي بتقفل الحاجة اللي وقعت قبل كده: نموذج بيطلب حقل
 * مالوش خانة، أو بيعرض خانة مالهاش مكان في الـAPI.
 */

const page = fs.readFileSync("client/src/pages/DailyLedger.tsx", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");

/** Comments stripped — "must not contain" is meaningless against prose that names things. */
const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("الإجراءات المتاحة", () => {
  it("أربع إجراءات، كل واحد بعقده", () => {
    const m = code.match(/type ActionKind = ([^;]+);/);
    expect(m).toBeTruthy();
    for (const k of ["expense", "deposit", "withdrawal", "collection"]) {
      expect(m![1], k).toContain(k);
    }
  });

  it("كل إجراء ليه mutation بتاعته", () => {
    const muts = [...code.matchAll(/trpc\.accounting\.(\w+)\.useMutation/g)].map(m => m[1]);
    expect(new Set(muts)).toEqual(
      new Set(["expenseCreate", "treasuryCreate", "collectionRecord"])
    );
  });
});

describe("التحصيل — عقده مختلف عن الباقي", () => {
  it("🔑 مجموعة تحقق مستقلة، مش المشتركة", () => {
    expect(code).toContain("function validateCollection()");
    expect(code).toContain('if (action === "collection") return validateCollection();');
  });

  it("🔑 مابيطلبش براند — الأوردر شايل البراند بتاعه", () => {
    const fn = code.slice(code.indexOf("function validateCollection()"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    expect(body).toContain("errors.orderId");
    expect(body).toContain("errors.amount");
    expect(body).not.toContain("businessId");
    expect(body).not.toContain("description");
  });

  it("🔑 والحفظ نفسه مابيوقفش على البراند في حالة التحصيل", () => {
    expect(code).toContain('if (action !== "collection" && chosenBusinessId == null) return;');
  });

  it("🔑 الحقول اللي مالهاش مكان في الـAPI مش معروضة", () => {
    // collectionRecord بياخد orderId و collectedAmount و collectedAt وبس — مفيش بيان
    // ولا ملاحظات ولا براند، فالخانات دي بتتخفي بدل ما المستخدم يكتب حاجة تتضيع.
    expect(code).toContain('{action !== "collection" && brands.length > 1 && (');
    expect(code).toContain('{action !== "collection" && (');
    expect(code).toContain('{(action === "deposit" || action === "withdrawal") && (');
  });

  it("العقد على السيرفر: orderId + collectedAmount بس", () => {
    const i = routers.indexOf("    collectionRecord: permissionProcedure");
    const input = routers.slice(i, routers.indexOf(".mutation(", i));
    expect(input).toContain("orderId");
    expect(input).toContain("collectedAmount");
    expect(input).not.toContain("businessId");
    expect(input).not.toContain("description");
  });

  it("🔑 المبلغ بيتعبّى بالمتبقي مش بالإجمالي", () => {
    // لو اتعبّى بالإجمالي، أوردر متحصّل جزئيًا هيتسجّل تاني بالكامل والفرق يتضاعف.
    expect(code).toContain(
      "Number(o.totalAmount ?? 0) - Number(o.collectedAmount ?? 0)"
    );
    expect(code).toContain("setAmount(String(outstanding));");
  });

  it("بيجيب الأوردرات المستنية بس، ووقت فتح النموذج بس", () => {
    expect(code).toContain('collectionStatus: "pending"');
    expect(code).toContain('enabled: action === "collection"');
  });
});

describe("الرسائل جنب حقولها", () => {
  it("مفيش صندوق أخطاء مجمّع", () => {
    expect(code).not.toContain("issues.map");
  });

  it("كل حقل بيوري خطأه", () => {
    for (const f of ["businessId", "amount", "description", "orderId"]) {
      expect(code, f).toContain(`showError("${f}")`);
    }
  });
});

describe("المصروف مستحق مش مدفوع", () => {
  const db = fs.readFileSync("server/db.ts", "utf-8");
  const fn = db.slice(
    db.indexOf("export async function getDailyLedgerSummary"),
    db.indexOf("// ==================== PAYROLL")
  );

  it("🔑 المدفوع بيتقرا من expense_payments مش من الخزنة", () => {
    // createExpenseDraft بيعمل مسودة في `expenses` ومفيش صف خزنة، فعدّ صفوف الخزنة
    // من نوع 'expense' كان بيرجّع صفر لكل مصروف اتسجّل من الشاشة.
    expect(fn).toContain("from(expensePayments)");
    expect(fn).toContain("gte(expensePayments.paidAt, from)");
    expect(fn).not.toContain("${treasuryTransactions.type} = 'expense'");
  });

  it("🔑 المستحق = المبلغ ناقص المدفوع، للحالات غير المدفوعة", () => {
    expect(fn).toContain("${expenses.amount} - ${expenses.paidAmount}");
    for (const st of ["draft", "pending_approval", "accrued", "partially_paid"]) {
      expect(fn, st).toContain(`"${st}"`);
    }
  });

  it("الملغي مش التزام فمش محسوب", () => {
    const due = fn.slice(fn.indexOf("const [dueExpenses]"));
    expect(due.slice(0, due.indexOf("];"))).not.toContain('"voided"');
  });

  it("🔑 المستحق مش محدود باليوم — اللي عليك من الأسبوع اللي فات لسه عليك", () => {
    const due = fn.slice(fn.indexOf("const [dueExpenses]"), fn.indexOf("// Money already out"));
    expect(due).not.toContain("gte(expenses.expenseDate");
    expect(due).not.toContain("toExclusive");
  });

  it("الرقمين منفصلين في المخرجات", () => {
    expect(fn).toContain("expensesPaid:");
    expect(fn).toContain("expensesDue:");
    expect(fn).not.toContain("\n    expenses: Number(");
  });

  it("🔑 الشاشة بتفرّق بينهم وبتقول للمحاسب", () => {
    expect(page).toContain("مصروفات مدفوعة");
    expect(page).toContain("مصروفات مستحقة");
    expect(page).toContain("مستحق وغير مدفوع");
    expect(page).toContain("حركات الخزنة اليوم");
  });

  it("🔑 مفيش حركة خزنة مصطنعة — فرع المصروف بينادي expenseCreate وبس", () => {
    // الفحص على **فرع المصروف** نفسه، مش على الدالة كلها: الدالة فيها فرع تاني
    // للإيداع والسحب بينادي treasuryCreate بشكل مشروع، والفحص العام كان بيقع عليه.
    const i = code.indexOf('if (action === "expense") {');
    const branch = code.slice(i, code.indexOf("} else {", i));
    expect(branch).toContain("expenseMutation.mutateAsync");
    expect(branch).not.toContain("treasuryMutation");
    expect(branch).not.toContain("collectionMutation");
  });
});
