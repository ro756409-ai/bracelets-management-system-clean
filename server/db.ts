import { eq, desc, asc, and, or, gte, lte, sql, inArray, isNull, isNotNull, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser, users,
  employees, InsertEmployee, Employee,
  products, InsertProduct, Product,
  orders, InsertOrder, Order,
  inventoryMovements, InsertInventoryMovement,
  returns as returnsTable,
  printLogs, InsertPrintLog,
  activityLogs, InsertActivityLog,
  businesses, InsertBusiness, Business,
  businessGroups, InsertBusinessGroup, BusinessGroup,
  categories, InsertCategory, Category,
  warehouses, InsertWarehouse, Warehouse,
  salesChannels, InsertSalesChannel, SalesChannel,
  syncLogs, InsertSyncLog, SyncLog,
  productVariants, InsertProductVariant, ProductVariant,
  orderEditLogs, InsertOrderEditLog, OrderEditLog,
  scanLogs, InsertScanLog,
  orderItems, InsertOrderItem, OrderItem,
  expenseCategories, InsertExpenseCategory, ExpenseCategory,
  expenses, InsertExpense, Expense,
  treasuryTransactions, InsertTreasuryTransaction, TreasuryTransaction,
} from "../drizzle/schema";
import { normalizeEgyptianPhone, toAsciiDigits } from "../shared/phone";

// ==================== CAIRO TIMEZONE HELPERS ====================
const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2 (EET) - Egypt doesn't observe DST since 2014

export function cairoStartOfDay(date: Date): Date {
  const cairoTime = new Date(date.getTime() + CAIRO_OFFSET_MS);
  const year = cairoTime.getUTCFullYear();
  const month = cairoTime.getUTCMonth();
  const day = cairoTime.getUTCDate();
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - CAIRO_OFFSET_MS);
}

export function cairoEndOfDay(date: Date): Date {
  const cairoTime = new Date(date.getTime() + CAIRO_OFFSET_MS);
  const year = cairoTime.getUTCFullYear();
  const month = cairoTime.getUTCMonth();
  const day = cairoTime.getUTCDate();
  return new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - CAIRO_OFFSET_MS);
}

export function cairoTodayRange(): { from: Date; to: Date } {
  const now = new Date();
  return { from: cairoStartOfDay(now), to: cairoEndOfDay(now) };
}

export function cairoParseDateRange(dateStr: string): { from: Date; to: Date } {
  const [year, month, day] = dateStr.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - CAIRO_OFFSET_MS);
  const to = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - CAIRO_OFFSET_MS);
  return { from, to };
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
  return db.select().from(businessGroups).where(eq(businessGroups.isActive, true)).orderBy(asc(businessGroups.id));
}

export async function getBusinessGroupsWithBusinesses() {
  const db = await getDb();
  if (!db) return [];
  const groups = await db.select().from(businessGroups).where(eq(businessGroups.isActive, true)).orderBy(asc(businessGroups.id));
  const allBusinesses = await db.select().from(businesses).where(eq(businesses.isActive, true)).orderBy(asc(businesses.name));
  return groups.map(g => ({
    ...g,
    businesses: allBusinesses.filter(b => b.groupId === g.id),
  }));
}

export async function getBusinessIdsByGroupId(groupId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db.select({ id: businesses.id }).from(businesses)
    .where(and(eq(businesses.groupId, groupId), eq(businesses.isActive, true)));
  return result.map(r => r.id);
}

// جلب معرفات الأعمال (businesses) التابعة لمجموعة عمل عبر الـ slug
// تُستخدم لاستثناء مجموعة المفروشات من الإرسال لبوسطة
export async function getBusinessIdsByGroupSlug(slug: string): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const [group] = await db.select({ id: businessGroups.id }).from(businessGroups)
    .where(eq(businessGroups.slug, slug)).limit(1);
  if (!group) return [];
  const result = await db.select({ id: businesses.id }).from(businesses)
    .where(eq(businesses.groupId, group.id));
  return result.map(r => r.id);
}

// ==================== BUSINESSES ====================
export async function getAllBusinesses(businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const where = businessIds && businessIds.length > 0 ? inArray(businesses.id, businessIds) : undefined;
  return db.select().from(businesses).where(where).orderBy(asc(businesses.name));
}

export async function getActiveBusinesses(businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(businesses.isActive, true)];
  if (businessIds && businessIds.length > 0) conditions.push(inArray(businesses.id, businessIds));
  return db.select().from(businesses).where(and(...conditions)).orderBy(asc(businesses.name));
}

// ==================== TENANTS (multi-tenancy) ====================
/**
 * Every business id that belongs to a given tenant — the allow-list a session may ever
 * read/write. Returns `null` (not `[]`) when the database itself is unreachable, so callers can
 * tell "verified: this tenant owns zero businesses" apart from "couldn't verify at all" —
 * treating the latter as an empty allow-list would fail closed for the wrong reason and mask
 * the real "database unavailable" error every other query in this file already surfaces.
 */
export async function getBusinessIdsForTenant(tenantId: number): Promise<number[] | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.tenantId, tenantId));
  return rows.map(r => r.id);
}

/**
 * Tenant a business group belongs to. Returns null/undefined if the group doesn't exist, the
 * database is unavailable, OR the group's own tenantId hasn't been backfilled yet (still null)
 * — all three are treated identically by callers: "cannot verify, so reject the cross-tenant
 * group assignment" rather than assume it's fine.
 */
async function getBusinessGroupTenantId(groupId: number): Promise<number | null | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const [group] = await db.select({ tenantId: businessGroups.tenantId }).from(businessGroups)
    .where(eq(businessGroups.id, groupId)).limit(1);
  return group?.tenantId;
}

export async function getBusinessById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1);
  return result[0];
}

export async function createBusiness(data: InsertBusiness) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (data.groupId != null) {
    const groupTenantId = await getBusinessGroupTenantId(data.groupId);
    if (groupTenantId == null || groupTenantId !== (data.tenantId ?? 1)) {
      throw new Error("Business group belongs to a different tenant");
    }
  }
  await db.insert(businesses).values(data);
}

export async function updateBusiness(id: number, data: Partial<InsertBusiness>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (data.groupId != null) {
    const [biz] = await db.select({ tenantId: businesses.tenantId }).from(businesses).where(eq(businesses.id, id)).limit(1);
    const effectiveTenantId = data.tenantId ?? biz?.tenantId;
    const groupTenantId = await getBusinessGroupTenantId(data.groupId);
    if (effectiveTenantId == null || groupTenantId == null || groupTenantId !== effectiveTenantId) {
      throw new Error("Business group belongs to a different tenant");
    }
  }
  await db.update(businesses).set(data).where(eq(businesses.id, id));
}

// ==================== CATEGORIES ====================
export async function getCategoriesByBusiness(businessId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(categories)
    .where(and(eq(categories.businessId, businessId), eq(categories.isActive, true)))
    .orderBy(asc(categories.name));
}

export async function createCategory(data: InsertCategory) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(categories).values(data);
}

export async function updateCategory(id: number, data: Partial<InsertCategory>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(categories).set(data).where(eq(categories.id, id));
}

// ==================== WAREHOUSES ====================
export async function getWarehousesByBusiness(businessId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(warehouses)
    .where(and(eq(warehouses.businessId, businessId), eq(warehouses.isActive, true)))
    .orderBy(asc(warehouses.name));
}

export async function createWarehouse(data: InsertWarehouse) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(warehouses).values(data);
}

export async function updateWarehouse(id: number, data: Partial<InsertWarehouse>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(warehouses).set(data).where(eq(warehouses.id, id));
}

// ==================== USERS ====================
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
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
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) { console.error("[Database] Failed to upsert user:", error); throw error; }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
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
const { passwordHash: _employeePasswordHashColumn, ...employeeSafeColumns } = getTableColumns(employees);

export async function getAllEmployees(businessId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (businessId) conditions.push(eq(employees.businessId, businessId));
  return db.select(employeeSafeColumns).from(employees)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(employees.name));
}

export async function searchEmployees(filters: EmployeeFilters) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters.businessId) conditions.push(eq(employees.businessId, filters.businessId));
  if (filters.role) conditions.push(eq(employees.role, filters.role as any));
  if (filters.isActive !== undefined) conditions.push(eq(employees.isActive, filters.isActive));
  if (filters.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      sql`(${employees.name} LIKE ${term} OR ${employees.username} LIKE ${term} OR ${employees.email} LIKE ${term})`
    );
  }
  return db.select(employeeSafeColumns).from(employees)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(employees.name));
}

const ADMIN_TIER_ROLES_FOR_QUERY = ["super_admin", "admin", "manager"] as const;

/** Number of currently-active admin-tier employees (super_admin/admin/manager). */
export async function countActiveAdminTierEmployees(excludeId?: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions: any[] = [
    eq(employees.isActive, true),
    inArray(employees.role, ADMIN_TIER_ROLES_FOR_QUERY),
  ];
  if (excludeId) conditions.push(sql`${employees.id} != ${excludeId}`);
  const rows = await db.select({ id: employees.id }).from(employees).where(and(...conditions));
  return rows.length;
}

export async function getActiveEmployees(businessId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(employees.isActive, true)];
  if (businessId) conditions.push(eq(employees.businessId, businessId));
  return db.select(employeeSafeColumns).from(employees)
    .where(and(...conditions))
    .orderBy(asc(employees.name));
}

export async function getEmployeeById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select(employeeSafeColumns).from(employees).where(eq(employees.id, id)).limit(1);
  return result[0];
}

export async function getEmployeeByUsernameOrEmail(identifier: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(employees)
    .where(or(eq(employees.username, identifier), eq(employees.email, identifier)))
    .limit(1);
  return result[0];
}

export async function createEmployee(data: InsertEmployee) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(employees).values(data);
  return result;
}

export async function updateEmployee(id: number, data: Partial<InsertEmployee>) {
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
export async function getAllProducts(businessId?: number, businessIds?: number[], opts: { includeInactive?: boolean } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (!opts.includeInactive) conditions.push(eq(products.isActive, true));
  if (businessIds && businessIds.length > 0) {
    conditions.push(inArray(products.businessId, businessIds));
  } else if (businessId) {
    conditions.push(eq(products.businessId, businessId));
  }
  return db.select().from(products)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(products.name));
}

