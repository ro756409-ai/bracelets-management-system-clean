// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Business } from "@/contexts/BusinessContext";

/**
 * هوية النشاط في رأس السايدبار (Desktop) وشريط الموبايل (Mobile) — نفس المكوّن، نفس المصدر.
 * السياق mocked: البيانات هنا شكل `businesses.activeList` بس (أسماء عشوائية، مفيش نشاط حقيقي).
 */
const ctx = vi.hoisted(() => ({ value: {} as any }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ctx.value }));

import { BusinessSwitcher } from "./BusinessSwitcher";

const biz = (id: number, name: string, logoUrl: string | null = null): Business =>
  ({ id, name, slug: `b${id}`, groupId: null, isActive: true, logoUrl });

function setCtx(businesses: Business[], currentBusinessId: number | undefined) {
  ctx.value = {
    businesses, groups: [], currentBusinessId, setCurrentBusinessId: vi.fn(),
    activeBusiness: businesses.find(b => b.id === currentBusinessId),
  };
}

afterEach(() => cleanup());

describe("🔑 هوية النشاط — Desktop وMobile", () => {
  it("🔑 نشاط واحد بلا لوجو: الاسم + أول حرف، بلا زر تبديل — في السايدبار وشريط الموبايل", () => {
    setCtx([biz(11, "متجر القمر")], 11);
    for (const variant of ["sidebar", "topbar"] as const) {
      const { unmount } = render(<BusinessSwitcher variant={variant} />);
      expect(screen.getByTestId("business-name").textContent).toBe("متجر القمر");
      expect(screen.getByTestId("business-initial").textContent).toBe("م");
      expect(screen.queryByTestId("business-logo")).toBeNull();
      expect(screen.queryByTestId("business-switcher")).toBeNull(); // مفيش قائمة لنشاط واحد
      unmount();
    }
  });
  it("🔑 لوجو موجود → صورة بالمرجع نفسه بدل الحرف", () => {
    setCtx([biz(11, "متجر القمر", "/api/branding/files/t1-logo-abc.png")], 11);
    render(<BusinessSwitcher variant="sidebar" />);
    expect(screen.getByTestId("business-logo").getAttribute("src")).toBe("/api/branding/files/t1-logo-abc.png");
    expect(screen.queryByTestId("business-initial")).toBeNull();
  });
  it("🔑 سايدبار مطوية → اللوجو/الحرف فقط بلا اسم", () => {
    setCtx([biz(11, "متجر القمر")], 11);
    render(<BusinessSwitcher variant="sidebar" collapsed />);
    expect(screen.getByTestId("business-initial")).toBeTruthy();
    expect(screen.queryByTestId("business-name")).toBeNull();
  });
  it("🔑 عدة أنشطة → الرأس زر تبديل (aria-label) وبيعرض النشاط الفعّال", () => {
    setCtx([biz(11, "متجر القمر"), biz(12, "متجر الشمس", "/api/branding/files/t1-logo-s.png")], 12);
    render(<BusinessSwitcher variant="topbar" />);
    expect(screen.getByTestId("business-switcher").getAttribute("aria-label")).toBe("تبديل النشاط");
    expect(screen.getByTestId("business-name").textContent).toBe("متجر الشمس");
    expect(screen.getByTestId("business-logo")).toBeTruthy();
  });
  it("🔑 عدة أنشطة بلا اختيار → «كل الأنشطة»", () => {
    setCtx([biz(11, "متجر القمر"), biz(12, "متجر الشمس")], undefined);
    render(<BusinessSwitcher variant="sidebar" />);
    expect(screen.getByTestId("business-name").textContent).toBe("كل الأنشطة");
    expect(screen.getByTestId("business-all")).toBeTruthy();
  });
});
