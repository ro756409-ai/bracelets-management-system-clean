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
  // ==================== COLLECTION (التحصيل) ====================
  // `totalAmount` هو المبلغ المتوقع من العميل. الحقول دي بتسجّل اللي اتحصّل فعلاً، وهو
  // رقم مختلف: شركة الشحن بترجّع أقل (خصم، جزء مرفوض) أو متأخر أو مايرجّعش خالص.
  // الفرق بين الاتنين هو أساس صفحة التحصيلات، وكان مستحيل يتحسب قبل كده.
  // nullable مقصود: null معناها "لسه ماتحصّلش" وده مختلف عن 0 (اتحصّل صفر فعلاً).
  collectedAmount: decimal("collectedAmount", { precision: 10, scale: 2 }),
  collectedAt: timestamp("collectedAt"),
  collectionStatus: mysqlEnum("collectionStatus", [
    "pending",   // لسه في الطريق / مع شركة الشحن
    "collected", // اتحصّل بالكامل
    "partial",   // اتحصّل أقل من المتوقع
    "failed",    // مرتجع / مارجعش فلوس
  ]).default("pending").notNull(),
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

// ==================== ACCOUNTING ====================
// المرحلة الأولى من وحدة الحسابات: خزنة + مصروفات، بدون قيود محاسبية مزدوجة.
//
// القرار المعماري هنا هو إن `treasury_transactions` هو الـledger الوحيد: كل حركة مالية
// في النظام (تحصيل، مرتجع، مصروف، إيداع، سحب) بتنزل فيه صف واحد، والجداول التانية
// (expenses) بتوصف تفاصيل الحركة بس مش بتحسب أرصدة بنفسها. كده رصيد الخزنة له مصدر
// واحد، ومش ممكن جدولين يقولوا رقمين مختلفين لنفس اليوم.

// تصنيفات المصروفات — جدول منفصل مش enum، لأن كل تاجر عنده تصنيفاته (إيجار، رواتب،
// إعلانات، شحن، …) والـenum كان معناه migration مع كل تصنيف جديد.
export const expenseCategories = mysqlTable("expense_categories", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  // تصنيفات النظام الأساسية — مش قابلة للحذف عشان المصروفات القديمة مايبقاش لها تصنيف
  isSystem: boolean("isSystem").default(false).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // نفس الاسم مرتين لنفس النشاط بيخلي التقارير تتفرّق على تصنيفين متطابقين
  businessNameUnique: uniqueIndex("expense_categories_business_name_unique").on(table.businessId, table.name),
}));

export type ExpenseCategory = typeof expenseCategories.$inferSelect;
export type InsertExpenseCategory = typeof expenseCategories.$inferInsert;

