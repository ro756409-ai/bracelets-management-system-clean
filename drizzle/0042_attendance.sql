-- 0042 — الحضور والانصراف. DELTA مكتوبة بخط اليد، ADDITIVE بحت: 5 جداول جديدة + FK لاحق واحد (كسر الدورة).
-- يعتمد على الفهرسين المركّبين businesses_tenant_id/employees_tenant_id (ينشئهما 0040 أو 0041) — الـpreflight يرفض بدونهما.
-- لا ربط بالرواتب ولا Ledger. لا GPS ولا بيانات حيوية. لا حذف في أي مسار كود. غير مضاف إلى drizzle journal.
--
-- عزل الموظف داخل الـtenant بالـFK الثلاثي: الحدث وطلب التصحيح لا يُربطان بيوم/طلب/حدث موظف آخر:
--   (tenantId, employeeId, attendanceDayId)     → attendance_days(tenantId, employeeId, id)
--   (tenantId, employeeId, correctionRequestId) → attendance_correction_requests(tenantId, employeeId, id)
--   (tenantId, employeeId, correctionOfEventId) → attendance_events(tenantId, employeeId, id)
--   (tenantId, employeeId, targetEventId)       → attendance_events(tenantId, employeeId, id)  ← ALTER بعد إنشاء الجدولين
-- الوقت: كل الطوابع timestamp(3) (UTC داخليًا)؛ الخدمة تكتب/تقرأ بالـepoch وتضبط time_zone='+00:00' لكل معاملة؛
--   workDate = تاريخ بداية الوردية بتوقيت الوردية (IANA، افتراضيًا Africa/Cairo) يُحسب على السيرفر.
-- workDaysMask (ثابت في shared/attendanceSpec.ts): bit0=السبت، bit1=الأحد، bit2=الاثنين، bit3=الثلاثاء،
--   bit4=الأربعاء، bit5=الخميس، bit6=الجمعة — بلا Default: العميل يرسل الأيام صراحةً ويوم واحد على الأقل.
-- CHECK: كل تعبير بلا UNKNOWN (شروط IS [NOT] NULL صريحة). يتطلب MySQL ≥ 8.0.16.
-- لا يُشغَّل إلا عبر scripts/migrate-0042-attendance، وفي هذه المرحلة على قواعد Docker محلية مؤقتة فقط.

