-- ════════════════════════════════════════════════════════════════════════════
-- مقترح — مش متولّد بـdrizzle-kit ومش متنفّذ ومش في journal الهجرات.
-- مكانه drizzle/proposed/ عن قصد عشان `drizzle-kit migrate` ماياخدوش.
-- ════════════════════════════════════════════════════════════════════════════
--
-- ده أقل تغيير في السكيمة يخلّي المطلوب في المواصفة يشتغل بالكامل. كل اللي ينفع
-- يتعمل من غير سكيمة اتعمل خلاص (الجسر، الإلغاء بحركة عكسية، البنود المتعددة،
-- الخصم والتكلفة الإضافية بالحساب، الدفتر اليومي بحقايقه المنفصلة).
--
-- اللي لسه محتاج أعمدة:
--   1. المورد ككيان له معرّف — دلوقتي `supplierName` نص حر، فـ«أحمد الجملة»
--      و«احمد الجمله» موردين مختلفين ومفيش رصيد مورد ممكن يتحسب.
--   2. بيانات الفاتورة (رقمها وتاريخها) — دلوقتي بتتحشر في `reference` و`reason`.
--   3. المدفوع الفعلي — `paymentStatus` بيقول «مدفوع/مش مدفوع» وبس، فالدفع الجزئي
--      مالوش مكان يتخزّن فيه، وده اللي مانع تسجيل مدفوعات الموردين أصلاً.
--   4. تفصيلة الخصم والتكلفة الإضافية على البند — بتتحسب دلوقتي وبتتحوّل لتكلفة
--      وحدة نهائية، فالإجمالي مضبوط لكن التفصيلة بتضيع.
--
-- كله إضافي: مفيش عمود بيتشال، مفيش صف بيتغيّر، ومفيش قيد بيتشدّد على بيانات
-- موجودة. الأعمدة الجديدة كلها NULL أو ليها DEFAULT، فالكود الحالي بيفضل شغّال
-- من غير سطر تعديل.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. الموردون ──────────────────────────────────────────────────────────────
CREATE TABLE `suppliers` (
  `id`         int AUTO_INCREMENT NOT NULL,
  `businessId` int NOT NULL,
  `name`       varchar(160) NOT NULL,
  `phone`      varchar(30),
  `notes`      text,
  `isActive`   boolean NOT NULL DEFAULT true,
  `createdAt`  timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`  timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `suppliers_id` PRIMARY KEY(`id`),
  CONSTRAINT `suppliers_business_name_unique` UNIQUE(`businessId`, `name`)
);

CREATE INDEX `suppliers_business_active_idx` ON `suppliers` (`businessId`, `isActive`);


-- ── 2. رأس إذن الاستلام ──────────────────────────────────────────────────────
-- supplierId بيفضل NULL للأذون القديمة. supplierName بيتساب مكانه عن قصد: هو
-- سجل تاريخي لاسم المورد وقت الاستلام، ومسحه يخلّي أذون النهاردة بتقرا اسم
-- اتغيّر بكرة. الكود الجديد يكتب الاتنين والقراءة تفضّل supplierId.
ALTER TABLE `purchase_receipts` ADD COLUMN `supplierId`       int;
ALTER TABLE `purchase_receipts` ADD COLUMN `invoiceNumber`    varchar(100);
ALTER TABLE `purchase_receipts` ADD COLUMN `invoiceDate`      timestamp;
ALTER TABLE `purchase_receipts` ADD COLUMN `paidAmount`       decimal(18,4) NOT NULL DEFAULT '0';
ALTER TABLE `purchase_receipts` ADD COLUMN `headerDiscount`   decimal(18,4) NOT NULL DEFAULT '0';
ALTER TABLE `purchase_receipts` ADD COLUMN `shippingCost`     decimal(18,4) NOT NULL DEFAULT '0';
ALTER TABLE `purchase_receipts` ADD COLUMN `notes`            text;

CREATE INDEX `purchase_receipts_supplier_idx`
  ON `purchase_receipts` (`businessId`, `supplierId`, `status`);


-- ── 3. بنود إذن الاستلام ─────────────────────────────────────────────────────
-- unitCost الموجود هو التكلفة **النهائية** اللي دخلت المخزون — مايتغيّرش معناه،
-- لأن قيمة المخزون المرحّلة مبنية عليه. التلاتة الجداد بيسجّلوا من إيه اتكوّنت.
ALTER TABLE `purchase_receipt_items` ADD COLUMN `grossUnitCost` decimal(18,4);
ALTER TABLE `purchase_receipt_items` ADD COLUMN `discount`      decimal(18,4) NOT NULL DEFAULT '0';
ALTER TABLE `purchase_receipt_items` ADD COLUMN `extraCost`     decimal(18,4) NOT NULL DEFAULT '0';


-- ── 4. مدفوعات الموردين ──────────────────────────────────────────────────────
-- الجدول ده هو اللي مخلّي «مدفوعات موردين» في الدفتر اليومي ترجع رقم بدل NULL.
-- مبني على نفس شكل expense_payments عن قصد: الدفع بيترحّل على financial_accounts
-- عن طريق نفس محرك القيود، والصف ده هو الربط بين الفاتورة والقيد.
CREATE TABLE `supplier_payments` (
  `id`                    int AUTO_INCREMENT NOT NULL,
  `businessId`            int NOT NULL,
  `supplierId`            int,
  `purchaseReceiptId`     int NOT NULL,
  `financialTransactionId` int,
  `accountId`             int NOT NULL,
  `amount`                decimal(18,4) NOT NULL,
  `paidAt`                timestamp NOT NULL,
  `evidenceUrl`           varchar(500),
  `notes`                 text,
  `createdBy`             int NOT NULL,
  `createdByName`         varchar(100) NOT NULL,
  `createdAt`             timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `supplier_payments_id` PRIMARY KEY(`id`)
);

CREATE INDEX `supplier_payments_receipt_idx` ON `supplier_payments` (`purchaseReceiptId`);
CREATE INDEX `supplier_payments_paid_idx`    ON `supplier_payments` (`businessId`, `paidAt`);


-- ════════════════════════════════════════════════════════════════════════════
-- الرجوع
-- ════════════════════════════════════════════════════════════════════════════
-- الترتيب معكوس، وكله آمن طالما مفيش كود جديد كتب فيه:
--
--   DROP TABLE `supplier_payments`;
--   ALTER TABLE `purchase_receipt_items` DROP COLUMN `extraCost`, DROP COLUMN `discount`, DROP COLUMN `grossUnitCost`;
--   DROP INDEX `purchase_receipts_supplier_idx` ON `purchase_receipts`;
--   ALTER TABLE `purchase_receipts` DROP COLUMN `notes`, DROP COLUMN `shippingCost`,
--     DROP COLUMN `headerDiscount`, DROP COLUMN `paidAmount`,
--     DROP COLUMN `invoiceDate`, DROP COLUMN `invoiceNumber`, DROP COLUMN `supplierId`;
--   DROP TABLE `suppliers`;
--
-- لو كانت اتسجّلت مدفوعات موردين فعلًا، الرجوع بيمسحها — وساعتها الاسترجاع من
-- الـBackup هو المسار الوحيد الآمن.
-- ════════════════════════════════════════════════════════════════════════════
