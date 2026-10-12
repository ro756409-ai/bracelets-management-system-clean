-- 0048 — المرتبات والسلف في Ledger V3 (المرحلة 5). DELTA مكتوبة بخط اليد، ADDITIVE بحت: أربعة جداول جديدة، بلا Backfill ولا Seed،
-- ولا تعديل على payroll_* أو employee_advances القديمة (V1/V2 تبقى أرشيفًا كما هي). يتطلب 0040 والفهرسين المركّبين.
--   • ledger_payroll_runs: دورة شهرية draft → approved (قيد استحقاق) → paid (قيد دفع) أو cancelled (قيود عكسية).
--     activePeriod عمود مولّد = الشهر للدورة غير الملغاة فقط ⇒ UNIQUE(tenantId, activePeriod) دورة نشطة واحدة لكل شهر،
--     وإعادة الدورة بعد الإلغاء ممكنة دون حذف التاريخ.
--   • ledger_payroll_lines: سطر لكل موظف في الدورة بمدخلات مجمّدة (inputsJson) ونتيجة المحرك (resultJson).
--   • ledger_advances / ledger_advance_installments: سلفة بأقساط ورصيد؛ القسط «مخصوم» مرتبط بدورة واحدة بالضبط (CHECK)،
--     والجزء غير المخصوم يُرحّل قسطًا جديدًا — لا خصم مرتين ولا إسقاط صامت.
-- معرّفات الفاعلين موجبة ومربوطة بموظفي نفس الشركة؛ القيود عبر (tenantId, id) في ledger_transactions.
-- CHECK: كل تعبير بلا UNKNOWN. يتطلب MySQL ≥ 8.0.16. لا يُشغَّل إلا عبر scripts/migrate-0048-ledger-payroll، وفي هذه المرحلة
-- على Docker محلي مؤقت فقط.

