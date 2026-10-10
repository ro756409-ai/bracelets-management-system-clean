import type { TableSpec } from "./schemaSpec";

/**
 * مواصفة 0043 (مركز الرسائل) كبيانات + الثوابت المشتركة بين الخدمة والواجهة.
 * القرارات المعتمدة من المالك (2026-10-10):
 *   • المالك يطّلع على المحادثات الخاصة بين الموظفين (قراءة فقط)، والكل مُبلَّغ تلقائيًا، وكل اطلاع مسجَّل.
 *   • أي موظف يراسل أي موظف داخل نفس الشركة.
 *   • تعديل الرسالة بعد إرسالها مع حفظ النسخ السابقة؛ الحذف ناعم والنص يبقى في السجل.
 *   • إشعارات داخل النظام فقط.
 *   • النص يُحفظ دائمًا؛ المرفقات والصوت 6 أشهر؛ الإعلانات المثبّتة لا تُحذف مرفقاتها.
 */
export const MESSAGING_TABLES = [
  "msg_conversations", "msg_members", "msg_messages", "msg_message_edits", "msg_attachments",
  "msg_reactions", "msg_announcement_acks", "msg_voice_listens", "msg_access_audit",
] as const;
export type MessagingTable = (typeof MESSAGING_TABLES)[number];

