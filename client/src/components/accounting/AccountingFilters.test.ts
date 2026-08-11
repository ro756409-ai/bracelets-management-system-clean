import { describe, it, expect } from "vitest";
import fs from "fs";
import { presetRange, PRESETS } from "./AccountingFilters";

/**
 * الفلتر الموحّد.
 *
 * المدى الزمني منطق، والمنطق بيتختبر. الحد الأعلى **حصري** عن قصد — ده مصدر أشهر
 * غلط في الفلاتر: نهاية اليوم كـ23:59:59 بتفقد الحركات في آخر جزء من ثانية.
 */

const now = new Date(2026, 7, 10, 15, 30); // ١٠ أغسطس ٢٠٢٦

describe("🔑 الفترات", () => {
  it("الأربعة المطلوبين وبس", () => {
    expect(PRESETS.map(p => p.label)).toEqual([
      "اليوم",
      "أمس",
      "هذا الشهر",
      "مخصص",
    ]);
  });

  it("اليوم من أول اليوم ومفيش حد أعلى", () => {
    const range = presetRange("today", now);
    expect(range.from).toEqual(new Date(2026, 7, 10));
    expect(range.toExclusive).toBeNull();
  });

  it("🔑 أمس يوم كامل — والحد الأعلى أول النهاردة مش آخر امبارح", () => {
    // 23:59:59 كانت هتفقد الحركة اللي حصلت 23:59:59.5
    const range = presetRange("yesterday", now);
    expect(range.from).toEqual(new Date(2026, 7, 9));
    expect(range.toExclusive).toEqual(new Date(2026, 7, 10));
  });

  it("هذا الشهر من أول يوم فيه", () => {
    expect(presetRange("month", now).from).toEqual(new Date(2026, 7, 1));
  });

  it("مخصص من غير حدود — الشاشة بتحطهم", () => {
    expect(presetRange("custom", now)).toEqual({ from: null, toExclusive: null });
  });

  it("🔑 وأمس في أول الشهر بيرجع للشهر اللي فات صح", () => {
    const firstOfMonth = new Date(2026, 7, 1, 9, 0);
    expect(presetRange("yesterday", firstOfMonth).from).toEqual(
      new Date(2026, 6, 31)
    );
  });
});

describe("🔑 الشكل", () => {
  const src = fs.readFileSync(
    "client/src/components/accounting/AccountingFilters.tsx",
    "utf-8"
  );

  it("🔑 حقول التاريخ بتظهر مع «مخصص» بس", () => {
    expect(src).toContain('{preset === "custom" && (');
  });

  it("نوع الحركة والبحث بيتحطوا في نفس السطر", () => {
    expect(src).toContain("{children}");
  });
});
