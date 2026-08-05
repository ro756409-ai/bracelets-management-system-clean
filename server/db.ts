import {
  eq,
  desc,
  asc,
  and,
  or,
  gte,
  lt,
  lte,
  sql,
  inArray,
  isNull,
  isNotNull,
  getTableColumns,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  employees,
  InsertEmployee,
  Employee,
  products,
  InsertProduct,
  Product,
  orders,
  InsertOrder,
  Order,
  inventoryMovements,
  InsertInventoryMovement,
  returns as returnsTable,
  printLogs,
  InsertPrintLog,
  activityLogs,
  InsertActivityLog,
  businesses,
  InsertBusiness,
  Business,
  businessGroups,
  InsertBusinessGroup,
  BusinessGroup,
  categories,
  InsertCategory,
  Category,
  warehouses,
  InsertWarehouse,
  Warehouse,
  salesChannels,
  InsertSalesChannel,
  SalesChannel,
  syncLogs,
  InsertSyncLog,
  SyncLog,
  productVariants,
  InsertProductVariant,
  ProductVariant,
  orderEditLogs,
  InsertOrderEditLog,
  OrderEditLog,
  scanLogs,
  InsertScanLog,
  orderItems,
  InsertOrderItem,
  OrderItem,
  expenseCategories,
  InsertExpenseCategory,
  ExpenseCategory,
  expenses,
  expensePayments,
  InsertExpense,
  Expense,
  treasuryTransactions,
  InsertTreasuryTransaction,
  TreasuryTransaction,
  payrollSettings,
  InsertPayrollSettings,
  PayrollSettings,
  employeeSalaryProfiles,
  InsertEmployeeSalaryProfile,
  EmployeeSalaryProfile,
  payrollPeriods,
  InsertPayrollPeriod,
  PayrollPeriod,
  payrollItems,
  InsertPayrollItem,
  PayrollItem,
  employeeAdvances,
  InsertEmployeeAdvance,
  EmployeeAdvance,
  inventoryBalances,
  businessConfigurationValues,
  businessShippingProviders,
  purchaseReceipts,
} from "../drizzle/schema";
import {
  calcPayrollLine,
  mergeWithManualEdits,
  parseManualFields,
  toNumber,
  COMMISSION_BASIS_STATUS,
  type PayrollSettingsInput,
  type SalaryProfileInput,
  type PayrollLineInput,
} from "../shared/payrollCalc";
import { normalizeEgyptianPhone, toAsciiDigits } from "../shared/phone";
import {
  allocateProportionally,
  divideRounded,
  fromMinorUnits,
  multiplyMoney,
  toMinorUnits,
} from "../shared/accountingMoney";
import { businessDateKey, businessDayRange } from "../shared/businessTime";
import { captureExpectedShippingSnapshotInTransaction } from "./shippingSnapshotV2.service";

// ==================== CAIRO TIMEZONE HELPERS ====================
const CAIRO_TIMEZONE = "Africa/Cairo";

export function cairoStartOfDay(date: Date): Date {
  return businessDayRange(businessDateKey(date, CAIRO_TIMEZONE), CAIRO_TIMEZONE)
    .from;
}

export function cairoEndOfDay(date: Date): Date {
  const { toExclusive } = businessDayRange(
    businessDateKey(date, CAIRO_TIMEZONE),
    CAIRO_TIMEZONE
  );
  return new Date(toExclusive.getTime() - 1);
}

export function cairoTodayRange(): { from: Date; to: Date } {
  const now = new Date();
  return { from: cairoStartOfDay(now), to: cairoEndOfDay(now) };
}

export function cairoParseDateRange(dateStr: string): { from: Date; to: Date } {
  const { from, toExclusive } = businessDayRange(dateStr, CAIRO_TIMEZONE);
  return { from, to: new Date(toExclusive.getTime() - 1) };
}

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ==================== BUSINESS GROUPS ====================
export async function getAllBusinessGroups() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(businessGroups).orderBy(asc(businessGroups.name));
}

export async function getActiveBusinessGroups() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(businessGroups)
    .where(eq(businessGroups.isActive, true))
    .orderBy(asc(businessGroups.id));
}

export async function getBusinessGroupsWithBusinesses() {
  const db = await getDb();
  if (!db) return [];
  const groups = await db
    .select()
    .from(businessGroups)
    .where(eq(businessGroups.isActive, true))
    .orderBy(asc(businessGroups.id));
  const allBusinesses = await db
    .select()
    .from(businesses)
    .where(eq(businesses.isActive, true))
    .orderBy(asc(businesses.name));
  return groups.map(g => ({
    ...g,
    businesses: allBusinesses.filter(b => b.groupId === g.id),
  }));
}

export async function getBusinessIdsByGroupId(
  groupId: number
): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.groupId, groupId), eq(businesses.isActive, true)));
  return result.map(r => r.id);
}

// جلب معرفات الأعمال (businesses) التابعة لمجموعة عمل عبر الـ slug
// تُستخدم لاستثناء مجموعة المفروشات من الإرسال لبوسطة
export async function getBusinessIdsByGroupSlug(
  slug: string
): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const [group] = await db
    .select({ id: businessGroups.id })
    .from(businessGroups)
    .where(eq(businessGroups.slug, slug))
    .limit(1);
  if (!group) return [];
  const result = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.groupId, group.id));
  return result.map(r => r.id);
}

// ==================== BUSINESSES ====================
export async function getAllBusinesses(businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const where =
    businessIds && businessIds.length > 0
      ? inArray(businesses.id, businessIds)
      : undefined;
  return db
    .select()
    .from(businesses)
    .where(where)
    .orderBy(asc(businesses.name));
}

export async function getActiveBusinesses(businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(businesses.isActive, true)];
  if (businessIds && businessIds.length > 0)
    conditions.push(inArray(businesses.id, businessIds));
  return db
    .select()
    .from(businesses)
    .where(and(...conditions))
    .orderBy(asc(businesses.name));
}

// ==================== TENANTS (multi-tenancy) ====================
/**
 * Every business id that belongs to a given tenant — the allow-list a session may ever
 * read/write. Returns `null` (not `[]`) when the database itself is unreachable, so callers can
 * tell "verified: this tenant owns zero businesses" apart from "couldn't verify at all" —
 * treating the latter as an empty allow-list would fail closed for the wrong reason and mask
 * the real "database unavailable" error every other query in this file already surfaces.
 */
export async function getBusinessIdsForTenant(
  tenantId: number
): Promise<number[] | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.tenantId, tenantId));
  return rows.map(r => r.id);
}

/**
 * Tenant a business group belongs to. Returns null/undefined if the group doesn't exist, the
 * database is unavailable, OR the group's own tenantId hasn't been backfilled yet (still null)
 * — all three are treated identically by callers: "cannot verify, so reject the cross-tenant
 * group assignment" rather than assume it's fine.
 */
async function getBusinessGroupTenantId(
  groupId: number
): Promise<number | null | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const [group] = await db
    .select({ tenantId: businessGroups.tenantId })
    .from(businessGroups)
    .where(eq(businessGroups.id, groupId))
    .limit(1);
  return group?.tenantId;
}

export async function getBusinessById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, id))
    .limit(1);
  return result[0];
}

export async function createBusiness(data: InsertBusiness) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (data.groupId != null) {
    const groupTenantId = await getBusinessGroupTenantId(data.groupId);
    if (data.tenantId == null) throw new Error("Business tenantId is required");
    if (groupTenantId == null || groupTenantId !== data.tenantId) {
      throw new Error("Business group belongs to a different tenant");
    }
  }
  await db.insert(businesses).values(data);
}

export async function updateBusiness(
  id: number,
  data: Partial<InsertBusiness>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (data.groupId != null) {
    const [biz] = await db
      .select({ tenantId: businesses.tenantId })
      .from(businesses)
      .where(eq(businesses.id, id))
      .limit(1);
    const effectiveTenantId = data.tenantId ?? biz?.tenantId;
    const groupTenantId = await getBusinessGroupTenantId(data.groupId);
    if (
      effectiveTenantId == null ||
      groupTenantId == null ||
      groupTenantId !== effectiveTenantId
    ) {
      throw new Error("Business group belongs to a different tenant");
    }
  }
  await db.update(businesses).set(data).where(eq(businesses.id, id));
}

// ==================== CATEGORIES ====================
export async function getCategoriesByBusiness(businessId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(categories)
    .where(
      and(eq(categories.businessId, businessId), eq(categories.isActive, true))
    )
    .orderBy(asc(categories.name));
}

export async function createCategory(data: InsertCategory) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(categories).values(data);
}

export async function updateCategory(
  id: number,
  data: Partial<InsertCategory>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(categories).set(data).where(eq(categories.id, id));
}

// ==================== WAREHOUSES ====================
export async function getWarehousesByBusiness(businessId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(warehouses)
    .where(
      and(eq(warehouses.businessId, businessId), eq(warehouses.isActive, true))
    )
    .orderBy(asc(warehouses.name));
}

export async function createWarehouse(data: InsertWarehouse) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(warehouses).values(data);
}

export async function updateWarehouse(
  id: number,
  data: Partial<InsertWarehouse>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(warehouses).set(data).where(eq(warehouses.id, id));
}

// ==================== USERS ====================
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0)
      updateSet.lastSignedIn = new Date();
    await db
      .insert(users)
      .values(values)
      .onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ==================== EMPLOYEES ====================
export interface EmployeeFilters {
  businessId?: number;
  search?: string;
  role?: string;
  isActive?: boolean;
}

// Column set for any employee query whose result may reach the client — omits passwordHash.
const { passwordHash: _employeePasswordHashColumn, ...employeeSafeColumns } =
  getTableColumns(employees);

export async function getAllEmployees(businessId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (businessId) conditions.push(eq(employees.businessId, businessId));
  return db
    .select(employeeSafeColumns)
    .from(employees)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(employees.name));
}

export async function searchEmployees(filters: EmployeeFilters) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters.businessId)
    conditions.push(eq(employees.businessId, filters.businessId));
  if (filters.role) conditions.push(eq(employees.role, filters.role as any));
  if (filters.isActive !== undefined)
    conditions.push(eq(employees.isActive, filters.isActive));
  if (filters.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      sql`(${employees.name} LIKE ${term} OR ${employees.username} LIKE ${term} OR ${employees.email} LIKE ${term})`
    );
  }
  return db
    .select(employeeSafeColumns)
    .from(employees)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(employees.name));
}

const ADMIN_TIER_ROLES_FOR_QUERY = ["super_admin", "admin", "manager"] as const;
/** Literal mirror of OWNER_ROLES — inArray() needs the enum literals, not the widened type. */
const OWNER_ROLES_FOR_QUERY = ["super_admin"] as const;

/** Number of currently-active admin-tier employees (super_admin/admin/manager). */
/**
 * Active accounts holding the owner tier. Used to decide whether granting the
 * owner role is a bootstrap (no owner exists yet — any admin may create the
 * first one) or an escalation (an owner exists — only an owner may grant it).
 */
export async function countActiveOwnerEmployees(
  excludeId?: number
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions: any[] = [
    eq(employees.isActive, true),
    inArray(employees.role, OWNER_ROLES_FOR_QUERY),
  ];
  if (excludeId) conditions.push(sql`${employees.id} != ${excludeId}`);
  const rows = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(...conditions));
  return rows.length;
}

export async function countActiveAdminTierEmployees(
  excludeId?: number
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions: any[] = [
    eq(employees.isActive, true),
    inArray(employees.role, ADMIN_TIER_ROLES_FOR_QUERY),
  ];
  if (excludeId) conditions.push(sql`${employees.id} != ${excludeId}`);
  const rows = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(...conditions));
  return rows.length;
}

export async function getActiveEmployees(businessId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(employees.isActive, true)];
  if (businessId) conditions.push(eq(employees.businessId, businessId));
  return db
    .select(employeeSafeColumns)
    .from(employees)
    .where(and(...conditions))
    .orderBy(asc(employees.name));
}

export async function getEmployeeById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select(employeeSafeColumns)
    .from(employees)
    .where(eq(employees.id, id))
    .limit(1);
  return result[0];
}

export async function getEmployeeByUsernameOrEmail(identifier: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(employees)
    .where(
      or(eq(employees.username, identifier), eq(employees.email, identifier))
    )
    .limit(1);
  return result[0];
}

export async function createEmployee(data: InsertEmployee) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(employees).values(data);
  return result;
}

export async function updateEmployee(
  id: number,
  data: Partial<InsertEmployee>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(employees).set(data).where(eq(employees.id, id));
}

export async function deleteEmployee(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(employees).where(eq(employees.id, id));
}

// ==================== PRODUCTS ====================
export async function getAllProducts(
  businessId?: number,
  businessIds?: number[],
  opts: { includeInactive?: boolean } = {}
) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (!opts.includeInactive) conditions.push(eq(products.isActive, true));
  if (businessIds && businessIds.length > 0) {
    conditions.push(inArray(products.businessId, businessIds));
  } else if (businessId) {
    conditions.push(eq(products.businessId, businessId));
  }
  return db
    .select()
    .from(products)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(products.name));
}

export async function getProductById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return result[0];
}

export async function createProduct(data: InsertProduct) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(products).values(data);
}

export async function updateProduct(id: number, data: Partial<InsertProduct>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(products).set(data).where(eq(products.id, id));
}

export async function updateProductStock(productId: number, delta: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(products)
    .set({ currentStock: sql`${products.currentStock} + ${delta}` })
    .where(eq(products.id, productId));
}

/**
 * Products that need restocking, judged on their OWN stock column.
 *
 * A product with active variants does not hold stock itself — the stock lives on each
 * variant (a bracelet's engravings, a cover's size/colour). Its `currentStock` therefore
 * sits at 0 permanently and would raise a false "out of stock" alert forever, even with
 * thousands of pieces across its variants. Such products are excluded here and are covered
 * per-variant instead, which is also more precise: one engraving running out is a real
 * alert that a healthy parent total would otherwise hide.
 */