export async function getProductById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(products).where(eq(products.id, id)).limit(1);
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
  await db.update(products)
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
export async function getLowStockProducts(businessId?: number, businessIds?: number[]) {
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
  return db.select().from(products).where(and(...conditions));
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
export async function getOrderStatusCounts(businessIds?: number[]): Promise<OrderStatusCounts> {
  const db = await getDb();
  if (!db) return { total: 0, byStatus: {}, today: 0, needsReview: 0 };

  const scope = businessIds && businessIds.length > 0 ? inArray(orders.businessId, businessIds) : undefined;

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

  // Cairo offset — matches the convention already used for "today" elsewhere (e.g. the
  // printed-date filter on the Orders page).
  const cairoNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const todayStart = new Date(cairoNow.toISOString().slice(0, 10) + "T00:00:00Z");
  const todayEnd = new Date(cairoNow.toISOString().slice(0, 10) + "T23:59:59Z");
  const todayConditions = [gte(orders.createdAt, todayStart), lte(orders.createdAt, todayEnd)];
  if (scope) todayConditions.push(scope);
  const [todayRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(orders)
    .where(and(...todayConditions));

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
  const result = await db.select({ maxNum: sql<string>`MAX(CAST(orderNumber AS UNSIGNED))` })
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
  if (filters.websiteId) conditions.push(eq(orders.websiteId, filters.websiteId));
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
          eq(orders.governorate, '')
        )!
      );
    }
  } else if (filters.governorate) {
    conditions.push(eq(orders.governorate, filters.governorate));
  }
  if (filters.assignedEmployeeId) conditions.push(eq(orders.assignedEmployeeId, filters.assignedEmployeeId));
  if (filters.unassignedOnly) conditions.push(isNull(orders.assignedEmployeeId));
  if (filters.dateFrom) conditions.push(gte(orders.createdAt, cairoStartOfDay(filters.dateFrom)));
  if (filters.dateTo) conditions.push(lte(orders.createdAt, cairoEndOfDay(filters.dateTo)));
  if (filters.assignedDateFrom) conditions.push(gte(orders.assignedAt, cairoStartOfDay(filters.assignedDateFrom)));
  if (filters.assignedDateTo) conditions.push(lte(orders.assignedAt, cairoEndOfDay(filters.assignedDateTo)));
  if (filters.printedDateFrom) conditions.push(gte(orders.printedAt, filters.printedDateFrom));
  if (filters.printedDateTo) conditions.push(lte(orders.printedAt, filters.printedDateTo));
  if (filters.adName) conditions.push(eq(orders.adName, filters.adName));
  if (filters.search) {
    conditions.push(sql`(${orders.customerName} LIKE ${`%${filters.search}%`} OR ${orders.customerPhone} LIKE ${`%${filters.search}%`} OR ${orders.orderNumber} LIKE ${`%${filters.search}%`})`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const [rows, countResult] = await Promise.all([
    db.select()
      .from(orders)
      .leftJoin(salesChannels, eq(orders.websiteId, salesChannels.id))
      .where(whereClause)
      .orderBy(
        sql`CASE WHEN ${orders.importRowIndex} IS NULL THEN 0 ELSE 1 END`,
        desc(orders.createdAt),
        asc(orders.importRowIndex),
      )
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(orders).where(whereClause),
  ]);

  const ordersWithWebsite = rows.map((row: any) => ({
    ...row.orders,
    websiteName: row.sales_channels?.name || null,
  }));

  return { orders: ordersWithWebsite, total: Number(countResult[0]?.count ?? 0) };
}

// ==================== Bosta Orders View ====================
// Categorizes orders by their Bosta shipping state, using only existing columns
// (bostaShipmentId/bostaStatus/bostaSentAt/bostaLastError) — no schema change.
// bostaStatus holds either the literal "sent" placeholder (set the moment a shipment is
// created, before any webhook arrives) or one of the Arabic strings from
// BOSTA_STATUS_MAP in bostaWebhook.ts.

export type BostaOrderCategory = "sent_today" | "awaiting_update" | "in_transit" | "delivered" | "returned" | "send_failed";

const BOSTA_IN_TRANSIT_STATUSES = ["تم الاستلام", "في المستودع", "في مستودع الفرع", "في مستودع المنطقة", "في طريق التسليم"];
const BOSTA_DELIVERED_STATUSES = ["تم التسليم", "تم التسليم جزئياً"];
const BOSTA_RETURNED_STATUSES = [
  "مرتجع - لم يُستلم", "مرتجع - رُفض", "مرتجع - عنوان خاطئ", "مرتجع - لم يُتصل به", "مرتجع - تالف",
  "مرتجع", "مرتجع - تأجيل", "مرتجع - طلب العميل", "مرتجع - مشكلة في الدفع",
  "في طريق الإرجاع", "تم الإرجاع",
];

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
      return and(gte(orders.bostaSentAt, cairoStartOfDay(new Date())), lte(orders.bostaSentAt, cairoEndOfDay(new Date())))!;
    case "send_failed":
      return and(isNotNull(orders.bostaLastError), isNull(orders.bostaShipmentId))!;
    case "awaiting_update":
      return and(isNotNull(orders.bostaShipmentId), eq(orders.bostaStatus, "sent"))!;
    case "in_transit":
      return and(isNotNull(orders.bostaShipmentId), inArray(orders.bostaStatus, BOSTA_IN_TRANSIT_STATUSES))!;
    case "delivered":
      return and(isNotNull(orders.bostaShipmentId), inArray(orders.bostaStatus, BOSTA_DELIVERED_STATUSES))!;
    case "returned":
      return and(isNotNull(orders.bostaShipmentId), inArray(orders.bostaStatus, BOSTA_RETURNED_STATUSES))!;
  }
}

