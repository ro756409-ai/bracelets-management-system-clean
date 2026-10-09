import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { migrationConfirmationPhrase, runMigrate0040 } from "./ledgerV3Migrate.service";
import { disableConfirmationPhrase, runDisableLedgerV3 } from "./ledgerV3Disable.service";
import { activateLedgerV3, type LedgerDb } from "./ledgerV3.service";

/**
 * أدوات التشغيل على قواعد مؤقتة كاملة (نسخة المخطط الحقيقي بلا 0040):
 *   migrate-0040: check بلا كتابة · بوابات --apply (DEPLOY_ENV/إنتاج/اسم القاعدة/التأكيد) قبل أي DDL · تطبيق كامل
 *   مع تحقق بعد كل عبارة ثم المواصفة · replay بلا تغيير · partial يتوقف بلا إكمال · لا أسرار في المخرجات.
 *   disable: dry-run بلا تغيير · رفض التأكيد الخاطئ/غير المالك/شركة أخرى/غير مفعّلة · تعطيل العلم فقط مع تسجيل
 *   الفاعل والسبب والتوقيت والحركات تبقى · retry = replay.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const SQL = fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8");
const statements = splitMigrationStatements(SQL);
const LEDGER_TABLES = ["ledger_accounts", "ledger_account_businesses", "ledger_periods", "ledger_period_events", "ledger_transactions", "ledger_entries", "ledger_tenant_flags"];
const stripLedgerIndexes = (ddl: string) => ddl.split("\n").filter(l => !/`(businesses|employees)_tenant_id`/.test(l)).join("\n").replace(/,\n\)/, "\n)");
const SECRET_PASS = "S3cretPassXYZ";

describe.runIf(CAN)("🛠️ Ledger V3 ops — migrate-0040 وdisable على قواعد مؤقتة كاملة", () => {
  const baseUrl = process.env.TEST_DATABASE_URL as string;
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  // الاسم يحدد البوابة: staging/test مسموح، غيره مرفوض
  const DB_STAGING = `ledgerops_staging_${tag}`, DB_PARTIAL = `ledgerops_test_partial_${tag}`, DB_PROD = `ledgerops_prodlike_${tag}`;
  const urlFor = (db: string) => { const u = new URL(baseUrl); u.pathname = `/${db}`; return u.toString(); };
  let admin: mysql.Connection;
  const ledgerTableCount = async (db: string) => Number(((await admin.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)", [db, LEDGER_TABLES])) as any)[0][0].n);
  const noSecrets = (r: { lines: string[] }) => { const t = r.lines.join("\n"); expect(t).not.toContain(SECRET_PASS); expect(t).not.toMatch(/mysql:\/\//); };

  beforeAll(async () => {
    admin = await mysql.createConnection(baseUrl);
    const [tables] = await admin.query("SHOW TABLES") as any;
    const names: string[] = tables.map((r: any) => Object.values(r)[0] as string).filter((n: string) => !n.startsWith("ledger_") && !n.startsWith("_"));
    const ddl: string[] = [];
    for (const n of names) { try { const [r] = await admin.query(`SHOW CREATE TABLE \`${n}\``) as any; ddl.push(stripLedgerIndexes(r[0]["Create Table"])); } catch (e: any) { if (e?.code !== "ER_NO_SUCH_TABLE") throw e; } }
    for (const name of [DB_STAGING, DB_PARTIAL, DB_PROD]) {
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      const c = await mysql.createConnection(urlFor(name));
      await c.query("SET foreign_key_checks = 0");
      for (const stmt of ddl) await c.query(stmt);
      await c.query("SET foreign_key_checks = 1");
      await c.end();
    }
  }, 180_000);
  // حذف نسخ المخطط الكاملة (≥80 جدولًا لكل قاعدة) تحت حمل الـsuite المتوازية على Docker مؤقت أبطأ من
  // المهلة الافتراضية 10 ثوانٍ؛ كل الاتصالات مغلقة قبله (afterAll الداخلية) فلا قفل معلّق — نفس مهلة الإنشاء.
  afterAll(async () => {
    for (const name of [DB_STAGING, DB_PARTIAL, DB_PROD]) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  }, 120_000);

  describe("migrate-0040", () => {
    it("check (افتراضي): not_applied، العبارات التسع ناقصة، لا كتابة، ولا أسرار في المخرجات", async () => {
      const r = await runMigrate0040({ databaseUrl: urlFor(DB_STAGING), mode: "check", sqlText: SQL });
      expect(r.state).toBe("not_applied"); expect(r.ok).toBe(true); expect(r.replay).toBe(false);
      expect(r.statements).toHaveLength(9); expect(r.statements.every(s => !s.present)).toBe(true);
      expect(r.statements.map(s => s.kind)).toEqual(["index", "index", "table", "table", "table", "table", "table", "table", "table"]);
      expect(r.target).toEqual({ host: "127.0.0.1", database: DB_STAGING });
      expect(await ledgerTableCount(DB_STAGING)).toBe(0);
      noSecrets(r);
    });
    it("بوابات --apply قبل أي DDL: DEPLOY_ENV ≠ staging، تأكيد خاطئ، اسم قاعدة لا يدل على Staging، ورابط يبدو إنتاجًا (بلا اتصال أصلًا ولا تسريب كلمة السر)", async () => {
      const confirm = migrationConfirmationPhrase(DB_STAGING);
      const r1 = await runMigrate0040({ databaseUrl: urlFor(DB_STAGING), mode: "apply", sqlText: SQL, confirm, deployEnv: "production" });
      expect(r1.refused).toContain("DEPLOY_ENV"); expect(r1.ok).toBe(false);
      const r2 = await runMigrate0040({ databaseUrl: urlFor(DB_STAGING), mode: "apply", sqlText: SQL, confirm: "APPLY LEDGER V3 0040 TO wrong", deployEnv: "staging" });
      expect(r2.refused).toContain("عبارة التأكيد");
      const r3 = await runMigrate0040({ databaseUrl: urlFor(DB_PROD), mode: "apply", sqlText: SQL, confirm: migrationConfirmationPhrase(DB_PROD), deployEnv: "staging" });
      expect(r3.refused).toContain("لا يدل على Staging");
      const prodUrl = `mysql://app:${SECRET_PASS}@db.internal.example:3306/matjarak`;
      const r4 = await runMigrate0040({ databaseUrl: prodUrl, mode: "apply", sqlText: SQL, confirm: migrationConfirmationPhrase("matjarak"), deployEnv: "staging" });
      expect(r4.refused).toContain("تبدو إنتاجًا");
      for (const r of [r1, r2, r3, r4]) { expect(r.applied).toBe(0); noSecrets(r); }
      expect(await ledgerTableCount(DB_STAGING)).toBe(0); expect(await ledgerTableCount(DB_PROD)).toBe(0);
    });
    it("--apply كامل على Staging: العبارات التسع بالترتيب مع تحقق بعد كل واحدة، ثم «مطابق بالكامل»؛ ثم check = applied", async () => {
      const r = await runMigrate0040({ databaseUrl: urlFor(DB_STAGING), mode: "apply", sqlText: SQL, confirm: migrationConfirmationPhrase(DB_STAGING), deployEnv: "staging" });
      expect(r.refused).toBeNull(); expect(r.ok).toBe(true); expect(r.applied).toBe(9); expect(r.state).toBe("applied"); expect(r.issues).toEqual([]);
      expect(r.lines.filter(l => /— نُفِّذ وتحقّق/.test(l))).toHaveLength(9);
      expect(r.lines.join("\n")).toContain("مطابق بالكامل");
      expect(await ledgerTableCount(DB_STAGING)).toBe(7);
      const c = await runMigrate0040({ databaseUrl: urlFor(DB_STAGING), mode: "check", sqlText: SQL });
      expect(c.state).toBe("applied"); expect(c.ok).toBe(true); expect(c.statements.every(s => s.present)).toBe(true);
      noSecrets(r);
    });
    it("replay: --apply على قاعدة مطبَّقة = لا تغيير (applied 0) ومطابق بالكامل", async () => {
      const [[before]] = await admin.query("SELECT COUNT(*) n, MAX(CREATE_TIME) t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [DB_STAGING]) as any;
      const r = await runMigrate0040({ databaseUrl: urlFor(DB_STAGING), mode: "apply", sqlText: SQL, confirm: migrationConfirmationPhrase(DB_STAGING), deployEnv: "staging" });
      expect(r).toMatchObject({ ok: true, replay: true, applied: 0, state: "applied" });
      expect(r.lines.join("\n")).toContain("replay");
      const [[after]] = await admin.query("SELECT COUNT(*) n, MAX(CREATE_TIME) t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [DB_STAGING]) as any;
      expect(after.n).toBe(before.n); expect(String(after.t)).toBe(String(before.t));
    });
    it("partial: 3 عبارات منفَّذة → check يعرض المنفَّذ/الناقص، و--apply يتوقف بلا إكمال تلقائي", async () => {
      const c = await mysql.createConnection(urlFor(DB_PARTIAL));
      for (const s of statements.slice(0, 3)) await c.query(s);
      await c.end();
      const chk = await runMigrate0040({ databaseUrl: urlFor(DB_PARTIAL), mode: "check", sqlText: SQL });
      expect(chk.state).toBe("partial"); expect(chk.ok).toBe(false);
      expect(chk.statements.map(s => s.present)).toEqual([true, true, true, false, false, false, false, false, false]);
      const r = await runMigrate0040({ databaseUrl: urlFor(DB_PARTIAL), mode: "apply", sqlText: SQL, confirm: migrationConfirmationPhrase(DB_PARTIAL), deployEnv: "staging" });
      expect(r.refused).toBe("partial"); expect(r.applied).toBe(0); expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toContain("لا إكمال تلقائي");
      expect(await ledgerTableCount(DB_PARTIAL)).toBe(1);
      noSecrets(r);
    });
  });

  describe("disable-ledger-v3", () => {
    let db: LedgerDb; let raw: mysql.Connection;
    let tenantX = 0, bizX = 0, ownerX = 0, accX = 0, tenantY = 0, bizY = 0, ownerY = 0;
    const ins = async (sql: string, p: unknown[]) => Number(((await raw.query(sql, p)) as any)[0].insertId);
    const n = async (sql: string, p: unknown[] = []) => Number(((await raw.query(sql, p)) as any)[0][0].n);
    const flag = async () => ((await raw.query("SELECT ledgerV3Enabled, disabledAt, disabledReason, actorEmployeeId FROM ledger_tenant_flags WHERE tenantId = ?", [tenantX])) as any)[0][0];

    beforeAll(async () => {
      db = drizzle(urlFor(DB_STAGING)) as unknown as LedgerDb;
      raw = await mysql.createConnection(urlFor(DB_STAGING));
      tenantX = await ins("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`X ${tag}`, `x-${tag}`]);
      tenantY = await ins("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`Y ${tag}`, `y-${tag}`]);
      bizX = await ins("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'Brand X', ?)", [tenantX, `bx-${tag}`]);
      bizY = await ins("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'Brand Y', ?)", [tenantY, `by-${tag}`]);
      ownerX = await ins("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('owner X', 'super_admin', 1, ?, ?, ?)", [tenantX, bizX, `ox-${tag}`]);
      accX = await ins("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('acc X', 'accountant', 1, ?, ?, ?)", [tenantX, bizX, `ax-${tag}`]);
      ownerY = await ins("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('owner Y', 'super_admin', 1, ?, ?, ?)", [tenantY, bizY, `oy-${tag}`]);
      await activateLedgerV3({
        tenantId: tenantX, goLiveDate: "2026-11-01", currency: "EGP", actor: { type: "employee", employeeId: ownerX },
        reconciliation: { reportGeneratedAt: "r", approvedByEmployeeId: ownerX, approvedAt: "a" }, openingBalances: { OFFICE_CASH: "500" }, businessIds: [bizX], safeGrants: { OFFICE_CASH: [bizX] },
      }, db);
    }, 60_000);
    afterAll(async () => { await raw.end(); await (db as any).$client?.end?.(); });

    it("dry-run لا يغيّر شيئًا؛ تأكيد خاطئ/محاسب/مالك شركة أخرى/شركة غير مفعّلة = رفض بلا كتابة", async () => {
      const before = await flag(); expect(before.ledgerV3Enabled).toBe(1);
      const dry = await runDisableLedgerV3({ tenantId: tenantX, db, actorEmployeeId: ownerX, reason: "اختبار", apply: false });
      expect(dry).toMatchObject({ ok: true, applied: false, replay: false, refused: null });
      expect(dry.lines.join("\n")).toContain("الحركات المحفوظة: 1");
      expect((await runDisableLedgerV3({ tenantId: tenantX, db, actorEmployeeId: ownerX, reason: "اختبار", apply: true, confirm: "DISABLE LEDGER V3 TENANT 0" })).refused).toContain("عبارة التأكيد");
      expect((await runDisableLedgerV3({ tenantId: tenantX, db, actorEmployeeId: accX, reason: "اختبار", apply: true, confirm: disableConfirmationPhrase(tenantX) })).refused).toContain("ليس مالكًا");
      expect((await runDisableLedgerV3({ tenantId: tenantX, db, actorEmployeeId: ownerY, reason: "اختبار", apply: true, confirm: disableConfirmationPhrase(tenantX) })).refused).toContain("ليس موظفًا فعّالًا في هذه الشركة");
      expect((await runDisableLedgerV3({ tenantId: tenantY, db, actorEmployeeId: ownerY, reason: "اختبار", apply: true, confirm: disableConfirmationPhrase(tenantY) })).refused).toContain("لم تُفعَّل قط");
      expect((await runDisableLedgerV3({ tenantId: tenantX, db, actorEmployeeId: ownerX, reason: "", apply: true, confirm: disableConfirmationPhrase(tenantX) })).refused).toContain("السبب إلزامي");
      expect(await flag()).toEqual(before);
    });
    it("apply صحيح: العلم فقط يتعطل مع الفاعل والسبب والتوقيت؛ الحسابات والحركات تبقى؛ retry = replay بلا تغيير", async () => {
      const txBefore = await n("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [tenantX]);
      const r = await runDisableLedgerV3({ tenantId: tenantX, db, actorEmployeeId: ownerX, reason: "إيقاف مؤقت للمراجعة", apply: true, confirm: disableConfirmationPhrase(tenantX) });
      expect(r).toMatchObject({ ok: true, applied: true, replay: false, refused: null });
      const f = await flag();
      expect(f.ledgerV3Enabled).toBe(0); expect(f.disabledReason).toBe("إيقاف مؤقت للمراجعة"); expect(f.actorEmployeeId).toBe(ownerX); expect(f.disabledAt).not.toBeNull();
      expect(await n("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [tenantX])).toBe(txBefore);
      expect(await n("SELECT COUNT(*) n FROM ledger_accounts WHERE tenantId = ?", [tenantX])).toBe(9);
      expect(await n("SELECT COUNT(*) n FROM ledger_entries WHERE tenantId = ?", [tenantX])).toBe(2);
      const again = await runDisableLedgerV3({ tenantId: tenantX, db, actorEmployeeId: ownerX, reason: "مرة ثانية", apply: true, confirm: disableConfirmationPhrase(tenantX) });
      expect(again).toMatchObject({ ok: true, applied: false, replay: true });
      expect(await flag()).toEqual(f);
      noSecrets(r);
    });
  });
});