export async function getLowStockProducts(
  businessId?: number,
  businessIds?: number[]
) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [
    eq(products.isActive, true),
    sql`${products.currentStock} <= ${products.minStockLevel}`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${productVariants}
      WHERE ${productVariants.productId} = ${products.id}
        AND ${productVariants.isActive} = TRUE
    )`,
  ];
  if (businessIds && businessIds.length > 0) {
    conditions.push(inArray(products.businessId, businessIds));
  } else if (businessId) {
    conditions.push(eq(products.businessId, businessId));
  }
  return db
    .select()
    .from(products)
    .where(and(...conditions));
}

// ==================== ORDERS ====================
export interface OrderStatusCounts {
  total: number;
  byStatus: Record<string, number>;
  /** Created today (Cairo time), regardless of status. */
  today: number;
  /** Items the parser/importer/sync could not fully match — needs a human before confirming. */
  needsReview: number;
}

/**
 * Order counts for the Orders page header stat cards. One GROUP BY query plus two small
 * counts, rather than the page firing a separate `orders.list` call per stat card.
 */
export async function getOrderStatusCounts(
  businessIds?: number[]
): Promise<OrderStatusCounts> {
  const db = await getDb();
  if (!db) return { total: 0, byStatus: {}, today: 0, needsReview: 0 };

  const scope =
    businessIds && businessIds.length > 0
      ? inArray(orders.businessId, businessIds)
      : undefined;

  const statusRows = await db
    .select({ status: orders.status, count: sql<number>`COUNT(*)` })
    .from(orders)
    .where(scope)
    .groupBy(orders.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of statusRows) {
    const count = Number(row.count);
    byStatus[row.status] = count;
    total += count;
  }

  const businessRows = await db
    .select({ id: businesses.id, timezone: businesses.timezone })
    .from(businesses)
    .where(
      businessIds?.length ? inArray(businesses.id, businessIds) : undefined
    );
  const now = new Date();
  const todayScopes = businessRows.map(business => {
    const range = businessDayRange(
      businessDateKey(now, business.timezone),
      business.timezone
    );
    return and(
      eq(orders.businessId, business.id),
      gte(orders.createdAt, range.from),
      lte(orders.createdAt, new Date(range.toExclusive.getTime() - 1))
    );
  });
  const [todayRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(orders)
    .where(todayScopes.length ? or(...todayScopes) : sql`FALSE`);

  const reviewConditions = [eq(orders.needsReview, true)];
  if (scope) reviewConditions.push(scope);
  const [reviewRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(orders)
    .where(and(...reviewConditions));

  return {
    total,
    byStatus,
    today: Number(todayRow?.count ?? 0),
    needsReview: Number(reviewRow?.count ?? 0),
  };
}

export async function generateOrderNumber(): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db
    .select({ maxNum: sql<string>`MAX(CAST(orderNumber AS UNSIGNED))` })
    .from(orders);
  const maxNum = Number(result[0]?.maxNum ?? 0);
  return String(maxNum + 1);
}

export interface OrderFilters {
  businessId?: number;
  businessIds?: number[];
  websiteId?: number;
  status?: string;
  statuses?: string[];
  source?: string;
  governorate?: string;
  governorates?: string[];
  assignedEmployeeId?: number;
  unassignedOnly?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  assignedDateFrom?: Date;
  assignedDateTo?: Date;
  printedDateFrom?: Date;
  printedDateTo?: Date;
  adName?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export async function getOrders(filters: OrderFilters = {}) {
  const db = await getDb();
  if (!db) return { orders: [], total: 0 };

  const conditions = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(inArray(orders.businessId, filters.businessIds));
  } else if (filters.businessId) {
    conditions.push(eq(orders.businessId, filters.businessId));
  }
  if (filters.websiteId)
    conditions.push(eq(orders.websiteId, filters.websiteId));
  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push(inArray(orders.status, filters.statuses as any[]));
  } else if (filters.status) {
    conditions.push(eq(orders.status, filters.status as any));
  }
  if (filters.source) conditions.push(eq(orders.source, filters.source as any));
  if (filters.governorates && filters.governorates.length > 0) {
    if (filters.governorates.length < 27) {
      conditions.push(
        or(
          inArray(orders.governorate, filters.governorates),
          isNull(orders.governorate),
          eq(orders.governorate, "")
        )!
      );
    }
  } else if (filters.governorate) {
    conditions.push(eq(orders.governorate, filters.governorate));
  }
  if (filters.assignedEmployeeId)
    conditions.push(eq(orders.assignedEmployeeId, filters.assignedEmployeeId));
  if (filters.unassignedOnly)
    conditions.push(isNull(orders.assignedEmployeeId));
  if (filters.dateFrom)
    conditions.push(gte(orders.createdAt, cairoStartOfDay(filters.dateFrom)));
  if (filters.dateTo)
    conditions.push(lte(orders.createdAt, cairoEndOfDay(filters.dateTo)));
  if (filters.assignedDateFrom)
    conditions.push(
      gte(orders.assignedAt, cairoStartOfDay(filters.assignedDateFrom))
    );
  if (filters.assignedDateTo)
    conditions.push(
      lte(orders.assignedAt, cairoEndOfDay(filters.assignedDateTo))
    );
  if (filters.printedDateFrom)
    conditions.push(gte(orders.printedAt, filters.printedDateFrom));
  if (filters.printedDateTo)
    conditions.push(lte(orders.printedAt, filters.printedDateTo));
  if (filters.adName) conditions.push(eq(orders.adName, filters.adName));
  if (filters.search) {
    conditions.push(
      sql`(${orders.customerName} LIKE ${`%${filters.search}%`} OR ${orders.customerPhone} LIKE ${`%${filters.search}%`} OR ${orders.orderNumber} LIKE ${`%${filters.search}%`})`
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(orders)
      .leftJoin(salesChannels, eq(orders.websiteId, salesChannels.id))
      .where(whereClause)
      .orderBy(
        sql`CASE WHEN ${orders.importRowIndex} IS NULL THEN 0 ELSE 1 END`,
        desc(orders.createdAt),
        asc(orders.importRowIndex)
      )
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(orders)
      .where(whereClause),
  ]);

  const ordersWithWebsite = rows.map((row: any) => ({
    ...row.orders,
    websiteName: row.sales_channels?.name || null,
  }));

  return {
    orders: ordersWithWebsite,
    total: Number(countResult[0]?.count ?? 0),
  };
}

// ==================== Bosta Orders View ====================
// Categorizes orders by their Bosta shipping state, using only existing columns
// (bostaShipmentId/bostaStatus/bostaSentAt/bostaLastError) — no schema change.
// External provider statuses are display-only. Categories use the canonical order lifecycle;
// provider-specific normalization belongs to each Business status mapping.

export type BostaOrderCategory =
  | "sent_today"
  | "awaiting_update"
  | "in_transit"
  | "delivered"
  | "returned"
  | "send_failed";

export type BostaOrdersFilters = {
  businessIds?: number[];
  category?: BostaOrderCategory;
  governorate?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  websiteId?: number;
  page?: number;
  limit?: number;
};

/** Base condition: orders that ever touched Bosta — either a shipment exists, or sending
 *  one failed outright (bostaLastError set, no shipmentId). Anything else (never attempted)
 *  is excluded — that's just a regular order, not "a Bosta order". */
function bostaOrdersBaseCondition() {
  return or(
    isNotNull(orders.bostaShipmentId),
    and(isNotNull(orders.bostaLastError), isNull(orders.bostaShipmentId))
  )!;
}

function bostaCategoryCondition(category: BostaOrderCategory) {
  switch (category) {
    case "sent_today":
      return and(
        gte(orders.bostaSentAt, cairoStartOfDay(new Date())),
        lte(orders.bostaSentAt, cairoEndOfDay(new Date()))
      )!;
    case "send_failed":
      return and(
        isNotNull(orders.bostaLastError),
        isNull(orders.bostaShipmentId)
      )!;
    case "awaiting_update":
      return and(
        isNotNull(orders.bostaShipmentId),
        inArray(orders.status, [
          "new",
          "confirmed",
          "printed",
          "preparing",
        ] as any)
      )!;
    case "in_transit":
      return and(
        isNotNull(orders.bostaShipmentId),
        eq(orders.status, "shipped")
      )!;
    case "delivered":
      return and(
        isNotNull(orders.bostaShipmentId),
        eq(orders.status, "delivered")
      )!;
    case "returned":
      return and(
        isNotNull(orders.bostaShipmentId),
        eq(orders.status, "returned")
      )!;
  }
}

export async function getBostaOrders(filters: BostaOrdersFilters = {}) {
  const db = await getDb();
  if (!db) return { orders: [], total: 0 };

  const conditions = [bostaOrdersBaseCondition()];
  if (filters.businessIds && filters.businessIds.length > 0)
    conditions.push(inArray(orders.businessId, filters.businessIds));
  if (filters.governorate)
    conditions.push(eq(orders.governorate, filters.governorate));
  if (filters.websiteId)
    conditions.push(eq(orders.websiteId, filters.websiteId));
  if (filters.dateFrom)
    conditions.push(gte(orders.bostaSentAt, cairoStartOfDay(filters.dateFrom)));
  if (filters.dateTo)
    conditions.push(lte(orders.bostaSentAt, cairoEndOfDay(filters.dateTo)));
  if (filters.search) {
    conditions.push(
      sql`(${orders.bostaTrackingNumber} LIKE ${`%${filters.search}%`} OR ${orders.customerPhone} LIKE ${`%${filters.search}%`} OR ${orders.orderNumber} LIKE ${`%${filters.search}%`})`
    );
  }
  if (filters.category)
    conditions.push(bostaCategoryCondition(filters.category));

  const whereClause = and(...conditions);
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(orders)
      .leftJoin(salesChannels, eq(orders.websiteId, salesChannels.id))
      .where(whereClause)
      .orderBy(desc(orders.bostaSentAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(orders)
      .where(whereClause),
  ]);

  const ordersWithWebsite = rows.map((row: any) => ({
    ...row.orders,
    websiteName: row.sales_channels?.name || null,
  }));

  return {
    orders: ordersWithWebsite,
    total: Number(countResult[0]?.count ?? 0),
  };
}

export async function getBostaOrdersSummary(businessIds?: number[]) {
  const db = await getDb();
  if (!db)
    return {
      sentToday: 0,
      inTransit: 0,
      delivered: 0,
      returned: 0,
      sendFailed: 0,
      awaitingUpdate: 0,
    };

  const scope =
    businessIds && businessIds.length > 0
      ? inArray(orders.businessId, businessIds)
      : undefined;
  const combine = (
    extra: NonNullable<ReturnType<typeof bostaCategoryCondition>>
  ) => (scope ? and(scope, extra) : extra);

  const [
    sentToday,
    inTransit,
    delivered,
    returned,
    sendFailed,
    awaitingUpdate,
  ] = await Promise.all([
    db
      .select({ c: sql<number>`COUNT(*)` })
      .from(orders)
      .where(combine(bostaCategoryCondition("sent_today"))),
    db
      .select({ c: sql<number>`COUNT(*)` })
      .from(orders)
      .where(combine(bostaCategoryCondition("in_transit"))),
    db
      .select({ c: sql<number>`COUNT(*)` })
      .from(orders)
      .where(combine(bostaCategoryCondition("delivered"))),
    db
      .select({ c: sql<number>`COUNT(*)` })
      .from(orders)
      .where(combine(bostaCategoryCondition("returned"))),
    db
      .select({ c: sql<number>`COUNT(*)` })
      .from(orders)
      .where(combine(bostaCategoryCondition("send_failed"))),
    db
      .select({ c: sql<number>`COUNT(*)` })
      .from(orders)
      .where(combine(bostaCategoryCondition("awaiting_update"))),
  ]);

  return {
    sentToday: Number(sentToday[0]?.c ?? 0),
    inTransit: Number(inTransit[0]?.c ?? 0),
    delivered: Number(delivered[0]?.c ?? 0),
    returned: Number(returned[0]?.c ?? 0),
    sendFailed: Number(sendFailed[0]?.c ?? 0),
    awaitingUpdate: Number(awaitingUpdate[0]?.c ?? 0),
  };
}

export async function getOrderById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  return result[0];
}

export async function getOrdersByIds(ids: number[]) {
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  const rows = await db.select().from(orders).where(inArray(orders.id, ids));
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  return rows.sort(
    (a, b) => (idIndex.get(a.id) ?? 0) - (idIndex.get(b.id) ?? 0)
  );
}

export async function getOrdersByEmployee(
  employeeId: number,
  filters: OrderFilters = {}
) {
  return getOrders({ ...filters, assignedEmployeeId: employeeId });
}

export function generateSerialNumber(
  orderId: number,
  createdAt?: Date
): string {
  const year = (createdAt ?? new Date()).getFullYear();
  return `ORD-${year}-${String(orderId).padStart(6, "0")}`;
}

function withNormalizedPhoneFields<
  T extends { customerPhone?: unknown; customerPhone2?: unknown },
>(data: T): T {
  const normalized = { ...data };
  if (
    typeof normalized.customerPhone === "string" &&
    normalized.customerPhone
  ) {
    normalized.customerPhone = normalizeEgyptianPhone(
      normalized.customerPhone
    ) as any;
  }
  if (
    typeof normalized.customerPhone2 === "string" &&
    normalized.customerPhone2
  ) {
    normalized.customerPhone2 = normalizeEgyptianPhone(
      normalized.customerPhone2
    ) as any;
  }
  return normalized;
}

type OrderItemWrite = {
  productId?: number;
  productName: string;
  quantity: number;
  unitPrice?: number;
  variantId?: number;
  size?: string;
  color?: string;
};

async function createOrderInTransaction(
  tx: any,
  data: InsertOrder,
  items?: OrderItemWrite[]
): Promise<number | undefined> {
  if (data.businessId == null)
    throw new Error("Business is required when creating an order");
  const businessId = data.businessId;
  const normalizedData = { ...data };
  const [business] = await tx
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const isAfterGoLive = Boolean(
    business?.accountingGoLiveAt &&
      (data.createdAt ?? new Date()) >= business.accountingGoLiveAt
  );
  if (
    isAfterGoLive &&
    (!normalizedData.projectedShippingProviderId ||
      !normalizedData.projectedShippingType ||
      !normalizedData.projectedPaymentType)
  ) {
    const [providers, shippingTypes, paymentTypes] = await Promise.all([
      tx
        .select()
        .from(businessShippingProviders)
        .where(
          and(
            eq(businessShippingProviders.businessId, businessId),
            eq(businessShippingProviders.isActive, true)
          )
        ),
      tx
        .select()
        .from(businessConfigurationValues)
        .where(
          and(
            eq(businessConfigurationValues.businessId, businessId),
            eq(businessConfigurationValues.namespace, "shipping_type"),
            eq(businessConfigurationValues.isActive, true)
          )
        ),
      tx
        .select()
        .from(businessConfigurationValues)
        .where(
          and(
            eq(businessConfigurationValues.businessId, businessId),
            eq(businessConfigurationValues.namespace, "payment_type"),
            eq(businessConfigurationValues.isActive, true)
          )
        ),
    ]);
    if (
      providers.length !== 1 ||
      shippingTypes.length !== 1 ||
      paymentTypes.length !== 1
    ) {
      throw new Error(
        "Shipping Provider, Shipping Type and Payment Type must be selected for orders after Go-Live"
      );
    }
    normalizedData.projectedShippingProviderId = providers[0].id;
    normalizedData.projectedShippingType = shippingTypes[0].configKey;
    normalizedData.projectedPaymentType = paymentTypes[0].configKey;
  }
  const [result] = await tx
    .insert(orders)
    .values(withNormalizedPhoneFields(normalizedData));
  const insertId = Number((result as any).insertId);
  if (!insertId) return undefined;
  await tx
    .update(orders)
    .set({ serialNumber: generateSerialNumber(insertId) })
    .where(eq(orders.id, insertId));
  if (items) await replaceOrderItemsInTransaction(tx, insertId, items);
  if (
    normalizedData.projectedShippingProviderId &&
    normalizedData.projectedShippingType &&
    normalizedData.projectedPaymentType
  ) {
    await captureExpectedShippingSnapshotInTransaction(tx, {
      businessId,
      orderId: insertId,
      businessShippingProviderId: normalizedData.projectedShippingProviderId,
      governorate: normalizedData.governorate,
      shippingType: normalizedData.projectedShippingType,
      paymentType: normalizedData.projectedPaymentType,
      occurredAt: data.createdAt ?? new Date(),
    });
  }
  return insertId;
}

export async function createOrder(
  data: InsertOrder
): Promise<number | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(tx => createOrderInTransaction(tx, data));
}

export async function createOrderWithItems(
  data: InsertOrder,
  items: OrderItemWrite[]
): Promise<number | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(tx => createOrderInTransaction(tx, data, items));
}

/**
 * Which status a raw status write is allowed to move an order into, keyed by its current
 * status. Only guards the generic update path — the dedicated functions (confirmOrder,
 * postponeOrder, cancelOrder, markOrdersAsPrinted, markOrderAsReturned) already encode
 * their own correct transitions and are unaffected by this map.
 */
// Widened 2026-07-28 per an explicit ops review: the original map was too strict for real
// day-to-day corrections (a confirmed order whose customer calls back to postpone, a shipment
// that has to be cancelled, a delivered order the customer returns, ...). Still refuses
// genuinely nonsensical jumps (e.g. new -> delivered) — this is a considered widening, not a
// removal of the guard, and applies equally to every role (no manager-only bypass).
const STATUS_TRANSITIONS: Record<string, string[]> = {
  new: ["confirmed", "postponed", "cancelled", "no_answer"],
  postponed: ["confirmed", "cancelled", "no_answer", "new"],
  no_answer: ["new", "confirmed", "postponed", "cancelled"],
  confirmed: ["preparing", "cancelled", "postponed", "no_answer"],
  printed: ["preparing", "shipped", "cancelled"],
  preparing: ["shipped", "cancelled", "confirmed"],
  shipped: ["delivered", "cancelled", "returned"],
  delivered: ["returned"],
  cancelled: ["new", "confirmed"],
  returned: ["new"],
};

export function isValidOrderStatusTransition(
  from: string,
  to: string
): boolean {
  if (from === to) return true;
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function updateOrder(id: number, data: Partial<InsertOrder>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (data.status) {
    const [current] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    if (current && !isValidOrderStatusTransition(current.status, data.status)) {
      throw new Error(
        `لا يمكن تغيير حالة الأوردر من "${current.status}" إلى "${data.status}" مباشرة`
      );
    }
  }
  await db
    .update(orders)
    .set(withNormalizedPhoneFields(data))
    .where(eq(orders.id, id));
}

export async function deleteOrder(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(orders).where(eq(orders.id, id));
}

// ==================== SCAN HELPERS ====================
export async function scanOrderBySerial(
  serialNumber: string,
  scannedBy: number,
  scannedByName: string,
  deviceInfo?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Clean up the scanned value (trim whitespace, remove URL prefixes if any)
  let searchValue = serialNumber.trim();

  // If the QR contains a Bosta tracking URL, extract the tracking number
  // e.g., "https://bosta.co/tracking?tn=N-692764761726X" or just the tracking number
  const bostaUrlMatch = searchValue.match(/[?&]tn=([^&]+)/);
  if (bostaUrlMatch) {
    searchValue = bostaUrlMatch[1];
  }
  // Also handle if QR contains just a URL with tracking number in path
  const bostaPathMatch = searchValue.match(/bosta\.co\/tracking\/([^/?]+)/);
  if (bostaPathMatch) {
    searchValue = bostaPathMatch[1];
  }

  console.log(
    `[Scan] Searching for: "${searchValue}" (original: "${serialNumber}")`
  );

  // Try to find order by multiple fields: orderNumber, bostaTrackingNumber, serialNumber, bostaShipmentId
  let orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, searchValue))
    .limit(1);
  if (!orderRows.length) {
    orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.bostaTrackingNumber, searchValue))
      .limit(1);
  }
  if (!orderRows.length) {
    orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.serialNumber, searchValue))
      .limit(1);
  }
  if (!orderRows.length) {
    orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.bostaShipmentId, searchValue))
      .limit(1);
  }
  // Try partial match - Bosta tracking numbers often start with N- followed by digits
  if (!orderRows.length && /^N-?\d+/i.test(searchValue)) {
    orderRows = await db
      .select()
      .from(orders)
      .where(sql`${orders.bostaTrackingNumber} LIKE ${`%${searchValue}%`}`)
      .limit(1);
  }
  // Try searching by customer phone if the scanned value looks like a phone number
  // (converted to ASCII digits first so Arabic-Indic phone numbers are recognized too)
  const asciiSearchValue = toAsciiDigits(searchValue).replace(/\s/g, "");
  if (!orderRows.length && /^\+?[0-9]{10,15}$/.test(asciiSearchValue)) {
    const phone =
      normalizeEgyptianPhone(searchValue) ||
      asciiSearchValue.replace(/^\+2/, "");
    orderRows = await db
      .select()
      .from(orders)
      .where(
        and(
          sql`${orders.customerPhone} LIKE ${`%${phone}%`}`,
          eq(orders.isPrepared, false)
        )
      )
      .limit(1);
  }
  if (!orderRows.length) {
    await db
      .insert(scanLogs)
      .values({
        orderId: 0,
        serialNumber: searchValue,
        scannedBy,
        scannedByName,
        result: "failed",
        deviceInfo,
      });
    return {
      success: false,
      result: "failed" as const,
      message: `الأوردر غير موجود - QR غير صحيح (${searchValue})`,
    };
  }

  const order = orderRows[0];

  // Check cancelled/returned
  if (order.status === "cancelled" || order.status === "returned") {
    await db
      .insert(scanLogs)
      .values({
        orderId: order.id,
        serialNumber,
        scannedBy,
        scannedByName,
        result: "cancelled",
        deviceInfo,
      });
    return {
      success: false,
      result: "cancelled" as const,
      message: `تحذير: هذا الأوردر ${order.status === "cancelled" ? "ملغي" : "مرتجع"}`,
      order,
    };
  }

  // Check already prepared
  if (order.isPrepared) {
    await db
      .insert(scanLogs)
      .values({
        orderId: order.id,
        serialNumber,
        scannedBy,
        scannedByName,
        result: "duplicate",
        deviceInfo,
      });
    await db
      .update(orders)
      .set({ scanCount: (order.scanCount ?? 0) + 1, lastScannedAt: new Date() })
      .where(eq(orders.id, order.id));
    return {
      success: false,
      result: "duplicate" as const,
      message: `تم تجهيز هذا الأوردر بالفعل بواسطة ${order.preparedByName ?? "موظف"} في ${order.preparedAt ? new Date(order.preparedAt).toLocaleString("ar-EG") : ""}`,
      order,
    };
  }

  // Mark as prepared
  const now = new Date();
  await db
    .update(orders)
    .set({
      isPrepared: true,
      preparedAt: now,
      preparedBy: scannedBy,
      preparedByName: scannedByName,
      scanCount: (order.scanCount ?? 0) + 1,
      lastScannedAt: now,
    })
    .where(eq(orders.id, order.id));

  await db
    .insert(scanLogs)
    .values({
      orderId: order.id,
      serialNumber,
      scannedBy,
      scannedByName,
      result: "success",
      deviceInfo,
    });

  const updatedOrder = {
    ...order,
    isPrepared: true,
    preparedAt: now,
    preparedBy: scannedBy,
    preparedByName: scannedByName,
  };
  return {
    success: true,
    result: "success" as const,
    message: "تم تجهيز الأوردر بنجاح ✓",
    order: updatedOrder,
  };
}

export async function getScanLogs(filters: {
  orderId?: number;
  scannedBy?: number;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters.orderId) conditions.push(eq(scanLogs.orderId, filters.orderId));
  if (filters.scannedBy)
    conditions.push(eq(scanLogs.scannedBy, filters.scannedBy));
  const rows = await db
    .select()
    .from(scanLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(scanLogs.createdAt))
    .limit(filters.limit ?? 100);
  return rows;
}

export async function deleteOrders(ids: number[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  for (const id of ids) {
    await db.delete(orders).where(eq(orders.id, id));
  }
}

export async function markOrdersAsPrinted(ids: number[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (ids.length === 0) return;
  await db
    .update(orders)
    .set({
      status: "printed",
      printedAt: new Date(),
    })
    .where(and(inArray(orders.id, ids), eq(orders.status, "confirmed")));
}

export async function assignOrderToEmployee(
  orderId: number,
  employeeId: number,
  updatedBy: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(orders)
    .set({
      assignedEmployeeId: employeeId,
      assignedAt: new Date(),
      lastUpdatedBy: updatedBy,
    })
    .where(eq(orders.id, orderId));
}

export async function bulkAssignOrders(
  orderIds: number[],
  employeeId: number,
  updatedBy: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(orders)
    .set({
      assignedEmployeeId: employeeId,
      assignedAt: new Date(),
      lastUpdatedBy: updatedBy,
    })
    .where(inArray(orders.id, orderIds));
}

export async function confirmOrder(
  orderId: number,
  updatedBy: number,
  confirmedByName?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw new Error("Order not found");
  if (order.businessId == null)
    throw new Error(
      "Order has no Business and cannot enter accounting workflow"
    );
  const [business] = await db
    .select({ accountingGoLiveAt: businesses.accountingGoLiveAt })
    .from(businesses)
    .where(eq(businesses.id, order.businessId))
    .limit(1);
  const accountingInventoryActive = Boolean(business?.accountingGoLiveAt);

  if (order.status === "confirmed") return;

  const missingFields: string[] = [];
  if (
    !order.governorate ||
    order.governorate.trim() === "" ||
    order.governorate.trim() === "غير محدد"
  ) {
    missingFields.push("اسم المحافظة");
  }
  if (!order.customerAddress || order.customerAddress.trim().length < 5) {
    missingFields.push("العنوان بالتفصيل");
  }
  if (missingFields.length > 0) {
    throw new Error(
      `لا يمكن تأكيد الأوردر - بيانات ناقصة: ${missingFields.join(" و ")}`
    );
  }

  const qty = order.quantity ?? 1;
  if (!accountingInventoryActive && order.productId) {
    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, order.productId))
      .limit(1);
    if (product && product.currentStock < qty) {
      throw new Error(
        `لا يمكن تأكيد الأوردر - المخزون غير كافي (المتاح: ${product.currentStock}، المطلوب: ${qty})`
      );
    }
  }

  await db
    .update(orders)
    .set({
      status: "confirmed",
      confirmedAt: new Date(),
      lastUpdatedBy: updatedBy,
      // Preserve whatever confirmation record already exists (e.g. a legacy-imported
      // order) rather than overwriting it — this function only ever runs once per order
      // anyway (guarded by the early return above), but keep the intent explicit.
      ...(order.confirmedByEmployeeId == null && updatedBy
        ? {
            confirmedByEmployeeId: updatedBy,
            confirmedByEmployeeName: confirmedByName ?? null,
          }
        : {}),
    })
    .where(eq(orders.id, orderId));

  if (!accountingInventoryActive && order.productId) {
    await addInventoryMovement({
      productId: order.productId,
      type: "out",
      quantity: qty,
      reason: `تأكيد أوردر ${order.orderNumber}`,
      orderId: order.id,
      performedBy: updatedBy,
      businessId: order.businessId,
    });
  }
}

export async function postponeOrder(
  orderId: number,
  postponedTo: Date,
  notes: string | undefined,
  updatedBy: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(orders)
    .set({
      status: "postponed",
      postponedTo,
      notes,
      lastUpdatedBy: updatedBy,
    })
    .where(eq(orders.id, orderId));
}

export async function cancelOrder(
  orderId: number,
  cancelReason: string,
  notes: string | undefined,
  updatedBy: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(orders)
    .set({
      status: "cancelled",
      cancelReason: cancelReason as any,
      cancelledAt: new Date(),
      notes,
      lastUpdatedBy: updatedBy,
    })
    .where(eq(orders.id, orderId));
}

// ==================== DASHBOARD STATS ====================
export async function getDashboardStats(
  dateFrom?: Date,
  dateTo?: Date,
  businessId?: number,
  businessIds?: number[]
) {
  const db = await getDb();
  if (!db) return null;

  // Apply Cairo timezone correction: ensure dateFrom/dateTo cover full Cairo day
  const correctedFrom = dateFrom ? cairoStartOfDay(dateFrom) : undefined;
  const correctedTo = dateTo ? cairoEndOfDay(dateTo) : undefined;

  const addBusinessFilter = (conds: any[]) => {
    if (businessIds && businessIds.length > 0) {
      conds.push(inArray(orders.businessId, businessIds));
    } else if (businessId) {
      conds.push(eq(orders.businessId, businessId));
    }
  };

  const conditions: any[] = [];
  addBusinessFilter(conditions);
  if (correctedFrom) conditions.push(gte(orders.createdAt, correctedFrom));
  if (correctedTo) conditions.push(lte(orders.createdAt, correctedTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Confirmed stats (based on confirmedAt)
  const confirmedConditions: any[] = [];
  addBusinessFilter(confirmedConditions);
  if (correctedFrom)
    confirmedConditions.push(gte(orders.confirmedAt, correctedFrom));
  if (correctedTo)
    confirmedConditions.push(lte(orders.confirmedAt, correctedTo));
  confirmedConditions.push(
    inArray(orders.status, [
      "confirmed",
      "printed",
      "preparing",
      "shipped",
      "delivered",
    ] as any[])
  );
  const confirmedWhere = and(...confirmedConditions);

  // Cancelled stats (based on cancelledAt)
  const cancelledConditions: any[] = [];
  addBusinessFilter(cancelledConditions);
  if (correctedFrom)
    cancelledConditions.push(gte(orders.cancelledAt, correctedFrom));
  if (correctedTo)
    cancelledConditions.push(lte(orders.cancelledAt, correctedTo));
  cancelledConditions.push(eq(orders.status, "cancelled"));
  const cancelledWhere = and(...cancelledConditions);

  // Shipped stats (based on shippedAt)
  const shippedConditions: any[] = [];
  addBusinessFilter(shippedConditions);
  if (correctedFrom)
    shippedConditions.push(gte(orders.shippedAt, correctedFrom));
  if (correctedTo) shippedConditions.push(lte(orders.shippedAt, correctedTo));
  shippedConditions.push(
    inArray(orders.status, ["shipped", "delivered"] as any[])
  );
  const shippedWhere = and(...shippedConditions);

  // Delivered revenue (based on deliveredAt)
  const deliveredConditions: any[] = [];
  addBusinessFilter(deliveredConditions);
  if (correctedFrom)
    deliveredConditions.push(gte(orders.deliveredAt, correctedFrom));
  if (correctedTo)
    deliveredConditions.push(lte(orders.deliveredAt, correctedTo));
  deliveredConditions.push(eq(orders.status, "delivered"));
  const deliveredWhere = and(...deliveredConditions);

  const [
    statusStats,
    sourceStats,
    governorateStats,
    totalRevenue,
    confirmedCount,
    cancelledCount,
    shippedCount,
  ] = await Promise.all([
    db
      .select({
        status: orders.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(orders)
      .where(whereClause)
      .groupBy(orders.status),

    db
      .select({
        source: orders.source,
        count: sql<number>`COUNT(*)`,
      })
      .from(orders)
      .where(whereClause)
      .groupBy(orders.source),

    db
      .select({
        governorate: orders.governorate,
        count: sql<number>`COUNT(*)`,
      })
      .from(orders)
      .where(whereClause)
      .groupBy(orders.governorate)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10),

    db
      .select({
        total: sql<number>`SUM(${orders.totalAmount})`,
      })
      .from(orders)
      .where(deliveredWhere),

    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(orders)
      .where(confirmedWhere),

    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(orders)
      .where(cancelledWhere),

    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(orders)
      .where(shippedWhere),
  ]);

  return {
    statusStats,
    sourceStats,
    governorateStats,
    totalRevenue: Number(totalRevenue[0]?.total ?? 0),
    confirmedToday: Number(confirmedCount[0]?.count ?? 0),
    cancelledToday: Number(cancelledCount[0]?.count ?? 0),
    shippedToday: Number(shippedCount[0]?.count ?? 0),
  };
}

export async function getEmployeePerformance(
  dateFrom?: Date,
  dateTo?: Date,
  businessId?: number,
  businessIds?: number[]
) {
  const db = await getDb();
  if (!db) return [];

  const correctedFrom = dateFrom ? cairoStartOfDay(dateFrom) : undefined;
  const correctedTo = dateTo ? cairoEndOfDay(dateTo) : undefined;
  const conditions = [];
  if (businessIds && businessIds.length > 0)
    conditions.push(inArray(orders.businessId, businessIds));
  else if (businessId) conditions.push(eq(orders.businessId, businessId));
  if (correctedFrom) conditions.push(gte(orders.createdAt, correctedFrom));
  if (correctedTo) conditions.push(lte(orders.createdAt, correctedTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  return db
    .select({
      employeeId: orders.assignedEmployeeId,
      total: sql<number>`COUNT(*)`,
      confirmed: sql<number>`SUM(CASE WHEN ${orders.status} = 'confirmed' THEN 1 ELSE 0 END)`,
      cancelled: sql<number>`SUM(CASE WHEN ${orders.status} = 'cancelled' THEN 1 ELSE 0 END)`,
      postponed: sql<number>`SUM(CASE WHEN ${orders.status} = 'postponed' THEN 1 ELSE 0 END)`,
      delivered: sql<number>`SUM(CASE WHEN ${orders.status} = 'delivered' THEN 1 ELSE 0 END)`,
    })
    .from(orders)
    .where(and(whereClause, sql`${orders.assignedEmployeeId} IS NOT NULL`))
    .groupBy(orders.assignedEmployeeId);
}

export async function getCancellationReasons(
  dateFrom?: Date,
  dateTo?: Date,
  businessId?: number,
  businessIds?: number[]
) {
  const db = await getDb();
  if (!db) return [];

  const correctedFrom = dateFrom ? cairoStartOfDay(dateFrom) : undefined;
  const correctedTo = dateTo ? cairoEndOfDay(dateTo) : undefined;
  const conditions = [eq(orders.status, "cancelled")];
  if (businessIds && businessIds.length > 0)
    conditions.push(inArray(orders.businessId, businessIds));
  else if (businessId) conditions.push(eq(orders.businessId, businessId));
  if (correctedFrom) conditions.push(gte(orders.cancelledAt, correctedFrom));
  if (correctedTo) conditions.push(lte(orders.cancelledAt, correctedTo));

  return db
    .select({
      reason: orders.cancelReason,
      count: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .where(and(...conditions))
    .groupBy(orders.cancelReason);
}

export async function getDailyOrdersChart(
  days: number = 30,
  businessId?: number,
  businessIds?: number[]
) {
  const db = await getDb();
  if (!db) return [];
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);

  let businessFilter;
  if (businessIds && businessIds.length > 0) {
    businessFilter = sql`AND businessId IN (${sql.raw(businessIds.join(","))})`;
  } else if (businessId) {
    businessFilter = sql`AND businessId = ${businessId}`;
  } else {
    businessFilter = sql``;
  }

  // Use CONVERT_TZ to get Cairo date correctly
  const result = await db.execute(sql`
    SELECT order_date as date,
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('confirmed','printed','preparing','shipped','delivered') THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status IN ('shipped','delivered') THEN 1 ELSE 0 END) as shipped
    FROM (
      SELECT DATE(CONVERT_TZ(createdAt, '+00:00', '+02:00')) as order_date, status
      FROM orders
      WHERE createdAt >= ${dateFrom} ${businessFilter}
    ) t
    GROUP BY order_date
    ORDER BY order_date ASC
  `);

  const rows = Array.isArray(result) ? result[0] : (result as unknown as any[]);
  return (rows as any[]).map((r: any) => ({
    date:
      r.date instanceof Date
        ? r.date.toISOString().split("T")[0]
        : String(r.date),
    total: Number(r.total),
    confirmed: Number(r.confirmed),
    cancelled: Number(r.cancelled),
    shipped: Number(r.shipped ?? 0),
  }));
}

// ==================== ORDER EDIT WITH INVENTORY ====================
export async function editOrderWithInventory(
  orderId: number,
  updates: {
    productId?: number;
    productName?: string;
    quantity?: number;
    totalAmount?: number;
    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;
    governorate?: string;
    notes?: string;
  },
  updatedBy: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw new Error("الأوردر غير موجود");

  const isConfirmed = order.status === "confirmed";
  const oldProductId = order.productId;
  const oldQty = order.quantity ?? 1;
  const newProductId = updates.productId ?? oldProductId;
  const newQty = updates.quantity ?? oldQty;

  await db
    .update(orders)
    .set({
      ...(updates.productId && { productId: updates.productId }),
      ...(updates.productName && { productName: updates.productName }),
      ...(updates.quantity !== undefined && { quantity: updates.quantity }),
      ...(updates.totalAmount !== undefined && {
        totalAmount: String(updates.totalAmount),
      }),
      ...(updates.customerName && { customerName: updates.customerName }),
      ...(updates.customerPhone && { customerPhone: updates.customerPhone }),
      ...(updates.customerAddress !== undefined && {
        customerAddress: updates.customerAddress,
      }),
      ...(updates.governorate && { governorate: updates.governorate }),
      ...(updates.notes !== undefined && { notes: updates.notes }),
      lastUpdatedBy: updatedBy,
    })
    .where(eq(orders.id, orderId));

  // Stock is only moved for orders that actually have a product resolved. An order still
  // awaiting product review (productId null) has never deducted stock, so there is nothing
  // to return or deduct here.
  if (order.businessId == null)
    throw new Error("Order has no Business and cannot update inventory");
  const [inventoryBusiness] = await db
    .select({ accountingGoLiveAt: businesses.accountingGoLiveAt })
    .from(businesses)
    .where(eq(businesses.id, order.businessId))
    .limit(1);
  if (
    isConfirmed &&
    !inventoryBusiness?.accountingGoLiveAt &&
    (updates.productId !== undefined || updates.quantity !== undefined)
  ) {
    if (oldProductId != null) {
      await addInventoryMovement({
        productId: oldProductId,
        type: "in",
        quantity: oldQty,
        reason: `تعديل أوردر ${order.orderNumber} - إرجاع قديم`,
        orderId: order.id,
        performedBy: updatedBy,
        businessId: order.businessId,
      });
    }
    if (newProductId != null) {
      await addInventoryMovement({
        productId: newProductId,
        type: "out",
        quantity: newQty,
        reason: `تعديل أوردر ${order.orderNumber} - خصم جديد`,
        orderId: order.id,
        performedBy: updatedBy,
        businessId: order.businessId,
      });
    }
  }
}

// ==================== INVENTORY ====================
export async function addInventoryMovement(data: InsertInventoryMovement) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const product = await getProductById(data.productId);
  if (!product) throw new Error("المنتج غير موجود");
  const movementBusinessId = data.businessId ?? product.businessId;
  const [business] = await db
    .select({ accountingGoLiveAt: businesses.accountingGoLiveAt })
    .from(businesses)
    .where(eq(businesses.id, movementBusinessId))
    .limit(1);
  if (business?.accountingGoLiveAt)
    throw new Error(
      "بعد Go-Live استخدم Purchase Receipt أو Reservation/Dispatch بدل الحركة اليدوية"
    );
  if (data.type === "out") {
    if (data.quantity > product.currentStock) {
      throw new Error(
        `الكمية الصادرة (${data.quantity}) أكبر من المخزون الحالي (${product.currentStock})`
      );
    }
  }
  await db.insert(inventoryMovements).values(data);
  const delta = data.type === "in" ? data.quantity : -data.quantity;
  await updateProductStock(data.productId, delta);
}

export async function getInventoryMovements(
  productId?: number,
  limit = 50,
  businessId?: number,
  businessIds?: number[],
  variantId?: number
) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (productId) conditions.push(eq(inventoryMovements.productId, productId));
  if (variantId) conditions.push(eq(inventoryMovements.variantId, variantId));
  if (businessIds && businessIds.length > 0) {
    conditions.push(inArray(inventoryMovements.businessId, businessIds));
  } else if (businessId) {
    conditions.push(eq(inventoryMovements.businessId, businessId));
  }
  return db
    .select()
    .from(inventoryMovements)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(limit);
}

// ==================== SEED DATA ====================
export async function seedInitialData() {
  const db = await getDb();
  if (!db) return;

  const existingProducts = await db.select().from(products).limit(1);
  if (existingProducts.length > 0) return;

  const braceletProducts = [
    {
      name: "أسورة سادة",
      sku: "PLAIN-001",
      price: "150.00",
      currentStock: 100,
      minStockLevel: 20,
      businessId: 1,
    },
    {
      name: "آية الكرسي",
      sku: "AYAT-001",
      price: "180.00",
      currentStock: 80,
      minStockLevel: 15,
      businessId: 1,
    },
    {
      name: "ذكر التحصين",
      sku: "DHIKR-001",
      price: "175.00",
      currentStock: 60,
      minStockLevel: 15,
      businessId: 1,
    },
    {
      name: "فالله خير حافظاً",
      sku: "HAFIZ-001",
      price: "185.00",
      currentStock: 70,
      minStockLevel: 15,
      businessId: 1,
    },
    {
      name: "منقوش",
      sku: "ENGR-001",
      price: "200.00",
      currentStock: 50,
      minStockLevel: 10,
      businessId: 1,
    },
    {
      name: "عين حورس",
      sku: "HORUS-001",
      price: "160.00",
      currentStock: 90,
      minStockLevel: 20,
      businessId: 1,
    },
    {
      name: "قل أعوذ برب الفلق",
      sku: "FALAQ-001",
      price: "180.00",
      currentStock: 65,
      minStockLevel: 15,
      businessId: 1,
    },
    {
      name: "أسورة إنه من سليمان",
      sku: "SULAI-001",
      price: "185.00",
      currentStock: 50,
      minStockLevel: 15,
      businessId: 1,
    },
    {
      name: "أسورة كهيعص",
      sku: "KAHYA-001",
      price: "185.00",
      currentStock: 50,
      minStockLevel: 15,
      businessId: 1,
    },
  ];

  await db.insert(products).values(braceletProducts);
}

// ==================== RETURNS ====================
export async function markOrderAsReturned(
  orderId: number,
  returnReason: string,
  notes: string | undefined,
  processedBy: number,
  restoreStock: boolean = true
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (orderRows.length === 0) throw new Error("الأوردر غير موجود");
  const order = orderRows[0];
  if (order.businessId == null)
    throw new Error("Order has no Business and cannot be returned");
  const [returnBusiness] = await db
    .select({ accountingGoLiveAt: businesses.accountingGoLiveAt })
    .from(businesses)
    .where(eq(businesses.id, order.businessId))
    .limit(1);
  if (returnBusiness?.accountingGoLiveAt)
    throw new Error(
      "بعد Go-Live سجل Returned أو Partial Return من المصدر الرسمي ثم نفّذ الفحص"
    );

  const allowedStatuses = ["confirmed", "shipped", "delivered", "preparing"];
  if (!allowedStatuses.includes(order.status)) {
    throw new Error(`لا يمكن إرجاع أوردر بحالة: ${order.status}`);
  }

  await db
    .update(orders)
    .set({ status: "returned", lastUpdatedBy: processedBy })
    .where(eq(orders.id, orderId));

  // Only restore stock when a product was actually resolved for this order.
  if (restoreStock && order.productId != null) {
    await addInventoryMovement({
      productId: order.productId,
      type: "in",
      quantity: order.quantity,
      reason: `مرتجع - أوردر ${order.orderNumber}`,
      orderId: order.id,
      performedBy: processedBy,
      businessId: order.businessId,
    });
  }

  await db.insert(returnsTable).values({
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    governorate: order.governorate,
    productId: order.productId,
    productName: order.productName,
    quantity: order.quantity,
    totalAmount: order.totalAmount,
    returnReason,
    notes: notes ?? null,
    stockRestored: restoreStock,
    processedBy,
    businessId: order.businessId,
  });

  return {
    success: true,
    orderNumber: order.orderNumber,
    stockRestored: restoreStock,
  };
}

export async function getReturnsList(
  filters: {
    page?: number;
    limit?: number;
    governorate?: string;
    returnReason?: string;
    dateFrom?: Date;
    dateTo?: Date;
    businessId?: number;
  } = {}
) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const {
    page = 1,
    limit = 50,
    governorate,
    returnReason,
    dateFrom,
    dateTo,
    businessId,
  } = filters;
  const conditions: ReturnType<typeof eq>[] = [];
  if (businessId) conditions.push(eq(returnsTable.businessId, businessId));
  if (governorate) conditions.push(eq(returnsTable.governorate, governorate));
  if (returnReason)
    conditions.push(eq(returnsTable.returnReason, returnReason as any));
  if (dateFrom) conditions.push(gte(returnsTable.createdAt, dateFrom));
  if (dateTo) conditions.push(lte(returnsTable.createdAt, dateTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(returnsTable)
      .where(whereClause)
      .orderBy(desc(returnsTable.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(returnsTable)
      .where(whereClause),
  ]);
  return { items, total: Number(countResult[0]?.count ?? 0) };
}

export async function getReturnsStats(
  dateFrom?: Date,
  dateTo?: Date,
  businessId?: number
) {
  const db = await getDb();
  if (!db) return { total: 0, totalAmount: 0, byReason: [], byGovernorate: [] };
  const conditions: ReturnType<typeof eq>[] = [];
  if (businessId) conditions.push(eq(returnsTable.businessId, businessId));
  if (dateFrom) conditions.push(gte(returnsTable.createdAt, dateFrom));
  if (dateTo) conditions.push(lte(returnsTable.createdAt, dateTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [totals, byReason, byGovernorate] = await Promise.all([
    db
      .select({
        total: sql<number>`COUNT(*)`,
        totalAmount: sql<number>`SUM(totalAmount)`,
      })
      .from(returnsTable)
      .where(whereClause),
    db
      .select({
        reason: returnsTable.returnReason,
        count: sql<number>`COUNT(*)`,
      })
      .from(returnsTable)
      .where(whereClause)
      .groupBy(returnsTable.returnReason)
      .orderBy(desc(sql`COUNT(*)`)),
    db
      .select({
        governorate: returnsTable.governorate,
        count: sql<number>`COUNT(*)`,
      })
      .from(returnsTable)
      .where(whereClause)
      .groupBy(returnsTable.governorate)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10),
  ]);
  return {
    total: Number(totals[0]?.total ?? 0),
    totalAmount: Number(totals[0]?.totalAmount ?? 0),
    byReason,
    byGovernorate,
  };
}

// جرد الموظف
export async function getEmployeeInventory(employeeId: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select({
      total: sql<number>`COUNT(*)`,
      newOrders: sql<number>`SUM(CASE WHEN ${orders.status} = 'new' THEN 1 ELSE 0 END)`,
      confirmed: sql<number>`SUM(CASE WHEN ${orders.status} IN ('confirmed', 'printed') THEN 1 ELSE 0 END)`,
      cancelled: sql<number>`SUM(CASE WHEN ${orders.status} = 'cancelled' THEN 1 ELSE 0 END)`,
      postponed: sql<number>`SUM(CASE WHEN ${orders.status} = 'postponed' THEN 1 ELSE 0 END)`,
      noAnswer: sql<number>`SUM(CASE WHEN ${orders.status} = 'no_answer' THEN 1 ELSE 0 END)`,
      returned: sql<number>`SUM(CASE WHEN ${orders.status} = 'returned' THEN 1 ELSE 0 END)`,
      firstAssigned: sql<string>`MIN(${orders.assignedAt})`,
      lastAssigned: sql<string>`MAX(${orders.assignedAt})`,
    })
    .from(orders)
    .where(eq(orders.assignedEmployeeId, employeeId));

  return result[0] ?? null;
}

// استرداد كل أوردرات موظف
export async function reclaimEmployeeOrders(
  employeeId: number,
  statuses?: string[]
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions: any[] = [eq(orders.assignedEmployeeId, employeeId)];
  if (statuses && statuses.length > 0) {
    conditions.push(inArray(orders.status, statuses as any));
  } else {
    conditions.push(
      inArray(orders.status, ["new", "no_answer", "postponed"] as any)
    );
  }

  const result = await db
    .update(orders)
    .set({
      assignedEmployeeId: null,
      assignedAt: null,
    })
    .where(and(...conditions));

  return { count: (result as any)[0]?.affectedRows ?? 0 };
}

// ===== سجل الطباعات =====
export async function createPrintLog(data: {
  type: "shipping_sheet" | "labels";
  orderIds: number[];
  printedBy: number;
  printedByName: string;
  notes?: string;
  businessId?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  let businessId = data.businessId;
  if (businessId == null) {
    const orderBusinesses = await db
      .select({ businessId: orders.businessId })
      .from(orders)
      .where(inArray(orders.id, data.orderIds));
    const ids = [...new Set(orderBusinesses.map(row => row.businessId))];
    if (ids.length !== 1)
      throw new Error("سجل الطباعة لازم يخص Business واحد فقط");
    businessId = ids[0];
  }
  const result = await db.insert(printLogs).values({
    type: data.type,
    orderIds: JSON.stringify(data.orderIds),
    orderCount: data.orderIds.length,
    printedBy: data.printedBy,
    printedByName: data.printedByName,
    notes: data.notes || null,
    businessId,
  });
  return { id: result[0].insertId };
}

export async function getPrintLogs(limit = 50, businessId?: number) {
  const db = await getDb();
  const conditions: any[] = [];
  if (businessId) conditions.push(eq(printLogs.businessId, businessId));
  const rows = await db!
    .select()
    .from(printLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(printLogs.createdAt))
    .limit(limit);
  return rows.map(r => ({
    ...r,
    orderIds: JSON.parse(r.orderIds as string) as number[],
  }));
}

export async function getPrintLogById(id: number) {
  const db = await getDb();
  const rows = await db!
    .select()
    .from(printLogs)
    .where(eq(printLogs.id, id))
    .limit(1);
  if (!rows[0]) return null;
  return {
    ...rows[0],
    orderIds: JSON.parse(rows[0].orderIds as string) as number[],
  };
}

// ===== سجل الأنشطة (Activity Log) =====
export async function addActivityLog(data: {
  action: string;
  entityType: string;
  entityId?: number;
  description: string;
  metadata?: Record<string, any>;
  performedBy: number;
  performedByName: string;
  performedByRole: string;
  businessId?: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(activityLogs).values({
    action: data.action,
    entityType: data.entityType,
    entityId: data.entityId ?? null,
    description: data.description,
    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
    performedBy: data.performedBy,
    performedByName: data.performedByName,
    performedByRole: data.performedByRole,
    businessId: data.businessId ?? null,
  });
}

export async function getActivityLogs(
  filters: {
    page?: number;
    limit?: number;
    action?: string;
    entityType?: string;
    entityId?: number;
    performedBy?: number;
    dateFrom?: Date;
    dateTo?: Date;
    businessId?: number;
  } = {}
) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const {
    page = 1,
    limit = 50,
    action,
    entityType,
    entityId,
    performedBy,
    dateFrom,
    dateTo,
    businessId,
  } = filters;
  const conditions: ReturnType<typeof eq>[] = [];
  if (businessId) conditions.push(eq(activityLogs.businessId, businessId));
  if (action) conditions.push(eq(activityLogs.action, action));
  if (entityType) conditions.push(eq(activityLogs.entityType, entityType));
  if (entityId) conditions.push(eq(activityLogs.entityId, entityId));
  if (performedBy) conditions.push(eq(activityLogs.performedBy, performedBy));
  if (dateFrom) conditions.push(gte(activityLogs.createdAt, dateFrom));
  if (dateTo) conditions.push(lte(activityLogs.createdAt, dateTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(activityLogs)
      .where(whereClause)
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(activityLogs)
      .where(whereClause),
  ]);
  return { items, total: Number(countResult[0]?.count ?? 0) };
}

// ==================== SALES CHANNELS ====================
/**
 * Client-safe shape of a sales channel: the raw `apiToken`/`webhookSecret` are NEVER included.
 * Callers that need to show "is a secret configured?" get booleans plus the last 4 characters,
 * which is enough to identify a credential without exposing it.
 */
export type SafeSalesChannel = Omit<
  SalesChannel,
  "apiToken" | "webhookSecret"
> & {
  hasApiToken: boolean;
  apiTokenLast4: string | null;
  hasWebhookSecret: boolean;
  webhookSecretLast4: string | null;
};

function toSafeSalesChannel(row: SalesChannel): SafeSalesChannel {
  const { apiToken, webhookSecret, ...rest } = row;
  const last4 = (v: string | null | undefined) =>
    v && v.length > 0 ? v.slice(-4) : null;
  return {
    ...rest,
    hasApiToken: Boolean(apiToken),
    apiTokenLast4: last4(apiToken),
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretLast4: last4(webhookSecret),
  };
}

export async function getAllSalesChannels(
  businessId?: number,
  opts: { includeInactive?: boolean } = { includeInactive: true }
): Promise<SafeSalesChannel[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (!opts.includeInactive) conditions.push(eq(salesChannels.isActive, true));
  if (businessId) conditions.push(eq(salesChannels.businessId, businessId));
  const rows = await db
    .select()
    .from(salesChannels)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(salesChannels.createdAt));
  return rows.map(toSafeSalesChannel);
}

export async function getActiveSalesChannels(
  businessId?: number
): Promise<SafeSalesChannel[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(salesChannels.isActive, true)];
  if (businessId) conditions.push(eq(salesChannels.businessId, businessId));
  const rows = await db
    .select()
    .from(salesChannels)
    .where(and(...conditions))
    .orderBy(asc(salesChannels.name));
  return rows.map(toSafeSalesChannel);
}

export async function getSalesChannelById(
  id: number
): Promise<SafeSalesChannel | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(salesChannels)
    .where(eq(salesChannels.id, id))
    .limit(1);
  return result[0] ? toSafeSalesChannel(result[0]) : undefined;
}

/** True if `secret` is already used as the webhook secret of another channel (secrets must be unique to route webhooks unambiguously). */
export async function isWebhookSecretTaken(
  secret: string,
  excludeChannelId?: number
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = secret.trim();
  if (!trimmed) return false;
  const conditions: any[] = [eq(salesChannels.webhookSecret, trimmed)];
  if (excludeChannelId)
    conditions.push(sql`${salesChannels.id} != ${excludeChannelId}`);
  const match = await db
    .select({ id: salesChannels.id })
    .from(salesChannels)
    .where(and(...conditions))
    .limit(1);
  return match.length > 0;
}

/** True if an active channel with the same (trimmed, case-insensitive) name already exists for this business. */
export async function isSalesChannelNameTaken(
  businessId: number,
  name: string,
  excludeChannelId?: number
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const conditions: any[] = [
    eq(salesChannels.businessId, businessId),
    eq(salesChannels.isActive, true),
    sql`LOWER(TRIM(${salesChannels.name})) = LOWER(${trimmed})`,
  ];
  if (excludeChannelId)
    conditions.push(sql`${salesChannels.id} != ${excludeChannelId}`);
  const match = await db
    .select({ id: salesChannels.id })
    .from(salesChannels)
    .where(and(...conditions))
    .limit(1);
  return match.length > 0;
}

/**
 * SERVER-INTERNAL ONLY — returns the full row including secrets, for webhook routing.
 * Never expose the result of this through a tRPC procedure; use getSalesChannelById instead.
 */
export async function getSalesChannelByWebhookSecret(secret: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(salesChannels)
    .where(
      and(
        eq(salesChannels.webhookSecret, secret),
        eq(salesChannels.isActive, true)
      )
    )
    .limit(1);
  return result[0];
}

/** SERVER-INTERNAL ONLY — see getSalesChannelByWebhookSecret. */
export async function getSalesChannelByPlatformAndBusiness(
  platform: string,
  businessId?: number
) {
  const db = await getDb();
  if (!db) return undefined;
  const conditions: any[] = [
    eq(salesChannels.platform, platform as any),
    eq(salesChannels.isActive, true),
  ];
  if (businessId) conditions.push(eq(salesChannels.businessId, businessId));
  const result = await db
    .select()
    .from(salesChannels)
    .where(and(...conditions))
    .limit(1);
  return result[0];
}

export async function createSalesChannel(data: InsertSalesChannel) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(salesChannels).values(data);
  return { id: result[0].insertId };
}

export async function updateSalesChannel(
  id: number,
  data: Partial<InsertSalesChannel>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Secrets are write-only from the client's perspective: since the API never returns them,
  // an edit form can't round-trip them. `undefined` therefore means "leave unchanged" — only an
  // explicit non-empty value replaces a stored secret, so re-saving a form can't silently wipe one.
  const patch: Partial<InsertSalesChannel> = { ...data };
  if (patch.apiToken === undefined || patch.apiToken === "")
    delete patch.apiToken;
  if (patch.webhookSecret === undefined || patch.webhookSecret === "")
    delete patch.webhookSecret;
  if (Object.keys(patch).length === 0) return;
  await db.update(salesChannels).set(patch).where(eq(salesChannels.id, id));
}

/** Explicitly clears one stored secret (the only way to remove one, since update() ignores empty values). */
export async function clearSalesChannelSecret(
  id: number,
  field: "apiToken" | "webhookSecret"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(salesChannels)
    .set({ [field]: null })
    .where(eq(salesChannels.id, id));
}

export async function deleteSalesChannel(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Soft delete - just deactivate
  await db
    .update(salesChannels)
    .set({ isActive: false })
    .where(eq(salesChannels.id, id));
}

export async function reactivateSalesChannel(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(salesChannels)
    .set({ isActive: true })
    .where(eq(salesChannels.id, id));
}

/** SERVER-INTERNAL ONLY — full row incl. secrets, for the sync client. Never route to a client. */
export async function getSalesChannelWithSecrets(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(salesChannels)
    .where(eq(salesChannels.id, id))
    .limit(1);
  return result[0];
}

export async function updateSalesChannelSyncStatus(
  id: number,
  status: {
    lastSyncStatus: "success" | "error";
    lastSyncError?: string | null;
    lastSyncedOrderCount?: number;
  }
) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(salesChannels)
    .set({
      lastSyncAt: new Date(),
      lastSyncStatus: status.lastSyncStatus,
      lastSyncError: status.lastSyncError ?? null,
      ...(status.lastSyncedOrderCount !== undefined
        ? { lastSyncedOrderCount: status.lastSyncedOrderCount }
        : {}),
    })
    .where(eq(salesChannels.id, id));
}

/**
 * Records the outcome of a read-only connection test. This is the ONLY write a connection
 * test performs — it never touches orders, products or sync logs.
 */
export async function updateSalesChannelConnectionStatus(
  id: number,
  result: {
    connected: boolean;
    storeName?: string | null;
    errorCode?: string;
    errorMessage?: string;
  }
) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(salesChannels)
    .set({
      lastConnectionTestAt: new Date(),
      lastConnectionStatus: result.connected ? "connected" : "failed",
      lastConnectionError: result.connected
        ? null
        : [result.errorCode, result.errorMessage].filter(Boolean).join(": ") ||
          null,
      // Only overwrite the stored store name when the provider actually reported one, so a
      // later endpoint that omits it doesn't erase a previously-discovered value.
      ...(result.connected && result.storeName
        ? { externalStoreName: result.storeName }
        : {}),
    })
    .where(eq(salesChannels.id, id));
}

// ==================== SYNC LOGS ====================
export async function createSyncLog(data: InsertSyncLog): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(syncLogs).values(data);
  return (result as any).insertId as number;
}

export async function finishSyncLog(id: number, data: Partial<InsertSyncLog>) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(syncLogs)
    .set({ ...data, finishedAt: new Date() })
    .where(eq(syncLogs.id, id));
}

export async function getSyncLogs(
  filters: { channelId?: number; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters.channelId)
    conditions.push(eq(syncLogs.channelId, filters.channelId));
  return db
    .select()
    .from(syncLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(syncLogs.startedAt))
    .limit(filters.limit ?? 50);
}

/** Order lookup by the external system's order id — the idempotency key for imports. */
export async function getOrderByExternalId(
  externalOrderId: string,
  businessId?: number
) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.externalOrderId, externalOrderId),
        ...(businessId != null ? [eq(orders.businessId, businessId)] : [])
      )
    )
    .limit(1);
  return result[0];
}

/** Orders flagged for manual product review (unmatched/ambiguous external items). */
export async function getOrdersNeedingReview(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(orders)
    .where(eq(orders.needsReview, true))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

/** Full catalog needed by productMatching, in one round-trip. */
export async function getMatchCatalog(businessId?: number) {
  const db = await getDb();
  if (!db) return { products: [], variants: [] };
  const productConditions: any[] = [eq(products.isActive, true)];
  if (businessId) productConditions.push(eq(products.businessId, businessId));
  const productRows = await db
    .select()
    .from(products)
    .where(and(...productConditions));
  const productIds = productRows.map(p => p.id);
  const variantRows =
    productIds.length > 0
      ? await db
          .select()
          .from(productVariants)
          .where(
            and(
              inArray(productVariants.productId, productIds),
              eq(productVariants.isActive, true)
            )
          )
      : [];
  return {
    products: productRows.map(p => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      price: p.price,
      businessId: p.businessId,
    })),
    variants: variantRows.map(v => ({
      id: v.id,
      productId: v.productId,
      name: v.name,
      sku: v.sku,
      price: v.price,
      isActive: v.isActive,
    })),
  };
}

// ==================== PRODUCT VARIANTS ====================
export async function getVariantsByProduct(
  productId: number,
  opts: { includeInactive?: boolean } = {}
) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(productVariants.productId, productId)];
  if (!opts.includeInactive)
    conditions.push(eq(productVariants.isActive, true));
  return db
    .select()
    .from(productVariants)
    .where(and(...conditions))
    .orderBy(
      asc(productVariants.name),
      asc(productVariants.color),
      asc(productVariants.size)
    );
}

/** True if `sku` is already used by an active product or variant (SKUs are unique across both). */
export async function isSkuTaken(
  sku: string,
  opts: { excludeProductId?: number; excludeVariantId?: number } = {}
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = sku.trim();
  if (!trimmed) return false;

  const productConditions: any[] = [eq(products.sku, trimmed)];
  if (opts.excludeProductId)
    productConditions.push(sql`${products.id} != ${opts.excludeProductId}`);
  const productMatch = await db
    .select({ id: products.id })
    .from(products)
    .where(and(...productConditions))
    .limit(1);
  if (productMatch.length > 0) return true;

  const variantConditions: any[] = [eq(productVariants.sku, trimmed)];
  if (opts.excludeVariantId)
    variantConditions.push(
      sql`${productVariants.id} != ${opts.excludeVariantId}`
    );
  const variantMatch = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(...variantConditions))
    .limit(1);
  return variantMatch.length > 0;
}

/** True if an active variant with the same (trimmed, case-insensitive) name already exists under this product. */
export async function isVariantNameTaken(
  productId: number,
  name: string,
  excludeVariantId?: number
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const conditions: any[] = [
    eq(productVariants.productId, productId),
    eq(productVariants.isActive, true),
    sql`LOWER(TRIM(${productVariants.name})) = LOWER(${trimmed})`,
  ];
  if (excludeVariantId)
    conditions.push(sql`${productVariants.id} != ${excludeVariantId}`);
  const match = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(...conditions))
    .limit(1);
  return match.length > 0;
}

export async function getVariantById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.id, id))
    .limit(1);
  return result[0];
}

export async function createVariant(data: InsertProductVariant) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(productVariants).values(data);
}

export async function updateVariant(
  id: number,
  data: Partial<InsertProductVariant>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(productVariants).set(data).where(eq(productVariants.id, id));
}

export async function deleteVariant(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Soft delete: نخفي الصنف بدل الحذف النهائي للحفاظ على سجلات المخزون المرتبطة
  await db
    .update(productVariants)
    .set({ isActive: false })
    .where(eq(productVariants.id, id));
}

/** Low-level stock delta with no audit trail — kept for internal/legacy callers. Prefer addVariantInventoryMovement. */
export async function updateVariantStock(variantId: number, delta: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(productVariants)
    .set({ currentStock: sql`${productVariants.currentStock} + ${delta}` })
    .where(eq(productVariants.id, variantId));
}

/** Records an audited stock movement for a variant (reason/notes) and applies the delta. Rejects if it would go negative. */
export async function addVariantInventoryMovement(data: {
  variantId: number;
  type: "in" | "out";
  quantity: number;
  reason?: string;
  notes?: string;
  orderId?: number;
  performedBy?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const variant = await getVariantById(data.variantId);
  if (!variant) throw new Error("الصنف غير موجود");
  if (data.type === "out" && data.quantity > variant.currentStock) {
    throw new Error(
      `الكمية الصادرة (${data.quantity}) أكبر من المخزون الحالي (${variant.currentStock})`
    );
  }
  const product = await getProductById(variant.productId);
  if (!product) throw new Error("المنتج غير موجود");
  const [business] = await db
    .select({ accountingGoLiveAt: businesses.accountingGoLiveAt })
    .from(businesses)
    .where(eq(businesses.id, product.businessId))
    .limit(1);
  if (business?.accountingGoLiveAt)
    throw new Error(
      "بعد Go-Live استخدم Purchase Receipt أو Reservation/Dispatch بدل الحركة اليدوية"
    );
  await db.insert(inventoryMovements).values({
    businessId: product.businessId,
    productId: variant.productId,
    variantId: variant.id,
    type: data.type,
    quantity: data.quantity,
    reason: data.reason || null,
    notes: data.notes || null,
    orderId: data.orderId ?? null,
    performedBy: data.performedBy ?? null,
  });
  const delta = data.type === "in" ? data.quantity : -data.quantity;
  await updateVariantStock(data.variantId, delta);
}

export async function getAllVariantsWithProduct(
  businessId?: number,
  businessIds?: number[],
  opts: { includeInactive?: boolean } = {}
) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (!opts.includeInactive)
    conditions.push(eq(productVariants.isActive, true));
  const allProducts = await getAllProducts(businessId, businessIds, {
    includeInactive: opts.includeInactive,
  });
  const productIds = allProducts.map(p => p.id);
  if (productIds.length === 0) return [];
  conditions.push(inArray(productVariants.productId, productIds));
  const variants = await db
    .select()
    .from(productVariants)
    .where(and(...conditions))
    .orderBy(
      asc(productVariants.name),
      asc(productVariants.color),
      asc(productVariants.size)
    );
  return variants.map(v => {
    const product = allProducts.find(p => p.id === v.productId);
    return {
      ...v,
      productName: product?.name || "Unknown",
      businessId: product?.businessId,
    };
  });
}

// ==================== ORDER EDIT LOGS ====================

export async function logOrderEdit(data: InsertOrderEditLog) {
  const db = await getDb();
  if (!db) return;
  await db.insert(orderEditLogs).values(data);
}

export async function logOrderEdits(entries: InsertOrderEditLog[]) {
  const db = await getDb();
  if (!db) return;
  if (entries.length === 0) return;
  await db.insert(orderEditLogs).values(entries);
}

export async function getOrderEditLogs(orderId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(orderEditLogs)
    .where(eq(orderEditLogs.orderId, orderId))
    .orderBy(desc(orderEditLogs.createdAt));
}

// Full order edit with change tracking
export async function editOrderFull(
  orderId: number,
  updates: Record<string, any>,
  editor: { id: number; name: string; role: string }
) {
  const db = await getDb();
  if (!db) return null;

  // Get current order
  const [currentOrder] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!currentOrder) return null;

  updates = withNormalizedPhoneFields(updates);

  // Track changes
  const editLogEntries: InsertOrderEditLog[] = [];
  const FIELD_LABELS: Record<string, string> = {
    customerName: "اسم العميل",
    customerPhone: "رقم الهاتف",
    customerPhone2: "هاتف بديل",
    customerAddress: "العنوان",
    governorate: "المحافظة",
    city: "المدينة/المركز",
    productId: "المنتج",
    productName: "اسم المنتج",
    quantity: "الكمية",
    totalAmount: "الإجمالي",
    shippingFees: "رسوم الشحن",
    paymentMethod: "وسيلة الدفع",
    notes: "ملاحظات العميل",
    employeeNotes: "ملاحظات الموظف",
    variantId: "المتغير",
    color: "اللون",
    size: "المقاس",
  };

  const allowedFields = Object.keys(FIELD_LABELS);
  const orderUpdates: Record<string, any> = {};

  for (const field of allowedFields) {
    if (field in updates) {
      const oldVal = String((currentOrder as any)[field] ?? "");
      const newVal = String(updates[field] ?? "");
      if (oldVal !== newVal) {
        editLogEntries.push({
          orderId,
          field,
          oldValue: oldVal,
          newValue: newVal,
          editedBy: editor.id,
          editedByName: editor.name,
          editedByRole: editor.role,
        });
        orderUpdates[field] = updates[field];
      }
    }
  }

  if (Object.keys(orderUpdates).length === 0) return currentOrder;

  // Handle inventory changes if quantity changed. Skipped for orders with no resolved
  // product (needsReview) — they have never deducted stock, so there is nothing to adjust.
  if (
    "quantity" in orderUpdates &&
    currentOrder.status === "confirmed" &&
    currentOrder.productId != null
  ) {
    const productId = currentOrder.productId;
    const oldQty = currentOrder.quantity;
    const newQty = orderUpdates.quantity;
    const diff = newQty - oldQty;
    if (diff !== 0) {
      // Deduct additional from stock if increased, restore if decreased
      await updateProductStock(productId, -diff);
      await addInventoryMovement({
        businessId: currentOrder.businessId,
        productId,
        type: diff > 0 ? "out" : "in",
        quantity: Math.abs(diff),
        reason: `تعديل كمية أوردر #${currentOrder.orderNumber}`,
        orderId: currentOrder.id,
        performedBy: editor.id,
      });
    }
  }

  // Apply updates
  orderUpdates.lastUpdatedBy = editor.id;
  await db.update(orders).set(orderUpdates).where(eq(orders.id, orderId));

  // Log edits
  if (editLogEntries.length > 0) {
    await logOrderEdits(editLogEntries);
    // Also log in activity log
    await addActivityLog({
      businessId: currentOrder.businessId,
      action: "edit_order",
      entityType: "order",
      entityId: orderId,
      description: `تعديل أوردر #${currentOrder.orderNumber}: ${editLogEntries.map(e => FIELD_LABELS[e.field] || e.field).join("، ")}`,
      metadata: {
        changes: editLogEntries.map(e => ({
          field: e.field,
          old: e.oldValue,
          new: e.newValue,
        })),
      },
      performedBy: editor.id,
      performedByName: editor.name,
      performedByRole: editor.role,
    });
  }

  // Return updated order
  const [updated] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId));
  return updated;
}

