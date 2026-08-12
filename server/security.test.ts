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
    expect(content).toMatch(
      /import \{ requireAdminOrManager[^}]*\} from "\.\/authMiddleware"/
    );
  });

  it("exportExcel.ts imports requireAdminOrManager middleware", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/exportExcel.ts", "utf-8");
    expect(content).toContain(
      'import { requireAdminOrManager } from "./authMiddleware"'
    );
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
    const executeSection = content.substring(
      content.indexOf("/api/import/execute")
    );
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
  it("reports.dashboard is permission-gated, not merely admin-gated", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    // Bounded to the reports router. The old version sliced from the REPORTS marker to the
    // end of the file, so it was matching `accounting.dashboard` — a different router
    // several thousand lines further down — and passed while reports.dashboard was
    // something else entirely.
    const start = content.indexOf("// ==================== REPORTS ====================");
    const reportsSection = content.slice(start, content.indexOf("\n  broadcast: router(", start));
    expect(reportsSection).toContain("dashboard: permissionProcedure('accounting.view')");
    expect(reportsSection).not.toContain("dashboard: adminProcedure");
  });

  it("accounting.dashboard is behind the profit permission", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    // Was adminProcedure: every admin-tier account could read margins whether or not the
    // owner intended it. Seeing profit is a separate decision from being an administrator.
    const start = content.indexOf("\n  accounting: router({");
    const section = content.slice(start, start + 2000);
    expect(section).toContain("dashboard: permissionProcedure('reports.view_profit')");
  });

  it("reports.cancellationReasons uses adminProcedure", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    const reportsSection = content.substring(
      content.indexOf("// ==================== REPORTS ====================")
    );
    expect(reportsSection).toContain("cancellationReasons: adminProcedure");
  });

  it("reports.dailyChart uses adminProcedure", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    const reportsSection = content.substring(
      content.indexOf("// ==================== REPORTS ====================")
    );
    expect(reportsSection).toContain("dailyChart: adminProcedure");
  });

  it("products.addMovement uses adminProcedure", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    expect(content).toContain("addMovement: adminProcedure");
  });
});

