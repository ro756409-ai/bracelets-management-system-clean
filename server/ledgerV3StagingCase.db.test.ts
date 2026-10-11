import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { migrationConfirmationPhrase, runMigrate0040 } from "./ledgerV3Migrate.service";
import { openReadOnlyExecutor } from "./balanceReconciliation.service";
import { ledgerV3Preflight, verifyLedgerV3OnDatabase } from "./ledgerV3Verify.service";
import { LEDGER_V3_DROP_ORDER, LEDGER_V3_TABLES } from "../shared/ledgerV3Spec";
import { createTempSchema, type TempSchema } from "./testTempSchema";

/**
 * 0040 على قاعدتين مؤقتتين:
 *  (أ) جديدة بلا أي شيء (قبل 0040/0041/0042).
 *  (ب) **حالة Staging الحالية حرفيًا**: 0041 ثم 0042 مطبَّقتان أولًا ⇒ الفهرسان businesses_tenant_id /
 *      employees_tenant_id موجودان Unique على (tenantId,id) ولا أي جدول ledger_*.
 * لكلٍّ: preflight → check (not_applied) → apply (الجداول السبعة؛ الفهرسان يُتخطّيان في (ب)) → replay → verify →
 * rollback (في (ب) الجداول السبعة فقط — الفهرسان ملك 0041) → check (not_applied) → إعادة تطبيق.
 * وحالات الرفض قبل أي DDL: فهرس بنفس الاسم غير فريد، فهرس بترتيب أعمدة مختلف، جدول ledger_* جزئي.
 */
const SQL40 = fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8");
const SQL41 = fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
const SQL42 = fs.readFileSync("drizzle/0042_attendance.sql", "utf-8");
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const OLD_IDX = [["businesses", "businesses_tenant_id"], ["employees", "employees_tenant_id"]] as const;

