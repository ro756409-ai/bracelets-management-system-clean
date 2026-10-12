-- 0049 — الموردون والورشة في Ledger V3 (المرحلة 6). DELTA مكتوبة بخط اليد، ADDITIVE بحت: أربعة جداول جديدة، بلا Backfill ولا Seed،
-- ولا تعديل على purchase_receipts أو أي جدول قائم. الاسم ledger_suppliers وليس suppliers عمدًا: ملف 0034 القديم (غير المطبّق)
-- يحجز الاسم suppliers. يتطلب 0040 والفهرسين المركّبين.
--   • ledger_suppliers: هوية مورد ثابتة بكود لكل شركة (لا ربط بالاسم)، والاسم فريد لكل شركة لمنع التكرار؛ الورشة مورد isWorkshop.
--   • ledger_supplier_documents: فاتورة/دفعة/دفعة مقدمة/تخصيص مقدم/إشعار مرتجع، رقم مستند فريد لكل مورد ونوع، وقيد دفتر
--     إلزامي (tenantId, transactionId). receiptInvoiceId مولّد = إيصال الاستلام للفاتورة فقط ⇒ الإيصال مربوط بفاتورة واحدة.
--     purchaseReceiptId بلا FK (جدول purchase_receipts بلا Migration في المستودع).
--   • ledger_workshop_batches / ledger_workshop_events: عهدة خامات لدى الورشة بالكمية والقيمة، استلام جزئي، عجز، تصليح، وأجر
--     قطعة؛ المُستلم + العجز لا يتجاوز المُرسل (CHECK)، وكل حدث بمفتاح عملية فريد.
-- CHECK: كل تعبير بلا UNKNOWN. يتطلب MySQL ≥ 8.0.16. لا يُشغَّل إلا عبر scripts/migrate-0049-ledger-suppliers، وفي هذه المرحلة
-- على Docker محلي مؤقت فقط.

