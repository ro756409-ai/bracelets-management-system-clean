-- 0043 — مركز الرسائل. DELTA مكتوبة بخط اليد، ADDITIVE بحت: 9 جداول جديدة، بلا تعديل أي جدول قائم.
-- يعتمد على الفهرسين المركّبين businesses_tenant_id/employees_tenant_id (ينشئهما 0040 أو 0041) — الـpreflight يرفض بدونهما.
-- غير مضاف إلى drizzle journal. لا يُشغَّل إلا عبر scripts/migrate-0043-messaging، وفي هذه المرحلة على Docker محلي مؤقت فقط.
--
-- العزل: كل جدول يحمل tenantId، وكل ربط بمحادثة/رسالة/موظف/نشاط FK مركّب يبدأ بـtenantId — يستحيل ربط صف بشركة أخرى.
--   الرد على رسالة: (tenantId, conversationId, replyToMessageId) → msg_messages(tenantId, conversationId, id) = نفس المحادثة فقط.
-- المحادثات الفريدة: uniqueKey = 'announcement' | 'team' | 'business:<id>' | 'direct:<أصغر>:<أكبر>'، والمجموعة NULL.
-- الحذف: ناعم (deletedAt) والنص السابق يُحفظ في msg_message_edits قبل أي تعديل أو حذف. لا DELETE في أي مسار كود.
-- المرفقات: حتى 10 ميجا؛ الصوت حتى 5 دقائق؛ expiresAt = NULL يعني «لا يُحذف» (الإعلانات المثبّتة).
-- الوقت: كل الطوابع timestamp(3)؛ الخدمة تضبط time_zone='+00:00' لكل معاملة.
-- CHECK: كل تعبير بلا UNKNOWN (شروط IS [NOT] NULL صريحة). يتطلب MySQL ≥ 8.0.16.

