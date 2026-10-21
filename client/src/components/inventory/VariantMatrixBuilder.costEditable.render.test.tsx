// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { VariantMatrixBuilder, rebuildRows, type VariantMatrixValue } from "./VariantMatrixBuilder";

/** BUG-01 (Release 1) — خانة التكلفة في مصفوفة التركيبات مقفولة بلا صلاحية إدارة التكلفة، ومفتوحة افتراضيًا. */
afterEach(() => cleanup());
const value = (): VariantMatrixValue => {
  const rows = rebuildRows(["أسود"], ["S"], {}, "");
  for (const k of Object.keys(rows)) rows[k] = { ...rows[k], price: "250", costPrice: "90", currentStock: "7", minStockLevel: "3" };
  return { colors: ["أسود"], sizes: ["S"], rows };
};
const inputByValue = (c: HTMLElement, v: string) => Array.from(c.querySelectorAll<HTMLInputElement>('input[type="number"]')).find(i => i.value === v)!;

describe("VariantMatrixBuilder — costEditable", () => {
  it("الافتراضي (المالك/المحاسب): التكلفة مفتوحة للتعديل", () => {
    const { container } = render(<VariantMatrixBuilder value={value()} onChange={() => {}} skuBase="" />);
    expect(inputByValue(container, "90").disabled).toBe(false);
  });
  it("بلا صلاحية: التكلفة وحدها مقفولة، والسعر والمخزون والحد الأدنى مفتوحين", () => {
    const { container } = render(<VariantMatrixBuilder value={value()} onChange={() => {}} skuBase="" costEditable={false} />);
    expect(inputByValue(container, "90").disabled).toBe(true);
    for (const v of ["250", "7", "3"]) expect(inputByValue(container, v).disabled, v).toBe(false);
  });
});
