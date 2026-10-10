import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import { runHandMigration, confirmPhrase, evaluate, loadSchemaSnapshot } from "./handMigration.service";
import { TEAMS_MIGRATION } from "./teamsMigration";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { openReadOnlyExecutor } from "./balanceReconciliation.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { splitStatements, TENANT_COMPOSITE_INDEXES } from "../shared/schemaSpec";

/**
 * شكل 0044 القديم (Commit 7728417: جدولان بلا team_task_operations) يُكتشف partial ولا يُعتبر مطابقًا:
 * check وverify ⇒ partial مع ذكر الجدول الناقص؛ apply ⇒ رفض بلا أي DDL تلقائي.
 * الملف القديم منسوخ حرفيًا في server/testdata ومثبت بمعرّف git blob نفسه (234bd82…).
 */
const OLD = fs.readFileSync("server/testdata/0044_teams.at-7728417.sql", "utf-8");
const NEW = fs.readFileSync("drizzle/0044_teams.sql", "utf-8");
const SQL41 = fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
const OLD_BLOB = "234bd82b39177c25ed23981c4f07ed4818477e7c";
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const run = (db: TempSchema, mode: "check" | "apply" | "rollback") =>
  runHandMigration(TEAMS_MIGRATION, { databaseUrl: db.url, mode, sqlText: NEW, deployEnv: "test", confirm: mode === "check" ? null : confirmPhrase("0044", mode, db.name) });

describe("0044 القديم — النص", () => {
  it("نسخة حرفية من 7728417 (نفس git blob) وتحتوي جدولين فقط", () => {
    const buf = fs.readFileSync("server/testdata/0044_teams.at-7728417.sql");
    const blob = crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
    expect(blob).toBe(OLD_BLOB);
    expect(splitStatements(OLD).map(s => s.match(/^CREATE TABLE `([^`]+)`/)?.[1])).toEqual(["teams", "team_memberships"]);
  });
});

describe.runIf(CAN)("🧩 0044 القديم على قاعدة مؤقتة", () => {
  let db: TempSchema;
  beforeAll(async () => {
    db = await createTempSchema("t44_old");
    expect((await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: db.url, mode: "apply", sqlText: SQL41, deployEnv: "test", confirm: confirmPhrase("0041", "apply", db.name) })).ok).toBe(true);
    for (const stmt of splitStatements(OLD)) await db.raw.query(stmt); // الشكل القديم حرفيًا
  }, 180_000);
  afterAll(async () => { await db?.drop(); }, 180_000);

  const tables = async () => ((await db.raw.query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('teams','team_memberships','team_task_operations') ORDER BY t")) as any)[0].map((r: any) => r.t);

  it("check: partial مع ذكر team_task_operations الناقص — ليس مطابقًا", async () => {
    expect(await tables()).toEqual(["team_memberships", "teams"]);
    const c = await run(db, "check");
    expect(c.state).toBe("partial");
    expect(c.ok).toBe(false);
    expect(c.issues).toContainEqual(expect.objectContaining({ table: "team_task_operations", kind: "table", detail: "الجدول غير موجود" }));
    expect(c.statements.map(s => `${s.name}:${s.present}`)).toEqual(["teams:true", "team_memberships:true", "team_task_operations:false"]);
  });

  it("verify (نفس مسار scripts/verify-teams): partial ونفس الفرق", async () => {
    const exec = await openReadOnlyExecutor(db.url);
    try {
      const r = evaluate(TEAMS_MIGRATION, await loadSchemaSnapshot(exec, [...TEAMS_MIGRATION.tables, ...TENANT_COMPOSITE_INDEXES.map(i => i.table)]));
      expect(r.state).toBe("partial");
      expect(r.issues.map(i => `${i.table}:${i.detail}`)).toContain("team_task_operations:الجدول غير موجود");
    } finally { await exec.close(); }
  });

  it("apply على partial: رفض بلا أي DDL — لا جدول جديد ولا تعديل", async () => {
    const before = await tables();
    const a = await run(db, "apply");
    expect(a.ok).toBe(false);
    expect(a.refused).toBe("partial");
    expect(a.applied).toBe(0);
    expect(await tables()).toEqual(before);
  });
});