export const CONVERSATION_KINDS = ["announcement", "team", "business", "group", "direct"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const MESSAGE_KINDS = ["text", "voice", "attachment", "system", "announcement"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const REACTIONS = ["like", "done", "heart", "thanks"] as const;
export type Reaction = (typeof REACTIONS)[number];
export const REACTION_EMOJI: Record<Reaction, string> = { like: "👍", done: "✅", heart: "❤️", thanks: "🙏" };

export const MESSAGING_LIMITS = {
  bodyMaxChars: 4000,
  titleMaxChars: 160,
  groupTitleMaxChars: 120,
  attachmentMaxBytes: 10 * 1024 * 1024,
  voiceMaxMs: 5 * 60 * 1000,
  /** 6 أشهر تقريبًا */
  attachmentRetentionDays: 182,
  pageSize: 50,
  groupMaxMembers: 100,
} as const;

/** نص تنبيه السياسة الذي يصل لكل الموظفين تلقائيًا (رسالة نظام في الإعلانات + شريط في كل محادثة خاصة). */
export const PRIVACY_NOTICE = "سياسة الرسائل: يمكن للمالك الاطلاع على المحادثات الخاصة بين الموظفين، ويُسجَّل كل اطلاع. الرسائل للعمل.";

export const conversationUniqueKey = {
  announcement: () => "announcement",
  team: () => "team",
  business: (businessId: number) => `business:${businessId}`,
  direct: (a: number, b: number) => `direct:${Math.min(a, b)}:${Math.max(a, b)}`,
};

const ts = (name: string, nullable = false) => ({ name, type: "timestamp(3)", nullable });
const int = (name: string, nullable = false) => ({ name, type: "int", nullable });
const fk = (name: string, columns: string[], refTable: string, refColumns: string[]) => ({ name, columns, refTable, refColumns });
const tenantFk = (prefix: string) => fk(`fk_${prefix}_tenant`, ["tenantId"], "tenants", ["id"]);
const empFk = (name: string, col: string) => fk(name, ["tenantId", col], "employees", ["tenantId", "id"]);
const msgFk = (name: string) => fk(name, ["tenantId", "messageId"], "msg_messages", ["tenantId", "id"]);

export const MESSAGING_SPEC: Record<MessagingTable, TableSpec> = {
  msg_conversations: {
    columns: [
      int("id"), int("tenantId"), { name: "kind", type: "enum", nullable: false }, int("businessId", true),
      { name: "title", type: "varchar(120)", nullable: true }, { name: "uniqueKey", type: "varchar(40)", nullable: true },
      int("createdByEmployeeId", true), int("lastMessageId", true), ts("lastMessageAt", true),
      { name: "isArchived", type: "tinyint(1)", nullable: false },
      { name: "idempotencyKey", type: "varchar(100)", nullable: true }, { name: "payloadHash", type: "char(64)", nullable: true },
      ts("createdAt"), ts("updatedAt"),
    ],
    uniques: [
      { name: "PRIMARY", columns: ["id"] }, { name: "msc_tenant_id_unique", columns: ["tenantId", "id"] },
      { name: "msc_tenant_key_unique", columns: ["tenantId", "uniqueKey"] },
      { name: "msc_tenant_idempotency_unique", columns: ["tenantId", "idempotencyKey"] },
    ],
    indexes: [{ name: "msc_tenant_last", columns: ["tenantId", "lastMessageAt"] }],
    foreignKeys: [
      tenantFk("msc"),
      fk("fk_msc_tenant_business", ["tenantId", "businessId"], "businesses", ["tenantId", "id"]),
      empFk("fk_msc_tenant_creator", "createdByEmployeeId"),
    ],
    checks: ["chk_msc_kind", "chk_msc_idem"],
  },
  msg_members: {
    columns: [
      int("id"), int("tenantId"), int("conversationId"), int("employeeId"), { name: "role", type: "enum", nullable: false },
      int("lastReadMessageId", true), ts("joinedAt"), ts("leftAt", true),
    ],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "msm_tenant_conv_employee_unique", columns: ["tenantId", "conversationId", "employeeId"] }],
    indexes: [{ name: "msm_tenant_employee", columns: ["tenantId", "employeeId"] }],
    foreignKeys: [
      fk("fk_msm_tenant_conversation", ["tenantId", "conversationId"], "msg_conversations", ["tenantId", "id"]),
      empFk("fk_msm_tenant_employee", "employeeId"),
    ],
    checks: [],
  },
  msg_messages: {
    columns: [
      int("id"), int("tenantId"), int("conversationId"), int("senderEmployeeId", true), { name: "kind", type: "enum", nullable: false },
      { name: "title", type: "varchar(160)", nullable: true }, { name: "body", type: "text", nullable: true },
      int("replyToMessageId", true), int("orderId", true), { name: "isPinned", type: "tinyint(1)", nullable: false },
      ts("editedAt", true), ts("deletedAt", true), int("deletedByEmployeeId", true),
      { name: "idempotencyKey", type: "varchar(100)", nullable: true }, { name: "payloadHash", type: "char(64)", nullable: true },
      ts("createdAt"),
    ],
    uniques: [
      { name: "PRIMARY", columns: ["id"] }, { name: "mmg_tenant_id_unique", columns: ["tenantId", "id"] },
      { name: "mmg_tenant_conv_id_unique", columns: ["tenantId", "conversationId", "id"] },
      { name: "mmg_tenant_idempotency_unique", columns: ["tenantId", "idempotencyKey"] },
    ],
    indexes: [{ name: "mmg_tenant_conv_created", columns: ["tenantId", "conversationId", "createdAt"] }],
    foreignKeys: [
      fk("fk_mmg_tenant_conversation", ["tenantId", "conversationId"], "msg_conversations", ["tenantId", "id"]),
      empFk("fk_mmg_tenant_sender", "senderEmployeeId"),
      empFk("fk_mmg_tenant_deleter", "deletedByEmployeeId"),
      fk("fk_mmg_tenant_conv_reply", ["tenantId", "conversationId", "replyToMessageId"], "msg_messages", ["tenantId", "conversationId", "id"]),
    ],
    checks: ["chk_mmg_sender", "chk_mmg_body", "chk_mmg_body_len", "chk_mmg_delete", "chk_mmg_pin", "chk_mmg_idem"],
  },
  msg_message_edits: {
    columns: [
      int("id"), int("tenantId"), int("messageId"), int("editorEmployeeId"), { name: "action", type: "enum", nullable: false },
      { name: "previousTitle", type: "varchar(160)", nullable: true }, { name: "previousBody", type: "text", nullable: true }, ts("createdAt"),
    ],
    uniques: [{ name: "PRIMARY", columns: ["id"] }],
    indexes: [{ name: "mme_tenant_message", columns: ["tenantId", "messageId", "id"] }],
    foreignKeys: [msgFk("fk_mme_tenant_message"), empFk("fk_mme_tenant_editor", "editorEmployeeId")],
    checks: [],
  },
  msg_attachments: {
    columns: [
      int("id"), int("tenantId"), int("messageId"), { name: "kind", type: "enum", nullable: false },
      { name: "storageKey", type: "varchar(255)", nullable: false }, { name: "mime", type: "varchar(100)", nullable: false },
      { name: "bytes", type: "int unsigned", nullable: false },
      { name: "width", type: "smallint unsigned", nullable: true }, { name: "height", type: "smallint unsigned", nullable: true },
      { name: "durationMs", type: "int unsigned", nullable: true }, { name: "waveformJson", type: "json", nullable: true },
      ts("expiresAt", true), ts("purgedAt", true), ts("createdAt"),
    ],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "mat_tenant_storage_unique", columns: ["tenantId", "storageKey"] }],
    indexes: [{ name: "mat_tenant_message", columns: ["tenantId", "messageId"] }, { name: "mat_expires", columns: ["expiresAt", "purgedAt"] }],
    foreignKeys: [msgFk("fk_mat_tenant_message")],
    checks: ["chk_mat_bytes", "chk_mat_voice", "chk_mat_key"],
  },
  msg_reactions: {
    columns: [int("id"), int("tenantId"), int("messageId"), int("employeeId"), { name: "reaction", type: "enum", nullable: false }, ts("createdAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "mrx_tenant_message_employee_reaction_unique", columns: ["tenantId", "messageId", "employeeId", "reaction"] }],
    indexes: [],
    foreignKeys: [msgFk("fk_mrx_tenant_message"), empFk("fk_mrx_tenant_employee", "employeeId")],
    checks: [],
  },
  msg_announcement_acks: {
    columns: [int("id"), int("tenantId"), int("messageId"), int("employeeId"), ts("ackedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "mak_tenant_message_employee_unique", columns: ["tenantId", "messageId", "employeeId"] }],
    indexes: [],
    foreignKeys: [msgFk("fk_mak_tenant_message"), empFk("fk_mak_tenant_employee", "employeeId")],
    checks: [],
  },
  msg_voice_listens: {
    columns: [int("id"), int("tenantId"), int("messageId"), int("employeeId"), ts("firstListenedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "mvl_tenant_message_employee_unique", columns: ["tenantId", "messageId", "employeeId"] }],
    indexes: [],
    foreignKeys: [msgFk("fk_mvl_tenant_message"), empFk("fk_mvl_tenant_employee", "employeeId")],
    checks: [],
  },
  msg_access_audit: {
    columns: [
      int("id"), int("tenantId"), int("viewerEmployeeId"), int("conversationId"), { name: "action", type: "enum", nullable: false },
      int("messageId", true), ts("viewedAt"),
    ],
    uniques: [{ name: "PRIMARY", columns: ["id"] }],
    indexes: [{ name: "maa_tenant_viewed", columns: ["tenantId", "viewedAt"] }, { name: "maa_tenant_conversation", columns: ["tenantId", "conversationId"] }],
    foreignKeys: [
      empFk("fk_maa_tenant_viewer", "viewerEmployeeId"),
      fk("fk_maa_tenant_conversation", ["tenantId", "conversationId"], "msg_conversations", ["tenantId", "id"]),
      fk("fk_maa_tenant_conv_message", ["tenantId", "conversationId", "messageId"], "msg_messages", ["tenantId", "conversationId", "id"]),
    ],
    checks: ["chk_maa_listen"],
  },
};
