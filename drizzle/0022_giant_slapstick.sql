CREATE TABLE `import_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`label` varchar(150) NOT NULL,
	`source` varchar(100) NOT NULL,
	`status` enum('running','completed','failed','rolled_back') NOT NULL DEFAULT 'running',
	`totalRows` int NOT NULL DEFAULT 0,
	`importedCount` int NOT NULL DEFAULT 0,
	`skippedCount` int NOT NULL DEFAULT 0,
	`duplicateCount` int NOT NULL DEFAULT 0,
	`performedBy` int NOT NULL,
	`performedByName` varchar(100),
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`rolledBackAt` timestamp,
	`rolledBackBy` int,
	`errorSummary` text,
	CONSTRAINT `import_batches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `employees` MODIFY COLUMN `role` enum('agent','warehouse','manager','facebook_entry','scanner','super_admin','admin','data_entry','order_confirmation','shipping','accountant','viewer') NOT NULL DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `source` enum('easyorder','easyorder_ataba','easyorder_farhat','easyorder_flashbox','shopify','whatsapp','manual','facebook') NOT NULL DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE `employees` ADD `lastLoginAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `importBatchId` int;