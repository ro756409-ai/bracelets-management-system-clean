import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { runLedgerKindsMigration, KINDS_AFTER_TYPE, KINDS_BEFORE_TYPE } from "./ledgerKindsMigration.service";
import { LEDGER_PHASE_MIGRATIONS } from "./ledgerPhaseMigrations";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture } from "./testFixtures";
import { __setDbForTests } from "./db";
import { drizzle } from "drizzle-orm/mysql2";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * Migrations 0046–0051 على قواعد مؤقتة محلية فقط: check → apply → verify → replay → partial مرفوض → rollback (مرفوض مع بيانات
 * مستخدمة) → إعادة تطبيق؛ وبوابات البيئة/عبارة التأكيد/الهدف الإنتاجي قبل أي DDL؛ و0047–0051 بلا 0040 = preflight مرفوض بلا DDL.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🧱 Migrations 0046–0051 (محلي مؤقت)", () => {
  let tmp: TempSchema; let bare: TempSchema;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const env = (db: TempSchema, id: string, mode: "apply" | "rollback") => ({ deployEnv: "test", confirm: confirmPhrase(id as any, mode, db.name) });

  beforeAll(async () => {
    tmp = await createTempSchema("mig_4650");
    bare = await createTempSchema("mig_bare");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    // بيانات حقيقية للتحقق من رفض التراجع: شركة وموظف (عبر نفس الـfixtures)
    __setDbForTests(drizzle(tmp.url));
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); await bare?.drop(); }, 120_000);

  it("0046: check/apply/replay/verify، والخصائص كما هي، والتراجع مرفوض مع حساب يستخدم نوعًا جديدًا", async () => {
    const col = async () => (await q("SELECT COLUMN_TYPE t, IS_NULLABLE n, CHARACTER_SET_NAME c, COLLATION_NAME l FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ledger_accounts' AND COLUMN_NAME = 'kind'"))[0];
    const before = await col();
    expect(before.t).toBe(KINDS_BEFORE_TYPE);
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "check" })).state).toBe("not_applied");
    // بوابات قبل أي DDL
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: "APPLY 0046 TO other" })).refused).toMatch(/عبارة التأكيد/);
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: null, confirm: confirmPhrase("0046", "apply", tmp.name) })).refused).toMatch(/DEPLOY_ENV/);
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url.replace("127.0.0.1", "10.1.2.3"), mode: "apply", ...env(tmp, "0046", "apply") })).refused).toBeTruthy();
    expect((await col()).t).toBe(KINDS_BEFORE_TYPE);
    const a = await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "apply", ...env(tmp, "0046", "apply") });
    expect([a.ok, a.applied, a.state]).toEqual([true, true, "applied"]);
    const after = await col();
    expect(after).toEqual({ ...before, t: KINDS_AFTER_TYPE });
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "apply", ...env(tmp, "0046", "apply") })).replay).toBe(true);
    // تراجع مرفوض مع استخدام
    const f = await createCoreTestFixture("m46");
    await q("INSERT INTO ledger_accounts (tenantId, code, name, kind, normalSide, currency, actorType) VALUES (?, 'PAYROLL_PAYABLE', 'رواتب مستحقة', 'payroll_payable', 'credit', 'EGP', 'system')", [f.tenantId]);
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "rollback", ...env(tmp, "0046", "rollback") })).refused).toBe("kind_in_use");
    await q("DELETE FROM ledger_accounts WHERE code = 'PAYROLL_PAYABLE'");
    const rb = await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "rollback", ...env(tmp, "0046", "rollback") });
    expect([rb.ok, rb.state]).toEqual([true, "not_applied"]);
    expect((await col()).t).toBe(KINDS_BEFORE_TYPE);
    // شكل مختلف = partial ورفض بلا DDL
    await q("ALTER TABLE ledger_accounts MODIFY COLUMN kind enum('cash','bank') NULL");
    const p = await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "apply", ...env(tmp, "0046", "apply") });
    expect([p.state, p.refused]).toEqual(["partial", "partial"]);
    await q(`ALTER TABLE ledger_accounts MODIFY COLUMN kind ${KINDS_BEFORE_TYPE} NOT NULL`);
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "apply", ...env(tmp, "0046", "apply") })).ok).toBe(true);
  });

  it("0047–0051 بلا 0040: preflight مرفوض بلا أي DDL", async () => {
    for (const { def, file } of LEDGER_PHASE_MIGRATIONS) {
      const r = await runHandMigration(def, { databaseUrl: bare.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), ...env(bare, def.id, "apply") });
      expect(r.ok).toBe(false);
      expect(String(r.refused)).toMatch(/preflight/);
    }
    for (const t of ["ledger_shipments", "ledger_payroll_runs", "ledger_suppliers", "ledger_period_snapshots"])
      expect(Number((await bare.raw.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]) as any)[0][0].n)).toBe(0);
  });

  // كل Migration في اختبار مستقل (DDL متتابع — يبقى كل اختبار داخل المهلة الافتراضية بلا رفعها)
  for (const [i, id] of ["0047", "0048", "0049", "0050", "0051"].entries()) {
    it(`${id}: check → apply → مطابقة كاملة للمواصفة → replay → check سليم`, async () => {
      const { def, file } = LEDGER_PHASE_MIGRATIONS[i];
      const sqlText = fs.readFileSync(file, "utf-8");
      const run = (mode: "check" | "apply") => runHandMigration(def, { databaseUrl: tmp.url, mode, sqlText, ...(mode === "check" ? {} : env(tmp, def.id, "apply")) });
      expect((await run("check")).state).toBe("not_applied");
      const a = await run("apply");
      expect([a.ok, a.state, a.issues]).toEqual([true, "applied", []]);
      expect((await run("apply")).replay).toBe(true);
      expect((await run("check")).ok).toBe(true);
    });
  }

  it("partial: CHECK محذوفة = شكل مختلف ⇒ apply مرفوض بلا إكمال؛ والـCHECK المعادة فعّالة", async () => {
    const { def, file } = LEDGER_PHASE_MIGRATIONS[0];
    await q("ALTER TABLE ledger_settings DROP CHECK chk_lst_one_value");
    const p = await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), ...env(tmp, "0047", "apply") });
    expect([p.state, p.refused]).toEqual(["partial", "partial"]);
    await q("ALTER TABLE ledger_settings ADD CONSTRAINT chk_lst_one_value CHECK ((`valueDecimal` IS NOT NULL AND `valueInt` IS NULL) OR (`valueDecimal` IS NULL AND `valueInt` IS NOT NULL))");
    expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "check", sqlText: fs.readFileSync(file, "utf-8") })).state).toBe("applied");
  });

  it("rollback 0047: مرفوض مع بيانات، ناجح بعد تفريغها، ثم إعادة تطبيق", async () => {
    const { def, file } = LEDGER_PHASE_MIGRATIONS[0];
    const f = await createCoreTestFixture("m47");
    const empId = (await q("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('م', 'super_admin', 1, ?, ?, ?)", [f.tenantId, f.businessId, `m47_${tmp.name}`.slice(0, 50)])).insertId;
    await expect(q("INSERT INTO ledger_settings (tenantId, settingKey, valueDecimal, valueInt, updatedByEmployeeId) VALUES (?, 'carrier.bosta.payout_days', 1, 2, ?)", [f.tenantId, empId])).rejects.toThrow();
    await q("INSERT INTO ledger_settings (tenantId, settingKey, valueInt, updatedByEmployeeId) VALUES (?, 'carrier.bosta.payout_days', 7, ?)", [f.tenantId, empId]);
    const rb = (mode: "rollback" | "apply") => runHandMigration(def, { databaseUrl: tmp.url, mode, sqlText: fs.readFileSync(file, "utf-8"), ...env(tmp, "0047", mode) });
    expect((await rb("rollback")).refused).toBe("not_empty");
    await q("DELETE FROM ledger_settings");
    expect((await rb("rollback")).ok).toBe(true);
    expect(Number((await q("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('ledger_shipments','ledger_carrier_review_items','ledger_settings')"))[0].n)).toBe(0);
    expect((await rb("apply")).ok).toBe(true);
  });

  it("rollback 0048–0051 (فارغة) بترتيب عكسي ثم إعادة تطبيق", async () => {
    for (const { def, file } of [...LEDGER_PHASE_MIGRATIONS].slice(1).reverse()) {
      const r = await runHandMigration(def, { databaseUrl: tmp.url, mode: "rollback", sqlText: fs.readFileSync(file, "utf-8"), ...env(tmp, def.id, "rollback") });
      expect([r.ok, r.state], def.id).toEqual([true, "not_applied"]);
    }
    for (const { def, file } of LEDGER_PHASE_MIGRATIONS.slice(1)) expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), ...env(tmp, def.id, "apply") })).ok, def.id).toBe(true);
  });

  it("0051: القيود فعّالة (شكل كل حدث، الفاعل، السبب، منع التكرار، صورة من نفس الشركة) والتراجع مرفوض مع أي حدث", async () => {
    const { def, file } = LEDGER_PHASE_MIGRATIONS[4];
    const f = await createCoreTestFixture("m51"); const g = await createCoreTestFixture("m51b");
    const emp = (await q("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('مالك', 'super_admin', 1, ?, ?, ?)", [f.tenantId, f.businessId, `m51_${tmp.name}`.slice(0, 50)])).insertId;
    const empB = (await q("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('مالك ب', 'super_admin', 1, ?, ?, ?)", [g.tenantId, g.businessId, `m51b_${tmp.name}`.slice(0, 50)])).insertId;
    const H = "a".repeat(64);
    const ins = (t: number, action: string, key: string, snap: number | null, json: string | null, hash: string | null, reason: string, actor: number | null) =>
      q("INSERT INTO ledger_legacy_archive_events (tenantId, action, activationAt, dedupeKey, snapshotEventId, figuresJson, figuresHash, reason, actorEmployeeId) VALUES (?, ?, '2026-10-01 10:00:00', ?, ?, ?, ?, ?, ?)", [t, action, key, snap, json, hash, reason, actor]);
    const snap = (await ins(f.tenantId, "stop_snapshot", "snapshot:1", null, "{}", H, "توقف للمطابقة", emp)).insertId;
    await expect(ins(f.tenantId, "lift", "lift:x", null, null, H, "رفع بعد المطابقة", emp)).rejects.toThrow(/chk_llae_shape/);       // رفع بلا صورة
    await expect(ins(f.tenantId, "lift", "lift:y", snap, null, H, "رفع بعد المطابقة", null)).rejects.toThrow(/chk_llae_actor/);       // رفع بلا فاعل
    await expect(ins(f.tenantId, "lift", "lift:z", snap, null, H, "  ", emp)).rejects.toThrow(/chk_llae_reason/);                    // سبب فارغ
    await expect(ins(f.tenantId, "reapply", "reapply:1", null, null, "XYZ", "تفعيل", null)).rejects.toThrow(/chk_llae_shape|chk_llae_hash/);
    await expect(ins(g.tenantId, "lift", "lift:other", snap, null, H, "صورة شركة أخرى", empB)).rejects.toThrow(/foreign key/i);   // صورة شركة أخرى
    await expect(ins(f.tenantId, "lift", "lift:emp", snap, null, H, "فاعل شركة أخرى", empB)).rejects.toThrow(/foreign key/i);      // فاعل شركة أخرى
    await ins(f.tenantId, "lift", `lift:${snap}`, snap, null, H, "رفع بعد المطابقة", emp);
    await expect(ins(f.tenantId, "lift", `lift:${snap}`, snap, null, H, "رفع مكرر", emp)).rejects.toThrow(/Duplicate/);
    await ins(f.tenantId, "reapply", "reapply:1", null, null, null, "تفعيل Ledger V3", null);
    const rb = (mode: "rollback" | "apply" | "check") => runHandMigration(def, { databaseUrl: tmp.url, mode, sqlText: fs.readFileSync(file, "utf-8"), ...(mode === "check" ? {} : env(tmp, "0051", mode)) });
    expect((await rb("rollback")).refused).toBe("not_empty");
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_legacy_archive_events"))[0].n)).toBe(3);
    expect((await rb("check")).state).toBe("applied");
    // تفريغ يدوي (اختبار فقط — التطبيق لا يملك مسار حذف) ثم تراجع وإعادة تطبيق
    await q("DELETE FROM ledger_legacy_archive_events WHERE snapshotEventId IS NOT NULL"); await q("DELETE FROM ledger_legacy_archive_events");
    expect((await rb("rollback")).ok).toBe(true);
    expect((await rb("check")).state).toBe("not_applied");
    expect((await rb("apply")).ok).toBe(true);
  });

  it("قيود الجداول فعّالة: دورة نشطة واحدة لكل شهر (وإعادة بعد الإلغاء)، والقسط المخصوم مربوط بدورة، والإيصال بفاتورة واحدة", async () => {
    const f = await createCoreTestFixture("m48");
    const emp = (await q("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('مالك', 'super_admin', 1, ?, ?, ?)", [f.tenantId, f.businessId, `m48_${tmp.name}`.slice(0, 50)])).insertId;
    await q("INSERT INTO ledger_payroll_runs (tenantId, period, createdByEmployeeId, idempotencyKey) VALUES (?, '2026-10', ?, 'run-2026-10-a')", [f.tenantId, emp]);
    await expect(q("INSERT INTO ledger_payroll_runs (tenantId, period, createdByEmployeeId, idempotencyKey) VALUES (?, '2026-10', ?, 'run-2026-10-b')", [f.tenantId, emp])).rejects.toThrow(/Duplicate/);
    await q("UPDATE ledger_payroll_runs SET status = 'cancelled', cancelledAt = NOW(3), cancelledByEmployeeId = ?, cancelReason = 'إعادة الحساب' WHERE tenantId = ? AND period = '2026-10'", [emp, f.tenantId]);
    await q("INSERT INTO ledger_payroll_runs (tenantId, period, createdByEmployeeId, idempotencyKey) VALUES (?, '2026-10', ?, 'run-2026-10-c')", [f.tenantId, emp]);
    // حالة غير متسقة: موافَق بلا قيد استحقاق = CHECK
    await expect(q("UPDATE ledger_payroll_runs SET status = 'approved', approvedAt = NOW(3), approvedByEmployeeId = ? WHERE idempotencyKey = 'run-2026-10-c'", [emp])).rejects.toThrow(/chk_lpr/);
  });
});
