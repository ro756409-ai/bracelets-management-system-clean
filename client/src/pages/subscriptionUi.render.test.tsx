// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";

/** صفحة الاشتراك للمالك + لوحة فوترة المنصة + شريط السماح/التقييد + رابط التنقّل خلف العلم. */
const st = vi.hoisted(() => ({ status: null as any, error: null as any, checkoutCalls: [] as any[], access: { enforced: false, billing: false } as any }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    subscription: {
      status: { useQuery: () => ({ data: st.status, error: st.error, isLoading: false, isFetching: false, refetch: vi.fn() }) },
      createCheckout: { useMutation: () => ({ isPending: false, mutateAsync: async (i: any) => { st.checkoutCalls.push(i); return { paymentId: 1, status: "pending", replay: false, checkout: { mock: true } }; } }) },
    },
    tenantAccess: { status: { useQuery: () => ({ data: st.access }) } },
    auth: { logout: { useMutation: () => ({ mutateAsync: async () => {} }) } },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/shared/toast", () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { I18nProvider } from "@/i18n";
import Subscription from "./Subscription";
import { PlatformBillingPanel } from "./platform/PlatformBillingPanel";
import { TenantAccessProvider } from "@/contexts/TenantAccessContext";
import { TenantAccessNotice } from "@/components/TenantAccessNotice";
import { visibleChildren, PRIMARY_DESTINATIONS } from "@/config/navigation";

const mount = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);
const base = { plans: [], periods: [], payments: [] };
beforeEach(() => { st.status = null; st.error = null; st.checkoutCalls = []; st.access = { enforced: false, billing: false }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("💳 صفحة الاشتراك", () => {
  it("العلم مقفول ⇒ رسالة إن مفيش أي إجراء مطلوب", () => {
    st.status = { enabled: false, plans: [] };
    mount(<Subscription />);
    expect(screen.getByTestId("sub-disabled")).toBeTruthy();
  });
  it("شركة قديمة مش مسجّلة ⇒ مفيش تغيير مطلوب", () => {
    st.status = { enabled: true, enrolled: false, status: null, ...base, online: false };
    mount(<Subscription />);
    expect(screen.getByTestId("sub-not-enrolled")).toBeTruthy();
  });
  it("منتهي: الحالة + تعليمات التحويل، ومفيش زر دفع أونلاين لما مفيش مزوّد", () => {
    st.status = { enabled: true, enrolled: true, status: { state: "expired", paidUntil: "2026-01-01T00:00:00Z", graceEndsAt: "2026-01-04T00:00:00Z" }, ...base, online: false,
      payments: [{ id: 3, planCode: "month_1", months: 1, amountMinor: 50000, currency: "EGP", provider: "manual", status: "succeeded", paymentReference: "TRX-1", createdAt: "2025-12-01T00:00:00Z", succeededAt: "2025-12-01T00:00:00Z", refundedAt: null }] };
    mount(<Subscription />);
    expect(screen.getByTestId("sub-state").textContent).toContain("منتهي");
    expect(screen.getByTestId("sub-manual").textContent).toContain("الدفع الأونلاين غير متاح");
    expect(screen.queryByRole("button", { name: /ادفع أونلاين/ })).toBeNull();
    expect(screen.getByTestId("sub-history").textContent).toContain("TRX-1");
  });
  it("مزوّد شغال: الضغط مرتين على نفس الخطة = نفس مفتاح منع التكرار", async () => {
    st.status = { enabled: true, enrolled: true, status: { state: "pending_payment", paidUntil: null, graceEndsAt: null }, ...base, online: true };
    mount(<Subscription />);
    const btn = within(screen.getByTestId("plan-month_12")).getByRole("button");
    await act(async () => { fireEvent.click(btn); });
    await act(async () => { fireEvent.click(btn); });
    expect(st.checkoutCalls).toHaveLength(2);
    expect(st.checkoutCalls[0]).toMatchObject({ planCode: "month_12" });
    expect(st.checkoutCalls[1].idempotencyKey).toBe(st.checkoutCalls[0].idempotencyKey);
  });
  it("غير المالك ⇒ رسالة للمالك بس", () => {
    st.error = { data: { code: "FORBIDDEN" } };
    mount(<Subscription />);
    expect(document.body.textContent).toContain("صفحة الاشتراك للمالك بس");
  });
});

describe("🛡️ لوحة فوترة المنصة", () => {
  const overview = { tenantId: 7, enrolled: true, status: { state: "active", paidUntil: "2026-12-01T00:00:00Z", graceEndsAt: "2026-12-04T00:00:00Z" }, periods: [], payments: [] };
  it("الدفع اليدوي بيبعت مرجع + دليل + مفتاح ثابت لإعادة المحاولة، ومفتاح جديد بعد النجاح", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bodies: any[] = [];
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body));
        if (fail) { fail = false; return new Response(JSON.stringify({ success: false, error: "انقطاع" }), { status: 503 }); }
        return new Response(JSON.stringify({ success: true, replay: false }), { status: 200 });
      }
      return new Response(JSON.stringify(overview), { status: 200 });
    });
    render(<PlatformBillingPanel onUnauthorized={() => {}} />);
    fireEvent.change(screen.getByLabelText("رقم الشركة (Tenant)"), { target: { value: "7" } });
    await act(async () => { fireEvent.submit(screen.getByRole("search")); await new Promise(r => setTimeout(r, 20)); });
    expect(screen.getByTestId("billing-overview").textContent).toContain("فعّال");
    const record = screen.getByTestId("billing-record") as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/مرجع الدفع/), { target: { value: "INSTA-77" } });
    fireEvent.change(screen.getByLabelText("رابط الدليل (https)"), { target: { value: "https://e.example/r.png" } });
    fireEvent.click(screen.getByLabelText(/سنة/));
    await act(async () => { fireEvent.submit(screen.getByTestId("billing-manual-form")); await new Promise(r => setTimeout(r, 20)); });
    expect(screen.getByTestId("billing-msg").textContent).toContain("انقطاع");
    await act(async () => { fireEvent.submit(screen.getByTestId("billing-manual-form")); await new Promise(r => setTimeout(r, 20)); });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ planCode: "month_12", paymentReference: "INSTA-77", evidenceUrl: "https://e.example/r.png" });
    expect(bodies[1].idempotencyKey).toBe(bodies[0].idempotencyKey);
    expect(screen.getByTestId("billing-msg").textContent).toContain("تم تسجيل الدفع");
  });
  it("شركة غير مسجّلة ⇒ زر تسجيل صريح ومفيش نموذج دفع", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...overview, enrolled: false, status: null }), { status: 200 }));
    render(<PlatformBillingPanel onUnauthorized={() => {}} />);
    fireEvent.change(screen.getByLabelText("رقم الشركة (Tenant)"), { target: { value: "7" } });
    await act(async () => { fireEvent.submit(screen.getByRole("search")); await new Promise(r => setTimeout(r, 20)); });
    expect(screen.getByTestId("billing-enroll")).toBeTruthy();
    expect(screen.queryByTestId("billing-manual-form")).toBeNull();
  });
});

