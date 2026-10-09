import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { runHandMigration, confirmPhrase, describeStatements } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { runMigrate0040 } from "./ledgerV3Migrate.service";
import { openReadOnlyExecutor } from "./balanceReconciliation.service";
import { ledgerV3Preflight } from "./ledgerV3Verify.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";

/**
 * Migration 0041 على قواعد Docker محلية مؤقتة فقط (نسخ كاملة من مخطط المشروع الحقيقي):
 * preflight → not_applied → بوابات الرفض → apply → verify → replay → قيود CHECK/FK بالحالات الدقيقة →
 * rollback قبل الاستخدام (ويرفض مع بيانات) → إعادة التطبيق مع تخطّي الفهرسين → partial يرفض → 0040 يقبل الفهرسين.
 */
const SQL = fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const run = (db: TempSchema, mode: "check" | "apply" | "rollback", extra: Record<string, unknown> = {}) =>
  runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: db.url, mode, sqlText: SQL, deployEnv: "test", confirm: mode === "check" ? null : confirmPhrase("0041", mode, db.name), ...extra });

describe("0041 — نص الملف", () => {
  it("العبارات: فهرسان مركّبان ثم جدول واحد، ولا عبارة أخرى", () => {
    const st = describeStatements(SQL);
    expect(st.map(s => `${s.kind}:${s.name}`)).toEqual(["composite_index:businesses_tenant_id", "composite_index:employees_tenant_id", "table:order_activity_events"]);
  });
  it("orderId بلا FK، وattributedEmployeeId بـFK مركّب، وeventType VARCHAR(50)", () => {
    expect(SQL).not.toMatch(/FOREIGN KEY \(`orderId`\)/);
    expect(SQL).toContain("FOREIGN KEY (`tenantId`,`attributedEmployeeId`) REFERENCES `employees`(`tenantId`,`id`)");
    expect(SQL).toContain("`eventType` varchar(50) NOT NULL");
    expect(SQL).toContain("`orderNumberSnapshot` varchar(100) NOT NULL");
  });
});

