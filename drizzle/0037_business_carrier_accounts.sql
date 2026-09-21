-- 0037: حساب شركة شحن (Bosta أولًا) لكل نشاط + أحداث webhook للـidempotency.
--
-- السبب: مفتاح Bosta كان متغير بيئة واحد للتطبيق كله ومكان الاستلام مكتوبًا في الكود، فكل
-- الأنشطة كانت تشحن على حساب Bosta واحد. المفتاح هنا مشفّر AES-256-GCM بمفتاح رئيسي من
-- البيئة (CARRIER_SECRETS_KEY) — لا plaintext. أعمدة المفتاح NULLable: الفصل بيمسحها
-- فعليًا ويسيب الصف كأثر بالحالة disconnected.
-- بلا FOREIGN KEY اتباعًا لباقي الـschema (صفر قيود مرجعية، وtenantId في businesses لسه nullable).
CREATE TABLE `business_carrier_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NOT NULL,
	`provider` varchar(30) NOT NULL,
	`encryptedApiKey` text,
	`apiKeyLast4` varchar(4),
	`encryptionIv` varchar(64),
	`encryptionTag` varchar(64),
	`apiBaseUrl` varchar(200),
	`apiAuthScheme` varchar(16),
	`pickupLocationId` varchar(100),
	`pickupLocationName` varchar(255),
	`allowOpenPackageDefault` tinyint(1) NOT NULL DEFAULT 1,
	`webhookSalt` varchar(64) NOT NULL,
	`webhookSecretHash` varchar(128) NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'disconnected',
	`lastVerifiedAt` timestamp NULL,
	`lastError` text,
	`createdBy` int NOT NULL,
	`updatedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `business_carrier_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `bca_business_provider_unique` UNIQUE(`businessId`,`provider`),
	CONSTRAINT `bca_webhook_secret_hash_unique` UNIQUE(`webhookSecretHash`)
);
--> statement-breakpoint
CREATE INDEX `bca_tenant_idx` ON `business_carrier_accounts` (`tenantId`);
--> statement-breakpoint
CREATE TABLE `carrier_webhook_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`provider` varchar(30) NOT NULL,
	`eventHash` varchar(64) NOT NULL,
	`shipmentId` varchar(100),
	`stateCode` int,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `carrier_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `cwe_business_provider_event_unique` UNIQUE(`businessId`,`provider`,`eventHash`)
);