// ==================== ORDER ITEMS (بنود الأوردر المتعددة) ====================

/**
 * استبدال بنود أوردر بالكامل (حذف القديم وإضافة الجديد)
 * كل بند: { productId?, productName, quantity, unitPrice? }
 */
async function replaceOrderItemsInTransaction(
  tx: any,
  orderId: number,
  items: OrderItemWrite[]
): Promise<void> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)
    .for("update");
  if (!order) throw new Error("الأوردر غير موجود");
  const existing = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .for("update");
  if (
    existing.some(
      (item: OrderItem) =>
        item.stockOutQuantity > 0 || item.costCapturedAt != null
    )
  ) {
    throw new Error(
      "لا يمكن تعديل بنود الأوردر بعد خروج المخزون؛ استخدم Reversal موثق"
    );
  }
  if (items.length === 0)
    throw new Error("Order Items هي المصدر الإلزامي لبيانات الأوردر");
  if (
    items.some(item => !Number.isInteger(item.quantity) || item.quantity <= 0)
  )
    throw new Error("كمية بند الأوردر غير صالحة");

  const [business] = await tx
    .select()
    .from(businesses)
    .where(eq(businesses.id, order.businessId))
    .limit(1);
  const keys = items
    .filter(item => item.productId != null)
    .map(
      item => `product:${item.productId}:variant:${item.variantId ?? "base"}`
    );
  const balances =
    business?.defaultWarehouseId && keys.length > 0
      ? await tx
          .select()
          .from(inventoryBalances)
          .where(
            and(
              eq(inventoryBalances.businessId, order.businessId),
              eq(inventoryBalances.warehouseId, business.defaultWarehouseId),
              inArray(inventoryBalances.inventoryKey, keys)
            )
          )
      : [];
  const costByKey = new Map(
    balances.map(
      (balance: { inventoryKey: string; movingAverageCost: string }) => [
        balance.inventoryKey,
        balance.movingAverageCost,
      ]
    )
  );
  const grossWeights = items.map(item =>
    item.unitPrice != null
      ? multiplyMoney(item.quantity, item.unitPrice)
      : BigInt(item.quantity)
  );
  const customerShipping = toMinorUnits(order.shippingFees ?? "0");
  const productsNet = toMinorUnits(order.totalAmount) - customerShipping;
  if (productsNet < 0n)
    throw new Error("إجمالي الأوردر أقل من تكلفة الشحن على العميل");
  const netAllocations = allocateProportionally(productsNet, grossWeights);
  const shippingAllocations = allocateProportionally(
    customerShipping,
    items.map(item => BigInt(item.quantity))
  );
  await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
  await tx.insert(orderItems).values(
    items.map((item, index) => {
      const rawGross =
        item.unitPrice != null
          ? multiplyMoney(item.quantity, item.unitPrice)
          : netAllocations[index];
      const gross =
        rawGross < netAllocations[index] ? netAllocations[index] : rawGross;
      const key =
        item.productId == null
          ? null
          : `product:${item.productId}:variant:${item.variantId ?? "base"}`;
      return {
        orderId,
        productId: item.productId ?? null,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice:
          item.unitPrice != null
            ? item.unitPrice.toString()
            : fromMinorUnits(
                divideRounded(netAllocations[index], BigInt(item.quantity))
              ),
        grossAmountSnapshot: fromMinorUnits(gross),
        discountAmountSnapshot: fromMinorUnits(gross - netAllocations[index]),
        netAmountSnapshot: fromMinorUnits(netAllocations[index]),
        customerShippingSnapshot: fromMinorUnits(shippingAllocations[index]),
        projectedUnitCostSnapshot: key ? (costByKey.get(key) ?? null) : null,
        variantId: item.variantId ?? null,
        size: item.size ?? null,
        color: item.color ?? null,
      };
    })
  );
}