CREATE TABLE `msg_conversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`kind` enum('announcement','team','business','group','direct') NOT NULL,
	`businessId` int NULL,
	`title` varchar(120) NULL,
	`uniqueKey` varchar(40) NULL,
	`createdByEmployeeId` int NULL,
	`lastMessageId` int NULL,
	`lastMessageAt` timestamp(3) NULL,
	`isArchived` tinyint(1) NOT NULL DEFAULT 0,
	`idempotencyKey` varchar(100) NULL,
	`payloadHash` char(64) NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `msg_conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `msc_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `msc_tenant_key_unique` UNIQUE(`tenantId`,`uniqueKey`),
	CONSTRAINT `msc_tenant_idempotency_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	INDEX `msc_tenant_last` (`tenantId`,`lastMessageAt`),
	CONSTRAINT `fk_msc_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_msc_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_msc_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_msc_kind` CHECK (
		(`kind` = 'announcement' AND `businessId` IS NULL AND `uniqueKey` IS NOT NULL AND `uniqueKey` = 'announcement')
		OR (`kind` = 'team' AND `businessId` IS NULL AND `uniqueKey` IS NOT NULL AND `uniqueKey` = 'team')
		OR (`kind` = 'business' AND `businessId` IS NOT NULL AND `uniqueKey` IS NOT NULL AND `uniqueKey` = CONCAT('business:', `businessId`))
		OR (`kind` = 'group' AND `businessId` IS NULL AND `uniqueKey` IS NULL AND `title` IS NOT NULL AND CHAR_LENGTH(TRIM(`title`)) >= 1 AND `createdByEmployeeId` IS NOT NULL)
		OR (`kind` = 'direct' AND `businessId` IS NULL AND `uniqueKey` IS NOT NULL AND `uniqueKey` LIKE 'direct:%' AND `createdByEmployeeId` IS NOT NULL)),
	CONSTRAINT `chk_msc_idem` CHECK ((`idempotencyKey` IS NULL AND `payloadHash` IS NULL) OR (`idempotencyKey` IS NOT NULL AND `payloadHash` IS NOT NULL AND `kind` = 'group'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `msg_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`conversationId` int NOT NULL,
	`employeeId` int NOT NULL,
	`role` enum('member','admin') NOT NULL DEFAULT 'member',
	`lastReadMessageId` int NULL,
	`joinedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`leftAt` timestamp(3) NULL,
	CONSTRAINT `msg_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `msm_tenant_conv_employee_unique` UNIQUE(`tenantId`,`conversationId`,`employeeId`),
	INDEX `msm_tenant_employee` (`tenantId`,`employeeId`),
	CONSTRAINT `fk_msm_tenant_conversation` FOREIGN KEY (`tenantId`,`conversationId`) REFERENCES `msg_conversations`(`tenantId`,`id`),
	CONSTRAINT `fk_msm_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `msg_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`conversationId` int NOT NULL,
	`senderEmployeeId` int NULL,
	`kind` enum('text','voice','attachment','system','announcement') NOT NULL,
	`title` varchar(160) NULL,
	`body` text NULL,
	`replyToMessageId` int NULL,
	`orderId` int NULL,
	`isPinned` tinyint(1) NOT NULL DEFAULT 0,
	`editedAt` timestamp(3) NULL,
	`deletedAt` timestamp(3) NULL,
	`deletedByEmployeeId` int NULL,
	`idempotencyKey` varchar(100) NULL,
	`payloadHash` char(64) NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `msg_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `mmg_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `mmg_tenant_conv_id_unique` UNIQUE(`tenantId`,`conversationId`,`id`),
	CONSTRAINT `mmg_tenant_idempotency_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	INDEX `mmg_tenant_conv_created` (`tenantId`,`conversationId`,`createdAt`),
	CONSTRAINT `fk_mmg_tenant_conversation` FOREIGN KEY (`tenantId`,`conversationId`) REFERENCES `msg_conversations`(`tenantId`,`id`),
	CONSTRAINT `fk_mmg_tenant_sender` FOREIGN KEY (`tenantId`,`senderEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_mmg_tenant_deleter` FOREIGN KEY (`tenantId`,`deletedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_mmg_tenant_conv_reply` FOREIGN KEY (`tenantId`,`conversationId`,`replyToMessageId`) REFERENCES `msg_messages`(`tenantId`,`conversationId`,`id`),
	CONSTRAINT `chk_mmg_sender` CHECK ((`kind` = 'system' AND `senderEmployeeId` IS NULL) OR (`kind` <> 'system' AND `senderEmployeeId` IS NOT NULL)),
	CONSTRAINT `chk_mmg_body` CHECK (
		`deletedAt` IS NOT NULL
		OR (`kind` IN ('text','system') AND `body` IS NOT NULL AND CHAR_LENGTH(TRIM(`body`)) >= 1 AND `title` IS NULL)
		OR (`kind` = 'announcement' AND `body` IS NOT NULL AND CHAR_LENGTH(TRIM(`body`)) >= 1 AND `title` IS NOT NULL AND CHAR_LENGTH(TRIM(`title`)) >= 1)
		OR (`kind` = 'voice' AND `body` IS NULL AND `title` IS NULL)
		OR (`kind` = 'attachment' AND `title` IS NULL)),
	CONSTRAINT `chk_mmg_body_len` CHECK (`body` IS NULL OR CHAR_LENGTH(`body`) <= 4000),
	CONSTRAINT `chk_mmg_delete` CHECK ((`deletedAt` IS NULL AND `deletedByEmployeeId` IS NULL) OR (`deletedAt` IS NOT NULL AND `deletedByEmployeeId` IS NOT NULL)),
	CONSTRAINT `chk_mmg_pin` CHECK (`isPinned` = 0 OR `kind` = 'announcement'),
	CONSTRAINT `chk_mmg_idem` CHECK ((`idempotencyKey` IS NULL AND `payloadHash` IS NULL) OR (`idempotencyKey` IS NOT NULL AND `payloadHash` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `msg_message_edits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`messageId` int NOT NULL,
	`editorEmployeeId` int NOT NULL,
	`action` enum('edit','delete') NOT NULL,
	`previousTitle` varchar(160) NULL,
	`previousBody` text NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `msg_message_edits_id` PRIMARY KEY(`id`),
	INDEX `mme_tenant_message` (`tenantId`,`messageId`,`id`),
	CONSTRAINT `fk_mme_tenant_message` FOREIGN KEY (`tenantId`,`messageId`) REFERENCES `msg_messages`(`tenantId`,`id`),
	CONSTRAINT `fk_mme_tenant_editor` FOREIGN KEY (`tenantId`,`editorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `msg_attachments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`messageId` int NOT NULL,
	`kind` enum('image','file','voice') NOT NULL,
	`storageKey` varchar(255) NOT NULL,
	`mime` varchar(100) NOT NULL,
	`bytes` int unsigned NOT NULL,
	`width` smallint unsigned NULL,
	`height` smallint unsigned NULL,
	`durationMs` int unsigned NULL,
	`waveformJson` json NULL,
	`expiresAt` timestamp(3) NULL,
	`purgedAt` timestamp(3) NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `msg_attachments_id` PRIMARY KEY(`id`),
	CONSTRAINT `mat_tenant_storage_unique` UNIQUE(`tenantId`,`storageKey`),
	INDEX `mat_tenant_message` (`tenantId`,`messageId`),
	INDEX `mat_expires` (`expiresAt`,`purgedAt`),
	CONSTRAINT `fk_mat_tenant_message` FOREIGN KEY (`tenantId`,`messageId`) REFERENCES `msg_messages`(`tenantId`,`id`),
	CONSTRAINT `chk_mat_bytes` CHECK (`bytes` BETWEEN 1 AND 10485760),
	CONSTRAINT `chk_mat_voice` CHECK ((`kind` = 'voice' AND `durationMs` IS NOT NULL AND `durationMs` BETWEEN 1 AND 300000) OR (`kind` <> 'voice' AND `durationMs` IS NULL)),
	CONSTRAINT `chk_mat_key` CHECK (CHAR_LENGTH(TRIM(`storageKey`)) >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `msg_reactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`messageId` int NOT NULL,
	`employeeId` int NOT NULL,
	`reaction` enum('like','done','heart','thanks') NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `msg_reactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `mrx_tenant_message_employee_reaction_unique` UNIQUE(`tenantId`,`messageId`,`employeeId`,`reaction`),
	CONSTRAINT `fk_mrx_tenant_message` FOREIGN KEY (`tenantId`,`messageId`) REFERENCES `msg_messages`(`tenantId`,`id`),
	CONSTRAINT `fk_mrx_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `msg_announcement_acks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`messageId` int NOT NULL,
	`employeeId` int NOT NULL,
	`ackedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `msg_announcement_acks_id` PRIMARY KEY(`id`),
	CONSTRAINT `mak_tenant_message_employee_unique` UNIQUE(`tenantId`,`messageId`,`employeeId`),
	CONSTRAINT `fk_mak_tenant_message` FOREIGN KEY (`tenantId`,`messageId`) REFERENCES `msg_messages`(`tenantId`,`id`),
	CONSTRAINT `fk_mak_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `msg_voice_listens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`messageId` int NOT NULL,
	`employeeId` int NOT NULL,
	`firstListenedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `msg_voice_listens_id` PRIMARY KEY(`id`),
	CONSTRAINT `mvl_tenant_message_employee_unique` UNIQUE(`tenantId`,`messageId`,`employeeId`),
	CONSTRAINT `fk_mvl_tenant_message` FOREIGN KEY (`tenantId`,`messageId`) REFERENCES `msg_messages`(`tenantId`,`id`),
	CONSTRAINT `fk_mvl_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `msg_access_audit` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`viewerEmployeeId` int NOT NULL,
	`conversationId` int NOT NULL,
	`action` enum('open','listen') NOT NULL,
	`messageId` int NULL,
	`viewedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `msg_access_audit_id` PRIMARY KEY(`id`),
	INDEX `maa_tenant_viewed` (`tenantId`,`viewedAt`),
	INDEX `maa_tenant_conversation` (`tenantId`,`conversationId`),
	CONSTRAINT `fk_maa_tenant_viewer` FOREIGN KEY (`tenantId`,`viewerEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_maa_tenant_conversation` FOREIGN KEY (`tenantId`,`conversationId`) REFERENCES `msg_conversations`(`tenantId`,`id`),
	CONSTRAINT `fk_maa_tenant_conv_message` FOREIGN KEY (`tenantId`,`conversationId`,`messageId`) REFERENCES `msg_messages`(`tenantId`,`conversationId`,`id`),
	CONSTRAINT `chk_maa_listen` CHECK ((`action` = 'open' AND `messageId` IS NULL) OR (`action` = 'listen' AND `messageId` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
