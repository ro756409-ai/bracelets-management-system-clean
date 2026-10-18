/**
 * حارس نصّي: تعديل أوردر فيسبوك بيبعت نوع الحفر (variantId) + اللون/المقاس لكل بند — زي الإضافة بالظبط.
 * قبل الإصلاح كان بيبعت تركيبة البند الأول بس على مستوى الأوردر، فنقشة البند التاني كانت بتضيع/تتبدّل.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const page = strip(readFileSync(path.join(root, "pages/FacebookEntry.tsx"), "utf8"));

describe("FacebookEntry — تعديل الأوردر بيحفظ نقشة كل بند", () => {
  it("submitEdit → selectedProducts فيها variantId/color/size/unitPrice لكل بند", () => {
    const fn = page.slice(page.indexOf("function submitEdit"), page.indexOf("function handleLogout"));
    const sel = fn.slice(fn.indexOf("selectedProducts:"), fn.indexOf("totalAmount:"));
    expect(sel).toContain("editItems.map(");
    expect(sel).toMatch(/variantId:\s*it\.variantId/);
    expect(sel).toMatch(/color:\s*it\.color/);
    expect(sel).toMatch(/size:\s*it\.size/);
    expect(sel).toMatch(/unitPrice:\s*it\.unitPrice/);
  });
});
