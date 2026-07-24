import { describe, it, expect } from "vitest";
import {
  findPotentialDuplicates,
  hasStrongDuplicateSignal,
  type ExistingOrderForDuplicateCheck,
} from "./duplicateDetection";

const baseExisting: ExistingOrderForDuplicateCheck = {
  id: 1,
  customerPhone: "01012345678",
  customerAddress: "شارع التحرير، القاهرة",
  productId: 5,
  productName: "سوار نحاس طبي",
  externalOrderId: "EO-100",
  bostaTrackingNumber: "N-12345",
};

describe("findPotentialDuplicates", () => {
  it("returns no matches when nothing overlaps", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "01198765432", customerAddress: "الجيزة" },
      [baseExisting]
    );
    expect(matches).toEqual([]);
  });

  it("flags samePhone only when phone matches but nothing else does", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "01012345678", customerAddress: "عنوان مختلف تمامًا", productId: 99 },
      [baseExisting]
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].signals).toEqual(["samePhone"]);
  });

  it("recognizes the same phone across different formats (country code / Arabic digits)", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "+201012345678" },
      [baseExisting]
    );
    expect(matches[0].signals).toContain("samePhone");
  });

  it("flags samePhoneAndProduct when phone and product both match", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "01012345678", productId: 5, customerAddress: "عنوان آخر" },
      [baseExisting]
    );
    expect(matches[0].signals).toContain("samePhone");
    expect(matches[0].signals).toContain("samePhoneAndProduct");
    expect(matches[0].signals).not.toContain("samePhoneAndAddress");
  });

  it("matches product by name when productId is not available", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "01012345678", productName: "سوار نحاس طبي" },
      [baseExisting]
    );
    expect(matches[0].signals).toContain("samePhoneAndProduct");
  });

  it("flags samePhoneAndAddress when phone and address both match (address whitespace/case-insensitive)", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "01012345678", customerAddress: "  شارع التحرير،   القاهرة  " },
      [baseExisting]
    );
    expect(matches[0].signals).toContain("samePhoneAndAddress");
  });

  it("flags sameExternalOrderId even when phone differs", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "01199999999", externalOrderId: "EO-100" },
      [baseExisting]
    );
    expect(matches[0].signals).toEqual(["sameExternalOrderId"]);
  });

  it("flags sameTrackingNumber even when phone differs", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "01199999999", bostaTrackingNumber: "N-12345" },
      [baseExisting]
    );
    expect(matches[0].signals).toEqual(["sameTrackingNumber"]);
  });

  it("can report multiple signals at once for the same order", () => {
    const matches = findPotentialDuplicates(
      {
        customerPhone: "01012345678",
        productId: 5,
        customerAddress: "شارع التحرير، القاهرة",
        externalOrderId: "EO-100",
      },
      [baseExisting]
    );
    expect(matches[0].signals).toEqual(
      expect.arrayContaining([
        "sameExternalOrderId",
        "samePhone",
        "samePhoneAndProduct",
        "samePhoneAndAddress",
      ])
    );
  });

  it("ignores empty externalOrderId/trackingNumber (does not match empty-to-empty)", () => {
    const matches = findPotentialDuplicates(
      { customerPhone: "01199999999", externalOrderId: "", bostaTrackingNumber: "" },
      [{ ...baseExisting, customerPhone: "01111111111", externalOrderId: "", bostaTrackingNumber: "" }]
    );
    expect(matches).toEqual([]);
  });

  it("checks against multiple existing orders independently", () => {
    const second: ExistingOrderForDuplicateCheck = {
      id: 2,
      customerPhone: "01012345678",
      productId: 7,
      externalOrderId: "EO-200",
    };
    const matches = findPotentialDuplicates(
      { customerPhone: "01012345678", productId: 5 },
      [baseExisting, second]
    );
    expect(matches).toHaveLength(2);
    const byId = Object.fromEntries(matches.map(m => [m.orderId, m.signals]));
    expect(byId[1]).toContain("samePhoneAndProduct");
    expect(byId[2]).toEqual(["samePhone"]);
  });
});

describe("hasStrongDuplicateSignal", () => {
  it("is false for samePhone alone — a repeat customer is not an automatic duplicate", () => {
    expect(hasStrongDuplicateSignal([{ orderId: 1, signals: ["samePhone"] }])).toBe(false);
  });

  it("is true for samePhoneAndProduct", () => {
    expect(
      hasStrongDuplicateSignal([{ orderId: 1, signals: ["samePhone", "samePhoneAndProduct"] }])
    ).toBe(true);
  });

  it("is true for sameExternalOrderId", () => {
    expect(hasStrongDuplicateSignal([{ orderId: 1, signals: ["sameExternalOrderId"] }])).toBe(true);
  });

  it("is true for sameTrackingNumber", () => {
    expect(hasStrongDuplicateSignal([{ orderId: 1, signals: ["sameTrackingNumber"] }])).toBe(true);
  });

  it("is false for samePhoneAndAddress alone (address alone is not treated as strong)", () => {
    expect(
      hasStrongDuplicateSignal([{ orderId: 1, signals: ["samePhone", "samePhoneAndAddress"] }])
    ).toBe(false);
  });

  it("is false for an empty match list", () => {
    expect(hasStrongDuplicateSignal([])).toBe(false);
  });
});
