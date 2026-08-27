import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس العزل للتحويلات بالجملة على الأوردرات (Phase D — P0).
 *
 * `convertNoAnswerToNew` و`convertPostponedToNew` كانوا بيعملوا `UPDATE orders` خام
 * من غير أي فلتر `businessId`، فأدمن شركة كان بيقلب حالة أوردرات **كل** الشركات.
 * الاختبار ده بيقفل على إن الاتنين بيتقيّدوا بأنشطة الـtenant عبر `scopeBusinessIds`
 * و`inArray(ordersTable.businessId, ...)`، ومفيش رجوع للـSQL الخام غير المُنطَّق.
 *
 * حارس نصّي عن قصد: طبقة الـmock في tenantIsolation.test.ts بتنمذج تعديل الصف الواحد
 * بالمعرّف، مش تحديث حالة بالجملة — فالتحقق البنيوي هنا أوثق من سلوك ناقص.
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");

function endpointBlock(name: string): string {
  const start = routers.indexOf(`${name}: adminProcedure`);
  if (start < 0) throw new Error(`مالقيتش ${name}`);
  // لحد بداية الإجراء اللي بعده.
  const rest = routers.slice(start + name.length);
  const next = rest.search(/\n {4}[a-zA-Z]+: (admin|protected|owner|permission|manager)/);
  return rest.slice(0, next < 0 ? 2000 : next);
}

describe("🔑 P0 · التحويل بالجملة للأوردرات متقيّد بالـtenant", () => {
  for (const name of ["convertNoAnswerToNew", "convertPostponedToNew"]) {
    describe(name, () => {
      const block = endpointBlock(name);

      it("🔑 بيجيب نطاق الأنشطة عبر scopeBusinessIds", () => {
        // P0: النطاق بقى session-scoped (بيمرّر ctx) — بيقيّد الموظف بنشاطه.
        expect(block).toContain("scopeBusinessIds(ctx)");
      });

      it("🔑 بيفلتر التحديث بـinArray على businessId", () => {
        expect(block).toContain("inArray(ordersTable.businessId, scoped)");
      });

      it("🔑 مفيش UPDATE orders خام من غير فلتر", () => {
        expect(block).not.toMatch(/sql`UPDATE orders SET/);
      });
    });
  }
});
