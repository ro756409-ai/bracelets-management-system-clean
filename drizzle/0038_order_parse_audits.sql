-- 0038: سجل تحليل الرسالة الملصوقة لكل أوردر (Hybrid Order Parser).
--
-- النص الخام يفضل كمان في orders.externalRawPayload كما هو. هنا بيتحفظ ناتج التحليل
-- المهيكل (ParseResultV2: الثقة لكل حقل، مصدر سعر كل سطر، الأجزاء غير المحلولة، مصدر
-- التحليل حتمي/AI) داخل resultJson — **بلا أي عمود جديد في order_items**.
-- بلا FOREIGN KEY اتباعًا لباقي الـschema. الكود fail-safe قبل تشغيل الملف ده: غياب
-- الجدول = الأوردر يتسجّل عادي مع تحذير في اللوج فقط.
CREATE TABLE `order_parse_audits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NOT NULL,
	`orderId` int NOT NULL,
	`parserVersion` varchar(16) NOT NULL,
	`parseSource` varchar(16) NOT NULL,
	`rawText` text NOT NULL,
	`resultJson` mediumtext NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `order_parse_audits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `opa_order_idx` ON `order_parse_audits` (`orderId`);
--> statement-breakpoint
CREATE INDEX `opa_business_idx` ON `order_parse_audits` (`businessId`);