describe("🔔 شريط الحالة + التنقّل", () => {
  it("السماح (full) بيظهر تنبيه تجديد؛ restricted بيظهر شريط برابط الاشتراك من غير تعطيل الأزرار", async () => {
    st.access = { enforced: true, billing: true, level: "full", reason: "subscription_grace", message: "فترة سماح", until: "2026-12-04T00:00:00Z" };
    render(<TenantAccessProvider><TenantAccessNotice /><button>إلغاء الأوردر</button></TenantAccessProvider>);
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(screen.getByTestId("tenant-access-grace").querySelector('a[href="/subscription"]')).toBeTruthy();
    cleanup();
    st.access = { enforced: true, billing: true, level: "restricted", reason: "subscription_expired", message: "انتهى الاشتراك", until: null };
    render(<TenantAccessProvider><TenantAccessNotice /><button>إلغاء الأوردر</button></TenantAccessProvider>);
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(screen.getByTestId("tenant-access-restricted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "إلغاء الأوردر" }).getAttribute("aria-disabled")).toBeNull();
    expect(document.documentElement.getAttribute("data-tenant-readonly")).toBeNull();
  });
  it("رابط «الاشتراك» في الإعدادات للمالك بس ولما العلم شغال", () => {
    const settings = PRIMARY_DESTINATIONS.find(d => d.key === "settings")!;
    const has = (isAdmin: boolean, flags: any[]) => visibleChildren(settings, isAdmin, [], flags).some(c => c.path === "/subscription");
    expect(has(true, [])).toBe(false);
    expect(has(true, ["subscription"])).toBe(true);
    expect(has(false, ["subscription"])).toBe(false);
  });
});