export async function getBostaOrders(filters: BostaOrdersFilters = {}) {
  const db = await getDb();
  if (!db) return { orders: [], total: 0 };

  const conditions = [bostaOrdersBaseCondition()];
  if (filters.businessIds && filters.businessIds.length > 0) conditions.push(inArray(orders.businessId, filters.businessIds));
  if (filters.governorate) conditions.push(eq(orders.governorate, filters.governorate));
  if (filters.websiteId) conditions.push(eq(orders.websiteId, filters.websiteId));
  if (filters.dateFrom) conditions.push(gte(orders.bostaSentAt, cairoStartOfDay(filters.dateFrom)));
  if (filters.dateTo) conditions.push(lte(orders.bostaSentAt, cairoEndOfDay(filters.dateTo)));
  if (filters.search) {
    conditions.push(sql`(${orders.bostaTrackingNumber} LIKE ${`%${filters.search}%`} OR ${orders.customerPhone} LIKE ${`%${filters.search}%`} OR ${orders.orderNumber} LIKE ${`%${filters.search}%`})`);
  }
  if (filters.category) conditions.push(bostaCategoryCondition(filters.category));

  const whereClause = and(...conditions);
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const [rows, countResult] = await Promise.all([
    db.select().from(orders)
      .leftJoin(salesChannels, eq(orders.websiteId, salesChannels.id))
      .where(whereClause)
      .orderBy(desc(orders.bostaSentAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(orders).where(whereClause),
  ]);

  const ordersWithWebsite = rows.map((row: any) => ({
    ...row.orders,
    websiteName: row.sales_channels?.name || null,
  }));

  return { orders: ordersWithWebsite, total: Number(countResult[0]?.count ?? 0) };
}

export async function getBostaOrdersSummary(businessIds?: number[]) {
  const db = await getDb();
  if (!db) return { sentToday: 0, inTransit: 0, delivered: 0, returned: 0, sendFailed: 0, awaitingUpdate: 0 };

  const scope = businessIds && businessIds.length > 0 ? inArray(orders.businessId, businessIds) : undefined;
  const combine = (extra: NonNullable<ReturnType<typeof bostaCategoryCondition>>) =>
    scope ? and(scope, extra) : extra;

  const [sentToday, inTransit, delivered, returned, sendFailed, awaitingUpdate] = await Promise.all([
    db.select({ c: sql<number>`COUNT(*)` }).from(orders).where(combine(bostaCategoryCondition("sent_today"))),
    db.select({ c: sql<number>`COUNT(*)` }).from(orders).where(combine(bostaCategoryCondition("in_transit"))),
    db.select({ c: sql<number>`COUNT(*)` }).from(orders).where(combine(bostaCategoryCondition("delivered"))),
    db.select({ c: sql<number>`COUNT(*)` }).from(orders).where(combine(bostaCategoryCondition("returned"))),
    db.select({ c: sql<number>`COUNT(*)` }).from(orders).where(combine(bostaCategoryCondition("send_failed"))),
    db.select({ c: sql<number>`COUNT(*)` }).from(orders).where(combine(bostaCategoryCondition("awaiting_update"))),
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
  const result = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return result[0];
}

export async function getOrdersByIds(ids: number[]) {
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  const rows = await db.select().from(orders).where(inArray(orders.id, ids));
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (idIndex.get(a.id) ?? 0) - (idIndex.get(b.id) ?? 0));
}

export async function getOrdersByEmployee(employeeId: number, filters: OrderFilters = {}) {
  return getOrders({ ...filters, assignedEmployeeId: employeeId });
}

export function generateSerialNumber(orderId: number, createdAt?: Date): string {
  const year = (createdAt ?? new Date()).getFullYear();
  return `ORD-${year}-${String(orderId).padStart(6, '0')}`;
}

function withNormalizedPhoneFields<T extends { customerPhone?: unknown; customerPhone2?: unknown }>(data: T): T {
  const normalized = { ...data };
  if (typeof normalized.customerPhone === 'string' && normalized.customerPhone) {
    normalized.customerPhone = normalizeEgyptianPhone(normalized.customerPhone) as any;
  }
  if (typeof normalized.customerPhone2 === 'string' && normalized.customerPhone2) {
    normalized.customerPhone2 = normalizeEgyptianPhone(normalized.customerPhone2) as any;
  }
  return normalized;
}

export async function createOrder(data: InsertOrder): Promise<number | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(orders).values(withNormalizedPhoneFields(data));
  // Generate serialNumber using the new auto-increment id
  const insertId = (result as any).insertId;
  if (insertId) {
    const serial = generateSerialNumber(insertId);
    await db.update(orders).set({ serialNumber: serial }).where(eq(orders.id, insertId));
  }
  return insertId;
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

export function isValidOrderStatusTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function updateOrder(id: number, data: Partial<InsertOrder>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (data.status) {
    const [current] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, id)).limit(1);
    if (current && !isValidOrderStatusTransition(current.status, data.status)) {
      throw new Error(`لا يمكن تغيير حالة الأوردر من "${current.status}" إلى "${data.status}" مباشرة`);
    }
  }
  await db.update(orders).set(withNormalizedPhoneFields(data)).where(eq(orders.id, id));
}

export async function deleteOrder(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(orders).where(eq(orders.id, id));
}

// ==================== SCAN HELPERS ====================
export async function scanOrderBySerial(serialNumber: string, scannedBy: number, scannedByName: string, deviceInfo?: string) {
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

  console.log(`[Scan] Searching for: "${searchValue}" (original: "${serialNumber}")`);

  // Try to find order by multiple fields: orderNumber, bostaTrackingNumber, serialNumber, bostaShipmentId
  let orderRows = await db.select().from(orders).where(eq(orders.orderNumber, searchValue)).limit(1);
  if (!orderRows.length) {
    orderRows = await db.select().from(orders).where(eq(orders.bostaTrackingNumber, searchValue)).limit(1);
  }
  if (!orderRows.length) {
    orderRows = await db.select().from(orders).where(eq(orders.serialNumber, searchValue)).limit(1);
  }
  if (!orderRows.length) {
    orderRows = await db.select().from(orders).where(eq(orders.bostaShipmentId, searchValue)).limit(1);
  }
  // Try partial match - Bosta tracking numbers often start with N- followed by digits
  if (!orderRows.length && /^N-?\d+/i.test(searchValue)) {
    orderRows = await db.select().from(orders)
      .where(sql`${orders.bostaTrackingNumber} LIKE ${`%${searchValue}%`}`)
      .limit(1);
  }
  // Try searching by customer phone if the scanned value looks like a phone number
  // (converted to ASCII digits first so Arabic-Indic phone numbers are recognized too)
  const asciiSearchValue = toAsciiDigits(searchValue).replace(/\s/g, '');
  if (!orderRows.length && /^\+?[0-9]{10,15}$/.test(asciiSearchValue)) {
    const phone = normalizeEgyptianPhone(searchValue) || asciiSearchValue.replace(/^\+2/, '');
    orderRows = await db.select().from(orders)
      .where(and(
        sql`${orders.customerPhone} LIKE ${`%${phone}%`}`,
        eq(orders.isPrepared, false)
      ))
      .limit(1);
  }
  if (!orderRows.length) {
    await db.insert(scanLogs).values({ orderId: 0, serialNumber: searchValue, scannedBy, scannedByName, result: 'failed', deviceInfo });
    return { success: false, result: 'failed' as const, message: `الأوردر غير موجود - QR غير صحيح (${searchValue})` };
  }

  const order = orderRows[0];

  // Check cancelled/returned
  if (order.status === 'cancelled' || order.status === 'returned') {
    await db.insert(scanLogs).values({ orderId: order.id, serialNumber, scannedBy, scannedByName, result: 'cancelled', deviceInfo });
    return { success: false, result: 'cancelled' as const, message: `تحذير: هذا الأوردر ${order.status === 'cancelled' ? 'ملغي' : 'مرتجع'}`, order };
  }

  // Check already prepared
  if (order.isPrepared) {
    await db.insert(scanLogs).values({ orderId: order.id, serialNumber, scannedBy, scannedByName, result: 'duplicate', deviceInfo });
    await db.update(orders).set({ scanCount: (order.scanCount ?? 0) + 1, lastScannedAt: new Date() }).where(eq(orders.id, order.id));
    return { success: false, result: 'duplicate' as const, message: `تم تجهيز هذا الأوردر بالفعل بواسطة ${order.preparedByName ?? 'موظف'} في ${order.preparedAt ? new Date(order.preparedAt).toLocaleString('ar-EG') : ''}`, order };
  }

  // Mark as prepared
  const now = new Date();
  await db.update(orders).set({
    isPrepared: true,
    preparedAt: now,
    preparedBy: scannedBy,
    preparedByName: scannedByName,
    scanCount: (order.scanCount ?? 0) + 1,
    lastScannedAt: now,
  }).where(eq(orders.id, order.id));

  await db.insert(scanLogs).values({ orderId: order.id, serialNumber, scannedBy, scannedByName, result: 'success', deviceInfo });

  const updatedOrder = { ...order, isPrepared: true, preparedAt: now, preparedBy: scannedBy, preparedByName: scannedByName };
  return { success: true, result: 'success' as const, message: 'تم تجهيز الأوردر بنجاح ✓', order: updatedOrder };
}

export async function getScanLogs(filters: { orderId?: number; scannedBy?: number; limit?: number }) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters.orderId) conditions.push(eq(scanLogs.orderId, filters.orderId));
  if (filters.scannedBy) conditions.push(eq(scanLogs.scannedBy, filters.scannedBy));
  const rows = await db.select().from(scanLogs)
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
  await db.update(orders).set({
    status: 'printed',
    printedAt: new Date(),
  }).where(
    and(
      inArray(orders.id, ids),
      eq(orders.status, 'confirmed')
    )
  );
}

export async function assignOrderToEmployee(orderId: number, employeeId: number, updatedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(orders).set({
    assignedEmployeeId: employeeId,
    assignedAt: new Date(),
    lastUpdatedBy: updatedBy,
  }).where(eq(orders.id, orderId));
}

export async function bulkAssignOrders(orderIds: number[], employeeId: number, updatedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(orders).set({
    assignedEmployeeId: employeeId,
    assignedAt: new Date(),
    lastUpdatedBy: updatedBy,
  }).where(inArray(orders.id, orderIds));
}

export async function confirmOrder(orderId: number, updatedBy: number, confirmedByName?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("Order not found");

  if (order.status === 'confirmed') return;

  const missingFields: string[] = [];
  if (!order.governorate || order.governorate.trim() === '' || order.governorate.trim() === 'غير محدد') {
    missingFields.push('اسم المحافظة');
  }
  if (!order.customerAddress || order.customerAddress.trim().length < 5) {
    missingFields.push('العنوان بالتفصيل');
  }
  if (missingFields.length > 0) {
    throw new Error(`لا يمكن تأكيد الأوردر - بيانات ناقصة: ${missingFields.join(' و ')}`);
  }

  const qty = order.quantity ?? 1;
  if (order.productId) {
    const [product] = await db.select().from(products).where(eq(products.id, order.productId)).limit(1);
    if (product && product.currentStock < qty) {
      throw new Error(`لا يمكن تأكيد الأوردر - المخزون غير كافي (المتاح: ${product.currentStock}، المطلوب: ${qty})`);
    }
  }

  await db.update(orders).set({
    status: 'confirmed',
    confirmedAt: new Date(),
    lastUpdatedBy: updatedBy,
    // Preserve whatever confirmation record already exists (e.g. a legacy-imported
    // order) rather than overwriting it — this function only ever runs once per order
    // anyway (guarded by the early return above), but keep the intent explicit.
    ...(order.confirmedByEmployeeId == null && updatedBy
      ? { confirmedByEmployeeId: updatedBy, confirmedByEmployeeName: confirmedByName ?? null }
      : {}),
  }).where(eq(orders.id, orderId));

  if (order.productId) {
    await addInventoryMovement({
      productId: order.productId,
      type: 'out',
      quantity: qty,
      reason: `تأكيد أوردر ${order.orderNumber}`,
      orderId: order.id,
      performedBy: updatedBy,
      businessId: order.businessId ?? 1,
    });
  }
}

export async function postponeOrder(orderId: number, postponedTo: Date, notes: string | undefined, updatedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(orders).set({
    status: 'postponed',
    postponedTo,
    notes,
    lastUpdatedBy: updatedBy,
  }).where(eq(orders.id, orderId));
}

export async function cancelOrder(orderId: number, cancelReason: string, notes: string | undefined, updatedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(orders).set({
    status: 'cancelled',
    cancelReason: cancelReason as any,
    cancelledAt: new Date(),
    notes,
    lastUpdatedBy: updatedBy,
  }).where(eq(orders.id, orderId));
}

