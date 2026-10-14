import { describe, it, expect } from "vitest";
import { GOVERNORATES } from "./egyptGovernorates";
import { canonicalGovernorate, MIN_SHIPPING_ADDRESS_LENGTH, shippingIssuesText, shippingReadiness } from "./shippingReadiness";

/** اكتمال بيانات الشحن: عنوان 10 أحرف بعد trim + محافظة بمطابقة دقيقة أو بديل معتمد فقط (لا مطابقة جزئية). */
describe("📦 shippingReadiness", () => {
  it("كل المحافظات الـ27 بأسمائها الرسمية معروفة، وبصيغ الهمزة/التاء المربوطة/الياء وبادئة «محافظة»", () => {
    for (const g of GOVERNORATES) expect(canonicalGovernorate(g), g).toBe(g);
    expect(canonicalGovernorate("الاسكندريه")).toBe("الإسكندرية");
    expect(canonicalGovernorate("بنى سويف")).toBe("بني سويف");
    expect(canonicalGovernorate("  القاهره  ")).toBe("القاهرة");
    expect(canonicalGovernorate("محافظة الجيزة")).toBe("الجيزة");
    expect(canonicalGovernorate("Cairo")).toBe("القاهرة");
    expect(canonicalGovernorate("كفرالشيخ")).toBe("كفر الشيخ");
  });

  it("لا مطابقة جزئية ولا تخمين: «ال»، «القاهرة الجديدة»، «مدينة نصر»، «الساحل الشمالي»، أول كلمة — كلها غير معروفة", () => {
    for (const v of ["ال", "قا", "القاهرة الجديدة", "مدينة نصر", "الساحل الشمالي", "العاشر من رمضان", "بحيرة قارون", "القاهرة مدينة نصر", "غير محدد", ""])
      expect(canonicalGovernorate(v), v).toBeNull();
  });

  it(`حدود العنوان: ${MIN_SHIPPING_ADDRESS_LENGTH - 1} أحرف ناقص، ${MIN_SHIPPING_ADDRESS_LENGTH} مكتمل، والمسافات الطرفية لا تُحسب`, () => {
    const gov = "القاهرة";
    expect(shippingReadiness({ customerAddress: "123456789", governorate: gov }).issues.map(i => i.code)).toEqual(["address_short"]);
    expect(shippingReadiness({ customerAddress: "1234567890", governorate: gov }).ready).toBe(true);
    expect(shippingReadiness({ customerAddress: "   123456789   ", governorate: gov }).ready).toBe(false);
    expect(shippingReadiness({ customerAddress: "شارع النصر", governorate: gov }).ready).toBe(true); // 10 أحرف بالمسافة الداخلية
    expect(shippingReadiness({ customerAddress: "   ", governorate: gov }).issues.map(i => i.code)).toEqual(["address_missing"]);
  });

  it("أسباب النقص بالعربي معًا، والمحافظة الرسمية تُعاد عند الاكتمال", () => {
    const r = shippingReadiness({ customerAddress: "شارع", governorate: "غير محدد" });
    expect(r.ready).toBe(false);
    expect(r.issues.map(i => i.code)).toEqual(["address_short", "governorate_missing"]);
    expect(shippingIssuesText(r)).toBe("العنوان قصير — 10 أحرف على الأقل (الحالي 4) — المحافظة غير محددة");
    expect(shippingReadiness({ customerAddress: "شارع طويل رقم 10", governorate: "ال" }).issues[0].message).toContain("«ال» غير معروفة");
    expect(shippingReadiness({ customerAddress: "شارع طويل رقم 10", governorate: "الاسكندريه" })).toMatchObject({ ready: true, governorate: "الإسكندرية" });
  });
});
