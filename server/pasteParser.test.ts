import { describe, it, expect } from "vitest";
import { parsePasteMessage, splitColorSize } from "./pasteParser";

/**
 * محلّل رسالة العميل الملصوقة — القالب المطلوب، مع اختلاف الألف/الهمزات والأرقام العربية،
 * والشحن المجاني، وفصل اللون/المقاس، واستخراج المحافظة والعنوان التفصيلي.
 */

const SAMPLE = `بيدج: afandy kids
التاريخ: 19 سبتمبر
الاسم: سليم الجزار
العنوان: محافظة السويس
الموشي تعاونيات البحر الاحمر عند مسجد الحرمين
رقم الفون(1): 01229190603
نوع المنتج: طقم اطفال
عدد القطع: ١
اللون: اسود مقاس 8 سنين
الشحن: مجانا
الاجمالي: 500`;

describe("🔑 parsePasteMessage — القالب المطلوب", () => {
  const p = parsePasteMessage(SAMPLE);
  it("🔑 بيدج → مصدر الإعلان", () => expect(p.adName).toBe("afandy kids"));
  it("🔑 الاسم → اسم العميل", () => expect(p.customerName).toBe("سليم الجزار"));
  it("🔑 الهاتف مع الصفر الأول", () => expect(p.customerPhone).toBe("01229190603"));
  it("🔑 المحافظة من «محافظة السويس» → السويس", () => expect(p.governorate).toBe("السويس"));
  it("🔑 العنوان التفصيلي بيجمع السطور (فيه «الموشي...»)", () => {
    expect(p.customerAddress).toContain("الموشي تعاونيات البحر الاحمر عند مسجد الحرمين");
  });
  it("🔑 نوع المنتج", () => expect(p.productName).toBe("طقم اطفال"));
  it("🔑 عدد القطع ١ → 1", () => expect(p.quantity).toBe(1));
  it("🔑 اللون «اسود» والمقاس «8» من «اسود مقاس 8 سنين»", () => {
    expect(p.color).toBe("اسود");
    expect(p.size).toBe("8");
  });
  it("🔑 الشحن «مجانا» → 0", () => expect(p.shipping).toBe(0));
  it("🔑 الاجمالي → 500", () => expect(p.totalAmount).toBe(500));
});

describe("🔑 اختلافات الأرقام والمسافات والهمزات", () => {
  it("🔑 أرقام عربية في الهاتف والكمية والإجمالي", () => {
    const p = parsePasteMessage(
      "الاسم: أحمد\nرقم الفون: ٠١٠١٢٣٤٥٦٧٨\nعدد القطع: ٢\nاللون: بيج مقاس ١٠ سنين\nالاجمالي: ٣٥٠"
    );
    expect(p.customerPhone).toBe("01012345678");
    expect(p.quantity).toBe(2);
    expect(p.size).toBe("10");
    expect(p.totalAmount).toBe(350);
  });
  it("🔑 «رقم الفون» بدون (1)", () => {
    expect(parsePasteMessage("رقم الفون : 01111111111").customerPhone).toBe("01111111111");
  });
  it("🔑 مقاس كنطاق «من 6 إلى 8 سنين» → 8 (الحد الأعلى)", () => {
    expect(parsePasteMessage("اللون: أسود من 6 إلى 8 سنين").size).toBe("8");
  });
});

describe("🔑 splitColorSize", () => {
  it("🔑 «اسود مقاس 8 سنين»", () => expect(splitColorSize("اسود مقاس 8 سنين")).toEqual({ color: "اسود", size: "8" }));
  it("🔑 «بيج 10»", () => expect(splitColorSize("بيج 10")).toEqual({ color: "بيج", size: "10" }));
  it("🔑 لون بلا مقاس", () => expect(splitColorSize("أحمر")).toEqual({ color: "أحمر", size: "" }));
  it("🔑 «بيج (12 سنة)» → بيج / 12 (مقاس داخل أقواس)", () =>
    expect(splitColorSize("بيج (12 سنة)")).toEqual({ color: "بيج", size: "12" }));
  it("🔑 «بيج (١٢ سنه)» أرقام عربية", () =>
    expect(splitColorSize("بيج (١٢ سنه)")).toEqual({ color: "بيج", size: "12" }));
});

describe("🔑 قالب «بيج (12 سنة)» — الاستخراج الكامل", () => {
  const p = parsePasteMessage(
    "بيدج: afandy kids\nالاسم: شيماء فهمي\nالعنوان: محافظة السويس\nمنطقة الصباح\nرقم التواصل: 01286711488\nنوع المنتج: طقم أطفال\nعدد القطع: 1\nاللون: بيج (12 سنة)\nالشحن: مجانا\nالاجمالي: 500"
  );
  it("🔑 المنتج «طقم أطفال»", () => expect(p.productName).toBe("طقم أطفال"));
  it("🔑 اللون «بيج»", () => expect(p.color).toBe("بيج"));
  it("🔑 المقاس «12»", () => expect(p.size).toBe("12"));
  it("🔑 الهاتف «رقم التواصل» مع الصفر", () => expect(p.customerPhone).toBe("01286711488"));
  it("🔑 المحافظة السويس", () => expect(p.governorate).toBe("السويس"));
});

describe("🔑 المقاس في سطر مستقل", () => {
  it("🔑 «اللون: بيج» + «المقاس: 12 سنين» (سطرين)", () => {
    const p = parsePasteMessage("نوع المنتج: طقم\nاللون: بيج\nالمقاس: 12 سنين\nالاجمالي: 100");
    expect(p.color).toBe("بيج");
    expect(p.size).toBe("12");
  });
});
