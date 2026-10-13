-- 0051 — سجل دائم لحظر الكتابات المالية القديمة (V1/V2) ورفعه بعد التوقف والمطابقة. DELTA مكتوبة بخط اليد، ADDITIVE بحت:
-- جدول واحد جديد، بلا Backfill، ولا يغيّر أي جدول قائم. يتطلب 0040.
--   • stop_snapshot: صورة أرصدة V3 لحظة التوقف (figuresJson + بصمة sha256) — بفاعل مالك.
--   • lift: رفع الحظر لتفعيل محدد (activationAt = ledger_tenant_flags.enabledAt لحظتها) بمرجع صورة توقف (snapshotEventId).
--   • recovery: نتيجة إدخال أرصدة التوقف في V1/V2 (الفروق المرحّلة والتحقق بعدها) — في نفس transaction الرفع.
--   • reapply: إعادة الحظر داخل transaction تفعيل V3 (الفاعل قد يكون نظامًا ⇒ actorEmployeeId NULL مسموح هنا فقط).
-- الحالة = آخر حدث (بالمعرّف) من lift/reapply: مرفوع فقط إن كان lift لنفس التفعيل الحالي. لا UPDATE/DELETE من التطبيق.
-- منع التكرار: UNIQUE(tenantId, dedupeKey) — lift:<snapshot> / recovery:<snapshot> / snapshot:<activation>:<hash> / reapply:<uuid>.
-- CHECK: كل تعبير بلا UNKNOWN. يتطلب MySQL ≥ 8.0.16. لا يُشغَّل إلا عبر scripts/migrate-0051-ledger-legacy-archive، وفي هذه
-- المرحلة على Docker محلي مؤقت فقط. التراجع مرفوض متى وُجد أي حدث (المحرّك يشترط الجدول فارغًا).

CREATE TABLE `ledger_legacy_archive_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`action` enum('stop_snapshot','lift','recovery','reapply') NOT NULL,
	`activationAt` timestamp NOT NULL,
	`dedupeKey` varchar(120) NOT NULL,
	`snapshotEventId` int NULL,
	`figuresJson` json NULL,
	`figuresHash` char(64) NULL,
	`reason` varchar(500) NOT NULL,
	`actorEmployeeId` int NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_legacy_archive_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `llae_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `llae_tenant_dedupe_unique` UNIQUE(`tenantId`,`dedupeKey`),
	CONSTRAINT `fk_llae_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_llae_tenant_snapshot` FOREIGN KEY (`tenantId`,`snapshotEventId`) REFERENCES `ledger_legacy_archive_events`(`tenantId`,`id`),
	CONSTRAINT `fk_llae_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_llae_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3),
	CONSTRAINT `chk_llae_actor` CHECK (`action` = 'reapply' OR `actorEmployeeId` IS NOT NULL),
	CONSTRAINT `chk_llae_shape` CHECK (
		(`action` = 'stop_snapshot' AND `snapshotEventId` IS NULL AND `figuresJson` IS NOT NULL AND `figuresHash` IS NOT NULL)
		OR (`action` = 'lift' AND `snapshotEventId` IS NOT NULL AND `figuresJson` IS NULL AND `figuresHash` IS NOT NULL)
		OR (`action` = 'recovery' AND `snapshotEventId` IS NOT NULL AND `figuresJson` IS NOT NULL AND `figuresHash` IS NOT NULL)
		OR (`action` = 'reapply' AND `snapshotEventId` IS NULL AND `figuresJson` IS NULL AND `figuresHash` IS NULL)),
	CONSTRAINT `chk_llae_hash` CHECK (`figuresHash` IS NULL OR REGEXP_LIKE(`figuresHash`, '^[0-9a-f]{64}$', 'c'))
);
