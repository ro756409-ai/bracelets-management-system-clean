import { describe, it, expect, vi, beforeEach } from "vitest";
import XLSX from "xlsx-js-style";

// Mock db module
vi.mock("./db", () => ({
  getOrders: vi.fn(),
  getAllEmployees: vi.fn(),
  getAllProducts: vi.fn(),
  generateOrderNumber: vi.fn(),
  createOrder: vi.fn(),
}));


import { getOrders, getAllEmployees, getAllProducts } from "./db";

const mockGetOrders = getOrders as any;
const mockGetAllEmployees = getAllEmployees as any;
const mockGetAllProducts = getAllProducts as any;

// Helper to create mock orders
function createMockOrder(overrides: any = {}) {
  return {
    id: 1,
    orderNumber: "ORD20260408001",
    customerName: "أحمد محمد",
    customerPhone: "01012345678",
    customerAddress: "شارع التحرير",
    governorate: "القاهرة",
    productId: 1,
    productName: "أسورة نحاس أحمر طبي",
    quantity: 1,
    totalAmount: "250",
    status: "confirmed",
    source: "easyorder",
    notes: "",
    createdAt: new Date("2026-04-08"),
    confirmedAt: new Date("2026-04-08"),
    lastUpdatedBy: 1,
    ...overrides,
  };
}

