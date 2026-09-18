-- 0036 — عمود مُنشئ الأوردر الثابت (DELTA ONLY، مكتوب بخط اليد، ADDITIVE)
--
-- ليه بخط اليد: snapshots الـmeta قديمة ومش متزامنة مع schema.ts (نفس سبب 0035)، فـ
-- `drizzle-kit generate` بيطلّع فرقًا ملوّثًا. الملف ده دلتا واحدة بس.
--
-- الغرض: `orders.createdByEmployeeId` — مُنشئ الأوردر الثابت، بيتحدّد مرة واحدة عند الإنشاء
-- اليدوي من موظف الإدخال ومابيتغيّرش. بديل موثوق لعمود «آخر من عدّل» المتغيّر في إثبات ملكية
-- موظف الإدخال لأوردراته (myOrders/updateOrder/deleteOrder).
--
-- additive بحت وآمن:
--   * عمود nullable — الأوردرات القديمة تفضل NULL (مفيش backfill تخميني). أوردر قديم NULL =
--     موظف الإدخال مايقدرش يعدّله/يحذفه؛ المالك/الدور الإداري بيتعامل معاه من مسارات الأدمن.
--   * index للأداء (myOrders بيفلتر بالعمود ده + businessId).
--   * بلا مفتاح خارجي (FK) — مطابق لنمط الأعمدة المشابهة (بلا FK في كل الـschema)، فمفيش
--     مخاطرة engine أو حذف صفوف موظفين.
--
-- Preflight (لازم صفر تعارض):
--   * العمود مش موجود:   SHOW COLUMNS FROM `orders` LIKE 'createdByEmployeeId';   (صفر صفوف)
--   * الـindex مش موجود: SHOW INDEX FROM `orders` WHERE Key_name = 'orders_created_by_employee_idx';  (صفر صفوف)
--
-- ترتيب التطبيق الآمن: matjarak_test أولًا (تحقّق + شغّل اختبارات DB)، وبعد التأكيد Production.
-- Rollback (لو لزم، بلا فقد بيانات تشغيلية غير هذا العمود الجديد):
--   DROP INDEX `orders_created_by_employee_idx` ON `orders`;
--   ALTER TABLE `orders` DROP COLUMN `createdByEmployeeId`;

ALTER TABLE `orders` ADD COLUMN `createdByEmployeeId` int;
--> statement-breakpoint
CREATE INDEX `orders_created_by_employee_idx` ON `orders` (`createdByEmployeeId`);
