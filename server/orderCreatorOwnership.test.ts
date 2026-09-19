import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * ملكية أوردرات موظف الإدخال عبر حقل ثابت `orders.createdByEmployeeId` — **مؤجَّلة** مع
 * Migration 0036 (لسه مش مطبّق على الإنتاج). حادثة الإنتاج: إضافة العمود لـschema قبل تطبيق
 * الـmigration خلّت drizzle يعمل SELECT لعمود مش موجود في القاعدة → كل استعلامات الأوردرات
 * فشلت واختفت أوردرات كل الأنشطة. لحد ما يتطبّق 0036، العمود **مش** في schema والملكية
 * مؤقتًا عبر lastUpdatedBy (العزل الأساسي بالنشاط عبر requireOwned ثابت).
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");

describe("🔑 عمود المُنشئ الثابت مؤجَّل بأمان (منع حادثة العمود الوهمي)", () => {
  it("🔒 schema مايحطّش createdByEmployeeId قبل تطبيق الـmigration", () => {
    // لو رجع العمود لـschema من غير ما الـmigration يتطبّق، drizzle هيكسر كل استعلامات
    // الأوردرات على الإنتاج. الحارس ده بيمنع تكرار الحادثة.
    expect(schema).not.toContain('int("createdByEmployeeId")');
  });
  it("🔒 مفيش استعلام أوردرات بيفلتر بعمود createdByEmployeeId (لحد الـmigration)", () => {
    expect(routers).not.toContain("orders.createdByEmployeeId");
  });
  it("🔑 Migration 0036 جاهز (additive: عمود + index، بلا FK/backfill) — للنشر الصحيح لاحقًا", () => {
    const migration = fs.readFileSync("drizzle/0036_orders_created_by_employee.sql", "utf-8");
    expect(migration).toContain("ADD COLUMN `createdByEmployeeId` int");
    expect(migration).toContain("CREATE INDEX `orders_created_by_employee_idx`");
    expect(migration).not.toContain("FOREIGN KEY");
    expect(migration).not.toContain("UPDATE `orders`");
  });
  it("🔑 ملكية إدخال البيانات مؤقتًا عبر lastUpdatedBy + العزل بالنشاط ثابت", () => {
    // العزل الأساسي (requireOwned/businessId) هو اللي بيمنع التسريب — مش تغيّر بالحادثة.
    expect(routers).toContain("eq(orders.lastUpdatedBy, ctx.employee.id)");
  });
});