// ==================== DASHBOARD STATS ====================
export async function getDashboardStats(dateFrom?: Date, dateTo?: Date, businessId?: number, businessIds?: number[]) {
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
  if (correctedFrom) confirmedConditions.push(gte(orders.confirmedAt, correctedFrom));
  if (correctedTo) confirmedConditions.push(lte(orders.confirmedAt, correctedTo));
  confirmedConditions.push(inArray(orders.status, ['confirmed', 'printed', 'preparing', 'shipped', 'delivered'] as any[]));
  const confirmedWhere = and(...confirmedConditions);

  // Cancelled stats (based on cancelledAt)
  const cancelledConditions: any[] = [];
  addBusinessFilter(cancelledConditions);
  if (correctedFrom) cancelledConditions.push(gte(orders.cancelledAt, correctedFrom));
  if (correctedTo) cancelledConditions.push(lte(orders.cancelledAt, correctedTo));
  cancelledConditions.push(eq(orders.status, 'cancelled'));
  const cancelledWhere = and(...cancelledConditions);

  // Shipped stats (based on shippedAt)
  const shippedConditions: any[] = [];
  addBusinessFilter(shippedConditions);
  if (correctedFrom) shippedConditions.push(gte(orders.shippedAt, correctedFrom));
  if (correctedTo) shippedConditions.push(lte(orders.shippedAt, correctedTo));
  shippedConditions.push(inArray(orders.status, ['shipped', 'delivered'] as any[]));
  const shippedWhere = and(...shippedConditions);

  // Delivered revenue (based on deliveredAt)
  const deliveredConditions: any[] = [];
  addBusinessFilter(deliveredConditions);
  if (correctedFrom) deliveredConditions.push(gte(orders.deliveredAt, correctedFrom));
  if (correctedTo) deliveredConditions.push(lte(orders.deliveredAt, correctedTo));
  deliveredConditions.push(eq(orders.status, 'delivered'));
  const deliveredWhere = and(...deliveredConditions);

  const [statusStats, sourceStats, governorateStats, totalRevenue, confirmedCount, cancelledCount, shippedCount] = await Promise.all([
    db.select({
      status: orders.status,
      count: sql<number>`COUNT(*)`,
    }).from(orders).where(whereClause).groupBy(orders.status),

    db.select({
      source: orders.source,
      count: sql<number>`COUNT(*)`,
    }).from(orders).where(whereClause).groupBy(orders.source),

    db.select({
      governorate: orders.governorate,
      count: sql<number>`COUNT(*)`,
    }).from(orders).where(whereClause).groupBy(orders.governorate).orderBy(desc(sql`COUNT(*)`)).limit(10),

    db.select({
      total: sql<number>`SUM(${orders.totalAmount})`,
    }).from(orders).where(deliveredWhere),

    db.select({ count: sql<number>`COUNT(*)` }).from(orders).where(confirmedWhere),

    db.select({ count: sql<number>`COUNT(*)` }).from(orders).where(cancelledWhere),

    db.select({ count: sql<number>`COUNT(*)` }).from(orders).where(shippedWhere),
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

export async function getEmployeePerformance(dateFrom?: Date, dateTo?: Date, businessId?: number, businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];

  const correctedFrom = dateFrom ? cairoStartOfDay(dateFrom) : undefined;
  const correctedTo = dateTo ? cairoEndOfDay(dateTo) : undefined;
  const conditions = [];
  if (businessIds && businessIds.length > 0) conditions.push(inArray(orders.businessId, businessIds));
  else if (businessId) conditions.push(eq(orders.businessId, businessId));
  if (correctedFrom) conditions.push(gte(orders.createdAt, correctedFrom));
  if (correctedTo) conditions.push(lte(orders.createdAt, correctedTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  return db.select({
    employeeId: orders.assignedEmployeeId,
    total: sql<number>`COUNT(*)`,
    confirmed: sql<number>`SUM(CASE WHEN ${orders.status} = 'confirmed' THEN 1 ELSE 0 END)`,
    cancelled: sql<number>`SUM(CASE WHEN ${orders.status} = 'cancelled' THEN 1 ELSE 0 END)`,
    postponed: sql<number>`SUM(CASE WHEN ${orders.status} = 'postponed' THEN 1 ELSE 0 END)`,
    delivered: sql<number>`SUM(CASE WHEN ${orders.status} = 'delivered' THEN 1 ELSE 0 END)`,
  }).from(orders)
    .where(and(whereClause, sql`${orders.assignedEmployeeId} IS NOT NULL`))
    .groupBy(orders.assignedEmployeeId);
}

export async function getCancellationReasons(dateFrom?: Date, dateTo?: Date, businessId?: number, businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];

  const correctedFrom = dateFrom ? cairoStartOfDay(dateFrom) : undefined;
  const correctedTo = dateTo ? cairoEndOfDay(dateTo) : undefined;
  const conditions = [eq(orders.status, 'cancelled')];
  if (businessIds && businessIds.length > 0) conditions.push(inArray(orders.businessId, businessIds));
  else if (businessId) conditions.push(eq(orders.businessId, businessId));
  if (correctedFrom) conditions.push(gte(orders.cancelledAt, correctedFrom));
  if (correctedTo) conditions.push(lte(orders.cancelledAt, correctedTo));

  return db.select({
    reason: orders.cancelReason,
    count: sql<number>`COUNT(*)`,
  }).from(orders)
    .where(and(...conditions))
    .groupBy(orders.cancelReason);
}

export async function getDailyOrdersChart(days: number = 30, businessId?: number, businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);

  let businessFilter;
  if (businessIds && businessIds.length > 0) {
    businessFilter = sql`AND businessId IN (${sql.raw(businessIds.join(','))})`;
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
    date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
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

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("الأوردر غير موجود");

  const isConfirmed = order.status === 'confirmed';
  const oldProductId = order.productId;
  const oldQty = order.quantity ?? 1;
  const newProductId = updates.productId ?? oldProductId;
  const newQty = updates.quantity ?? oldQty;

  await db.update(orders).set({
    ...(updates.productId && { productId: updates.productId }),
    ...(updates.productName && { productName: updates.productName }),
    ...(updates.quantity !== undefined && { quantity: updates.quantity }),
    ...(updates.totalAmount !== undefined && { totalAmount: String(updates.totalAmount) }),
    ...(updates.customerName && { customerName: updates.customerName }),
    ...(updates.customerPhone && { customerPhone: updates.customerPhone }),
    ...(updates.customerAddress !== undefined && { customerAddress: updates.customerAddress }),
    ...(updates.governorate && { governorate: updates.governorate }),
    ...(updates.notes !== undefined && { notes: updates.notes }),
    lastUpdatedBy: updatedBy,
  }).where(eq(orders.id, orderId));

  // Stock is only moved for orders that actually have a product resolved. An order still
  // awaiting product review (productId null) has never deducted stock, so there is nothing
  // to return or deduct here.
  if (isConfirmed && (updates.productId !== undefined || updates.quantity !== undefined)) {
    if (oldProductId != null) {
      await addInventoryMovement({
        productId: oldProductId,
        type: 'in',
        quantity: oldQty,
        reason: `تعديل أوردر ${order.orderNumber} - إرجاع قديم`,
        orderId: order.id,
        performedBy: updatedBy,
        businessId: order.businessId ?? 1,
      });
    }
    if (newProductId != null) {
      await addInventoryMovement({
        productId: newProductId,
        type: 'out',
        quantity: newQty,
        reason: `تعديل أوردر ${order.orderNumber} - خصم جديد`,
        orderId: order.id,
        performedBy: updatedBy,
        businessId: order.businessId ?? 1,
      });
    }
  }
}

// ==================== INVENTORY ====================
export async function addInventoryMovement(data: InsertInventoryMovement) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (data.type === 'out') {
    const current = await getProductById(data.productId);
    if (!current) throw new Error("المنتج غير موجود");
    if (data.quantity > current.currentStock) {
      throw new Error(`الكمية الصادرة (${data.quantity}) أكبر من المخزون الحالي (${current.currentStock})`);
    }
  }
  await db.insert(inventoryMovements).values(data);
  const delta = data.type === 'in' ? data.quantity : -data.quantity;
  await updateProductStock(data.productId, delta);
}

export async function getInventoryMovements(productId?: number, limit = 50, businessId?: number, businessIds?: number[], variantId?: number) {
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
  return db.select().from(inventoryMovements)
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
    { name: 'أسورة سادة', sku: 'PLAIN-001', price: '150.00', currentStock: 100, minStockLevel: 20, businessId: 1 },
    { name: 'آية الكرسي', sku: 'AYAT-001', price: '180.00', currentStock: 80, minStockLevel: 15, businessId: 1 },
    { name: 'ذكر التحصين', sku: 'DHIKR-001', price: '175.00', currentStock: 60, minStockLevel: 15, businessId: 1 },
    { name: 'فالله خير حافظاً', sku: 'HAFIZ-001', price: '185.00', currentStock: 70, minStockLevel: 15, businessId: 1 },
    { name: 'منقوش', sku: 'ENGR-001', price: '200.00', currentStock: 50, minStockLevel: 10, businessId: 1 },
    { name: 'عين حورس', sku: 'HORUS-001', price: '160.00', currentStock: 90, minStockLevel: 20, businessId: 1 },
    { name: 'قل أعوذ برب الفلق', sku: 'FALAQ-001', price: '180.00', currentStock: 65, minStockLevel: 15, businessId: 1 },
    { name: 'أسورة إنه من سليمان', sku: 'SULAI-001', price: '185.00', currentStock: 50, minStockLevel: 15, businessId: 1 },
    { name: 'أسورة كهيعص', sku: 'KAHYA-001', price: '185.00', currentStock: 50, minStockLevel: 15, businessId: 1 },
  ];

  await db.insert(products).values(braceletProducts);
}

// ==================== RETURNS ====================
export async function markOrderAsReturned(
  orderId: number,
  returnReason: 'customer_refused' | 'wrong_product' | 'damaged' | 'wrong_address' | 'customer_not_available' | 'other',
  notes: string | undefined,
  processedBy: number,
  restoreStock: boolean = true
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const orderRows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (orderRows.length === 0) throw new Error("الأوردر غير موجود");
  const order = orderRows[0];

  const allowedStatuses = ['confirmed', 'shipped', 'delivered', 'preparing'];
  if (!allowedStatuses.includes(order.status)) {
    throw new Error(`لا يمكن إرجاع أوردر بحالة: ${order.status}`);
  }

  await db.update(orders)
    .set({ status: 'returned', lastUpdatedBy: processedBy })
    .where(eq(orders.id, orderId));

  // Only restore stock when a product was actually resolved for this order.
  if (restoreStock && order.productId != null) {
    await addInventoryMovement({
      productId: order.productId,
      type: 'in',
      quantity: order.quantity,
      reason: `مرتجع - أوردر ${order.orderNumber}`,
      orderId: order.id,
      performedBy: processedBy,
      businessId: order.businessId ?? 1,
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
    businessId: order.businessId ?? 1,
  });

  return { success: true, orderNumber: order.orderNumber, stockRestored: restoreStock };
}

export async function getReturnsList(filters: {
  page?: number;
  limit?: number;
  governorate?: string;
  returnReason?: string;
  dateFrom?: Date;
  dateTo?: Date;
  businessId?: number;
} = {}) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const { page = 1, limit = 50, governorate, returnReason, dateFrom, dateTo, businessId } = filters;
  const conditions: ReturnType<typeof eq>[] = [];
  if (businessId) conditions.push(eq(returnsTable.businessId, businessId));
  if (governorate) conditions.push(eq(returnsTable.governorate, governorate));
  if (returnReason) conditions.push(eq(returnsTable.returnReason, returnReason as any));
  if (dateFrom) conditions.push(gte(returnsTable.createdAt, dateFrom));
  if (dateTo) conditions.push(lte(returnsTable.createdAt, dateTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [items, countResult] = await Promise.all([
    db.select().from(returnsTable)
      .where(whereClause)
      .orderBy(desc(returnsTable.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`COUNT(*)` }).from(returnsTable).where(whereClause),
  ]);
  return { items, total: Number(countResult[0]?.count ?? 0) };
}

export async function getReturnsStats(dateFrom?: Date, dateTo?: Date, businessId?: number) {
  const db = await getDb();
  if (!db) return { total: 0, totalAmount: 0, byReason: [], byGovernorate: [] };
  const conditions: ReturnType<typeof eq>[] = [];
  if (businessId) conditions.push(eq(returnsTable.businessId, businessId));
  if (dateFrom) conditions.push(gte(returnsTable.createdAt, dateFrom));
  if (dateTo) conditions.push(lte(returnsTable.createdAt, dateTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [totals, byReason, byGovernorate] = await Promise.all([
    db.select({
      total: sql<number>`COUNT(*)`,
      totalAmount: sql<number>`SUM(totalAmount)`,
    }).from(returnsTable).where(whereClause),
    db.select({
      reason: returnsTable.returnReason,
      count: sql<number>`COUNT(*)`,
    }).from(returnsTable).where(whereClause).groupBy(returnsTable.returnReason).orderBy(desc(sql`COUNT(*)`)),
    db.select({
      governorate: returnsTable.governorate,
      count: sql<number>`COUNT(*)`,
    }).from(returnsTable).where(whereClause).groupBy(returnsTable.governorate).orderBy(desc(sql`COUNT(*)`)).limit(10),
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

  const result = await db.select({
    total: sql<number>`COUNT(*)`,
    newOrders: sql<number>`SUM(CASE WHEN ${orders.status} = 'new' THEN 1 ELSE 0 END)`,
    confirmed: sql<number>`SUM(CASE WHEN ${orders.status} IN ('confirmed', 'printed') THEN 1 ELSE 0 END)`,
    cancelled: sql<number>`SUM(CASE WHEN ${orders.status} = 'cancelled' THEN 1 ELSE 0 END)`,
    postponed: sql<number>`SUM(CASE WHEN ${orders.status} = 'postponed' THEN 1 ELSE 0 END)`,
    noAnswer: sql<number>`SUM(CASE WHEN ${orders.status} = 'no_answer' THEN 1 ELSE 0 END)`,
    returned: sql<number>`SUM(CASE WHEN ${orders.status} = 'returned' THEN 1 ELSE 0 END)`,
    firstAssigned: sql<string>`MIN(${orders.assignedAt})`,
    lastAssigned: sql<string>`MAX(${orders.assignedAt})`,
  }).from(orders)
    .where(eq(orders.assignedEmployeeId, employeeId));

  return result[0] ?? null;
}

// استرداد كل أوردرات موظف
export async function reclaimEmployeeOrders(employeeId: number, statuses?: string[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions: any[] = [eq(orders.assignedEmployeeId, employeeId)];
  if (statuses && statuses.length > 0) {
    conditions.push(inArray(orders.status, statuses as any));
  } else {
    conditions.push(inArray(orders.status, ['new', 'no_answer', 'postponed'] as any));
  }

  const result = await db.update(orders).set({
    assignedEmployeeId: null,
    assignedAt: null,
  }).where(and(...conditions));

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
  const result = await db!.insert(printLogs).values({
    type: data.type,
    orderIds: JSON.stringify(data.orderIds),
    orderCount: data.orderIds.length,
    printedBy: data.printedBy,
    printedByName: data.printedByName,
    notes: data.notes || null,
    businessId: data.businessId ?? 1,
  });
  return { id: result[0].insertId };
}

export async function getPrintLogs(limit = 50, businessId?: number) {
  const db = await getDb();
  const conditions: any[] = [];
  if (businessId) conditions.push(eq(printLogs.businessId, businessId));
  const rows = await db!.select().from(printLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(printLogs.createdAt)).limit(limit);
  return rows.map(r => ({
    ...r,
    orderIds: JSON.parse(r.orderIds as string) as number[],
  }));
}

export async function getPrintLogById(id: number) {
  const db = await getDb();
  const rows = await db!.select().from(printLogs).where(eq(printLogs.id, id)).limit(1);
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
    businessId: data.businessId ?? 1,
  });
}

export async function getActivityLogs(filters: {
  page?: number;
  limit?: number;
  action?: string;
  entityType?: string;
  entityId?: number;
  performedBy?: number;
  dateFrom?: Date;
  dateTo?: Date;
  businessId?: number;
} = {}) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const { page = 1, limit = 50, action, entityType, entityId, performedBy, dateFrom, dateTo, businessId } = filters;
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
    db.select().from(activityLogs)
      .where(whereClause)
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`COUNT(*)` }).from(activityLogs).where(whereClause),
  ]);
  return { items, total: Number(countResult[0]?.count ?? 0) };
}

// ==================== SALES CHANNELS ====================
/**
 * Client-safe shape of a sales channel: the raw `apiToken`/`webhookSecret` are NEVER included.
 * Callers that need to show "is a secret configured?" get booleans plus the last 4 characters,
 * which is enough to identify a credential without exposing it.
 */
export type SafeSalesChannel = Omit<SalesChannel, "apiToken" | "webhookSecret"> & {
  hasApiToken: boolean;
  apiTokenLast4: string | null;
  hasWebhookSecret: boolean;
  webhookSecretLast4: string | null;
};

function toSafeSalesChannel(row: SalesChannel): SafeSalesChannel {
  const { apiToken, webhookSecret, ...rest } = row;
  const last4 = (v: string | null | undefined) => (v && v.length > 0 ? v.slice(-4) : null);
  return {
    ...rest,
    hasApiToken: Boolean(apiToken),
    apiTokenLast4: last4(apiToken),
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretLast4: last4(webhookSecret),
  };
}

export async function getAllSalesChannels(businessId?: number, opts: { includeInactive?: boolean } = { includeInactive: true }): Promise<SafeSalesChannel[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (!opts.includeInactive) conditions.push(eq(salesChannels.isActive, true));
  if (businessId) conditions.push(eq(salesChannels.businessId, businessId));
  const rows = await db.select().from(salesChannels)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(salesChannels.createdAt));
  return rows.map(toSafeSalesChannel);
}

