import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  stocktakeApproveFeedback,
  STOCKTAKE_APPROVED_POSTED,
  STOCKTAKE_APPROVED_REVIEW,
  STOCKTAKE_APPROVED_SKIPPED,
} from "./stocktakeApproveFeedback";

/** BUG-55: رسالة اعتماد الجرد بتعكس حالة قيد الدفتر الفعلية — مش «نجاح كامل» ثابت. */
describe("stocktakeApproveFeedback", () => {
  it("posted / replay / من غير ledger = النجاح الكامل القديم", () => {
    for (const r of [{ ledger: { status: "posted" } }, { ledger: { status: "replay" } }, {}, null, undefined])
      expect(stocktakeApproveFeedback(r)).toEqual({ kind: "success", title: STOCKTAKE_APPROVED_POSTED });
  });

  it("review = تحذير صريح إن القيد ماتسجّلش، بالسبب، ومن غير ادعاء تسجيل الخسارة/الربح", () => {
    const fb = stocktakeApproveFeedback({ ledger: { status: "review", reason: "خطأ داخلي (ER_LOCK_DEADLOCK)" } });
    expect(fb.kind).toBe("warning");
    expect(fb.title).toBe(STOCKTAKE_APPROVED_REVIEW);
    expect(fb.title).not.toContain("اتسجّل خسارة");
    expect(fb.description).toContain("خطأ داخلي (ER_LOCK_DEADLOCK)");
    expect(fb.description).toContain("سجل النشاط");
  });

  it("review من غير سبب لسه تحذير", () => {
    expect(stocktakeApproveFeedback({ ledger: { status: "review" } }).kind).toBe("warning");
  });

  it("skipped = نجاح الاعتماد بس، مع إن القيد ماتسجّلش وسببه", () => {
    const fb = stocktakeApproveFeedback({ ledger: { status: "skipped", reason: "الدفتر أو تقييم المخزون غير مفعّل" } });
    expect(fb).toEqual({ kind: "success", title: STOCKTAKE_APPROVED_SKIPPED, description: "قيد الدفتر: لم يُسجَّل — الدفتر أو تقييم المخزون غير مفعّل." });
  });

  it("StocktakeBoard بيستخدم حالة القيد (تحذير ثابت عند review)، مش رسالة النجاح الثابتة", () => {
    const src = readFileSync(resolve(__dirname, "StocktakeBoard.tsx"), "utf8");
    expect(src).toContain("stocktakeApproveFeedback(r)");
    expect(src).toMatch(/toast\.warning\(fb\.title, \{ description: fb\.description, duration: Infinity/);
    expect(src).not.toContain('toast.success("تم الاعتماد — العجز اتسجّل خسارة مخزون');
  });
});
