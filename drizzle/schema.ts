import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  decimal,
  boolean,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// ==================== TENANTS ====================
// حساب التاجر المستقل — طبقة عزل البيانات بين التجار (multi-tenancy). كل tenant ممكن يملك
// أكتر من business (براند) تحته، زي الحساب الحالي اللي عنده براندين (مفروشات السعد / غطي)
// تحت مالك واحد. الحساب الحقيقي الحالي بيتحول لـ tenant #1 في خطوة الـbackfill المنفصلة
// (data migration)، مش جزء من هذا التعديل الإضافي على الـschema.
export const tenants = mysqlTable("tenants", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 150 }).notNull(),
  slug: varchar("slug", { length: 60 }).notNull().unique(),
  status: mysqlEnum("status", ["trialing", "active", "past_due", "canceled"]).default("trialing").notNull(),
  trialEndsAt: timestamp("trialEndsAt"),
  ownerName: varchar("ownerName", { length: 150 }),
  ownerEmail: varchar("ownerEmail", { length: 320 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type InsertTenant = typeof tenants.$inferInsert;

// ==================== BUSINESS GROUPS ====================
// Optional tenant-owned sub-entity: platform -> tenant -> (optional) business group -> business.
// A group belongs to exactly one tenant; a business may optionally belong to a group, but only
// one that belongs to the SAME tenant as the business (enforced in code — see
// db.ts createBusiness/updateBusiness — since this schema has no DB-level FKs anywhere).
export const businessGroups = mysqlTable("business_groups", {
  id: int("id").autoincrement().primaryKey(),
  // NULLABLE, NO DATABASE DEFAULT — deliberately. A schema-level DEFAULT is itself a silent
  // tenant fallback, same category of risk as a runtime `tenantId ?? 1`. This column is
  // populated ONLY by the explicit, reviewed backfill script (scripts/backfillLegacyTenant.ts)
  // and only becomes NOT NULL in a later migration once that backfill is verified with zero
  // remaining NULLs (see docs/multi-tenant-deployment.md).
  tenantId: int("tenantId"),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 50 }).notNull().unique(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type BusinessGroup = typeof businessGroups.$inferSelect;
export type InsertBusinessGroup = typeof businessGroups.$inferInsert;

// ==================== BUSINESSES ====================
export const businesses = mysqlTable("businesses", {
  id: int("id").autoincrement().primaryKey(),
  // CORRECTED (forward-only, see migration 0030): migration 0028 originally added this column
  // as `NOT NULL DEFAULT 1` in a single step — a database-level tenant fallback of exactly the
  // kind now disallowed, and it made existing businesses NOT NULL before any real tenant #1 row
  // ever existed. 0028 is left untouched (unknown whether it already ran against a real
  // database) — this nullable-no-default shape is applied by a NEW forward migration instead.
  // Populated only by scripts/backfillLegacyTenant.ts, NOT NULL only after validation passes.
  tenantId: int("tenantId"),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 50 }).notNull().unique(),
  groupId: int("groupId"),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Business = typeof businesses.$inferSelect;
export type InsertBusiness = typeof businesses.$inferInsert;

// ==================== SUBSCRIPTION PLANS ====================
export const subscriptionPlans = mysqlTable("subscription_plans", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 50 }).notNull().unique(),
  priceMonthly: decimal("priceMonthly", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).default("EGP").notNull(),
  maxEmployees: int("maxEmployees"),
  maxOrdersPerMonth: int("maxOrdersPerMonth"),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type InsertSubscriptionPlan = typeof subscriptionPlans.$inferInsert;

// ==================== SUBSCRIPTIONS ====================
export const subscriptions = mysqlTable("subscriptions", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  planId: int("planId").notNull(),
  status: mysqlEnum("status", ["trialing", "active", "past_due", "canceled"]).default("trialing").notNull(),
  currentPeriodStart: timestamp("currentPeriodStart"),
  currentPeriodEnd: timestamp("currentPeriodEnd"),
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").default(false).notNull(),
  canceledAt: timestamp("canceledAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type InsertSubscription = typeof subscriptions.$inferInsert;

// ==================== PAYMENT GATEWAY CONFIGS ====================
// إعدادات بوابة الدفع الخاصة بكل tenant — كل تاجر يختار ويربط بوابته بنفسه من الإعدادات.
// نفس نمط الإخفاء/التأمين المستخدم فعلاً في sales_channels.apiToken/webhookSecret.
//
// SECURITY (schema preparation only — do not store real credentials yet): this codebase has
// no encryption/secret-manager utility anywhere today (audited — no crypto helper, no KMS/vault
// dependency). `credentials` is plain `text` for now purely to reserve the shape. Before any
// real tenant payment credential is ever written here, application-level encryption at rest
// must be implemented (e.g. AES-GCM with a key from env, never the raw value). Until then this
// column must stay unused by any live integration code path. Never return its value to the
// frontend and never log it, regardless of encryption status.
export const paymentGatewayConfigs = mysqlTable("payment_gateway_configs", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  provider: mysqlEnum("provider", ["paymob", "stripe", "fawry", "other"]).notNull(),
  displayName: varchar("displayName", { length: 100 }),
  credentials: text("credentials"),
  isActive: boolean("isActive").default(false).notNull(),
  lastVerifiedAt: timestamp("lastVerifiedAt"),
  lastVerificationStatus: mysqlEnum("lastVerificationStatus", ["never", "connected", "failed"]).default("never").notNull(),
  lastVerificationError: text("lastVerificationError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type PaymentGatewayConfig = typeof paymentGatewayConfigs.$inferSelect;
export type InsertPaymentGatewayConfig = typeof paymentGatewayConfigs.$inferInsert;

// ==================== PLAN FEATURES / LIMITS (normalized, not a JSON blob) ====================
export const planFeatures = mysqlTable("plan_features", {
  id: int("id").autoincrement().primaryKey(),
  planId: int("planId").notNull(),
  // Validated server-side against a fixed known-code list — see permissions.ts-style constant,
  // not scattered plan-name string checks throughout the app.
  featureCode: varchar("featureCode", { length: 60 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  // Feature-specific configuration only (e.g. a rate limit for that one feature) — never a
  // dumping ground for the whole plan's permissions.
  configurationJson: text("configurationJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  planFeatureUnique: uniqueIndex("plan_features_plan_id_feature_code_unique").on(table.planId, table.featureCode),
}));

export type PlanFeature = typeof planFeatures.$inferSelect;
export type InsertPlanFeature = typeof planFeatures.$inferInsert;

export const planLimits = mysqlTable("plan_limits", {
  id: int("id").autoincrement().primaryKey(),
  planId: int("planId").notNull(),
  limitCode: varchar("limitCode", { length: 60 }).notNull(),
  limitValue: int("limitValue").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  planLimitUnique: uniqueIndex("plan_limits_plan_id_limit_code_unique").on(table.planId, table.limitCode),
}));

export type PlanLimit = typeof planLimits.$inferSelect;
export type InsertPlanLimit = typeof planLimits.$inferInsert;

// ==================== CATEGORIES ====================
export const categories = mysqlTable("categories", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Category = typeof categories.$inferSelect;
export type InsertCategory = typeof categories.$inferInsert;

// ==================== WAREHOUSES ====================
export const warehouses = mysqlTable("warehouses", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Warehouse = typeof warehouses.$inferSelect;
export type InsertWarehouse = typeof warehouses.$inferInsert;

// ==================== USERS ====================
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// جدول الموظفين
export const employees = mysqlTable("employees", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  phone: varchar("phone", { length: 20 }),
  email: varchar("email", { length: 320 }),
  role: mysqlEnum("role", [
    // existing roles — unchanged, still drive current admin/manager/employee-portal auth
    "agent", "warehouse", "manager", "facebook_entry", "scanner",
    // new roles (Sprint 3 employee management) — additive only
    "super_admin", "admin", "data_entry", "order_confirmation", "shipping", "accountant", "viewer",
  ]).default("agent").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  // The tenant this employee belongs to — the authoritative source for auth-time tenant
  // resolution (see server/_core/context.ts). Deliberately NULLABLE WITH NO DEFAULT: unlike
  // businesses.tenantId/businessGroups.tenantId (which safely default existing rows to tenant
  // #1 as pure migration backfill machinery), this column drives live authentication decisions
  // — it must only ever be populated by an explicit backfill migration, never implied by a
  // schema default, so a session with no resolvable tenant is rejected instead of silently
  // treated as tenant #1.
  tenantId: int("tenantId"),
  businessId: int("businessId"),
  userId: int("userId"),
  username: varchar("username", { length: 50 }).unique(),
  passwordHash: varchar("passwordHash", { length: 255 }),
  lastLoginAt: timestamp("lastLoginAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Employee = typeof employees.$inferSelect;
export type InsertEmployee = typeof employees.$inferInsert;

// جدول المنتجات
export const products = mysqlTable("products", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull().default(1),
  categoryId: int("categoryId"),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  // sku/price are nullable: a parent product with variants (e.g. "أسورة نحاس") carries no SKU or
  // price of its own — those live on product_variants. Standalone products without variants
  // (e.g. "مسند سيارة") still set both, same as before this change.
  sku: varchar("sku", { length: 50 }).unique(),
  price: decimal("price", { precision: 10, scale: 2 }),
  currentStock: int("currentStock").default(0).notNull(),
  minStockLevel: int("minStockLevel").default(15).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

// جدول الطلبات
export const orders = mysqlTable("orders", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull().default(1),
  orderNumber: varchar("orderNumber", { length: 20 }).notNull().unique(),
  customerName: varchar("customerName", { length: 100 }).notNull(),
  customerPhone: varchar("customerPhone", { length: 20 }).notNull(),
  customerPhone2: varchar("customerPhone2", { length: 20 }),
  customerAddress: text("customerAddress").notNull(),
  governorate: varchar("governorate", { length: 50 }).notNull(),
  city: varchar("city", { length: 100 }),
  // Nullable: an order awaiting manual product review (needsReview) genuinely has no product
  // yet. Previously NOT NULL, which forced the EasyOrder webhook to silently attach
  // unmatched orders to productId=1. Several call sites already guarded for null.
  productId: int("productId"),
  productName: varchar("productName", { length: 200 }).notNull(),
  quantity: int("quantity").default(1).notNull(),
  totalAmount: decimal("totalAmount", { precision: 10, scale: 2 }).notNull(),
  shippingFees: decimal("shippingFees", { precision: 10, scale: 2 }).default("0"),
  paymentMethod: varchar("paymentMethod", { length: 50 }).default("cod"),
  status: mysqlEnum("status", [
    "new",
    "confirmed",
    "postponed",
    "cancelled",
    "preparing",
    "shipped",
    "delivered",
    "no_answer",
    "returned",
    "printed",
  ]).default("new").notNull(),
  source: mysqlEnum("source", ["easyorder", "easyorder_ataba", "easyorder_farhat", "easyorder_flashbox", "shopify", "whatsapp", "manual", "facebook"]).default("manual").notNull(),
  assignedEmployeeId: int("assignedEmployeeId"),
  assignedAt: timestamp("assignedAt"),
  confirmedAt: timestamp("confirmedAt"),
  // Who actually confirmed the order — set once, at confirm time, from the acting
  // session server-side (never trusts a frontend-supplied name). Denormalized name
  // so the record stays readable even if the employee row is later deleted.
  confirmedByEmployeeId: int("confirmedByEmployeeId"),
  confirmedByEmployeeName: varchar("confirmedByEmployeeName", { length: 100 }),
  cancelledAt: timestamp("cancelledAt"),
  shippedAt: timestamp("shippedAt"),
  deliveredAt: timestamp("deliveredAt"),
  printedAt: timestamp("printedAt"),
  postponedTo: timestamp("postponedTo"),
  websiteId: int("websiteId"),
  variantId: int("variantId"),
  color: varchar("color", { length: 100 }),
  size: varchar("size", { length: 100 }),
  cancelReason: mysqlEnum("cancelReason", ["price", "not_serious", "wrong_number", "duplicate"]),
  // Confirmation-employee feedback captured at the moment an order is marked "no_answer" —
  // how many times they actually tried calling this round. Nullable: only ever set by the
  // markNoAnswer mutation, never a default; overwritten (not accumulated) on each no_answer
  // mark, matching "how many times this round", not a lifetime counter.
  noAnswerCallAttempts: int("noAnswerCallAttempts"),
  notes: text("notes"),
  employeeNotes: text("employeeNotes"),
  lastUpdatedBy: int("lastUpdatedBy"),
  importRowIndex: int("importRowIndex"),
  importBatchId: int("importBatchId"),
  externalOrderId: varchar("externalOrderId", { length: 100 }),
  easyOrderShortId: int("easyOrderShortId"),
  // Full untruncated payload of the external order, kept so a mis-mapped order can be
  // re-processed later without re-fetching from the provider.
  externalRawPayload: text("externalRawPayload"),
  // `updated_at` reported by the external system — used to decide whether an incoming
  // payload is newer than what we already stored.
  externalUpdatedAt: timestamp("externalUpdatedAt"),
  // Set when an order could not be confidently mapped to a product/variant. Such orders are
  // created (never dropped) but flagged for manual review instead of being silently
  // attached to an arbitrary product.
  needsReview: boolean("needsReview").default(false).notNull(),
  reviewReason: text("reviewReason"),
  adName: varchar("adName", { length: 255 }),
  pageName: varchar("pageName", { length: 255 }),
  isDuplicate: boolean("isDuplicate").default(false).notNull(),
  duplicateMarkedAt: timestamp("duplicateMarkedAt"),
  duplicateMarkedBy: int("duplicateMarkedBy"),
  // Bosta integration fields
  bostaShipmentId: varchar("bostaShipmentId", { length: 100 }),
  bostaTrackingNumber: varchar("bostaTrackingNumber", { length: 100 }),
  bostaSentAt: timestamp("bostaSentAt"),
  bostaStatus: varchar("bostaStatus", { length: 50 }),
  bostaLastError: text("bostaLastError"),
  // QR Code + Preparation fields
  serialNumber: varchar("serialNumber", { length: 30 }).unique(),
  isPrepared: boolean("isPrepared").default(false).notNull(),
  preparedAt: timestamp("preparedAt"),
  preparedBy: int("preparedBy"),
  preparedByName: varchar("preparedByName", { length: 100 }),
  scanCount: int("scanCount").default(0).notNull(),
  lastScannedAt: timestamp("lastScannedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;

// جدول بنود الأوردر (أنواع الحفر/المنتجات المتعددة داخل الأوردر الواحد)
export const orderItems = mysqlTable("order_items", {
  id: int("id").autoincrement().primaryKey(),
  orderId: int("orderId").notNull(),
  productId: int("productId"),
  productName: varchar("productName", { length: 200 }).notNull(),
  quantity: int("quantity").default(1).notNull(),
  unitPrice: decimal("unitPrice", { precision: 10, scale: 2 }),
  variantId: int("variantId"),
  size: varchar("size", { length: 100 }),
  color: varchar("color", { length: 100 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type OrderItem = typeof orderItems.$inferSelect;
export type InsertOrderItem = typeof orderItems.$inferInsert;

// جدول قنوات البيع / المواقع
export const salesChannels = mysqlTable("sales_channels", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  domain: varchar("domain", { length: 255 }),
  platform: mysqlEnum("platform", ["easyorder", "shopify", "woocommerce", "whatsapp", "facebook", "instagram", "manual", "other"]).default("other").notNull(),
  apiToken: text("apiToken"),
  webhookSecret: text("webhookSecret"),
  webhookUrl: text("webhookUrl"),
  // Base URL for this channel's API (EasyOrder etc.). Null = use the provider default.
  apiBaseUrl: varchar("apiBaseUrl", { length: 300 }),
  isActive: boolean("isActive").default(true).notNull(),
  // ---- Sync status (set by an actual order sync) ----
  lastSyncAt: timestamp("lastSyncAt"),
  lastSyncStatus: mysqlEnum("lastSyncStatus", ["never", "success", "error"]).default("never").notNull(),
  lastSyncError: text("lastSyncError"),
  lastSyncedOrderCount: int("lastSyncedOrderCount").default(0).notNull(),
  // ---- Connection-test status (set by the read-only credential check; kept separate from
  // sync status so a failed import never looks like broken credentials, and vice versa) ----
  lastConnectionTestAt: timestamp("lastConnectionTestAt"),
  lastConnectionStatus: mysqlEnum("lastConnectionStatus", ["never", "connected", "failed"]).default("never").notNull(),
  lastConnectionError: text("lastConnectionError"),
  /** Store name/identifier reported by the provider, when the endpoint exposes one. */
  externalStoreName: varchar("externalStoreName", { length: 200 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type SalesChannel = typeof salesChannels.$inferSelect;
export type InsertSalesChannel = typeof salesChannels.$inferInsert;

// سجل عمليات المزامنة (webhook + مزامنة يدوية) لكل قناة بيع
export const syncLogs = mysqlTable("sync_logs", {
  id: int("id").autoincrement().primaryKey(),
  channelId: int("channelId"),
  provider: varchar("provider", { length: 30 }).notNull(), // 'easyorder'
  trigger: mysqlEnum("trigger", ["webhook", "manual", "retry"]).notNull(),
  status: mysqlEnum("status", ["running", "success", "partial", "error"]).default("running").notNull(),
  // Range requested for a manual sync (null for a single webhook event)
  rangeFrom: timestamp("rangeFrom"),
  rangeTo: timestamp("rangeTo"),
  fetchedCount: int("fetchedCount").default(0).notNull(),
  createdCount: int("createdCount").default(0).notNull(),
  updatedCount: int("updatedCount").default(0).notNull(),
  duplicateCount: int("duplicateCount").default(0).notNull(),
  needsReviewCount: int("needsReviewCount").default(0).notNull(),
  failedCount: int("failedCount").default(0).notNull(),
  attempt: int("attempt").default(1).notNull(),
  errorMessage: text("errorMessage"),
  details: text("details"),
  durationMs: int("durationMs"),
  performedBy: int("performedBy"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
});

export type SyncLog = typeof syncLogs.$inferSelect;
export type InsertSyncLog = typeof syncLogs.$inferInsert;

// جدول حركات المخزن
export const inventoryMovements = mysqlTable("inventory_movements", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull().default(1),
  warehouseId: int("warehouseId"),
  productId: int("productId").notNull(),
  // Set when this movement is for a specific variant of `productId` (the parent product).
  // Null means the movement is for a standalone (non-variant) product.
  variantId: int("variantId"),
  type: mysqlEnum("type", ["in", "out"]).notNull(),
  quantity: int("quantity").notNull(),
  reason: varchar("reason", { length: 200 }),
  notes: text("notes"),
  orderId: int("orderId"),
  performedBy: int("performedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InsertInventoryMovement = typeof inventoryMovements.$inferInsert;

// جدول سجل Webhook من Easy Order
export const webhookLogs = mysqlTable("webhook_logs", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull().default(1),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
  eventType: varchar("eventType", { length: 50 }).notNull(),
  status: mysqlEnum("status", ["success", "duplicate", "error", "status_update"]).notNull(),
  externalOrderId: varchar("externalOrderId", { length: 100 }),
  customerName: varchar("customerName", { length: 200 }),
  customerPhone: varchar("customerPhone", { length: 30 }),
  governorate: varchar("governorate", { length: 100 }),
  totalAmount: decimal("totalAmount", { precision: 10, scale: 2 }),
  itemsCount: int("itemsCount"),
  importedCount: int("importedCount"),
  rawPayload: text("rawPayload"),
  message: text("message"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type WebhookLog = typeof webhookLogs.$inferSelect;
export type InsertWebhookLog = typeof webhookLogs.$inferInsert;

// جدول سجل الدمج التلقائي للأوردرات المكررة
export const mergeLogs = mysqlTable("merge_logs", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull().default(1),
  keptOrderId: int("keptOrderId").notNull(),
  keptOrderNumber: varchar("keptOrderNumber", { length: 50 }).notNull(),
  customerName: varchar("customerName", { length: 200 }),
  customerPhone: varchar("customerPhone", { length: 30 }),
  productName: varchar("productName", { length: 200 }),
  mergedQty: int("mergedQty").notNull(),
  totalQtyAfter: int("totalQtyAfter").notNull(),
  source: varchar("source", { length: 50 }).default("easyorder"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type MergeLog = typeof mergeLogs.$inferSelect;
export type InsertMergeLog = typeof mergeLogs.$inferInsert;

// جدول المرتجعات
export const returns = mysqlTable("returns", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull().default(1),
  orderId: int("orderId").notNull(),
  orderNumber: varchar("orderNumber", { length: 20 }).notNull(),
  customerName: varchar("customerName", { length: 100 }).notNull(),
  customerPhone: varchar("customerPhone", { length: 20 }).notNull(),
  governorate: varchar("governorate", { length: 50 }).notNull(),
  // Nullable to mirror orders.productId — a returned order may never have had a product
  // resolved (see the needsReview flow).
  productId: int("productId"),
  productName: varchar("productName", { length: 200 }).notNull(),
  quantity: int("quantity").notNull(),
  totalAmount: decimal("totalAmount", { precision: 10, scale: 2 }).notNull(),
  returnReason: mysqlEnum("returnReason", [
    "customer_refused",
    "wrong_product",
    "damaged",
    "wrong_address",
    "customer_not_available",
    "other",
  ]).notNull(),
  notes: text("notes"),
  stockRestored: boolean("stockRestored").default(false).notNull(),
  processedBy: int("processedBy"),
  returnedAt: timestamp("returnedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Return = typeof returns.$inferSelect;
export type InsertReturn = typeof returns.$inferInsert;

// جدول رسائل البث للموظفين (broadcast messages)
export const broadcastMessages = mysqlTable("broadcast_messages", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId"),
  message: text("message").notNull(),
  sentBy: int("sentBy").notNull(),
  sentByName: varchar("sentByName", { length: 100 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BroadcastMessage = typeof broadcastMessages.$inferSelect;
export type InsertBroadcastMessage = typeof broadcastMessages.$inferInsert;

// جدول توزيع المهام
export const tasks = mysqlTable("tasks", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId"),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description"),
  assignedTo: int("assignedTo"),
  assignedToName: varchar("assignedToName", { length: 100 }),
  createdBy: int("createdBy").notNull(),
  createdByName: varchar("createdByName", { length: 100 }).notNull(),
  status: mysqlEnum("taskStatus", ["new", "in_progress", "done"]).default("new").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

// جدول سجل الطباعات
export const printLogs = mysqlTable("print_logs", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull().default(1),
  type: mysqlEnum("printType", ["shipping_sheet", "labels"]).default("shipping_sheet").notNull(),
  orderIds: text("orderIds").notNull(),
  orderCount: int("orderCount").notNull(),
  printedBy: int("printedBy").notNull(),
  printedByName: varchar("printedByName", { length: 100 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PrintLog = typeof printLogs.$inferSelect;
export type InsertPrintLog = typeof printLogs.$inferInsert;

// جدول سجل الأنشطة (Activity Log)
export const activityLogs = mysqlTable("activity_logs", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId"),
  action: varchar("action", { length: 100 }).notNull(),
  entityType: varchar("entityType", { length: 50 }).notNull(),
  entityId: int("entityId"),
  description: text("description").notNull(),
  metadata: text("metadata"),
  performedBy: int("performedBy").notNull(),
  performedByName: varchar("performedByName", { length: 100 }).notNull(),
  performedByRole: varchar("performedByRole", { length: 20 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ActivityLog = typeof activityLogs.$inferSelect;
export type InsertActivityLog = typeof activityLogs.$inferInsert;

// ==================== PRODUCT VARIANTS ====================
// جدول المتغيرات (لون × مقاس) مع جرد مستقل لكل variant
export const productVariants = mysqlTable("product_variants", {
  id: int("id").autoincrement().primaryKey(),
  productId: int("productId").notNull(),
  // Generic variant label (e.g. "آية الكرسي" for an engraving type) — used instead of
  // color/size for products whose variant dimension isn't color or size. color/size stay
  // available for products that do vary by them; a variant sets name OR color/size, not
  // necessarily all three.
  name: varchar("name", { length: 200 }),
  color: varchar("color", { length: 50 }),
  size: varchar("size", { length: 50 }),
  sku: varchar("sku", { length: 100 }),
  price: decimal("price", { precision: 10, scale: 2 }),
  costPrice: decimal("costPrice", { precision: 10, scale: 2 }),
  currentStock: int("currentStock").default(0).notNull(),
  minStockLevel: int("minStockLevel").default(5).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ProductVariant = typeof productVariants.$inferSelect;
export type InsertProductVariant = typeof productVariants.$inferInsert;

// ==================== ORDER EDIT LOGS ====================
// سجل تعديلات الأوردرات (من عدل، عدل إيه، القيمة القديمة، الجديدة)
export const orderEditLogs = mysqlTable("order_edit_logs", {
  id: int("id").autoincrement().primaryKey(),
  orderId: int("orderId").notNull(),
  field: varchar("field", { length: 100 }).notNull(),
  oldValue: text("oldValue"),
  newValue: text("newValue"),
  editedBy: int("editedBy").notNull(),
  editedByName: varchar("editedByName", { length: 100 }).notNull(),
  editedByRole: varchar("editedByRole", { length: 30 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type OrderEditLog = typeof orderEditLogs.$inferSelect;
export type InsertOrderEditLog = typeof orderEditLogs.$inferInsert;

// ==================== SCAN LOGS ====================
// سجل كل عملية مسح QR Code لتجهيز الأوردرات
export const scanLogs = mysqlTable("scan_logs", {
  id: int("id").autoincrement().primaryKey(),
  orderId: int("orderId").notNull(),
  serialNumber: varchar("serialNumber", { length: 30 }).notNull(),
  scannedBy: int("scannedBy").notNull(),
  scannedByName: varchar("scannedByName", { length: 100 }).notNull(),
  result: mysqlEnum("result", ["success", "failed", "duplicate", "cancelled"]).notNull(),
  deviceInfo: varchar("deviceInfo", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ScanLog = typeof scanLogs.$inferSelect;
export type InsertScanLog = typeof scanLogs.$inferInsert;

// ==================== IMPORT BATCHES ====================
// سجل كل عملية استيراد جماعي (مثل استيراد الأوردرات التاريخية) — يسمح بمعرفة
// كل أوردر جاء من أي دفعة، ومن نفّذها، ولإمكانية التراجع عن دفعة بعينها لاحقًا.
export const importBatches = mysqlTable("import_batches", {
  id: int("id").autoincrement().primaryKey(),
  // NULLABLE, NO DEFAULT — added under the "if approved" clause of the multi-tenant migration
  // plan; flagged for explicit confirmation (see the migration report). Same backfill-then-
  // NOT-NULL treatment as businessGroups.tenantId/employees.tenantId above.
  tenantId: int("tenantId"),
  label: varchar("label", { length: 150 }).notNull(),
  source: varchar("source", { length: 100 }).notNull(),
  status: mysqlEnum("status", ["running", "completed", "failed", "rolled_back"]).default("running").notNull(),
  totalRows: int("totalRows").default(0).notNull(),
  importedCount: int("importedCount").default(0).notNull(),
  skippedCount: int("skippedCount").default(0).notNull(),
  duplicateCount: int("duplicateCount").default(0).notNull(),
  performedBy: int("performedBy").notNull(),
  performedByName: varchar("performedByName", { length: 100 }),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  rolledBackAt: timestamp("rolledBackAt"),
  rolledBackBy: int("rolledBackBy"),
  errorSummary: text("errorSummary"),
});
export type ImportBatch = typeof importBatches.$inferSelect;
export type InsertImportBatch = typeof importBatches.$inferInsert;
