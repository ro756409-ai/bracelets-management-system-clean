import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import mysql from "mysql2/promise";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { runHandMigration } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { runMigrate0040 } from "./ledgerV3Migrate.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import {
  authorizeProductionMigration,
  productionConfirmPhrase,
  runProductionMigration,
  PRODUCTION_MIGRATION_ENABLE_ENV,
  PRODUCTION_MIGRATION_LOCK,
  type MigrationTarget,
  type ProductionMigrationId,
} from "./productionMigration";

/**
 * B1 على MySQL محلي حقيقي (قاعدة مؤقتة لكل تشغيل): هوية الخادم الفعلية، القفل الفعلي، check قبل/بعد، replay بلا
 * إعادة تطبيق، وبيانات الجداول الموجودة لا تتغير. لا Production ولا Staging — الهدف «إنتاجي» بالموافقة فقط.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const SHA = "16b8551f1e2d3fdc25fc8d6e02d4ffb3e05923dde254612afdad519ed5d36443";

describe.runIf(CAN)("🛡️ B1 — المسار المحمي على قاعدة محلية", () => {
  let tmp: TempSchema; let target: MigrationTarget; let raw: mysql.Connection;
  const sql0041 = () => fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
  const sql0040 = () => fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8");
  const env = { [PRODUCTION_MIGRATION_ENABLE_ENV]: "1", DEPLOY_ENV: "production" };
  const auth = (id: ProductionMigrationId, t: MigrationTarget = target) => authorizeProductionMigration({
    env, databaseUrl: tmp.url, migrationId: id, mode: "apply", backupSha256: SHA,
    confirm: productionConfirmPhrase(id, "apply", t.database, t.serverUuid), targets: { version: 1, targets: [t] },
  });
  const outcome = (r: { ok: boolean; state: string | null; refused: string | null; lines: string[] }) => ({ ok: r.ok, state: r.state, refused: r.refused, lines: r.lines });
  const hand = (a: ReturnType<typeof auth>) => ({
    check: async () => outcome(await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: tmp.url, mode: "check", sqlText: sql0041() })),
    run: async () => outcome(await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: sql0041(), confirm: a.confirm, production: a })),
  });
  const schemaShape = async () => {
    const [t] = await raw.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
    const [i] = await raw.query("SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY 1,2,3");
    const [id] = await raw.query("SELECT NAME, TABLE_ID FROM information_schema.INNODB_TABLES WHERE NAME LIKE CONCAT(DATABASE(), '/%') ORDER BY NAME");
    return JSON.stringify([t, i, id]);
  };
  const checksums = async () => JSON.stringify((await raw.query("CHECKSUM TABLE tenants, businesses, employees, orders, products"))[0]);

  beforeAll(async () => {
    tmp = await createTempSchema("b1_prod");
    raw = await mysql.createConnection(tmp.url);
    await raw.query("INSERT INTO tenants (name, slug, status) VALUES ('شركة B1', ?, 'active')", [`b1-${Date.now()}`]);
    const [[{ uuid }]] = (await raw.query("SELECT @@server_uuid AS uuid")) as any;
    const u = new URL(tmp.url);
    target = { id: "local-b1", host: u.hostname, port: Number(u.port || 3306), database: u.pathname.slice(1), serverUuid: uuid,
      migrations: ["0040", "0041", "0045"], approvedBy: "local-test", approvalRef: "B1-LOCAL", approvedAt: new Date(Date.now() - 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), backupSha256: SHA, backupRestoreVerifiedAt: new Date(Date.now() - 600_000).toISOString() };
  }, 240_000);
  afterAll(async () => { await raw?.end(); await tmp?.drop(); }, 120_000);

  it("بدون إذن: الـrunner يرفض كما كان (DEPLOY_ENV=production ليس بيئة مسموحة)", async () => {
    const r = await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: sql0041(), confirm: `APPLY 0041 TO ${target.database}`, deployEnv: "production" });
    expect(r.refused).toMatch(/DEPLOY_ENV/);
    const r2 = await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: sql0041(), confirm: "x", production: { migrationId: "0041" } });
    expect(r2.refused).toMatch(/إذن Production غير صالح/);
  }, 120_000);

  it("server_uuid مختلف في الموافقة = توقف قبل أي DDL", async () => {
    const before = await schemaShape();
    const a = auth("0041", { ...target, serverUuid: "11111111-2222-3333-4444-555555555555" });
    const res = await runProductionMigration({ auth: a, databaseUrl: tmp.url, ...hand(a), rollbackHint: "x" });
    expect(res.ok).toBe(false); expect(res.refused).toMatch(/server_uuid/);
    expect(await schemaShape()).toBe(before);
  }, 120_000);

  it("قفل محجوز من اتصال آخر = توقف قبل أي DDL", async () => {
    const holder = await mysql.createConnection(tmp.url);
    try {
      await holder.query("SELECT GET_LOCK(?, 0)", [PRODUCTION_MIGRATION_LOCK]);
      const before = await schemaShape();
      const a = auth("0041");
      const res = await runProductionMigration({ auth: a, databaseUrl: tmp.url, ...hand(a), rollbackHint: "x" });
      expect(res.refused).toMatch(/قفل/);
      expect(await schemaShape()).toBe(before);
    } finally { await holder.query("SELECT RELEASE_LOCK(?)", [PRODUCTION_MIGRATION_LOCK]); await holder.end(); }
  }, 120_000);

  it("0041 كاملة: قبل not_applied ← بعد applied، البيانات كما هي، والتدقيق بلا أسرار؛ والتشغيل الثاني replay بلا DDL", async () => {
    const data0 = await checksums();
    const a = auth("0041");
    const first = await runProductionMigration({ auth: a, databaseUrl: tmp.url, ...hand(a), rollbackHint: "x" });
    expect(first.ok).toBe(true);
    expect(first.audit).toMatchObject({ before: "not_applied", after: "applied", approvalRef: "B1-LOCAL", ok: true });
    expect(JSON.stringify(first.audit)).not.toMatch(/mysql:\/\/|password|root@/);
    expect(await checksums()).toBe(data0);
    const shape = await schemaShape();
    const a2 = auth("0041");
    const second = await runProductionMigration({ auth: a2, databaseUrl: tmp.url, ...hand(a2), rollbackHint: "x" });
    expect(second.ok).toBe(true);
    expect(second.audit).toMatchObject({ before: "applied", after: "applied" });
    expect(second.lines.join("\n")).toContain("replay");
    expect(await schemaShape()).toBe(shape);
    expect(await checksums()).toBe(data0);
    const [[{ got }]] = (await raw.query("SELECT IS_FREE_LOCK(?) AS got", [PRODUCTION_MIGRATION_LOCK])) as any;
    expect(Number(got)).toBe(1);
  }, 120_000);

  it("0040 و0045 بنفس المسار: 0040 تُطبَّق ثم replay، و0045 replay لشكل الأدوار الحالي", async () => {
    const data0 = await checksums();
    for (let i = 0; i < 2; i++) {
      const a = auth("0040");
      const r = await runProductionMigration({ auth: a, databaseUrl: tmp.url, rollbackHint: "x",
        check: async () => outcome(await runMigrate0040({ databaseUrl: tmp.url, mode: "check", sqlText: sql0040() })),
        run: async () => outcome(await runMigrate0040({ databaseUrl: tmp.url, mode: "apply", sqlText: sql0040(), confirm: a.confirm, production: a })) });
      expect(r.ok, r.lines.join("\n")).toBe(true);
      expect(r.audit.after).toBe("applied");
      if (i === 1) expect(r.audit.before).toBe("applied");
    }
    const b = auth("0045");
    const r45 = await runProductionMigration({ auth: b, databaseUrl: tmp.url, rollbackHint: "x",
      check: async () => outcome(await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "check" })),
      run: async () => outcome(await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", confirm: b.confirm, production: b })) });
    expect(r45.ok, r45.lines.join("\n")).toBe(true);
    expect(await checksums()).toBe(data0);
  }, 120_000);

  it("migration خارج الموافقة لا يصدر لها إذن أصلًا", () => {
    expect(() => auth("0055")).toThrow(/لا تشمل 0055/);
  }, 120_000);
});
