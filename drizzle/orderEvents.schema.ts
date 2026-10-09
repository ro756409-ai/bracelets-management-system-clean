import { mysqlTable, int, bigint, varchar, char, smallint, timestamp, json, mysqlEnum, uniqueIndex, index } from "drizzle-orm/mysql-core";

/**
 * order_activity_events (0041) — تعريف Drizzle **للخدمة فقط**.
 *
 * ليس ضمن `drizzle.config.ts` (الذي يقرأ `./drizzle/schema.ts` وحده) عن قصد: لا push ولا generate ينشئ الجدول.
 * المصدر الوحيد للإنشاء `drizzle/0041_order_activity_events.sql` عبر `scripts/migrate-0041-order-events`.
 * المفاتيح الأجنبية المركّبة وقيود CHECK في الـDDL ولا تُكرَّر هنا. الطوابع تُقرأ بالـepoch (UNIX_TIMESTAMP)
 * في الخدمة، فلا تعتمد على time_zone الجلسة.
 */
export const orderActivityEvents = mysqlTable(
  "order_activity_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    tenantId: int("tenantId").notNull(),
    businessId: int("businessId").notNull(),
    orderId: int("orderId").notNull(),
    orderNumberSnapshot: varchar("orderNumberSnapshot", { length: 100 }).notNull(),
    eventType: varchar("eventType", { length: 50 }).notNull(),
    fromStatus: varchar("fromStatus", { length: 30 }),
    toStatus: varchar("toStatus", { length: 30 }),
    actorType: mysqlEnum("actorType", ["employee", "system", "webhook", "backfill"]).notNull(),
    actorEmployeeId: int("actorEmployeeId"),
    attributedEmployeeId: int("attributedEmployeeId"),
    actorRoleSnapshot: varchar("actorRoleSnapshot", { length: 50 }),
    actorNameSnapshot: varchar("actorNameSnapshot", { length: 100 }),
    assigneeEmployeeIdAtEvent: int("assigneeEmployeeIdAtEvent"),
    previousAssigneeEmployeeId: int("previousAssigneeEmployeeId"),
    reason: varchar("reason", { length: 160 }),
    callAttempt: smallint("callAttempt", { unsigned: true }),
    source: varchar("source", { length: 30 }).notNull(),
    backfillConfidence: mysqlEnum("backfillConfidence", ["confirmed", "partial"]),
    idempotencyKey: varchar("idempotencyKey", { length: 191 }).notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    occurredAt: timestamp("occurredAt", { fsp: 3 }).notNull(),
    metadataJson: json("metadataJson"),
    createdAt: timestamp("createdAt", { fsp: 3 }).notNull(),
  },
  t => ({
    tenantIdemUnique: uniqueIndex("oae_tenant_idem_unique").on(t.tenantId, t.idempotencyKey),
    tenantIdUnique: uniqueIndex("oae_tenant_id_unique").on(t.tenantId, t.id),
    tenantOccurred: index("oae_tenant_occurred").on(t.tenantId, t.occurredAt),
    tenantAttributed: index("oae_tenant_attributed_occurred").on(t.tenantId, t.attributedEmployeeId, t.occurredAt),
    tenantActor: index("oae_tenant_actor_occurred").on(t.tenantId, t.actorEmployeeId, t.occurredAt),
    tenantAssignee: index("oae_tenant_assignee_occurred").on(t.tenantId, t.assigneeEmployeeIdAtEvent, t.occurredAt),
    tenantBusiness: index("oae_tenant_business_occurred").on(t.tenantId, t.businessId, t.occurredAt),
    tenantType: index("oae_tenant_type_occurred").on(t.tenantId, t.eventType, t.occurredAt),
    orderOccurred: index("oae_order_occurred").on(t.orderId, t.occurredAt),
  })
);
export type OrderActivityEvent = typeof orderActivityEvents.$inferSelect;
