-- ============================================================================
-- إعادة تنظيم الصلاحيات/الحسابات/المرتبات — مايجريشن يدوي (additive فقط)
-- ============================================================================
-- شغّل ده على البرودكشن قبل ما الكود ينزل. الاتنين إضافيين وآمنين على الداتا الموجودة:
--   • مفيش عمود بيتحذف أو يتغيّر اسمه.
--   • القيمة الجديدة في الـenum مابتأثرش على أي صف موجود.
--   • الجدول الجديد فاضي وقت الإنشاء.
--
-- ملاحظة: اخترنا مسار ALTER اليدوي لأن drizzle-kit generate عنده snapshot drift
-- (بيحاول يعيد إنشاء ~30 جدول). لا تشغّل db:push — طبّق الـSQL ده بإيدك.
-- ============================================================================

-- 1) دور «مودريتور» — إضافة قيمة جديدة لـenum الأدوار (باقي القيم زي ما هي).
ALTER TABLE `employees`
  MODIFY COLUMN `role` ENUM(
    'agent','warehouse','manager','facebook_entry','scanner',
    'super_admin','admin','data_entry','order_confirmation','shipping',
    'accountant','viewer','moderator'
  ) NOT NULL DEFAULT 'agent';

-- 2) جدول بونص الموظف — سجل بسيط بيتضاف لصافي المرتب (موازي لـemployee_advances).
CREATE TABLE IF NOT EXISTS `employee_bonuses` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `businessId`    INT NOT NULL,
  `employeeId`    INT NOT NULL,
  `employeeName`  VARCHAR(100) NOT NULL,
  `amount`        DECIMAL(10,2) NOT NULL,
  `bonusDate`     TIMESTAMP NOT NULL,
  `reason`        TEXT NULL,
  `createdBy`     INT NOT NULL,
  `createdByName` VARCHAR(100) NOT NULL,
  `createdAt`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `employee_bonuses_business_idx` (`businessId`),
  INDEX `employee_bonuses_employee_idx` (`employeeId`)
);
