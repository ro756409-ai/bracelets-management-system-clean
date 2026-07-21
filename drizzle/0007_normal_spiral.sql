CREATE TABLE `returns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderId` int NOT NULL,
	`orderNumber` varchar(20) NOT NULL,
	`customerName` varchar(100) NOT NULL,
	`customerPhone` varchar(20) NOT NULL,
	`governorate` varchar(50) NOT NULL,
	`productId` int NOT NULL,
	`productName` varchar(200) NOT NULL,
	`quantity` int NOT NULL,
	`totalAmount` decimal(10,2) NOT NULL,
	`returnReason` enum('customer_refused','wrong_product','damaged','wrong_address','customer_not_available','other') NOT NULL,
	`notes` text,
	`stockRestored` boolean NOT NULL DEFAULT false,
	`processedBy` int,
	`returnedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `returns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `status` enum('new','confirmed','postponed','cancelled','preparing','shipped','delivered','no_answer','returned') NOT NULL DEFAULT 'new';--> statement-breakpoint
ALTER TABLE `orders` ADD `easyOrderShortId` int;