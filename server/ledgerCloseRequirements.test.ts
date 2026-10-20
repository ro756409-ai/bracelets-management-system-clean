import { describe, it, expect } from "vitest";
import fs from "fs";
import { requirementChecks } from "./ledgerCloseRequirements.service";
import { LEDGER_REVIEW_PREFIX, ledgerReviewReasons } from "../shared/ledgerReview";

/** BUG-88 — بنود الإقفال الجديدة (بلا قاعدة بيانات) والربط بالقائمة وبادئة المراجعة المالية. */
describe("requirementChecks", () => {
  it("لا فجوات = كل البنود ok", () => {
    const c = requirementChecks({ stocktakes: [], returnInspections: [], orderCosts: [], orderReturns: [], openReviewItems: 0 });
    expect(c.map(x => x.key)).toEqual(["stocktake_variances", "return_inspections", "order_costs", "order_returns", "review_queue"]);
    expect(c.every(x => x.ok)).toBe(true);
  });

  it("كل فجوة تمنع وتذكر العدد والمراجع (أول 5 فقط)", () => {
    const c = Object.fromEntries(requirementChecks({ stocktakes: [1, 2, 3, 4, 5, 6], returnInspections: [9], orderCosts: [7], orderReturns: [8], openReviewItems: 2 }).map(x => [x.key, x]));
    expect(Object.values(c).every((x: any) => !x.ok)).toBe(true);
    expect(c.stocktake_variances.label).toBe("6 جرد معتمد بفرق بلا قيد في الدفتر (جرد #1، جرد #2، جرد #3، جرد #4، جرد #5، …)");
    expect(c.return_inspections.label).toContain("فحص #9");
    expect(c.order_costs.label).toContain("أوردر #7");
    expect(c.order_returns.label).toContain("أوردر #8");
    expect(c.review_queue.label).toMatch(/^2 بند مفتوح/);
  });

  it("تعذر فحص المرتجعات = ممنوع (لا نجاح كاذب)", () => {
    const r = requirementChecks({ stocktakes: [], returnInspections: [], orderCosts: [], orderReturns: null, openReviewItems: 0 }).find(x => x.key === "order_returns")!;
    expect(r.ok).toBe(false);
    expect(r.label).toContain("تعذر فحص");
  });
});

describe("ledgerReviewReasons", () => {
  it("يستخرج أسباب «دفتر:» فقط", () => {
    expect(ledgerReviewReasons("منتج غير مطابق | دفتر: لم تُسجَّل التكلفة | رقم ناقص | دفتر: لم يُعكس الإيراد"))
      .toEqual(["دفتر: لم تُسجَّل التكلفة", "دفتر: لم يُعكس الإيراد"]);
    expect(ledgerReviewReasons(null)).toEqual([]);
    expect(LEDGER_REVIEW_PREFIX).toBe("دفتر:");
  });
});

describe("الربط (فحص ثابت)", () => {
  it("قائمة الإقفال تضم البنود الجديدة، والإقفال يشغّلها داخل transaction القفل، وربط الأوردرات يستخدم نفس البادئة", () => {
    const reports = fs.readFileSync("server/ledgerReports.service.ts", "utf8");
    expect(reports).toContain("...requirementChecks(gaps)");
    const close = fs.readFileSync("server/ledgerClose.service.ts", "utf8");
    expect(close).toMatch(/beforeLock: async \(\) => \{\s*checklist = await closeChecklist/);
    expect(close).toContain("if (!checklist.ready) throw new LedgerError(\"conflict\"");
    expect(fs.readFileSync("server/ledgerOrders.service.ts", "utf8")).toContain("const REVIEW_PREFIX = LEDGER_REVIEW_PREFIX;");
    expect(fs.readFileSync("server/db.ts", "utf8")).toContain("ledgerReviewReasons(target.reviewReason)");
  });
});