export async function getActiveSalesChannels(businessId?: number): Promise<SafeSalesChannel[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(salesChannels.isActive, true)];
  if (businessId) conditions.push(eq(salesChannels.businessId, businessId));
  const rows = await db.select().from(salesChannels)
    .where(and(...conditions))
    .orderBy(asc(salesChannels.name));
  return rows.map(toSafeSalesChannel);
}

export async function getSalesChannelById(id: number): Promise<SafeSalesChannel | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(salesChannels).where(eq(salesChannels.id, id)).limit(1);
  return result[0] ? toSafeSalesChannel(result[0]) : undefined;
}

/** True if `secret` is already used as the webhook secret of another channel (secrets must be unique to route webhooks unambiguously). */
export async function isWebhookSecretTaken(secret: string, excludeChannelId?: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = secret.trim();
  if (!trimmed) return false;
  const conditions: any[] = [eq(salesChannels.webhookSecret, trimmed)];
  if (excludeChannelId) conditions.push(sql`${salesChannels.id} != ${excludeChannelId}`);
  const match = await db.select({ id: salesChannels.id }).from(salesChannels).where(and(...conditions)).limit(1);
  return match.length > 0;
}

/** True if an active channel with the same (trimmed, case-insensitive) name already exists for this business. */
export async function isSalesChannelNameTaken(businessId: number, name: string, excludeChannelId?: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const conditions: any[] = [
    eq(salesChannels.businessId, businessId),
    eq(salesChannels.isActive, true),
    sql`LOWER(TRIM(${salesChannels.name})) = LOWER(${trimmed})`,
  ];
  if (excludeChannelId) conditions.push(sql`${salesChannels.id} != ${excludeChannelId}`);
  const match = await db.select({ id: salesChannels.id }).from(salesChannels).where(and(...conditions)).limit(1);
  return match.length > 0;
}

/**
 * SERVER-INTERNAL ONLY — returns the full row including secrets, for webhook routing.
 * Never expose the result of this through a tRPC procedure; use getSalesChannelById instead.
 */
export async function getSalesChannelByWebhookSecret(secret: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(salesChannels)
    .where(and(eq(salesChannels.webhookSecret, secret), eq(salesChannels.isActive, true)))
    .limit(1);
  return result[0];
}

/** SERVER-INTERNAL ONLY — see getSalesChannelByWebhookSecret. */
export async function getSalesChannelByPlatformAndBusiness(platform: string, businessId?: number) {
  const db = await getDb();
  if (!db) return undefined;
  const conditions: any[] = [
    eq(salesChannels.platform, platform as any),
    eq(salesChannels.isActive, true),
  ];
  if (businessId) conditions.push(eq(salesChannels.businessId, businessId));
  const result = await db.select().from(salesChannels)
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

export async function updateSalesChannel(id: number, data: Partial<InsertSalesChannel>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Secrets are write-only from the client's perspective: since the API never returns them,
  // an edit form can't round-trip them. `undefined` therefore means "leave unchanged" — only an
  // explicit non-empty value replaces a stored secret, so re-saving a form can't silently wipe one.
  const patch: Partial<InsertSalesChannel> = { ...data };
  if (patch.apiToken === undefined || patch.apiToken === "") delete patch.apiToken;
  if (patch.webhookSecret === undefined || patch.webhookSecret === "") delete patch.webhookSecret;
  if (Object.keys(patch).length === 0) return;
  await db.update(salesChannels).set(patch).where(eq(salesChannels.id, id));
}

/** Explicitly clears one stored secret (the only way to remove one, since update() ignores empty values). */
export async function clearSalesChannelSecret(id: number, field: "apiToken" | "webhookSecret") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(salesChannels).set({ [field]: null }).where(eq(salesChannels.id, id));
}

