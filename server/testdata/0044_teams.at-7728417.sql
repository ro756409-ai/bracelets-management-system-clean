-- 0044 — الفرق التشغيلية والقيادة المؤرخة. DELTA مكتوبة بخط اليد، ADDITIVE بحت: جدولان جديدان، بلا FK لاحق.
-- يعتمد على الفهرسين المركّبين businesses_tenant_id/employees_tenant_id (ينشئهما 0040 أو 0041) — الـpreflight يرفض بدونهما.
-- لا تعديل على orders ولا tasks ولا أي جدول قائم. لا Backfill ولا Seed. لا حذف في أي مسار كود. غير مضاف إلى drizzle journal.
--
-- القرارات المعتمدة (2026-10-10):
--   • فريق تشغيلي نشط واحد لكل Business؛ الإيقاف نهائي (لا إعادة تفعيل — فريق جديد بدلًا منه) ولا حذف.
--   • القيادة = صف عضوية بدور 'leader' (لا Role جديد ولا عمود قائد في teams): الصف المؤرخ هو مصدر الحقيقة.
--   • الفترات Timestamp(3) UTC نصف مفتوحة: effectiveFromAt <= t AND (effectiveToAt IS NULL OR t < effectiveToAt).
--     تغيير القائد/النقل: إغلاق القديم وفتح الجديد في **نفس اللحظة** (متلامسة مسموحة، تداخل ولو بملّي ثانية مرفوض).
--   • activatedAt صريح (وقت بدء التشغيل الفعلي) ومستقل عن createdAt (وقت كتابة السجل).
--
-- منع التداخل مع الاحتفاظ بالتاريخ (MySQL بلا UNIQUE جزئي):
--   طبقة 1 (القاعدة): أعمدة مولّدة STORED = NULL للصف المنتهي/الموقوف، والفهرس الفريد يتجاهل NULL:
--     teams.activeBusinessId            → UNIQUE(tenantId, activeBusinessId)          فريق نشط واحد لكل نشاط
--     team_memberships.openMemberTeamId → UNIQUE(tenantId, employeeId, openMemberTeamId) عضوية مفتوحة واحدة للموظف في الفريق
--     team_memberships.openLeaderTeamId → UNIQUE(tenantId, openLeaderTeamId)          قائد مفتوح واحد لكل فريق
--   طبقة 2 (الخدمة، مرحلة لاحقة): التداخل التاريخي للفترات المغلقة داخل معاملة بقفل صف الفريق FOR UPDATE.
--
-- Idempotency: كل صف يحمل مفتاح العملية التي أنشأته (NOT NULL)؛ الإغلاق يحمل مفتاح عملية الإغلاق
--   (teams.deactivation*، team_memberships.end*) — مقيّدة كلها بـCHECK مع حقول الحالة. الأحرف المسموحة في المفاتيح
--   [A-Za-z0-9_:#-] بطول 8..191، والبصمة sha256 hex صغيرة (REGEXP_LIKE حساس لحالة الأحرف).
-- معرّفات الفاعلين (created/assigned/ended/deactivated By) موجبة وموجودة في employees لنفس الـtenant — لا الهوية
--   السالبة لجلسة الإدارة (CHECK > 0 + FK مركّب).
-- CHECK: كل تعبير بلا UNKNOWN (شروط IS [NOT] NULL صريحة). يتطلب MySQL ≥ 8.0.16.
-- لا يُشغَّل إلا عبر scripts/migrate-0044-teams، وفي هذه المرحلة على قواعد Docker محلية مؤقتة فقط.

CREATE TABLE `teams` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`isActive` tinyint(1) NOT NULL DEFAULT 1,
	`activeBusinessId` int GENERATED ALWAYS AS (CASE WHEN `isActive` = 1 THEN `businessId` END) STORED,
	`activatedAt` timestamp(3) NOT NULL,
	`deactivatedAt` timestamp(3) NULL,
	`deactivatedByEmployeeId` int NULL,
	`createdByEmployeeId` int NOT NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`deactivationIdempotencyKey` varchar(191) NULL,
	`deactivationPayloadHash` char(64) NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `teams_id` PRIMARY KEY(`id`),
	CONSTRAINT `tm_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `tm_tenant_active_business_unique` UNIQUE(`tenantId`,`activeBusinessId`),
	CONSTRAINT `tm_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `tm_tenant_deact_idem_unique` UNIQUE(`tenantId`,`deactivationIdempotencyKey`),
	INDEX `tm_tenant_business_activated` (`tenantId`,`businessId`,`activatedAt`),
	CONSTRAINT `fk_tm_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_tm_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_tm_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_tm_tenant_deactivator` FOREIGN KEY (`tenantId`,`deactivatedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_tm_name` CHECK (CHAR_LENGTH(TRIM(`name`)) >= 1 AND REGEXP_LIKE(`name`, '[^[:space:]]')),
	CONSTRAINT `chk_tm_active_flag` CHECK (`isActive` IN (0, 1)),
	CONSTRAINT `chk_tm_state` CHECK (
		(`isActive` = 1 AND `deactivatedAt` IS NULL AND `deactivatedByEmployeeId` IS NULL AND `deactivationIdempotencyKey` IS NULL AND `deactivationPayloadHash` IS NULL)
		OR (`isActive` = 0 AND `deactivatedAt` IS NOT NULL AND `deactivatedByEmployeeId` IS NOT NULL AND `deactivationIdempotencyKey` IS NOT NULL AND `deactivationPayloadHash` IS NOT NULL)),
	CONSTRAINT `chk_tm_deact_time` CHECK (`deactivatedAt` IS NULL OR `deactivatedAt` >= `activatedAt`),
	CONSTRAINT `chk_tm_actor_ids` CHECK (`createdByEmployeeId` > 0 AND (`deactivatedByEmployeeId` IS NULL OR `deactivatedByEmployeeId` > 0)),
	CONSTRAINT `chk_tm_keys` CHECK (REGEXP_LIKE(`idempotencyKey`, '^[A-Za-z0-9_:#-]{8,191}$', 'c')
		AND (`deactivationIdempotencyKey` IS NULL OR REGEXP_LIKE(`deactivationIdempotencyKey`, '^[A-Za-z0-9_:#-]{8,191}$', 'c'))),
	CONSTRAINT `chk_tm_hash` CHECK (REGEXP_LIKE(`payloadHash`, '^[0-9a-f]{64}$', 'c')
		AND (`deactivationPayloadHash` IS NULL OR REGEXP_LIKE(`deactivationPayloadHash`, '^[0-9a-f]{64}$', 'c')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `team_memberships` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`teamId` int NOT NULL,
	`employeeId` int NOT NULL,
	`membershipRole` enum('member','leader') NOT NULL,
	`effectiveFromAt` timestamp(3) NOT NULL,
	`effectiveToAt` timestamp(3) NULL,
	`openMemberTeamId` int GENERATED ALWAYS AS (CASE WHEN `effectiveToAt` IS NULL THEN `teamId` END) STORED,
	`openLeaderTeamId` int GENERATED ALWAYS AS (CASE WHEN `effectiveToAt` IS NULL AND `membershipRole` = 'leader' THEN `teamId` END) STORED,
	`assignedByEmployeeId` int NOT NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`endedByEmployeeId` int NULL,
	`endedAt` timestamp(3) NULL,
	`endIdempotencyKey` varchar(191) NULL,
	`endPayloadHash` char(64) NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `team_memberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `tmb_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `tmb_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `tmb_tenant_end_idem_unique` UNIQUE(`tenantId`,`endIdempotencyKey`),
	CONSTRAINT `tmb_tenant_employee_open_unique` UNIQUE(`tenantId`,`employeeId`,`openMemberTeamId`),
	CONSTRAINT `tmb_tenant_open_leader_unique` UNIQUE(`tenantId`,`openLeaderTeamId`),
	INDEX `tmb_tenant_team_from` (`tenantId`,`teamId`,`effectiveFromAt`),
	INDEX `tmb_tenant_employee_from` (`tenantId`,`employeeId`,`effectiveFromAt`),
	INDEX `tmb_tenant_team_role_from` (`tenantId`,`teamId`,`membershipRole`,`effectiveFromAt`),
	CONSTRAINT `fk_tmb_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_tmb_tenant_team` FOREIGN KEY (`tenantId`,`teamId`) REFERENCES `teams`(`tenantId`,`id`),
	CONSTRAINT `fk_tmb_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_tmb_tenant_assigner` FOREIGN KEY (`tenantId`,`assignedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_tmb_tenant_ender` FOREIGN KEY (`tenantId`,`endedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_tmb_range` CHECK (`effectiveToAt` IS NULL OR `effectiveToAt` > `effectiveFromAt`),
	CONSTRAINT `chk_tmb_end` CHECK (
		(`effectiveToAt` IS NULL AND `endedAt` IS NULL AND `endedByEmployeeId` IS NULL AND `endIdempotencyKey` IS NULL AND `endPayloadHash` IS NULL)
		OR (`effectiveToAt` IS NOT NULL AND `endedAt` IS NOT NULL AND `endedByEmployeeId` IS NOT NULL AND `endIdempotencyKey` IS NOT NULL AND `endPayloadHash` IS NOT NULL)),
	CONSTRAINT `chk_tmb_ids` CHECK (`employeeId` > 0 AND `assignedByEmployeeId` > 0 AND (`endedByEmployeeId` IS NULL OR `endedByEmployeeId` > 0)),
	CONSTRAINT `chk_tmb_keys` CHECK (REGEXP_LIKE(`idempotencyKey`, '^[A-Za-z0-9_:#-]{8,191}$', 'c')
		AND (`endIdempotencyKey` IS NULL OR REGEXP_LIKE(`endIdempotencyKey`, '^[A-Za-z0-9_:#-]{8,191}$', 'c'))),
	CONSTRAINT `chk_tmb_hash` CHECK (REGEXP_LIKE(`payloadHash`, '^[0-9a-f]{64}$', 'c')
		AND (`endPayloadHash` IS NULL OR REGEXP_LIKE(`endPayloadHash`, '^[0-9a-f]{64}$', 'c')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ROLLBACK قبل أي استخدام — فقط عبر: scripts/migrate-0044-teams --rollback (يتحقق أن الجدولين فارغان):
--   DROP TABLE `team_memberships`; DROP TABLE `teams`;
