import { describe, it, expect } from "vitest";
import { parsePasteMessage, splitProductTerms } from "./pasteParser";

/**
 * المرحلة B — قراءة الأرقام حتمية ومحدودة بالـlabel.
 * الحادثة: «الشحن: 50» و«الإجمالي: 450» في سطر واحد كانوا بيتلزقوا 50450، لأن القراءة
 * كانت بتاخد باقي السطر وتشيل كل حرف مش رقم. كل قيمة دلوقتي بتقف عند نهاية السطر أو
 * أول label تاني — أيهما أقرب.
 */

const REAL = `اسم العميل: Samar Hasan
رقم التليفون: 01098260811
العنوان: المنصورة الصفيح امام صيدلية ياسين
نوع المنتج: عين حورس وذكر التحصين
عدد القطع: 2
السعر: 400
الشحن: 50
الإجمالي: 450`;

describe("🔑 النص الحقيقي من Production", () => {
  const p = parsePasteMessage(REAL);
  it("🔑 الكمية 2", () => expect(p.quantity).toBe(2));
  it("🔑 إجمالي الأصناف 400", () => expect(p.itemsSubtotal).toBe(400));
  it("🔑 الشحن 50 — مش 50450", () => {
    expect(p.shipping).toBe(50);
    expect(p.shipping).not.toBe(50450);
  });
  it("🔑 الإجمالي 450", () => expect(p.totalAmount).toBe(450));
  it("🔑 المعادلة متسقة → مفيش تحذير", () => expect(p.totalMismatch).toBe(false));
  it("🔑 النوعان المذكوران", () =>
    expect(p.productTerms).toEqual(["عين حورس", "ذكر التحصين"]));
  it("🔑 الهاتف والاسم", () => {
    expect(p.customerPhone).toBe("01098260811");
    expect(p.customerName).toBe("Samar Hasan");
  });
  it("🔑 المحافظة من المدينة: المنصورة → الدقهلية (مش أول كلمة)", () => {
    expect(p.governorate).toBe("الدقهلية");
    expect(p.city).toBe("المنصورة");
  });
  it("🔑 العنوان الكامل منفصل عن المحافظة والمدينة", () => {
    expect(p.customerAddress).toBe("المنصورة الصفيح امام صيدلية ياسين");
  });
});

describe("🔒 المحافظة: يقين أو فراغ", () => {
  const govOf = (addr: string) => parsePasteMessage(`العنوان: ${addr}`).governorate;
  it("🔑 6 أكتوبر → الجيزة", () => expect(govOf("6 أكتوبر الحي المتميز")).toBe("الجيزة"));
  it("🔑 إدفو → أسوان", () => expect(govOf("إدفو شارع المحطة")).toBe("أسوان"));
  it("🔑 كفر الشيخ → كفر الشيخ", () => expect(govOf("كفر الشيخ شارع الجيش")).toBe("كفر الشيخ"));
  it("🔑 مدينة نصر → القاهرة", () => expect(govOf("مدينة نصر عمارة 7")).toBe("القاهرة"));
  it("🔒 عنوان غير معروف → فاضي (الموظف يختار)", () =>
    expect(govOf("شارع 15 عمارة 7 الدور التالت")).toBe(""));
  it("🔒 ممنوع أول كلمة: «الصفيح» مش محافظة", () =>
    expect(govOf("الصفيح امام صيدلية ياسين")).toBe(""));
});

describe("🔒 الحقول في سطر واحد — الحالة اللي كشفت 50450", () => {
  it("🔒 «الشحن: 50 الإجمالي: 450» في نفس السطر", () => {
    const p = parsePasteMessage("نوع المنتج: أسورة\nالشحن: 50 الإجمالي: 450");
    expect(p.shipping).toBe(50);
    expect(p.totalAmount).toBe(450);
  });
  it("🔒 ثلاثة حقول في سطر واحد", () => {
    const p = parsePasteMessage("السعر: 400 الشحن: 50 الإجمالي: 450");
    expect(p.itemsSubtotal).toBe(400);
    expect(p.shipping).toBe(50);
    expect(p.totalAmount).toBe(450);
  });
  it("🔒 الكمية في سطر مشترك ماتبلعش الأرقام اللي بعدها", () => {
    const p = parsePasteMessage("عدد القطع: 2 السعر: 400");
    expect(p.quantity).toBe(2);
    expect(p.itemsSubtotal).toBe(400);
  });
});

