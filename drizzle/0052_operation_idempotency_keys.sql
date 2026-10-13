-- 0052 — منع تكرار إنشاء الأوردر وإرسال الورشة على السيرفر (مفتاح عملية دائم). DELTA مكتوبة بخط اليد، ADDITIVE بحت: جدول واحد
-- جديد، بلا Backfill، ولا يغيّر أي جدول قائم. يتطلب الفهرس المركّب businesses(tenantId, id) من 0040/0041.
--   • المفتاح بنطاق (الشركة، النشاط، نوع العملية، operationId الذي تولّده الواجهة) — قيد فريد في القاعدة.
--   • requestHash = sha256 لبيانات الطلب القانونية: نفس المفتاح ونفس البيانات = نفس النتيجة؛ بيانات مختلفة = رفض.
--   • resultId/resultReference = الأوردر (id/orderNumber) أو حدث تحويل الورشة (business_events.id/رقم الإذن). بلا FK على
--     الأوردر عمدًا: حذف الأوردر الحالي يظل يعمل، والإعادة بعد الحذف تُرفض ولا تُنشئ أوردرًا جديدًا.
--   • actorType/actorId: الفاعل الأصلي — الإعادة لنفس الفاعل فقط. يُكتب الصف داخل معاملة الأوردر/التحويل نفسها.
-- الطلبات بلا مفتاح (عملاء قدامى) لا تُسجَّل هنا ولا يُولَّد لها مفتاح. لا UPDATE/DELETE من التطبيق.
-- CHECK: كل تعبير بلا UNKNOWN. يتطلب MySQL ≥ 8.0.16. لا يُشغَّل إلا عبر scripts/migrate-0052-operation-idempotency، وفي هذه
-- المرحلة على Docker محلي مؤقت فقط. التراجع مرفوض متى وُجد أي صف (المحرّك يشترط الجدول فارغًا).

CREATE TABLE `operation_idempotency_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NOT NULL,
	`operation` enum('order.create','workshop.send') NOT NULL,
	`operationId` varchar(80) NOT NULL,
	`requestHash` char(64) NOT NULL,
	`resultId` int NOT NULL,
	`resultReference` varchar(100) NOT NULL,
	`actorType` enum('employee','user') NOT NULL,
	`actorId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `operation_idempotency_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `oik_scope_unique` UNIQUE(`tenantId`,`businessId`,`operation`,`operationId`),
	CONSTRAINT `fk_oik_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_oik_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `chk_oik_operation_id` CHECK (REGEXP_LIKE(`operationId`, '^[A-Za-z0-9_-]{8,80}$', 'c')),
	CONSTRAINT `chk_oik_hash` CHECK (REGEXP_LIKE(`requestHash`, '^[0-9a-f]{64}$', 'c')),
	CONSTRAINT `chk_oik_result` CHECK (`resultId` >= 1 AND CHAR_LENGTH(`resultReference`) >= 1)
);
