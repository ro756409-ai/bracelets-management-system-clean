CREATE TABLE `print_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`printType` enum('shipping_sheet','labels') NOT NULL DEFAULT 'shipping_sheet',
	`orderIds` text NOT NULL,
	`orderCount` int NOT NULL,
	`printedBy` int NOT NULL,
	`printedByName` varchar(100) NOT NULL,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `print_logs_id` PRIMARY KEY(`id`)
);
