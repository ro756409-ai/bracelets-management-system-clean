/**
 * Centralized role → permission mapping.
 *
 * This is intentionally a small, hardcoded table (not a database-driven
 * permissions system) — that's the "smallest safe change" for this release.
 * A full dynamic RBAC system (custom roles, per-tenant permission editing) is
 * explicitly deferred to the future System Administration module.
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

const ROLE_PERMISSIONS: Record<EmployeeRole, readonly Permission[]> = {
  super_admin: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  manager: ALL_PERMISSIONS,
  // المحاسب هو الدور الوحيد غير الإداري اللي بيدخل حركات على الخزنة — الدور كان موجود
  // في القائمة من غير أي صلاحية محاسبية، فكان بيشوف الأوردرات وبس.
  accountant: [
    "dashboard.view", "orders.view", "orders.export", "settings.view", "audit.view",
    "accounting.view", "accounting.manage",
  ],
  viewer: ["dashboard.view", "orders.view"],
  order_confirmation: ["dashboard.view", "orders.view", "orders.confirm", "orders.cancel", "orders.update"],
  agent: ["dashboard.view", "orders.view", "orders.confirm", "orders.cancel", "orders.update"],
  data_entry: ["orders.view", "orders.create"],
  facebook_entry: ["orders.view", "orders.create"],
  shipping: ["orders.view", "orders.export"],
  scanner: ["orders.view"],
  warehouse: ["dashboard.view", "orders.view"],
};

export function permissionsForRole(role: string | null | undefined): readonly Permission[] {
  return ROLE_PERMISSIONS[role as EmployeeRole] ?? [];
}

export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}
