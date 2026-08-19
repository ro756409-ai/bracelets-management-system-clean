import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  DEFAULT_TREASURY_ACCOUNT_CODE,
  DEFAULT_TREASURY_ACCOUNT_NAME,
  resolveDefaultTreasuryAccountInTransaction,
} from "./accountingV2.service";
import {
  paymentSourceId,
  paymentSourceMissing,
} from "../client/src/components/accounting/PaymentSource";

/**
 * «الخزنة الرئيسية».
 *
 * الجسر خلّى الدفع يحرّك الخزنة — بس الدفع نفسه كان لسه بيقف قبل ما يبدأ: بيطلب «حساب
 * مالي مصدر» من قايمة فاضية، ولو مالقاش بيرمي «Financial account is outside this
 * business». التاجر مش محاسب ومش المفروض يفهم الجملة دي ولا يعرف يحلّها.
 *
 * الاختبارات دي بتقفل إن النشاط بياخد خزنة واحدة بتتعمل لوحدها، إنها **واحدة** مهما
 * اتنادت كام مرة، وإن التاجر مايشوفش كلمة حساب ولا كود ولا مدين ودائن.
 */

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
const read = (f: string) => codeOnly(fs.readFileSync(f, "utf-8"));

/**
 * `tx` مزيّف: طابور نتايج للـselect بالترتيب، وتسجيل لكل insert.
 * `failInsert` بيحاكي وقوع الـunique index لما نداءين يتسابقوا.
 */
function fakeTx(opts: { selects: any[][]; failInsert?: boolean }) {
  const inserted: any[] = [];
  let nth = 0;
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
      const i = nth++;
      return chain(() => opts.selects[i] ?? []);
    },
    insert: () => ({
      values: (v: any) => {
        if (opts.failInsert)
          return Promise.reject(
            new Error("Duplicate entry for key 'financial_accounts_business_code_unique'")
          );
        inserted.push(v);
        return Promise.resolve({ insertId: 12 });
      },
    }),
  };
  return { tx, inserted, insertCount: () => inserted.length };
}

const account = (over: Record<string, any> = {}) => ({
  id: 5,
  businessId: 1,
  code: DEFAULT_TREASURY_ACCOUNT_CODE,
  name: DEFAULT_TREASURY_ACCOUNT_NAME,
  isActive: true,
  currencyCode: "EGP",
  ...over,
});

// ───────────────── السلوك ─────────────────

