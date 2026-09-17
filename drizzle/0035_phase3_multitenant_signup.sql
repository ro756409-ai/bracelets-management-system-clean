-- Phase 3.1 — Multi-tenant signup & platform admin (DELTA ONLY, hand-authored, ADDITIVE)
--
-- ملاحظة مهمة: `drizzle-kit generate` بيطلّع فرقًا ملوّثًا لأن snapshots الـmeta قديمة ومش
-- متزامنة مع schema.ts (جداول كتير اتضافت للإنتاج عبر db:push بدون تحديث الـsnapshots). عشان
-- كده الملف ده **مكتوب بخط اليد** ويحتوي فقط على دلتا Phase 3.1 (4 جداول جديدة + أعمدة/enum
-- على tenants). **additive بحت — صفر تغيير على المصادقة الحالية.** يُطبَّق على matjarak_test أولًا.
--
-- ملاحظة: تغيير فريدة username لـ(businessId, username) اتأجّل لـP3.4 (يتطبّق مع login الجديد
-- businessSlug + username)، فمش موجود هنا عشان P3.1 يفضل additive بلا كسر للدخول الحالي.
--
-- Preflight قبل التطبيق (لازم صفر تعارضات):
--   * الجداول الأربعة مش موجودة مسبقًا (matjarak_test/إنتاج):
--       SHOW TABLES LIKE 'memberships'; ... (وهكذا)

-- ============ 1) جداول جديدة ============
CREATE TABLE `memberships` (
	`id` int AUTO_INCREMENT NOT NULL,
	`employeeId` int NOT NULL,
	`tenantId` int NOT NULL,
	`role` varchar(50) NOT NULL DEFAULT 'owner',
	`status` enum('active','suspended','invited') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `memberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `memberships_employee_tenant_unique` UNIQUE(`employeeId`,`tenantId`)
);
--> statement-breakpoint
CREATE TABLE `platform_admins` (
	`id` int AUTO_INCREMENT NOT NULL,
	`username` varchar(50) NOT NULL,
	`email` varchar(320),
	`passwordHash` varchar(255) NOT NULL,
	`mfaSecret` varchar(255),
	`isActive` boolean NOT NULL DEFAULT true,
	`lastLoginAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platform_admins_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_admins_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE TABLE `signup_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerName` varchar(150) NOT NULL,
	`businessName` varchar(150) NOT NULL,
	`phone` varchar(30) NOT NULL,
	`email` varchar(320) NOT NULL,
	`username` varchar(50) NOT NULL,
	`passwordHash` varchar(255) NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`rejectionReason` text,
	`reviewedByPlatformAdminId` int,
	`reviewedAt` timestamp,
	`createdTenantId` int,
	`createdBusinessId` int,
	`createdEmployeeId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `signup_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `platform_audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`platformAdminId` int,
	`action` varchar(50) NOT NULL,
	`targetType` varchar(50),
	`targetId` int,
	`details` text,
	`ipAddress` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `platform_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

-- ============ 2) فهارس الجداول الجديدة ============
CREATE INDEX `memberships_tenant_idx` ON `memberships` (`tenantId`);--> statement-breakpoint
CREATE INDEX `signup_requests_status_idx` ON `signup_requests` (`status`);--> statement-breakpoint
CREATE INDEX `signup_requests_email_idx` ON `signup_requests` (`email`);--> statement-breakpoint
CREATE INDEX `signup_requests_username_idx` ON `signup_requests` (`username`);--> statement-breakpoint
CREATE INDEX `platform_audit_logs_admin_idx` ON `platform_audit_logs` (`platformAdminId`);--> statement-breakpoint
CREATE INDEX `platform_audit_logs_action_idx` ON `platform_audit_logs` (`action`);--> statement-breakpoint

-- ============ 3) tenants: دورة حياة التجربة/الإيقاف (additive + توسيع enum) ============
ALTER TABLE `tenants` MODIFY COLUMN `status` enum('trialing','active','past_due','canceled','suspended','expired') NOT NULL DEFAULT 'trialing';--> statement-breakpoint
ALTER TABLE `tenants` ADD `trialStartsAt` timestamp;--> statement-breakpoint
ALTER TABLE `tenants` ADD `suspendedAt` timestamp;--> statement-breakpoint
ALTER TABLE `tenants` ADD `adminNotes` text;
