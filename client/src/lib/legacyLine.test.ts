import { describe, it, expect } from "vitest";
import fs from "fs";
import { applyTypeToLine, setManualPrice, setLineQuantity, linesFromParse, lineTotal } from "./legacyLine";
import type { PickedItem, Catalog } from "@/components/orders/VariantOrderPicker";
import type { ParseResultV2 } from "@shared/orderParse";

const catalog: Catalog = {
  products: [{ id: 10, name: "منتج نقش", sku: null, price: "160" }],
  variants: [
    { id: 101, productId: 10, name: "سادة", sku: null, price: "160", isActive: true, currentStock: 5 },
    { id: 102, productId: 10, name: "منقوش", sku: null, price: "180", isActive: true, currentStock: 5 },
  ],
};
const base: PickedItem = { productId: 10, productName: "منتج نقش", variantId: 101, quantity: 2, unitPrice: 175, availableStock: 5, priceSource: "allocated", confidence: "confident" };

describe("🔒 السعر لا يعود للكتالوج", () => {
  it("🔒 تعديل يدوي ثم تغيير النوع → السعر اليدوي يبقى (مش 180 من الكتالوج) وpriceSource=manual", () => {
    const manual = setManualPrice(base, 190);
    expect(manual.priceSource).toBe("manual");
    const changed = applyTypeToLine(manual, catalog.variants[1], catalog.products[0]);
    expect(changed).toMatchObject({ variantId: 102, unitPrice: 190, priceSource: "manual", confidence: "confident" });
  });
  it("🔒 سعر موزَّع من الرسالة (allocated) يبقى عند تغيير النوع", () => {
    const changed = applyTypeToLine(base, catalog.variants[1], catalog.products[0]);
    expect(changed.unitPrice).toBe(175); expect(changed.priceSource).toBe("allocated");
  });
  it("🔒 تغيير الكمية لا يلمس السعر", () => {
    expect(setLineQuantity(setManualPrice(base, 190), 5)).toMatchObject({ quantity: 5, unitPrice: 190, priceSource: "manual" });
  });
  it("🔑 سطر بلا سعر أصلًا → سعر الكتالوج (catalog) عند اختيار النوع", () => {
    const empty: PickedItem = { ...base, unitPrice: 0, priceSource: undefined, variantId: undefined, needsPick: true };
    expect(applyTypeToLine(empty, catalog.variants[1], catalog.products[0])).toMatchObject({ unitPrice: 180, priceSource: "catalog", needsPick: false });
  });
  it("🔑 إجمالي السطر بالقرش", () => {
    expect(lineTotal({ unitPrice: 233.33, quantity: 2 })).toBe(466.66);
  });
});

describe("🔑 سطور ParseResultV2 → القالب المبسّط", () => {
  const v2 = {
    parserVersion: "2.0", parseSource: "deterministic", aiProvider: null, allocationPolicy: "p", unresolvedSegments: [],
    fields: {} as any,
    lines: [
      { segmentText: "سادة", quantity: 2, unitPrice: 175, lineTotal: 350, priceSource: "allocated", match: { productId: 10, productName: "منتج نقش", variantId: 101, variantName: "سادة" }, confidence: "confident", reason: null, aiAssisted: false },
      { segmentText: "نجمة", quantity: 1, unitPrice: 175, lineTotal: 175, priceSource: "allocated", match: null, confidence: "unresolved", reason: "غير موجود", aiAssisted: false },
      { segmentText: "عين حرس", quantity: 1, unitPrice: 175, lineTotal: 175, priceSource: "allocated", match: { productId: 999, productName: "نشاط آخر", variantId: 555, variantName: "x" }, confidence: "confident", reason: null, aiAssisted: false },
    ],
  } as unknown as ParseResultV2;
  it("🔑 المحلول بهويته وسعره، غير المحلول بنص الرسالة needsPick، ومطابقة مش في كتالوج الجلسة = غير محلولة", () => {
    const items = linesFromParse(v2, catalog);
    expect(items[0]).toMatchObject({ productId: 10, variantId: 101, unitPrice: 175, priceSource: "allocated", confidence: "confident", needsPick: false, segmentText: "سادة" });
    expect(items[1]).toMatchObject({ productId: 0, needsPick: true, segmentText: "نجمة", confidence: "unresolved", pickReason: "غير موجود" });
    expect(items[2]).toMatchObject({ productId: 0, needsPick: true, confidence: "unresolved" }); // عزل: مش من كتالوجنا → مايتقبلش
  });
});

describe("🔒 حراس المصدر — الواجهة", () => {
  const picker = fs.readFileSync("client/src/components/orders/LegacyEngravingPicker.tsx", "utf8");
  const page = fs.readFileSync("client/src/pages/FacebookEntry.tsx", "utf8");
  it("🔒 القالب المبسّط: أعمدة نوع الحفر/الكمية/سعر الوحدة/إجمالي السطر، بلا ألوان أو مقاسات، والسعر عبر setManualPrice", () => {
    for (const h of ["نوع الحفر", "الكمية", "سعر الوحدة", "إجمالي السطر"]) expect(picker).toContain(h);
    expect(picker).not.toMatch(/اللون|المقاس/);
    expect(picker).toContain("setManualPrice(it, Number(e.target.value))");
    expect(picker).toContain("applyTypeToLine(value[idx], v, p)");
    expect(picker).toContain('data-confidence={it.confidence ?? "confident"}');
    expect(picker).toContain("من الرسالة: «");
    // اقتراح AI مش حقيقة نهائية: أصفر + «اقتراح AI — راجع الاختيار» + القائمة تفضل مفتوحة (مفيش قفل)
    expect(picker).toContain("اقتراح AI — راجع الاختيار");
    expect(picker).toContain('it.confidence === "ambiguous" || it.aiAssisted');
    expect(picker).not.toMatch(/locked\(/);
  });
  it("🔒 الصفحة: القالب المبسّط يبني السطور من v2 ويبعت rawText + parseToken + parseResult؛ القالب الكامل على res.lines كما هو", () => {
    expect(page).toContain("if (isLegacy && res.v2) {");
    expect(page).toContain("linesFromParse(res.v2, catalog)");
    expect(page).toContain("setItems(built);"); // catalog_variants بلا تغيير
    expect(page).toContain("{ rawText: analyzedText, parseToken, parseResult: parseV2, discount: Number(cust.discount) || 0 }");
    expect(page).toContain("pasteSaveBlockers(");
    expect(page).toContain('data-testid="sum-items-expected"');
  });
});
