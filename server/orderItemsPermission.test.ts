import { describe, it, expect } from "vitest";
import fs from "fs";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import {
  ALL_PERMISSIONS,
  hasPermission,
  permissionsForRole,
  EMPLOYEE_ROLE_VALUES,
  isAdminTierRole,
} from "./permissions";

/**
 * صلاحية تعديل محتوى الأوردر — `orders.edit_items`.
 *
 * الاختبارات دي بتنادي الراوتر الحقيقي، مش بتقرا نص: `appRouter.createCaller` بجلسة
 * فيها دور معيّن، والتأكد إن الرفض بيحصل **قبل** ما أي شغل يتنفّذ. الحارس اللي بيتشاف
 * في الواجهة بس مش حارس.
 */

const ITEMS_INPUT = {
  orderId: 999_999_999,
  items: [
    {
      productId: 1,
      productName: "أسورة نحاس",
      variantId: 2,
      quantity: 1,
      unitPrice: 250,
      discount: 0,
    },
  ],
  shippingFees: 0,
};

function employeeRow(role: string, id = 5) {
  return {
    id,
    name: `موظف ${role}`,
    role,
    tenantId: 1,
    businessId: 7,
    isActive: true,
    email: null,
    username: `emp-${id}`,
    userId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

function baseReqRes() {
  return {
    req: { protocol: "https", headers: {}, cookies: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

/** المالك/الأدمن — جلسة `/login`، بتاخد كل الصلاحيات تلقائيًا. */
function ownerContext(): TrpcContext {
  return {
    ...baseReqRes(),
    user: {
      id: -1,
      openId: "employee-manager-1",
      email: "owner@example.com",
      name: "المالك",
      loginMethod: "employee",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as any,
    employee: employeeRow("super_admin", 1),
    tenantId: 1,
  } as TrpcContext;
}

/** موظف بكوكي الموظف — من غير حساب مالك، فـ`user` بيبقى null. */
function employeeContext(role: string): TrpcContext {
  return {
    ...baseReqRes(),
    user: null,
    employee: employeeRow(role),
    tenantId: 1,
  } as TrpcContext;
}

function anonymousContext(): TrpcContext {
  return { ...baseReqRes(), user: null, employee: null, tenantId: null } as TrpcContext;
}

/** الرفض بسبب الصلاحية — مش أي فشل تاني (أوردر مش موجود، داتابيز مقفولة...). */
async function rejectionCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (error: any) {
    return error?.code ?? error?.cause?.code ?? String(error?.message ?? error);
  }
}

// ==================== الصلاحية نفسها ====================

describe("orders.edit_items — الصلاحية في نظام الصلاحيات الحالي", () => {
  it("موجودة في القائمة الرسمية — يعني المالك يقدر يمنحها أو يمنعها من الشاشة", () => {
    expect(ALL_PERMISSIONS).toContain("orders.edit_items");
  });

  it("مفصولة عن orders.update — تعديل العميل غير تعديل محتوى الصندوق", () => {
    expect(ALL_PERMISSIONS).toContain("orders.update");
    expect("orders.edit_items").not.toBe("orders.update");
  });

  it("أدوار التأكيد واخداها افتراضيًا", () => {
    expect(hasPermission("order_confirmation", "orders.edit_items")).toBe(true);
    expect(hasPermission("agent", "orders.edit_items")).toBe(true);
  });

  it("الأدوار الإدارية واخداها ضمن كل الصلاحيات", () => {
    for (const role of EMPLOYEE_ROLE_VALUES.filter(isAdminTierRole)) {
      expect(hasPermission(role, "orders.edit_items"), role).toBe(true);
    }
  });

  it("🔑 الأدوار اللي شغلها مش تعديل الطلبات معندهاش الصلاحية", () => {
    for (const role of ["warehouse", "scanner", "viewer", "shipping", "accountant", "data_entry", "facebook_entry"]) {
      expect(permissionsForRole(role), role).not.toContain("orders.edit_items");
    }
  });

  it("مفيش نظام صلاحيات موازي — الحقل varchar، فمفيش migration", () => {
    const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
    const table = schema.slice(
      schema.indexOf("export const tenantRolePermissions"),
      schema.indexOf("export const tenantRolePermissions") + 900
    );
    expect(table).toContain('varchar("permission"');
    expect(table).not.toContain('mysqlEnum("permission"');
  });
});

// ==================== التطبيق على السيرفر ====================

describe("🔑 orders.editOrderItems — الحارس على الـendpoint", () => {
  it("جلسة غير مسجّلة ← مرفوضة", async () => {
    const caller = appRouter.createCaller(anonymousContext());
    expect(await rejectionCode(() => caller.orders.editOrderItems(ITEMS_INPUT))).toBe(
      "UNAUTHORIZED"
    );
  });

  it("موظف من غير الصلاحية ← FORBIDDEN", async () => {
    for (const role of ["warehouse", "scanner", "viewer"]) {
      const caller = appRouter.createCaller(employeeContext(role));
      const denied = await rejectionCode(() => caller.orders.editOrderItems(ITEMS_INPUT));
      expect(denied, role).toBe("FORBIDDEN");
    }
  });

  it("🔑 موظف التأكيدات بصلاحيته ← بيعدّي الحارس", async () => {
    for (const role of ["order_confirmation", "agent"]) {
      const caller = appRouter.createCaller(employeeContext(role));
      const code = await rejectionCode(() => caller.orders.editOrderItems(ITEMS_INPUT));
      // الأوردر ٩٩٩٩٩٩٩٩٩ مش موجود، فالفشل المتوقع هو ده — المهم إنه **مش** FORBIDDEN.
      expect(code, role).not.toBe("FORBIDDEN");
      expect(code, role).not.toBe("UNAUTHORIZED");
    }
  });

  it("🔑 المالك/الأدمن بيعدّي تلقائيًا", async () => {
    const caller = appRouter.createCaller(ownerContext());
    const code = await rejectionCode(() => caller.orders.editOrderItems(ITEMS_INPUT));
    expect(code).not.toBe("FORBIDDEN");
    expect(code).not.toBe("UNAUTHORIZED");
  });
});

describe("🔑 employeePortal.editOrderItems — نفس الصلاحية بالظبط", () => {
  it("جلسة غير مسجّلة ← مرفوضة", async () => {
    const caller = appRouter.createCaller(anonymousContext());
    expect(
      await rejectionCode(() => caller.employeePortal.editOrderItems(ITEMS_INPUT))
    ).toBe("UNAUTHORIZED");
  });

  it("موظف من غير الصلاحية ← FORBIDDEN", async () => {
    for (const role of ["warehouse", "scanner", "viewer"]) {
      const caller = appRouter.createCaller(employeeContext(role));
      expect(
        await rejectionCode(() => caller.employeePortal.editOrderItems(ITEMS_INPUT)),
        role
      ).toBe("FORBIDDEN");
    }
  });

  it("🔑 موظف التأكيدات بصلاحيته ← بيعدّي الحارس", async () => {
    const caller = appRouter.createCaller(employeeContext("order_confirmation"));
    const code = await rejectionCode(() =>
      caller.employeePortal.editOrderItems(ITEMS_INPUT)
    );
    expect(code).not.toBe("FORBIDDEN");
    expect(code).not.toBe("UNAUTHORIZED");
  });
});

// ==================== الواجهة والسجل ====================

describe("الواجهة والسجل", () => {
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter(line => !line.trim().startsWith("//"))
      .join("\n");
  }

  const routers = codeOnly(fs.readFileSync("server/routers.ts", "utf-8"));

  it("🔑 المسارين الاتنين على نفس الحارس — مفيش قاعدتين", () => {
    const gates = routers.match(/editOrderItems: (\w+)\(?"?([\w.]*)"?\)?/g) ?? [];
    expect(gates).toHaveLength(2);
    for (const gate of gates) {
      expect(gate).toContain('permissionProcedure("orders.edit_items")');
    }
  });

  it("🔑 الشاشات بتقرا الصلاحية من السيرفر مش بتستنتجها من الدور", () => {
    for (const path of [
      "client/src/pages/Orders.tsx",
      "client/src/pages/EmployeeDashboard.tsx",
      "client/src/pages/AgentWorkspace.tsx",
      "client/src/pages/OrderDetails.tsx",
    ]) {
      const source = codeOnly(fs.readFileSync(path, "utf-8"));
      expect(source, path).toContain('usePermission("orders.edit_items")');
      expect(source, path).toContain("allowItemsEdit={canEditItems}");
    }
    const hook = fs.readFileSync("client/src/hooks/usePermission.ts", "utf-8");
    expect(hook).toContain("auth.myPermissions");
  });

  it("🔑 السجل بيقول مين ودوره الحقيقي، مش «admin» على طول", () => {
    const start = routers.indexOf('editOrderItems: permissionProcedure("orders.edit_items")');
    const body = routers.slice(start, routers.indexOf("getEditHistory", start));
    expect(body).toContain("resolveOrderEditor(ctx)");
    expect(body).toContain("performedByName: editor.name");
    expect(body).toContain("performedByRole: editor.role");
    expect(body).not.toContain('role: "admin" }');
  });

  it("🔑 القبل/البعد بيتسجّلوا في order_edit_logs من محرّك واحد", () => {
    const db = codeOnly(fs.readFileSync("server/db.ts", "utf-8"));
    const start = db.indexOf("export async function replaceOrderItemsFromEditor(");
    const body = db.slice(start, db.indexOf("\nexport async function", start + 10));
    expect(body).toContain("insert(orderEditLogs)");
    expect(body).toContain("oldValue:");
    expect(body).toContain("newValue:");
    expect(body).toContain("editedByName: editor.name");
    expect(body).toContain("editedByRole: editor.role");
  });

  it("🔑 editOrderFull مارجعتش تعدّل محتوى الطلب", () => {
    const db = codeOnly(fs.readFileSync("server/db.ts", "utf-8"));
    const start = db.indexOf("export async function editOrderFull(");
    const body = db.slice(start, db.indexOf("\nexport async function", start + 10));
    expect(body).toContain("ORDER_CONTENT_HEADER_FIELDS.filter");
    expect(body).toContain("existingItems.length > 1");
  });
});
