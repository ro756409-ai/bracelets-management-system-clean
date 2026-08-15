import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس الاستدامة: إنشاء موظف جديد **مايرجعش businessId=NULL** أبدًا — عشان مايتكررش
 * السبب الجذري اللي كسر العزل (22 موظف businessId فاضي). الاختبار بيقفل على إن كل
 * مسارات إنشاء الموظف بتعدّي على `resolveEmployeeBusinessId` (اللي بترجّع رقم دايمًا).
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");

describe("🔑 استدامة: إنشاء موظف بنشاط دايمًا", () => {
  it("🔑 resolveEmployeeBusinessId موجود ومايرجعش undefined/null", () => {
    expect(routers).toContain("async function resolveEmployeeBusinessId(");
    expect(routers).toContain("): Promise<number> {"); // رقم، مش number|undefined
  });

  it("🔑 المسارين بيستخدموا الـhelper مش businessId الخام", () => {
    const matches =
      routers.match(/resolveEmployeeBusinessId\(/g) ?? [];
    // مرة في التعريف + مرتين استخدام = 3 على الأقل.
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("🔑 مفيش createEmployee بياخد businessId خام ممكن يكون undefined", () => {
    // الأنماط القديمة الخطيرة اللي كانت بتسيب null:
    expect(routers).not.toContain("businessId: emp.businessId ?? undefined,\n          tenantId,");
    expect(routers).not.toMatch(
      /const businessId = await scopeBusinessId\(\s*ctx\.tenantId,\s*input\.businessId\s*\);\s*await createEmployee/
    );
  });

  it("🔑 متعدد الأنشطة لازم يتحدّد النشاط (مايخمّنش)", () => {
    expect(routers).toContain("حدّد النشاط اللي هيتبعله الموظف");
  });
});