/**
 * A line as the confirmation employee typed it: an explicit price and discount per row,
 * not a total to be split afterwards.
 */
export type OrderItemEditorLine = {
  productId: number | null;
  productName: string;
  variantId: number | null;
  quantity: number;
  unitPrice: number;
  /** Discount in currency on the whole line, not per unit. */
  discount: number;
  size?: string | null;
  color?: string | null;
};

export type OrderItemsEditResult = {
  itemCount: number;
  totalQuantity: number;
  productsNet: string;
  shippingFees: string;
  totalAmount: string;
};

/**
 * Rewrite an order's lines from the confirmation screen, and re-roll the order header to
 * match — both inside one transaction.
 *
 * Separate from replaceOrderItems() on purpose. That one starts from `orders.totalAmount`
 * and splits it across lines proportionally, because its callers (import, webhook) know a
 * total and not a price breakdown. Here it is the other way round: the employee is looking
 * at the customer and typing "two of these at 250, one of those at 300, minus 50" — so the
 * lines are the truth and the total is derived. Routing this through the allocating path
 * would silently redistribute a discount the employee attached to one specific line.
 *
 * The header stays in sync because `orders.productName`, `.quantity`, `.totalAmount` are
 * read all over the app (orders table, Bosta export, dashboards) and are the only product
 * data older screens know about. First line wins for the display fields; quantity and money
 * are true sums.
 */