export async function deleteSalesChannel(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Soft delete - just deactivate
  await db.update(salesChannels).set({ isActive: false }).where(eq(salesChannels.id, id));
}

export async function reactivateSalesChannel(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(salesChannels).set({ isActive: true }).where(eq(salesChannels.id, id));
}

/** SERVER-INTERNAL ONLY — full row incl. secrets, for the sync client. Never route to a client. */
export async function getSalesChannelWithSecrets(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(salesChannels).where(eq(salesChannels.id, id)).limit(1);
  return result[0];
}

export async function updateSalesChannelSyncStatus(
  id: number,
  status: { lastSyncStatus: "success" | "error"; lastSyncError?: string | null; lastSyncedOrderCount?: number }
) {
  const db = await getDb();
  if (!db) return;
  await db.update(salesChannels).set({
    lastSyncAt: new Date(),
    lastSyncStatus: status.lastSyncStatus,
    lastSyncError: status.lastSyncError ?? null,
    ...(status.lastSyncedOrderCount !== undefined ? { lastSyncedOrderCount: status.lastSyncedOrderCount } : {}),
  }).where(eq(salesChannels.id, id));
}

/**
 * Records the outcome of a read-only connection test. This is the ONLY write a connection
 * test performs — it never touches orders, products or sync logs.
 */
export async function updateSalesChannelConnectionStatus(
  id: number,
  result: { connected: boolean; storeName?: string | null; errorCode?: string; errorMessage?: string }
) {
  const db = await getDb();
  if (!db) return;
  await db.update(salesChannels).set({
    lastConnectionTestAt: new Date(),
    lastConnectionStatus: result.connected ? "connected" : "failed",
    lastConnectionError: result.connected
      ? null
      : [result.errorCode, result.errorMessage].filter(Boolean).join(": ") || null,
    // Only overwrite the stored store name when the provider actually reported one, so a
    // later endpoint that omits it doesn't erase a previously-discovered value.
    ...(result.connected && result.storeName ? { externalStoreName: result.storeName } : {}),
  }).where(eq(salesChannels.id, id));
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
  await db.update(syncLogs).set({ ...data, finishedAt: new Date() }).where(eq(syncLogs.id, id));
}

export async function getSyncLogs(filters: { channelId?: number; limit?: number } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters.channelId) conditions.push(eq(syncLogs.channelId, filters.channelId));
  return db.select().from(syncLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(syncLogs.startedAt))
    .limit(filters.limit ?? 50);
}

/** Order lookup by the external system's order id — the idempotency key for imports. */
export async function getOrderByExternalId(externalOrderId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(orders)
    .where(eq(orders.externalOrderId, externalOrderId))
    .limit(1);
  return result[0];
}

/** Orders flagged for manual product review (unmatched/ambiguous external items). */
export async function getOrdersNeedingReview(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(orders)
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
  const productRows = await db.select().from(products).where(and(...productConditions));
  const productIds = productRows.map(p => p.id);
  const variantRows = productIds.length > 0
    ? await db.select().from(productVariants)
        .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)))
    : [];
  return {
    products: productRows.map(p => ({
      id: p.id, name: p.name, sku: p.sku, price: p.price, businessId: p.businessId,
    })),
    variants: variantRows.map(v => ({
      id: v.id, productId: v.productId, name: v.name, sku: v.sku, price: v.price, isActive: v.isActive,
    })),
  };
}

// ==================== PRODUCT VARIANTS ====================
export async function getVariantsByProduct(productId: number, opts: { includeInactive?: boolean } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(productVariants.productId, productId)];
  if (!opts.includeInactive) conditions.push(eq(productVariants.isActive, true));
  return db.select().from(productVariants)
    .where(and(...conditions))
    .orderBy(asc(productVariants.name), asc(productVariants.color), asc(productVariants.size));
}

/** True if `sku` is already used by an active product or variant (SKUs are unique across both). */
export async function isSkuTaken(sku: string, opts: { excludeProductId?: number; excludeVariantId?: number } = {}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = sku.trim();
  if (!trimmed) return false;

  const productConditions: any[] = [eq(products.sku, trimmed)];
  if (opts.excludeProductId) productConditions.push(sql`${products.id} != ${opts.excludeProductId}`);
  const productMatch = await db.select({ id: products.id }).from(products).where(and(...productConditions)).limit(1);
  if (productMatch.length > 0) return true;

  const variantConditions: any[] = [eq(productVariants.sku, trimmed)];
  if (opts.excludeVariantId) variantConditions.push(sql`${productVariants.id} != ${opts.excludeVariantId}`);
  const variantMatch = await db.select({ id: productVariants.id }).from(productVariants).where(and(...variantConditions)).limit(1);
  return variantMatch.length > 0;
}

/** True if an active variant with the same (trimmed, case-insensitive) name already exists under this product. */
export async function isVariantNameTaken(productId: number, name: string, excludeVariantId?: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const conditions: any[] = [
    eq(productVariants.productId, productId),
    eq(productVariants.isActive, true),
    sql`LOWER(TRIM(${productVariants.name})) = LOWER(${trimmed})`,
  ];
  if (excludeVariantId) conditions.push(sql`${productVariants.id} != ${excludeVariantId}`);
  const match = await db.select({ id: productVariants.id }).from(productVariants).where(and(...conditions)).limit(1);
  return match.length > 0;
}

export async function getVariantById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(productVariants).where(eq(productVariants.id, id)).limit(1);
  return result[0];
}

export async function createVariant(data: InsertProductVariant) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(productVariants).values(data);
}

export async function updateVariant(id: number, data: Partial<InsertProductVariant>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(productVariants).set(data).where(eq(productVariants.id, id));
}

export async function deleteVariant(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Soft delete: نخفي الصنف بدل الحذف النهائي للحفاظ على سجلات المخزون المرتبطة
  await db.update(productVariants).set({ isActive: false }).where(eq(productVariants.id, id));
}

