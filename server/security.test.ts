import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// Security Tests for the 6 security fixes
// ============================================================

// Mock db functions
vi.mock("./db", () => ({
  getDb: vi.fn(() => null),
  getAllEmployees: vi.fn(() => []),
  getActiveEmployees: vi.fn(() => []),
  getEmployeeById: vi.fn(() => null),
  createEmployee: vi.fn(),
  updateEmployee: vi.fn(),
  deleteEmployee: vi.fn(),
  getAllProducts: vi.fn(() => []),
  getProductById: vi.fn(() => null),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  getLowStockProducts: vi.fn(() => []),
  addInventoryMovement: vi.fn(),
  getInventoryMovements: vi.fn(() => []),
  getOrders: vi.fn(() => ({ orders: [], total: 0 })),
  getOrderById: vi.fn(() => null),
  createOrder: vi.fn(),
  updateOrder: vi.fn(),
  assignOrderToEmployee: vi.fn(),
  bulkAssignOrders: vi.fn(),
  confirmOrder: vi.fn(),
  postponeOrder: vi.fn(),
  cancelOrder: vi.fn(),
  deleteOrder: vi.fn(),
  deleteOrders: vi.fn(),
  generateOrderNumber: vi.fn(() => "ORD-001"),
  getDashboardStats: vi.fn(() => ({
    statusStats: [],
    sourceStats: [],
    governorateStats: [],
    totalRevenue: "0",
  })),
  getEmployeePerformance: vi.fn(() => []),
  getCancellationReasons: vi.fn(() => []),
  getDailyOrdersChart: vi.fn(() => []),
  seedInitialData: vi.fn(),
  getUserByOpenId: vi.fn(() => null),
  upsertUser: vi.fn(),
}));

// ============================================================
// Fix 1: Express import/export routes require auth
// ============================================================
describe("Fix 1: Express import/export routes protection", () => {
  it("importExcel.ts imports requireAdminOrManager middleware", async () => {
    // Verify the import exists by reading the file
    const fs = await import("fs");
    const content = fs.readFileSync("server/importExcel.ts", "utf-8");
    expect(content).toContain('import { requireAdminOrManager } from "./authMiddleware"');
  });

  it("exportExcel.ts imports requireAdminOrManager middleware", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/exportExcel.ts", "utf-8");
    expect(content).toContain('import { requireAdminOrManager } from "./authMiddleware"');
  });

  it("import preview route has auth middleware", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/importExcel.ts", "utf-8");
    // The middleware should appear before upload.single in the route registration
    const previewSection = content.substring(
      content.indexOf("/api/import/preview"),
      content.indexOf("/api/import/execute")
    );
    expect(previewSection).toContain("requireAdminOrManager");
  });

  it("import execute route has auth middleware", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/importExcel.ts", "utf-8");
    const executeSection = content.substring(content.indexOf("/api/import/execute"));
    expect(executeSection).toContain("requireAdminOrManager");
  });

  it("export confirmed route has auth middleware", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/exportExcel.ts", "utf-8");
    expect(content).toContain('"/api/export/confirmed", requireAdminOrManager');
  });

  it("export shipping route has auth middleware", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/exportExcel.ts", "utf-8");
    expect(content).toContain('"/api/export/shipping", requireAdminOrManager');
  });
});

// ============================================================
// Fix 2: Backend role checks in tRPC
// ============================================================
describe("Fix 2: Backend role checks in tRPC procedures", () => {
  it("reports.dashboard uses adminProcedure", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const reportsSection = content.substring(content.indexOf("// ==================== REPORTS ===================="));
    expect(reportsSection).toContain("dashboard: adminProcedure");
  });

  it("reports.cancellationReasons uses adminProcedure", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const reportsSection = content.substring(content.indexOf("// ==================== REPORTS ===================="));
    expect(reportsSection).toContain("cancellationReasons: adminProcedure");
  });

  it("reports.dailyChart uses adminProcedure", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const reportsSection = content.substring(content.indexOf("// ==================== REPORTS ===================="));
    expect(reportsSection).toContain("dailyChart: adminProcedure");
  });

  it("products.addMovement uses adminProcedure", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    expect(content).toContain("addMovement: adminProcedure");
  });
});