describe.runIf(CAN)("🏗️ 0041 على قاعدتين مؤقتتين", () => {
  const dbs: TempSchema[] = [];
  beforeAll(async () => { dbs.push(await createTempSchema("oae_a"), await createTempSchema("oae_b"), await createTempSchema("oae_p")); }, 180_000);
  afterAll(async () => { for (const d of dbs) await d.drop(); }, 180_000);

  const seed = async (db: TempSchema) => {
    const q = (s: string, p: unknown[] = []) => db.raw.query(s, p).then(r => (r[0] as any).insertId as number);
    const ta = await q("INSERT INTO tenants (name, slug, status) VALUES ('A', ?, 'active')", [`a-${db.name}`.slice(0, 60)]);
    const tb = await q("INSERT INTO tenants (name, slug, status) VALUES ('B', ?, 'active')", [`b-${db.name}`.slice(0, 60)]);
    const ba = await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'A1', ?)", [ta, `ba-${db.name}`.slice(0, 50)]);
    const bb = await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'B1', ?)", [tb, `bb-${db.name}`.slice(0, 50)]);
    const ea = await q("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('ea', 'agent', 1, ?, ?, ?)", [ta, ba, `ea-${db.name}`.slice(0, 50)]);
    const eb = await q("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('eb', 'agent', 1, ?, ?, ?)", [tb, bb, `eb-${db.name}`.slice(0, 50)]);
    return { ta, tb, ba, bb, ea, eb };
  };

  for (const i of [0, 1]) {
    it(`قاعدة ${i + 1}: preflight → apply → verify → replay → قيود → rollback → إعادة تطبيق بتخطّي الفهرسين`, async () => {
      const db = dbs[i];
      const s = await seed(db);

      const chk = await run(db, "check");
      expect(chk.state).toBe("not_applied");
      expect(chk.compositeIndexes).toBe("absent");
      expect(chk.preflight.filter(p => !p.ok)).toEqual([]);

      // بوابات الرفض — بلا أي DDL
      expect((await run(db, "apply", { confirm: "APPLY 0041 TO wrong" })).refused).toMatch(/عبارة التأكيد/);
      expect((await run(db, "apply", { deployEnv: null })).refused).toMatch(/DEPLOY_ENV/);
      expect((await run(db, "apply", { deployEnv: "production" })).refused).toMatch(/DEPLOY_ENV/);
      expect((await run(db, "check")).state).toBe("not_applied");

      const ap = await run(db, "apply");
      expect(ap.ok).toBe(true); expect(ap.applied).toBe(3); expect(ap.skipped).toBe(0);
      expect(ap.state).toBe("applied"); expect(ap.issues).toEqual([]);

      const again = await run(db, "apply");
      expect(again.replay).toBe(true); expect(again.applied).toBe(0);

      // ── القيود بالحالات الدقيقة (كل رفض = صفر صفوف جديدة) ──
      const ins = (cols: Record<string, unknown>) => {
        const base = { tenantId: s.ta, businessId: s.ba, orderId: 1, orderNumberSnapshot: "TH-1", eventType: "confirm", actorType: "employee", actorEmployeeId: s.ea, attributedEmployeeId: s.ea, source: "admin_ui", idempotencyKey: `k-${Math.random()}`, payloadHash: "a".repeat(64), ...cols };
        const keys = Object.keys(base);
        return db.raw.query(`INSERT INTO order_activity_events (${keys.map(k => `\`${k}\``).join(",")}) VALUES (${keys.map(() => "?").join(",")})`, keys.map(k => (base as any)[k]));
      };
      const count = async () => Number(((await db.raw.query("SELECT COUNT(*) n FROM order_activity_events")) as any)[0][0].n);
      await ins({});
      expect(await count()).toBe(1);
      const rejected = async (cols: Record<string, unknown>, re: RegExp) => { const n = await count(); await expect(ins(cols)).rejects.toThrow(re); expect(await count()).toBe(n); };
      await rejected({ attributedEmployeeId: null }, /chk_oae_actor/);                                  // موظف بلا منسوب
      await rejected({ actorEmployeeId: null }, /chk_oae_actor/);                                       // موظف بلا منفّذ
      await rejected({ actorType: "webhook", source: "webhook_bosta" }, /chk_oae_actor/);               // ويبهوك بمنفّذ
      await rejected({ actorType: "backfill", actorEmployeeId: null, source: "admin_ui" }, /chk_oae_backfill/);
      await rejected({ actorType: "backfill", actorEmployeeId: null, source: "backfill" }, /chk_oae_backfill/); // بلا درجة ثقة
      await rejected({ callAttempt: 2 }, /chk_oae_call/);
      await rejected({ eventType: "Confirm!" }, /chk_oae_event_type/);
      await rejected({ payloadHash: "zz" }, /chk_oae_hash/);
      await rejected({ businessId: s.bb }, /foreign key/i);                                            // نشاط B بـtenant A
      await rejected({ actorEmployeeId: s.eb, attributedEmployeeId: s.eb }, /foreign key/i);           // موظف B بـtenant A
      await rejected({ assigneeEmployeeIdAtEvent: s.eb }, /foreign key/i);
      const dupKey = `dup-${Math.random()}`; await ins({ idempotencyKey: dupKey });
      await rejected({ idempotencyKey: dupKey }, /Duplicate entry/);
      // المقبول: backfill مؤكد منسوب لموظف بلا منفّذ، وويبهوك بلا موظف، وno_answer بمحاولة
      await ins({ actorType: "backfill", actorEmployeeId: null, attributedEmployeeId: s.ea, source: "backfill", backfillConfidence: "confirmed" });
      await ins({ actorType: "backfill", actorEmployeeId: null, attributedEmployeeId: null, source: "backfill", backfillConfidence: "partial" });
      await ins({ actorType: "webhook", actorEmployeeId: null, attributedEmployeeId: null, source: "webhook_bosta", eventType: "ship_update" });
      await ins({ eventType: "no_answer", callAttempt: 3 });
      // أطول رقم أوردر مسموح حاليًا (orders.orderNumber + easyOrderShortId) يدخل في الـsnapshot
      const [lens] = (await db.raw.query("SELECT COLUMN_NAME c, CHARACTER_MAXIMUM_LENGTH l FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME IN ('orderNumber','easyOrderShortId')")) as any;
      const longest = Math.max(...lens.map((r: any) => Number(r.l)));
      expect(longest).toBeLessThanOrEqual(100);
      await ins({ orderNumberSnapshot: "9".repeat(longest) });
      await ins({ orderNumberSnapshot: "X".repeat(100) });
      await rejected({ orderNumberSnapshot: "X".repeat(101) }, /too long/i);

      // rollback مع بيانات → مرفوض بلا تغيير
      const rbFull = await run(db, "rollback");
      expect(rbFull.refused).toBe("not_empty");
      expect((await run(db, "check")).state).toBe("applied");
      await db.raw.query("DELETE FROM order_activity_events"); // قاعدة اختبار مؤقتة فقط — الكود لا يحذف أحداثًا أبدًا

      // rollback قبل الاستخدام: الجدول يُحذف والفهرسان يبقيان (الافتراضي الآمن)
      const rb = await run(db, "rollback");
      expect(rb.ok).toBe(true);
      const after = await run(db, "check");
      expect(after.state).toBe("not_applied"); expect(after.compositeIndexes).toBe("present");

      // 0040 يقبل الفهرسين الصحيحين: check = غير مطبَّقة (لا partial) والـpreflight مستوفى — بلا تطبيق 0040
      const l = await runMigrate0040({ databaseUrl: db.url, mode: "check", sqlText: fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8") });
      expect(l.state).toBe("not_applied"); expect(l.ok).toBe(true);
      const ro = await openReadOnlyExecutor(db.url);
      try { expect((await ledgerV3Preflight(ro)).filter(r => !r.ok)).toEqual([]); } finally { await ro.close(); }

      // إعادة التطبيق: الفهرسان موجودان بالتعريف الصحيح → skip، والجدول يُنشأ
      const re = await run(db, "apply");
      expect(re.ok).toBe(true); expect(re.skipped).toBe(2); expect(re.applied).toBe(1);

      // rollback مع حذف الفهرسين: لا FK آخر يعتمد عليهما → يُحذفان
      const rb2 = await run(db, "rollback", { dropCompositeIndexes: true });
      expect(rb2.ok).toBe(true);
      expect((await run(db, "check")).compositeIndexes).toBe("absent");
    }, 180_000);
  }

  it("partial: فهرس مركّب واحد أو بتعريف مختلف → check partial و--apply يرفض بلا أي DDL", async () => {
    const db = dbs[2];
    await seed(db);
    await db.raw.query("ALTER TABLE `businesses` ADD UNIQUE INDEX `businesses_tenant_id` (`tenantId`,`id`)");
    let chk = await run(db, "check");
    expect(chk.state).toBe("partial"); expect(chk.ok).toBe(false);
    let ap = await run(db, "apply");
    expect(ap.refused).toBe("partial"); expect(ap.applied).toBe(0);
    await db.raw.query("ALTER TABLE `employees` ADD UNIQUE INDEX `employees_tenant_id` (`id`,`tenantId`)"); // ترتيب مختلف
    chk = await run(db, "check");
    expect(chk.state).toBe("partial");
    ap = await run(db, "apply");
    expect(ap.refused).toBe("partial");
    const [[t]] = (await db.raw.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_activity_events'")) as any;
    expect(Number(t.n)).toBe(0);
  }, 120_000);

  it("هدف يبدو إنتاجًا يُرفض دائمًا", async () => {
    const r = await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: "mysql://u:p@db.example.com:3306/matjarak", mode: "apply", sqlText: SQL, deployEnv: "staging", confirm: confirmPhrase("0041", "apply", "matjarak") });
    expect(r.refused).toMatch(/إنتاج/);
  });
});
