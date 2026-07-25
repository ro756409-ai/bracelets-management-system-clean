CREATE TABLE `sync_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`channelId` int,
	`provider` varchar(30) NOT NULL,
	`trigger` enum('webhook','manual','retry') NOT NULL,
	`status` enum('running','success','partial','error') NOT NULL DEFAULT 'running',
	`rangeFrom` timestamp,
	`rangeTo` timestamp,
	`fetchedCount` int NOT NULL DEFAULT 0,
	`createdCount` int NOT NULL DEFAULT 0,
	`updatedCount` int NOT NULL DEFAULT 0,
	`duplicateCount` int NOT NULL DEFAULT 0,
	`needsReviewCount` int NOT NULL DEFAULT 0,
	`failedCount` int NOT NULL DEFAULT 0,
	`attempt` int NOT NULL DEFAULT 1,
	`errorMessage` text,
	`details` text,
	`durationMs` int,
	`performedBy` int,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	CONSTRAINT `sync_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `productId` int;--> statement-breakpoint
ALTER TABLE `returns` MODIFY COLUMN `productId` int;--> statement-breakpoint
ALTER TABLE `orders` ADD `externalRawPayload` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `externalUpdatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `needsReview` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `reviewReason` text;--> statement-breakpoint
ALTER TABLE `sales_channels` ADD `apiBaseUrl` varchar(300);--> statement-breakpoint
ALTER TABLE `sales_channels` ADD `lastSyncAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_channels` ADD `lastSyncStatus` enum('never','success','error') DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_channels` ADD `lastSyncError` text;--> statement-breakpoint
ALTER TABLE `sales_channels` ADD `lastSyncedOrderCount` int DEFAULT 0 NOT NULL;