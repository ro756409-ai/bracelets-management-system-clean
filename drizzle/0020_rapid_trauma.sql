CREATE TABLE `scan_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderId` int NOT NULL,
	`serialNumber` varchar(30) NOT NULL,
	`scannedBy` int NOT NULL,
	`scannedByName` varchar(100) NOT NULL,
	`result` enum('success','failed','duplicate','cancelled') NOT NULL,
	`deviceInfo` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `scan_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `employees` MODIFY COLUMN `role` enum('agent','warehouse','manager','facebook_entry','scanner') NOT NULL DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE `orders` ADD `serialNumber` varchar(30);--> statement-breakpoint
ALTER TABLE `orders` ADD `isPrepared` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `preparedAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `preparedBy` int;--> statement-breakpoint
ALTER TABLE `orders` ADD `preparedByName` varchar(100);--> statement-breakpoint
ALTER TABLE `orders` ADD `scanCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `lastScannedAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_serialNumber_unique` UNIQUE(`serialNumber`);