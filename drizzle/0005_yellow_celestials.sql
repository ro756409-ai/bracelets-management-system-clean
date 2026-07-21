CREATE TABLE `merge_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`keptOrderId` int NOT NULL,
	`keptOrderNumber` varchar(50) NOT NULL,
	`customerName` varchar(200),
	`customerPhone` varchar(30),
	`productName` varchar(200),
	`mergedQty` int NOT NULL,
	`totalQtyAfter` int NOT NULL,
	`source` varchar(50) DEFAULT 'easyorder',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `merge_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `status` enum('new','confirmed','postponed','cancelled','preparing','shipped','delivered','no_answer') NOT NULL DEFAULT 'new';