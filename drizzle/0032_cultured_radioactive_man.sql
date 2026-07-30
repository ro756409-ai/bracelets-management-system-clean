CREATE TABLE `expense_categories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`isSystem` boolean NOT NULL DEFAULT false,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `expense_categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `expense_categories_business_name_unique` UNIQUE(`businessId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`categoryId` int,
	`amount` decimal(10,2) NOT NULL,
	`description` text NOT NULL,
	`expenseDate` timestamp NOT NULL,
	`reference` varchar(100),
	`attachmentUrl` varchar(500),
	`createdBy` int NOT NULL,
	`createdByName` varchar(100) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `treasury_transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`type` enum('collection','refund','expense','deposit','withdrawal','adjustment') NOT NULL,
	`direction` enum('in','out') NOT NULL,
	`amount` decimal(10,2) NOT NULL,
	`balanceAfter` decimal(10,2) NOT NULL,
	`description` text NOT NULL,
	`notes` text,
	`referenceType` enum('order','expense','return','manual') NOT NULL DEFAULT 'manual',
	`referenceId` int,
	`performedBy` int NOT NULL,
	`performedByName` varchar(100) NOT NULL,
	`transactionDate` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `treasury_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `orders` ADD `collectedAmount` decimal(10,2);--> statement-breakpoint
ALTER TABLE `orders` ADD `collectedAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `collectionStatus` enum('pending','collected','partial','failed') DEFAULT 'pending' NOT NULL;