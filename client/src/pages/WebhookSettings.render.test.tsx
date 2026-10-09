// @vitest-environment jsdom
/**
 * المرحلة 7H — سجل Easy Order: الإحصاءات من السجل نفسه وتعمل كفلتر، خطوات الإعداد قابلة للطي بلا أي
 * Secret، صفوف السجل تُفتح بزر aria-expanded، والبحث يفلتر.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";

const st = vi.hoisted(() => ({ log: [] as any[], loading: false }));
vi.mock("@/lib/trpc", () => ({ trpc: { webhook: { log: { useQuery: () => ({ data: { log: st.log }, isLoading: st.loading, isFetching: false, refetch: vi.fn() }) } } } }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("@/components/SetupJourney", () => ({ SetupJourney: () => <nav data-testid="setup-journey" /> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import WebhookSettings from "./WebhookSettings";

const LOG = [
  { id: 1, status: "success", customerName: "منى", externalOrderId: "EO-1", customerPhone: "0100", governorate: "القاهرة", message: "تم الاستيراد", receivedAt: "2026-10-09T10:00:00Z", importedCount: 1, totalAmount: "250", itemsCount: 2, eventType: "order.created", rawPayload: '{"a":1}' },
  { id: 2, status: "duplicate", customerName: "سارة", externalOrderId: "EO-2", message: "مكرر", receivedAt: "2026-10-09T11:00:00Z" },
  { id: 3, status: "error", message: "secret mismatch", receivedAt: "2026-10-09T12:00:00Z" },
];
beforeEach(() => { st.log = LOG; st.loading = false; vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("⚡ سجل Easy Order", () => {
  it("الإحصاءات من السجل؛ بطاقة «خطأ» تفلتر الصفوف ثم تُلغى بالضغط مرة أخرى", () => {
    render(<WebhookSettings />);
    const stats = screen.getByTestId("webhook-stats").textContent ?? "";
    expect(stats).toContain("٣"); expect(stats).toContain("١");
    expect(screen.getAllByTestId(/^webhook-log-\d+$/)).toHaveLength(3);
    fireEvent.click(within(screen.getByTestId("webhook-stats")).getByText("خطأ").closest('[role="button"]')!);
    expect(screen.getAllByTestId(/^webhook-log-\d+$/)).toHaveLength(1);
    expect(screen.getByTestId("webhook-filter-error").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(screen.getByTestId("webhook-stats")).getByText("خطأ").closest('[role="button"]')!);
    expect(screen.getAllByTestId(/^webhook-log-\d+$/)).toHaveLength(3);
  });
  it("خطوات الإعداد مطوية افتراضيًا؛ عند الفتح يظهر رابط الـWebhook بلا أي Secret", () => {
    render(<WebhookSettings />);
    expect(screen.queryByTestId("webhook-url")).toBeNull();
    fireEvent.click(screen.getByTestId("webhook-setup-toggle"));
    expect(screen.getByTestId("webhook-setup-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("webhook-url").textContent).toContain("/api/webhooks/easyorder");
    expect(screen.getByTestId("webhook-url").textContent).not.toMatch(/secret=/i);
    expect(screen.getByTestId("webhook-setup-card").textContent).toContain("النظام لا يعرض الـ Secret في المتصفح");
  });
  it("صف السجل يُفتح بزر aria-expanded ويعرض التفاصيل؛ البحث يفلتر", () => {
    render(<WebhookSettings />);
    const row = screen.getByTestId("webhook-log-1");
    const btn = row.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(row.textContent).toContain("order.created"); expect(row.textContent).toContain("٢٥٠");
    const search = screen.getByLabelText("بحث بالاسم أو التليفون أو رقم الأوردر...") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "سارة" } });
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getAllByTestId(/^webhook-log-\d+$/)).toHaveLength(1);
    expect(screen.getByTestId("webhook-log-2")).toBeTruthy();
  });
  it("لا سجل بعد → حالة فارغة توجّه للإعداد", () => {
    st.log = [];
    render(<WebhookSettings />);
    expect(screen.getByText("لم يصل أي Webhook بعد")).toBeTruthy();
  });
});
