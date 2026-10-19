import { describe, it, expect } from "vitest";
import { SIDEBAR_TOKEN_CSS } from "@/components/DashboardLayout";

/**
 * انحدار حقيقي اتلقط في المتصفح: الغلاف الأب للسايدبار بيحسب لون النص من متغيرات :root (سايدبار داكن، نص #F3F1F2)، والحاوية
 * بتقلب الخلفية لبطاقة بيضاء — فبنود القائمة اللي مالهاش لون صريح كانت بتورث نص شبه أبيض على أبيض (~1.1:1).
 * الحاوية لازم تعيد تعريف color من متغيراتها هي.
 */
describe("🎨 تباين السايدبار", () => {
  it("حاوية السايدبار (ديسكتوب وورقة الموبايل) بتعيد تعريف لون النص من --sidebar-foreground بتاعها", () => {
    const block = SIDEBAR_TOKEN_CSS.slice(SIDEBAR_TOKEN_CSS.indexOf("{"), SIDEBAR_TOKEN_CSS.lastIndexOf("}"));
    expect(SIDEBAR_TOKEN_CSS).toContain('[data-slot="sidebar-container"]');
    expect(SIDEBAR_TOKEN_CSS).toContain('[data-slot="sidebar"][data-mobile="true"]');
    expect(block).toContain("--sidebar-foreground: var(--foreground);");
    expect(block).toMatch(/\n\s*color: var\(--sidebar-foreground\);/);
  });
});
