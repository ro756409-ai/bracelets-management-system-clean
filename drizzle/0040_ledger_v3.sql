-- Accounting Ledger V3 — DELTA مكتوبة بخط اليد، ADDITIVE بحت: فهرسان فريدان مركّبان على جدولين
-- قديمين (بلا تغيير أعمدة أو بيانات) + 7 جداول جديدة. غير مضافة إلى drizzle journal.
--
-- عزل الـtenant مفروض بالـFK المركّب في **كل** علاقة:
--   • الحساب/الحركة/القيد/العكس: (tenantId, …) → ledger_*(tenantId, id)
--   • النشاط: (tenantId, businessId) → businesses(tenantId, id)   ← يتطلب UNIQUE businesses_tenant_id
--   • الفاعل: (tenantId, actorEmployeeId) → employees(tenantId, id) ← يتطلب UNIQUE employees_tenant_id
--   فصف يدّعي tenantId=A ويشير إلى نشاط/موظف/حساب تابع لـB يُرفض في DB نفسها (مُختبَر بالحالات الدقيقة).
--
-- ما لا يفرضه الـDB (تحقق fail-closed في خدمة V3 مع اختبار): actorType='employee' يتطلب
--   actorEmployeeId، وactorType IN ('system','webhook') يتطلب actorEmployeeId IS NULL.
--
-- Preflight (قراءة فقط): scripts/verify-ledger-v3.ts --preflight — يشترط: لا جداول ledger_*،
--   لا businesses.tenantId NULL، لا employees.tenantId NULL، لا أنشطة/موظفين يتيمين، foreign_key_checks=1.
-- التشغيل اليدوي (بعد backup وبعد Staging): mysql -u"$MYSQL_USER" -p <db> < drizzle/0040_ledger_v3.sql
-- إعادة التشغيل بالخطأ تفشل على أول عبارة (الفهرس موجود) بلا أي تغيير جزئي.
-- Rollback قبل أي استخدام فعلي: أسفل الملف (معلّق) — الجداول السبعة بالترتيب العكسي ثم الفهرسان.