describe("🔑 الخزنة الرئيسية بتتعمل لوحدها", () => {
  it("بتتعمل باسم «الخزنة الرئيسية» لما مايكونش فيه واحدة", async () => {
    const { tx, inserted } = fakeTx({
      selects: [[], [{ baseCurrency: "EGP" }], [account()]],
    });
    const row = await resolveDefaultTreasuryAccountInTransaction(tx, 1);
    expect(inserted[0].name).toBe("الخزنة الرئيسية");
    expect(inserted[0].code).toBe("CASH-MAIN");
    expect(row.id).toBe(5);
  });

  it("🔑 بتسمح بالرصيد السالب — وإلا أول مصروف كان هيترفض", () => {
    // الحساب بيتعمل برصيد صفر، و`postFinancialTransaction` بيرفض أي حركة تنزّل الرصيد
    // تحت الصفر. من غير السطر ده التاجر كان هيقرا رسالة محاسبية بدل ما يدفع.
    const { tx, inserted } = fakeTx({
      selects: [[], [{ baseCurrency: "EGP" }], [account()]],
    });
    return resolveDefaultTreasuryAccountInTransaction(tx, 1).then(() => {
      expect(inserted[0].allowNegativeBalance).toBe(true);
      expect(inserted[0].openingBalance).toBe("0");
    });
  });

  it("بتاخد عملة النشاط مش عملة ثابتة", async () => {
    const { tx, inserted } = fakeTx({
      selects: [[], [{ baseCurrency: "USD" }], [account({ currencyCode: "USD" })]],
    });
    await resolveDefaultTreasuryAccountInTransaction(tx, 1);
    expect(inserted[0].currencyCode).toBe("USD");
  });

  it("🔑 والنداء التاني بيرجّع الموجودة من غير ما يعمل واحدة تانية", async () => {
    const { tx, insertCount } = fakeTx({ selects: [[account()]] });
    const row = await resolveDefaultTreasuryAccountInTransaction(tx, 1);
    expect(row.id).toBe(5);
    expect(insertCount()).toBe(0);
  });

  it("🔑 ونداءين متوازيين بينتهوا بخزنة واحدة مش استثناء", async () => {
    // التاني بيقع على الـunique index — وده النتيجة الصح: الخزنة اتعملت خلاص.
    const { tx } = fakeTx({
      selects: [[], [{ baseCurrency: "EGP" }], [account({ id: 5 })]],
      failInsert: true,
    });
    const row = await resolveDefaultTreasuryAccountInTransaction(tx, 1);
    expect(row.id).toBe(5);
  });

  it("لو وقع الإدخال والخزنة مش موجودة فعلًا، الخطأ بيطلع", async () => {
    const { tx } = fakeTx({ selects: [[], [{ baseCurrency: "EGP" }], []], failInsert: true });
    await expect(
      resolveDefaultTreasuryAccountInTransaction(tx, 1)
    ).rejects.toThrow(/Duplicate entry/);
  });

  it("خزنة موقوفة بترمي رسالة عربية مفهومة مش بتتعدّى بصمت", async () => {
    const { tx } = fakeTx({ selects: [[account({ isActive: false })]] });
    await expect(
      resolveDefaultTreasuryAccountInTransaction(tx, 1)
    ).rejects.toThrow("الخزنة الرئيسية موقوفة — فعّلها من إعدادات الحسابات");
  });

  it("نشاط مش موجود بيترفض قبل أي إدخال", async () => {
    const { tx, insertCount } = fakeTx({ selects: [[], []] });
    await expect(
      resolveDefaultTreasuryAccountInTransaction(tx, 99)
    ).rejects.toThrow("Business not found");
    expect(insertCount()).toBe(0);
  });
});

// ───────────────── الوصل بمسارات الدفع ─────────────────

describe("🔑 الدفع بيرجع للخزنة الرئيسية لما مااتحددش حساب", () => {
  const expensesSvc = read("server/expensesV2.service.ts");
  const payrollSvc = read("server/payrollV2.service.ts");
  const routers = read("server/routers.ts");

  it("دفع المصروف بيحلّها", () => {
    expect(expensesSvc).toContain(
      "input.sourceAccountId ??\n      (await resolveDefaultTreasuryAccountInTransaction(tx, input.businessId)).id"
    );
  });

  it("وصرف المرتبات كمان", () => {
    expect(payrollSvc).toContain("resolveDefaultTreasuryAccountInTransaction(tx, period.businessId)");
  });

  it("🔑 والعقد بقى بيسمح بغياب الحساب في المسارين", () => {
    const pay = routers.slice(
      routers.indexOf("expensePay: permissionProcedure"),
      routers.indexOf("adSpendCreate: permissionProcedure")
    );
    expect(pay).toContain("sourceAccountId: z.number().optional()");
    const periodPay = routers.slice(
      routers.indexOf("periodPay: permissionProcedure"),
      routers.indexOf("periodPay: permissionProcedure") + 600
    );
    expect(periodPay).toContain("sourceAccountId: z.number().optional()");
  });

  it("🔑 بتتحل جوه ترانزاكشن الدفع — فلو الدفعة رجعت الخزنة ترجع معاها", () => {
    for (const [name, src] of [
      ["expensesV2", expensesSvc],
      ["payrollV2", payrollSvc],
    ] as const) {
      expect(src, name).toContain(
        "resolveDefaultTreasuryAccountInTransaction(tx,"
      );
    }
  });

  it("🔑 والحساب اللي اتصرف منه فعلًا هو اللي بيتسجّل في الحدث", () => {
    // لو الحدث سجّل `input.sourceAccountId` كان هيسجّل `undefined` في الحالة الافتراضية.
    const payFn = expensesSvc.slice(
      expensesSvc.indexOf("export async function payExpense"),
      expensesSvc.indexOf("export async function createAdSpendDraft")
    );
    const resolveAt = payFn.indexOf("const sourceAccountId =");
    const eventAt = payFn.indexOf("createBusinessEventInTransaction");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(eventAt).toBeGreaterThan(resolveAt);
    expect(payFn).toContain("sourceAccountId },");
  });
});

