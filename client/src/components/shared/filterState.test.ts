import { describe, expect, it } from "vitest";
import {
  isEmptyFilterValue,
  isActiveFilter,
  buildFilterChips,
  countActiveFilters,
  clearFilter,
} from "./filterState";

describe("isEmptyFilterValue", () => {
  it("treats null/undefined/blank string/empty array as empty", () => {
    expect(isEmptyFilterValue(null)).toBe(true);
    expect(isEmptyFilterValue(undefined)).toBe(true);
    expect(isEmptyFilterValue("")).toBe(true);
    expect(isEmptyFilterValue("   ")).toBe(true);
    expect(isEmptyFilterValue([])).toBe(true);
  });

  it("treats real values as non-empty", () => {
    expect(isEmptyFilterValue("القاهرة")).toBe(false);
    expect(isEmptyFilterValue(["a"])).toBe(false);
    expect(isEmptyFilterValue(0)).toBe(false);
    expect(isEmptyFilterValue(false)).toBe(false);
  });

  it("treats a date-range object as empty only when both ends are unset", () => {
    expect(isEmptyFilterValue({ from: null, to: null })).toBe(true);
    expect(isEmptyFilterValue({ from: new Date(), to: null })).toBe(false);
  });

  it("never treats a Date instance as empty", () => {
    expect(isEmptyFilterValue(new Date())).toBe(false);
  });
});

describe("isActiveFilter", () => {
  it("does not count the 'all' sentinel as an active filter", () => {
    expect(isActiveFilter("all")).toBe(false);
    expect(isActiveFilter("الكل")).toBe(false);
  });

  it("counts a real status as active", () => {
    expect(isActiveFilter("confirmed")).toBe(true);
  });

  it("treats boolean filters correctly — true is active, false is not", () => {
    expect(isActiveFilter(true)).toBe(true);
    expect(isActiveFilter(false)).toBe(false);
  });
});

type OrderFilters = {
  status: string;
  governorate: string;
  needsReview: boolean;
  dateRange: { from: Date | null; to: Date | null };
};

const INITIAL: OrderFilters = {
  status: "all",
  governorate: "",
  needsReview: false,
  dateRange: { from: null, to: null },
};

const DESCRIPTORS = [
  { key: "status" as const, label: "الحالة" },
  { key: "governorate" as const, label: "المحافظة" },
  { key: "needsReview" as const, label: "تحتاج مراجعة" },
];

describe("buildFilterChips / countActiveFilters", () => {
  it("produces no chips on the pristine filter state", () => {
    expect(buildFilterChips(INITIAL, DESCRIPTORS)).toEqual([]);
    expect(countActiveFilters(INITIAL, DESCRIPTORS)).toBe(0);
  });

  it("produces one chip per set filter, preserving descriptor order", () => {
    const filters: OrderFilters = {
      ...INITIAL,
      status: "confirmed",
      governorate: "الجيزة",
    };
    const chips = buildFilterChips(filters, DESCRIPTORS);
    expect(chips.map((c) => c.key)).toEqual(["status", "governorate"]);
    expect(chips[0]).toEqual({ key: "status", label: "الحالة", value: "confirmed" });
    expect(countActiveFilters(filters, DESCRIPTORS)).toBe(2);
  });

  it("respects a custom formatter", () => {
    const chips = buildFilterChips(
      { ...INITIAL, needsReview: true },
      [{ key: "needsReview" as const, label: "المراجعة", format: () => "مفعّل" }]
    );
    expect(chips[0].value).toBe("مفعّل");
  });
});

describe("clearFilter", () => {
  it("resets exactly one key back to its initial value, leaving the rest untouched", () => {
    const filters: OrderFilters = {
      status: "cancelled",
      governorate: "أسيوط",
      needsReview: true,
      dateRange: { from: null, to: null },
    };
    const next = clearFilter(filters, "status", INITIAL);
    expect(next.status).toBe("all");
    expect(next.governorate).toBe("أسيوط"); // untouched
  });
});