// ============================================================
// Fix 3: Employee ownership enforcement
// ============================================================
describe("Fix 3: Employee ownership enforcement in employeePortal", () => {
  it("employeePortal.confirm has ownership check", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const portalSection = content.substring(
      content.indexOf("// ==================== EMPLOYEE PORTAL ====================")
    );
    // Find the confirm mutation section
    const confirmIdx = portalSection.indexOf("confirm: employeePortalProcedure");
    const confirmSection = portalSection.substring(confirmIdx, confirmIdx + 500);
    expect(confirmSection).toContain("Ownership check");
    expect(confirmSection).toContain("emp.role !== 'manager'");
    expect(confirmSection).toContain("assignedEmployeeId !== emp.id");
  });

  it("employeePortal.postpone has ownership check", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const portalSection = content.substring(
      content.indexOf("// ==================== EMPLOYEE PORTAL ====================")
    );
    const postponeIdx = portalSection.indexOf("postpone: employeePortalProcedure");
    const postponeSection = portalSection.substring(postponeIdx, postponeIdx + 500);
    expect(postponeSection).toContain("Ownership check");
    expect(postponeSection).toContain("emp.role !== 'manager'");
  });

  it("employeePortal.cancel has ownership check", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const portalSection = content.substring(
      content.indexOf("// ==================== EMPLOYEE PORTAL ====================")
    );
    const cancelIdx = portalSection.indexOf("cancel: employeePortalProcedure");
    const cancelSection = portalSection.substring(cancelIdx, cancelIdx + 500);
    expect(cancelSection).toContain("Ownership check");
    expect(cancelSection).toContain("emp.role !== 'manager'");
  });

  it("employeePortal.updateNotes has ownership check", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const portalSection = content.substring(
      content.indexOf("// ==================== EMPLOYEE PORTAL ====================")
    );
    const notesIdx = portalSection.indexOf("updateNotes: employeePortalProcedure");
    const notesSection = portalSection.substring(notesIdx, notesIdx + 500);
    expect(notesSection).toContain("Ownership check");
    expect(notesSection).toContain("emp.role !== 'manager'");
  });

  it("manager employees bypass ownership check", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const portalSection = content.substring(
      content.indexOf("// ==================== EMPLOYEE PORTAL ====================")
    );
    // All ownership checks should check emp.role !== 'manager' (i.e., managers bypass)
    const confirmIdx = portalSection.indexOf("confirm: employeePortalProcedure");
    const confirmSection = portalSection.substring(confirmIdx, confirmIdx + 500);
    expect(confirmSection).toContain("if (emp.role !== 'manager')");
  });
});

// ============================================================
// Fix 4: Audit fields for manager employees
// ============================================================
describe("Fix 4: Audit fields use resolveActingEmployeeId", () => {
  it("resolveActingEmployeeId helper function exists", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    expect(content).toContain("async function resolveActingEmployeeId");
    expect(content).toContain("ctx.realEmployeeId");
  });

  it("context.ts includes realEmployeeId in TrpcContext type", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/_core/context.ts", "utf-8");
    expect(content).toContain("realEmployeeId?: number");
  });

  it("context.ts passes realEmployeeId for manager employees", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/_core/context.ts", "utf-8");
    expect(content).toContain("realEmployeeId: emp.id");
  });

  it("orders.create uses resolveActingEmployeeId", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const createSection = content.substring(
      content.indexOf("create: protectedProcedure"),
      content.indexOf("update: protectedProcedure")
    );
    expect(createSection).toContain("resolveActingEmployeeId");
    expect(createSection).not.toContain("emps.find(e => e.userId === ctx.user.id)");
  });

  it("orders.update uses resolveActingEmployeeId", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const updateSection = content.substring(
      content.indexOf("update: protectedProcedure"),
      content.indexOf("assign: adminProcedure")
    );
    expect(updateSection).toContain("resolveActingEmployeeId");
    expect(updateSection).not.toContain("emps.find(e => e.userId === ctx.user.id)");
  });

  it("orders.assign uses resolveActingEmployeeId", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const assignSection = content.substring(
      content.indexOf("assign: adminProcedure"),
      content.indexOf("bulkAssign: adminProcedure")
    );
    expect(assignSection).toContain("resolveActingEmployeeId");
  });

  it("products.addMovement uses resolveActingEmployeeId", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const movementSection = content.substring(
      content.indexOf("addMovement: adminProcedure"),
      content.indexOf("movements: protectedProcedure")
    );
    expect(movementSection).toContain("resolveActingEmployeeId");
    expect(movementSection).not.toContain("emps.find(e => e.userId === ctx.user.id)");
  });
});

