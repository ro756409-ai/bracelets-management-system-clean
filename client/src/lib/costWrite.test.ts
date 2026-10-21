import { describe, it, expect } from "vitest";
import { canWriteCost, costForSubmit } from "./costWrite";

/** BUG-01 (Release 1) — نموذج المخزون لا يرسل تكلفة بلا inventory_costing.manage، ولا يغيّر شيئًا لمن يملكها. */
const perms = (isSuccess: boolean, list: string[]) => ({ isSuccess, has: (p: string) => list.includes(p) });

describe("canWriteCost / costForSubmit", () => {
  it("بالصلاحية (المالك/المحاسب/المدير بالافتراضي): التكلفة تتبعت كما هي", () => {
    const can = canWriteCost(perms(true, ["inventory_costing.view", "inventory_costing.manage"]));
    expect(can).toBe(true);
    expect(costForSubmit(can, 95)).toBe(95);
    expect(costForSubmit(can, undefined)).toBeUndefined();
  });
  it("المدير المسحوب منه الإدارة (حتى لو بيشوف التكلفة): لا تكلفة في الطلب", () => {
    const can = canWriteCost(perms(true, ["inventory_costing.view"]));
    expect(can).toBe(false);
    expect(costForSubmit(can, 95)).toBeUndefined();
    expect(JSON.stringify({ id: 1, price: 250, costPrice: costForSubmit(can, 95) })).toBe('{"id":1,"price":250}');
  });
  it("قبل تحميل الصلاحيات بنجاح (تحميل/خطأ): نفس السلوك القديم — السيرفر يحكم", () => {
    expect(canWriteCost(perms(false, []))).toBe(true);
  });
});
