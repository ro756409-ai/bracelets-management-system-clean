-- 0047 — شركات الشحن في Ledger V3 (المرحلة 3). DELTA مكتوبة بخط اليد، ADDITIVE بحت: ثلاثة جداول جديدة، بلا Backfill ولا Seed.
-- يتطلب 0040 (جداول الدفتر) والفهرسين المركّبين businesses_tenant_id / employees_tenant_id. لا تعديل على orders أو أي جدول قائم.
--   • ledger_shipments: ربط أوردر↔شحنة موحّد بلا تكرار — شحنة واحدة لكل (شركة، شركة شحن، رقم شحنة) وأوردر واحد لكل
--     (شركة، شركة شحن، أوردر). orderId بلا FK إلى orders عمدًا (deleteOrder القائم يبقى يعمل كما هو)؛ السلامة في الخدمة.
--   • ledger_carrier_review_items: طابور مراجعة دائم (تسليم/تسوية/تحويل) بمفتاح منع تكرار، وحل بسبب وفاعل ووقت إلزامية.
--   • ledger_settings: إعدادات مُدخلة فقط (أيام صرف، رسوم، ضريبة، تكلفة تغليف…) — لا قيم افتراضية مخمّنة. scopeBusinessId = 0
--     للشركة كلها (ليس FK)، وإلا نشاط محدد. قيمة واحدة بالضبط (عشرية أو صحيحة).
-- CHECK: كل تعبير بلا UNKNOWN. يتطلب MySQL ≥ 8.0.16. لا يُشغَّل إلا عبر scripts/migrate-0047-ledger-carrier، وفي هذه المرحلة على
-- Docker محلي مؤقت فقط.

CREATE TABLE `ledger_shipments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NOT NULL,
	`orderId` int NOT NULL,
	`carrier` varchar(20) NOT NULL,
	`shipmentId` varchar(100) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_shipments_id` PRIMARY KEY(`id`),
	CONSTRAINT `lsh_tenant_carrier_shipment_unique` UNIQUE(`tenantId`,`carrier`,`shipmentId`),
	CONSTRAINT `lsh_tenant_carrier_order_unique` UNIQUE(`tenantId`,`carrier`,`orderId`),
	CONSTRAINT `fk_lsh_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lsh_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `chk_lsh_carrier` CHECK (`carrier` IN ('bosta')),
	CONSTRAINT `chk_lsh_shipment` CHECK (CHAR_LENGTH(TRIM(`shipmentId`)) >= 1),
	CONSTRAINT `chk_lsh_order` CHECK (`orderId` > 0)
);
--> statement-breakpoint
CREATE TABLE `ledger_carrier_review_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NULL,
	`source` enum('delivery','settlement','payout') NOT NULL,
	`referenceKey` varchar(191) NOT NULL,
	`orderId` int NULL,
	`shipmentId` varchar(100) NULL,
	`reason` varchar(500) NOT NULL,
	`status` enum('open','resolved','dismissed') NOT NULL DEFAULT 'open',
	`resolvedByEmployeeId` int NULL,
	`resolvedAt` timestamp(3) NULL,
	`resolutionNote` varchar(500) NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_carrier_review_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `lcr_tenant_reference_unique` UNIQUE(`tenantId`,`referenceKey`),
	INDEX `lcr_tenant_status_created` (`tenantId`,`status`,`createdAt`),
	CONSTRAINT `fk_lcr_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lcr_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_lcr_tenant_resolver` FOREIGN KEY (`tenantId`,`resolvedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_lcr_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3),
	CONSTRAINT `chk_lcr_resolution` CHECK ((`status` = 'open' AND `resolvedAt` IS NULL AND `resolvedByEmployeeId` IS NULL AND `resolutionNote` IS NULL)
		OR (`status` <> 'open' AND `resolvedAt` IS NOT NULL AND `resolvedByEmployeeId` IS NOT NULL AND `resolutionNote` IS NOT NULL AND CHAR_LENGTH(TRIM(`resolutionNote`)) >= 3))
);
--> statement-breakpoint
CREATE TABLE `ledger_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`scopeBusinessId` int NOT NULL DEFAULT 0,
	`settingKey` varchar(60) NOT NULL,
	`valueDecimal` decimal(18,4) NULL,
	`valueInt` int NULL,
	`updatedByEmployeeId` int NOT NULL,
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `lst_tenant_scope_key_unique` UNIQUE(`tenantId`,`scopeBusinessId`,`settingKey`),
	CONSTRAINT `fk_lst_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lst_tenant_updater` FOREIGN KEY (`tenantId`,`updatedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_lst_key` CHECK (REGEXP_LIKE(`settingKey`, '^[a-z][a-z0-9_.]{2,59}$', 'c')),
	CONSTRAINT `chk_lst_scope` CHECK (`scopeBusinessId` >= 0),
	CONSTRAINT `chk_lst_one_value` CHECK ((`valueDecimal` IS NOT NULL AND `valueInt` IS NULL) OR (`valueDecimal` IS NULL AND `valueInt` IS NOT NULL))
);
