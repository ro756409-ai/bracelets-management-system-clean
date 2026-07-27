import { describe, expect, it } from "vitest";
import { toWhatsAppNumber, buildWhatsAppUrl } from "./whatsapp";

describe("toWhatsAppNumber", () => {
  it("converts a plain Egyptian mobile number to international format", () => {
    expect(toWhatsAppNumber("01012345678")).toBe("201012345678");
  });

  it("accepts +20 and 0020 prefixed numbers", () => {
    expect(toWhatsAppNumber("+201012345678")).toBe("201012345678");
    expect(toWhatsAppNumber("00201012345678")).toBe("201012345678");
  });

  it("strips spaces, dashes and parentheses", () => {
    expect(toWhatsAppNumber("010 1234 5678")).toBe("201012345678");
    expect(toWhatsAppNumber("010-1234-5678")).toBe("201012345678");
    expect(toWhatsAppNumber("(010) 1234-5678")).toBe("201012345678");
  });

  it("converts Arabic-Indic digits", () => {
    expect(toWhatsAppNumber("٠١٠١٢٣٤٥٦٧٨")).toBe("201012345678");
  });

  it("takes the first valid number when several are present", () => {
    expect(toWhatsAppNumber("01012345678 / 01123456789")).toBe("201012345678");
  });

  it("rejects empty, null and undefined", () => {
    expect(toWhatsAppNumber("")).toBeNull();
    expect(toWhatsAppNumber(null)).toBeNull();
    expect(toWhatsAppNumber(undefined)).toBeNull();
  });

  it("rejects numbers too short to be an Egyptian mobile", () => {
    expect(toWhatsAppNumber("0101234")).toBeNull();
  });

  it("rejects a landline / non-mobile-shaped number", () => {
    expect(toWhatsAppNumber("0223456789")).toBeNull(); // starts 02, not 01
  });

  it("rejects garbage text with no recoverable number", () => {
    expect(toWhatsAppNumber("لا يوجد رقم")).toBeNull();
  });
});

describe("buildWhatsAppUrl", () => {
  it("builds a plain wa.me link with no message", () => {
    expect(buildWhatsAppUrl("01012345678")).toBe("https://wa.me/201012345678");
  });

  it("appends an encoded text parameter when a message is given", () => {
    const url = buildWhatsAppUrl("01012345678", "مرحباً، بخصوص أوردرك");
    expect(url).toBe(
      `https://wa.me/201012345678?text=${encodeURIComponent("مرحباً، بخصوص أوردرك")}`
    );
  });

  it("ignores a blank/whitespace-only message", () => {
    expect(buildWhatsAppUrl("01012345678", "   ")).toBe("https://wa.me/201012345678");
  });

  it("returns null for an invalid phone regardless of message", () => {
    expect(buildWhatsAppUrl("", "hello")).toBeNull();
    expect(buildWhatsAppUrl("123", "hello")).toBeNull();
  });
});