export async function replaceOrderItemsFromEditor(
  orderId: number,
  lines: OrderItemEditorLine[],
  shippingFeesInput: number | undefined,
  editor: { id: number; name: string; role: string }
): Promise<OrderItemsEditResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (lines.length === 0) throw new Error("الأوردر لازم يكون فيه بند واحد على الأقل");

  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0)
      throw new Error("الكمية لازم تكون رقم صحيح أكبر من صفر");
    if (!(line.unitPrice >= 0)) throw new Error("السعر لازم يكون صفر أو أكثر");
    if (!(line.discount >= 0)) throw new Error("الخصم لازم يكون صفر أو أكثر");
    if (multiplyMoney(line.quantity, line.unitPrice) < toMinorUnits(line.discount))
      throw new Error(`الخصم أكبر من قيمة البند: ${line.productName}`);
    if (!line.productName.trim()) throw new Error("اسم المنتج مطلوب في كل بند");
  }

  return db.transaction(async tx => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)
      .for("update");
    if (!order) throw new Error("الأوردر غير موجود");

    // Same guard replaceOrderItemsInTransaction enforces: once stock has left the warehouse
    // or cost has been captured, the lines are an accounting record and editing them in
    // place would desynchronise inventory and COGS. Confirmation happens before that point.
    const existing = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .for("update");
    if (
      existing.some(
        (item: OrderItem) => item.stockOutQuantity > 0 || item.costCapturedAt != null
      )
    ) {
      throw new Error(
        "لا يمكن تعديل بنود الأوردر بعد خروج المخزون؛ استخدم Reversal موثق"
      );
    }

    const grossPerLine = lines.map(l => multiplyMoney(l.quantity, l.unitPrice));
    const discountPerLine = lines.map(l => toMinorUnits(l.discount));
    const netPerLine = grossPerLine.map((gross, i) => gross - discountPerLine[i]);
    const productsNet = netPerLine.reduce((sum, n) => sum + n, 0n);

    const shippingMinor = toMinorUnits(
      shippingFeesInput ?? order.shippingFees ?? "0"
    );
    if (shippingMinor < 0n) throw new Error("رسوم الشحن لازم تكون صفر أو أكثر");
    const totalMinor = productsNet + shippingMinor;

    // Shipping is spread by unit count, matching how replaceOrderItemsInTransaction does it,
    // so a line's `customerShippingSnapshot` means the same thing whichever path wrote it.
    const shippingAllocations = allocateProportionally(
      shippingMinor,
      lines.map(l => BigInt(l.quantity))
    );

    const [business] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, order.businessId))
      .limit(1);
    const keys = lines
      .filter(l => l.productId != null)
      .map(l => `product:${l.productId}:variant:${l.variantId ?? "base"}`);
    const balances =
      business?.defaultWarehouseId && keys.length > 0
        ? await tx
            .select()
            .from(inventoryBalances)
            .where(
              and(
                eq(inventoryBalances.businessId, order.businessId),
                eq(inventoryBalances.warehouseId, business.defaultWarehouseId),
                inArray(inventoryBalances.inventoryKey, keys)
              )
            )
        : [];
    const costByKey = new Map(
      balances.map((b: { inventoryKey: string; movingAverageCost: string }) => [
        b.inventoryKey,
        b.movingAverageCost,
      ])
    );

    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await tx.insert(orderItems).values(
      lines.map((line, i) => {
        const key =
          line.productId == null
            ? null
            : `product:${line.productId}:variant:${line.variantId ?? "base"}`;
        return {
          orderId,
          productId: line.productId,
          productName: line.productName.trim(),
          quantity: line.quantity,
          unitPrice: line.unitPrice.toFixed(2),
          grossAmountSnapshot: fromMinorUnits(grossPerLine[i]),
          discountAmountSnapshot: fromMinorUnits(discountPerLine[i]),
          netAmountSnapshot: fromMinorUnits(netPerLine[i]),
          customerShippingSnapshot: fromMinorUnits(shippingAllocations[i]),
          projectedUnitCostSnapshot: key ? (costByKey.get(key) ?? null) : null,
          variantId: line.variantId,
          size: line.size ?? null,
          color: line.color ?? null,
        };
      })
    );

    const head = lines[0];
    const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);

    // Stock reconciliation.
    //
    // confirmOrder() deducts stock from the HEADER (`order.productId` × `order.quantity`)
    // whenever the business is pre-Go-Live. Rewriting the header here without compensating
    // would leave the deduction stranded at the old number: confirm two, edit to five, and
    // the warehouse ships five while the books show two gone.
    //
    // editOrderFull() covered the quantity case, but by calling updateProductStock() AND
    // addInventoryMovement() — which calls updateProductStock() itself — so it moved stock
    // twice per edit. That bug is left alone here rather than copied: this path writes one
    // ledger row and applies its delta once.
    //
    // Post-Go-Live is deliberately excluded. Stock there is reservations and dispatches,
    // not `products.currentStock`, and the guard above already refuses once any of it has
    // moved. Movements are written through `tx` so a failure rolls the lines back with them.
    if (order.status === "confirmed" && !business?.accountingGoLiveAt) {
      const oldProductId = order.productId;
      const oldQuantity = order.quantity ?? 0;
      const moves: { productId: number; delta: number }[] = [];
      if (oldProductId != null && head.productId === oldProductId) {
        const diff = totalQuantity - oldQuantity;
        if (diff !== 0) moves.push({ productId: oldProductId, delta: -diff });
      } else {
        // Product swapped — give the old one back in full, take the new one in full.
        if (oldProductId != null && oldQuantity > 0)
          moves.push({ productId: oldProductId, delta: oldQuantity });
        if (head.productId != null && totalQuantity > 0)
          moves.push({ productId: head.productId, delta: -totalQuantity });
      }

      for (const move of moves) {
        const [product] = await tx
          .select({ id: products.id, currentStock: products.currentStock })
          .from(products)
          .where(eq(products.id, move.productId))
          .limit(1)
          .for("update");
        if (!product) continue; // product deleted since the order was placed
        if (move.delta < 0 && product.currentStock < -move.delta) {
          throw new Error(
            `المخزون غير كافي للتعديل (المتاح: ${product.currentStock}، المطلوب: ${-move.delta})`
          );
        }
        await tx.insert(inventoryMovements).values({
          businessId: order.businessId,
          productId: move.productId,
          type: move.delta < 0 ? "out" : "in",
          quantity: Math.abs(move.delta),
          reason: `تعديل بنود أوردر ${order.orderNumber}`,
          orderId: order.id,
          performedBy: editor.id,
        });
        await tx
          .update(products)
          .set({ currentStock: sql`${products.currentStock} + ${move.delta}` })
          .where(eq(products.id, move.productId));
      }
    }

    const headerUpdates = {
      productId: head.productId,
      productName: head.productName.trim(),
      variantId: head.variantId,
      size: head.size ?? null,
      color: head.color ?? null,
      quantity: totalQuantity,
      totalAmount: fromMinorUnits(totalMinor, 2),
      shippingFees: fromMinorUnits(shippingMinor, 2),
      lastUpdatedBy: editor.id,
      lastUpdatedAt: new Date(),
    };
    await tx.update(orders).set(headerUpdates).where(eq(orders.id, orderId));

    // One log line describing the whole basket. Field-by-field diffing the way editOrderFull
    // does would produce noise ("الكمية 2 → 5") that hides what actually changed.
    const summary = lines
      .map(l => `${l.productName} ×${l.quantity} @ ${l.unitPrice}`)
      .join(" | ");
    await tx.insert(orderEditLogs).values({
      orderId,
      field: "orderItems",
      oldValue: existing
        .map((i: OrderItem) => `${i.productName} ×${i.quantity}`)
        .join(" | "),
      newValue: summary,
      editedBy: editor.id,
      editedByName: editor.name,
      editedByRole: editor.role,
    });

    return {
      itemCount: lines.length,
      totalQuantity,
      productsNet: fromMinorUnits(productsNet, 2),
      shippingFees: fromMinorUnits(shippingMinor, 2),
      totalAmount: fromMinorUnits(totalMinor, 2),
    };
  });
}

export async function replaceOrderItems(
  orderId: number,
  items: OrderItemWrite[]
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.transaction(tx =>
    replaceOrderItemsInTransaction(tx, orderId, items)
  );
}

/**
 * بند أوردر مع اسم نوع الحفر/المتغير الفعلي (product_variants.name) — لا يوجد نص محفوظ وقت
 * إنشاء الأوردر، فبيتجاب بـ join وقت القراءة عبر variantId الموجود بالفعل على كل بند. لو
 * الأوردر قديم قبل إضافة variants أو مفيهوش variant (منتج مفرد) بيرجع null.
 */
export type OrderItemWithVariant = OrderItem & { variantName: string | null };

/** جلب بنود أوردر واحد، مع اسم نوع الحفر لكل بند */
export async function getOrderItems(
  orderId: number
): Promise<OrderItemWithVariant[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      ...getTableColumns(orderItems),
      variantName: productVariants.name,
    })
    .from(orderItems)
    .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);
  return rows;
}

/** جلب بنود عدة أوردرات دفعة واحدة (مفهرسة حسب orderId)، مع اسم نوع الحفر لكل بند */
export async function getOrderItemsForOrders(
  orderIds: number[]
): Promise<Map<number, OrderItemWithVariant[]>> {
  const map = new Map<number, OrderItemWithVariant[]>();
  if (orderIds.length === 0) return map;
  const db = await getDb();
  if (!db) return map;
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({
      ...getTableColumns(orderItems),
      variantName: productVariants.name,
    })
    .from(orderItems)
    .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(orderItems.id);
  for (const r of rows) {
    const list = map.get(r.orderId) ?? [];
    list.push(r);
    map.set(r.orderId, list);
  }
  return map;
}

// ==================== ACCOUNTING ====================
//
// قاعدة واحدة تحكم الملف ده كله: `treasury_transactions` هو الـledger الوحيد. أي حركة
// مالية بتنزل فيه صف، ورصيد الخزنة هو `balanceAfter` لآخر صف — مش SUM محسوب عند كل
// قراءة. السبب إن الأرصدة التاريخية لازم تفضل ثابتة: لو حسبناها بالجمع، إدخال حركة
// بتاريخ قديم كان هيحرّك كل الأرصدة اللي بعدها ويخلي التاجر مايقدرش يطابق كشف قديم.

/** رصيد الخزنة الحالي = balanceAfter لآخر حركة. صفر لو مفيش حركات. */
export async function getTreasuryBalance(
  businessIds?: number[] | null
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions =
    businessIds && businessIds.length > 0
      ? [inArray(treasuryTransactions.businessId, businessIds)]
      : [];
  const [row] = await db
    .select({ balanceAfter: treasuryTransactions.balanceAfter })
    .from(treasuryTransactions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(treasuryTransactions.id))
    .limit(1);
  return row ? Number(row.balanceAfter) : 0;
}

/**
 * إضافة حركة للخزنة مع حساب الرصيد بعدها.
 *
 * جوه transaction عن قصد: قراءة آخر رصيد ثم الكتابة عمليتان، ولو حركتين اتنفذوا في نفس
 * اللحظة الاتنين هيقروا نفس الرصيد القديم ويكتبوا نفس `balanceAfter` — ووقتها الـledger
 * بيكدب. الـtransaction بتخلي الاتنين يتسلسلوا.
 *
 * ملحوظة: كل الحركات في نفس الـbusiness بتشترك في سلسلة رصيد واحدة، فالرصيد بيتقرا
 * لنفس الـbusinessId بس مش لكل الأنشطة.
 */
export async function addTreasuryTransaction(
  data: Omit<InsertTreasuryTransaction, "balanceAfter">
): Promise<TreasuryTransaction | null> {
  const db = await getDb();
  if (!db) return null;
  const signed =
    data.direction === "in" ? Number(data.amount) : -Number(data.amount);

  return db.transaction(async tx => {
    const [last] = await tx
      .select({ balanceAfter: treasuryTransactions.balanceAfter })
      .from(treasuryTransactions)
      .where(eq(treasuryTransactions.businessId, data.businessId))
      .orderBy(desc(treasuryTransactions.id))
      .limit(1);
    const balanceAfter = (last ? Number(last.balanceAfter) : 0) + signed;
    const result: any = await tx.insert(treasuryTransactions).values({
      ...data,
      balanceAfter: balanceAfter.toFixed(2),
    });
    const insertId = result?.insertId ?? result?.[0]?.insertId;
    if (!insertId) return null;
    const [row] = await tx
      .select()
      .from(treasuryTransactions)
      .where(eq(treasuryTransactions.id, Number(insertId)))
      .limit(1);
    return row ?? null;
  });
}

export type TreasuryFilters = {
  businessIds?: number[] | null;
  type?: string;
  direction?: "in" | "out";
  performedBy?: number;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
  page?: number;
  limit?: number;
  /** يدمج أحداث "أوردر جديد" في السجل — عرض فقط، بدون أي أثر على الرصيد. */
  includeOrderEvents?: boolean;
};

/**
 * حدث "أوردر جديد" في سجل الحركة المالية.
 *
 * أوردر جديد **مش حركة نقدية** — هو التزام، الفلوس لسه مادخلتش. فلو نزل الخزنة كحركة
 * `in` كان رصيد الخزنة بيبقى خيال: بيعرض فلوس لسه مع شركة الشحن كأنها في الدُرج.
 *
 * فالحدث بيتعرض في السجل عشان التاجر يشوف الصورة كاملة في تايم‌لاين واحد، لكن بـ
 * `balanceAfter: null` و`direction: null` — يعني ظاهر ومحسوب عليه صفر. اللي بيحوّله
 * لفلوس حقيقية هو التحصيل، وهو حركة منفصلة بترتبط بنفس الأوردر.
 */
export type LedgerRow = {
  id: string;
  kind: "cash" | "commitment";
  type: string;
  direction: "in" | "out" | null;
  amount: string;
  balanceAfter: string | null;
  description: string;
  notes: string | null;
  referenceType: string;
  referenceId: number | null;
  performedByName: string;
  transactionDate: Date;
};

