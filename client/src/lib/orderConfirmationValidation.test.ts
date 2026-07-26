import { describe, expect, it } from "vitest";
import { getMissingConfirmationFields, canConfirmOrder } from "./orderConfirmationValidation";

const COMPLETE = {
  customerName: "منى سيد",
  customerPhone: "01012345678",
  governorate: "القاهرة",
  customerAddress: "شارع الجيش",
  productName: "أسورة نحاس - آية الكرسي",
  totalAmount: "270",
};

describe("getMissingConfirmationFields", () => {
  it("returns nothing when every field is present", () => {
    expect(getMissingConfirmationFields(COMPLETE)).toEqual([]);
  });

  it("flags a missing phone", () => {
    expect(getMissingConfirmationFields({ ...COMPLETE, customerPhone: "" })).toEqual(["رقم الهاتف"]);
  });

  it("flags blank/whitespace-only fields, not just missing ones", () => {
    expect(getMissingConfirmationFields({ ...COMPLETE, customerAddress: "   " })).toEqual(["العنوان"]);
  });

  it("flags a zero or negative total — an order can't confirm with no price", () => {
    expect(getMissingConfirmationFields({ ...COMPLETE, totalAmount: 0 })).toEqual(["الإجمالي"]);
    expect(getMissingConfirmationFields({ ...COMPLETE, totalAmount: "-5" })).toEqual(["الإجمالي"]);
  });

  it("accepts a numeric-string total above zero", () => {
    expect(getMissingConfirmationFields({ ...COMPLETE, totalAmount: "0.01" })).toEqual([]);
  });

  it("lists every missing field, in field order", () => {
    const bare = { customerName: "", customerPhone: "", governorate: "", customerAddress: "", productName: "", totalAmount: null };
    expect(getMissingConfirmationFields(bare)).toEqual([
      "اسم العميل", "رقم الهاتف", "المحافظة", "العنوان", "المنتج", "الإجمالي",
    ]);
  });
});

describe("canConfirmOrder", () => {
  it("is true only when nothing is missing", () => {
    expect(canConfirmOrder(COMPLETE)).toBe(true);
    expect(canConfirmOrder({ ...COMPLETE, governorate: "" })).toBe(false);
  });
});
