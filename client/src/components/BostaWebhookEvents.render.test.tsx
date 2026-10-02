// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const state = vi.hoisted(() => ({ rows: [] as any[], queryInput: null as any, mutate: null as any }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ carrierAccounts: { webhookEvents: { invalidate: () => {} } } }),
    carrierAccounts: {
      webhookEvents: { useQuery: (input: any) => { state.queryInput = input; return { data: state.rows, isLoading: false }; } },
      reprocessWebhookEvent: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
    },
  },
}));
import { BostaWebhookEvents } from "./BostaWebhookEvents";

const row = (id: number, processingStatus: string, over: Record<string, unknown> = {}) => ({
  id, provider: "bosta", shipmentId: `S${id}`, trackingNumber: `10${id}`, stateCode: 45, eventType: "SEND", eventTimestamp: 1, orderId: null,
  processingStatus, failureReason: null, attempts: 1, duplicateCount: 0, receivedAt: new Date(), processedAt: new Date(), stateLabel: "تم التسليم", ...over,
});
beforeEach(() => { state.rows = []; state.mutate = vi.fn(); });
afterEach(() => cleanup());

describe("🔑 أحداث بوسطة للمراجعة", () => {
  it("مفيش أحداث → لا يظهر شيء", () => {
    const { container } = render(<BostaWebhookEvents businessId={7} />);
    expect(container.innerHTML).toBe("");
  });
  it("القائمة بنطاق النشاط الحالي، وإعادة المعالجة لـunmatched/failed فقط", () => {
    state.rows = [
      row(1, "unmatched", { failureReason: "لا توجد شحنة مطابقة داخل هذا النشاط" }),
      row(2, "failed", { failureReason: "انقطاع مؤقت" }),
      row(3, "ignored", { stateCode: 103, stateLabel: "في انتظار إجراء منك" }),
    ];
    render(<BostaWebhookEvents businessId={7} />);
    expect(state.queryInput).toMatchObject({ businessId: 7, statuses: ["unmatched", "failed", "ignored"] });
    expect(screen.getByTestId("bosta-webhook-events").textContent).toContain("(3)");
    expect(screen.getByTestId("bosta-event-3").textContent).toContain("في انتظار إجراء منك");
    expect(screen.getByTestId("bosta-event-1").textContent).toContain("لا توجد شحنة مطابقة");
    expect(screen.queryByTestId("bosta-event-reprocess-3")).toBeNull();
    fireEvent.click(screen.getByTestId("bosta-event-reprocess-2"));
    expect(state.mutate).toHaveBeenCalledWith({ businessId: 7, eventId: 2 });
  });
});
