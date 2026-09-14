import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حراس Stage C — Inventory Workspace. نصّية (بيئة node، مفيش DOM) زي باقي حراس الواجهة.
 * بتقفل على: بناء الـWorkspace من toolkit المرحلة A، حالة المخزون مصدر واحد، شريط أدوات
 * موحّد، وعدم كسر العزل (multi-business) ولا الاعتماد على currentGroup كنطاق.
 */
const src = fs.readFileSync("client/src/pages/Inventory.tsx", "utf-8");

describe("🔑 Inventory Workspace — toolkit المرحلة A (مفيش أنماط مكرّرة)", () => {
  it("🔑 رأس موحّد PageHeader + WorkspaceTabs (تبويبات المخزون من NavConfig)", () => {
    expect(src).toContain('from "@/components/shared"');
    expect(src).toContain("<PageHeader");
    expect(src).toContain("<WorkspaceTabs tabs={inventoryTabs} />");
    expect(src).toContain('PRIMARY_DESTINATIONS.find(d => d.key === "inventory")');
    expect(src).toContain("visibleChildren(dest, isAdmin, permissions)");
    // مفيش h1 يدوي مكرّر للرأس بعد التوحيد.
    expect(src).not.toContain('<h1 className="text-2xl font-bold text-foreground">المخزن والجرد</h1>');
  });

  it("🔑 حالة المخزون = StatusFilterChips (single source، مش Select مكرّر)", () => {
    expect(src).toContain("<StatusFilterChips");
    // الـSelect القديم لحالة المخزون اتشال (مفيش عنصرين لنفس الفلتر).
    expect(src).not.toContain('<SelectItem value="available">متوفر</SelectItem>');
  });

  it("🔑 شريط أدوات موحّد DataToolbar (بحث + متقدمة + chips + reset)", () => {
    expect(src).toContain("<DataToolbar");
    expect(src).toContain("advancedFilters=");
    expect(src).toContain("onReset=");
  });
});

describe("🔑 Inventory — multi-business isolation محفوظ", () => {
  it("🔑 النطاق من currentBusinessIds (مش currentGroup)", () => {
    expect(src).toContain("currentBusinessIds");
    expect(src).not.toContain("currentGroup");
  });
  it("🔑 عملية الحركة (WRITE) بتتطلب نشاط واحد صريح — مش «كل الأنشطة»", () => {
    // حارس الكتابة القائم: مفيش حركة تحت نطاق متعدد/غير محدد.
    expect(src).toContain("currentBusinessIds?.length !== 1");
    expect(src).toContain("businessId: currentBusinessIds[0]");
  });
});
