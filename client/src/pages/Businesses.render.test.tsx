// @vitest-environment jsdom
/**
 * المرحلة 7H — إدارة الأنشطة: التاجر الجديد يرى فراغًا واضحًا مع خطوات الإعداد، Desktop جدول / Mobile
 * بطاقات، إنشاء بحارس ضغط مكرر وslug مشتق، تعديل/تفعيل بنفس الـpayload.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean };
const st = vi.hoisted(() => ({ q: {} as Record<string, Q>, mut: {} as Record<string, ReturnType<typeof vi.fn>>, desktop: true }));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => () => { const q = st.q[key] ?? {}; return { data: q.data, isLoading: q.isLoading ?? false, isError: false, error: null, refetch: vi.fn() }; },
  mkMutation: (key: string) => () => { st.mut[key] ??= vi.fn(); return { mutate: st.mut[key], isPending: false }; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    businesses: { list: { useQuery: mkQuery("list") }, orderEntryMode: { useQuery: mkQuery("mode") }, setOrderEntryMode: { useMutation: mkMutation("setMode") }, create: { useMutation: mkMutation("create") }, update: { useMutation: mkMutation("update") } },
    useUtils: () => ({ businesses: { list: { invalidate: vi.fn() }, activeList: { invalidate: vi.fn() }, orderEntryMode: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("@/components/SetupJourney", () => ({ SetupJourney: ({ current }: any) => <nav data-testid="setup-journey">خطوات الإعداد: {current}</nav> }));
vi.mock("@/components/BusinessLogoField", () => ({ BusinessLogoField: () => <div data-testid="logo-field" /> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));

import Businesses from "./Businesses";

const BIZ = [{ id: 1, name: "براند A", slug: "brand-a", isActive: true, createdAt: "2026-10-01", logoUrl: null }, { id: 2, name: "براند B", slug: "brand-b", isActive: false, createdAt: "2026-10-02", logoUrl: null }];
beforeEach(() => {
  st.q = { list: { data: BIZ }, mode: { data: { mode: "classic" } } }; st.mut = {}; st.desktop = true;
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? st.desktop : !st.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("🏢 إدارة الأنشطة", () => {
  it("تاجر جديد بلا أنشطة: فراغ واضح + خطوات الإعداد + زر إنشاء أول نشاط", () => {
    st.q.list = { data: [] };
    render(<Businesses />);
    expect(screen.getByTestId("setup-journey").textContent).toContain("business");
    expect(screen.getByText("لا توجد أنشطة بعد")).toBeTruthy();
    expect(screen.getByTestId("biz-add-empty")).toBeTruthy();
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
  });
  it("Desktop: جدول بشارات الحالة؛ Mobile: بطاقات وحدها", () => {
    const { unmount } = render(<Businesses />);
    const table = screen.getByTestId("responsive-table-table");
    expect(table.textContent).toContain("براند A"); expect(table.textContent).toContain("نشط"); expect(table.textContent).toContain("معطل");
    expect(screen.queryByTestId("biz-card-1")).toBeNull();
    unmount(); st.desktop = false;
    render(<Businesses />);
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
    expect(screen.getByTestId("biz-card-2").textContent).toContain("معطل");
  });
  it("إنشاء: الاسم فارغ لا يرسل؛ ضغطتان = طلب واحد بـslug مشتق", () => {
    render(<Businesses />);
    fireEvent.click(screen.getByTestId("biz-add"));
    fireEvent.click(screen.getByTestId("biz-create"));
    expect(st.mut.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("biz-field-name"), { target: { value: "Farhat Brass" } });
    const btn = screen.getByTestId("biz-create");
    fireEvent.click(btn); fireEvent.click(btn);
    expect(st.mut.create).toHaveBeenCalledTimes(1);
    expect(st.mut.create.mock.calls[0][0]).toEqual({ name: "Farhat Brass", slug: "farhat-brass" });
  });
  it("تعديل يرسل update بالمعرّف؛ التفعيل يعكس isActive", () => {
    render(<Businesses />);
    fireEvent.click(screen.getByTestId("biz-edit-1"));
    fireEvent.change(screen.getByTestId("biz-edit-name"), { target: { value: "براند A جديد" } });
    fireEvent.click(screen.getByTestId("biz-save"));
    expect(st.mut.update.mock.calls[0][0]).toEqual({ id: 1, name: "براند A جديد", slug: "brand-a" });
    fireEvent.click(screen.getByTestId("biz-toggle-2"));
    expect(st.mut.update.mock.calls[1][0]).toEqual({ id: 2, isActive: true });
  });
});