export async function getTreasuryTransactions(filters: TreasuryFilters = {}) {
  const db = await getDb();
  if (!db)
    return {
      transactions: [],
      total: 0,
      page: 1,
      totalPages: 0,
      totalIn: 0,
      totalOut: 0,
    };
  const { page = 1, limit = 50 } = filters;

  const conditions: any[] = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(
      inArray(treasuryTransactions.businessId, filters.businessIds)
    );
  }
  if (filters.type)
    conditions.push(eq(treasuryTransactions.type, filters.type as any));
  if (filters.direction)
    conditions.push(eq(treasuryTransactions.direction, filters.direction));
  if (filters.performedBy)
    conditions.push(eq(treasuryTransactions.performedBy, filters.performedBy));
  if (filters.dateFrom)
    conditions.push(
      gte(treasuryTransactions.transactionDate, filters.dateFrom)
    );
  if (filters.dateTo)
    conditions.push(lte(treasuryTransactions.transactionDate, filters.dateTo));
  if (filters.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${treasuryTransactions.description} LIKE ${q}`,
        sql`${treasuryTransactions.notes} LIKE ${q}`,
        sql`${treasuryTransactions.performedByName} LIKE ${q}`
      )
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // العدّاد والإجماليات في استعلام واحد على كل الحركات المطابقة للفلاتر — مش على الصفحة
  // المعروضة. الكروت اللي فوق اسمها "إجمالي"، فلازم تكون إجمالي فعلاً: لو حسبت الصفحة بس
  // كان الرقم بيتغيّر لما المستخدم يقلب صفحة، وده اسم بيكدب على نفسه.
  const [countRow] = await db
    .select({
      count: sql<number>`count(*)`,
      totalIn: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'in' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      totalOut: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'out' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
    })
    .from(treasuryTransactions)
    .where(where);
  const total = Number(countRow?.count ?? 0);
  const totalIn = Number(countRow?.totalIn ?? 0);
  const totalOut = Number(countRow?.totalOut ?? 0);

  const transactions = await db
    .select()
    .from(treasuryTransactions)
    .where(where)
    .orderBy(
      desc(treasuryTransactions.transactionDate),
      desc(treasuryTransactions.id)
    )
    .limit(limit)
    .offset((page - 1) * limit);

  const cashRows: LedgerRow[] = transactions.map(t => ({
    id: `tx-${t.id}`,
    kind: "cash",
    type: t.type,
    direction: t.direction,
    amount: t.amount,
    balanceAfter: t.balanceAfter,
    description: t.description,
    notes: t.notes,
    referenceType: t.referenceType,
    referenceId: t.referenceId,
    performedByName: t.performedByName,
    transactionDate: t.transactionDate,
  }));

  if (!filters.includeOrderEvents) {
    return {
      transactions: cashRows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      totalIn,
      totalOut,
    };
  }

  // أحداث الأوردرات الجديدة — بتُدمج في صفحة النتائج المعروضة فقط.
  //
  // مقصودة إنها تدخل بعد الـpagination مش قبله: الترقيم بيفضل على الحركات النقدية (اللي
  // ليها أرصدة متسلسلة)، والالتزامات بتنضاف كسياق على نفس النطاق الزمني. لو دخلت في
  // الترقيم كان عدد الصفحات هيتغيّر بمجرد تشغيل الزر، والتاجر يفقد مكانه.
  const shown = cashRows
    .map(r => r.transactionDate.getTime())
    .filter(t => !Number.isNaN(t));
  const windowFrom =
    filters.dateFrom ??
    (shown.length > 0 ? new Date(Math.min(...shown)) : undefined);
  const windowTo =
    filters.dateTo ??
    (shown.length > 0 ? new Date(Math.max(...shown)) : undefined);

  const orderConditions: any[] = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    orderConditions.push(inArray(orders.businessId, filters.businessIds));
  }
  if (windowFrom) orderConditions.push(gte(orders.createdAt, windowFrom));
  if (windowTo) orderConditions.push(lte(orders.createdAt, windowTo));
  if (filters.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    orderConditions.push(
      or(
        sql`${orders.customerName} LIKE ${q}`,
        sql`${orders.orderNumber} LIKE ${q}`
      )
    );
  }

  const orderRows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerName: orders.customerName,
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
      source: orders.source,
    })
    .from(orders)
    .where(orderConditions.length > 0 ? and(...orderConditions) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  const commitmentRows: LedgerRow[] = orderRows.map(o => ({
    id: `order-${o.id}`,
    kind: "commitment",
    type: "order_new",
    direction: null,
    amount: o.totalAmount,
    balanceAfter: null,
    description: `أوردر جديد ${o.orderNumber} — ${o.customerName}`,
    notes: null,
    referenceType: "order",
    referenceId: o.id,
    performedByName: "—",
    transactionDate: o.createdAt,
  }));

  const merged = [...cashRows, ...commitmentRows].sort(
    (a, b) => b.transactionDate.getTime() - a.transactionDate.getTime()
  );

  return {
    transactions: merged,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    totalIn,
    totalOut,
  };
}

// ==================== EXPENSE CATEGORIES ====================

export async function getExpenseCategories(
  businessIds?: number[] | null,
  includeInactive = false
) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (businessIds && businessIds.length > 0) {
    conditions.push(inArray(expenseCategories.businessId, businessIds));
  }
  if (!includeInactive) conditions.push(eq(expenseCategories.isActive, true));
  return db
    .select()
    .from(expenseCategories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(expenseCategories.name));
}

export async function createExpenseCategory(data: InsertExpenseCategory) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result: any = await db.insert(expenseCategories).values(data);
  const insertId = result?.insertId ?? result?.[0]?.insertId;
  return { id: Number(insertId) };
}

export async function updateExpenseCategory(
  id: number,
  data: Partial<InsertExpenseCategory>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (Object.keys(data).length === 0) return;
  await db
    .update(expenseCategories)
    .set(data)
    .where(eq(expenseCategories.id, id));
}

/**
 * أرشفة التصنيف مش حذفه.
 *
 * المصروفات القديمة بتشاور على categoryId — والحذف كان هيخلي تقارير الشهور اللي فاتت
 * تعرض تصنيف مفقود. الأرشفة بتشيله من قوائم الاختيار وبتسيب التاريخ سليم.
 */
export async function archiveExpenseCategory(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [cat] = await db
    .select()
    .from(expenseCategories)
    .where(eq(expenseCategories.id, id))
    .limit(1);
  if (!cat) throw new Error("التصنيف غير موجود");
  if (cat.isSystem) throw new Error("لا يمكن حذف تصنيف أساسي");
  await db
    .update(expenseCategories)
    .set({ isActive: false })
    .where(eq(expenseCategories.id, id));
}

// ==================== EXPENSES ====================

export type ExpenseFilters = {
  businessIds?: number[] | null;
  categoryId?: number;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
  page?: number;
  limit?: number;
};

export async function getExpenses(filters: ExpenseFilters = {}) {
  const db = await getDb();
  if (!db)
    return { expenses: [], total: 0, page: 1, totalPages: 0, totalAmount: 0 };
  const { page = 1, limit = 50 } = filters;

  const conditions: any[] = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(inArray(expenses.businessId, filters.businessIds));
  }
  if (filters.categoryId)
    conditions.push(eq(expenses.categoryId, filters.categoryId));
  if (filters.dateFrom)
    conditions.push(gte(expenses.expenseDate, filters.dateFrom));
  if (filters.dateTo)
    conditions.push(lte(expenses.expenseDate, filters.dateTo));
  if (filters.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${expenses.description} LIKE ${q}`,
        sql`${expenses.reference} LIKE ${q}`,
        sql`${expenses.createdByName} LIKE ${q}`
      )
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [agg] = await db
    .select({
      count: sql<number>`count(*)`,
      sum: sql<string>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .where(where);
  const total = Number(agg?.count ?? 0);

  // اسم التصنيف بـleftJoin: مصروف بتصنيف مؤرشف أو محذوف لازم يفضل ظاهر، فالـjoin
  // مايقدرش يبقى inner.
  const rows = await db
    .select({
      ...getTableColumns(expenses),
      categoryName: expenseCategories.name,
    })
    .from(expenses)
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(where)
    .orderBy(desc(expenses.expenseDate), desc(expenses.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return {
    expenses: rows,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    totalAmount: Number(agg?.sum ?? 0),
  };
}

/** Legacy writer kept for existing screens. Payment is intentionally separate in V2. */
export async function createExpense(data: InsertExpense) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result: any = await db.insert(expenses).values(data);
  const insertId = Number(result?.insertId ?? result?.[0]?.insertId);
  if (!insertId) throw new Error("تعذر إنشاء المصروف");

  return { id: insertId };
}

/**
 * تعديل المسودة فقط. بعد الاعتماد التغيير يتم بـVoid أو Adjustment موثق.
 */
export async function updateExpense(
  id: number,
  data: Partial<InsertExpense>,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [before] = await db
    .select()
    .from(expenses)
    .where(eq(expenses.id, id))
    .limit(1);
  if (!before) throw new Error("المصروف غير موجود");
  if (before.status !== "draft")
    throw new Error("لا يمكن تعديل المصروف بعد إرساله للاعتماد");
  if (Object.keys(data).length === 0) return;

  await db.update(expenses).set(data).where(eq(expenses.id, id));
}

/** حذف مسودة فقط؛ المصروف المعتمد لا يُحذف. */
export async function deleteExpense(
  id: number,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [before] = await db
    .select()
    .from(expenses)
    .where(eq(expenses.id, id))
    .limit(1);
  if (!before) throw new Error("المصروف غير موجود");
  if (before.status !== "draft")
    throw new Error("لا يمكن حذف المصروف بعد إرساله للاعتماد");

  await db.delete(expenses).where(eq(expenses.id, id));
}

// ==================== COLLECTIONS (التحصيلات) ====================

export type CollectionFilters = {
  businessIds?: number[] | null;
  collectionStatus?: string;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
  page?: number;
  limit?: number;
};

/**
 * الأوردرات من منظور التحصيل.
 *
 * النطاق: الأوردرات اللي خرجت للشحن فعلاً (shipped/delivered/returned/printed/preparing).
 * أوردر لسه "جديد" أو "ملغي" مالوش مبلغ متوقع للتحصيل، فوجوده هنا كان هيخلي "المعلّق"
 * رقم بلا معنى.
 */
export async function getCollections(filters: CollectionFilters = {}) {
  const db = await getDb();
  if (!db)
    return {
      orders: [],
      total: 0,
      page: 1,
      totalPages: 0,
      expectedTotal: 0,
      collectedTotal: 0,
    };
  const { page = 1, limit = 50 } = filters;

  const conditions: any[] = [
    inArray(orders.status, [
      "printed",
      "preparing",
      "shipped",
      "delivered",
      "returned",
    ] as any),
  ];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(inArray(orders.businessId, filters.businessIds));
  }
  if (filters.collectionStatus) {
    conditions.push(
      eq(orders.collectionStatus, filters.collectionStatus as any)
    );
  }
  if (filters.dateFrom)
    conditions.push(gte(orders.shippedAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(orders.shippedAt, filters.dateTo));
  if (filters.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${orders.customerName} LIKE ${q}`,
        sql`${orders.orderNumber} LIKE ${q}`,
        sql`${orders.customerPhone} LIKE ${q}`
      )
    );
  }
  const where = and(...conditions);

  const [agg] = await db
    .select({
      count: sql<number>`count(*)`,
      expected: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      collected: sql<string>`COALESCE(SUM(${orders.collectedAmount}), 0)`,
    })
    .from(orders)
    .where(where);

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      governorate: orders.governorate,
      status: orders.status,
      totalAmount: orders.totalAmount,
      shippingFees: orders.shippingFees,
      collectedAmount: orders.collectedAmount,
      collectedAt: orders.collectedAt,
      collectionStatus: orders.collectionStatus,
      bostaTrackingNumber: orders.bostaTrackingNumber,
      bostaShipmentId: orders.bostaShipmentId,
      shippedAt: orders.shippedAt,
      deliveredAt: orders.deliveredAt,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.shippedAt), desc(orders.id))
    .limit(limit)
    .offset((page - 1) * limit);

  // "الموظف الذي قام بالتحصيل" — مشتق من آخر حركة تحصيل للأوردر في الخزنة، مش من عمود
  // جديد على orders. الخزنة بتسجّل performedByName مع كل حركة أصلاً، فالمعلومة موجودة
  // ومضاف عمود denormalized كان هيبقى نسخة تانية ممكن تختلف عنها.
  const collectorByOrderId = new Map<number, string>();
  const orderIds = rows.map(r => r.id);
  if (orderIds.length > 0) {
    const collectors = await db
      .select({
        referenceId: treasuryTransactions.referenceId,
        performedByName: treasuryTransactions.performedByName,
        id: treasuryTransactions.id,
      })
      .from(treasuryTransactions)
      .where(
        and(
          eq(treasuryTransactions.referenceType, "order"),
          inArray(treasuryTransactions.referenceId, orderIds)
        )
      )
      .orderBy(asc(treasuryTransactions.id));
    // الترتيب تصاعدي والكتابة بتستبدل، فآخر حركة هي اللي تفضل — وهي آخر مين لمس التحصيل
    for (const c of collectors) {
      if (c.referenceId != null)
        collectorByOrderId.set(c.referenceId, c.performedByName);
    }
  }

  const total = Number(agg?.count ?? 0);
  return {
    orders: rows.map(r => ({
      ...r,
      collectedByName: collectorByOrderId.get(r.id) ?? null,
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit),
    expectedTotal: Number(agg?.expected ?? 0),
    collectedTotal: Number(agg?.collected ?? 0),
  };
}

/**
 * تسجيل تحصيل أوردر + حركة الخزنة المقابلة.
 *
 * الحالة بتتحدد من الأرقام مش من إدخال المستخدم: صفر = failed، أقل من المتوقع = partial،
 * المتوقع أو أكتر = collected. كده مستحيل يبقى فيه أوردر محصّل بالكامل وحالته "معلّق".
 */
export async function recordOrderCollection(
  orderId: number,
  collectedAmount: number,
  actor: { id: number; name: string },
  collectedAt?: Date
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw new Error("الأوردر غير موجود");

  const expected = Number(order.totalAmount);
  const previous =
    order.collectedAmount != null ? Number(order.collectedAmount) : 0;
  const status =
    collectedAmount <= 0
      ? "failed"
      : collectedAmount < expected
        ? "partial"
        : "collected";
  const when = collectedAt ?? new Date();

  await db
    .update(orders)
    .set({
      collectedAmount: collectedAmount.toFixed(2),
      collectedAt: when,
      collectionStatus: status as any,
    })
    .where(eq(orders.id, orderId));

  // بنسجّل الفرق مش المبلغ كامل: لو التحصيل اتصحّح من ٤٠٠ لـ٤٥٠، اللي دخل الخزنة
  // فعلاً هو ٥٠ — تسجيل ٤٥٠ تاني كان هيحسب الأوردر مرتين.
  const delta = collectedAmount - previous;
  if (delta !== 0) {
    await addTreasuryTransaction({
      businessId: order.businessId,
      type: previous === 0 ? "collection" : "adjustment",
      direction: delta > 0 ? "in" : "out",
      amount: Math.abs(delta).toFixed(2),
      description: `تحصيل أوردر ${order.orderNumber} — ${order.customerName}`,
      notes:
        previous === 0
          ? undefined
          : `تصحيح من ${previous.toFixed(2)} إلى ${collectedAmount.toFixed(2)}`,
      referenceType: "order",
      referenceId: orderId,
      performedBy: actor.id,
      performedByName: actor.name,
      transactionDate: when,
    } as any);
  }
  return { status, delta };
}

// ==================== ACCOUNTING DASHBOARD ====================

/**
 * مؤشرات لوحة الحسابات.
 *
 * كل رقم هنا محسوب من الجداول الموجودة مباشرة — مفيش قيم مخزّنة مجمّعة تحتاج مزامنة.
 * تكلفة المنتجات بتتحسب من costPrice في وقت القراءة، فمعناها "التكلفة بالسعر الحالي"
 * مش "التكلفة وقت البيع": النظام مابيصوّرش سعر التكلفة على الأوردر، وده مرصود كنقص.
 */
export async function getAccountingDashboard(params: {
  businessIds?: number[] | null;
  dateFrom?: Date;
  dateTo?: Date;
}) {
  const db = await getDb();
  const empty = {
    totalSales: 0,
    totalCollected: 0,
    shippingCost: 0,
    productCost: 0,
    totalExpenses: 0,
    totalReturns: 0,
    treasuryBalance: 0,
    netProfit: 0,
    pendingCollection: 0,
    profitMargin: 0,
    todaySales: 0,
    todayOrders: 0,
    monthSales: 0,
    monthOrders: 0,
    movementByDay: [] as { day: string; inflow: number; outflow: number }[],
  };
  if (!db) return empty;

  const { businessIds, dateFrom, dateTo } = params;
  const scope = (col: any) =>
    businessIds && businessIds.length > 0 ? [inArray(col, businessIds)] : [];
  const range = (col: any) => {
    const c: any[] = [];
    if (dateFrom) c.push(gte(col, dateFrom));
    if (dateTo) c.push(lte(col, dateTo));
    return c;
  };
  const whereOf = (conds: any[]) =>
    conds.length > 0 ? and(...conds) : undefined;

  // المبيعات والشحن: الأوردرات اللي وصلت مرحلة الشحن. الملغي والجديد مش مبيعات.
  const soldStatuses = [
    "printed",
    "preparing",
    "shipped",
    "delivered",
    "returned",
  ] as any;
  const [sales] = await db
    .select({
      sales: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      shipping: sql<string>`COALESCE(SUM(${orders.shippingFees}), 0)`,
      collected: sql<string>`COALESCE(SUM(${orders.collectedAmount}), 0)`,
    })
    .from(orders)
    .where(
      whereOf([
        inArray(orders.status, soldStatuses),
        ...scope(orders.businessId),
        ...range(orders.createdAt),
      ])
    );

  // مبيعات اليوم والشهر — مستقلّة عن فلتر التاريخ عن قصد.
  //
  // البطاقتين دول بيجاوبوا "إيه اللي بيحصل دلوقتي؟"، فلازم يفضلوا ثابتين لما التاجر
  // يفلتر على شهر قديم. لو خضعوا للفلتر كانوا هيقولوا "مبيعات اليوم: صفر" وهو بيبص على
  // مارس، وده رقم صح بمعنى غلط. بتوقيت القاهرة زي باقي حسابات "اليوم" في النظام.
  const cairoTodayKey = businessDateKey(new Date(), CAIRO_TIMEZONE);
  const todayStart = businessDayRange(cairoTodayKey, CAIRO_TIMEZONE).from;
  const monthStart = businessDayRange(
    `${cairoTodayKey.slice(0, 7)}-01`,
    CAIRO_TIMEZONE
  ).from;

  const [todayRow] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .where(
      whereOf([
        inArray(orders.status, soldStatuses),
        gte(orders.createdAt, todayStart),
        ...scope(orders.businessId),
      ])
    );

  const [monthRow] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .where(
      whereOf([
        inArray(orders.status, soldStatuses),
        gte(orders.createdAt, monthStart),
        ...scope(orders.businessId),
      ])
    );

  // المعلّق: المتوقع ناقص المحصّل للأوردرات اللي لسه مش محصّلة
  const [pending] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${orders.totalAmount} - COALESCE(${orders.collectedAmount}, 0)), 0)`,
    })
    .from(orders)
    .where(
      whereOf([
        inArray(orders.status, soldStatuses),
        inArray(orders.collectionStatus, ["pending", "partial"] as any),
        ...scope(orders.businessId),
        ...range(orders.createdAt),
      ])
    );

  // تكلفة المنتجات: من بنود الأوردر مضروبة في costPrice للـvariant.
  //
  // نقص معروف: `costPrice` موجود على product_variants بس، مش على products. يعني منتج
  // بدون variants (زي "مسند سيارة") تكلفته بتتحسب صفر، والرقم ده أقل من الحقيقي.
  // الإصلاح محتاج عمود products.costPrice — مرصود للمرحلة الجاية ومش داخل في المطلوب هنا.
  const [cost] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${orderItems.quantity} * COALESCE(${productVariants.costPrice}, 0)), 0)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
    .where(
      whereOf([
        inArray(orders.status, soldStatuses),
        ...scope(orders.businessId),
        ...range(orders.createdAt),
      ])
    );

  const [exp] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .where(
      whereOf([...scope(expenses.businessId), ...range(expenses.expenseDate)])
    );

  const [ret] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${returnsTable.totalAmount}), 0)`,
    })
    .from(returnsTable)
    .where(
      whereOf([
        ...scope(returnsTable.businessId),
        ...range(returnsTable.returnedAt),
      ])
    );

  // الحركة المالية بالأيام — للرسم البياني
  const movement = await db
    .select({
      day: sql<string>`DATE(${treasuryTransactions.transactionDate})`,
      inflow: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'in' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      outflow: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'out' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
    })
    .from(treasuryTransactions)
    .where(
      whereOf([
        ...scope(treasuryTransactions.businessId),
        ...range(treasuryTransactions.transactionDate),
      ])
    )
    .groupBy(sql`DATE(${treasuryTransactions.transactionDate})`)
    .orderBy(sql`DATE(${treasuryTransactions.transactionDate})`);

  const totalSales = Number(sales?.sales ?? 0);
  const shippingCost = Number(sales?.shipping ?? 0);
  const productCost = Number(cost?.amount ?? 0);
  const totalExpenses = Number(exp?.amount ?? 0);
  const totalReturns = Number(ret?.amount ?? 0);
  // صافي الربح = المبيعات − (تكلفة المنتجات + الشحن + المصروفات + المرتجعات).
  // مبني على المبيعات مش على المحصّل عن قصد: ده ربح محقّق دفتريًا، والفرق بينه وبين
  // الكاش الفعلي هو "المعلّق" المعروض جنبه.
  const netProfit =
    totalSales - (productCost + shippingCost + totalExpenses + totalReturns);

  return {
    totalSales,
    totalCollected: Number(sales?.collected ?? 0),
    shippingCost,
    productCost,
    totalExpenses,
    totalReturns,
    pendingCollection: Number(pending?.amount ?? 0),
    treasuryBalance: await getTreasuryBalance(businessIds),
    netProfit,
    // هامش الربح كنسبة من المبيعات. القسمة محميّة: مفيش مبيعات معناها مفيش هامش (صفر)،
    // مش Infinity ولا NaN — والواجهة بتعرضه كنسبة على طول.
    profitMargin: totalSales > 0 ? (netProfit / totalSales) * 100 : 0,
    todaySales: Number(todayRow?.amount ?? 0),
    todayOrders: Number(todayRow?.count ?? 0),
    monthSales: Number(monthRow?.amount ?? 0),
    monthOrders: Number(monthRow?.count ?? 0),
    movementByDay: movement.map(m => ({
      day: String(m.day),
      inflow: Number(m.inflow),
      outflow: Number(m.outflow),
    })),
  };
}

/**
 * سجل تحصيل أوردر واحد — مين حصّل، امتى، وكام.
 *
 * مقروء من `treasury_transactions` مش من عمود على الأوردر: الأوردر بيحمل آخر قيمة
 * محصّلة بس، أما السجل ده فبيمسك كل خطوة (تحصيل أولي ٤٠٠، بعدين تصحيح +٥٠) واسم اللي
 * عملها. ده هو "سجل التحصيل" — الجدول موجود بالحقول دي أصلاً، فمفيش داعي لجدول تالت.
 */
export async function getOrderCollectionHistory(orderId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(treasuryTransactions)
    .where(
      and(
        eq(treasuryTransactions.referenceType, "order"),
        eq(treasuryTransactions.referenceId, orderId)
      )
    )
    .orderBy(
      asc(treasuryTransactions.transactionDate),
      asc(treasuryTransactions.id)
    );
}

/**
 * لوحة الخزنة — الأرقام اللي أمين الخزنة بيفتح الصفحة عشانها.
 *
 * مستقلّة عن فلاتر الجدول تحتها عن قصد: دي حالة الخزنة النهاردة، مش ملخّص للي المستخدم
 * فلتر عليه. لو خضعت للفلاتر كان "صافي اليوم" بيتغيّر لما حد يبحث عن كلمة، وهو رقم
 * المفروض يبقى ثابت.
 *
 * "أرباح الشهر" بتتقرا من `getAccountingDashboard` مش بمعادلة تانية هنا: تعريف الربح
 * لازم يفضل واحد في النظام كله، وأي نسخة تانية منه بتبقى رقم تالت يختلف عن التقارير.
 */
export async function getTreasurySummary(
  businessIds?: number[] | null,
  realizedMonthProfit?: number
) {
  const db = await getDb();
  const empty = {
    balance: 0,
    todayCollections: 0,
    todayExpenses: 0,
    todayNet: 0,
    monthProfit: 0,
    pendingCollection: 0,
    recentTransactions: [] as TreasuryTransaction[],
  };
  if (!db) return empty;

  const cairoTodayKey = businessDateKey(new Date(), CAIRO_TIMEZONE);
  const todayStart = businessDayRange(cairoTodayKey, CAIRO_TIMEZONE).from;
  const monthStart = businessDayRange(
    `${cairoTodayKey.slice(0, 7)}-01`,
    CAIRO_TIMEZONE
  ).from;

  const scopeTreasury =
    businessIds && businessIds.length > 0
      ? [inArray(treasuryTransactions.businessId, businessIds)]
      : [];

  // حركات النهاردة مقسّمة بالنوع والاتجاه في استعلام واحد
  const [today] = await db
    .select({
      collections: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.type} = 'collection' AND ${treasuryTransactions.direction} = 'in' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      expenses: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.type} = 'expense' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      inflow: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'in' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      outflow: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'out' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
    })
    .from(treasuryTransactions)
    .where(
      and(
        gte(treasuryTransactions.transactionDate, todayStart),
        ...scopeTreasury
      )
    );

  // المعلّق: كل الأوردرات اللي خرجت للشحن ولسه ماتحصّلتش بالكامل — بدون حد زمني.
  // فلوس بره من شهرين لسه بره، والحصر بالشهر الحالي كان هيخفيها.
  const scopeOrders =
    businessIds && businessIds.length > 0
      ? [inArray(orders.businessId, businessIds)]
      : [];
  const [pending] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${orders.totalAmount} - COALESCE(${orders.collectedAmount}, 0)), 0)`,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.status, [
          "printed",
          "preparing",
          "shipped",
          "delivered",
          "returned",
        ] as any),
        inArray(orders.collectionStatus, ["pending", "partial"] as any),
        ...scopeOrders
      )
    );

  const recentTransactions = await db
    .select()
    .from(treasuryTransactions)
    .where(scopeTreasury.length > 0 ? and(...scopeTreasury) : undefined)
    .orderBy(
      desc(treasuryTransactions.transactionDate),
      desc(treasuryTransactions.id)
    )
    .limit(10);

  return {
    balance: await getTreasuryBalance(businessIds),
    todayCollections: Number(today?.collections ?? 0),
    todayExpenses: Number(today?.expenses ?? 0),
    // صافي اليوم = كل الداخل − كل الخارج، مش التحصيلات ناقص المصروفات: الإيداع والسحب
    // والمرتجع بيأثروا على الكاش برضه، وحصره في نوعين كان بيخلي الرقم مش مطابق للرصيد.
    todayNet: Number(today?.inflow ?? 0) - Number(today?.outflow ?? 0),
    // V2 callers pass the realized profit calculated from immutable Business Events.
    // The legacy fallback remains readable only before a Business Accounting Go-Live.
    monthProfit:
      realizedMonthProfit ??
      (await getAccountingDashboard({ businessIds, dateFrom: monthStart }))
        .netProfit,
    pendingCollection: Number(pending?.amount ?? 0),
    recentTransactions,
  };
}