describe("🔑 اختلافات الصياغة", () => {
  it("🔑 أرقام عربية", () => {
    const p = parsePasteMessage("عدد القطع: ٣\nالسعر: ٦٠٠\nالشحن: ٥٠\nالإجمالي: ٦٥٠");
    expect(p.quantity).toBe(3);
    expect(p.itemsSubtotal).toBe(600);
    expect(p.shipping).toBe(50);
    expect(p.totalAmount).toBe(650);
  });
  it("🔑 فاصل = و -", () => {
    const p = parsePasteMessage("السعر = 400\nالشحن = 50\nالإجمالي = 450");
    expect(p.itemsSubtotal).toBe(400);
    expect(p.shipping).toBe(50);
  });
  it("🔑 ترتيب مختلف للسطور", () => {
    const p = parsePasteMessage("الإجمالي: 450\nالشحن: 50\nالسعر: 400\nعدد القطع: 2");
    expect(p.itemsSubtotal).toBe(400);
    expect(p.shipping).toBe(50);
    expect(p.totalAmount).toBe(450);
    expect(p.quantity).toBe(2);
  });
  it("🔑 بلا مسافات حول الفاصل", () => {
    const p = parsePasteMessage("السعر:400\nالشحن:50");
    expect(p.itemsSubtotal).toBe(400);
    expect(p.shipping).toBe(50);
  });
  it("🔑 الشحن مجانًا → صفر", () => {
    expect(parsePasteMessage("الشحن: مجانا\nالإجمالي: 400").shipping).toBe(0);
  });
});

describe("🔑 label غائب", () => {
  it("🔑 بلا شحن → صفر بلا تخمين", () => {
    const p = parsePasteMessage("السعر: 400\nالإجمالي: 400");
    expect(p.shipping).toBe(0);
    expect(p.totalMismatch).toBe(false);
  });
  it("🔑 بلا سعر أصناف → يُشتق من الإجمالي ناقص الشحن", () => {
    const p = parsePasteMessage("الشحن: 50\nالإجمالي: 450");
    expect(p.itemsSubtotal).toBe(400);
    expect(p.totalAmount).toBe(450);
  });
  it("🔑 بلا إجمالي مكتوب → يُحسب", () => {
    const p = parsePasteMessage("السعر: 400\nالشحن: 50");
    expect(p.totalAmount).toBe(450);
  });
  it("🔑 بلا أي أرقام → أصفار بلا انهيار", () => {
    const p = parsePasteMessage("الاسم: أحمد");
    expect(p.quantity).toBe(1);
    expect(p.itemsSubtotal).toBe(0);
    expect(p.totalAmount).toBe(0);
  });
});

describe("🔒 الإجمالي غير المتطابق يُعلَّم ولا يُصحَّح", () => {
  it("🔒 400 + 50 ≠ 500 → تحذير، والقيم زي ما هي", () => {
    const p = parsePasteMessage("السعر: 400\nالشحن: 50\nالإجمالي: 500");
    expect(p.totalMismatch).toBe(true);
    expect(p.itemsSubtotal).toBe(400);
    expect(p.shipping).toBe(50);
    expect(p.totalAmount).toBe(500);
  });
  it("🔑 الخصم داخل المعادلة", () => {
    const p = parsePasteMessage("السعر: 400\nالشحن: 50\nالخصم: 20\nالإجمالي: 430");
    expect(p.discount).toBe(20);
    expect(p.totalMismatch).toBe(false);
  });
});

describe("🔑 فصل الأنواع المذكورة", () => {
  it("🔑 «و» المستقلة", () =>
    expect(splitProductTerms("عين حورس وذكر التحصين")).toEqual(["عين حورس", "ذكر التحصين"]));
  it("🔑 «+» والفاصلة", () => {
    expect(splitProductTerms("آية الكرسي + سادة")).toEqual(["آية الكرسي", "سادة"]);
    expect(splitProductTerms("آية الكرسي، سادة")).toEqual(["آية الكرسي", "سادة"]);
  });
  it("🔒 «و» جوه كلمة ماتفصلش («حورس»)", () =>
    expect(splitProductTerms("عين حورس")).toEqual(["عين حورس"]));
  it("🔑 نوع واحد → عنصر واحد", () =>
    expect(splitProductTerms("أسورة نحاس")).toEqual(["أسورة نحاس"]));
  it("🔑 ثلاثة أنواع", () =>
    expect(splitProductTerms("عين حورس وذكر التحصين وسادة")).toEqual([
      "عين حورس", "ذكر التحصين", "سادة",
    ]));
});
