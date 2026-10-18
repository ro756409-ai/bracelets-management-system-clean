import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { confirmPhrase } from "./handMigration.service";
import {
  runRoleEnumMigration, evaluateRoleColumn, alterRoleSql, AFTER_TYPE, BEFORE_TYPE, LEGACY_BEFORE_TYPE, type RoleColumn,
} from "./roleEnumMigration.service";
import {
  EMPLOYEE_ROLE_ENUM_AFTER_0045, EMPLOYEE_ROLE_ENUM_BEFORE_0045, EMPLOYEE_ROLE_ENUM_LEGACY_WITHOUT_MODERATOR, enumColumnType,
} from "../shared/employeeRoleEnumSpec";
import { createTempSchema, type TempSchema } from "./testTempSchema";

/**
 * 0045 — الحالات الثلاث المعروفة لـemployees.role ورفض أي شكل غيرها:
 *   12 قيمة بلا moderator (الإنتاج الفعلي) · 13 قيمة (الوسيطة) · 14 قيمة (بعد 0045).
 * من أي «قبل» معروف: إضافة القيم الناقصة في الآخر فقط، والقيم المخزّنة بتفضل زي ما هي.
 */
const col = (columnType: string, over: Partial<RoleColumn> = {}): RoleColumn => ({
  columnType, nullable: false, defaultValue: "agent", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci", comment: "", extra: "", ...over,
});
const LEGACY = [...EMPLOYEE_ROLE_ENUM_LEGACY_WITHOUT_MODERATOR];
const UNKNOWN_TYPES: Record<string, string> = {
  "12 بترتيب مختلف": enumColumnType([LEGACY[1], LEGACY[0], ...LEGACY.slice(2)]),
  "11 قيمة (viewer ناقصة)": enumColumnType(LEGACY.slice(0, 11)),
  "accounts_manager من غير moderator": enumColumnType([...LEGACY, "accounts_manager"]),
  "moderator في النص": enumColumnType([...LEGACY.slice(0, 5), "moderator", ...LEGACY.slice(5)]),
  "قيمة زيادة غير معروفة": enumColumnType([...EMPLOYEE_ROLE_ENUM_AFTER_0045, "x_unknown"]),
  "قيمة بمعنى مختلف بدل viewer": enumColumnType([...LEGACY.slice(0, 11), "auditor"]),
};

describe("👤 0045 — حالات employees.role (بلا قاعدة)", () => {
  it("المواصفة: 12 ⊂ 13 ⊂ 14 كبادئات حرفية (إضافة في الآخر فقط، مفيش حذف ولا إعادة ترتيب)", () => {
    expect(LEGACY).toHaveLength(12);
    expect(LEGACY).not.toContain("moderator");
    expect(EMPLOYEE_ROLE_ENUM_BEFORE_0045.slice(0, 12)).toEqual(LEGACY);
    expect(EMPLOYEE_ROLE_ENUM_BEFORE_0045[12]).toBe("moderator");
    expect(EMPLOYEE_ROLE_ENUM_AFTER_0045.slice(0, 13)).toEqual([...EMPLOYEE_ROLE_ENUM_BEFORE_0045]);
    expect(EMPLOYEE_ROLE_ENUM_AFTER_0045[13]).toBe("accounts_manager");
    expect(EMPLOYEE_ROLE_ENUM_AFTER_0045).toHaveLength(14);
    // الشكل الفعلي المقروء من نسخة الإنتاج المسترجعة حرفيًا
    expect(LEGACY_BEFORE_TYPE).toBe("enum('agent','warehouse','manager','facebook_entry','scanner','super_admin','admin','data_entry','order_confirmation','shipping','accountant','viewer')");
  });

  it("الحكم: 12 و13 = غير مطبَّقة، 14 = مطبَّقة؛ أي شكل تاني = partial", () => {
    expect(evaluateRoleColumn(col(LEGACY_BEFORE_TYPE))).toEqual({ state: "not_applied", issues: [] });
    expect(evaluateRoleColumn(col(BEFORE_TYPE))).toEqual({ state: "not_applied", issues: [] });
    expect(evaluateRoleColumn(col(AFTER_TYPE))).toEqual({ state: "applied", issues: [] });
    for (const [label, t] of Object.entries(UNKNOWN_TYPES)) expect(evaluateRoleColumn(col(t)).state, label).toBe("partial");
    // الخصائص الثابتة لسه بتتفحص حتى مع الشكل المعروف
    expect(evaluateRoleColumn(col(LEGACY_BEFORE_TYPE, { nullable: true })).state).toBe("partial");
    expect(evaluateRoleColumn(col(LEGACY_BEFORE_TYPE, { defaultValue: "viewer" })).state).toBe("partial");
    expect(evaluateRoleColumn(null).state).toBe("partial");
  });
});

