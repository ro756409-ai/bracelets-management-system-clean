import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { runHandMigration, confirmPhrase, describeStatements } from "./handMigration.service";
import { MESSAGING_MIGRATION } from "./messagingMigration";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { MESSAGING_TABLES, conversationUniqueKey } from "../shared/messagingSpec";

/**
 * Migration 0043 على قواعد Docker محلية مؤقتة: يشترط الفهرسين → apply بعد 0041 → verify → replay →
 * كل FK مركّب يمنع الربط بشركة أخرى، والرد لا يكون إلا على رسالة من نفس المحادثة → CHECKs →
 * rollback قبل الاستخدام فقط (يرفض مع بيانات).
 */
const SQL43 = fs.readFileSync("drizzle/0043_messaging.sql", "utf-8");
const SQL41 = fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const run = (db: TempSchema, mode: "check" | "apply" | "rollback", extra: Record<string, unknown> = {}) =>
  runHandMigration(MESSAGING_MIGRATION, { databaseUrl: db.url, mode, sqlText: SQL43, deployEnv: "test", confirm: mode === "check" ? null : confirmPhrase("0043", mode, db.name), ...extra });

describe("0043 — نص الملف", () => {
  it("9 جداول بالترتيب، بلا فهارس مركّبة ولا FK لاحق، وبلا تعديل جداول قائمة", () => {
    expect(describeStatements(SQL43).map(s => `${s.kind}:${s.name}`)).toEqual(MESSAGING_TABLES.map(t => `table:${t}`));
    const code = SQL43.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|^\s*UPDATE /im);
  });
  it("مفاتيح المحادثات الفريدة: الخاصة مستقلة عن ترتيب الطرفين", () => {
    expect(conversationUniqueKey.direct(9, 3)).toBe("direct:3:9");
    expect(conversationUniqueKey.direct(3, 9)).toBe("direct:3:9");
    expect(conversationUniqueKey.business(5)).toBe("business:5");
  });
});

