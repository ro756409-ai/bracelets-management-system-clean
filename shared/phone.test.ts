import { describe, it, expect } from "vitest";
import { normalizeEgyptianPhone, toAsciiDigits, egyptianPhonesMatch } from "./phone";

describe("toAsciiDigits", () => {
  it("converts Arabic-Indic digits to ASCII", () => {
    expect(toAsciiDigits("٠١٠١٢٣٤٥٦٧٨")).toBe("01012345678");
  });

  it("converts Eastern Arabic (Persian) digits to ASCII", () => {
    expect(toAsciiDigits("۰۱۰۱۲۳۴۵۶۷۸")).toBe("01012345678");
  });

  it("leaves ASCII digits and other characters unchanged", () => {
    expect(toAsciiDigits("01-012 345678")).toBe("01-012 345678");
  });
});

describe("normalizeEgyptianPhone", () => {
  it("returns an already-canonical number unchanged", () => {
    expect(normalizeEgyptianPhone("01012345678")).toBe("01012345678");
  });

  it("handles the +20 country code format", () => {
    expect(normalizeEgyptianPhone("+201012345678")).toBe("01012345678");
  });

  it("handles the 0020 country code format", () => {
    expect(normalizeEgyptianPhone("00201012345678")).toBe("01012345678");
  });

  it("handles a bare 20-prefixed 12-digit number", () => {
    expect(normalizeEgyptianPhone("201012345678")).toBe("01012345678");
  });

  it("strips spaces", () => {
    expect(normalizeEgyptianPhone("010 1234 5678")).toBe("01012345678");
  });

  it("strips dashes", () => {
    expect(normalizeEgyptianPhone("010-1234-5678")).toBe("01012345678");
  });

  it("strips parentheses", () => {
    expect(normalizeEgyptianPhone("(010) 1234-5678")).toBe("01012345678");
  });

  it("strips dots", () => {
    expect(normalizeEgyptianPhone("010.1234.5678")).toBe("01012345678");
  });

  it("normalizes Arabic-Indic digit phone numbers", () => {
    expect(normalizeEgyptianPhone("٠١٠١٢٣٤٥٦٧٨")).toBe("01012345678");
  });

  it("normalizes Arabic-Indic digits combined with +20 and spaces", () => {
    expect(normalizeEgyptianPhone("+٢٠١٠ ١٢٣٤ ٥٦٧٨")).toBe("01012345678");
  });

  it("extracts the first valid number when multiple are separated by delimiters", () => {
    expect(normalizeEgyptianPhone("01012345678 / 01198765432")).toBe("01012345678");
  });

  it("extracts a valid number embedded in extra text", () => {
    expect(normalizeEgyptianPhone("تليفون: 01012345678 شكرا")).toBe("01012345678");
  });

  it("returns empty string for null/undefined/empty input", () => {
    expect(normalizeEgyptianPhone(null)).toBe("");
    expect(normalizeEgyptianPhone(undefined)).toBe("");
    expect(normalizeEgyptianPhone("")).toBe("");
  });

  it("returns empty string for garbage input shorter than 7 digits", () => {
    expect(normalizeEgyptianPhone("abc12")).toBe("");
  });

  it("falls back to raw digits for a non-Egyptian-mobile but plausible number", () => {
    expect(normalizeEgyptianPhone("035-1234567")).toBe("0351234567");
  });
});

describe("egyptianPhonesMatch", () => {
  it("matches numbers written in different formats", () => {
    expect(egyptianPhonesMatch("01012345678", "+201012345678")).toBe(true);
    expect(egyptianPhonesMatch("010 1234 5678", "٠١٠١٢٣٤٥٦٧٨")).toBe(true);
  });

  it("does not match different numbers", () => {
    expect(egyptianPhonesMatch("01012345678", "01198765432")).toBe(false);
  });

  it("does not match when either side is empty/invalid", () => {
    expect(egyptianPhonesMatch("", "01012345678")).toBe(false);
    expect(egyptianPhonesMatch(null, null)).toBe(false);
  });
});
