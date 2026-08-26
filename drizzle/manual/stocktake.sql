-- ============================================================================
-- الجرد (P2-C.1) — جدولين جديدين فقط (additive بالكامل)
-- ============================================================================
-- شغّل ده على قاعدة التطبيق (default) قبل ما الكود ينزل. آمن تمامًا:
--   • جدولين جديدين فاضيين — صفر تعديل على أي جدول موجود.
--   • مفيش أي حركة مخزون أو قيد محاسبي هنا (الاعتماد في P2-C.2).
-- ملاحظة: نفّذه بإيدك (drizzle-kit generate عنده snapshot drift) — لا تشغّل db:push.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `stocktakes` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `businessId`     INT NOT NULL,
  `warehouseId`    INT NOT NULL,
  `status`         ENUM('draft','pending_approval','approved','cancelled') NOT NULL DEFAULT 'draft',
  `reference`      VARCHAR(100) NULL,
  `notes`          TEXT NULL,
  `createdBy`      INT NOT NULL,
  `createdByName`  VARCHAR(100) NOT NULL,
  `submittedAt`    TIMESTAMP NULL,
  `approvedBy`     INT NULL,
  `approvedByName` VARCHAR(100) NULL,
  `approvedAt`     TIMESTAMP NULL,
  `cancelledBy`    INT NULL,
  `cancelReason`   TEXT NULL,
  `businessEventId` INT NULL,
  `createdAt`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `stocktakes_business_idx` (`businessId`)
);

CREATE TABLE IF NOT EXISTS `stocktake_lines` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `stocktakeId`        INT NOT NULL,
  `businessId`         INT NOT NULL,
  `warehouseId`        INT NOT NULL,
  `productId`          INT NOT NULL,
  `variantId`          INT NULL,
  `inventoryKey`       VARCHAR(100) NOT NULL,
  `systemQuantity`     INT NOT NULL,
  `countedQuantity`    INT NOT NULL,
  `differenceQuantity` INT NOT NULL DEFAULT 0,
  `unitCostSnapshot`   DECIMAL(18,4) NOT NULL DEFAULT 0,
  `differenceValue`    DECIMAL(18,4) NOT NULL DEFAULT 0,
  `createdAt`          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `stocktake_lines_stocktake_idx` (`stocktakeId`),
  INDEX `stocktake_lines_business_idx` (`businessId`)
);
