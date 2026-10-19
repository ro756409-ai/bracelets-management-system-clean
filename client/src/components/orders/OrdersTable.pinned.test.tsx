// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { OrdersTable, buildOrdersColumns } from "./OrdersTable";

/** v2: «مبلغ التحصيل» عمود مثبّت بين الحافتين (مايتغطّاش ولا يتعلّم ⋯)؛ v1 بدون تغيير. */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const ctx: any = { seqByOrderId: new Map(), employeeNameById: new Map(), businessNameById: new Map(), sourceLabel: (s: string) => s,
  actions: { isAdmin: true, confirmPending: false, duplicatePending: false, onConfirm: vi.fn(), onCancel: vi.fn(), onDetails: vi.fn(), onPostpone: vi.fn(), onNoAnswer: vi.fn(), onCall: vi.fn(), onEdit: vi.fn(), onDuplicate: vi.fn(), onReturn: vi.fn(), onDelete: vi.fn() } };
const rows = [{ id: 1, orderNumber: "A", customerName: "x", customerPhone: "0100", productName: "p", quantity: 1, totalAmount: "1250", status: "new", source: "manual", createdAt: "2026-10-01T00:00:00Z", collectionStatus: "pending" }];
afterEach(() => { cleanup(); document.documentElement.removeAttribute("data-brand"); });

describe("📌 مبلغ التحصيل", () => {
  it("v2: الخلية والرأس مثبّتين بإزاحتي الأعمدة الثابتة، وغير خاضعين لعلامة ⋯", () => {
    document.documentElement.setAttribute("data-brand", "v2");
    render(<OrdersTable rows={rows as any} columns={buildOrdersColumns(ctx)} mobileRow={() => null} hiddenColumns={new Set(["seq", "website"])} />);
    const cells = document.querySelectorAll<HTMLElement>('[data-rdt-sticky="pinned"]');
    expect(cells.length).toBe(2); // th + td
    for (const c of cells) {
      expect(c.className).toContain("sticky");
      expect(c.style.insetInlineStart).toBe("var(--rdt-start-w, 0px)");
      expect(c.style.insetInlineEnd).toBe("var(--rdt-end-w, 0px)");
    }
    const td = document.querySelector<HTMLElement>('td[data-rdt-sticky="pinned"]')!;
    expect(td.textContent).toContain("ج.م");
    expect(td.querySelector("[data-rdt-value]")).not.toBeNull();
  });
  it("v1: مفيش تثبيت ولا علامات جديدة", () => {
    render(<OrdersTable rows={rows as any} columns={buildOrdersColumns(ctx)} mobileRow={() => null} hiddenColumns={new Set(["seq", "website"])} />);
    expect(document.querySelector('[data-rdt-sticky="pinned"]')).toBeNull();
    expect(document.querySelector("[data-rdt-numeric]")).toBeNull();
  });
});
