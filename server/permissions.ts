/**
 * Bootstrap role → permission mapping. Tenant overrides are loaded from the
 * database by hasTenantPermission(), so daily permission changes need no deploy.
 *
 * "admin"/"super_admin"/"manager" employees are treated as full-access,
 * matching the existing behavior where a manager-role employee already gets
 * a synthetic full-admin session (see server/_core/context.ts). The other
 * roles below have a real, distinct permission set defined here, but are
 * only enforced today on the employee-management endpoints themselves
 * (see server/routers.ts `employees` router) — wiring them into every other
 * existing procedure (orders, reports, etc.) is future System Administration
 * work, not part of this release. Documented as a known limitation.
 */

export const ALL_PERMISSIONS = [
  "dashboard.view",
  "orders.view",
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
  // وحدة الحسابات. مفصولة لـview/manage لأن قراءة الأرقام ودخول حركة على الخزنة
  // مسؤوليتين مختلفتين: المدير بيبص، المحاسب بيسجّل.
  "accounting.view",
  "accounting.manage",
  "closing.view",
  "closing.create",
  "closing.submit",
  "closing.approve",
  "closing.adjust",
  "closing.lock",
  "closing.export",
  "financial_accounts.view",
  "financial_accounts.manage",
  "shipping_finance.view",
  "shipping_finance.manage",
  "shipping_finance.approve",
  "inventory_costing.view",
  "inventory_costing.manage",
  "inventory_costing.approve",
  "ad_spend.view",
  "ad_spend.manage",
  // شاشات تشغيل الشحن (شحنات اليوم، جدول توزيع المسارات). منفصلة عن shipping_finance
  // لأن دي تشغيل يومي بيعمله موظف الشحن، وتلك فلوس وتسويات. موظف التأكيدات مالوش
  // الاتنين — بيشوف بيانات الشحن جوه الأوردر بتاعه وبس.
  "shipping_ops.view",
  // الرواتب. أربع صلاحيات مش واحدة عشان فصل المهام يبقى ممكن: المحاسب يجهّز ويدفع،
  // والاعتماد يفضل للإدارة — وده أهم حاجز إداري في وحدة بتحرّك فلوس شهريًا.
  "payroll.view",
  "payroll.manage",
  "payroll.approve",
  "payroll.pay",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** Every employees.role enum value (existing + new) — single source of truth for both the TS type and the runtime array (used by z.enum() in routers.ts). */
export const EMPLOYEE_ROLE_VALUES = [
  "agent", "warehouse", "manager", "facebook_entry", "scanner",
  "super_admin", "admin", "data_entry", "order_confirmation", "shipping", "accountant", "viewer",
] as const;

export type EmployeeRole = (typeof EMPLOYEE_ROLE_VALUES)[number];

/** Roles treated as full-access, equivalent to the existing "manager acts as admin" behavior. */
export const ADMIN_TIER_ROLES: readonly EmployeeRole[] = ["super_admin", "admin", "manager"];

export function isAdminTierRole(role: string | null | undefined): boolean {
  return ADMIN_TIER_ROLES.includes(role as EmployeeRole);
}

/**
 * Owner tier — the narrow set of destructive, unrecoverable actions (permanently
 * deleting orders, locking a closing period, rewriting the tenant permission map).
 *
 * This used to be expressed in routers.ts as "the session has no employee row",
 * which was unreachable: every branch of createContext() attaches an employee
 * row, including the /login owner session. So the owner-only procedures were
 * denied to *everyone*. The tier is now a role, which makes it assignable from
 * the employees screen and visible to the person using the system.
 *
 * Deliberately narrower than ADMIN_TIER_ROLES: "manager" runs the business day
 * to day and must not be able to permanently destroy records.
 */
export const OWNER_ROLES: readonly EmployeeRole[] = ["super_admin"];

export function isOwnerRole(role: string | null | undefined): boolean {
  return OWNER_ROLES.includes(role as EmployeeRole);
}

const ROLE_PERMISSIONS: Record<EmployeeRole, readonly Permission[]> = {
  super_admin: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  manager: ALL_PERMISSIONS,
  // المحاسب هو الدور الوحيد غير الإداري اللي بيدخل حركات على الخزنة — الدور كان موجود
  // في القائمة من غير أي صلاحية محاسبية، فكان بيشوف الأوردرات وبس.
  accountant: [
    "dashboard.view", "orders.view", "orders.export", "settings.view", "audit.view",
    "accounting.view", "accounting.manage",
    "closing.view", "closing.create", "closing.submit", "closing.adjust", "closing.export",
    "financial_accounts.view", "financial_accounts.manage",
    "shipping_finance.view", "shipping_finance.manage",
    "inventory_costing.view",
    "ad_spend.view", "ad_spend.manage",
    // بيجهّز الدورة ويدفعها، لكن مش بيعتمدها — الاعتماد قرار إداري
    "payroll.view", "payroll.manage", "payroll.pay",
  ],
  viewer: ["dashboard.view", "orders.view"],
  order_confirmation: ["dashboard.view", "orders.view", "orders.confirm", "orders.cancel", "orders.update"],
  agent: ["dashboard.view", "orders.view", "orders.confirm", "orders.cancel", "orders.update"],
  data_entry: ["orders.view", "orders.create"],
  facebook_entry: ["orders.view", "orders.create"],
  shipping: ["orders.view", "orders.export", "shipping_ops.view"],
  scanner: ["orders.view"],
  warehouse: ["dashboard.view", "orders.view"],
};

export function permissionsForRole(role: string | null | undefined): readonly Permission[] {
  return ROLE_PERMISSIONS[role as EmployeeRole] ?? [];
}

export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export async function hasTenantPermission(
  tenantId: number,
  role: string | null | undefined,
  permission: Permission,
): Promise<boolean> {
  const [{ getDb }, { tenantRolePermissions }, { and, eq }] = await Promise.all([
    import("./db"),
    import("../drizzle/schema"),
    import("drizzle-orm"),
  ]);
  const db = await getDb();
  if (!db) return hasPermission(role, permission);
  const [override] = await db.select().from(tenantRolePermissions).where(and(
    eq(tenantRolePermissions.tenantId, tenantId),
    eq(tenantRolePermissions.role, role ?? ""),
    eq(tenantRolePermissions.permission, permission),
  )).limit(1);
  return override ? override.isAllowed : hasPermission(role, permission);
}