/** Low-level stock delta with no audit trail — kept for internal/legacy callers. Prefer addVariantInventoryMovement. */
export async function updateVariantStock(variantId: number, delta: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(productVariants)
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
    throw new Error(`الكمية الصادرة (${data.quantity}) أكبر من المخزون الحالي (${variant.currentStock})`);
  }
  const product = await getProductById(variant.productId);
  await db.insert(inventoryMovements).values({
    businessId: product?.businessId ?? 1,
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

export async function getAllVariantsWithProduct(businessId?: number, businessIds?: number[], opts: { includeInactive?: boolean } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (!opts.includeInactive) conditions.push(eq(productVariants.isActive, true));
  const allProducts = await getAllProducts(businessId, businessIds, { includeInactive: opts.includeInactive });
  const productIds = allProducts.map(p => p.id);
  if (productIds.length === 0) return [];
  conditions.push(inArray(productVariants.productId, productIds));
  const variants = await db.select().from(productVariants).where(and(...conditions))
    .orderBy(asc(productVariants.name), asc(productVariants.color), asc(productVariants.size));
  return variants.map(v => {
    const product = allProducts.find(p => p.id === v.productId);
    return { ...v, productName: product?.name || 'Unknown', businessId: product?.businessId };
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
  return db.select().from(orderEditLogs)
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
  const [currentOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!currentOrder) return null;

  updates = withNormalizedPhoneFields(updates);

  // Track changes
  const editLogEntries: InsertOrderEditLog[] = [];
  const FIELD_LABELS: Record<string, string> = {
    customerName: 'اسم العميل',
    customerPhone: 'رقم الهاتف',
    customerPhone2: 'هاتف بديل',
    customerAddress: 'العنوان',
    governorate: 'المحافظة',
    city: 'المدينة/المركز',
    productId: 'المنتج',
    productName: 'اسم المنتج',
    quantity: 'الكمية',
    totalAmount: 'الإجمالي',
    shippingFees: 'رسوم الشحن',
    paymentMethod: 'وسيلة الدفع',
    notes: 'ملاحظات العميل',
    employeeNotes: 'ملاحظات الموظف',
    variantId: 'المتغير',
    color: 'اللون',
    size: 'المقاس',
  };

  const allowedFields = Object.keys(FIELD_LABELS);
  const orderUpdates: Record<string, any> = {};

  for (const field of allowedFields) {
    if (field in updates) {
      const oldVal = String((currentOrder as any)[field] ?? '');
      const newVal = String(updates[field] ?? '');
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
  if ('quantity' in orderUpdates && currentOrder.status === 'confirmed' && currentOrder.productId != null) {
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
        type: diff > 0 ? 'out' : 'in',
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
      action: 'edit_order',
      entityType: 'order',
      entityId: orderId,
      description: `تعديل أوردر #${currentOrder.orderNumber}: ${editLogEntries.map(e => FIELD_LABELS[e.field] || e.field).join('، ')}`,
      metadata: { changes: editLogEntries.map(e => ({ field: e.field, old: e.oldValue, new: e.newValue })) },
      performedBy: editor.id,
      performedByName: editor.name,
      performedByRole: editor.role,
    });
  }

  // Return updated order
  const [updated] = await db.select().from(orders).where(eq(orders.id, orderId));
  return updated;
}


// ==================== ORDER ITEMS (بنود الأوردر المتعددة) ====================

/**
 * استبدال بنود أوردر بالكامل (حذف القديم وإضافة الجديد)
 * كل بند: { productId?, productName, quantity, unitPrice? }
 */
export async function replaceOrderItems(
  orderId: number,
  items: { productId?: number; productName: string; quantity: number; unitPrice?: number; variantId?: number; size?: string; color?: string }[]
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  // حذف البنود القديمة
  await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
  if (items.length === 0) return;
  // إضافة البنود الجديدة
  await db.insert(orderItems).values(
    items.map((it) => ({
      orderId,
      productId: it.productId ?? null,
      productName: it.productName,
      quantity: it.quantity,
      unitPrice: it.unitPrice != null ? it.unitPrice.toString() : null,
      variantId: it.variantId ?? null,
      size: it.size ?? null,
      color: it.color ?? null,
    }))
  );
}

/**
 * بند أوردر مع اسم نوع الحفر/المتغير الفعلي (product_variants.name) — لا يوجد نص محفوظ وقت
 * إنشاء الأوردر، فبيتجاب بـ join وقت القراءة عبر variantId الموجود بالفعل على كل بند. لو
 * الأوردر قديم قبل إضافة variants أو مفيهوش variant (منتج مفرد) بيرجع null.
 */
export type OrderItemWithVariant = OrderItem & { variantName: string | null };

/** جلب بنود أوردر واحد، مع اسم نوع الحفر لكل بند */
export async function getOrderItems(orderId: number): Promise<OrderItemWithVariant[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ ...getTableColumns(orderItems), variantName: productVariants.name })
    .from(orderItems)
    .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);
  return rows;
}

/** جلب بنود عدة أوردرات دفعة واحدة (مفهرسة حسب orderId)، مع اسم نوع الحفر لكل بند */
export async function getOrderItemsForOrders(orderIds: number[]): Promise<Map<number, OrderItemWithVariant[]>> {
  const map = new Map<number, OrderItemWithVariant[]>();
  if (orderIds.length === 0) return map;
  const db = await getDb();
  if (!db) return map;
  const { inArray } = await import('drizzle-orm');
  const rows = await db
    .select({ ...getTableColumns(orderItems), variantName: productVariants.name })
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
export async function getTreasuryBalance(businessIds?: number[] | null): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = businessIds && businessIds.length > 0
    ? [inArray(treasuryTransactions.businessId, businessIds)]
    : [];
  const [row] = await db.select({ balanceAfter: treasuryTransactions.balanceAfter })
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
  const signed = data.direction === "in" ? Number(data.amount) : -Number(data.amount);

  return db.transaction(async (tx) => {
    const [last] = await tx.select({ balanceAfter: treasuryTransactions.balanceAfter })
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
    const [row] = await tx.select().from(treasuryTransactions)
      .where(eq(treasuryTransactions.id, Number(insertId))).limit(1);
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
  if (!db) return { transactions: [], total: 0, page: 1, totalPages: 0 };
  const { page = 1, limit = 50 } = filters;

  const conditions: any[] = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(inArray(treasuryTransactions.businessId, filters.businessIds));
  }
  if (filters.type) conditions.push(eq(treasuryTransactions.type, filters.type as any));
  if (filters.direction) conditions.push(eq(treasuryTransactions.direction, filters.direction));
  if (filters.performedBy) conditions.push(eq(treasuryTransactions.performedBy, filters.performedBy));
  if (filters.dateFrom) conditions.push(gte(treasuryTransactions.transactionDate, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(treasuryTransactions.transactionDate, filters.dateTo));
  if (filters.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    conditions.push(or(
      sql`${treasuryTransactions.description} LIKE ${q}`,
      sql`${treasuryTransactions.notes} LIKE ${q}`,
      sql`${treasuryTransactions.performedByName} LIKE ${q}`,
    ));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db.select({ count: sql<number>`count(*)` })
    .from(treasuryTransactions).where(where);
  const total = Number(countRow?.count ?? 0);

  const transactions = await db.select().from(treasuryTransactions)
    .where(where)
    .orderBy(desc(treasuryTransactions.transactionDate), desc(treasuryTransactions.id))
    .limit(limit).offset((page - 1) * limit);

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
    return { transactions: cashRows, total, page, totalPages: Math.ceil(total / limit) };
  }

  // أحداث الأوردرات الجديدة — بتُدمج في صفحة النتائج المعروضة فقط.
  //
  // مقصودة إنها تدخل بعد الـpagination مش قبله: الترقيم بيفضل على الحركات النقدية (اللي
  // ليها أرصدة متسلسلة)، والالتزامات بتنضاف كسياق على نفس النطاق الزمني. لو دخلت في
  // الترقيم كان عدد الصفحات هيتغيّر بمجرد تشغيل الزر، والتاجر يفقد مكانه.
  const shown = cashRows.map(r => r.transactionDate.getTime()).filter(t => !Number.isNaN(t));
  const windowFrom = filters.dateFrom ?? (shown.length > 0 ? new Date(Math.min(...shown)) : undefined);
  const windowTo = filters.dateTo ?? (shown.length > 0 ? new Date(Math.max(...shown)) : undefined);

  const orderConditions: any[] = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    orderConditions.push(inArray(orders.businessId, filters.businessIds));
  }
  if (windowFrom) orderConditions.push(gte(orders.createdAt, windowFrom));
  if (windowTo) orderConditions.push(lte(orders.createdAt, windowTo));
  if (filters.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    orderConditions.push(or(
      sql`${orders.customerName} LIKE ${q}`,
      sql`${orders.orderNumber} LIKE ${q}`,
    ));
  }

  const orderRows = await db.select({
    id: orders.id,
    orderNumber: orders.orderNumber,
    customerName: orders.customerName,
    totalAmount: orders.totalAmount,
    createdAt: orders.createdAt,
    source: orders.source,
  }).from(orders)
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

  const merged = [...cashRows, ...commitmentRows]
    .sort((a, b) => b.transactionDate.getTime() - a.transactionDate.getTime());

  return { transactions: merged, total, page, totalPages: Math.ceil(total / limit) };
}

// ==================== EXPENSE CATEGORIES ====================

export async function getExpenseCategories(businessIds?: number[] | null, includeInactive = false) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (businessIds && businessIds.length > 0) {
    conditions.push(inArray(expenseCategories.businessId, businessIds));
  }
  if (!includeInactive) conditions.push(eq(expenseCategories.isActive, true));
  return db.select().from(expenseCategories)
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

export async function updateExpenseCategory(id: number, data: Partial<InsertExpenseCategory>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (Object.keys(data).length === 0) return;
  await db.update(expenseCategories).set(data).where(eq(expenseCategories.id, id));
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
  const [cat] = await db.select().from(expenseCategories).where(eq(expenseCategories.id, id)).limit(1);
  if (!cat) throw new Error("التصنيف غير موجود");
  if (cat.isSystem) throw new Error("لا يمكن حذف تصنيف أساسي");
  await db.update(expenseCategories).set({ isActive: false }).where(eq(expenseCategories.id, id));
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
  if (!db) return { expenses: [], total: 0, page: 1, totalPages: 0, totalAmount: 0 };
  const { page = 1, limit = 50 } = filters;

  const conditions: any[] = [];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(inArray(expenses.businessId, filters.businessIds));
  }
  if (filters.categoryId) conditions.push(eq(expenses.categoryId, filters.categoryId));
  if (filters.dateFrom) conditions.push(gte(expenses.expenseDate, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(expenses.expenseDate, filters.dateTo));
  if (filters.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    conditions.push(or(
      sql`${expenses.description} LIKE ${q}`,
      sql`${expenses.reference} LIKE ${q}`,
      sql`${expenses.createdByName} LIKE ${q}`,
    ));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [agg] = await db.select({
    count: sql<number>`count(*)`,
    sum: sql<string>`COALESCE(SUM(${expenses.amount}), 0)`,
  }).from(expenses).where(where);
  const total = Number(agg?.count ?? 0);

  // اسم التصنيف بـleftJoin: مصروف بتصنيف مؤرشف أو محذوف لازم يفضل ظاهر، فالـjoin
  // مايقدرش يبقى inner.
  const rows = await db.select({
    ...getTableColumns(expenses),
    categoryName: expenseCategories.name,
  }).from(expenses)
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(where)
    .orderBy(desc(expenses.expenseDate), desc(expenses.id))
    .limit(limit).offset((page - 1) * limit);

  return {
    expenses: rows,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    totalAmount: Number(agg?.sum ?? 0),
  };
}

/**
 * إنشاء مصروف + حركة الخزنة المقابلة له.
 *
 * الاتنين مع بعض عن قصد: مصروف بدون حركة خزنة معناه إن الرصيد بيكدب، وده أسوأ من
 * فشل الإدخال كله. لو حركة الخزنة فشلت بنرجّع المصروف.
 */
export async function createExpense(data: InsertExpense) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result: any = await db.insert(expenses).values(data);
  const insertId = Number(result?.insertId ?? result?.[0]?.insertId);
  if (!insertId) throw new Error("تعذر إنشاء المصروف");

  try {
    await addTreasuryTransaction({
      businessId: data.businessId,
      type: "expense",
      direction: "out",
      amount: String(data.amount),
      description: data.description,
      referenceType: "expense",
      referenceId: insertId,
      performedBy: data.createdBy,
      performedByName: data.createdByName,
      transactionDate: data.expenseDate,
    } as any);
  } catch (error) {
    await db.delete(expenses).where(eq(expenses.id, insertId));
    throw error;
  }
  return { id: insertId };
}

/**
 * تعديل مصروف — بيسجّل حركة تسوية بالفرق، مش بيعدّل حركة الخزنة القديمة.
 *
 * الـledger مايتعدّلش بأثر رجعي: تعديل صف قديم كان معناه إن كل الأرصدة اللي بعده بقت
 * غلط، وإن التاريخ نفسه مش موثوق. التسوية بتخلي المسار مقروء: صرفنا ١٠٠، بعدين
 * اتصحّح لـ١٢٠، فطلعت ٢٠ زيادة.
 */
export async function updateExpense(
  id: number,
  data: Partial<InsertExpense>,
  actor: { id: number; name: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [before] = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
  if (!before) throw new Error("المصروف غير موجود");
  if (Object.keys(data).length === 0) return;

  await db.update(expenses).set(data).where(eq(expenses.id, id));

  if (data.amount != null) {
    const delta = Number(data.amount) - Number(before.amount);
    if (delta !== 0) {
      await addTreasuryTransaction({
        businessId: before.businessId,
        type: "adjustment",
        direction: delta > 0 ? "out" : "in",
        amount: Math.abs(delta).toFixed(2),
        description: `تسوية تعديل مصروف: ${before.description}`,
        notes: `من ${Number(before.amount).toFixed(2)} إلى ${Number(data.amount).toFixed(2)}`,
        referenceType: "expense",
        referenceId: id,
        performedBy: actor.id,
        performedByName: actor.name,
        transactionDate: new Date(),
      } as any);
    }
  }
}

/** حذف مصروف — بيرجّع قيمته للخزنة بحركة تسوية بدل ما يشيل الحركة الأصلية. */
export async function deleteExpense(id: number, actor: { id: number; name: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [before] = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
  if (!before) throw new Error("المصروف غير موجود");

  await db.delete(expenses).where(eq(expenses.id, id));
  await addTreasuryTransaction({
    businessId: before.businessId,
    type: "adjustment",
    direction: "in",
    amount: String(before.amount),
    description: `إلغاء مصروف: ${before.description}`,
    referenceType: "expense",
    referenceId: id,
    performedBy: actor.id,
    performedByName: actor.name,
    transactionDate: new Date(),
  } as any);
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
  if (!db) return { orders: [], total: 0, page: 1, totalPages: 0, expectedTotal: 0, collectedTotal: 0 };
  const { page = 1, limit = 50 } = filters;

  const conditions: any[] = [
    inArray(orders.status, ['printed', 'preparing', 'shipped', 'delivered', 'returned'] as any),
  ];
  if (filters.businessIds && filters.businessIds.length > 0) {
    conditions.push(inArray(orders.businessId, filters.businessIds));
  }
  if (filters.collectionStatus) {
    conditions.push(eq(orders.collectionStatus, filters.collectionStatus as any));
  }
  if (filters.dateFrom) conditions.push(gte(orders.shippedAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(orders.shippedAt, filters.dateTo));
  if (filters.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    conditions.push(or(
      sql`${orders.customerName} LIKE ${q}`,
      sql`${orders.orderNumber} LIKE ${q}`,
      sql`${orders.customerPhone} LIKE ${q}`,
    ));
  }
  const where = and(...conditions);

  const [agg] = await db.select({
    count: sql<number>`count(*)`,
    expected: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
    collected: sql<string>`COALESCE(SUM(${orders.collectedAmount}), 0)`,
  }).from(orders).where(where);

  const rows = await db.select({
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
  }).from(orders)
    .where(where)
    .orderBy(desc(orders.shippedAt), desc(orders.id))
    .limit(limit).offset((page - 1) * limit);

  // "الموظف الذي قام بالتحصيل" — مشتق من آخر حركة تحصيل للأوردر في الخزنة، مش من عمود
  // جديد على orders. الخزنة بتسجّل performedByName مع كل حركة أصلاً، فالمعلومة موجودة
  // ومضاف عمود denormalized كان هيبقى نسخة تانية ممكن تختلف عنها.
  const collectorByOrderId = new Map<number, string>();
  const orderIds = rows.map(r => r.id);
  if (orderIds.length > 0) {
    const collectors = await db.select({
      referenceId: treasuryTransactions.referenceId,
      performedByName: treasuryTransactions.performedByName,
      id: treasuryTransactions.id,
    }).from(treasuryTransactions)
      .where(and(
        eq(treasuryTransactions.referenceType, 'order'),
        inArray(treasuryTransactions.referenceId, orderIds),
      ))
      .orderBy(asc(treasuryTransactions.id));
    // الترتيب تصاعدي والكتابة بتستبدل، فآخر حركة هي اللي تفضل — وهي آخر مين لمس التحصيل
    for (const c of collectors) {
      if (c.referenceId != null) collectorByOrderId.set(c.referenceId, c.performedByName);
    }
  }

  const total = Number(agg?.count ?? 0);
  return {
    orders: rows.map(r => ({ ...r, collectedByName: collectorByOrderId.get(r.id) ?? null })),
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
  collectedAt?: Date,
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("الأوردر غير موجود");

  const expected = Number(order.totalAmount);
  const previous = order.collectedAmount != null ? Number(order.collectedAmount) : 0;
  const status = collectedAmount <= 0 ? 'failed'
    : collectedAmount < expected ? 'partial'
    : 'collected';
  const when = collectedAt ?? new Date();

  await db.update(orders).set({
    collectedAmount: collectedAmount.toFixed(2),
    collectedAt: when,
    collectionStatus: status as any,
  }).where(eq(orders.id, orderId));

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
      notes: previous === 0 ? undefined : `تصحيح من ${previous.toFixed(2)} إلى ${collectedAmount.toFixed(2)}`,
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
    totalSales: 0, totalCollected: 0, shippingCost: 0, productCost: 0,
    totalExpenses: 0, totalReturns: 0, treasuryBalance: 0, netProfit: 0,
    pendingCollection: 0, profitMargin: 0,
    todaySales: 0, todayOrders: 0, monthSales: 0, monthOrders: 0,
    movementByDay: [] as { day: string; inflow: number; outflow: number }[],
  };
  if (!db) return empty;

  const { businessIds, dateFrom, dateTo } = params;
  const scope = (col: any) => businessIds && businessIds.length > 0 ? [inArray(col, businessIds)] : [];
  const range = (col: any) => {
    const c: any[] = [];
    if (dateFrom) c.push(gte(col, dateFrom));
    if (dateTo) c.push(lte(col, dateTo));
    return c;
  };
  const whereOf = (conds: any[]) => conds.length > 0 ? and(...conds) : undefined;

  // المبيعات والشحن: الأوردرات اللي وصلت مرحلة الشحن. الملغي والجديد مش مبيعات.
  const soldStatuses = ['printed', 'preparing', 'shipped', 'delivered', 'returned'] as any;
  const [sales] = await db.select({
    sales: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
    shipping: sql<string>`COALESCE(SUM(${orders.shippingFees}), 0)`,
    collected: sql<string>`COALESCE(SUM(${orders.collectedAmount}), 0)`,
  }).from(orders).where(whereOf([
    inArray(orders.status, soldStatuses),
    ...scope(orders.businessId),
    ...range(orders.createdAt),
  ]));

  // مبيعات اليوم والشهر — مستقلّة عن فلتر التاريخ عن قصد.
  //
  // البطاقتين دول بيجاوبوا "إيه اللي بيحصل دلوقتي؟"، فلازم يفضلوا ثابتين لما التاجر
  // يفلتر على شهر قديم. لو خضعوا للفلتر كانوا هيقولوا "مبيعات اليوم: صفر" وهو بيبص على
  // مارس، وده رقم صح بمعنى غلط. بتوقيت القاهرة زي باقي حسابات "اليوم" في النظام.
  const cairoNow = new Date(Date.now() + CAIRO_OFFSET_MS);
  const todayStart = new Date(cairoNow.toISOString().slice(0, 10) + "T00:00:00Z");
  const monthStart = new Date(cairoNow.toISOString().slice(0, 8) + "01T00:00:00Z");

  const [todayRow] = await db.select({
    amount: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(orders).where(whereOf([
    inArray(orders.status, soldStatuses),
    gte(orders.createdAt, todayStart),
    ...scope(orders.businessId),
  ]));

  const [monthRow] = await db.select({
    amount: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(orders).where(whereOf([
    inArray(orders.status, soldStatuses),
    gte(orders.createdAt, monthStart),
    ...scope(orders.businessId),
  ]));

  // المعلّق: المتوقع ناقص المحصّل للأوردرات اللي لسه مش محصّلة
  const [pending] = await db.select({
    amount: sql<string>`COALESCE(SUM(${orders.totalAmount} - COALESCE(${orders.collectedAmount}, 0)), 0)`,
  }).from(orders).where(whereOf([
    inArray(orders.status, soldStatuses),
    inArray(orders.collectionStatus, ['pending', 'partial'] as any),
    ...scope(orders.businessId),
    ...range(orders.createdAt),
  ]));

  // تكلفة المنتجات: من بنود الأوردر مضروبة في costPrice للـvariant.
  //
  // نقص معروف: `costPrice` موجود على product_variants بس، مش على products. يعني منتج
  // بدون variants (زي "مسند سيارة") تكلفته بتتحسب صفر، والرقم ده أقل من الحقيقي.
  // الإصلاح محتاج عمود products.costPrice — مرصود للمرحلة الجاية ومش داخل في المطلوب هنا.
  const [cost] = await db.select({
    amount: sql<string>`COALESCE(SUM(${orderItems.quantity} * COALESCE(${productVariants.costPrice}, 0)), 0)`,
  }).from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
    .where(whereOf([
      inArray(orders.status, soldStatuses),
      ...scope(orders.businessId),
      ...range(orders.createdAt),
    ]));

  const [exp] = await db.select({
    amount: sql<string>`COALESCE(SUM(${expenses.amount}), 0)`,
  }).from(expenses).where(whereOf([...scope(expenses.businessId), ...range(expenses.expenseDate)]));

  const [ret] = await db.select({
    amount: sql<string>`COALESCE(SUM(${returnsTable.totalAmount}), 0)`,
  }).from(returnsTable).where(whereOf([...scope(returnsTable.businessId), ...range(returnsTable.returnedAt)]));

  // الحركة المالية بالأيام — للرسم البياني
  const movement = await db.select({
    day: sql<string>`DATE(${treasuryTransactions.transactionDate})`,
    inflow: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'in' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
    outflow: sql<string>`COALESCE(SUM(CASE WHEN ${treasuryTransactions.direction} = 'out' THEN ${treasuryTransactions.amount} ELSE 0 END), 0)`,
  }).from(treasuryTransactions)
    .where(whereOf([...scope(treasuryTransactions.businessId), ...range(treasuryTransactions.transactionDate)]))
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
  const netProfit = totalSales - (productCost + shippingCost + totalExpenses + totalReturns);

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
  return db.select().from(treasuryTransactions)
    .where(and(
      eq(treasuryTransactions.referenceType, 'order'),
      eq(treasuryTransactions.referenceId, orderId),
    ))
    .orderBy(asc(treasuryTransactions.transactionDate), asc(treasuryTransactions.id));
}
