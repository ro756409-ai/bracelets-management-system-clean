-- 0039: صندوق وارد أحداث شركات الشحن (Bosta أولًا) — الحدث الخام + حالة معالجته.
--
-- السبب: carrier_webhook_events (0037) بيحفظ hash للـidempotency بس. استقبال الحالات محتاج:
-- الـpayload الخام قبل المعالجة، حالة المعالجة (received/processed/unmatched/ignored/failed)،
-- سبب الفشل، وقت الحدث من بوسطة (لمنع حدث قديم يرجّع الأوردر لورا)، وإعادة معالجة آمنة.
-- جدول جديد فقط — لا تعديل على orders ولا order_items ولا أي جدول موجود، بلا FOREIGN KEY
-- (نمط المشروع). الكود fail-safe قبل تشغيل الملف ده: غياب الجدول = الأحداث تتعالج بلا
-- سجل خام (تحذير في اللوج) والـidempotency بيرجع لجدول 0037.
CREATE TABLE `carrier_webhook_inbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int,
	`businessId` int,
	`provider` varchar(30) NOT NULL,
	`shipmentId` varchar(100),
	`trackingNumber` varchar(100),
	`eventKey` varchar(64) NOT NULL,
	`stateCode` int,
	`eventType` varchar(40),
	`eventTimestamp` bigint,
	`orderId` int,
	`processingStatus` varchar(16) NOT NULL DEFAULT 'received',
	`failureReason` text,
	`payloadJson` mediumtext NOT NULL,
	`attempts` int NOT NULL DEFAULT 1,
	`duplicateCount` int NOT NULL DEFAULT 0,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp NULL,
	CONSTRAINT `carrier_webhook_inbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `cwi_business_provider_event_unique` UNIQUE(`businessId`,`provider`,`eventKey`)
);
--> statement-breakpoint
CREATE INDEX `cwi_business_status_idx` ON `carrier_webhook_inbox` (`businessId`,`processingStatus`);
--> statement-breakpoint
CREATE INDEX `cwi_shipment_idx` ON `carrier_webhook_inbox` (`shipmentId`);