const CAN = Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(CAN)("👤 0045 — على MySQL مؤقتة", { timeout: 120_000 }, () => {
  let tmp: TempSchema;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const roleColumn = async () => (await q(`SELECT COLUMN_TYPE t, IS_NULLABLE n, COLUMN_DEFAULT d, CHARACTER_SET_NAME cs, COLLATION_NAME co
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'role'`))[0];
  const setType = (t: string) => q(alterRoleSql(t, { charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" }));
  const run = (mode: "check" | "apply" | "rollback", confirm?: string) =>
    runRoleEnumMigration({ databaseUrl: tmp.url, mode, deployEnv: "test", confirm: confirm ?? (mode === "check" ? null : confirmPhrase("0045", mode, tmp.name)) });

  beforeAll(async () => { tmp = await createTempSchema("role0045"); }, 180_000);
  afterAll(async () => { await tmp?.drop(); }, 120_000);

  it("من 12 (الإنتاج): check → غير مطبَّقة؛ تأكيد غلط = رفض بلا DDL؛ apply → 14 حرفيًا والخصائص زي ما هي والقيم المخزّنة زي ما هي", async () => {
    await q("DELETE FROM employees");
    await setType(LEGACY_BEFORE_TYPE);
    for (const r of LEGACY) await q("INSERT INTO employees (name, role) VALUES (?, ?)", [`e-${r}`, r]);
    const storedBefore = await q("SELECT id, role FROM employees ORDER BY id");
    const before = await roleColumn();

    const c = await run("check");
    expect([c.ok, c.state]).toEqual([true, "not_applied"]);
    expect(c.lines.join("\n")).toContain("12 قيمة بلا moderator");

    const wrong = await run("apply", "APPLY 0045 TO some_other_db");
    expect(wrong.ok).toBe(false);
    expect(wrong.refused).toBeTruthy();
    expect((await roleColumn()).t).toBe(LEGACY_BEFORE_TYPE);

    const a = await run("apply");
    expect([a.ok, a.applied, a.state]).toEqual([true, true, "applied"]);
    const after = await roleColumn();
    expect(after.t).toBe(AFTER_TYPE);
    expect([after.n, after.d, after.cs, after.co]).toEqual([before.n, before.d, before.cs, before.co]);
    expect(await q("SELECT id, role FROM employees ORDER BY id")).toEqual(storedBefore);
    // القيم الجديدة بقت مقبولة فعلًا
    await q("INSERT INTO employees (name, role) VALUES ('m', 'moderator'), ('am', 'accounts_manager')");
    await q("DELETE FROM employees WHERE name IN ('m','am')");
  });

  it("إعادة التشغيل idempotent: apply تاني = replay بلا أي تغيير، وcheck = مطبَّقة", async () => {
    const before = await roleColumn();
    const again = await run("apply");
    expect([again.ok, again.replay, again.applied]).toEqual([true, true, false]);
    expect(await roleColumn()).toEqual(before);
    const c = await run("check");
    expect([c.ok, c.state]).toEqual([true, "applied"]);
  });

  it("rollback → 13 (بيشيل accounts_manager بس، moderator بيفضل)؛ ومن 13 (الوسيطة) apply → 14؛ والتراجع مرفوض لو الدور مستخدم", async () => {
    const rb = await run("rollback");
    expect([rb.ok, rb.state]).toEqual([true, "not_applied"]);
    expect((await roleColumn()).t).toBe(BEFORE_TYPE);
    const c13 = await run("check");
    expect([c13.ok, c13.state]).toEqual([true, "not_applied"]);
    const a = await run("apply");
    expect([a.ok, a.applied]).toEqual([true, true]);
    expect((await roleColumn()).t).toBe(AFTER_TYPE);
    await q("INSERT INTO employees (name, role) VALUES ('am-in-use', 'accounts_manager')");
    const blocked = await run("rollback");
    expect([blocked.ok, blocked.refused]).toEqual([false, "role_in_use"]);
    expect((await roleColumn()).t).toBe(AFTER_TYPE);
    await q("DELETE FROM employees WHERE name = 'am-in-use'");
  });

  it("أي شكل غير معروف: check = partial، وapply/rollback مرفوضين بلا أي DDL", async () => {
    await q("DELETE FROM employees");
    for (const [label, t] of Object.entries(UNKNOWN_TYPES)) {
      await setType(t);
      const c = await run("check");
      expect([c.ok, c.state], label).toEqual([false, "partial"]);
      const a = await run("apply");
      expect([a.ok, a.refused], label).toEqual([false, "partial"]);
      const r = await run("rollback");
      expect([r.ok, r.refused], label).toEqual([false, "partial"]);
      expect((await roleColumn()).t, label).toBe(t);
    }
    await setType(BEFORE_TYPE);
  });
});
