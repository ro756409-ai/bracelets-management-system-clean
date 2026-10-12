-- 0050 — صورة ثابتة لأرقام الشهر عند الإقفال (المرحلة 7). DELTA مكتوبة بخط اليد، ADDITIVE بحت: جدول واحد جديد، بلا Backfill.
-- يتطلب 0040. صف لكل إقفال (إصدار متزايد لكل شهر) — إعادة الفتح لا تحذف أي إصدار، والإقفال التالي ينشئ إصدارًا جديدًا.
--   • (tenantId, period) → ledger_periods(tenantId, period) (الفهرس الفريد من 0040)؛ lockEventId → حدث الإقفال نفسه، فريد.
--   • figuresJson: قائمة الدخل/المركز/أرصدة الحسابات المحسوبة لحظة الإقفال؛ checklistJson: نتيجة قائمة الفحص؛
--     figuresHash = sha256 للأرقام (تحقق لاحق أن الصورة لم تتغير).
-- CHECK: كل تعبير بلا UNKNOWN. يتطلب MySQL ≥ 8.0.16. لا يُشغَّل إلا عبر scripts/migrate-0050-ledger-snapshots، وفي هذه المرحلة
-- على Docker محلي مؤقت فقط.

CREATE TABLE `ledger_period_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`period` char(7) NOT NULL,
	`version` int NOT NULL,
	`lockEventId` int NOT NULL,
	`figuresJson` json NOT NULL,
	`checklistJson` json NOT NULL,
	`figuresHash` char(64) NOT NULL,
	`createdByEmployeeId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_period_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `lps_tenant_period_version_unique` UNIQUE(`tenantId`,`period`,`version`),
	CONSTRAINT `lps_lock_event_unique` UNIQUE(`lockEventId`),
	CONSTRAINT `fk_lps_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lps_tenant_period` FOREIGN KEY (`tenantId`,`period`) REFERENCES `ledger_periods`(`tenantId`,`period`),
	CONSTRAINT `fk_lps_lock_event` FOREIGN KEY (`lockEventId`) REFERENCES `ledger_period_events`(`id`),
	CONSTRAINT `fk_lps_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_lps_version` CHECK (`version` >= 1),
	CONSTRAINT `chk_lps_period` CHECK (REGEXP_LIKE(`period`, '^[0-9]{4}-(0[1-9]|1[0-2])$', 'c')),
	CONSTRAINT `chk_lps_hash` CHECK (REGEXP_LIKE(`figuresHash`, '^[0-9a-f]{64}$', 'c'))
);
