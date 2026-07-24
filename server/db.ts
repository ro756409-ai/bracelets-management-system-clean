import { eq, desc, asc, and, or, gte, lte, sql, inArray, isNull } from "drizzle-orm";
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
  productVariants, InsertProductVariant, ProductVariant,
  orderEditLogs, InsertOrderEditLog, OrderEditLog,
  scanLogs, InsertScanLog,
  orderItems, InsertOrderItem, OrderItem,
} from "../drizzle/schema";
import { ENV } from './_core/env';
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
export async function getAllBusinesses() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(businesses).orderBy(asc(businesses.name));
}

export async function getActiveBusinesses() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(businesses).where(eq(businesses.isActive, true)).orderBy(asc(businesses.name));
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
  await db.insert(businesses).values(data);
}

export async function updateBusiness(id: number, data: Partial<InsertBusiness>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
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
    else if (user.openId === ENV.ownerOpenId) { values.role = 'admin'; updateSet.role = 'admin'; }
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
export async function getAllEmployees(businessId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (businessId) conditions.push(eq(employees.businessId, businessId));
  return db.select().from(employees)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(employees.name));
}

export async function getActiveEmployees(businessId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(employees.isActive, true)];
  if (businessId) conditions.push(eq(employees.businessId, businessId));
  return db.select().from(employees)
    .where(and(...conditions))
    .orderBy(asc(employees.name));
}

export async function getEmployeeById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
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
export async function getAllProducts(businessId?: number, businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(products.isActive, true)];
  if (businessIds && businessIds.length > 0) {
    conditions.push(inArray(products.businessId, businessIds));
  } else if (businessId) {
    conditions.push(eq(products.businessId, businessId));
  }
  return db.select().from(products)
    .where(and(...conditions))
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

export async function getLowStockProducts(businessId?: number, businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [
    eq(products.isActive, true),
    sql`${products.currentStock} <= ${products.minStockLevel}`
  ];
  if (businessIds && businessIds.length > 0) {
    conditions.push(inArray(products.businessId, businessIds));
  } else if (businessId) {
    conditions.push(eq(products.businessId, businessId));
  }
  return db.select().from(products).where(and(...conditions));
}

// ==================== ORDERS ====================
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

export async function updateOrder(id: number, data: Partial<InsertOrder>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
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

export async function confirmOrder(orderId: number, updatedBy: number) {
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

  if (isConfirmed && (updates.productId !== undefined || updates.quantity !== undefined)) {
    await addInventoryMovement({
      productId: oldProductId,
      type: 'in',
      quantity: oldQty,
      reason: `تعديل أوردر ${order.orderNumber} - إرجاع قديم`,
      orderId: order.id,
      performedBy: updatedBy,
      businessId: order.businessId ?? 1,
    });
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

// ==================== INVENTORY ====================
export async function addInventoryMovement(data: InsertInventoryMovement) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(inventoryMovements).values(data);
  const delta = data.type === 'in' ? data.quantity : -data.quantity;
  await updateProductStock(data.productId, delta);
}

export async function getInventoryMovements(productId?: number, limit = 50, businessId?: number, businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (productId) conditions.push(eq(inventoryMovements.productId, productId));
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

  if (restoreStock) {
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
export async function getAllSalesChannels(businessId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (businessId) conditions.push(eq(salesChannels.businessId, businessId));
  return db.select().from(salesChannels)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(salesChannels.createdAt));
}

export async function getActiveSalesChannels(businessId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(salesChannels.isActive, true)];
  if (businessId) conditions.push(eq(salesChannels.businessId, businessId));
  return db.select().from(salesChannels)
    .where(and(...conditions))
    .orderBy(asc(salesChannels.name));
}

export async function getSalesChannelById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(salesChannels).where(eq(salesChannels.id, id)).limit(1);
  return result[0];
}

export async function getSalesChannelByWebhookSecret(secret: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(salesChannels)
    .where(and(eq(salesChannels.webhookSecret, secret), eq(salesChannels.isActive, true)))
    .limit(1);
  return result[0];
}

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
  await db.update(salesChannels).set(data).where(eq(salesChannels.id, id));
}

export async function deleteSalesChannel(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Soft delete - just deactivate
  await db.update(salesChannels).set({ isActive: false }).where(eq(salesChannels.id, id));
}

// ==================== PRODUCT VARIANTS ====================
export async function getVariantsByProduct(productId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(productVariants)
    .where(and(eq(productVariants.productId, productId), eq(productVariants.isActive, true)))
    .orderBy(asc(productVariants.color), asc(productVariants.size));
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

export async function updateVariantStock(variantId: number, delta: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(productVariants)
    .set({ currentStock: sql`${productVariants.currentStock} + ${delta}` })
    .where(eq(productVariants.id, variantId));
}

export async function getAllVariantsWithProduct(businessId?: number, businessIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [eq(productVariants.isActive, true)];
  const allProducts = await getAllProducts(businessId, businessIds);
  const productIds = allProducts.map(p => p.id);
  if (productIds.length === 0) return [];
  conditions.push(inArray(productVariants.productId, productIds));
  const variants = await db.select().from(productVariants).where(and(...conditions))
    .orderBy(asc(productVariants.color), asc(productVariants.size));
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

  // Handle inventory changes if quantity changed
  if ('quantity' in orderUpdates && currentOrder.status === 'confirmed') {
    const oldQty = currentOrder.quantity;
    const newQty = orderUpdates.quantity;
    const diff = newQty - oldQty;
    if (diff !== 0) {
      // Deduct additional from stock if increased, restore if decreased
      await updateProductStock(currentOrder.productId, -diff);
      await addInventoryMovement({
        businessId: currentOrder.businessId,
        productId: currentOrder.productId,
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

/** جلب بنود أوردر واحد */
export async function getOrderItems(orderId: number): Promise<OrderItem[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(orderItems.id);
}

/** جلب بنود عدة أوردرات دفعة واحدة (مفهرسة حسب orderId) */
export async function getOrderItemsForOrders(orderIds: number[]): Promise<Map<number, OrderItem[]>> {
  const map = new Map<number, OrderItem[]>();
  if (orderIds.length === 0) return map;
  const db = await getDb();
  if (!db) return map;
  const { inArray } = await import('drizzle-orm');
  const rows = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds)).orderBy(orderItems.id);
  for (const r of rows) {
    const list = map.get(r.orderId) ?? [];
    list.push(r);
    map.set(r.orderId, list);
  }
  return map;
}