// ============================================================
// Fix 3: Employee ownership enforcement
// ============================================================
describe("Fix 3: Employee ownership enforcement in employeePortal", () => {
  it("employeePortal.confirm has ownership check", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    const portalSection = content.substring(
      content.indexOf(
        "// ==================== EMPLOYEE PORTAL ===================="
      )
    );
    // Find the confirm mutation section
    const confirmIdx = portalSection.indexOf(
      "confirm: requireEmployeePermission"
    );
    const confirmSection = portalSection.substring(
      confirmIdx,
      confirmIdx + 500
    );
    expect(confirmSection).toContain("Ownership check");
    expect(confirmSection).toContain("assertEmployeeOwnsOrder(emp, input.orderId");
  });

  it("employeePortal.postpone has ownership check", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    const portalSection = content.substring(
      content.indexOf(
        "// ==================== EMPLOYEE PORTAL ===================="
      )
    );
    const postponeIdx = portalSection.indexOf(
      "postpone: requireEmployeePermission"
    );
    const postponeSection = portalSection.substring(
      postponeIdx,
      postponeIdx + 500
    );
    expect(postponeSection).toContain("assertEmployeeOwnsOrder(emp, input.orderId");
  });

  it("employeePortal.cancel has ownership check", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    const portalSection = content.substring(
      content.indexOf(
        "// ==================== EMPLOYEE PORTAL ===================="
      )
    );
    const cancelIdx = portalSection.indexOf(
      "cancel: requireEmployeePermission"
    );
    const cancelSection = portalSection.substring(cancelIdx, cancelIdx + 500);
    expect(cancelSection).toContain("assertEmployeeOwnsOrder(emp, input.orderId");
  });

  it("employeePortal.updateNotes has ownership check", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    const portalSection = content.substring(
      content.indexOf(
        "// ==================== EMPLOYEE PORTAL ===================="
      )
    );
    const notesIdx = portalSection.indexOf(
      "updateNotes: requireEmployeePermission"
    );
    const notesSection = portalSection.substring(notesIdx, notesIdx + 500);
    expect(notesSection).toContain("assertEmployeeOwnsOrder(emp, input.orderId");
  });

  it("manager employees bypass ownership check", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    const portalSection = content.substring(
      content.indexOf(
        "// ==================== EMPLOYEE PORTAL ===================="
      )
    );
    // The bypass moved into assertEmployeeOwnsOrder and became tier-based. It used to
    // compare against the literal role 'manager', which wrongly denied an admin or
    // super_admin employee — both senior to a manager — access to the orders they supervise.
    expect(portalSection).toContain("assertEmployeeOwnsOrder(emp, input.orderId");
    expect(content).toContain(
      "if (!isAdminTierRole(emp.role) && order.assignedEmployeeId !== emp.id)"
    );
    expect(portalSection).not.toContain("if (emp.role !== 'manager') {");
  });

  it("employeePortal write actions require a role permission, not just an active session", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    const portalSection = content.substring(
      content.indexOf(
        "// ==================== EMPLOYEE PORTAL ===================="
      )
    );
    for (const [proc, perm] of [
      ["confirm", "orders.confirm"],
      ["postpone", "orders.update"],
      ["cancel", "orders.cancel"],
      ["markNoAnswer", "orders.update"],
      ["updateNotes", "orders.update"],
      ["updateCustomerInfo", "orders.update"],
      ["editOrder", "orders.update"],
    ] as const) {
      expect(portalSection).toContain(
        `${proc}: requireEmployeePermission('${perm}')`
      );
    }
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
    expect(createSection).not.toContain(
      "emps.find(e => e.userId === ctx.user.id)"
    );
  });

  it("orders.update uses resolveActingEmployeeId", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const updateSection = content.substring(
      content.indexOf("update: protectedProcedure"),
      content.indexOf("assign: adminProcedure")
    );
    expect(updateSection).toContain("resolveActingEmployeeId");
    expect(updateSection).not.toContain(
      "emps.find(e => e.userId === ctx.user.id)"
    );
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
    expect(movementSection).not.toContain(
      "emps.find(e => e.userId === ctx.user.id)"
    );
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
    // بيحلّ الجلسة النشطة (owner cookie ثم employee_token) عبر resolveActiveManager.
    expect(content).toContain("resolveActiveManager");
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

// ============================================================
// Fix 3: employeePortal role → permission enforcement
// (requireEmployeePermission wired onto orders.confirm/update/cancel/etc.)
// ============================================================
describe("Fix 3: employeePortal permission matrix (hasPermission)", () => {
  it("admin-tier roles (super_admin, admin, manager) can do everything, unchanged", async () => {
    const { hasPermission, ALL_PERMISSIONS } = await import("./permissions");
    for (const role of ["super_admin", "admin", "manager"] as const) {
      for (const permission of ALL_PERMISSIONS) {
        expect(hasPermission(role, permission)).toBe(true);
      }
    }
  });

  it("order_confirmation employees can view, confirm, cancel and update orders", async () => {
    const { hasPermission } = await import("./permissions");
    expect(hasPermission("order_confirmation", "orders.view")).toBe(true);
    expect(hasPermission("order_confirmation", "orders.confirm")).toBe(true);
    expect(hasPermission("order_confirmation", "orders.cancel")).toBe(true);
    expect(hasPermission("order_confirmation", "orders.update")).toBe(true);
    expect(hasPermission("order_confirmation", "dashboard.view")).toBe(true);
  });

  it("order_confirmation employees must NOT gain settings, employees, or audit access", async () => {
    const { hasPermission } = await import("./permissions");
    expect(hasPermission("order_confirmation", "settings.view")).toBe(false);
    expect(hasPermission("order_confirmation", "settings.manage")).toBe(false);
    expect(hasPermission("order_confirmation", "employees.view")).toBe(false);
    expect(hasPermission("order_confirmation", "employees.manage")).toBe(false);
    expect(hasPermission("order_confirmation", "audit.view")).toBe(false);
    expect(hasPermission("order_confirmation", "orders.export")).toBe(false);
    expect(hasPermission("order_confirmation", "orders.import")).toBe(false);
  });

  it("agent role matches order_confirmation's confirm/cancel/update access", async () => {
    const { hasPermission } = await import("./permissions");
    expect(hasPermission("agent", "orders.confirm")).toBe(true);
    expect(hasPermission("agent", "orders.cancel")).toBe(true);
    expect(hasPermission("agent", "orders.update")).toBe(true);
    expect(hasPermission("agent", "settings.manage")).toBe(false);
    expect(hasPermission("agent", "employees.manage")).toBe(false);
  });

  it("accountant can view/export orders and view settings/audit, but cannot confirm/cancel orders or manage anything", async () => {
    const { hasPermission } = await import("./permissions");
    expect(hasPermission("accountant", "orders.view")).toBe(true);
    expect(hasPermission("accountant", "orders.export")).toBe(true);
    expect(hasPermission("accountant", "settings.view")).toBe(true);
    expect(hasPermission("accountant", "audit.view")).toBe(true);
    expect(hasPermission("accountant", "orders.confirm")).toBe(false);
    expect(hasPermission("accountant", "orders.cancel")).toBe(false);
    expect(hasPermission("accountant", "orders.update")).toBe(false);
    expect(hasPermission("accountant", "settings.manage")).toBe(false);
    expect(hasPermission("accountant", "employees.manage")).toBe(false);
  });

  it("warehouse can view dashboard/orders only — no confirm/cancel/update/settings", async () => {
    const { hasPermission } = await import("./permissions");
    expect(hasPermission("warehouse", "dashboard.view")).toBe(true);
    expect(hasPermission("warehouse", "orders.view")).toBe(true);
    expect(hasPermission("warehouse", "orders.confirm")).toBe(false);
    expect(hasPermission("warehouse", "orders.cancel")).toBe(false);
    expect(hasPermission("warehouse", "orders.update")).toBe(false);
    expect(hasPermission("warehouse", "settings.view")).toBe(false);
    expect(hasPermission("warehouse", "employees.view")).toBe(false);
  });

  it("data_entry (and facebook_entry) can only view and create orders", async () => {
    const { hasPermission } = await import("./permissions");
    for (const role of ["data_entry", "facebook_entry"] as const) {
      expect(hasPermission(role, "orders.view")).toBe(true);
      expect(hasPermission(role, "orders.create")).toBe(true);
      expect(hasPermission(role, "orders.confirm")).toBe(false);
      expect(hasPermission(role, "orders.cancel")).toBe(false);
      expect(hasPermission(role, "orders.update")).toBe(false);
      expect(hasPermission(role, "dashboard.view")).toBe(false);
    }
  });

  it("shipping can view and export orders only", async () => {
    const { hasPermission } = await import("./permissions");
    expect(hasPermission("shipping", "orders.view")).toBe(true);
    expect(hasPermission("shipping", "orders.export")).toBe(true);
    expect(hasPermission("shipping", "orders.confirm")).toBe(false);
    expect(hasPermission("shipping", "orders.update")).toBe(false);
    expect(hasPermission("shipping", "dashboard.view")).toBe(false);
  });

  it("viewer can only view dashboard and orders — read-only, no mutations", async () => {
    const { hasPermission } = await import("./permissions");
    expect(hasPermission("viewer", "dashboard.view")).toBe(true);
    expect(hasPermission("viewer", "orders.view")).toBe(true);
    for (const permission of [
      "orders.create",
      "orders.update",
      "orders.confirm",
      "orders.cancel",
      "orders.export",
      "orders.import",
      "employees.view",
      "employees.manage",
      "settings.view",
      "settings.manage",
      "audit.view",
    ] as const) {
      expect(hasPermission("viewer", permission)).toBe(false);
    }
  });

  it("scanner can only view orders", async () => {
    const { hasPermission } = await import("./permissions");
    expect(hasPermission("scanner", "orders.view")).toBe(true);
    expect(hasPermission("scanner", "orders.confirm")).toBe(false);
    expect(hasPermission("scanner", "orders.update")).toBe(false);
    expect(hasPermission("scanner", "dashboard.view")).toBe(false);
  });

  it("routers.ts defines requireEmployeePermission and applies it (not a broad any-employee fallback) to every sensitive employeePortal mutation", async () => {
    const fs = await import("fs");
    const content = fs
      .readFileSync("server/routers.ts", "utf-8")
      .replaceAll('"', "'");
    expect(content).toContain(
      "function requireEmployeePermission(permission: Permission)"
    );
    expect(content).toContain("hasPermission(emp.role, permission)");
    for (const [proc, permission] of [
      ["confirm", "orders.confirm"],
      ["postpone", "orders.update"],
      ["cancel", "orders.cancel"],
      ["markNoAnswer", "orders.update"],
      ["updateNotes", "orders.update"],
      ["updateCustomerInfo", "orders.update"],
      ["editOrder", "orders.update"],
      ["markDuplicate", "orders.update"],
      ["unmarkDuplicate", "orders.update"],
      ["myOrders", "orders.view"],
      ["getOrderEditHistory", "orders.view"],
      ["stats", "dashboard.view"],
    ] as const) {
      expect(content).toContain(
        `${proc}: requireEmployeePermission('${permission}')`
      );
    }
  });

  it("managerPortalProcedure requires an admin-tier role, not the literal string 'manager'", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const idx = content.indexOf("const managerPortalProcedure");
    const section = content.substring(idx, idx + 400);
    expect(section).toContain("isAdminTierRole(emp.role)");
    expect(section).not.toContain("emp.role !== 'manager'");
  });
});