CREATE TABLE `attendance_shifts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NULL,
	`name` varchar(80) NOT NULL,
	`startTime` time NOT NULL,
	`endTime` time NOT NULL,
	`crossesMidnight` tinyint(1) NOT NULL,
	`workDaysMask` tinyint unsigned NOT NULL,
	`graceMinutes` smallint unsigned NOT NULL,
	`allowedBreakMinutes` smallint unsigned NOT NULL,
	`overtimeStartsAfterMinutes` smallint unsigned NOT NULL,
	`earlyClockInLimitMinutes` smallint unsigned NOT NULL,
	`earlyLeaveToleranceMinutes` smallint unsigned NOT NULL DEFAULT 0,
	`timezone` varchar(64) NOT NULL,
	`effectiveFrom` date NOT NULL,
	`effectiveTo` date NULL,
	`isActive` tinyint(1) NOT NULL DEFAULT 1,
	`version` int unsigned NOT NULL DEFAULT 1,
	`createdByEmployeeId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_shifts_id` PRIMARY KEY(`id`),
	CONSTRAINT `ash_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `ash_tenant_active_from` (`tenantId`,`isActive`,`effectiveFrom`),
	CONSTRAINT `fk_ash_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ash_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_ash_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_ash_times` CHECK (`endTime` <> `startTime` AND `crossesMidnight` = (`endTime` < `startTime`)),
	CONSTRAINT `chk_ash_days` CHECK (`workDaysMask` BETWEEN 1 AND 127),
	CONSTRAINT `chk_ash_limits` CHECK (`graceMinutes` <= 240 AND `allowedBreakMinutes` <= 480 AND `earlyClockInLimitMinutes` <= 480 AND `overtimeStartsAfterMinutes` <= 720 AND `earlyLeaveToleranceMinutes` <= 240),
	CONSTRAINT `chk_ash_range` CHECK (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`),
	CONSTRAINT `chk_ash_name` CHECK (CHAR_LENGTH(TRIM(`name`)) >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`shiftId` int NOT NULL,
	`targetType` enum('employee','role','business','tenant_default') NOT NULL,
	`employeeId` int NULL,
	`role` varchar(50) NULL,
	`businessId` int NULL,
	`effectiveFrom` date NOT NULL,
	`effectiveTo` date NULL,
	`assignedByEmployeeId` int NOT NULL,
	`assignedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`endedByEmployeeId` int NULL,
	`endedAt` timestamp(3) NULL,
	CONSTRAINT `attendance_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `aas_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `aas_tenant_employee_from` (`tenantId`,`employeeId`,`effectiveFrom`),
	INDEX `aas_tenant_target_from` (`tenantId`,`targetType`,`role`,`businessId`,`effectiveFrom`),
	CONSTRAINT `fk_aas_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_aas_tenant_shift` FOREIGN KEY (`tenantId`,`shiftId`) REFERENCES `attendance_shifts`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_assigner` FOREIGN KEY (`tenantId`,`assignedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_ender` FOREIGN KEY (`tenantId`,`endedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_aas_target` CHECK (
		(`targetType` = 'employee' AND `employeeId` IS NOT NULL AND `role` IS NULL AND `businessId` IS NULL)
		OR (`targetType` = 'role' AND `employeeId` IS NULL AND `role` IS NOT NULL)
		OR (`targetType` = 'business' AND `employeeId` IS NULL AND `role` IS NULL AND `businessId` IS NOT NULL)
		OR (`targetType` = 'tenant_default' AND `employeeId` IS NULL AND `role` IS NULL AND `businessId` IS NULL)),
	CONSTRAINT `chk_aas_range` CHECK (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`),
	CONSTRAINT `chk_aas_end` CHECK ((`endedAt` IS NULL AND `endedByEmployeeId` IS NULL) OR (`endedAt` IS NOT NULL AND `endedByEmployeeId` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_days` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`employeeId` int NOT NULL,
	`businessId` int NULL,
	`workDate` date NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`shiftId` int NULL,
	`shiftSnapshotJson` json NULL,
	`scheduledStartAt` timestamp(3) NULL,
	`scheduledEndAt` timestamp(3) NULL,
	`status` enum('open','on_break','closed','absent','leave','mission','holiday','day_off','incomplete') NOT NULL DEFAULT 'open',
	`firstInAt` timestamp(3) NULL,
	`lastOutAt` timestamp(3) NULL,
	`openBreakStartedAt` timestamp(3) NULL,
	`workedMinutes` int unsigned NOT NULL DEFAULT 0,
	`breakMinutes` int unsigned NOT NULL DEFAULT 0,
	`excessBreakMinutes` int unsigned NOT NULL DEFAULT 0,
	`lateMinutes` int unsigned NOT NULL DEFAULT 0,
	`earlyLeaveMinutes` int unsigned NOT NULL DEFAULT 0,
	`overtimeMinutes` int unsigned NOT NULL DEFAULT 0,
	`requiresReview` tinyint(1) NOT NULL DEFAULT 0,
	`reviewReason` varchar(160) NULL,
	`approvedByEmployeeId` int NULL,
	`approvedAt` timestamp(3) NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_days_id` PRIMARY KEY(`id`),
	CONSTRAINT `ad_tenant_employee_date_unique` UNIQUE(`tenantId`,`employeeId`,`workDate`),
	CONSTRAINT `ad_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `ad_tenant_employee_id_unique` UNIQUE(`tenantId`,`employeeId`,`id`),
	INDEX `ad_tenant_date_status` (`tenantId`,`workDate`,`status`),
	INDEX `ad_tenant_business_date` (`tenantId`,`businessId`,`workDate`),
	CONSTRAINT `fk_ad_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ad_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_shift` FOREIGN KEY (`tenantId`,`shiftId`) REFERENCES `attendance_shifts`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_approver` FOREIGN KEY (`tenantId`,`approvedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_ad_times` CHECK (`lastOutAt` IS NULL OR `firstInAt` IS NULL OR `lastOutAt` >= `firstInAt`),
	CONSTRAINT `chk_ad_break` CHECK ((`status` = 'on_break' AND `openBreakStartedAt` IS NOT NULL) OR (`status` <> 'on_break' AND `openBreakStartedAt` IS NULL)),
	CONSTRAINT `chk_ad_approval` CHECK ((`approvedAt` IS NULL AND `approvedByEmployeeId` IS NULL) OR (`approvedAt` IS NOT NULL AND `approvedByEmployeeId` IS NOT NULL)),
	CONSTRAINT `chk_ad_snapshot` CHECK (`shiftId` IS NULL OR `shiftSnapshotJson` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_correction_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`employeeId` int NOT NULL,
	`attendanceDayId` int NULL,
	`workDate` date NOT NULL,
	`requestType` enum('missing_clock_in','missing_clock_out','wrong_time','break_fix','absence_to_leave','absence_to_mission','early_leave_reason','other') NOT NULL,
	`targetEventId` bigint NULL,
	`requestedAt` timestamp(3) NULL,
	`requestedValueJson` json NULL,
	`reason` varchar(500) NOT NULL,
	`note` varchar(500) NULL,
	`status` enum('pending','approved','rejected','canceled') NOT NULL DEFAULT 'pending',
	`reviewedByEmployeeId` int NULL,
	`reviewedAt` timestamp(3) NULL,
	`reviewReason` varchar(500) NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_correction_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `acr_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `acr_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `acr_tenant_employee_id_unique` UNIQUE(`tenantId`,`employeeId`,`id`),
	INDEX `acr_tenant_status_created` (`tenantId`,`status`,`createdAt`),
	INDEX `acr_tenant_employee_date` (`tenantId`,`employeeId`,`workDate`),
	CONSTRAINT `fk_acr_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_acr_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_acr_tenant_employee_day` FOREIGN KEY (`tenantId`,`employeeId`,`attendanceDayId`) REFERENCES `attendance_days`(`tenantId`,`employeeId`,`id`),
	CONSTRAINT `fk_acr_tenant_reviewer` FOREIGN KEY (`tenantId`,`reviewedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_acr_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3),
	CONSTRAINT `chk_acr_review` CHECK (
		(`status` IN ('pending','canceled') AND `reviewedByEmployeeId` IS NULL AND `reviewedAt` IS NULL)
		OR (`status` IN ('approved','rejected') AND `reviewedByEmployeeId` IS NOT NULL AND `reviewedAt` IS NOT NULL)),
	CONSTRAINT `chk_acr_reject` CHECK (`status` <> 'rejected' OR CHAR_LENGTH(TRIM(COALESCE(`reviewReason`, ''))) >= 3),
	CONSTRAINT `chk_acr_no_self` CHECK (`reviewedByEmployeeId` IS NULL OR `reviewedByEmployeeId` <> `employeeId`),
	CONSTRAINT `chk_acr_hash` CHECK (`payloadHash` REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`attendanceDayId` int NOT NULL,
	`employeeId` int NOT NULL,
	`eventType` enum('clock_in','break_start','break_end','clock_out','absence','leave','mission','correction','day_close','day_reopen') NOT NULL,
	`occurredAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`effectiveAt` timestamp(3) NULL,
	`actorType` enum('self','admin','system') NOT NULL,
	`actorEmployeeId` int NULL,
	`source` enum('web','mobile_web','admin','system') NOT NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`correctionOfEventId` bigint NULL,
	`correctionRequestId` int NULL,
	`reason` varchar(200) NULL,
	`oldValueJson` json NULL,
	`newValueJson` json NULL,
	`clientInfoJson` json NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `ae_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `ae_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `ae_tenant_employee_id_unique` UNIQUE(`tenantId`,`employeeId`,`id`),
	INDEX `ae_tenant_employee_occurred` (`tenantId`,`employeeId`,`occurredAt`),
	INDEX `ae_day_occurred` (`attendanceDayId`,`occurredAt`),
	CONSTRAINT `fk_ae_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ae_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ae_tenant_employee_day` FOREIGN KEY (`tenantId`,`employeeId`,`attendanceDayId`) REFERENCES `attendance_days`(`tenantId`,`employeeId`,`id`),
	CONSTRAINT `fk_ae_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ae_tenant_employee_correction_of` FOREIGN KEY (`tenantId`,`employeeId`,`correctionOfEventId`) REFERENCES `attendance_events`(`tenantId`,`employeeId`,`id`),
	CONSTRAINT `fk_ae_tenant_employee_request` FOREIGN KEY (`tenantId`,`employeeId`,`correctionRequestId`) REFERENCES `attendance_correction_requests`(`tenantId`,`employeeId`,`id`),
	CONSTRAINT `chk_ae_actor` CHECK (
		(`actorType` = 'self' AND `actorEmployeeId` IS NOT NULL AND `actorEmployeeId` = `employeeId`)
		OR (`actorType` = 'admin' AND `actorEmployeeId` IS NOT NULL AND CHAR_LENGTH(TRIM(COALESCE(`reason`, ''))) >= 3)
		OR (`actorType` = 'system' AND `actorEmployeeId` IS NULL)),
	CONSTRAINT `chk_ae_correction` CHECK (`eventType` <> 'correction' OR `correctionOfEventId` IS NOT NULL OR `correctionRequestId` IS NOT NULL),
	CONSTRAINT `chk_ae_hash` CHECK (`payloadHash` REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `fk_acr_tenant_employee_target_event` FOREIGN KEY (`tenantId`,`employeeId`,`targetEventId`) REFERENCES `attendance_events`(`tenantId`,`employeeId`,`id`);

-- ROLLBACK قبل أي استخدام — فقط عبر: scripts/migrate-0042-attendance --rollback (يتحقق أن الجداول الخمسة فارغة):
--   ALTER TABLE `attendance_correction_requests` DROP FOREIGN KEY `fk_acr_tenant_employee_target_event`;
--   DROP TABLE `attendance_events`; DROP TABLE `attendance_correction_requests`;
--   DROP TABLE `attendance_days`; DROP TABLE `attendance_assignments`; DROP TABLE `attendance_shifts`;
