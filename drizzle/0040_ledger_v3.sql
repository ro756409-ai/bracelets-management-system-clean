-- Accounting Ledger V3 — جداول جديدة فقط (DELTA مكتوبة بخط اليد، ADDITIVE بحت).
--
-- لا تمس أي جدول قائم: لا ALTER ولا فهرس جديد على الجداول القديمة (treasury_transactions،
-- financial_*، business_events، accounting_closings تبقى للقراءة كما هي). الدفتر الجديد:
--   • الحساب مملوك للـtenant (خزنة مكتب/بنك مشتركة بين البراندات)؛ النشاط لا يستخدم حسابًا إلا
--     عبر ledger_account_businesses (المصدر الوحيد للسماح).
--   • الحركة غير قابلة للتعديل: لا status ولا UPDATE/DELETE؛ كونها معكوسة يُستنتج من وجود حركة
--     kind='reversal' تحمل reversalOfTransactionId (UNIQUE → لا تُعكس مرتين).
--   • idempotency ذرّية في DB: UNIQUE(tenantId, idempotencyKey) + payloadHash محفوظ (نفس المفتاح
--     ونفس الهاش = replay، هاش مختلف = CONFLICT).
--   • الفاعل: actorType (employee|system|webhook) + actorEmployeeId NULL — لا موظف وهمي للنظام.
--   • الفترات: ledger_periods حالة حالية فقط، وledger_period_events سجل كل قفل/فتح بسبب وفاعل.
--
-- ما لا يضمنه الـFK (يُفرض في الخدمة fail-closed داخل Transaction، مع اختبارات concurrency لاحقًا):
--   تطابق tenant النشاط (businesses.tenantId) مع tenantId الصف — لا يوجد UNIQUE(tenantId, id) على
--   businesses، وإضافته تعديل على جدول قديم مرفوض الآن. الـFK المركّب يضمن فقط أن الحساب
--   والحركة والقيد من نفس tenant.
--
-- Preflight (يجب أن يعيد صفرًا/القيم المتوقعة) في scripts/verify-ledger-v3.ts --preflight.
-- التشغيل اليدوي (بعد backup وبعد Staging):  mysql -u"$MYSQL_USER" -p <db> < drizzle/0040_ledger_v3.sql
-- Rollback قبل أي استخدام فعلي: الجداول السبعة مستقلة — DROP بالترتيب العكسي (أسفل الملف، معلّق).

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
	CONSTRAINT `fk_ledger_accounts_actor` FOREIGN KEY (`actorEmployeeId`) REFERENCES `employees`(`id`)
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
	CONSTRAINT `fk_lab_business` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`),
	CONSTRAINT `fk_lab_actor` FOREIGN KEY (`actorEmployeeId`) REFERENCES `employees`(`id`)
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
	CONSTRAINT `fk_lpe_actor` FOREIGN KEY (`actorEmployeeId`) REFERENCES `employees`(`id`)
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
	CONSTRAINT `fk_lt_business` FOREIGN KEY (`sourceBusinessId`) REFERENCES `businesses`(`id`),
	CONSTRAINT `fk_lt_period` FOREIGN KEY (`tenantId`,`postingPeriod`) REFERENCES `ledger_periods`(`tenantId`,`period`),
	CONSTRAINT `fk_lt_reversal` FOREIGN KEY (`tenantId`,`reversalOfTransactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_lt_actor` FOREIGN KEY (`actorEmployeeId`) REFERENCES `employees`(`id`)
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
	CONSTRAINT `fk_le_business` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`)
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
	CONSTRAINT `fk_ltf_actor` FOREIGN KEY (`actorEmployeeId`) REFERENCES `employees`(`id`)
);
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback قبل أي استخدام فعلي (بالترتيب العكسي للمفاتيح الأجنبية). بعد أول حركة فعلية:
-- لا DROP — تعطيل الكتابة فقط (ledger_tenant_flags.ledgerV3Enabled=0 + disabledReason).
--   DROP TABLE `ledger_tenant_flags`;
--   DROP TABLE `ledger_entries`;
--   DROP TABLE `ledger_transactions`;
--   DROP TABLE `ledger_period_events`;
--   DROP TABLE `ledger_periods`;
--   DROP TABLE `ledger_account_businesses`;
--   DROP TABLE `ledger_accounts`;
