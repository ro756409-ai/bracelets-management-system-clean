import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** BUG-01 (Release 1) — كل طلبات نموذج المخزون اللي فيها تكلفة تمر على costForSubmit، والخانات مقفولة بلا صلاحية. */
const s = readFileSync(resolve(__dirname, "Inventory.tsx"), "utf8");

describe("Inventory — التكلفة بصلاحية الإدارة فقط", () => {
  it("الصلاحية من usePermissions بنفس قاعدة السيرفر", () => {
    expect(s).toContain('import { canWriteCost, costForSubmit } from "@/lib/costWrite";');
    expect(s).toContain("const costWritable = canWriteCost(permState);");
  });
  it("الأربع طلبات (إضافة تركيبات، إنشاء تركيبة، تعديل تركيبة، منتج بتركيبات) — ولا تكلفة خام في أي طلب", () => {
    expect(s.match(/costPrice: costForSubmit\(costWritable, /g)?.length).toBe(4);
    expect(s.match(/^\s*costPrice: (?!costForSubmit)/gm)).toBeNull();
    const edit = s.slice(s.indexOf("editVariantMutation.mutate({"), s.indexOf("editVariantMutation.mutate({") + 400);
    expect(edit).toContain("costPrice: costForSubmit(costWritable, costPriceNum)");
  });
  it("خانة التكلفة في نموذج التركيبة والمصفوفتين مقفولة بلا صلاحية", () => {
    expect(s).toMatch(/value=\{vfCostPrice\}[\s\S]{0,200}disabled=\{!costWritable\}/);
    expect(s.match(/costEditable=\{costWritable\}/g)?.length).toBe(2);
  });
});
