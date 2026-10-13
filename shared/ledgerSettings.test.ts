import { describe, it, expect } from "vitest";
import { expectedCarrierFees, nextPayoutDate, sameToPiaster, settingDef, validateSettingValue, weekdaysText } from "./ledgerSettings";

/** الإعدادات المُدخلة: لا قيمة مخمّنة — الغائب = لا توقع؛ الرسوم المتوقعة والضريبة؛ أيام الصرف؛ والتحقق. */
describe("⚙️ إعدادات الدفتر المُدخلة", () => {
  it("الرسوم المتوقعة: ثابت التسليم + نسبة التحصيل ثم الضريبة؛ المرتجع برسومه ولا نسبة تحصيل؛ بلا إعداد = null", () => {
    expect(expectedCarrierFees({}, "750", false)).toBeNull();
    expect(expectedCarrierFees({ "carrier.bosta.vat_percent": "14" }, "750", false)).toBeNull(); // الضريبة وحدها لا تكفي
    expect(expectedCarrierFees({ "carrier.bosta.fee_per_shipment": "40" }, "750", false)).toBe("40.0000");
    expect(expectedCarrierFees({ "carrier.bosta.fee_per_shipment": "40", "carrier.bosta.cod_fee_percent": "1" }, "750", false)).toBe("47.5000");
    expect(expectedCarrierFees({ "carrier.bosta.fee_per_shipment": "40", "carrier.bosta.cod_fee_percent": "1", "carrier.bosta.vat_percent": "14" }, "750", false)).toBe("54.1500");
    expect(expectedCarrierFees({ "carrier.bosta.fee_per_shipment": "40", "carrier.bosta.cod_fee_percent": "1" }, "0", true)).toBeNull(); // رسوم المرتجع غير مُدخلة
    expect(expectedCarrierFees({ "carrier.bosta.return_fee": "30", "carrier.bosta.cod_fee_percent": "1", "carrier.bosta.vat_percent": "14" }, "0", true)).toBe("34.2000");
  });

  it("المقارنة بالقرش: فرق أقل من نصف قرش ليس فرقًا", () => {
    expect(sameToPiaster("54.1500", "54.15")).toBe(true);
    expect(sameToPiaster("54.1549", "54.15")).toBe(true);
    expect(sameToPiaster("54.1600", "54.15")).toBe(false);
  });

  it("يوم الصرف: أول يوم مُدخل في/بعد تاريخ الكشف (الإثنين/الأربعاء)؛ بلا إعداد = null", () => {
    const monWed = (1 << 1) | (1 << 3);
    expect(nextPayoutDate("2026-10-12", monWed)).toBe("2026-10-12"); // الإثنين نفسه
    expect(nextPayoutDate("2026-10-13", monWed)).toBe("2026-10-14"); // الثلاثاء → الأربعاء
    expect(nextPayoutDate("2026-10-15", monWed)).toBe("2026-10-19"); // الخميس → الإثنين التالي
    expect(nextPayoutDate("2026-12-31", 1 << 5)).toBe("2027-01-01"); // عبر السنة
    expect(nextPayoutDate("2026-10-15", null)).toBeNull();
    expect(nextPayoutDate("2026-10-15", 0)).toBeNull();
    expect(weekdaysText(monWed)).toBe("الإثنين، الأربعاء");
    expect(weekdaysText(null)).toBe("غير مُدخل");
  });

  it("التحقق: أيام 1..127، عشري موجب حتى 4 خانات، نسبة ≤ 100؛ المفتاح المجهول undefined", () => {
    const days = settingDef("carrier.bosta.payout_weekdays")!, fee = settingDef("carrier.bosta.fee_per_shipment")!, pct = settingDef("carrier.bosta.vat_percent")!;
    expect(validateSettingValue(days, 10)).toEqual({ valueDecimal: null, valueInt: 10 });
    expect("error" in validateSettingValue(days, 0)).toBe(true);
    expect("error" in validateSettingValue(days, 128)).toBe(true);
    expect(validateSettingValue(fee, "40.5")).toEqual({ valueDecimal: "40.5000", valueInt: null });
    expect("error" in validateSettingValue(fee, "-1")).toBe(true);
    expect("error" in validateSettingValue(fee, "1.12345")).toBe(true);
    expect("error" in validateSettingValue(pct, "100.01")).toBe(true);
    expect(validateSettingValue(pct, "100")).toEqual({ valueDecimal: "100.0000", valueInt: null });
    expect(settingDef("nope")).toBeUndefined();
    expect(settingDef("packaging.cost_per_order")?.scope).toBe("business");
  });
});
