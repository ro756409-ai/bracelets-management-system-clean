import { describe, it, expect } from "vitest";
import fs from "fs";
import { addTreasuryTransactionInTransaction } from "./db";

/**
 * الجسر بين دفترَي الفلوس.
 *
 * المشروع فيه دفترين اتبنوا في وقتين: `treasury_transactions` (الخزنة اللي التاجر
 * بيشوف رصيدها) و`financial_transactions` (القيد المحاسبي). الدفع كان بيكتب في التاني
 * وبس — فالتاجر يدفع إعلان بألف جنيه، «مصروفات مدفوعة» تزيد، والخزنة زي ما هي.
 *
 * الاختبارات دي بتقفل تلات حاجات:
 *   ١. حسابات السلسلة صح (الاتجاه، الرصيد بعد الحركة، الرفض عند فشل الإدخال).
 *   ٢. الدفع بيكتب في الدفترين **جوه ترانزاكشن واحدة** — مافيش نص دفعة.
 *   ٣. الحركة بتتكتب **مرة واحدة بالظبط** لكل دفعة، ومفيش جدول ولا عمود جديد.
 */

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const read = (f: string) => codeOnly(fs.readFileSync(f, "utf-8"));
const expensesSvc = read("server/expensesV2.service.ts");
const payrollSvc = read("server/payrollV2.service.ts");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, `مالقيتش «${start}»`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j > -1 ? j : undefined);
};

const payExpenseFn = between(
  expensesSvc,
  "export async function payExpense",
  "export async function createAdSpendDraft"
);
const payPayrollFn = payrollSvc.slice(
  payrollSvc.indexOf("export async function payPayrollPeriodV2")
);

// ───────────────── حسابات السلسلة ─────────────────

/**
 * `tx` مزيّف بيحاكي سلسلة Drizzle: كل ميثود بترجّع نفس الكائن، والكائن نفسه awaitable.
 * أول `select` هو قراءة آخر رصيد، والتاني هو قراءة الصف اللي اتكتب.
 */
function fakeTx(opts: { last?: string; insertId?: number | null } = {}) {
  const inserted: any[] = [];
  let selects = 0;
  const chain = (resolve: () => any) => {
    const obj: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then")
            return (ok: any, no: any) => Promise.resolve(resolve()).then(ok, no);
          return () => obj;
        },
      }
    );
    return obj;
  };
  const tx = {
    select: () => {
      const nth = selects++;
      return chain(() =>
        nth === 0
          ? opts.last === undefined
            ? []
            : [{ balanceAfter: opts.last }]
          : [{ id: 7, ...inserted[0] }]
      );
    },
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        return Promise.resolve({
          insertId: opts.insertId === undefined ? 7 : opts.insertId,
        });
      },
    }),
  };
  return { tx, inserted };
}

const movement = (over: Record<string, any> = {}) => ({
  businessId: 1,
  type: "expense" as const,
  direction: "out" as const,
  amount: "250.0000",
  description: "دفع مصروف",
  referenceType: "expense" as const,
  referenceId: 9,
  performedBy: 3,
  performedByName: "المالك",
  transactionDate: new Date("2026-08-06T10:00:00Z"),
  ...over,
});

describe("🔑 الرصيد بعد الحركة", () => {
  it("الصرف بينقص من الرصيد", async () => {
    const { tx, inserted } = fakeTx({ last: "1000.00" });
    await addTreasuryTransactionInTransaction(tx, movement());
    expect(inserted[0].balanceAfter).toBe("750.00");
  });

  it("والدخول بيزوّده", async () => {
    const { tx, inserted } = fakeTx({ last: "1000.00" });
    await addTreasuryTransactionInTransaction(
      tx,
      movement({ direction: "in", type: "collection" })
    );
    expect(inserted[0].balanceAfter).toBe("1250.00");
  });

  it("أول حركة في نشاط لسه مافيهوش حركات بتبدأ من صفر", async () => {
    const { tx, inserted } = fakeTx({});
    await addTreasuryTransactionInTransaction(tx, movement());
    expect(inserted[0].balanceAfter).toBe("-250.00");
  });

  it("🔑 الرصيد بيتقفل قبل القراءة عشان حركتين متوازيتين مايقروش نفس الرقم", () => {
    const fn = between(
      read("server/db.ts"),
      "export async function addTreasuryTransactionInTransaction",
      "export async function addTreasuryTransaction("
    );
    expect(fn).toContain('.for("update")');
  });

  it("🔑 فشل الإدخال بيرجّع null — مابيخترعش صف", async () => {
    const { tx } = fakeTx({ last: "1000.00", insertId: null });
    expect(await addTreasuryTransactionInTransaction(tx, movement())).toBeNull();
  });

  it("بيرجّع الصف اللي اتكتب لما ينجح", async () => {
    const { tx } = fakeTx({ last: "1000.00" });
    const row = await addTreasuryTransactionInTransaction(tx, movement());
    expect(row?.id).toBe(7);
  });
});