describe.runIf(CAN)("🧭 0040 — قاعدة جديدة وحالة Staging (0041+0042 أولًا)", () => {
  let fresh: TempSchema, staging: TempSchema, nonUnique: TempSchema, wrongOrder: TempSchema, partialTbl: TempSchema;
  beforeAll(async () => {
    [fresh, staging, nonUnique, wrongOrder, partialTbl] = await Promise.all([
      createTempSchema("l40_fresh"), createTempSchema("l40_staging"), createTempSchema("l40_nonuniq"), createTempSchema("l40_order"), createTempSchema("l40_partial"),
    ]);
    // (ب) 0041 ثم 0042 بالأداة الرسمية نفسها
    for (const [def, sql, id] of [[ORDER_EVENTS_MIGRATION, SQL41, "0041"], [ATTENDANCE_MIGRATION, SQL42, "0042"]] as const) {
      const r = await runHandMigration(def, { databaseUrl: staging.url, mode: "apply", sqlText: sql, deployEnv: "test", confirm: confirmPhrase(id, "apply", staging.name) });
      expect(r.ok).toBe(true);
    }
  }, 300_000);
  afterAll(async () => { for (const d of [fresh, staging, nonUnique, wrongOrder, partialTbl]) await d?.drop(); }, 300_000);

  const check = (db: TempSchema) => runMigrate0040({ databaseUrl: db.url, mode: "check", sqlText: SQL40 });
  const apply = (db: TempSchema) => runMigrate0040({ databaseUrl: db.url, mode: "apply", sqlText: SQL40, confirm: migrationConfirmationPhrase(db.name), deployEnv: "staging" });
  const q = async (db: TempSchema, sql: string, p: unknown[] = []) => ((await db.raw.query(sql, p)) as any)[0];
  const ledgerCount = async (db: TempSchema) => Number((await q(db, "SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)", [LEDGER_V3_TABLES]))[0].n);
  const idxRows = async (db: TempSchema) => JSON.stringify(await q(db, "SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('businesses_tenant_id','employees_tenant_id') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"));
  const preflightFailures = async (db: TempSchema) => { const ro = await openReadOnlyExecutor(db.url); try { return (await ledgerV3Preflight(ro)).filter(r => !r.ok).map(r => r.label); } finally { await ro.close(); } };
  const verifyIssues = async (db: TempSchema) => { const ro = await openReadOnlyExecutor(db.url); try { return (await verifyLedgerV3OnDatabase(ro)).issues; } finally { await ro.close(); } };
  const rollbackTables = async (db: TempSchema) => { for (const t of LEDGER_V3_DROP_ORDER) await q(db, `DROP TABLE IF EXISTS \`${t}\``); };

  it("(أ) قاعدة جديدة: preflight → check → apply 9/9 → replay → verify → rollback (جداول + فهرسان) → check → إعادة تطبيق", async () => {
    expect(await preflightFailures(fresh)).toEqual([]);
    const c0 = await check(fresh);
    expect(c0.state).toBe("not_applied"); expect(c0.statements.every(s => !s.present)).toBe(true);
    const a = await apply(fresh);
    expect(a).toMatchObject({ ok: true, state: "applied", applied: 9, refused: null }); expect(a.issues).toEqual([]);
    expect(a.lines.filter(l => /— نُفِّذ وتحقّق/.test(l))).toHaveLength(9);
    expect((await apply(fresh))).toMatchObject({ ok: true, replay: true, applied: 0 });
    expect(await verifyIssues(fresh)).toEqual([]);
    await rollbackTables(fresh);
    for (const [t, i] of OLD_IDX) await q(fresh, `ALTER TABLE \`${t}\` DROP INDEX \`${i}\``); // أنشأهما 0040 هنا
    expect((await check(fresh)).state).toBe("not_applied");
    expect((await apply(fresh))).toMatchObject({ ok: true, state: "applied", applied: 9 });
  });

  it("(ب) Staging الحالية حرفيًا: لا جدول ledger_* + الفهرسان Unique (tenantId,id) ⇒ preflight مستوفى، check = not_applied (ليست partial)", async () => {
    expect(await ledgerCount(staging)).toBe(0);
    expect(await idxRows(staging)).toBe(JSON.stringify([
      { TABLE_NAME: "businesses", INDEX_NAME: "businesses_tenant_id", SEQ_IN_INDEX: 1, COLUMN_NAME: "tenantId", NON_UNIQUE: 0 },
      { TABLE_NAME: "businesses", INDEX_NAME: "businesses_tenant_id", SEQ_IN_INDEX: 2, COLUMN_NAME: "id", NON_UNIQUE: 0 },
      { TABLE_NAME: "employees", INDEX_NAME: "employees_tenant_id", SEQ_IN_INDEX: 1, COLUMN_NAME: "tenantId", NON_UNIQUE: 0 },
      { TABLE_NAME: "employees", INDEX_NAME: "employees_tenant_id", SEQ_IN_INDEX: 2, COLUMN_NAME: "id", NON_UNIQUE: 0 },
    ]));
    expect(await preflightFailures(staging)).toEqual([]);
    const c = await check(staging);
    expect(c.state).toBe("not_applied"); expect(c.ok).toBe(true);
    expect(c.statements.map(s => s.present)).toEqual([true, true, false, false, false, false, false, false, false]);
  });

  it("(ب) apply: الجداول السبعة فقط، الفهرسان لا يُعاد إنشاؤهما ولا يتغيّران، ثم replay وverify", async () => {
    const before = await idxRows(staging);
    const a = await apply(staging);
    expect(a).toMatchObject({ ok: true, state: "applied", refused: null }); expect(a.issues).toEqual([]);
    expect(a.lines.filter(l => /موجود مسبقًا بالتعريف الصحيح \(skip\)/.test(l))).toHaveLength(2);
    expect(a.lines.filter(l => /جدول ledger_[a-z_]+ — نُفِّذ وتحقّق/.test(l))).toHaveLength(7);
    expect(a.lines.some(l => /فهرس فريد .* — نُفِّذ وتحقّق/.test(l))).toBe(false);
    expect(await ledgerCount(staging)).toBe(7);
    expect(await idxRows(staging)).toBe(before);
    expect((await apply(staging))).toMatchObject({ ok: true, replay: true, applied: 0, state: "applied" });
    expect(await verifyIssues(staging)).toEqual([]);
  });

  it("(ب) rollback = الجداول السبعة فقط (الفهرسان ملك 0041 يبقيان، وجداول 0041/0042 سليمة) ⇒ not_applied ثم إعادة تطبيق", async () => {
    const before = await idxRows(staging);
    await rollbackTables(staging);
    expect(await ledgerCount(staging)).toBe(0);
    expect(await idxRows(staging)).toBe(before);
    const kept = await q(staging, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME = 'order_activity_events' OR TABLE_NAME LIKE 'attendance\\_%') ORDER BY TABLE_NAME");
    expect(kept.map((r: any) => r.TABLE_NAME)).toEqual(["attendance_assignments", "attendance_correction_requests", "attendance_days", "attendance_events", "attendance_shifts", "order_activity_events"]);
    expect((await check(staging)).state).toBe("not_applied");
    expect(await preflightFailures(staging)).toEqual([]);
    expect((await apply(staging))).toMatchObject({ ok: true, state: "applied" });
    expect(await idxRows(staging)).toBe(before);
  });

  it("فهرس بنفس الاسم لكن غير فريد ⇒ partial، وapply يُرفض قبل أي DDL", async () => {
    await q(nonUnique, "ALTER TABLE `businesses` ADD INDEX `businesses_tenant_id` (`tenantId`,`id`)");
    await q(nonUnique, "ALTER TABLE `employees` ADD INDEX `employees_tenant_id` (`tenantId`,`id`)");
    const c = await check(nonUnique);
    expect(c.state).toBe("partial"); expect(c.ok).toBe(false);
    expect(c.issues.some(i => i.kind === "old_index" && /غير فريد/.test(i.detail))).toBe(true);
    const before = await idxRows(nonUnique);
    const a = await apply(nonUnique);
    expect(a).toMatchObject({ ok: false, refused: "partial", applied: 0 });
    expect(await ledgerCount(nonUnique)).toBe(0);
    expect(await idxRows(nonUnique)).toBe(before);
    expect((await preflightFailures(nonUnique)).length).toBeGreaterThan(0);
  });

  it("فهرس Unique بنفس الاسم لكن بترتيب أعمدة مختلف ⇒ partial، وapply يُرفض قبل أي DDL", async () => {
    await q(wrongOrder, "ALTER TABLE `businesses` ADD UNIQUE INDEX `businesses_tenant_id` (`id`,`tenantId`)");
    await q(wrongOrder, "ALTER TABLE `employees` ADD UNIQUE INDEX `employees_tenant_id` (`tenantId`,`id`)");
    expect((await check(wrongOrder)).state).toBe("partial");
    const a = await apply(wrongOrder);
    expect(a).toMatchObject({ ok: false, refused: "partial", applied: 0 });
    expect(await ledgerCount(wrongOrder)).toBe(0);
  });

  it("وجود جزئي لجداول ledger_* (مع الفهرسين الصحيحين) ⇒ partial، وapply يُرفض بلا إكمال", async () => {
    for (const [t, i] of OLD_IDX) await q(partialTbl, `ALTER TABLE \`${t}\` ADD UNIQUE INDEX \`${i}\` (\`tenantId\`,\`id\`)`);
    const create = SQL40.split(/-->\s*statement-breakpoint/).map(s => s.trim()).find(s => s.includes("CREATE TABLE `ledger_accounts`"))!;
    await q(partialTbl, create.split("\n").filter(l => !l.trim().startsWith("--")).join("\n"));
    expect((await check(partialTbl)).state).toBe("partial");
    const a = await apply(partialTbl);
    expect(a).toMatchObject({ ok: false, refused: "partial", applied: 0 });
    expect(await ledgerCount(partialTbl)).toBe(1);
  });
});