ALTER TABLE `businesses` ADD UNIQUE INDEX `businesses_tenant_id` (`tenantId`,`id`);
--> statement-breakpoint
ALTER TABLE `employees` ADD UNIQUE INDEX `employees_tenant_id` (`tenantId`,`id`);
--> statement-breakpoint
CREATE TABLE `ledger_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`code` varchar(50) NOT NULL,
	`name` varchar(120) NOT NULL,
	`kind` enum('cash','bank','wallet','carrier_receivable','employee_receivable','supplier_payable','customer_advance','owner_current','revenue','expense','cogs','inventory','equity','suspense') NOT NULL,
	`normalSide` enum('debit','credit') NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'EGP',
	`currentBalance` decimal(18,4) NOT NULL DEFAULT 0,
	`allowNegative` tinyint(1) NOT NULL DEFAULT 0,
	`isActive` tinyint(1) NOT NULL DEFAULT 1,
	`actorType` enum('employee','system','webhook') NOT NULL,
	`actorEmployeeId` int NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledger_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `ledger_accounts_tenant_code_unique` UNIQUE(`tenantId`,`code`),
	CONSTRAINT `ledger_accounts_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `fk_ledger_accounts_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ledger_accounts_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`)
);
--> statement-breakpoint
CREATE TABLE `ledger_account_businesses` (
	`tenantId` int NOT NULL,
	`accountId` int NOT NULL,
	`businessId` int NOT NULL,
	`canPost` tinyint(1) NOT NULL DEFAULT 1,
	`actorType` enum('employee','system','webhook') NOT NULL,
	`actorEmployeeId` int NULL,
	`grantedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledger_account_businesses_pk` PRIMARY KEY(`accountId`,`businessId`),
	CONSTRAINT `fk_lab_tenant_account` FOREIGN KEY (`tenantId`,`accountId`) REFERENCES `ledger_accounts`(`tenantId`,`id`),
	CONSTRAINT `fk_lab_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_lab_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`)
);
--> statement-breakpoint
CREATE TABLE `ledger_periods` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`period` char(7) NOT NULL,
	`status` enum('open','locked') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ledger_periods_id` PRIMARY KEY(`id`),
	CONSTRAINT `ledger_periods_tenant_period_unique` UNIQUE(`tenantId`,`period`),
	CONSTRAINT `fk_ledger_periods_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`)
);
--> statement-breakpoint
CREATE TABLE `ledger_period_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`periodId` int NOT NULL,
	`action` enum('lock','reopen') NOT NULL,
	`actorType` enum('employee','system','webhook') NOT NULL,
	`actorEmployeeId` int NULL,
	`reason` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledger_period_events_id` PRIMARY KEY(`id`),
	KEY `ledger_period_events_period_idx` (`periodId`,`createdAt`),
	CONSTRAINT `fk_lpe_period` FOREIGN KEY (`periodId`) REFERENCES `ledger_periods`(`id`),
	CONSTRAINT `fk_lpe_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lpe_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`)
);
--> statement-breakpoint
CREATE TABLE `ledger_transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`sourceBusinessId` int NULL,
	`kind` varchar(60) NOT NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'EGP',
	`effectiveDate` date NOT NULL,
	`postingPeriod` char(7) NOT NULL,
	`reversalOfTransactionId` int NULL,
	`sourceType` varchar(50) NULL,
	`sourceReference` varchar(160) NULL,
	`description` text NOT NULL,
	`actorType` enum('employee','system','webhook') NOT NULL,
	`actorEmployeeId` int NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledger_transactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `ledger_transactions_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `ledger_transactions_reversal_once_unique` UNIQUE(`reversalOfTransactionId`),
	CONSTRAINT `ledger_transactions_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	KEY `ledger_transactions_tenant_period_idx` (`tenantId`,`postingPeriod`),
	KEY `ledger_transactions_business_date_idx` (`sourceBusinessId`,`effectiveDate`),
	CONSTRAINT `fk_lt_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lt_tenant_business` FOREIGN KEY (`tenantId`,`sourceBusinessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_lt_period` FOREIGN KEY (`tenantId`,`postingPeriod`) REFERENCES `ledger_periods`(`tenantId`,`period`),
	CONSTRAINT `fk_lt_reversal` FOREIGN KEY (`tenantId`,`reversalOfTransactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_lt_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`)
);
--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`transactionId` int NOT NULL,
	`accountId` int NOT NULL,
	`businessId` int NULL,
	`side` enum('debit','credit') NOT NULL,
	`amount` decimal(18,4) NOT NULL,
	`balanceAfter` decimal(18,4) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledger_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `ledger_entries_amount_positive` CHECK (`amount` > 0),
	KEY `ledger_entries_account_tx_idx` (`accountId`,`transactionId`),
	KEY `ledger_entries_tx_idx` (`transactionId`),
	KEY `ledger_entries_business_idx` (`businessId`),
	CONSTRAINT `fk_le_tenant_tx` FOREIGN KEY (`tenantId`,`transactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_le_tenant_account` FOREIGN KEY (`tenantId`,`accountId`) REFERENCES `ledger_accounts`(`tenantId`,`id`),
	CONSTRAINT `fk_le_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`)
);
--> statement-breakpoint
CREATE TABLE `ledger_tenant_flags` (
	`tenantId` int NOT NULL,
	`ledgerV3Enabled` tinyint(1) NOT NULL DEFAULT 0,
	`goLiveDate` date NULL,
	`openingTransactionId` int NULL,
	`actorType` enum('employee','system','webhook') NULL,
	`actorEmployeeId` int NULL,
	`enabledAt` timestamp NULL,
	`disabledAt` timestamp NULL,
	`disabledReason` text NULL,
	CONSTRAINT `ledger_tenant_flags_pk` PRIMARY KEY(`tenantId`),
	CONSTRAINT `fk_ltf_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ltf_opening` FOREIGN KEY (`tenantId`,`openingTransactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_ltf_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`)
);
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback قبل أي استخدام فعلي (الجداول بالترتيب العكسي للمفاتيح الأجنبية، ثم الفهرسان). بعد أول
-- حركة فعلية: لا DROP — تعطيل الكتابة فقط (ledger_tenant_flags.ledgerV3Enabled=0 + disabledReason).
--   DROP TABLE `ledger_tenant_flags`;
--   DROP TABLE `ledger_entries`;
--   DROP TABLE `ledger_transactions`;
--   DROP TABLE `ledger_period_events`;
--   DROP TABLE `ledger_periods`;
--   DROP TABLE `ledger_account_businesses`;
--   DROP TABLE `ledger_accounts`;
--   ALTER TABLE `employees` DROP INDEX `employees_tenant_id`;
--   ALTER TABLE `businesses` DROP INDEX `businesses_tenant_id`;
