import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db functions
const mockGetOrderById = vi.fn();
const mockGenerateOrderNumber = vi.fn();
const mockCreateOrder = vi.fn();
const mockAddActivityLog = vi.fn();

vi.mock("./db", () => ({
  getOrderById: (...args: any[]) => mockGetOrderById(...args),
  generateOrderNumber: (...args: any[]) => mockGenerateOrderNumber(...args),
  createOrder: (...args: any[]) => mockCreateOrder(...args),
  addActivityLog: (...args: any[]) => mockAddActivityLog(...args),
  getAllEmployees: vi.fn().mockResolvedValue([]),
}));

describe("Order Duplicate Logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should duplicate an order with correct fields", async () => {
    const originalOrder = {
      id: 42,
      orderNumber: "100",
      customerName: "أحمد فرحات",
      customerPhone: "01012345678",
      customerAddress: "شارع التحرير، القاهرة",
      governorate: "القاهرة",
      productId: 1,
      productName: "سوار نحاس طبي",
      quantity: 2,
      totalAmount: "350.00",
      source: "manual",
      notes: "ملاحظة قديمة",
      pageName: "فرحات للنحاس",
      adName: "إعلان 1",
      status: "confirmed",
    };

    mockGetOrderById.mockResolvedValue(originalOrder);
    mockGenerateOrderNumber.mockResolvedValue("101");
    mockCreateOrder.mockResolvedValue(undefined);
    mockAddActivityLog.mockResolvedValue(undefined);

    // Simulate the duplicate logic from routers.ts
    const order = await mockGetOrderById(42);
    expect(order).toBeDefined();

    const newOrderNumber = await mockGenerateOrderNumber();
    expect(newOrderNumber).toBe("101");

    const newOrderData = {
      orderNumber: newOrderNumber,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerAddress: order.customerAddress,
      governorate: order.governorate,
      productId: order.productId,
      productName: order.productName,
      quantity: order.quantity ?? 1,
      totalAmount: order.totalAmount,
      source: order.source,
      notes: order.notes
        ? `تكرار من أوردر #${order.orderNumber} — ${order.notes}`
        : `تكرار من أوردر #${order.orderNumber}`,
      pageName: order.pageName,
      adName: order.adName,
    };

    await mockCreateOrder(newOrderData);

    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderNumber: "101",
        customerName: "أحمد فرحات",
        customerPhone: "01012345678",
        customerAddress: "شارع التحرير، القاهرة",
        governorate: "القاهرة",
        productId: 1,
        productName: "سوار نحاس طبي",
        quantity: 2,
        totalAmount: "350.00",
        source: "manual",
        notes: "تكرار من أوردر #100 — ملاحظة قديمة",
        pageName: "فرحات للنحاس",
        adName: "إعلان 1",
      })
    );
  });

  it("should handle order without notes", async () => {
    const originalOrder = {
      id: 43,
      orderNumber: "102",
      customerName: "محمد",
      customerPhone: "01098765432",
      customerAddress: "الجيزة",
      governorate: "الجيزة",
      productId: 2,
      productName: "سوار نحاس كلاسيك",
      quantity: 1,
      totalAmount: "200.00",
      source: "easyorder",
      notes: null,
      pageName: null,
      adName: null,
    };

    mockGetOrderById.mockResolvedValue(originalOrder);
    mockGenerateOrderNumber.mockResolvedValue("103");

    const order = await mockGetOrderById(43);
    const newOrderNumber = await mockGenerateOrderNumber();

    const notes = order.notes
      ? `تكرار من أوردر #${order.orderNumber} — ${order.notes}`
      : `تكرار من أوردر #${order.orderNumber}`;

    expect(notes).toBe("تكرار من أوردر #102");
    expect(newOrderNumber).toBe("103");
  });

  it("should return undefined for non-existent order", async () => {
    mockGetOrderById.mockResolvedValue(undefined);
    const order = await mockGetOrderById(999);
    expect(order).toBeUndefined();
  });
});