describe.runIf(CAN)("🏗️ 0043 على قواعد مؤقتة", () => {
  let db: TempSchema;
  beforeAll(async () => { db = await createTempSchema("msg_m"); }, 180_000);
  afterAll(async () => { await db?.drop(); }, 180_000);

  it("بدون الفهرسين: يرفض بلا DDL؛ بعد 0041: apply → verify → replay → القيود → rollback", async () => {
    expect((await run(db, "check")).state).toBe("not_applied");
    const refused = await run(db, "apply");
    expect(refused.refused).toBe("preflight"); expect(refused.applied).toBe(0);

    expect((await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: db.url, mode: "apply", sqlText: SQL41, deployEnv: "test", confirm: confirmPhrase("0041", "apply", db.name) })).ok).toBe(true);
    expect((await run(db, "apply", { confirm: "APPLY 0043 TO x" })).refused).toMatch(/عبارة التأكيد/);
    const ap = await run(db, "apply");
    expect(ap.ok).toBe(true); expect(ap.applied).toBe(9); expect(ap.issues).toEqual([]);
    expect((await run(db, "apply")).replay).toBe(true);
    expect((await run(db, "check")).state).toBe("applied");

    const q = async (s: string, p: unknown[] = []) => ((await db.raw.query(s, p)) as any)[0];
    const id = async (s: string, p: unknown[] = []) => (await q(s, p)).insertId as number;
    const ta = await id("INSERT INTO tenants (name, slug, status) VALUES ('A', ?, 'active')", [`a-${db.name}`.slice(0, 60)]);
    const tb = await id("INSERT INTO tenants (name, slug, status) VALUES ('B', ?, 'active')", [`b-${db.name}`.slice(0, 60)]);
    const ba = await id("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'A1', ?)", [ta, `ba-${db.name}`.slice(0, 50)]);
    const bb = await id("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'B1', ?)", [tb, `bb-${db.name}`.slice(0, 50)]);
    const emp = async (t: number, b: number | null, n: string) => id("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES (?, 'agent', 1, ?, ?, ?)", [n, t, b, `${n}-${db.name}`.slice(0, 50)]);
    const e1 = await emp(ta, ba, "e1"), e2 = await emp(ta, ba, "e2"), eb = await emp(tb, bb, "eb");
    const count = async (t: string) => Number((await q(`SELECT COUNT(*) n FROM ${t}`))[0].n);
    const rejected = async (t: string, s: string, p: unknown[], re: RegExp) => { const n = await count(t); await expect(db.raw.query(s, p)).rejects.toThrow(re); expect(await count(t)).toBe(n); };
    const conv = (cols: Record<string, unknown>) => { const k = Object.keys(cols); return db.raw.query(`INSERT INTO msg_conversations (${k.map(x => `\`${x}\``).join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map(x => cols[x])); };

    // ── المحادثات ──
    const team = ((await conv({ tenantId: ta, kind: "team", uniqueKey: "team" })) as any)[0].insertId;
    await conv({ tenantId: ta, kind: "announcement", uniqueKey: "announcement" });
    await conv({ tenantId: tb, kind: "team", uniqueKey: "team" }); // شركة أخرى بنفس المفتاح = مسموح
    await expect(conv({ tenantId: ta, kind: "team", uniqueKey: "team" })).rejects.toThrow(/Duplicate/);
    await expect(conv({ tenantId: ta, kind: "team", uniqueKey: "x" })).rejects.toThrow(/chk_msc_kind/);
    await expect(conv({ tenantId: ta, kind: "business", businessId: ba, uniqueKey: "business:999" })).rejects.toThrow(/chk_msc_kind/);
    await conv({ tenantId: ta, kind: "business", businessId: ba, uniqueKey: `business:${ba}` });
    await expect(conv({ tenantId: ta, kind: "business", businessId: bb, uniqueKey: `business:${bb}` })).rejects.toThrow(/fk_msc_tenant_business/);
    await expect(conv({ tenantId: ta, kind: "group", createdByEmployeeId: e1 })).rejects.toThrow(/chk_msc_kind/);
    await expect(conv({ tenantId: ta, kind: "group", title: "فريق", createdByEmployeeId: eb })).rejects.toThrow(/fk_msc_tenant_creator/);
    const dm = ((await conv({ tenantId: ta, kind: "direct", uniqueKey: conversationUniqueKey.direct(e1, e2), createdByEmployeeId: e1 })) as any)[0].insertId;

    // ── الأعضاء: لا موظف من شركة أخرى ──
    await q("INSERT INTO msg_members (tenantId, conversationId, employeeId) VALUES (?, ?, ?), (?, ?, ?)", [ta, dm, e1, ta, dm, e2]);
    await rejected("msg_members", "INSERT INTO msg_members (tenantId, conversationId, employeeId) VALUES (?, ?, ?)", [ta, dm, eb], /fk_msm_tenant_employee/);
    await rejected("msg_members", "INSERT INTO msg_members (tenantId, conversationId, employeeId) VALUES (?, ?, ?)", [tb, dm, eb], /fk_msm_tenant_conversation/);

    // ── الرسائل ──
    const H = "a".repeat(64);
    const m1 = await id("INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body, idempotencyKey, payloadHash) VALUES (?, ?, ?, 'text', 'أهلًا', 'k1', ?)", [ta, dm, e1, H]);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body) VALUES (?, ?, ?, 'text', 'x')", [ta, dm, eb], /fk_mmg_tenant_sender/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body) VALUES (?, ?, ?, 'text', '  ')", [ta, dm, e1], /chk_mmg_body/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body) VALUES (?, ?, NULL, 'text', 'x')", [ta, dm], /chk_mmg_sender/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body) VALUES (?, ?, ?, 'system', 'x')", [ta, dm, e1], /chk_mmg_sender/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body) VALUES (?, ?, ?, 'announcement', 'x')", [ta, team, e1], /chk_mmg_body/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body) VALUES (?, ?, ?, 'voice', 'x')", [ta, dm, e1], /chk_mmg_body/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body, isPinned) VALUES (?, ?, ?, 'text', 'x', 1)", [ta, dm, e1], /chk_mmg_pin/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body, idempotencyKey) VALUES (?, ?, ?, 'text', 'x', 'k2')", [ta, dm, e1], /chk_mmg_idem/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body) VALUES (?, ?, ?, 'text', ?)", [ta, dm, e1, "ش".repeat(4001)], /chk_mmg_body_len/);
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body, idempotencyKey, payloadHash) VALUES (?, ?, ?, 'text', 'x', 'k1', ?)", [ta, dm, e1, H], /Duplicate/);
    // الرد على رسالة من محادثة أخرى مرفوض
    await rejected("msg_messages", "INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body, replyToMessageId) VALUES (?, ?, ?, 'text', 'رد', ?)", [ta, team, e1, m1], /fk_mmg_tenant_conv_reply/);
    await id("INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body, replyToMessageId) VALUES (?, ?, ?, 'text', 'رد', ?)", [ta, dm, e2, m1]);
    // الحذف الناعم يتطلب الفاعل
    await expect(q("UPDATE msg_messages SET deletedAt = NOW(3) WHERE id = ?", [m1])).rejects.toThrow(/chk_mmg_delete/);
    await q("UPDATE msg_messages SET deletedAt = NOW(3), deletedByEmployeeId = ?, body = NULL WHERE id = ?", [e1, m1]);
    const sys = await id("INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind, body) VALUES (?, ?, NULL, 'system', 'سياسة')", [ta, team]);
    expect(sys).toBeGreaterThan(0);

    // ── المرفقات والصوت ──
    const v = await id("INSERT INTO msg_messages (tenantId, conversationId, senderEmployeeId, kind) VALUES (?, ?, ?, 'voice')", [ta, dm, e1]);
    await q("INSERT INTO msg_attachments (tenantId, messageId, kind, storageKey, mime, bytes, durationMs) VALUES (?, ?, 'voice', 'v/1.webm', 'audio/webm', 120000, 23000)", [ta, v]);
    await rejected("msg_attachments", "INSERT INTO msg_attachments (tenantId, messageId, kind, storageKey, mime, bytes, durationMs) VALUES (?, ?, 'voice', 'v/2.webm', 'audio/webm', 1000, 300001)", [ta, v], /chk_mat_voice/);
    await rejected("msg_attachments", "INSERT INTO msg_attachments (tenantId, messageId, kind, storageKey, mime, bytes) VALUES (?, ?, 'voice', 'v/3.webm', 'audio/webm', 1000)", [ta, v], /chk_mat_voice/);
    await rejected("msg_attachments", "INSERT INTO msg_attachments (tenantId, messageId, kind, storageKey, mime, bytes) VALUES (?, ?, 'file', 'f/1.pdf', 'application/pdf', 10485761)", [ta, v], /chk_mat_bytes/);
    await rejected("msg_attachments", "INSERT INTO msg_attachments (tenantId, messageId, kind, storageKey, mime, bytes) VALUES (?, ?, 'file', 'f/2.pdf', 'application/pdf', 100)", [tb, v], /fk_mat_tenant_message/);

    // ── التفاعل والاطلاع والاستماع والتدقيق ──
    await q("INSERT INTO msg_reactions (tenantId, messageId, employeeId, reaction) VALUES (?, ?, ?, 'like')", [ta, v, e2]);
    await rejected("msg_reactions", "INSERT INTO msg_reactions (tenantId, messageId, employeeId, reaction) VALUES (?, ?, ?, 'like')", [ta, v, e2], /Duplicate/);
    await q("INSERT INTO msg_voice_listens (tenantId, messageId, employeeId) VALUES (?, ?, ?)", [ta, v, e2]);
    await q("INSERT INTO msg_access_audit (tenantId, viewerEmployeeId, conversationId, action) VALUES (?, ?, ?, 'open')", [ta, e1, dm]);
    await rejected("msg_access_audit", "INSERT INTO msg_access_audit (tenantId, viewerEmployeeId, conversationId, action) VALUES (?, ?, ?, 'listen')", [ta, e1, dm], /chk_maa_listen/);
    await rejected("msg_access_audit", "INSERT INTO msg_access_audit (tenantId, viewerEmployeeId, conversationId, action, messageId) VALUES (?, ?, ?, 'listen', ?)", [ta, e1, team, v], /fk_maa_tenant_conv_message/);

    // ── rollback يرفض مع بيانات ──
    expect((await run(db, "rollback")).refused).toBe("not_empty");
    expect((await run(db, "check")).state).toBe("applied");
    await q("SET foreign_key_checks = 0");
    for (const t of [...MESSAGING_TABLES].reverse()) await q(`DELETE FROM ${t}`); // قاعدة اختبار مؤقتة فقط
    await q("SET foreign_key_checks = 1");
    expect((await run(db, "rollback")).ok).toBe(true);
    expect((await run(db, "check")).state).toBe("not_applied");
  }, 180_000);
});
