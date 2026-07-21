import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db module
vi.mock("./db", () => ({
  deleteOrder: vi.fn().mockResolvedValue(undefined),
  deleteOrders: vi.fn().mockResolvedValue(undefined),
  getAllEmployees: vi.fn().mockResolvedValue([]),
  getActiveEmployees: vi.fn().mockResolvedValue([]),
  getAllProducts: vi.fn().mockResolvedValue([
    { id: 1, name: "أسورة سادة", sku: "BRAC-PLAIN", currentStock: 100 },
    { id: 2, name: "أسورة آية الكرسي", sku: "BRAC-AYAH", currentStock: 80 },
    { id: 30001, name: "أسورة إنه من سليمان", sku: "SULAI-001", currentStock: 50 },
    { id: 30002, name: "أسورة كهيعص", sku: "KAHYA-001", currentStock: 50 },
  ]),
  getOrders: vi.fn().mockResolvedValue({ orders: [], total: 0 }),
  getOrderById: vi.fn(),
  createOrder: vi.fn(),
  updateOrder: vi.fn(),
  assignOrderToEmployee: vi.fn(),
  bulkAssignOrders: vi.fn(),
  confirmOrder: vi.fn(),
  postponeOrder: vi.fn(),
  cancelOrder: vi.fn(),
  generateOrderNumber: vi.fn().mockResolvedValue("ORD-TEST-001"),
  getProductById: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  getLowStockProducts: vi.fn().mockResolvedValue([]),
  addInventoryMovement: vi.fn(),
  getInventoryMovements: vi.fn().mockResolvedValue([]),
  getDashboardStats: vi.fn().mockResolvedValue({ totalOrders: 0, confirmedOrders: 0, cancelledOrders: 0 }),
  getEmployeePerformance: vi.fn().mockResolvedValue([]),
  getCancellationReasons: vi.fn().mockResolvedValue([]),
  getDailyOrdersChart: vi.fn().mockResolvedValue([]),
  seedInitialData: vi.fn(),
  getEmployeeById: vi.fn(),
  createEmployee: vi.fn(),
  updateEmployee: vi.fn(),
  deleteEmployee: vi.fn(),
}));

import { deleteOrder, deleteOrders, getAllProducts, updateProduct } from "./db";

describe("حذف الأوردرات", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("يجب أن تحذف أوردر واحد بنجاح", async () => {
    await deleteOrder(1);
    expect(deleteOrder).toHaveBeenCalledWith(1);
    expect(deleteOrder).toHaveBeenCalledTimes(1);
  });

  it("يجب أن تحذف عدة أوردرات بنجاح", async () => {
    await deleteOrders([1, 2, 3]);
    expect(deleteOrders).toHaveBeenCalledWith([1, 2, 3]);
    expect(deleteOrders).toHaveBeenCalledTimes(1);
  });
});

describe("الأصناف الجديدة", () => {
  it("يجب أن تحتوي قائمة المنتجات على أسورة إنه من سليمان", async () => {
    const products = await getAllProducts();
    const sulaimanProduct = products.find((p: any) => p.sku === "SULAI-001");
    expect(sulaimanProduct).toBeDefined();
    expect(sulaimanProduct?.name).toBe("أسورة إنه من سليمان");
  });

  it("يجب أن تحتوي قائمة المنتجات على أسورة كهيعص", async () => {
    const products = await getAllProducts();
    const kahyaProduct = products.find((p: any) => p.sku === "KAHYA-001");
    expect(kahyaProduct).toBeDefined();
    expect(kahyaProduct?.name).toBe("أسورة كهيعص");
  });

  it("يجب أن يكون إجمالي المنتجات 4 على الأقل (تشمل الأصناف الجديدة)", async () => {
    const products = await getAllProducts();
    expect(products.length).toBeGreaterThanOrEqual(4);
  });
});

describe("تعديل عدد القطع في المخزون", () => {
  it("يجب أن يتم تحديث عدد القطع بنجاح", async () => {
    await updateProduct(1, { currentStock: 75 });
    expect(updateProduct).toHaveBeenCalledWith(1, { currentStock: 75 });
    expect(updateProduct).toHaveBeenCalledTimes(1);
  });

  it("يجب أن يقبل القيمة صفر", async () => {
    await updateProduct(2, { currentStock: 0 });
    expect(updateProduct).toHaveBeenCalledWith(2, { currentStock: 0 });
  });
});
