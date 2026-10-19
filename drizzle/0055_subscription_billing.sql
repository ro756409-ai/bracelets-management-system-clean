-- 0055 — اشتراك متجرك (تجديد يدوي، بلا تجربة مجانية، بلا رسوم لكل أوردر). DELTA مكتوبة بخط اليد، ADDITIVE بحت: 3 جداول جديدة،
-- بلا Backfill، ولا يغيّر أي جدول قائم ولا أي شركة حالية. يتطلب الفهرس المركّب (موجود من 0040/0041 على Staging).
--   • tenant_billing_accounts: الشركات الداخلة نموذج الاشتراك (تسجيل جديد بعد التفعيل، أو تسجيل صريح من أدمن المنصة).
--     الشركات الحالية **مش** بتتسجّل تلقائيًا — بتفضل على سلوكها الحالي لحد قرار انتقال صريح.
--   • subscription_payments: كل محاولة دفع (يدوي/مزوّد). مفتاح منع تكرار فريد، ورقم مرجع المزوّد فريد لكل مزوّد ⇒ لا تفعيل مكرر.
--     الدفع اليدوي يشترط مرجع دفع + دليل + أدمن المنصة اللي سجّله. لا بيانات بطاقات أبدًا.
--   • subscription_periods: فترة واحدة بالظبط لكل دفع ناجح (paymentId فريد). الاسترداد = voidedAt (لا حذف). الحالة مشتقة.
-- CHECK: كل تعبير بلا UNKNOWN. يتطلب MySQL ≥ 8.0.16. لا يُشغَّل إلا عبر scripts/migrate-0055-subscription-billing، وفي هذه
-- المرحلة على Docker محلي مؤقت فقط. التراجع مرفوض متى وُجد أي صف (المحرّك يشترط الجداول فارغة).

CREATE TABLE `tenant_billing_accounts` (
	`tenantId` int NOT NULL,
	`model` enum('subscription_v1') NOT NULL DEFAULT 'subscription_v1',
	`enrolledBy` enum('signup','platform_admin') NOT NULL,
	`enrolledByPlatformAdminId` int NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_billing_accounts_tenantId` PRIMARY KEY(`tenantId`),
	CONSTRAINT `fk_tba_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `chk_tba_enrolled_by` CHECK (`enrolledBy` = 'signup' OR COALESCE(`enrolledByPlatformAdminId`, 0) >= 1)
);
--> statement-breakpoint
CREATE TABLE `subscription_payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`planCode` enum('month_1','month_5','month_12') NOT NULL,
	`months` tinyint NOT NULL,
	`amountMinor` int NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'EGP',
	`provider` enum('manual','paymob','fawry','mock') NOT NULL,
	`status` enum('pending','succeeded','failed','refunded') NOT NULL,
	`idempotencyKey` varchar(80) NOT NULL,
	`providerRef` varchar(120) NULL,
	`paymentReference` varchar(200) NULL,
	`evidenceUrl` varchar(500) NULL,
	`note` text NULL,
	`recordedByPlatformAdminId` int NULL,
	`failureReason` varchar(300) NULL,
	`refundReason` varchar(300) NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`succeededAt` timestamp(3) NULL,
	`failedAt` timestamp(3) NULL,
	`refundedAt` timestamp(3) NULL,
	CONSTRAINT `subscription_payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `sp_idempotency_unique` UNIQUE(`idempotencyKey`),
	CONSTRAINT `sp_provider_ref_unique` UNIQUE(`provider`,`providerRef`),
	INDEX `sp_tenant_created_idx` (`tenantId`,`createdAt`),
	CONSTRAINT `fk_sp_billing_account` FOREIGN KEY (`tenantId`) REFERENCES `tenant_billing_accounts`(`tenantId`),
	CONSTRAINT `chk_sp_plan_months` CHECK ((`planCode` = 'month_1' AND `months` = 1) OR (`planCode` = 'month_5' AND `months` = 5) OR (`planCode` = 'month_12' AND `months` = 12)),
	CONSTRAINT `chk_sp_amount` CHECK (`amountMinor` >= 1 AND `currency` = 'EGP'),
	CONSTRAINT `chk_sp_idempotency` CHECK (REGEXP_LIKE(`idempotencyKey`, '^[A-Za-z0-9:_-]{8,80}$', 'c')),
	CONSTRAINT `chk_sp_manual_evidence` CHECK (`provider` <> 'manual' OR (CHAR_LENGTH(COALESCE(`paymentReference`, '')) >= 3 AND COALESCE(`recordedByPlatformAdminId`, 0) >= 1 AND (CHAR_LENGTH(COALESCE(`evidenceUrl`, '')) >= 8 OR CHAR_LENGTH(COALESCE(`note`, '')) >= 10))),
	CONSTRAINT `chk_sp_online_ref` CHECK (`provider` = 'manual' OR `status` = 'pending' OR CHAR_LENGTH(COALESCE(`providerRef`, '')) >= 1),
	CONSTRAINT `chk_sp_status_times` CHECK ((`status` <> 'succeeded' OR `succeededAt` IS NOT NULL) AND (`status` <> 'refunded' OR (`refundedAt` IS NOT NULL AND `succeededAt` IS NOT NULL)) AND (`status` <> 'failed' OR `failedAt` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `subscription_periods` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`paymentId` int NOT NULL,
	`startsAt` timestamp(3) NOT NULL,
	`endsAt` timestamp(3) NOT NULL,
	`voidedAt` timestamp(3) NULL,
	`voidReason` varchar(300) NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscription_periods_id` PRIMARY KEY(`id`),
	CONSTRAINT `spd_payment_unique` UNIQUE(`paymentId`),
	INDEX `spd_tenant_ends_idx` (`tenantId`,`endsAt`),
	CONSTRAINT `fk_spd_billing_account` FOREIGN KEY (`tenantId`) REFERENCES `tenant_billing_accounts`(`tenantId`),
	CONSTRAINT `fk_spd_payment` FOREIGN KEY (`paymentId`) REFERENCES `subscription_payments`(`id`),
	CONSTRAINT `chk_spd_range` CHECK (`endsAt` > `startsAt`),
	CONSTRAINT `chk_spd_void` CHECK (`voidedAt` IS NULL OR CHAR_LENGTH(COALESCE(`voidReason`, '')) >= 3)
);