// المصروفات
export const expenses = mysqlTable("expenses", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  categoryId: int("categoryId"),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  description: text("description").notNull(),
  // تاريخ المصروف نفسه — مختلف عن createdAt (وقت الإدخال في النظام). مصروف امبارح
  // ممكن يتسجّل النهاردة، والتقارير لازم تحسبه على يومه مش على يوم الإدخال.
  expenseDate: timestamp("expenseDate").notNull(),
  // مرجع خارجي: رقم فاتورة أو إيصال
  reference: varchar("reference", { length: 100 }),
  // المرفق: مسار/URL للفاتورة. الرفع نفسه مش متطبّق في المرحلة دي — العمود موجود عشان
  // الواجهة تقدر تعرض رابط لو اتحط يدويًا، والرفع بياجي مع خدمة التخزين لاحقًا.
  attachmentUrl: varchar("attachmentUrl", { length: 500 }),
  createdBy: int("createdBy").notNull(),
  createdByName: varchar("createdByName", { length: 100 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Expense = typeof expenses.$inferSelect;
export type InsertExpense = typeof expenses.$inferInsert;

// الخزنة — الـledger الوحيد لكل حركة مالية
export const treasuryTransactions = mysqlTable("treasury_transactions", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  // نوع الحركة بيقول مصدرها، والاتجاه بيقول داخل/خارج. الاتنين منفصلين لأن نفس النوع
  // ممكن يبقى في اتجاهين: تعديل تحصيل ناقص بيطلع، وتصحيحه بيدخل.
  type: mysqlEnum("type", [
    "collection", // تحصيل أوردر
    "refund",     // مرتجع
    "expense",    // مصروف
    "deposit",    // إيداع
    "withdrawal", // سحب
    "adjustment", // تسوية يدوية
  ]).notNull(),
  direction: mysqlEnum("direction", ["in", "out"]).notNull(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  // الرصيد بعد الحركة — محسوب ومحفوظ وقت الإدخال، مش وقت العرض. لو حسبناه بجمع كل
  // الصفوف السابقة عند كل قراءة، أي حركة بتاريخ قديم بتتضاف بعدين كانت هتغيّر كل
  // الأرصدة اللي بعدها بأثر رجعي، والتاجر مايقدرش يطابق كشف قديم.
  balanceAfter: decimal("balanceAfter", { precision: 10, scale: 2 }).notNull(),
  description: text("description").notNull(),
  notes: text("notes"),
  // ربط الحركة بمصدرها: أوردر، مصروف، مرتجع. nullable لأن الإيداع/السحب اليدوي
  // مالوش مصدر في جدول تاني.
  referenceType: mysqlEnum("referenceType", ["order", "expense", "return", "manual"]).default("manual").notNull(),
  referenceId: int("referenceId"),
  performedBy: int("performedBy").notNull(),
  performedByName: varchar("performedByName", { length: 100 }).notNull(),
  // تاريخ الحركة المالية — زي expenseDate، مختلف عن وقت الإدخال
  transactionDate: timestamp("transactionDate").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type TreasuryTransaction = typeof treasuryTransactions.$inferSelect;
export type InsertTreasuryTransaction = typeof treasuryTransactions.$inferInsert;

// ==================== PAYROLL ====================
//
// الرواتب بتدخل المحاسبة عن طريق جدول `expenses` مش الخزنة مباشرة، وده قرار محسوب:
// لوحة الحسابات بتقرا المصروفات من `expenses`، فلو المرتبات نزلت الخزنة بس كان صافي
// الربح هيتجاهلها بالكامل ويطلع أعلى من الحقيقي. و`createExpense` أصلاً بينزّل حركة
// الخزنة المقابلة، فالمسار ده بيدّي الاتنين بقيد واحد.
//
// السُلفة كمان بتتسجّل كمصروف وقت صرفها مش وقت خصمها: الفلوس خرجت من الدُرج ساعتها.
// لو اتسجّلت وقت الخصم بس، كان الرصيد بيكدب طول الشهر؛ ولو اتسجّلت مرتين (وقت الصرف
// ووقت الخصم من إجمالي المرتب) كانت التكلفة هتتحسب مرتين. فسطر "السُلف" في كشف الراتب
// عرضي بحت — بيفسّر ليه الصافي أقل من الإجمالي، وتكلفته اتسجّلت خلاص.

/**
 * إعدادات محرّك الرواتب — صف واحد لكل نشاط.
 *
 * القيم دي كانت هتبقى أرقامًا ثابتة في الكود (٣٠ يوم، إجازة الجمعة والسبت، …) وهي
 * بتختلف من تاجر للتاني ومن بلد للتانية. وجودها في جدول معناه إن تغييرها إعداد مش نشر.
 */
export const payrollSettings = mysqlTable("payroll_settings", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  /** أيام العمل في الشهر — أساس حساب أجر اليوم للمرتب الشهري */
  workingDaysPerMonth: int("workingDaysPerMonth").default(26).notNull(),
  /**
   * أساس خصم الغياب: أيام التقويم (÷30) ولا أيام العمل (÷workingDaysPerMonth).
   * الفرق حقيقي في الجيب: مرتب ٣٠٠٠ وغياب يوم = ١٠٠ بالتقويم و١١٥.٣٨ بأيام العمل.
   */
  absenceDeductionBasis: mysqlEnum("absenceDeductionBasis", ["calendar_days", "working_days"])
    .default("working_days").notNull(),
  /** أيام الإجازة الأسبوعية كأرقام مفصولة بفواصل — 0=الأحد … 6=السبت. الافتراضي الجمعة والسبت. */
  weekendDays: varchar("weekendDays", { length: 20 }).default("5,6").notNull(),
  /**
   * الأوفرتايم: يدوي (المستخدم بيكتب المبلغ)، أو محسوب من أجر الساعة × مضاعف.
   * الافتراضي يدوي — مفيش نظام حضور بيسجّل ساعات لسه.
   */
  overtimeMode: mysqlEnum("overtimeMode", ["manual", "hourly_multiplier"]).default("manual").notNull(),
  overtimeMultiplier: decimal("overtimeMultiplier", { precision: 5, scale: 2 }).default("1.50").notNull(),
  /** ساعات اليوم — لحساب أجر الساعة لما يكون الأوفرتايم محسوبًا */
  workHoursPerDay: decimal("workHoursPerDay", { precision: 4, scale: 2 }).default("8.00").notNull(),
  currency: varchar("currency", { length: 10 }).default("EGP").notNull(),
  /** تقريب الصافي — بعض التجار بيقرّبوا لأقرب ٥ أو ١٠ عشان الكاش */
  roundingMode: mysqlEnum("roundingMode", ["none", "nearest_1", "nearest_5", "nearest_10"])
    .default("none").notNull(),
  defaultSalaryType: mysqlEnum("defaultSalaryType", ["monthly", "daily", "commission", "mixed"])
    .default("monthly").notNull(),
  defaultCommissionBasis: mysqlEnum("defaultCommissionBasis", ["confirmed", "prepared", "shipped", "delivered"])
    .default("delivered").notNull(),
  updatedBy: int("updatedBy"),
  updatedByName: varchar("updatedByName", { length: 100 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  businessUnique: uniqueIndex("payroll_settings_business_unique").on(table.businessId),
}));

export type PayrollSettings = typeof payrollSettings.$inferSelect;
export type InsertPayrollSettings = typeof payrollSettings.$inferInsert;

/**
 * ملف راتب الموظف — مُصدَّر بالإصدارات مش صفًا واحدًا بيتعدّل.
 *
 * لو كان صفًا واحدًا، رفع مرتب في مارس كان بيعيد حساب فبراير بأثر رجعي. الصفوف هنا
 * بتتراكم، والدورة بتختار الإصدار الساري: أحدث `effectiveFrom` أقل من أو يساوي نهاية
 * الشهر المحسوب.
 */
export const employeeSalaryProfiles = mysqlTable("employee_salary_profiles", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  employeeId: int("employeeId").notNull(),
  salaryType: mysqlEnum("salaryType", ["monthly", "daily", "commission", "mixed"]).notNull(),
  /** null للموظف اللي على عمولة صافية */
  baseSalary: decimal("baseSalary", { precision: 10, scale: 2 }),
  /** null لغير اليومي */
  dailyRate: decimal("dailyRate", { precision: 10, scale: 2 }),
  commissionType: mysqlEnum("commissionType", ["per_order", "percentage"]),
  commissionValue: decimal("commissionValue", { precision: 10, scale: 2 }),
  /**
   * الحالة اللي بتستحق العمولة. إعداد لكل موظف مش افتراض في الكود: موظف التأكيدات
   * بياخد على "مؤكد"، وموظف التجهيز على "تم التجهيز"، والمندوب على "تم التوصيل".
   */
  commissionBasis: mysqlEnum("commissionBasis", ["confirmed", "prepared", "shipped", "delivered"])
    .default("delivered").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  notes: text("notes"),
  isActive: boolean("isActive").default(true).notNull(),
  createdBy: int("createdBy").notNull(),
  createdByName: varchar("createdByName", { length: 100 }).notNull(),
  updatedBy: int("updatedBy"),
  updatedByName: varchar("updatedByName", { length: 100 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // إصداران بنفس تاريخ السريان لنفس الموظف = اختيار عشوائي بين الاتنين وقت الحساب
  employeeEffectiveUnique: uniqueIndex("employee_salary_profiles_employee_effective_unique")
    .on(table.employeeId, table.effectiveFrom),
}));

export type EmployeeSalaryProfile = typeof employeeSalaryProfiles.$inferSelect;
export type InsertEmployeeSalaryProfile = typeof employeeSalaryProfiles.$inferInsert;

/** دورة رواتب شهرية — رأس الدورة */
export const payrollPeriods = mysqlTable("payroll_periods", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  year: int("year").notNull(),
  month: int("month").notNull(),
  status: mysqlEnum("status", ["draft", "approved", "paid", "cancelled"]).default("draft").notNull(),
  totalGross: decimal("totalGross", { precision: 12, scale: 2 }).default("0").notNull(),
  totalNet: decimal("totalNet", { precision: 12, scale: 2 }).default("0").notNull(),
  employeeCount: int("employeeCount").default(0).notNull(),
  /**
   * القيد المحاسبي المقابل للدفع. وجوده معناه إن الدورة اتدفعت فعلاً، وهو الحارس
   * التاني ضد الدفع المزدوج بعد الفهرس الفريد على (businessId, year, month).
   */
  expenseId: int("expenseId"),
  notes: text("notes"),
  createdBy: int("createdBy").notNull(),
  createdByName: varchar("createdByName", { length: 100 }).notNull(),
  approvedBy: int("approvedBy"),
  approvedByName: varchar("approvedByName", { length: 100 }),
  approvedAt: timestamp("approvedAt"),
  paidBy: int("paidBy"),
  paidByName: varchar("paidByName", { length: 100 }),
  paidAt: timestamp("paidAt"),
  cancelledBy: int("cancelledBy"),
  cancelledByName: varchar("cancelledByName", { length: 100 }),
  cancelledAt: timestamp("cancelledAt"),
  cancelReason: text("cancelReason"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // الحارس الأول ضد الدفع المزدوج — على مستوى قاعدة البيانات مش شرط في الكود ينفع يتخطّى
  businessPeriodUnique: uniqueIndex("payroll_periods_business_period_unique")
    .on(table.businessId, table.year, table.month),
}));

export type PayrollPeriod = typeof payrollPeriods.$inferSelect;
export type InsertPayrollPeriod = typeof payrollPeriods.$inferInsert;

/** سطر راتب لموظف واحد في دورة واحدة */
export const payrollItems = mysqlTable("payroll_items", {
  id: int("id").autoincrement().primaryKey(),
  periodId: int("periodId").notNull(),
  businessId: int("businessId").notNull(),
  employeeId: int("employeeId").notNull(),
  /** لقطة مجمّدة — كشف يناير لازم يفضل مقروءًا لو الموظف اتشال بعدين */
  employeeName: varchar("employeeName", { length: 100 }).notNull(),
  salaryType: mysqlEnum("salaryType", ["monthly", "daily", "commission", "mixed"]).notNull(),
  /**
   * إصدار ملف الراتب اللي اتحسب منه السطر ده، ولقطة JSON من قيمه وقت الإنشاء.
   * الاتنين مع بعض: الـid للتتبّع، واللقطة عشان الكشف يفضل مفهومًا حتى لو الإصدار
   * نفسه اتمسح. أي تعديل مستقبلي على الراتب مالوش أي أثر على الدورات القديمة.
   */
  salaryProfileId: int("salaryProfileId"),
  profileSnapshot: text("profileSnapshot"),
  baseSalary: decimal("baseSalary", { precision: 10, scale: 2 }).default("0").notNull(),
  // إدخال يدوي في المرحلة دي — مفيش نظام حضور بعد. وحدة الحضور المستقبلية هتملاهم
  // تلقائيًا، والأعمدة موجودة من دلوقتي عشان مايحتاجش migration وقتها.
  attendanceDays: int("attendanceDays").default(0).notNull(),
  absenceDays: int("absenceDays").default(0).notNull(),
  overtimeHours: decimal("overtimeHours", { precision: 6, scale: 2 }).default("0").notNull(),
  overtimeAmount: decimal("overtimeAmount", { precision: 10, scale: 2 }).default("0").notNull(),
  bonuses: decimal("bonuses", { precision: 10, scale: 2 }).default("0").notNull(),
  commissions: decimal("commissions", { precision: 10, scale: 2 }).default("0").notNull(),
  /** شفافية: العمولة دي جات من كام أوردر */
  commissionOrders: int("commissionOrders").default(0).notNull(),
  absenceDeduction: decimal("absenceDeduction", { precision: 10, scale: 2 }).default("0").notNull(),
  deductions: decimal("deductions", { precision: 10, scale: 2 }).default("0").notNull(),
  advances: decimal("advances", { precision: 10, scale: 2 }).default("0").notNull(),
  netSalary: decimal("netSalary", { precision: 10, scale: 2 }).default("0").notNull(),
  /**
   * أسماء الحقول اللي المستخدم عدّلها بإيده (JSON array).
   * إعادة الحساب بتحدّث اللي مش موجود في القائمة دي بس — ده تنفيذ شرط "لا تكتب فوق
   * التعديلات اليدوية". من غيره كان أول ضغط على "إعادة حساب" بيمسح شغل يدوي كامل.
   */
  manualFields: text("manualFields"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  periodEmployeeUnique: uniqueIndex("payroll_items_period_employee_unique")
    .on(table.periodId, table.employeeId),
}));

export type PayrollItem = typeof payrollItems.$inferSelect;
export type InsertPayrollItem = typeof payrollItems.$inferInsert;

/** سُلف الموظفين */
export const employeeAdvances = mysqlTable("employee_advances", {
  id: int("id").autoincrement().primaryKey(),
  businessId: int("businessId").notNull(),
  employeeId: int("employeeId").notNull(),
  employeeName: varchar("employeeName", { length: 100 }).notNull(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  advanceDate: timestamp("advanceDate").notNull(),
  reason: text("reason"),
  status: mysqlEnum("status", ["pending", "settled", "cancelled"]).default("pending").notNull(),
  /** الدورة اللي اتخصمت فيها — بيتملى وقت اعتماد الدورة */
  settledPeriodId: int("settledPeriodId"),
  /** المصروف المقابل وقت الصرف — الفلوس خرجت من الدُرج ساعتها */
  expenseId: int("expenseId"),
  createdBy: int("createdBy").notNull(),
  createdByName: varchar("createdByName", { length: 100 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type EmployeeAdvance = typeof employeeAdvances.$inferSelect;
export type InsertEmployeeAdvance = typeof employeeAdvances.$inferInsert;
