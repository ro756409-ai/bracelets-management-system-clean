import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { openReadOnlyExecutor } from "./balanceReconciliation.service";
import { checkLedgerPrereqs } from "./ledgerPrereqs.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * فحص متطلبات Ledger V3 (قراءة فقط) على قاعدة حقيقية مؤقتة: كل جدول وعمود في المواصفة موجود فعلًا في المخطط الكامل
 * (لا أسماء مخمّنة)، الغياب يُكتشف بدقة، الاختياري لا يُفشل، وحالة 0040 تُقرأ؛ والمنفّذ يرفض أي كتابة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🧾 متطلبات Ledger V3 — فحص قراءة فقط", () => {
  let tmp: TempSchema;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  beforeAll(async () => {
    tmp = await createTempSchema("ledger_prereq");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
  }, 300_000);
  afterAll(async () => { await tmp?.drop(); }, 120_000);

  it("المخطط الكامل: كل المتطلبات موجودة؛ قبل 0040 حالة الدفتر «absent»؛ ثم بعده «present»", async () => {
    const exec = await openReadOnlyExecutor(tmp.url);
    try {
      const r = await checkLedgerPrereqs(exec);
      expect(r.tables.filter(t => !t.ok)).toEqual([]);
      expect(r.prerequisitesOk).toBe(true);
      expect(r.migrations.find(m => m.id === "0040")?.state).toBe("absent");
      await expect(exec.query("UPDATE orders SET status = status")).rejects.toThrow(/non-SELECT/);
    } finally { await exec.close(); }
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) {
      try { await tmp.raw.query(stmt); } catch (err: any) { if (err?.code !== "ER_DUP_KEYNAME") throw err; }
    }
    const exec2 = await openReadOnlyExecutor(tmp.url);
    try { expect((await checkLedgerPrereqs(exec2)).migrations.find(m => m.id === "0040")?.state).toBe("present"); } finally { await exec2.close(); }
  });

  it("الغياب يُكتشف بدقة: جدول مخزون ناقص وعمود ناقص = فشل؛ جدول أرشيف اختياري غائب لا يُفشل", async () => {
    await q("RENAME TABLE inventory_reservations TO inventory_reservations_x");
    await q("ALTER TABLE order_items DROP COLUMN returnedQuantity");
    await q("RENAME TABLE employee_advances TO employee_advances_x");
    const exec = await openReadOnlyExecutor(tmp.url);
    try {
      const r = await checkLedgerPrereqs(exec);
      expect(r.prerequisitesOk).toBe(false);
      expect(r.tables.filter(t => !t.ok).map(t => [t.table, t.present, t.missingColumns.includes("returnedQuantity")])).toEqual([["order_items", true, true], ["inventory_reservations", false, false]]);
      expect(r.tables.find(t => t.table === "employee_advances")).toMatchObject({ present: false, required: false, ok: true });
    } finally { await exec.close(); }
  });
});