/**
 * One day's numbers for the daily entry screen.
 *
 * getTreasurySummary() answers the same shape but only ever for today, because the
 * dashboard that uses it only ever asks about today. The accountant records yesterday's
 * movements this morning, so the day has to be a parameter — and the totals must come from
 * that day's rows rather than from "everything so far", or reopening an older day shows
 * today's figures under yesterday's date.
 *
 * Read-only aggregate: no writes, no side effects.
 */
export async function getDailyLedgerSummary(input: {
  businessIds?: number[] | null;
  /** Cairo-local day, `YYYY-MM-DD`. Defaults to today. */
  dateKey?: string;
}) {
  const db = await getDb();
  const dayKey = input.dateKey || businessDateKey(new Date(), CAIRO_TIMEZONE);
  // toExclusive, so the window is [from, toExclusive) — a movement stamped exactly at
  // midnight belongs to the next day, not to both.
  const { from, toExclusive } = businessDayRange(dayKey, CAIRO_TIMEZONE);
  const empty = {
    dateKey: dayKey,
    balance: 0,
    collections: 0,
    expensesPaid: 0,
    expensesDue: 0,
    deposits: 0,
    withdrawals: 0,
    net: 0,
    movementCount: 0,
    ordersToday: 0,
    confirmedToday: 0,
    pendingCollection: 0,
    goodsReceivedValue: 0,
    goodsReceivedCount: 0,
    supplierDue: 0,
    supplierPaid: null as number | null,
    movements: [] as TreasuryTransaction[],
  };
  if (!db) return empty;

  const scope =
    input.businessIds && input.businessIds.length > 0
      ? [inArray(treasuryTransactions.businessId, input.businessIds)]
      : [];
  const dayWindow = [
    gte(treasuryTransactions.transactionDate, from),
    lt(treasuryTransactions.transactionDate, toExclusive),
  ];

  const [totals] = await db
    .select({
      collections: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.type} = 'collection' AND ${treasuryTransactions.direction} = 'in' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      deposits: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.type} = 'deposit' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      withdrawals: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.type} = 'withdrawal' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      inflow: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'in' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      outflow: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'out' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
      movementCount: sql<number>`COUNT(*)`,
    })
    .from(treasuryTransactions)
    .where(and(...dayWindow, ...scope));

  const orderScope =
    input.businessIds && input.businessIds.length > 0
      ? [inArray(orders.businessId, input.businessIds)]
      : [];

  const [orderCounts] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      confirmed: sql<number>`SUM(CASE WHEN ${orders.status} = 'confirmed' THEN 1 ELSE 0 END)`,
    })
    .from(orders)
    .where(and(gte(orders.createdAt, from), lt(orders.createdAt, toExclusive), ...orderScope));

  // ── Expenses, read from the expense lifecycle rather than from the cash ledger ──
  //
  // createExpenseDraft writes a DRAFT into `expenses`; no money moves and no treasury row
  // exists. Counting treasury rows of type 'expense' therefore reported zero for every
  // expense entered here, which made the screen quietly disagree with what the accountant
  // had just typed. These two read where the truth actually lives.

  // Paid: an expense is paid when payExpense posts a financial transaction and records the
  // payment. `expense_payments.paidAt` is the moment the money left, so it is what a day's
  // "paid expenses" means.
  const [paidExpenses] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${expensePayments.amount}), 0)`,
    })
    .from(expensePayments)
    .where(
      and(
        gte(expensePayments.paidAt, from),
        lt(expensePayments.paidAt, toExclusive),
        ...(input.businessIds && input.businessIds.length > 0
          ? [inArray(expensePayments.businessId, input.businessIds)]
          : [])
      )
    );

  // Due: what is owed and not yet paid. Deliberately not limited to the selected day —
  // an unpaid expense from last week is still owed today, exactly like money sitting with
  // the courier. `voided` is excluded because a voided expense is not a liability.
  const [dueExpenses] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${expenses.amount} - ${expenses.paidAmount}), 0)`,
    })
    .from(expenses)
    .where(
      and(
        inArray(expenses.status, [
          "draft",
          "pending_approval",
          "accrued",
          "partially_paid",
        ] as any),
        ...(input.businessIds && input.businessIds.length > 0
          ? [inArray(expenses.businessId, input.businessIds)]
          : [])
      )
    );

  // Money already out with the courier and not yet collected — deliberately not limited to
  // the selected day: cash owed from two months ago is still owed today.
  const [pending] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${orders.totalAmount} - COALESCE(${orders.collectedAmount}, 0)), 0)`,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.status, ["printed", "preparing", "shipped", "delivered", "returned"] as any),
        inArray(orders.collectionStatus, ["pending", "partial"] as any),
        ...orderScope
      )
    );

  // ── Purchases, as three separate facts rather than one ──
  //
  // Receiving goods, owing the supplier and paying the supplier are three different events
  // and only the last one moves cash. Folding them together is how an unpaid purchase ends
  // up displayed as a paid expense.

  const receiptScope =
    input.businessIds && input.businessIds.length > 0
      ? [inArray(purchaseReceipts.businessId, input.businessIds)]
      : [];

  // Received today: valued at what the goods cost, scoped on approvedAt — the moment the
  // posting happened — not on receiptDate, which is the date the user typed on the paper.
  const [goodsReceived] = await db
    .select({
      value: sql<string>`COALESCE(SUM(${purchaseReceipts.totalAmount}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(purchaseReceipts)
    .where(
      and(
        eq(purchaseReceipts.status, "approved" as any),
        gte(purchaseReceipts.approvedAt, from),
        lt(purchaseReceipts.approvedAt, toExclusive),
        ...receiptScope
      )
    );

  // Owed to suppliers: every approved receipt not marked paid. Not day-scoped, for the same
  // reason unpaid expenses are not — last month's invoice is still owed today. A voided
  // receipt is not a liability, and a draft one is not either: nothing was received.
  const [supplierDue] = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${purchaseReceipts.totalAmount}), 0)`,
    })
    .from(purchaseReceipts)
    .where(
      and(
        eq(purchaseReceipts.status, "approved" as any),
        inArray(purchaseReceipts.paymentStatus, ["unpaid", "partially_paid"] as any),
        ...receiptScope
      )
    );

  const movements = await db
    .select()
    .from(treasuryTransactions)
    .where(and(...dayWindow, ...scope))
    .orderBy(desc(treasuryTransactions.transactionDate), desc(treasuryTransactions.id))
    .limit(100);

  return {
    dateKey: dayKey,
    balance: await getTreasuryBalance(input.businessIds),
    collections: Number(totals?.collections ?? 0),
    expensesPaid: Number(paidExpenses?.amount ?? 0),
    expensesDue: Number(dueExpenses?.amount ?? 0),
    deposits: Number(totals?.deposits ?? 0),
    withdrawals: Number(totals?.withdrawals ?? 0),
    // Everything in minus everything out — not collections minus expenses. Deposits,
    // withdrawals and refunds move cash too, and counting only two kinds made the figure
    // disagree with the balance.
    net: Number(totals?.inflow ?? 0) - Number(totals?.outflow ?? 0),
    movementCount: Number(totals?.movementCount ?? 0),
    ordersToday: Number(orderCounts?.total ?? 0),
    confirmedToday: Number(orderCounts?.confirmed ?? 0),
    pendingCollection: Number(pending?.amount ?? 0),
    goodsReceivedValue: Number(goodsReceived?.value ?? 0),
    goodsReceivedCount: Number(goodsReceived?.count ?? 0),
    supplierDue: Number(supplierDue?.amount ?? 0),
    // Deliberately null, not 0. There is no supplier payment record anywhere in the schema,
    // so "zero paid today" would be a claim this data cannot support. Null lets the screen
    // say the figure does not exist yet instead of inventing a reassuring number.
    supplierPaid: null as number | null,
    movements,
  };
}

// ==================== PAYROLL ====================
//
// المسار المحاسبي: الرواتب والسُلف بتدخل عن طريق `createExpense` مش الخزنة مباشرة.
// السبب إن لوحة الحسابات بتقرا المصروفات من جدول `expenses`، فلو نزلت الخزنة بس كان
// صافي الربح هيتجاهل المرتبات ويطلع أعلى من الحقيقي. و`createExpense` بينزّل حركة
// الخزنة المقابلة تلقائيًا، فالمسار ده بيدّي القيدين مع بعض.

const PAYROLL_EXPENSE_CATEGORY = "رواتب وأجور";

/** إعدادات افتراضية لنشاط لسه ماعندوش صف — مش بتتكتب في القاعدة إلا لما المستخدم يحفظ. */
const DEFAULT_PAYROLL_SETTINGS = {
  workingDaysPerMonth: 26,
  absenceDeductionBasis: "working_days" as const,
  weekendDays: "5,6",
  overtimeMode: "manual" as const,
  overtimeMultiplier: "1.50",
  workHoursPerDay: "8.00",
  currency: "EGP",
  roundingMode: "none" as const,
  defaultSalaryType: "monthly" as const,
  defaultCommissionBasis: "delivered" as const,
};

export async function getPayrollSettings(businessId: number) {
  const db = await getDb();
  if (!db) return { businessId, ...DEFAULT_PAYROLL_SETTINGS, id: 0 };
  const [row] = await db
    .select()
    .from(payrollSettings)
    .where(eq(payrollSettings.businessId, businessId))
    .limit(1);
  // الافتراضيات بترجع كأنها صف حقيقي — الواجهة مالهاش لازمة تعرف إن الإعدادات
  // ماتحفظتش لسه، والحساب بيشتغل من أول يوم.
  return row ?? { businessId, ...DEFAULT_PAYROLL_SETTINGS, id: 0 };
}

export async function upsertPayrollSettings(
  businessId: number,
  data: Partial<InsertPayrollSettings>,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [existing] = await db
    .select({ id: payrollSettings.id })
    .from(payrollSettings)
    .where(eq(payrollSettings.businessId, businessId))
    .limit(1);
  const values = { ...data, updatedBy: actor.id, updatedByName: actor.name };
  if (existing) {
    await db
      .update(payrollSettings)
      .set(values)
      .where(eq(payrollSettings.id, existing.id));
    return { id: existing.id };
  }
  const result: any = await db.insert(payrollSettings).values({
    ...DEFAULT_PAYROLL_SETTINGS,
    ...values,
    businessId,
  } as InsertPayrollSettings);
  return { id: Number(result?.insertId ?? result?.[0]?.insertId) };
}

// ---------- ملفات الرواتب ----------

export async function getSalaryProfiles(employeeId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(employeeSalaryProfiles)
    .where(eq(employeeSalaryProfiles.employeeId, employeeId))
    .orderBy(desc(employeeSalaryProfiles.effectiveFrom));
}

/**
 * الإصدار الساري من ملف الراتب في تاريخ معيّن.
 *
 * أحدث `effectiveFrom` أقل من أو يساوي التاريخ. ده اللي بيخلي رفع مرتب في مارس
 * مايغيّرش حساب فبراير: دورة فبراير بتسأل عن الساري في ٢٨ فبراير، فبتلاقي الإصدار
 * القديم مهما اتضاف بعده من إصدارات.
 */
export async function getEffectiveSalaryProfile(
  employeeId: number,
  onDate: Date
) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(employeeSalaryProfiles)
    .where(
      and(
        eq(employeeSalaryProfiles.employeeId, employeeId),
        eq(employeeSalaryProfiles.isActive, true),
        lte(employeeSalaryProfiles.effectiveFrom, onDate)
      )
    )
    .orderBy(desc(employeeSalaryProfiles.effectiveFrom))
    .limit(1);
  return row ?? null;
}

export async function createSalaryProfile(data: InsertEmployeeSalaryProfile) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    const result: any = await db.insert(employeeSalaryProfiles).values(data);
    return { id: Number(result?.insertId ?? result?.[0]?.insertId) };
  } catch (error: any) {
    if (String(error?.message ?? "").includes("Duplicate")) {
      throw new Error("يوجد إصدار راتب بنفس تاريخ السريان لهذا الموظف");
    }
    throw error;
  }
}

export async function updateSalaryProfile(
  id: number,
  data: Partial<InsertEmployeeSalaryProfile>,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (Object.keys(data).length === 0) return;
  await db
    .update(employeeSalaryProfiles)
    .set({ ...data, updatedBy: actor.id, updatedByName: actor.name })
    .where(eq(employeeSalaryProfiles.id, id));
}

// ---------- السُلف ----------

export async function getAdvances(filters: {
  businessIds?: number[] | null;
  employeeId?: number;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
}) {
  const db = await getDb();
  if (!db)
    return {
      advances: [],
      total: 0,
      page: 1,
      totalPages: 0,
      totalAmount: 0,
      pendingAmount: 0,
    };
  const { page = 1, limit = 50 } = filters;
  const conditions: any[] = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(inArray(employeeAdvances.businessId, filters.businessIds));
  }
  if (filters.employeeId)
    conditions.push(eq(employeeAdvances.employeeId, filters.employeeId));
  if (filters.status)
    conditions.push(eq(employeeAdvances.status, filters.status as any));
  if (filters.dateFrom)
    conditions.push(gte(employeeAdvances.advanceDate, filters.dateFrom));
  if (filters.dateTo)
    conditions.push(lte(employeeAdvances.advanceDate, filters.dateTo));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [agg] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<string>`COALESCE(SUM(${employeeAdvances.amount}), 0)`,
      pending: sql<string>`COALESCE(SUM(CASE WHEN ${employeeAdvances.status} = 'pending' THEN ${employeeAdvances.amount} ELSE 0 END), 0)`,
    })
    .from(employeeAdvances)
    .where(where);

  const advances = await db
    .select()
    .from(employeeAdvances)
    .where(where)
    .orderBy(desc(employeeAdvances.advanceDate), desc(employeeAdvances.id))
    .limit(limit)
    .offset((page - 1) * limit);

  const total = Number(agg?.count ?? 0);
  return {
    advances,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    totalAmount: Number(agg?.total ?? 0),
    pendingAmount: Number(agg?.pending ?? 0),
  };
}

/** تصنيف مصروفات الرواتب — بيتعمل مرة واحدة لكل نشاط عند أول استخدام. */
async function ensurePayrollExpenseCategory(
  businessId: number
): Promise<number | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const [existing] = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(
      and(
        eq(expenseCategories.businessId, businessId),
        eq(expenseCategories.name, PAYROLL_EXPENSE_CATEGORY)
      )
    )
    .limit(1);
  if (existing) return existing.id;
  try {
    const result: any = await db.insert(expenseCategories).values({
      businessId,
      name: PAYROLL_EXPENSE_CATEGORY,
      description: "مرتبات وسُلف الموظفين — يُنشأ تلقائيًا",
      isSystem: true,
    });
    return Number(result?.insertId ?? result?.[0]?.insertId);
  } catch {
    // سباق بين طلبين متزامنين: الفهرس الفريد رفض التاني، فنقرا اللي اتكتب
    const [row] = await db
      .select({ id: expenseCategories.id })
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.businessId, businessId),
          eq(expenseCategories.name, PAYROLL_EXPENSE_CATEGORY)
        )
      )
      .limit(1);
    return row?.id;
  }
}

/**
 * صرف سُلفة — بتتسجّل كمصروف فورًا.
 *
 * الفلوس بتخرج من الدُرج ساعة الصرف، فالتكلفة بتتسجّل ساعتها. وقت الرواتب بيتخصم
 * المبلغ من إجمالي المرتب لكن **مايتسجّلش كمصروف تاني** — سطر "السُلف" في كشف الراتب
 * عرضي بحت بيفسّر ليه الصافي أقل من الإجمالي. لو اتسجّل مرتين كانت التكلفة هتتضاعف.
 */
export async function createAdvance(
  data: Omit<InsertEmployeeAdvance, "expenseId">
): Promise<{ id: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const categoryId = await ensurePayrollExpenseCategory(data.businessId);
  const expense = await createExpense({
    businessId: data.businessId,
    categoryId,
    amount: String(data.amount),
    description: `سُلفة — ${data.employeeName}`,
    expenseDate: data.advanceDate,
    createdBy: data.createdBy,
    createdByName: data.createdByName,
  } as InsertExpense);

  try {
    const result: any = await db
      .insert(employeeAdvances)
      .values({ ...data, expenseId: expense.id });
    return { id: Number(result?.insertId ?? result?.[0]?.insertId) };
  } catch (error) {
    // السُلفة مااتسجلتش، فالمصروف اللي اتعمل ليها لازم يترد — وإلا فضل مصروف يتيم
    await deleteExpense(expense.id, {
      id: data.createdBy,
      name: data.createdByName,
    });
    throw error;
  }
}

/** إلغاء سُلفة — بيرد قيمتها للخزنة بقيد تسوية. ممنوع لو اتخصمت في دورة. */
export async function cancelAdvance(
  id: number,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [advance] = await db
    .select()
    .from(employeeAdvances)
    .where(eq(employeeAdvances.id, id))
    .limit(1);
  if (!advance) throw new Error("السُلفة غير موجودة");
  if (advance.status === "settled") {
    throw new Error("لا يمكن إلغاء سُلفة تم خصمها في دورة رواتب");
  }
  if (advance.status === "cancelled") return;

  if (advance.expenseId) await deleteExpense(advance.expenseId, actor);
  await db
    .update(employeeAdvances)
    .set({ status: "cancelled" })
    .where(eq(employeeAdvances.id, id));
}

// ---------- دورات الرواتب ----------

/** حدود الشهر بتوقيت القاهرة — نفس اصطلاح باقي حسابات "الشهر" في النظام. */
function monthBounds(year: number, month: number) {
  const fromKey = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = new Date(Date.UTC(year, month, 1));
  const toKey = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const from = businessDayRange(fromKey, CAIRO_TIMEZONE).from;
  const to = new Date(
    businessDayRange(toKey, CAIRO_TIMEZONE).from.getTime() - 1
  );
  return { from, to };
}

function settingsToInput(s: any): PayrollSettingsInput {
  return {
    workingDaysPerMonth: s.workingDaysPerMonth,
    absenceDeductionBasis: s.absenceDeductionBasis,
    overtimeMode: s.overtimeMode,
    overtimeMultiplier: s.overtimeMultiplier,
    workHoursPerDay: s.workHoursPerDay,
    roundingMode: s.roundingMode,
  };
}

function profileToInput(p: any): SalaryProfileInput {
  return {
    salaryType: p.salaryType,
    baseSalary: p.baseSalary,
    dailyRate: p.dailyRate,
    commissionType: p.commissionType,
    commissionValue: p.commissionValue,
    commissionBasis: p.commissionBasis,
  };
}

/**
 * الأوردرات المستحقة للعمولة لموظف في شهر.
 *
 * الحالة بتيجي من `commissionBasis` في ملف راتبه — مش ثابتة في الكود. والطابع الزمني
 * المستخدم للفلترة هو طابع الحالة نفسها (confirmedAt للتأكيد، deliveredAt للتوصيل …)
 * مش `createdAt`: أوردر اتعمل في يناير واتوصّل في فبراير عمولته على فبراير، لأن ده
 * الشهر اللي الموظف استحقها فيه.
 */
async function getCommissionableOrders(
  employeeId: number,
  basis: string,
  from: Date,
  to: Date,
  businessId: number
): Promise<{ count: number; total: number }> {
  const db = await getDb();
  if (!db) return { count: 0, total: 0 };

  const status =
    COMMISSION_BASIS_STATUS[basis as keyof typeof COMMISSION_BASIS_STATUS] ??
    "delivered";
  const dateColumn =
    {
      confirmed: orders.confirmedAt,
      preparing: orders.preparedAt,
      shipped: orders.shippedAt,
      delivered: orders.deliveredAt,
    }[status] ?? orders.deliveredAt;

  const [row] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.assignedEmployeeId, employeeId),
        eq(orders.businessId, businessId),
        isNotNull(dateColumn),
        gte(dateColumn, from),
        lte(dateColumn, to)
      )
    );

  return { count: Number(row?.count ?? 0), total: Number(row?.total ?? 0) };
}

export async function getPayrollPeriods(filters: {
  businessIds?: number[] | null;
  year?: number;
  status?: string;
  page?: number;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return { periods: [], total: 0, page: 1, totalPages: 0 };
  const { page = 1, limit = 50 } = filters;
  const conditions: any[] = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(inArray(payrollPeriods.businessId, filters.businessIds));
  }
  if (filters.year) conditions.push(eq(payrollPeriods.year, filters.year));
  if (filters.status)
    conditions.push(eq(payrollPeriods.status, filters.status as any));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(payrollPeriods)
    .where(where);
  const periods = await db
    .select()
    .from(payrollPeriods)
    .where(where)
    .orderBy(desc(payrollPeriods.year), desc(payrollPeriods.month))
    .limit(limit)
    .offset((page - 1) * limit);

  const total = Number(countRow?.count ?? 0);
  return { periods, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getPayrollPeriod(id: number) {
  const db = await getDb();
  if (!db) return null;
  const [period] = await db
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, id))
    .limit(1);
  if (!period) return null;
  const items = await db
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.periodId, id))
    .orderBy(asc(payrollItems.employeeName));
  return { ...period, items };
}

/**
 * إنشاء دورة رواتب لشهر — بيتولّد سطر لكل موظف نشط له ملف راتب ساري.
 *
 * الفهرس الفريد (businessId, year, month) بيرفض دورة تانية لنفس الشهر على مستوى قاعدة
 * البيانات. ده الحارس الأول ضد الدفع المزدوج، ومش شرط في الكود ينفع يتخطّى بطلبين
 * متزامنين.
 */
export async function createPayrollPeriod(params: {
  businessId: number;
  year: number;
  month: number;
  notes?: string;
  actor: { id: number; name: string };
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const { businessId, year, month, actor } = params;

  let periodId: number;
  try {
    const result: any = await db.insert(payrollPeriods).values({
      businessId,
      year,
      month,
      notes: params.notes,
      createdBy: actor.id,
      createdByName: actor.name,
    });
    periodId = Number(result?.insertId ?? result?.[0]?.insertId);
  } catch (error: any) {
    if (String(error?.message ?? "").includes("Duplicate")) {
      throw new Error(`توجد دورة رواتب بالفعل لشهر ${month}/${year}`);
    }
    throw error;
  }
  if (!periodId) throw new Error("تعذر إنشاء دورة الرواتب");

  await recalculatePayrollPeriod(periodId, actor);
  return { id: periodId };
}

/**
 * إعادة حساب سطور الدورة.
 *
 * الحقول المذكورة في `manualFields` لكل سطر بتفضل زي ما هي — ده تنفيذ شرط "لا تكتب
 * فوق التعديلات اليدوية". الأرقام المدخلة يدويًا أصلاً (الحضور، الغياب، الحوافز،
 * الخصومات) مابتتلمسش هنا خالص: مفيش مصدر تلقائي ليها لسه.
 *
 * ممنوعة بعد الاعتماد: دورة معتمدة أرقامها اتقفلت، وإعادة حسابها كانت هتغيّر مبلغًا
 * وافق عليه مدير.
 */
export async function recalculatePayrollPeriod(
  periodId: number,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [period] = await db
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, periodId))
    .limit(1);
  if (!period) throw new Error("الدورة غير موجودة");
  if (period.status !== "draft") {
    throw new Error("لا يمكن إعادة حساب دورة بعد اعتمادها");
  }

  const { from, to } = monthBounds(period.year, period.month);
  const settings = await getPayrollSettings(period.businessId);
  const settingsInput = settingsToInput(settings);

  const employeeRows = await db
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.businessId, period.businessId),
        eq(employees.isActive, true)
      )
    );
  const existingItems = await db
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.periodId, periodId));
  const existingByEmployee = new Map(existingItems.map(i => [i.employeeId, i]));

  let totalGross = 0,
    totalNet = 0,
    employeeCount = 0;

  for (const emp of employeeRows) {
    const profile = await getEffectiveSalaryProfile(emp.id, to);
    // موظف بلا ملف راتب ساري مالوش سطر — مش سطر بصفر. صفر بيبان كأنه قرار،
    // والغياب بيبان كأنه إعداد ناقص، وده الصح.
    if (!profile) continue;

    const existing = existingByEmployee.get(emp.id);
    const manualFields = parseManualFields(existing?.manualFields);

    const commission = await getCommissionableOrders(
      emp.id,
      profile.commissionBasis,
      from,
      to,
      period.businessId
    );

    const line: PayrollLineInput = {
      attendanceDays: existing?.attendanceDays ?? 0,
      absenceDays: existing?.absenceDays ?? 0,
      overtimeHours: toNumber(existing?.overtimeHours),
      overtimeAmount: toNumber(existing?.overtimeAmount),
      bonuses: toNumber(existing?.bonuses),
      deductions: toNumber(existing?.deductions),
      advances: toNumber(existing?.advances),
      commissionOrderCount: commission.count,
      commissionOrderTotal: commission.total,
    };

    const computed = calcPayrollLine(
      profileToInput(profile),
      line,
      settingsInput
    );
    const stored = {
      baseSalary: toNumber(existing?.baseSalary),
      absenceDeduction: toNumber(existing?.absenceDeduction),
      overtimeAmount: toNumber(existing?.overtimeAmount),
      commissions: toNumber(existing?.commissions),
      netSalary: toNumber(existing?.netSalary),
    };
    const final = existing
      ? mergeWithManualEdits(
          computed,
          stored,
          manualFields,
          line,
          settingsInput.roundingMode
        )
      : computed;

    // لقطة كاملة من الملف والإعدادات وقت الحساب — أي تعديل مستقبلي على الراتب مالوش
    // أثر على الدورة دي، والكشف بيفضل مفهومًا حتى لو الإصدار نفسه اتمسح.
    const snapshot = JSON.stringify({
      profile: profileToInput(profile),
      settings: settingsInput,
      commissionBasis: profile.commissionBasis,
      capturedAt: new Date().toISOString(),
    });

    const values = {
      periodId,
      businessId: period.businessId,
      employeeId: emp.id,
      employeeName: emp.name,
      salaryType: profile.salaryType,
      salaryProfileId: profile.id,
      profileSnapshot: snapshot,
      baseSalary: final.baseSalary.toFixed(2),
      attendanceDays: line.attendanceDays,
      absenceDays: line.absenceDays,
      overtimeHours: line.overtimeHours.toFixed(2),
      overtimeAmount: final.overtimeAmount.toFixed(2),
      bonuses: line.bonuses.toFixed(2),
      commissions: final.commissions.toFixed(2),
      commissionOrders: commission.count,
      absenceDeduction: final.absenceDeduction.toFixed(2),
      deductions: line.deductions.toFixed(2),
      advances: line.advances.toFixed(2),
      netSalary: final.netSalary.toFixed(2),
      manualFields: existing?.manualFields ?? null,
      notes: existing?.notes ?? null,
    };

    if (existing) {
      await db
        .update(payrollItems)
        .set(values)
        .where(eq(payrollItems.id, existing.id));
    } else {
      await db.insert(payrollItems).values(values as InsertPayrollItem);
    }

    totalGross +=
      final.baseSalary +
      final.overtimeAmount +
      line.bonuses +
      final.commissions;
    totalNet += final.netSalary;
    employeeCount += 1;
  }

  await db
    .update(payrollPeriods)
    .set({
      totalGross: totalGross.toFixed(2),
      totalNet: totalNet.toFixed(2),
      employeeCount,
    })
    .where(eq(payrollPeriods.id, periodId));

  return { employeeCount, totalGross, totalNet };
}

/**
 * تعديل سطر يدويًا.
 *
 * أي حقل محسوب بيتعدّل هنا بيتسجّل في `manualFields`، فإعادة الحساب بعدها بتحترمه.
 * الحقول المُدخلة (الحضور، الحوافز …) مابتتسجّلش لأنها يدوية أصلاً ومفيش حساب بيلمسها.
 */
export async function updatePayrollItem(
  itemId: number,
  data: Record<string, any>,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [item] = await db
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.id, itemId))
    .limit(1);
  if (!item) throw new Error("السطر غير موجود");
  const [period] = await db
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, item.periodId))
    .limit(1);
  if (!period) throw new Error("الدورة غير موجودة");
  if (period.status !== "draft") {
    throw new Error("لا يمكن تعديل سطور دورة بعد اعتمادها");
  }

  const CALCULATED = [
    "baseSalary",
    "absenceDeduction",
    "overtimeAmount",
    "commissions",
    "netSalary",
  ];
  const manual = new Set(parseManualFields(item.manualFields));
  for (const field of Object.keys(data)) {
    if (CALCULATED.includes(field)) manual.add(field);
  }

  const settings = await getPayrollSettings(period.businessId);
  const merged = { ...item, ...data };
  // الصافي بيتعاد جمعه من الأرقام النهائية إلا لو المستخدم قفله بنفسه — وإلا كان
  // بيعرض رقمًا مش مطابقًا لسطوره.
  const netSalary =
    manual.has("netSalary") && data.netSalary === undefined
      ? toNumber(item.netSalary)
      : data.netSalary !== undefined
        ? toNumber(data.netSalary)
        : toNumber(merged.baseSalary) +
          toNumber(merged.overtimeAmount) +
          toNumber(merged.bonuses) +
          toNumber(merged.commissions) -
          toNumber(merged.absenceDeduction) -
          toNumber(merged.deductions) -
          toNumber(merged.advances);

  await db
    .update(payrollItems)
    .set({
      ...data,
      netSalary: netSalary.toFixed(2),
      manualFields: JSON.stringify(Array.from(manual)),
    })
    .where(eq(payrollItems.id, itemId));

  // إجماليات الرأس لازم تتماشى مع سطورها
  const [agg] = await db
    .select({
      net: sql<string>`COALESCE(SUM(${payrollItems.netSalary}), 0)`,
      gross: sql<string>`COALESCE(SUM(${payrollItems.baseSalary} + ${payrollItems.overtimeAmount} + ${payrollItems.bonuses} + ${payrollItems.commissions}), 0)`,
    })
    .from(payrollItems)
    .where(eq(payrollItems.periodId, item.periodId));
  await db
    .update(payrollPeriods)
    .set({
      totalNet: String(agg?.net ?? "0"),
      totalGross: String(agg?.gross ?? "0"),
    })
    .where(eq(payrollPeriods.id, item.periodId));
}

/**
 * اعتماد الدورة — بيثبّت الأرقام ويخصم السُلف المعلّقة.
 *
 * الخصم بيحصل هنا مش وقت الدفع: الاعتماد هو اللحظة اللي الأرقام بتتقفل فيها، ولو
 * السُلف اتخصمت وقت الدفع كان المدير بيعتمد رقمًا غير اللي هيتدفع.
 */
export async function approvePayrollPeriod(
  periodId: number,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(tx =>
    approvePayrollPeriodInTransaction(tx, periodId, actor)
  );
}

export async function approvePayrollPeriodInTransaction(
  tx: any,
  periodId: number,
  actor: { id: number; name: string }
) {
  const [period] = await tx
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, periodId))
    .limit(1)
    .for("update");
  if (!period) throw new Error("الدورة غير موجودة");
  if (period.status !== "draft")
    throw new Error("لا يمكن اعتماد دورة إلا وهي مسودة");
  if (period.createdBy === actor.id)
    throw new Error("منشئ دورة الرواتب لا يمكنه اعتمادها بنفسه");

  const items = await tx
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.periodId, periodId))
    .for("update");
  if (items.length === 0) throw new Error("لا يمكن اعتماد دورة بلا سطور");

  // السُلف المعلّقة لكل موظف في الدورة → تتخصم من سطره وتتعلّم كمُسوّاة
  for (const item of items) {
    const pending = await tx
      .select()
      .from(employeeAdvances)
      .where(
        and(
          eq(employeeAdvances.employeeId, item.employeeId),
          eq(employeeAdvances.businessId, period.businessId),
          eq(employeeAdvances.status, "pending")
        )
      );
    if (pending.length === 0) continue;

    const totalAdvances = pending.reduce(
      (sum: number, a: any) => sum + toNumber(a.amount),
      0
    );
    const newNet =
      toNumber(item.baseSalary) +
      toNumber(item.overtimeAmount) +
      toNumber(item.bonuses) +
      toNumber(item.commissions) -
      toNumber(item.absenceDeduction) -
      toNumber(item.deductions) -
      totalAdvances;

    await tx
      .update(payrollItems)
      .set({
        advances: totalAdvances.toFixed(2),
        netSalary: newNet.toFixed(2),
      })
      .where(eq(payrollItems.id, item.id));

    await tx
      .update(employeeAdvances)
      .set({
        status: "settled",
        settledPeriodId: periodId,
      })
      .where(
        inArray(
          employeeAdvances.id,
          pending.map((a: any) => a.id)
        )
      );
  }

  const [agg] = await tx
    .select({
      net: sql<string>`COALESCE(SUM(${payrollItems.netSalary}), 0)`,
      gross: sql<string>`COALESCE(SUM(${payrollItems.baseSalary} + ${payrollItems.overtimeAmount} + ${payrollItems.bonuses} + ${payrollItems.commissions}), 0)`,
    })
    .from(payrollItems)
    .where(eq(payrollItems.periodId, periodId));

  await tx
    .update(payrollPeriods)
    .set({
      status: "approved",
      totalNet: String(agg?.net ?? "0"),
      totalGross: String(agg?.gross ?? "0"),
      approvedBy: actor.id,
      approvedByName: actor.name,
      approvedAt: new Date(),
    })
    .where(eq(payrollPeriods.id, periodId));

  return { totalNet: Number(agg?.net ?? 0) };
}

/**
 * دفع الدورة — قيد محاسبي واحد بمجموع الصافي.
 *
 * ثلاثة حواجز ضد الدفع المزدوج:
 *   ١. الفهرس الفريد (businessId, year, month) — دورة واحدة للشهر
 *   ٢. `status !== 'approved'` — الدفع من حالة واحدة بس
 *   ٣. `expenseId != null` — لو فيه قيد خلاص، الطلب بيترفض
 *
 * القيمة المدفوعة هي **الصافي** مش الإجمالي: السُلف خرجت من الدُرج واتسجّلت كمصروف
 * وقت صرفها، فتسجيلها تاني هنا كان بيحسب نفس التكلفة مرتين.
 */
export async function payPayrollPeriod(
  periodId: number,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [period] = await db
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, periodId))
    .limit(1);
  if (!period) throw new Error("الدورة غير موجودة");
  if (period.status !== "approved")
    throw new Error("لا يمكن دفع دورة إلا بعد اعتمادها");
  if (period.expenseId) throw new Error("هذه الدورة مدفوعة بالفعل");

  const netTotal = toNumber(period.totalNet);
  if (netTotal <= 0) throw new Error("لا يمكن دفع دورة صافيها صفر أو أقل");

  const categoryId = await ensurePayrollExpenseCategory(period.businessId);
  const { to } = monthBounds(period.year, period.month);
  const expense = await createExpense({
    businessId: period.businessId,
    categoryId,
    amount: netTotal.toFixed(2),
    description: `مرتبات ${period.month}/${period.year} — ${period.employeeCount} موظف`,
    expenseDate: to,
    reference: `PAYROLL-${period.year}-${String(period.month).padStart(2, "0")}`,
    createdBy: actor.id,
    createdByName: actor.name,
  } as InsertExpense);

  await db
    .update(payrollPeriods)
    .set({
      status: "paid",
      expenseId: expense.id,
      paidBy: actor.id,
      paidByName: actor.name,
      paidAt: new Date(),
    })
    .where(eq(payrollPeriods.id, periodId));

  return { expenseId: expense.id, amount: netTotal };
}

/**
 * إلغاء دورة.
 *
 * المسودة والمعتمدة بتتلغي مباشرة. المدفوعة بتتلغي كمان لكن بقيد عكسي: `deleteExpense`
 * بينزّل حركة تسوية بترد القيمة للخزنة بدل ما يمسح الحركة الأصلية — الـledger
 * append-only، والفلوس اللي خرجت لازم يفضل ليها أثر.
 *
 * في كل الحالات السُلف المخصومة بترجع "معلّقة" عشان تتخصم في الدورة الجاية، وإلا كان
 * الموظف بياخد سُلفة اتخصمت من دورة اتلغت.
 */
export async function cancelPayrollPeriod(
  periodId: number,
  reason: string,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [period] = await db
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, periodId))
    .limit(1);
  if (!period) throw new Error("الدورة غير موجودة");
  if (period.status === "cancelled") throw new Error("الدورة ملغاة بالفعل");

  if (period.expenseId) {
    await deleteExpense(period.expenseId, actor);
  }

  await db
    .update(employeeAdvances)
    .set({
      status: "pending",
      settledPeriodId: null,
    })
    .where(eq(employeeAdvances.settledPeriodId, periodId));

  await db
    .update(payrollPeriods)
    .set({
      status: "cancelled",
      expenseId: null,
      cancelledBy: actor.id,
      cancelledByName: actor.name,
      cancelledAt: new Date(),
      cancelReason: reason,
    })
    .where(eq(payrollPeriods.id, periodId));
}

/** حذف دورة مسودة نهائيًا — المعتمدة والمدفوعة بتتلغي مش بتتحذف. */
export async function deletePayrollPeriod(periodId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [period] = await db
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, periodId))
    .limit(1);
  if (!period) throw new Error("الدورة غير موجودة");
  if (period.status !== "draft") {
    throw new Error("لا يمكن حذف دورة بعد اعتمادها — استخدم الإلغاء");
  }
  await db.delete(payrollItems).where(eq(payrollItems.periodId, periodId));
  await db.delete(payrollPeriods).where(eq(payrollPeriods.id, periodId));
}

/** ملخّص لوحة الرواتب */
export async function getPayrollSummary(businessIds?: number[] | null) {
  const db = await getDb();
  const empty = {
    draftPeriods: 0,
    approvedPeriods: 0,
    paidThisYear: 0,
    pendingAdvances: 0,
    employeesWithProfile: 0,
    lastPeriod: null as PayrollPeriod | null,
  };
  if (!db) return empty;
  const scope =
    businessIds && businessIds.length > 0
      ? [inArray(payrollPeriods.businessId, businessIds)]
      : [];
  const year = new Date().getFullYear();

  const [counts] = await db
    .select({
      draft: sql<number>`SUM(CASE WHEN ${payrollPeriods.status} = 'draft' THEN 1 ELSE 0 END)`,
      approved: sql<number>`SUM(CASE WHEN ${payrollPeriods.status} = 'approved' THEN 1 ELSE 0 END)`,
      paidYear: sql<string>`COALESCE(SUM(CASE WHEN ${payrollPeriods.status} = 'paid' AND ${payrollPeriods.year} = ${year} THEN ${payrollPeriods.totalNet} ELSE 0 END), 0)`,
    })
    .from(payrollPeriods)
    .where(scope.length > 0 ? and(...scope) : undefined);

  const advScope =
    businessIds && businessIds.length > 0
      ? [inArray(employeeAdvances.businessId, businessIds)]
      : [];
  const [adv] = await db
    .select({
      pending: sql<string>`COALESCE(SUM(CASE WHEN ${employeeAdvances.status} = 'pending' THEN ${employeeAdvances.amount} ELSE 0 END), 0)`,
    })
    .from(employeeAdvances)
    .where(advScope.length > 0 ? and(...advScope) : undefined);

  const profScope =
    businessIds && businessIds.length > 0
      ? [inArray(employeeSalaryProfiles.businessId, businessIds)]
      : [];
  const [prof] = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${employeeSalaryProfiles.employeeId})`,
    })
    .from(employeeSalaryProfiles)
    .where(and(eq(employeeSalaryProfiles.isActive, true), ...profScope));

  const [lastPeriod] = await db
    .select()
    .from(payrollPeriods)
    .where(scope.length > 0 ? and(...scope) : undefined)
    .orderBy(desc(payrollPeriods.year), desc(payrollPeriods.month))
    .limit(1);

  return {
    draftPeriods: Number(counts?.draft ?? 0),
    approvedPeriods: Number(counts?.approved ?? 0),
    paidThisYear: Number(counts?.paidYear ?? 0),
    pendingAdvances: Number(adv?.pending ?? 0),
    employeesWithProfile: Number(prof?.count ?? 0),
    lastPeriod: lastPeriod ?? null,
  };
}
