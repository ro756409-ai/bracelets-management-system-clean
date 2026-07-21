CREATE TABLE `webhook_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`eventType` varchar(50) NOT NULL,
	`status` enum('success','duplicate','error','status_update') NOT NULL,
	`externalOrderId` varchar(100),
	`customerName` varchar(200),
	`customerPhone` varchar(30),
	`governorate` varchar(100),
	`totalAmount` decimal(10,2),
	`itemsCount` int,
	`importedCount` int,
	`rawPayload` text,
	`message` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `webhook_logs_id` PRIMARY KEY(`id`)
);
