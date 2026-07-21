CREATE TABLE `activity_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`action` varchar(100) NOT NULL,
	`entityType` varchar(50) NOT NULL,
	`entityId` int,
	`description` text NOT NULL,
	`metadata` text,
	`performedBy` int NOT NULL,
	`performedByName` varchar(100) NOT NULL,
	`performedByRole` varchar(20) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `activity_logs_id` PRIMARY KEY(`id`)
);
