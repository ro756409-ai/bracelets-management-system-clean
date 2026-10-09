// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const st = vi.hoisted(() => ({ data: undefined as any }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    tenantAccess: { status: { useQuery: () => ({ data: st.data }) } },
    auth: { logout: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
  },
}));
import { TenantAccessNotice } from "./TenantAccessNotice";
afterEach(() => cleanup());

describe("🔒 شاشة حالة الشركة", () => {
  it("لا شيء قبل جاهزية الحارس (enforced:false) أو والوصول كامل", () => {
    st.data = { enforced: false };
    const { container } = render(<TenantAccessNotice />);
    expect(container.innerHTML).toBe("");
    cleanup();
    st.data = { enforced: true, level: "full", reason: "active", message: "", until: null };
    expect(render(<TenantAccessNotice />).container.innerHTML).toBe("");
  });
  it("read_only: شريط بالسبب بلا حجب الشاشة", () => {
    st.data = { enforced: true, level: "read_only", reason: "trial_ended", message: "انتهت الفترة التجريبية — الحساب للقراءة فقط حتى الاشتراك", until: null };
    render(<TenantAccessNotice />);
    expect(screen.getByTestId("tenant-access-readonly").textContent).toContain("انتهت الفترة التجريبية");
    expect(screen.queryByTestId("tenant-access-blocked")).toBeNull();
  });
  it("blocked: شاشة كاملة وزر خروج فقط", () => {
    st.data = { enforced: true, level: "blocked", reason: "suspended", message: "الحساب موقوف — تواصل مع الدعم", until: null };
    render(<TenantAccessNotice />);
    expect(screen.getByTestId("tenant-access-blocked").textContent).toContain("الحساب موقوف");
    expect(screen.getAllByRole("button").map(b => b.textContent)).toEqual([" تسجيل الخروج"]);
  });
});
