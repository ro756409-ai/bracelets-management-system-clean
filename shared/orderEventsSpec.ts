import type { TableSpec } from "./schemaSpec";

/**
 * مواصفة 0041 (order_activity_events) كبيانات + القوائم المسموحة المركزية.
 * المصدر الوحيد لأنواع الأحداث والمصادر: الخدمة ترفض أي قيمة خارجها، والعميل لا يرسل eventType أبدًا.
 */
export const ORDER_EVENTS_TABLE = "order_activity_events" as const;

/** أنواع الأحداث المكتوبة اليوم. */
export const ORDER_EVENT_TYPES = [
  "confirm", "no_answer", "postpone", "cancel",
  "edit", "edit_items",
  "assign", "reassign", "unassign",
  "status_change", "print", "ship_update", "return",
  "duplicate_mark", "duplicate_restore",
] as const;
/** أنواع محجوزة للتوسع (مسموحة في الـDB، غير مكتوبة بعد) — إضافتها لا تحتاج Migration. */
export const ORDER_EVENT_TYPES_RESERVED = ["refund", "complaint", "delivery_attempt", "collection_update"] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number] | (typeof ORDER_EVENT_TYPES_RESERVED)[number];
export const ALLOWED_ORDER_EVENT_TYPES: ReadonlySet<string> = new Set<string>([...ORDER_EVENT_TYPES, ...ORDER_EVENT_TYPES_RESERVED]);

/** أحداث «القرار» — مقام «نسبة التأكيد من القرارات المسجلة». */
export const DECISION_EVENT_TYPES = ["confirm", "no_answer", "postpone", "cancel"] as const;
/** أحداث الإسناد — مقياس منفصل (الإسنادات) يُنسب لـassigneeEmployeeIdAtEvent. */
export const ASSIGNMENT_EVENT_TYPES = ["assign", "reassign"] as const;

export const ORDER_EVENT_SOURCES = ["admin_ui", "employee_portal", "bulk", "webhook_bosta", "webhook_easyorders", "system", "backfill"] as const;
export type OrderEventSource = (typeof ORDER_EVENT_SOURCES)[number];
export const ALLOWED_ORDER_EVENT_SOURCES: ReadonlySet<string> = new Set<string>(ORDER_EVENT_SOURCES);

export const ORDER_EVENT_ACTOR_TYPES = ["employee", "system", "webhook", "backfill"] as const;
export type OrderEventActorType = (typeof ORDER_EVENT_ACTOR_TYPES)[number];

/** حد أدنى لعينة الترتيب (قرار المالك). */
export const PERFORMANCE_RANKING_MIN_SAMPLE = 20;
export const ORDER_NUMBER_SNAPSHOT_MAX = 100;

export const ORDER_EVENTS_SPEC: TableSpec = {
  columns: [
    { name: "id", type: "bigint", nullable: false },
    { name: "tenantId", type: "int", nullable: false },
    { name: "businessId", type: "int", nullable: false },
    { name: "orderId", type: "int", nullable: false },
    { name: "orderNumberSnapshot", type: "varchar(100)", nullable: false },
    { name: "eventType", type: "varchar(50)", nullable: false },
    { name: "fromStatus", type: "varchar(30)", nullable: true },
    { name: "toStatus", type: "varchar(30)", nullable: true },
    { name: "actorType", type: "enum", nullable: false },
    { name: "actorEmployeeId", type: "int", nullable: true },
    { name: "attributedEmployeeId", type: "int", nullable: true },
    { name: "actorRoleSnapshot", type: "varchar(50)", nullable: true },
    { name: "actorNameSnapshot", type: "varchar(100)", nullable: true },
    { name: "assigneeEmployeeIdAtEvent", type: "int", nullable: true },
    { name: "previousAssigneeEmployeeId", type: "int", nullable: true },
    { name: "reason", type: "varchar(160)", nullable: true },
    { name: "callAttempt", type: "smallint unsigned", nullable: true },
    { name: "source", type: "varchar(30)", nullable: false },
    { name: "backfillConfidence", type: "enum", nullable: true },
    { name: "idempotencyKey", type: "varchar(191)", nullable: false },
    { name: "payloadHash", type: "char(64)", nullable: false },
    { name: "occurredAt", type: "timestamp(3)", nullable: false },
    { name: "metadataJson", type: "json", nullable: true },
    { name: "createdAt", type: "timestamp(3)", nullable: false },
  ],
  uniques: [
    { name: "PRIMARY", columns: ["id"] },
    { name: "oae_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] },
    { name: "oae_tenant_id_unique", columns: ["tenantId", "id"] },
  ],
  indexes: [
    { name: "oae_tenant_occurred", columns: ["tenantId", "occurredAt"] },
    { name: "oae_tenant_attributed_occurred", columns: ["tenantId", "attributedEmployeeId", "occurredAt"] },
    { name: "oae_tenant_actor_occurred", columns: ["tenantId", "actorEmployeeId", "occurredAt"] },
    { name: "oae_tenant_assignee_occurred", columns: ["tenantId", "assigneeEmployeeIdAtEvent", "occurredAt"] },
    { name: "oae_tenant_business_occurred", columns: ["tenantId", "businessId", "occurredAt"] },
    { name: "oae_tenant_type_occurred", columns: ["tenantId", "eventType", "occurredAt"] },
    { name: "oae_order_occurred", columns: ["orderId", "occurredAt"] },
  ],
  foreignKeys: [
    { name: "fk_oae_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
    { name: "fk_oae_tenant_business", columns: ["tenantId", "businessId"], refTable: "businesses", refColumns: ["tenantId", "id"] },
    { name: "fk_oae_tenant_actor", columns: ["tenantId", "actorEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    { name: "fk_oae_tenant_attributed", columns: ["tenantId", "attributedEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    { name: "fk_oae_tenant_assignee", columns: ["tenantId", "assigneeEmployeeIdAtEvent"], refTable: "employees", refColumns: ["tenantId", "id"] },
    { name: "fk_oae_tenant_prev_assignee", columns: ["tenantId", "previousAssigneeEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
  ],
  checks: ["chk_oae_actor", "chk_oae_backfill", "chk_oae_call", "chk_oae_event_type", "chk_oae_source", "chk_oae_hash"],
};
