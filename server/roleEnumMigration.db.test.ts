import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { confirmPhrase } from "./handMigration.service";
import { AFTER_TYPE, BEFORE_TYPE, alterRoleSql, evaluateRoleColumn, runRoleEnumMigration } from "./roleEnumMigration.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { EMPLOYEE_ROLE_ENUM_AFTER_0045, EMPLOYEE_ROLE_ENUM_BEFORE_0045, enumColumnType } from "../shared/employeeRoleEnumSpec";

/**
 * Migration 0045 (accounts_manager) على قواعد Docker مؤقتة: check → apply → خصائص العمود كما هي → replay → verify →
 * رفض الشكل المختلف بلا DDL → رفض التراجع عند استخدام الدور (كل عمود يخزّن الدور) → التراجع للتعريف القديم حرفيًا.
 */
const SQL45 = fs.readFileSync("drizzle/0045_accounts_manager_role.sql", "utf-8");
const CAN = Boolean(process.env.TEST_DATABASE_URL);

describe("0045 — المواصفة والملف", () => {
  it("القيم القديمة الثلاث عشرة بترتيبها حرفيًا، والجديدة في الآخر فقط؛ الملف والمواصفة متطابقان", () => {
    expect(EMPLOYEE_ROLE_ENUM_AFTER_0045.slice(0, -1)).toEqual([...EMPLOYEE_ROLE_ENUM_BEFORE_0045]);
    expect(EMPLOYEE_ROLE_ENUM_AFTER_0045.at(-1)).toBe("accounts_manager");
    const code = SQL45.split("\n").filter(l => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe(`ALTER TABLE \`employees\` MODIFY COLUMN \`role\` ${AFTER_TYPE} NOT NULL DEFAULT 'agent';`);
    expect(SQL45).toContain(`--   ALTER TABLE \`employees\` MODIFY COLUMN \`role\` ${BEFORE_TYPE} NOT NULL DEFAULT 'agent';`);
    expect(code).not.toMatch(/CREATE TABLE|DROP |DELETE FROM|INSERT INTO|UPDATE /i);
  });
  it("الحكم على الشكل (نقي): قيم مختلفة/ترتيب/nullable/افتراضي/تعليق = partial", () => {
    const base = { columnType: BEFORE_TYPE, nullable: false, defaultValue: "agent", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci", comment: "", extra: "" };
    expect(evaluateRoleColumn(base).state).toBe("not_applied");
    expect(evaluateRoleColumn({ ...base, columnType: AFTER_TYPE }).state).toBe("applied");
    expect(evaluateRoleColumn({ ...base, columnType: enumColumnType(["warehouse", "agent", ...EMPLOYEE_ROLE_ENUM_BEFORE_0045.slice(2)]) }).state).toBe("partial");
    // أول 12 بلا moderator = الشكل الفعلي في الإنتاج: «قبل» معروف (قرار 0045-ب)، مش partial
    expect(evaluateRoleColumn({ ...base, columnType: enumColumnType([...EMPLOYEE_ROLE_ENUM_BEFORE_0045.slice(0, -1)]) }).state).toBe("not_applied");
    // قيمة ناقصة من النص (viewer) لسه partial
    expect(evaluateRoleColumn({ ...base, columnType: enumColumnType(EMPLOYEE_ROLE_ENUM_BEFORE_0045.filter(v => v !== "viewer")) }).state).toBe("partial");
    expect(evaluateRoleColumn({ ...base, nullable: true }).state).toBe("partial");
    expect(evaluateRoleColumn({ ...base, defaultValue: "viewer" }).state).toBe("partial");
    expect(evaluateRoleColumn({ ...base, comment: "x" }).state).toBe("partial");
    expect(evaluateRoleColumn(null).state).toBe("partial");
    expect(() => alterRoleSql(AFTER_TYPE, { charset: "utf8mb4; DROP", collation: "x" })).toThrow();
  });
});

describe.runIf(CAN)("🏗️ 0045 على قواعد مؤقتة", () => {
  let db: TempSchema;
  const run = (mode: "check" | "apply" | "rollback", extra: Record<string, unknown> = {}) =>
    runRoleEnumMigration({ databaseUrl: db.url, mode, deployEnv: "test", confirm: mode === "check" ? null : confirmPhrase("0045", mode, db.name), ...extra });
  const q = async (s: string, p: unknown[] = []) => ((await db.raw.query(s, p)) as any)[0];
  const column = async () => (await q("SELECT COLUMN_TYPE t, IS_NULLABLE n, COLUMN_DEFAULT d, CHARACTER_SET_NAME cs, COLLATION_NAME co, COLUMN_COMMENT c, ORDINAL_POSITION p FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'role'"))[0];
  beforeAll(async () => { db = await createTempSchema("role_45"); }, 180_000);
  afterAll(async () => { await db?.drop(); }, 180_000);

  it("check → apply (بوابات) → خصائص كما هي → replay → verify", async () => {
    const before = await column();
    expect(before.t).toBe(BEFORE_TYPE);
    expect((await run("check")).state).toBe("not_applied");
    expect((await run("apply", { confirm: "APPLY 0045 TO x" })).refused).toMatch(/عبارة التأكيد/);
    expect((await run("apply", { deployEnv: null })).refused).toMatch(/DEPLOY_ENV/);
    expect((await run("apply", { databaseUrl: db.url.replace("127.0.0.1", "10.1.2.3") })).refused).toMatch(/مضيف محلي/);
    expect((await column()).t).toBe(BEFORE_TYPE); // لا DDL من المرفوض
    const ap = await run("apply");
    expect(ap.ok).toBe(true); expect(ap.applied).toBe(true);
    const after = await column();
    expect(after.t).toBe(AFTER_TYPE);
    expect([after.n, after.d, after.cs, after.co, after.c, after.p]).toEqual([before.n, before.d, before.cs, before.co, before.c, before.p]);
    expect((await run("apply")).replay).toBe(true);
    expect((await run("check")).state).toBe("applied");
    // القيمة الجديدة تُقبل، والقيم القديمة كما هي
    await q("INSERT INTO employees (name, role, isActive) VALUES ('مدير حسابات', 'accounts_manager', 1)");
    await expect(q("INSERT INTO employees (name, role, isActive) VALUES ('خطأ', 'not_a_role', 1)")).rejects.toThrow();
  }, 120_000);

  it("rollback يُرفض عند استخدام الدور في أي عمود يخزّنه، وينجح بعد إزالته ويعيد التعريف القديم حرفيًا", async () => {
    const tenant = (await q("INSERT INTO tenants (name, slug, status) VALUES ('T', ?, 'active')", [`t-${db.name}`.slice(0, 60)])).insertId;
    const emp = (await q("SELECT id FROM employees WHERE role = 'accounts_manager' LIMIT 1"))[0].id;
    expect((await run("rollback")).refused).toBe("role_in_use");
    await q("UPDATE employees SET role = 'accountant' WHERE id = ?", [emp]);
    // tenant_role_permissions
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accounts_manager', 'ledger.view', 1, ?)", [tenant, emp]);
    expect((await run("rollback")).refused).toBe("role_in_use");
    await q("DELETE FROM tenant_role_permissions WHERE role = 'accounts_manager'");
    // memberships
    await q("INSERT INTO memberships (employeeId, tenantId, role) VALUES (?, ?, 'accounts_manager')", [emp, tenant]);
    expect((await run("rollback")).refused).toBe("role_in_use");
    await q("DELETE FROM memberships WHERE role = 'accounts_manager'");
    expect((await column()).t).toBe(AFTER_TYPE); // كل الرفض بلا DDL
    const rb = await run("rollback");
    expect(rb.ok).toBe(true);
    expect((await column()).t).toBe(BEFORE_TYPE);
    expect((await run("check")).state).toBe("not_applied");
    expect((await run("rollback")).ok).toBe(true); // لا شيء للتراجع
  }, 120_000);

  it("شكل مختلف (ترتيب/قيمة ناقصة/nullable): check = partial و apply مرفوض بلا أي DDL", async () => {
    const shapes = [
      enumColumnType(["warehouse", "agent", ...EMPLOYEE_ROLE_ENUM_BEFORE_0045.slice(2)]) + " NOT NULL DEFAULT 'agent'",
      enumColumnType([...EMPLOYEE_ROLE_ENUM_BEFORE_0045, "other_role"]) + " NOT NULL DEFAULT 'agent'",
      BEFORE_TYPE + " NULL DEFAULT 'agent'",
    ];
    for (const shape of shapes) {
      await q(`ALTER TABLE employees MODIFY COLUMN role ${shape}`);
      const t = (await column()).t;
      const c = await run("check");
      expect(c.state, shape).toBe("partial"); expect(c.ok).toBe(false);
      const a = await run("apply");
      expect(a.refused, shape).toBe("partial");
      expect((await column()).t).toBe(t);
      expect((await run("rollback")).refused).toBe("partial");
    }
    await q(`ALTER TABLE employees MODIFY COLUMN role ${BEFORE_TYPE} NOT NULL DEFAULT 'agent'`);
    expect((await run("check")).state).toBe("not_applied");
  }, 120_000);
});