// ───────────────── اللي التاجر بيشوفه ─────────────────

describe("🔑 التاجر مايشوفش كلام محاسبة", () => {
  const component = fs.readFileSync(
    "client/src/components/accounting/PaymentSource.tsx",
    "utf-8"
  );
  const expensesPage = fs.readFileSync("client/src/pages/Expenses.tsx", "utf-8");
  const payrollPage = fs.readFileSync("client/src/pages/Payroll.tsx", "utf-8");

  const one = [{ id: 5, name: "الخزنة الرئيسية", isActive: true }];
  const two = [...one, { id: 6, name: "حساب البنك", isActive: true }];

  it("🔑 خزنة واحدة (أو ولا واحدة) = مفيش قايمة اختيار", () => {
    expect(component).toContain("if (active.length <= 1)");
    expect(component).toContain("الخزنة الرئيسية");
  });

  it("🔑 وبيتبعت للسيرفر «من غير حساب» يعني الافتراضي", () => {
    expect(paymentSourceId([], "")).toBeUndefined();
    expect(paymentSourceId(one, "")).toBeUndefined();
    expect(paymentSourceId(one, "5")).toBeUndefined();
  });

  it("أكتر من خزنة = القايمة بتظهر والاختيار بيتبعت", () => {
    expect(paymentSourceId(two, "6")).toBe(6);
  });

  it("🔑 والدفع بيقف بس لما القايمة ظاهرة ومااتختارش منها", () => {
    expect(paymentSourceMissing([], "")).toBe(false);
    expect(paymentSourceMissing(one, "")).toBe(false);
    expect(paymentSourceMissing(two, "")).toBe(true);
    expect(paymentSourceMissing(two, "6")).toBe(false);
  });

  it("الحسابات الموقوفة مابتتحسبش في العدّ", () => {
    const withInactive = [...one, { id: 7, name: "قديم", isActive: false }];
    expect(paymentSourceMissing(withInactive, "")).toBe(false);
    expect(paymentSourceId(withInactive, "")).toBeUndefined();
  });

  it("🔑 الشاشتين بيستخدموا نفس المكوّن — مفيش نسختين بيتفرقوا", () => {
    for (const [name, page] of [
      ["Expenses", expensesPage],
      ["Payroll", payrollPage],
    ] as const) {
      expect(page, name).toContain(
        'from "@/components/accounting/PaymentSource"'
      );
      expect(page, name).toContain("<PaymentSource");
    }
  });

  it("🔑 مفيش قايمة حسابات فاضلة في مسار دفع المصروف", () => {
    expect(expensesPage).not.toContain("الحساب المصدر");
  });

  it("صرف السُلفة لسه بيطلب حسابين — وده مقصود", () => {
    // السُلفة مش صرف عادي: فلوس بتخرج من الخزنة **وبتتسجّل ديْن على الموظف**، فمحتاجة
    // حساب مدينين جنب الخزنة. ما ينفعش الاتنين يبقوا «الخزنة الرئيسية» — كده القيد
    // بيتصفّر والسُلفة تختفي. الشاشة دي محتاجة قرار محاسبي، مش قيمة افتراضية.
    const advance = payrollPage.slice(payrollPage.indexOf("حساب سلف الموظفين"));
    expect(advance).toContain("receivableAccountId");
    expect(payrollPage).toContain("الحساب المصدر");
  });

  it("🔑 ومفيش كلمة «حساب مالي» ولا كود ولا نوع في شاشة الدفع", () => {
    for (const forbidden of ["accountType", "الحساب المصدر", "مدين", "دائن"]) {
      expect(component, forbidden).not.toContain(forbidden);
    }
  });
});
