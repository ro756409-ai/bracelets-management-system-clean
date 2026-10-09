-- 0041 — Order activity events (Event Ledger لأداء الموظفين). DELTA مكتوبة بخط اليد، ADDITIVE بحت:
--   • فهرسان فريدان مركّبان على جدولين قديمين (businesses/employees) — **فقط إذا لم يكونا موجودين**
--     (سكربت scripts/migrate-0041-order-events يقرر: كلاهما غائب → يُنشآن؛ كلاهما موجود بنفس الأعمدة
--     والترتيب → skip/replay؛ واحد فقط أو تعريف مختلف → partial ورفض بلا أي DDL).
--   • جدول جديد واحد order_activity_events. لا تعديل لأي عمود أو صف قائم. غير مضاف إلى drizzle journal.
--
-- عزل الـtenant بالـFK المركّب: النشاط (tenantId,businessId) وكل موظف (منفّذ/منسوب/مُسنَد) (tenantId,employeeId).
-- orderId **بلا FK** عمدًا (حذف المكررات النهائي قائم) — الخدمة تقفل الأوردر FOR UPDATE وتستخرج businessId منه
--   وtenantId من النشاط، ولا تقبلهما من العميل، وتحفظ orderNumberSnapshot ليبقى الحدث مقروءًا بعد الحذف.
-- eventType/source = VARCHAR بقائمة مسموحة مركزية في الخدمة (shared/orderEventsSpec.ts) — لا قيمة حرة من العميل.
-- actorEmployeeId = من نفّذ؛ attributedEmployeeId = من يُحتسب الحدث في أدائه (التقارير تعتمده).
-- الأحداث للإضافة فقط: لا UPDATE ولا DELETE في أي مسار كود. الوقت timestamp(3) (UTC داخليًا).
-- CHECK: كل تعبير مكتوب بحيث لا ينتج UNKNOWN (MySQL يمرّر UNKNOWN) — شروط IS [NOT] NULL صريحة و<=>.
-- يتطلب MySQL ≥ 8.0.16 لفرض CHECK (يفحصه الـpreflight).
-- لا يُشغَّل إلا عبر السكربت، وفي هذه المرحلة على قواعد Docker محلية مؤقتة فقط.

ALTER TABLE `businesses` ADD UNIQUE INDEX `businesses_tenant_id` (`tenantId`,`id`);
--> statement-breakpoint
ALTER TABLE `employees` ADD UNIQUE INDEX `employees_tenant_id` (`tenantId`,`id`);
--> statement-breakpoint
CREATE TABLE `order_activity_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NOT NULL,
	`orderId` int NOT NULL,
	`orderNumberSnapshot` varchar(100) NOT NULL,
	`eventType` varchar(50) NOT NULL,
	`fromStatus` varchar(30) NULL,
	`toStatus` varchar(30) NULL,
	`actorType` enum('employee','system','webhook','backfill') NOT NULL,
	`actorEmployeeId` int NULL,
	`attributedEmployeeId` int NULL,
	`actorRoleSnapshot` varchar(50) NULL,
	`actorNameSnapshot` varchar(100) NULL,
	`assigneeEmployeeIdAtEvent` int NULL,
	`previousAssigneeEmployeeId` int NULL,
	`reason` varchar(160) NULL,
	`callAttempt` smallint unsigned NULL,
	`source` varchar(30) NOT NULL,
	`backfillConfidence` enum('confirmed','partial') NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`occurredAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`metadataJson` json NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_activity_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `oae_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `oae_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `oae_tenant_occurred` (`tenantId`,`occurredAt`),
	INDEX `oae_tenant_attributed_occurred` (`tenantId`,`attributedEmployeeId`,`occurredAt`),
	INDEX `oae_tenant_actor_occurred` (`tenantId`,`actorEmployeeId`,`occurredAt`),
	INDEX `oae_tenant_assignee_occurred` (`tenantId`,`assigneeEmployeeIdAtEvent`,`occurredAt`),
	INDEX `oae_tenant_business_occurred` (`tenantId`,`businessId`,`occurredAt`),
	INDEX `oae_tenant_type_occurred` (`tenantId`,`eventType`,`occurredAt`),
	INDEX `oae_order_occurred` (`orderId`,`occurredAt`),
	CONSTRAINT `fk_oae_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_oae_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_attributed` FOREIGN KEY (`tenantId`,`attributedEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_assignee` FOREIGN KEY (`tenantId`,`assigneeEmployeeIdAtEvent`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_prev_assignee` FOREIGN KEY (`tenantId`,`previousAssigneeEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_oae_actor` CHECK (
		(`actorType` = 'employee' AND `actorEmployeeId` IS NOT NULL AND `attributedEmployeeId` IS NOT NULL AND `attributedEmployeeId` = `actorEmployeeId`)
		OR (`actorType` IN ('system','webhook') AND `actorEmployeeId` IS NULL)
		OR (`actorType` = 'backfill' AND `actorEmployeeId` IS NULL)),
	CONSTRAINT `chk_oae_backfill` CHECK (
		((`actorType` = 'backfill') = (`source` = 'backfill'))
		AND ((`source` = 'backfill') = (`backfillConfidence` IS NOT NULL))),
	CONSTRAINT `chk_oae_call` CHECK (`callAttempt` IS NULL OR `eventType` = 'no_answer'),
	CONSTRAINT `chk_oae_event_type` CHECK (`eventType` REGEXP '^[a-z][a-z_]{1,49}$'),
	CONSTRAINT `chk_oae_source` CHECK (`source` REGEXP '^[a-z][a-z_]{1,29}$'),
	CONSTRAINT `chk_oae_hash` CHECK (`payloadHash` REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ROLLBACK قبل أي استخدام — فقط عبر: scripts/migrate-0041-order-events --rollback (يتحقق أن الجدول فارغ):
--   DROP TABLE `order_activity_events`;
--   الفهرسان المركّبان **لا يُحذفان** إذا كانت أي جداول أخرى تعتمد عليهما (FK إليهما من ledger_* أو attendance_*)
--   أو إذا لم يكن 0041 منشئهما (كانا موجودين قبله) — السكربت يقرر من information_schema ويُبقيهما عند الشك.
