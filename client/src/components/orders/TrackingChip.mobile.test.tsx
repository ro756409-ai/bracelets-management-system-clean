// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { OrdersMobileCard } from "./OrdersMobileList";

/** رقم التتبع الحقيقي على كارت الموبايل (اتلقط في المتصفح: كان ظاهر في جدول الديسكتوب بس) + النسخ مايفتحش الأوردر. */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const onDetails = vi.fn();
const ctx: any = {
  seqByOrderId: new Map(), employeeNameById: new Map(), businessNameById: new Map(), sourceLabel: (s: string) => s,
  actions: { isAdmin: false, confirmPending: false, duplicatePending: false, onConfirm: vi.fn(), onCancel: vi.fn(), onDetails, onPostpone: vi.fn(), onNoAnswer: vi.fn(), onCall: vi.fn(), onEdit: vi.fn(), onDuplicate: vi.fn(), onReturn: vi.fn(), onDelete: vi.fn() },
};
const base = { id: 1, orderNumber: "MJ-1", customerName: "أحمد", customerPhone: "0100", governorate: "القاهرة", productName: "سوار", quantity: 1, totalAmount: "450", status: "shipped", source: "manual", createdAt: "2026-10-01T10:00:00Z", collectionStatus: "pending" };
afterEach(() => { cleanup(); onDetails.mockReset(); });

describe("📱 شارة التتبع على كارت الموبايل", () => {
  it("شحنة بوسطة برقم تتبع ⇒ الرقم + زر نسخ ظاهرين والكارت مقفول؛ النسخ (ضغط/Enter) مايفتحش التفاصيل", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<OrdersMobileCard order={{ ...base, bostaShipmentId: "SHP1", bostaTrackingNumber: "41234918" } as any} ctx={ctx} expanded={false} onToggle={() => {}} />);
    const chip = screen.getByTestId("tracking-chip");
    expect(within(chip).getByTestId("tracking-number").textContent).toBe("41234918");
    const copy = within(chip).getByTestId("tracking-copy");
    fireEvent.keyDown(copy, { key: "Enter" });
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith("41234918");
    expect(onDetails).not.toHaveBeenCalled();
  });
  it("مفيش شحنة بوسطة ⇒ مفيش شارة", () => {
    render(<OrdersMobileCard order={base as any} ctx={ctx} expanded={false} onToggle={() => {}} />);
    expect(screen.queryByTestId("tracking-chip")).toBeNull();
  });
});