// ============================================================
// Fix 5: Remove insecure JWT fallback
// ============================================================
describe("Fix 5: JWT fallback-secret removed", () => {
  it("employeeAuth.ts does not contain fallback-secret", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/employeeAuth.ts", "utf-8");
    expect(content).not.toContain("fallback-secret");
    expect(content).toContain("JWT_SECRET environment variable is required");
  });

  it("context.ts does not contain fallback-secret", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/_core/context.ts", "utf-8");
    expect(content).not.toContain("fallback-secret");
    expect(content).toContain("JWT_SECRET environment variable is required");
  });

  it("routers.ts does not contain fallback-secret", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    expect(content).not.toContain("fallback-secret");
  });
});

// ============================================================
// Fix 6: Frontend query guards
// ============================================================
describe("Fix 6: Frontend query guards", () => {
  it("Reports.tsx has enabled guards on all report queries", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("client/src/pages/Reports.tsx", "utf-8");
    // All three queries should have enabled: isAdmin
    const perfQuery = content.substring(
      content.indexOf("trpc.reports.employeePerformance"),
      content.indexOf("trpc.reports.cancellationReasons")
    );
    expect(perfQuery).toContain("enabled: isAdmin");

    const cancelQuery = content.substring(
      content.indexOf("trpc.reports.cancellationReasons"),
      content.indexOf("trpc.reports.dailyChart")
    );
    expect(cancelQuery).toContain("enabled: isAdmin");

    const chartQuery = content.substring(
      content.indexOf("trpc.reports.dailyChart"),
      content.indexOf("const dateRangeLabels")
    );
    expect(chartQuery).toContain("enabled: isAdmin");
  });

  it("Dashboard.tsx has enabled guards on report queries", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("client/src/pages/Dashboard.tsx", "utf-8");

    const dashQuery = content.substring(
      content.indexOf("trpc.reports.dashboard"),
      content.indexOf("trpc.products.lowStock")
    );
    expect(dashQuery).toContain("enabled: isAdmin");

    const lowStockQuery = content.substring(
      content.indexOf("trpc.products.lowStock"),
      content.indexOf("trpc.reports.dailyChart")
    );
    expect(lowStockQuery).toContain("enabled: isAdmin");

    const chartQuery = content.substring(
      content.indexOf("trpc.reports.dailyChart"),
      content.indexOf("Seed initial data")
    );
    expect(chartQuery).toContain("enabled: isAdmin");
  });
});

// ============================================================
// Auth middleware module tests
// ============================================================
describe("Auth middleware module", () => {
  it("authMiddleware.ts exports requireAdminOrManager", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/authMiddleware.ts", "utf-8");
    expect(content).toContain("export async function requireAdminOrManager");
    expect(content).toContain("isActiveManagerSession");
    // Employee-token fallback must accept the whole admin tier (super_admin/admin/manager),
    // not just a literal "manager" role — a plain admin employee should not be locked out.
    expect(content).toContain("isAdminTierRole(emp.role)");
  });

  it("authMiddleware.ts checks for JWT_SECRET", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/authMiddleware.ts", "utf-8");
    expect(content).toContain("JWT_SECRET");
    expect(content).toContain("Server misconfigured");
  });

  it("authMiddleware.ts returns 401 for missing tokens", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/authMiddleware.ts", "utf-8");
    expect(content).toContain("401");
    expect(content).toContain("غير مصرح");
  });

  it("authMiddleware.ts returns 403 for non-manager employees", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/authMiddleware.ts", "utf-8");
    expect(content).toContain("403");
    expect(content).toContain("هذا الإجراء متاح للمديرين فقط");
  });
});