CREATE TABLE `ledger_payroll_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`period` char(7) NOT NULL,
	`status` enum('draft','approved','paid','cancelled') NOT NULL DEFAULT 'draft',
	`activePeriod` char(7) GENERATED ALWAYS AS (CASE WHEN `status` <> 'cancelled' THEN `period` END) STORED,
	`gross` decimal(18,4) NOT NULL DEFAULT 0,
	`totalDeductions` decimal(18,4) NOT NULL DEFAULT 0,
	`net` decimal(18,4) NOT NULL DEFAULT 0,
	`accrualTransactionId` int NULL,
	`paymentTransactionId` int NULL,
	`createdByEmployeeId` int NOT NULL,
	`approvedByEmployeeId` int NULL,
	`approvedAt` timestamp(3) NULL,
	`paidByEmployeeId` int NULL,
	`paidAt` timestamp(3) NULL,
	`cancelledByEmployeeId` int NULL,
	`cancelledAt` timestamp(3) NULL,
	`cancelReason` varchar(500) NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_payroll_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `lpr_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `lpr_tenant_active_period_unique` UNIQUE(`tenantId`,`activePeriod`),
	CONSTRAINT `lpr_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	INDEX `lpr_tenant_period` (`tenantId`,`period`),
	CONSTRAINT `fk_lpr_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lpr_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_lpr_tenant_approver` FOREIGN KEY (`tenantId`,`approvedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_lpr_tenant_payer` FOREIGN KEY (`tenantId`,`paidByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_lpr_tenant_canceller` FOREIGN KEY (`tenantId`,`cancelledByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_lpr_tenant_accrual` FOREIGN KEY (`tenantId`,`accrualTransactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_lpr_tenant_payment` FOREIGN KEY (`tenantId`,`paymentTransactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `chk_lpr_period` CHECK (REGEXP_LIKE(`period`, '^[0-9]{4}-(0[1-9]|1[0-2])$', 'c')),
	CONSTRAINT `chk_lpr_amounts` CHECK (`gross` >= 0 AND `totalDeductions` >= 0 AND `net` >= 0 AND `gross` - `totalDeductions` = `net`),
	CONSTRAINT `chk_lpr_approved` CHECK ((`approvedAt` IS NULL AND `approvedByEmployeeId` IS NULL AND `accrualTransactionId` IS NULL) OR (`approvedAt` IS NOT NULL AND `approvedByEmployeeId` IS NOT NULL AND `accrualTransactionId` IS NOT NULL)),
	CONSTRAINT `chk_lpr_paid` CHECK ((`paidAt` IS NULL AND `paidByEmployeeId` IS NULL AND `paymentTransactionId` IS NULL) OR (`paidAt` IS NOT NULL AND `paidByEmployeeId` IS NOT NULL AND `paymentTransactionId` IS NOT NULL AND `approvedAt` IS NOT NULL)),
	CONSTRAINT `chk_lpr_cancelled` CHECK ((`status` = 'cancelled' AND `cancelledAt` IS NOT NULL AND `cancelledByEmployeeId` IS NOT NULL AND `cancelReason` IS NOT NULL AND CHAR_LENGTH(TRIM(`cancelReason`)) >= 3)
		OR (`status` <> 'cancelled' AND `cancelledAt` IS NULL AND `cancelledByEmployeeId` IS NULL AND `cancelReason` IS NULL)),
	CONSTRAINT `chk_lpr_state` CHECK ((`status` = 'draft' AND `approvedAt` IS NULL AND `paidAt` IS NULL) OR (`status` = 'approved' AND `approvedAt` IS NOT NULL AND `paidAt` IS NULL)
		OR (`status` = 'paid' AND `paidAt` IS NOT NULL) OR `status` = 'cancelled'),
	CONSTRAINT `chk_lpr_key` CHECK (REGEXP_LIKE(`idempotencyKey`, '^[A-Za-z0-9_:#.-]{8,191}$', 'c'))
);
--> statement-breakpoint
CREATE TABLE `ledger_payroll_lines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`runId` int NOT NULL,
	`employeeId` int NOT NULL,
	`businessId` int NULL,
	`inputsJson` json NOT NULL,
	`resultJson` json NOT NULL,
	`gross` decimal(18,4) NOT NULL,
	`totalDeductions` decimal(18,4) NOT NULL,
	`net` decimal(18,4) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_payroll_lines_id` PRIMARY KEY(`id`),
	CONSTRAINT `lpl_run_employee_unique` UNIQUE(`runId`,`employeeId`),
	CONSTRAINT `lpl_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `fk_lpl_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lpl_tenant_run` FOREIGN KEY (`tenantId`,`runId`) REFERENCES `ledger_payroll_runs`(`tenantId`,`id`),
	CONSTRAINT `fk_lpl_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_lpl_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `chk_lpl_amounts` CHECK (`gross` >= 0 AND `totalDeductions` >= 0 AND `net` >= 0 AND `gross` - `totalDeductions` = `net`)
);
--> statement-breakpoint
CREATE TABLE `ledger_advances` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`employeeId` int NOT NULL,
	`businessId` int NULL,
	`principal` decimal(18,4) NOT NULL,
	`issuedOn` date NOT NULL,
	`installmentsCount` int NOT NULL,
	`status` enum('active','settled','cancelled') NOT NULL DEFAULT 'active',
	`issueTransactionId` int NOT NULL,
	`cancelTransactionId` int NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`createdByEmployeeId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_advances_id` PRIMARY KEY(`id`),
	CONSTRAINT `lad_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `lad_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	INDEX `lad_tenant_employee_status` (`tenantId`,`employeeId`,`status`),
	CONSTRAINT `fk_lad_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lad_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_lad_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_lad_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_lad_tenant_issue` FOREIGN KEY (`tenantId`,`issueTransactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `fk_lad_tenant_cancel` FOREIGN KEY (`tenantId`,`cancelTransactionId`) REFERENCES `ledger_transactions`(`tenantId`,`id`),
	CONSTRAINT `chk_lad_principal` CHECK (`principal` > 0),
	CONSTRAINT `chk_lad_installments` CHECK (`installmentsCount` BETWEEN 1 AND 60),
	CONSTRAINT `chk_lad_cancel` CHECK ((`status` = 'cancelled' AND `cancelTransactionId` IS NOT NULL) OR (`status` <> 'cancelled' AND `cancelTransactionId` IS NULL)),
	CONSTRAINT `chk_lad_key` CHECK (REGEXP_LIKE(`idempotencyKey`, '^[A-Za-z0-9_:#.-]{8,191}$', 'c'))
);
--> statement-breakpoint
CREATE TABLE `ledger_advance_installments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`advanceId` int NOT NULL,
	`seq` int NOT NULL,
	`dueMonth` char(7) NOT NULL,
	`amount` decimal(18,4) NOT NULL,
	`status` enum('pending','deducted','cancelled') NOT NULL DEFAULT 'pending',
	`payrollRunId` int NULL,
	`deductedAmount` decimal(18,4) NOT NULL DEFAULT 0,
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `ledger_advance_installments_id` PRIMARY KEY(`id`),
	CONSTRAINT `lai_advance_seq_unique` UNIQUE(`advanceId`,`seq`),
	CONSTRAINT `lai_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `lai_tenant_due_status` (`tenantId`,`dueMonth`,`status`),
	CONSTRAINT `fk_lai_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_lai_tenant_advance` FOREIGN KEY (`tenantId`,`advanceId`) REFERENCES `ledger_advances`(`tenantId`,`id`),
	CONSTRAINT `fk_lai_tenant_run` FOREIGN KEY (`tenantId`,`payrollRunId`) REFERENCES `ledger_payroll_runs`(`tenantId`,`id`),
	CONSTRAINT `chk_lai_amount` CHECK (`amount` > 0 AND `deductedAmount` >= 0 AND `deductedAmount` <= `amount`),
	CONSTRAINT `chk_lai_due` CHECK (REGEXP_LIKE(`dueMonth`, '^[0-9]{4}-(0[1-9]|1[0-2])$', 'c')),
	CONSTRAINT `chk_lai_state` CHECK ((`status` = 'deducted' AND `payrollRunId` IS NOT NULL AND `deductedAmount` > 0) OR (`status` <> 'deducted' AND `payrollRunId` IS NULL AND `deductedAmount` = 0))
);
