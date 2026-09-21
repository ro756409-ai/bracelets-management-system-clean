// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveActiveBusinessId,
  activeDraftKey,
  purgeDraftsForOtherBusinesses,
  resetForBusinessSwitch,
  ACTIVE_BUSINESS_TAG,
} from "./activeBusiness";
import { DRAFT_PREFIX } from "./employeeScope";

describe("🔑 النشاط الفعّال — قواعد نقية", () => {
  it("🔑 نشاط واحد متاح → يتحدد تلقائيًا (حتى لو المخزّن غيره)", () => {
    expect(resolveActiveBusinessId([{ id: 5 }], undefined)).toBe(5);
    expect(resolveActiveBusinessId([{ id: 5 }], 9)).toBe(5);
  });
  it("🔑 عدة أنشطة → المخزّن لو متاح، وإلا لم يُختر", () => {
    const list = [{ id: 5 }, { id: 6 }];
    expect(resolveActiveBusinessId(list, 6)).toBe(6);
    expect(resolveActiveBusinessId(list, 7)).toBeUndefined(); // نشاط من نطاق تاني/مؤرشف
    expect(resolveActiveBusinessId(list, undefined)).toBeUndefined();
  });
  it("🔑 القايمة لسه ماوصلتش → المخزّن كما هو", () => {
    expect(resolveActiveBusinessId([], 3)).toBe(3);
  });
  it("🔑 مفتاح المسودة بيحمل النشاط الفعّال والقالب", () => {
    expect(activeDraftKey("manualEntryDraft:t1:b2:e3", 2, "catalog_variants")).toBe(`manualEntryDraft:t1:b2:e3${ACTIVE_BUSINESS_TAG}2:catalog_variants`);
    expect(activeDraftKey("k", undefined, "m")).toBe(`k${ACTIVE_BUSINESS_TAG}x:m`);
    expect(activeDraftKey("k", 2, "m")).not.toBe(activeDraftKey("k", 3, "m"));
  });
});

describe("🔒 تبديل النشاط بيمسح حالة النشاط السابق", () => {
  beforeEach(() => localStorage.clear());
  it("🔒 مسودات الأنشطة التانية والمسودة بلا علامة بتتمسح، ومسودة النشاط الفعّال بتفضل", () => {
    localStorage.setItem(`${DRAFT_PREFIX}t1:b2:e3${ACTIVE_BUSINESS_TAG}2:m`, "keep");
    localStorage.setItem(`${DRAFT_PREFIX}t1:b2:e3${ACTIVE_BUSINESS_TAG}3:m`, "other");
    localStorage.setItem(`${DRAFT_PREFIX}t1:b2:e3:m`, "untagged");
    localStorage.setItem("unrelated", "stay");
    purgeDraftsForOtherBusinesses(2);
    expect(localStorage.getItem(`${DRAFT_PREFIX}t1:b2:e3${ACTIVE_BUSINESS_TAG}2:m`)).toBe("keep");
    expect(localStorage.getItem(`${DRAFT_PREFIX}t1:b2:e3${ACTIVE_BUSINESS_TAG}3:m`)).toBeNull();
    expect(localStorage.getItem(`${DRAFT_PREFIX}t1:b2:e3:m`)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("stay");
  });
  it("🔒 «كل الأنشطة» (undefined) = امسح كل المسودات", () => {
    localStorage.setItem(`${DRAFT_PREFIX}a${ACTIVE_BUSINESS_TAG}2:m`, "x");
    purgeDraftsForOtherBusinesses(undefined);
    expect(localStorage.length).toBe(0);
  });
  it("🔒 resetForBusinessSwitch بيصفّر cache الاستعلامات كله (resetQueries) ويمسح المسودات", () => {
    localStorage.setItem(`${DRAFT_PREFIX}a${ACTIVE_BUSINESS_TAG}9:m`, "x");
    const qc = { resetQueries: vi.fn().mockResolvedValue(undefined) };
    resetForBusinessSwitch(qc, 4);
    expect(qc.resetQueries).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`${DRAFT_PREFIX}a${ACTIVE_BUSINESS_TAG}9:m`)).toBeNull();
  });
});