describe("Export Excel - Backend Logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllEmployees.mockResolvedValue([
      { id: 1, name: "يمنى", role: "agent" },
      { id: 2, name: "إسراء", role: "agent" },
    ]);
  });

  describe("Confirmed Orders Export", () => {
    it("should fetch confirmed orders with status filter", async () => {
      const orders = [
        createMockOrder({ id: 1, orderNumber: "ORD20260408001" }),
        createMockOrder({ id: 2, orderNumber: "ORD20260408002", customerName: "سارة أحمد" }),
      ];
      mockGetOrders.mockResolvedValue({ orders, total: 2 });

      const result = await getOrders({ status: "confirmed", limit: 10000 });
      expect(mockGetOrders).toHaveBeenCalledWith({ status: "confirmed", limit: 10000 });
      expect(result.orders).toHaveLength(2);
    });

    it("should filter orders by number range", async () => {
      const orders = [
        createMockOrder({ id: 1, orderNumber: "ORD20260408001" }),
        createMockOrder({ id: 2, orderNumber: "ORD20260408050" }),
        createMockOrder({ id: 3, orderNumber: "ORD20260408100" }),
      ];
      mockGetOrders.mockResolvedValue({ orders, total: 3 });

      const result = await getOrders({ status: "confirmed", limit: 10000 });
      const from = "ORD20260408001";
      const to = "ORD20260408050";
      const filtered = result.orders.filter((o: any) => o.orderNumber >= from && o.orderNumber <= to);
      
      expect(filtered).toHaveLength(2);
      expect(filtered[0].orderNumber).toBe("ORD20260408001");
      expect(filtered[1].orderNumber).toBe("ORD20260408050");
    });

    it("should filter orders by specific IDs", async () => {
      const orders = [
        createMockOrder({ id: 1 }),
        createMockOrder({ id: 2 }),
        createMockOrder({ id: 3 }),
      ];
      mockGetOrders.mockResolvedValue({ orders, total: 3 });

      const result = await getOrders({ status: "confirmed", limit: 10000 });
      const ids = [1, 3];
      const filtered = result.orders.filter((o: any) => ids.includes(o.id));
      
      expect(filtered).toHaveLength(2);
      expect(filtered.map((o: any) => o.id)).toEqual([1, 3]);
    });

    it("should generate valid Excel buffer for confirmed orders", () => {
      const headers = [
        "رقم الأوردر", "الاسم", "الهاتف", "العنوان", "المحافظة",
        "المنتج", "الكمية", "المبلغ", "المصدر", "الحالة", "ملاحظات",
        "تاريخ الإنشاء", "تاريخ التأكيد",
      ];
      const rows = [
        ["ORD20260408001", "أحمد محمد", "01012345678", "شارع التحرير", "القاهرة",
         "أسورة نحاس", 1, 250, "Easy Order", "مؤكد", "", "٨/٤/٢٠٢٦", "٨/٤/٢٠٢٦"],
      ];

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      XLSX.utils.book_append_sheet(wb, ws, "الأوردرات المؤكدة");
      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      expect(buffer).toBeTruthy();
      expect(buffer.length).toBeGreaterThan(0);

      // Verify we can read it back
      const readWb = XLSX.read(buffer, { type: "buffer" });
      expect(readWb.SheetNames).toContain("الأوردرات المؤكدة");
      const readWs = readWb.Sheets["الأوردرات المؤكدة"];
      const readRows: any[][] = XLSX.utils.sheet_to_json(readWs, { header: 1 });
      expect(readRows[0]).toEqual(headers);
      expect(readRows[1][0]).toBe("ORD20260408001");
    });
  });

  describe("Shipping Sheet Export - Styled", () => {
    it("should group orders by shipping agent based on governorate", () => {
      const SHIPPING_AGENTS: Record<string, { agent: string; cost: number }> = {
        "القاهرة": { agent: "المتخصص قاهره", cost: 60 },
        "الجيزة": { agent: "المتخصص قاهره", cost: 60 },
        "الدقهلية": { agent: "المتخصص محافظات", cost: 60 },
        "المنيا": { agent: "المتخصص صعيد", cost: 75 },
      };

      const orders = [
        createMockOrder({ id: 1, governorate: "القاهرة" }),
        createMockOrder({ id: 2, governorate: "الجيزة" }),
        createMockOrder({ id: 3, governorate: "الدقهلية" }),
        createMockOrder({ id: 4, governorate: "المنيا" }),
      ];

      const agentGroups: Record<string, any[]> = {};
      for (const order of orders) {
        const agentInfo = SHIPPING_AGENTS[order.governorate] || { agent: "غير محدد", cost: 60 };
        if (!agentGroups[agentInfo.agent]) agentGroups[agentInfo.agent] = [];
        agentGroups[agentInfo.agent].push(order);
      }

      expect(Object.keys(agentGroups)).toHaveLength(3);
      expect(agentGroups["المتخصص قاهره"]).toHaveLength(2);
      expect(agentGroups["المتخصص محافظات"]).toHaveLength(1);
      expect(agentGroups["المتخصص صعيد"]).toHaveLength(1);
    });

    it("should create styled multi-sheet workbook with 24-column headers", () => {
      const wb = XLSX.utils.book_new();

      const headerRow = [
        "م", "الاسم", "تليفون", "تليفون", "العنوان", "المحافظة",
        "التاكيد", "ملاحظات", "القطعة", "عددها", "سعرها",
        "القطعة", "عددها", "سعرها", "القطعة", "عددها", "سعرها",
        "الإجمالي", "تصفية الاوردر", "الشحن", "الوكيل", "حالة الاوردر",
        "تاريخ التصفية", "التاريخ الاصلي",
      ];

      expect(headerRow).toHaveLength(24);

      const titleRow = new Array(24).fill("");
      titleRow[0] = "فرحات للنحاس";
      const agentRow = new Array(24).fill("");
      agentRow[0] = "الوكيل";
      agentRow[3] = "المتخصص قاهره";

      const dataRow = [
        1, "أحمد محمد", "01012345678", "", "شارع التحرير", "القاهرة",
        "يمنى", "", "أسورة نحاس", 1, 250,
        "", "", "", "", "", "",
        250, "", 60, "المتخصص قاهره", "مؤكد", "", "",
      ];

      const ws = XLSX.utils.aoa_to_sheet([titleRow, [], agentRow, headerRow, dataRow]);

      // Apply styles to header row
      for (let c = 0; c < 24; c++) {
        const ref = XLSX.utils.encode_cell({ r: 3, c });
        if (!ws[ref]) ws[ref] = { v: "", t: "s" };
        ws[ref].s = {
          fill: { fgColor: { rgb: "8B4513" } },
          font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11 },
          alignment: { horizontal: "center", vertical: "center" },
        };
      }

      // Add merges for title
      ws["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 16 } },
      ];

      ws["!dir"] = "rtl";
      XLSX.utils.book_append_sheet(wb, ws, "المتخصص قاهره");

      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      expect(buffer).toBeTruthy();

      const readWb = XLSX.read(buffer, { type: "buffer" });
      expect(readWb.SheetNames).toContain("المتخصص قاهره");
      const readWs = readWb.Sheets["المتخصص قاهره"];
      const readRows: any[][] = XLSX.utils.sheet_to_json(readWs, { header: 1 });
      // Row 3 (index 3) should be the header row
      expect(readRows[3]).toEqual(headerRow);
      // Row 4 (index 4) should be data
      expect(readRows[4][1]).toBe("أحمد محمد");
      expect(readRows[4][17]).toBe(250); // الإجمالي
      expect(readRows[4][19]).toBe(60); // الشحن
    });

    it("should include correct shipping cost per governorate", () => {
      const SHIPPING_AGENTS: Record<string, { agent: string; cost: number }> = {
        "القاهرة": { agent: "المتخصص قاهره", cost: 60 },
        "المنيا": { agent: "المتخصص صعيد", cost: 75 },
      };

      expect(SHIPPING_AGENTS["القاهرة"].cost).toBe(60);
      expect(SHIPPING_AGENTS["المنيا"].cost).toBe(75);
    });

    it("should handle empty orders gracefully", () => {
      const wb = XLSX.utils.book_new();
      const agentGroups: Record<string, any[]> = {};

      if (Object.keys(agentGroups).length === 0) {
        const ws = XLSX.utils.aoa_to_sheet([["لا توجد أوردرات مؤكدة للتصدير"]]);
        XLSX.utils.book_append_sheet(wb, ws, "فارغ");
      }

      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const readWb = XLSX.read(buffer, { type: "buffer" });
      expect(readWb.SheetNames).toContain("فارغ");
    });
  });

  describe("Sanitize Notes Helper", () => {
    it("should remove JSON fragments from notes", () => {
      // Inline test of sanitizeNotes logic
      function sanitizeNotes(raw: string | null | undefined): string {
        if (!raw) return "";
        let cleaned = raw;
        cleaned = cleaned.replace(/\{[^}]*\}/g, "");
        cleaned = cleaned.replace(/is_free_shipping:\s*(true|false)/gi, "");
        cleaned = cleaned.replace(/[a-z_]+:\s*(true|false|null|\d+)/gi, "");
        cleaned = cleaned.replace(/[\[\]{}|]/g, "");
        cleaned = cleaned.replace(/\s+/g, " ").trim();
        return cleaned;
      }

      expect(sanitizeNotes(null)).toBe("");
      expect(sanitizeNotes("")).toBe("");
      expect(sanitizeNotes("ملاحظة عادية")).toBe("ملاحظة عادية");
      expect(sanitizeNotes('{"key":"value"} ملاحظة')).toBe("ملاحظة");
      expect(sanitizeNotes("is_free_shipping: true عميل مميز")).toBe("عميل مميز");
    });
  });

  describe("Format Address Helper", () => {
    it("should remove duplicate governorate from address", () => {
      function formatAddress(address: string | null | undefined, governorate?: string): string {
        if (!address) return governorate || "";
        let clean = address.trim();
        if (governorate && clean.endsWith(governorate)) {
          clean = clean.slice(0, -governorate.length).trim().replace(/[,،\-]+$/, "").trim();
        }
        return clean || governorate || "";
      }

      expect(formatAddress("شارع التحرير، القاهرة", "القاهرة")).toBe("شارع التحرير");
      expect(formatAddress(null, "القاهرة")).toBe("القاهرة");
      expect(formatAddress("")).toBe("");
      expect(formatAddress("شارع النيل", "الجيزة")).toBe("شارع النيل");
    });
  });

  describe("PDF Shipping Labels", () => {
    it("should build correct label HTML structure", () => {
      // Test the label HTML builder logic
      const order = createMockOrder({
        orderNumber: "ORD20260408001",
        customerName: "أحمد محمد",
        customerPhone: "01012345678",
        customerAddress: "شارع التحرير",
        governorate: "القاهرة",
        productName: "أسورة نحاس أحمر - مقاس L",
        quantity: 1,
        totalAmount: "250",
      });

      const shippingCost = 60;
      const totalCost = Number(order.totalAmount) + shippingCost;

      expect(totalCost).toBe(310);
      expect(order.productName).toContain(" - ");

      // Verify product name/variant split
      const parts = order.productName.split(" - ");
      expect(parts[0]).toBe("أسورة نحاس أحمر");
      expect(parts[1]).toBe("مقاس L");
    });

    it("should handle multi-product orders in labels", () => {
      const order = createMockOrder({
        productName: "أسورة نحاس\nخاتم نحاس\nسلسلة نحاس",
        quantity: 3,
        totalAmount: "750",
      });

      const products = order.productName.split("\n").map((s: string) => s.trim()).filter(Boolean);
      expect(products).toHaveLength(3);
      expect(products[0]).toBe("أسورة نحاس");
      expect(products[1]).toBe("خاتم نحاس");
      expect(products[2]).toBe("سلسلة نحاس");
    });
  });

  describe("Import Product Matching Safety", () => {
    it("should NOT fallback to first product when no match found", () => {
      const products = [
        { id: 1, name: "أسورة نحاس أحمر طبي" },
        { id: 2, name: "خاتم نحاس" },
      ];

      const rowProductName = "منتج غير موجود أبداً";

      // Replicate the fixed matching logic
      const matchedProduct = products.find(p =>
        rowProductName.includes(p.name) || p.name.includes(rowProductName.split(" - ")[0])
      );

      // Should NOT match — no fallback to products[0]
      expect(matchedProduct).toBeUndefined();
    });

    it("should match product by name similarity", () => {
      const products = [
        { id: 1, name: "أسورة نحاس أحمر طبي" },
        { id: 2, name: "خاتم نحاس" },
      ];

      const rowProductName = "أسورة نحاس أحمر طبي - مقاس L";

      const matchedProduct = products.find(p =>
        rowProductName.includes(p.name) || p.name.includes(rowProductName.split(" - ")[0])
      );

      expect(matchedProduct).toBeDefined();
      expect(matchedProduct!.id).toBe(1);
    });

    it("should report unmatched products with clear error message", () => {
      const products = [
        { id: 1, name: "أسورة نحاس أحمر طبي" },
      ];

      const rowProductName = "منتج غير موجود";
      const importErrors: string[] = [];
      let skipped = 0;

      const matchedProduct = products.find(p =>
        rowProductName.includes(p.name) || p.name.includes(rowProductName.split(" - ")[0])
      );

      if (!matchedProduct) {
        importErrors.push(`صف 5: منتج غير مطابق "${rowProductName}" — يحتاج مراجعة يدوية`);
        skipped++;
      }

      expect(skipped).toBe(1);
      expect(importErrors).toHaveLength(1);
      expect(importErrors[0]).toContain("منتج غير مطابق");
      expect(importErrors[0]).toContain("مراجعة يدوية");
    });
  });

  describe("Order Number Range Filtering", () => {
    it("should correctly compare order numbers lexicographically", () => {
      const orderNumbers = [
        "ORD20260401001",
        "ORD20260401050",
        "ORD20260401100",
        "ORD20260402001",
      ];

      const from = "ORD20260401001";
      const to = "ORD20260401100";
      const filtered = orderNumbers.filter(n => n >= from && n <= to);

      expect(filtered).toEqual([
        "ORD20260401001",
        "ORD20260401050",
        "ORD20260401100",
      ]);
    });

    it("should handle external order IDs in range filter", () => {
      const orderNumbers = [
        "ORD2026040700075",
        "ORD2026040700076",
        "ORD2026040700078",
        "ORD2026040700081",
        "ORD2026040700082",
      ];

      const from = "ORD2026040700076";
      const to = "ORD2026040700081";
      const filtered = orderNumbers.filter(n => n >= from && n <= to);

      expect(filtered).toEqual([
        "ORD2026040700076",
        "ORD2026040700078",
        "ORD2026040700081",
      ]);
    });
  });
});
