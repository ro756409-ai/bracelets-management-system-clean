import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حراس Design System Foundation (المرحلة A) — بيتأكدوا إن الـWorkspace toolkit **بيعيد
 * استخدام** المكتبة المشتركة (مفيش مكوّنات مكرّرة)، والتبويبات responsive، والنغمات موحّدة.
 * نصّية عن قصد (بيئة node، مفيش DOM) — زي باقي حراس الواجهة في المشروع.
 */
const read = (p: string) => fs.readFileSync(p, "utf-8");
const shell = read("client/src/components/workspace/WorkspaceShell.tsx");
const toolbar = read("client/src/components/workspace/DataToolbar.tsx");
const chips = read("client/src/components/workspace/StatusFilterChips.tsx");
const tabs = read("client/src/components/shell/WorkspaceTabs.tsx");
const barrel = read("client/src/components/workspace/index.ts");

describe("🔑 المرحلة A — إعادة استخدام مش تكرار", () => {
  it("🔑 WorkspaceShell بيركّب على PageHeader + WorkspaceTabs المشتركين", () => {
    expect(shell).toContain('from "@/components/shared"');
    expect(shell).toContain("PageHeader");
    expect(shell).toContain("WorkspaceTabs");
    // مش بيعيد كتابة رأس صفحة من الصفر.
    expect(shell).not.toContain("<h1");
  });
  it("🔑 DataToolbar بيعيد استخدام SearchInput + Drawer المشتركين", () => {
    expect(toolbar).toContain("SearchInput");
    expect(toolbar).toContain("Drawer");
    expect(toolbar).toContain('from "@/components/shared"');
    // الفلاتر المتقدمة في Drawer (تقليل الزحام).
    expect(toolbar).toContain("advancedFilters");
  });
  it("🔑 StatusFilterChips بيستخدم نظام النغمات الموحّد (StatusTone)", () => {
    expect(chips).toContain("StatusTone");
  });
});

describe("🔑 المرحلة A — تسلسل الأزرار + الحالات + responsive", () => {
  it("🔑 DataToolbar: الإجراءات هادية (outline)، مش Primary منافِس", () => {
    expect(toolbar).toContain('variant="outline"');
  });
  it("🔑 WorkspaceTabs responsive — مش مخفي على الموبايل", () => {
    expect(tabs).not.toContain("hidden border-b");
    expect(tabs).toContain("overflow-x-auto");
  });
  it("🔑 الـbarrel بيصدّر التوليكت + بيعيد تصدير البدائيات المشتركة (مصدر واحد)", () => {
    for (const name of ["WorkspaceShell", "DataToolbar", "StatusFilterChips", "WorkspaceTabs",
      "ResponsiveDataTable", "StatusBadge", "EmptyState", "LoadingSkeleton", "ErrorState"]) {
      expect(barrel, name).toContain(name);
    }
  });
});
