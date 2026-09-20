// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  draftKey,
  scopeFingerprint,
  purgeForeignDrafts,
  readEmployeeScope,
  resetEmployeeClientState,
  sanitizeDraftItems,
  DRAFT_PREFIX,
  type EmployeeScope,
} from "./employeeScope";

/**
 * المرحلة A — حالة العميل مربوطة بالحساب.
 * الحادثة: مفتاح مسودة عام + cache بلا هوية + خروج مابيمسحش → موظف نشاط B يلاقي
 * كتالوج ومسودة نشاط A على نفس الجهاز.
 */

const A: EmployeeScope = { employeeId: 7, businessId: 1, tenantId: 1 };
const B: EmployeeScope = { employeeId: 9, businessId: 3, tenantId: 2 };

beforeEach(() => localStorage.clear());

describe("🔒 مفتاح المسودة مربوط بالحساب", () => {
  it("🔒 حسابان مختلفان → مفتاحان مختلفان", () => {
    expect(draftKey(A)).not.toBe(draftKey(B));
  });
  it("🔒 نفس الموظف في نشاط مختلف → مفتاح مختلف", () => {
    expect(draftKey(A)).not.toBe(draftKey({ ...A, businessId: 3 }));
  });
  it("🔒 نفس النشاط وموظف مختلف → مفتاح مختلف", () => {
    expect(draftKey(A)).not.toBe(draftKey({ ...A, employeeId: 8 }));
  });
  it("🔒 بلا جلسة → بصمة anon مش مفتاح حساب حقيقي", () => {
    expect(scopeFingerprint(null)).toBe("anon");
  });
});

describe("🔒 مسح مسودات الحسابات التانية", () => {
  it("🔒 مسودة نشاط تاني بتتمسح، وبتاعة الحساب الحالي بتفضل", () => {
    localStorage.setItem(draftKey(A), '{"items":[]}');
    localStorage.setItem(draftKey(B), '{"items":[]}');
    purgeForeignDrafts(A);
    expect(localStorage.getItem(draftKey(A))).not.toBeNull();
    expect(localStorage.getItem(draftKey(B))).toBeNull();
  });
  it("🔒 المفتاح العام القديم بيتشال دايمًا (مالوش صاحب معروف)", () => {
    localStorage.setItem("manualEntryDraft", '{"items":[{"productId":99}]}');
    purgeForeignDrafts(A);
    expect(localStorage.getItem("manualEntryDraft")).toBeNull();
  });
  it("🔒 خروج (keep=null) بيمسح كل المسودات", () => {
    localStorage.setItem(draftKey(A), "{}");
    localStorage.setItem(draftKey(B), "{}");
    purgeForeignDrafts(null);
    expect(Object.keys(localStorage).filter(k => k.startsWith(DRAFT_PREFIX))).toEqual([]);
  });
  it("🔒 تغيّر الهوية بيمسح cache الاستعلامات كله", () => {
    const clear = vi.fn();
    localStorage.setItem(draftKey(B), "{}");
    resetEmployeeClientState({ clear } as any, A);
    expect(clear).toHaveBeenCalledOnce();
    expect(localStorage.getItem(draftKey(B))).toBeNull();
  });
});

describe("🔒 قراءة الجلسة", () => {
  it("🔒 جلسة تالفة → null بلا رمي", () => {
    localStorage.setItem("employee_session", "{ليست JSON");
    expect(readEmployeeScope()).toBeNull();
  });
  it("🔑 جلسة صحيحة بتقرا الهوية الكاملة", () => {
    localStorage.setItem(
      "employee_session",
      JSON.stringify({ id: 9, businessId: 3, tenantId: 2, name: "x" })
    );
    expect(readEmployeeScope()).toEqual(B);
  });
});

describe("🔒 المسودة المسترجعة متعقَّمة ضد الكتالوج الحالي", () => {
  const catalog = {
    products: [{ id: 10 }, { id: 20 }],
    variants: [
      { id: 101, productId: 10 },
      { id: 201, productId: 20 },
    ],
  };
  const row = (o: any) => ({ quantity: 2, unitPrice: 150, ...o });

  it("🔒 بند بمنتج مش في الكتالوج بيتشال", () => {
    const r = sanitizeDraftItems([row({ productId: 99, variantId: null })], catalog);
    expect(r.items).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it("🔒 تركيبة تابعة لمنتج تاني → تتمسح والسطر يفضل للمراجعة", () => {
    const r = sanitizeDraftItems(
      [row({ productId: 10, variantId: 201, color: "أسود", size: "6", optionLabel: "أسود / 6", sku: "X-1" })],
      catalog
    );
    expect(r.dropped).toBe(0);
    expect(r.needsReview).toBe(1);
    expect(r.items).toHaveLength(1);
    const it0 = r.items[0] as any;
    // المنتج والكمية والسعر محفوظين — اللي اتمسح هو التركيبة وخصائصها بس
    expect(it0.productId).toBe(10);
    expect(it0.quantity).toBe(2);
    expect(it0.unitPrice).toBe(150);
    expect(it0.variantId).toBeUndefined();
    expect(it0.color).toBeNull();
    expect(it0.size).toBeNull();
    expect(it0.sku).toBeNull();
    expect(it0.optionLabel).toBeNull();
    expect(it0.needsVariantReview).toBe(true);
  });

  it("🔒 تركيبة مش موجودة خالص → نفس المعاملة (مراجعة مش حذف)", () => {
    const r = sanitizeDraftItems([row({ productId: 10, variantId: 999 })], catalog);
    expect(r.needsReview).toBe(1);
    expect((r.items[0] as any).productId).toBe(10);
    expect((r.items[0] as any).variantId).toBeUndefined();
  });

  it("🔑 بند سليم بيفضل زي ما هو", () => {
    const ok = [row({ productId: 10, variantId: 101 })];
    const r = sanitizeDraftItems(ok, catalog);
    expect(r.items).toEqual(ok);
    expect(r.needsReview).toBe(0);
  });

  it("🔑 منتج بسيط بلا تركيبة بيفضل", () => {
    const ok = [row({ productId: 20, variantId: null })];
    expect(sanitizeDraftItems(ok, catalog).items).toEqual(ok);
  });

  it("🔒 كتالوج فاضي (fail-closed) → مفيش بنود بتترجّع", () => {
    const r = sanitizeDraftItems([row({ productId: 10, variantId: 101 })], { products: [], variants: [] });
    expect(r.items).toEqual([]);
    expect(r.dropped).toBe(1);
  });
});