CREATE TABLE `ledger_suppliers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`code` varchar(40) NOT NULL,
	`name` varchar(160) NOT NULL,
	`phone` varchar(30) NULL,
	`isWorkshop` tinyint(1) NOT NULL DEFAULT 0,
	`isActive` tinyint(1) NOT NULL DEFAULT 1,
	`createdByEmployeeId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_suppliers_id` PRIMARY KEY(`id`),
	CONSTRAINT `lsu_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `lsu_tenant_code_unique` UNIQUE(`tenantId`,`code`),
	CONSTRAINT `lsu_tenant_name_unique` UNIQUE(`tenantId`,`name`),
	CONSTRAINT `fk_lsu_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lsu_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_lsu_code` CHECK (REGEXP_LIKE(`code`, '^[A-Z0-9_-]{2,40}$', 'c')),
	CONSTRAINT `chk_lsu_name` CHECK (CHAR_LENGTH(TRIM(`name`)) >= 2),
	CONSTRAINT `chk_lsu_flags` CHECK (`isWorkshop` IN (0,1) AND `isActive` IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `ledger_supplier_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`supplierId` int NOT NULL,
	`businessId` int NULL,
	`docType` enum('invoice','payment','advance','advance_application','return_credit') NOT NULL,
	`docNo` varchar(80) NOT NULL,
	`docDate` date NOT NULL,
	`dueDate` date NULL,
	`amount` decimal(18,4) NOT NULL,
	`purchaseReceiptId` int NULL,
	`receiptInvoiceId` int GENERATED ALWAYS AS (CASE WHEN `docType` = 'invoice' THEN `purchaseReceiptId` END) STORED,
	`appliesToDocumentId` int NULL,
	`transactionId` int NOT NULL,
	`reversalTransactionId` int NULL,
	`createdByEmployeeId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_supplier_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `lsd_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `lsd_tenant_supplier_doc_unique` UNIQUE(`tenantId`,`supplierId`,`docType`,`docNo`),
	CONSTRAINT `lsd_tenant_receipt_invoice_unique` UNIQUE(`tenantId`,`receiptInvoiceId`),
	CONSTRAINT `lsd_tenant_transaction_unique` UNIQUE(`tenantId`,`transactionId`),
	INDEX `lsd_tenant_supplier_date` (`tenantId`,`supplierId`,`docDate`),
	CONSTRAINT `fk_lsd_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lsd_tenant_supplier` FOREIGN KEY (`tenantId`,`supplierId`) REFERENCES `ledger_suppliers`(`tenantId`,`id`),
	CONSTRAINT `fk_lsd_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_lsd_tenant_applies` FOREIGN KEY (`tenantId`,`appliesToDocumentId`) REFERENCES `ledger_supplier_documents`(`tenantId`,`id`),
	CONSTRAINT `fk_lsd_tenant_transaction` FOREIGN KEY (`tenantId`,`transactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_lsd_tenant_reversal` FOREIGN KEY (`tenantId`,`reversalTransactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_lsd_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_lsd_amount` CHECK (`amount` > 0),
	CONSTRAINT `chk_lsd_docno` CHECK (CHAR_LENGTH(TRIM(`docNo`)) >= 1),
	CONSTRAINT `chk_lsd_due` CHECK (`dueDate` IS NULL OR `dueDate` >= `docDate`),
	CONSTRAINT `chk_lsd_applies` CHECK ((`docType` = 'advance_application' AND `appliesToDocumentId` IS NOT NULL) OR (`docType` <> 'advance_application'))
);
--> statement-breakpoint
CREATE TABLE `ledger_workshop_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`supplierId` int NOT NULL,
	`businessId` int NOT NULL,
	`reference` varchar(80) NOT NULL,
	`status` enum('open','partially_received','closed') NOT NULL DEFAULT 'open',
	`sentQuantity` int NOT NULL DEFAULT 0,
	`sentValue` decimal(18,4) NOT NULL DEFAULT 0,
	`receivedQuantity` int NOT NULL DEFAULT 0,
	`receivedValue` decimal(18,4) NOT NULL DEFAULT 0,
	`shortageQuantity` int NOT NULL DEFAULT 0,
	`shortageValue` decimal(18,4) NOT NULL DEFAULT 0,
	`pieceWage` decimal(18,4) NOT NULL DEFAULT 0,
	`createdByEmployeeId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_workshop_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `lwb_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `lwb_tenant_reference_unique` UNIQUE(`tenantId`,`reference`),
	CONSTRAINT `fk_lwb_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lwb_tenant_supplier` FOREIGN KEY (`tenantId`,`supplierId`) REFERENCES `ledger_suppliers`(`tenantId`,`id`),
	CONSTRAINT `fk_lwb_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_lwb_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_lwb_quantities` CHECK (`sentQuantity` >= 0 AND `receivedQuantity` >= 0 AND `shortageQuantity` >= 0 AND `receivedQuantity` + `shortageQuantity` <= `sentQuantity`),
	CONSTRAINT `chk_lwb_values` CHECK (`sentValue` >= 0 AND `receivedValue` >= 0 AND `shortageValue` >= 0 AND `pieceWage` >= 0 AND `receivedValue` + `shortageValue` <= `sentValue`),
	CONSTRAINT `chk_lwb_reference` CHECK (CHAR_LENGTH(TRIM(`reference`)) >= 2)
);
--> statement-breakpoint
CREATE TABLE `ledger_workshop_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`batchId` int NOT NULL,
	`eventType` enum('send','receive','shortage','repair_cost','wage') NOT NULL,
	`quantity` int NOT NULL DEFAULT 0,
	`value` decimal(18,4) NOT NULL DEFAULT 0,
	`transactionId` int NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`actorEmployeeId` int NOT NULL,
	`note` varchar(500) NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_workshop_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `lwe_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	INDEX `lwe_tenant_batch_created` (`tenantId`,`batchId`,`createdAt`),
	CONSTRAINT `fk_lwe_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lwe_tenant_batch` FOREIGN KEY (`tenantId`,`batchId`) REFERENCES `ledger_workshop_batches`(`tenantId`,`id`),
	CONSTRAINT `fk_lwe_tenant_transaction` FOREIGN KEY (`tenantId`,`transactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_lwe_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_lwe_values` CHECK (`quantity` >= 0 AND `value` >= 0 AND (`quantity` > 0 OR `value` > 0)),
	CONSTRAINT `chk_lwe_key` CHECK (REGEXP_LIKE(`idempotencyKey`, '^[A-Za-z0-9_:#.-]{8,191}$', 'c'))
);