// ───────────────── دفع المصروف ─────────────────

describe("🔑 دفع المصروف بيحرّك الخزنة", () => {
  it("بينزّل حركة خزنة خارجة نوعها مصروف", () => {
    expect(payExpenseFn).toContain("addTreasuryTransactionInTransaction(tx, {");
    expect(payExpenseFn).toContain('type: "expense"');
    expect(payExpenseFn).toContain('direction: "out"');
  });

  it("🔑 بمبلغ الدفعة مش بإجمالي المصروف", () => {
    // الدفع الجزئي لازم يخصم الجزء بس. `expense.amount` هنا كان هيخصم الإجمالي كل مرة.
    const call = between(payExpenseFn, "addTreasuryTransactionInTransaction", "});");
    expect(call).toContain("amount: fromMinorUnits(paymentMinor)");
    expect(call).not.toContain("amount: expense.amount");
  });

  it("مربوطة بالمصروف عشان تتراجع لمصدرها", () => {
    const call = between(payExpenseFn, "addTreasuryTransactionInTransaction", "});");
    expect(call).toContain('referenceType: "expense"');
    expect(call).toContain("referenceId: expense.id");
  });

  it("🔑 جوه نفس الترانزاكشن — يا الاتنين يا ولا واحد", () => {
    const i = payExpenseFn.indexOf("db.transaction(async tx =>");
    const j = payExpenseFn.indexOf("addTreasuryTransactionInTransaction");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(payExpenseFn).not.toMatch(/await addTreasuryTransaction\(/);
  });

  it("🔑 ولو الخزنة فشلت الدفعة كلها بترجع", () => {
    expect(payExpenseFn).toContain("if (!treasury) throw new Error");
  });

  it("🔑 حركة واحدة بالظبط لكل دفعة", () => {
    const calls =
      payExpenseFn.match(/addTreasuryTransactionInTransaction\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect((payExpenseFn.match(/insert\(expensePayments\)/g) ?? []).length).toBe(1);
  });

  it("🔑 والحواجز اللي بتمنع الدفع مرتين لسه مكانها", () => {
    // القفل على الصف بيسلسل أي دفعتين، والحالة بترفض المدفوع بالكامل، و`remaining`
    // بيرفض الزيادة. حركة الخزنة جوه نفس الترانزاكشن فبتورث الحمايات دي كلها.
    expect(payExpenseFn).toContain('.limit(1).for("update")');
    expect(payExpenseFn).toContain(
      "if (!['accrued', 'partially_paid'].includes(expense.status))"
    );
    expect(payExpenseFn).toContain("paymentMinor > remaining");
  });
});

// ───────────────── صرف المرتبات ─────────────────

describe("🔑 صرف المرتبات بيحرّك الخزنة", () => {
  it("بينزّل حركة خارجة", () => {
    expect(payPayrollFn).toContain("addTreasuryTransactionInTransaction(tx, {");
    expect(payPayrollFn).toContain('direction: "out"');
  });

  it("🔑 بالصافي مش بالإجمالي", () => {
    // السُلف والخصومات اتسوّت قبل كده. `totalGross` هنا كان هيخصم فلوس مخرجتش.
    const call = between(payPayrollFn, "addTreasuryTransactionInTransaction", "});");
    expect(call).toContain("amount: period.totalNet");
    expect(call).not.toContain("totalGross");
  });

  it("🔑 النداء التاني بيرجع قبل أي حركة خزنة", () => {
    const dup = payPayrollFn.indexOf("if (event.duplicate)");
    const treasury = payPayrollFn.indexOf("addTreasuryTransactionInTransaction");
    expect(dup).toBeGreaterThan(-1);
    expect(treasury).toBeGreaterThan(dup);
    expect(payPayrollFn).toContain(
      "idempotencyKey: `payroll-period:${period.id}:paid`"
    );
  });

  it("🔑 حركة واحدة بالظبط", () => {
    expect(
      (payPayrollFn.match(/addTreasuryTransactionInTransaction\(/g) ?? []).length
    ).toBe(1);
  });

  it("ولو الخزنة فشلت الصرف بيرجع", () => {
    expect(payPayrollFn).toContain("if (!treasury) throw new Error");
  });
});

// ───────────────── الإعلانات ─────────────────

describe("🔑 الإعلانات بتمشي على نفس الجسر", () => {
  const adDraftFn = expensesSvc.slice(
    expensesSvc.indexOf("export async function createAdSpendDraft")
  );

  it("🔑 المسودة مابتحركش الخزنة — الفلوس لسه مخرجتش", () => {
    expect(adDraftFn).toContain("insert(expenses)");
    expect(adDraftFn).not.toContain("addTreasuryTransaction");
    expect(adDraftFn).not.toContain("treasuryTransactions");
  });

  it("🔑 ومفيش مسار دفع تاني للإعلانات — نفس payExpense", () => {
    // صرف الإعلان بيتسجّل كصف في `expenses`، فدفعه بيمر من نفس الدالة اللي بتدفع أي
    // مصروف. لو كان ليه مسار خاص كان لازم يتجسّر لوحده — وده تاني مكان يغلط فيه.
    expect(
      (expensesSvc.match(/insert\(expensePayments\)/g) ?? []).length
    ).toBe(1);
  });
});

// ───────────────── مفيش عدّ مرتين في الشاشات ─────────────────

describe("🔑 المصروف بيتعدّ مرة واحدة في التقارير", () => {
  const dbCode = read("server/db.ts");
  const dailySummary = between(
    dbCode,
    "export async function getDailyLedgerSummary",
    "export async function getAccountingControlCenter"
  );
  const controlCenter = dbCode.slice(
    dbCode.indexOf("export async function getAccountingControlCenter")
  );

  it("🔑 كشف اليوم بيقرا المصروفات من دورة حياة المصروف مش من الخزنة", () => {
    // قبل الجسر ماكانش فيه صفوف خزنة نوعها «مصروف» أصلاً، فالقرار ده كان تجميلي.
    // بعد الجسر بقى حامل وزن: لو الكشف جمع الاتنين، المصروف يتعدّ مرتين.
    expect(dailySummary).toContain("expensePayments");
    expect(dailySummary).not.toMatch(
      /treasuryTransactions\.type\} = 'expense'/
    );
  });

  it("🔑 ومركز التحكم برضه", () => {
    expect(controlCenter).not.toMatch(/treasuryTransactions\.type\} = 'expense'/);
  });

  it("رصيد الخزنة بيتقرا من آخر balanceAfter — فبيتحرّك لوحده", () => {
    const balance = between(
      dbCode,
      "export async function getTreasuryBalance",
      "export async function addTreasuryTransactionInTransaction"
    );
    expect(balance).toContain("treasuryTransactions.balanceAfter");
    expect(balance).toContain("orderBy(desc(treasuryTransactions.id))");
  });
});

// ───────────────── مفيش تغيير في قاعدة البيانات ─────────────────

describe("🔑 الجسر مااحتاجش migration", () => {
  const table = between(schema, "treasuryTransactions = mysqlTable(", "});");

  it("نوع «مصروف» موجود في enum الحركات من الأصل", () => {
    expect(between(table, 'mysqlEnum("type", [', "])")).toContain('"expense"');
  });

  it("و«expense» موجودة في مراجع الحركة", () => {
    expect(between(table, 'mysqlEnum("referenceType", [', "])")).toContain(
      '"expense"'
    );
  });

  it("🔑 الجسر مالمسش تعريف الجدول", () => {
    // الحقول اللي الجسر بيكتبها كلها موجودة في التعريف من قبله. لو حد ضاف عمود جديد
    // للحركة عشان الجسر، الاختبار ده بيوقّفه — لأن العمود ده هيحتاج migration، وأي
    // عمود في schema.ts مش موجود في الإنتاج بيكسر كل قراءة على الجدول.
    const table = between(schema, 'treasuryTransactions = mysqlTable(', "});");
    for (const col of [
      "businessId", "type", "direction", "amount", "balanceAfter",
      "description", "referenceType", "referenceId",
      "performedBy", "performedByName", "transactionDate",
    ]) {
      expect(table, col).toContain(col);
    }
  });
});
