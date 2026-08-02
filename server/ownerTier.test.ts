import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  OWNER_ROLES,
  isOwnerRole,
  isAdminTierRole,
  ADMIN_TIER_ROLES,
  EMPLOYEE_ROLE_VALUES,
} from "./permissions";

/**
 * طبقة المالك.
 *
 * الحارس القديم كان `if (ctx.employee) throw` — بنيّة إنه يرفض الموظفين ويسمح
 * للمالك. لكن كل مسارات createContext() بتحطّ صف موظف، مسار /login نفسه ضمنها،
 * فالشرط كان بيتحقق دايمًا والإجراءات الخطيرة كانت مقفولة على الجميع بلا استثناء.
 *
 * الاختبارات دي بتثبّت السلوك الجديد: طبقة المالك دور حقيقي، أضيق من طبقة الإدارة،
 * والحارس بيتفحّص على مصدر routers.ts لأن تشغيله محتاج قاعدة بيانات مش موجودة
 * في الساندبوكس — والاختبار بيقول ده صراحة بدل ما يدّعي تغطية أعمق.
 */

describe("طبقة المالك", () => {
  it("المالك = super_admin وبس", () => {
    expect([...OWNER_ROLES]).toEqual(["super_admin"]);
    expect(isOwnerRole("super_admin")).toBe(true);
  });

  it("🔑 المدير مش مالك — الفرق بين الطبقتين هو كل الغرض", () => {
    expect(isAdminTierRole("manager")).toBe(true);
    expect(isOwnerRole("manager")).toBe(false);
    expect(isOwnerRole("admin")).toBe(false);
  });

  it("طبقة المالك جزء من طبقة الإدارة — المالك بيقدر يعمل كل حاجة إدارية", () => {
    for (const role of OWNER_ROLES) {
      expect(ADMIN_TIER_ROLES).toContain(role);
    }
  });

  it("مفيش دور غير إداري بيعدّي كمالك", () => {
    const nonAdmin = EMPLOYEE_ROLE_VALUES.filter(r => !isAdminTierRole(r));
    for (const role of nonAdmin) {
      expect(isOwnerRole(role)).toBe(false);
    }
  });

  it("قيم فاضية مش مالك", () => {
    expect(isOwnerRole(null)).toBe(false);
    expect(isOwnerRole(undefined)).toBe(false);
    expect(isOwnerRole("")).toBe(false);
    expect(isOwnerRole("owner")).toBe(false); // مش قيمة في الـenum
  });
});

describe("حارس ownerProcedure", () => {
  const routers = fs.readFileSync("server/routers.ts", "utf-8");
  const compact = routers.replace(/\s+/g, " ");

  it("🔑 الحارس بقى على الدور مش على وجود صف موظف", () => {
    expect(compact).toContain(
      "const ownerProcedure = adminProcedure.use(({ ctx, next }) => { if (!isOwnerRole(ctx.employee?.role))"
    );
  });

  it("الشرط القديم المستحيل اتشال", () => {
    const guard = routers.slice(
      routers.indexOf("const ownerProcedure"),
      routers.indexOf("const ownerProcedure") + 400
    );
    expect(guard).not.toContain("if (ctx.employee) {");
  });

  it("الحارس مبني فوق adminProcedure — مش بديل عنه", () => {
    expect(routers).toContain("const ownerProcedure = adminProcedure.use(");
  });
});

describe("منح دور المالك", () => {
  const routers = fs.readFileSync("server/routers.ts", "utf-8");
  const compact = routers.replace(/\s+/g, " ");

  it("🔑 المالك وحده بيمنح أو يسحب دور المالك", () => {
    expect(compact).toContain(
      'message: "صلاحية المالك لا يمنحها أو يسحبها إلا المالك"'
    );
    expect(compact).toContain("if (isOwnerRole(ctx.employee?.role)) return;");
  });

  it("🔑 استثناء التأسيس — أول مالك ممكن يتعمل وقت ما مفيش مالك", () => {
    expect(compact).toContain(
      "if (grants && (await countActiveOwnerEmployees()) === 0) return;"
    );
  });

  it("السحب بيتفحص كمان مش المنح بس", () => {
    expect(compact).toContain("isOwnerRole(currentRole)");
  });

  it("الحارس متركّب على الإنشاء والتعديل الاتنين", () => {
    expect(compact).toContain(
      "await assertMayAssignOwnerRole(ctx, input.role, null)"
    );
    expect(compact).toContain(
      "await assertMayAssignOwnerRole(ctx, data.role, target.role)"
    );
  });
});

describe("واجهة الموظفين", () => {
  const page = fs.readFileSync("client/src/pages/Employees.tsx", "utf-8");

  it("🔑 الدور ظاهر للتاجر باسم «المالك» مش باسم الـenum", () => {
    expect(page).toContain('super_admin: "المالك (كل الصلاحيات)"');
  });

  it("كل أدوار الـenum ليها ترجمة — مافيش دور بيظهر بالإنجليزي", () => {
    for (const role of EMPLOYEE_ROLE_VALUES) {
      expect(page).toMatch(new RegExp(`${role}: "`));
    }
  });
});
