CREATE TABLE `broadcast_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`message` text NOT NULL,
	`sentBy` int NOT NULL,
	`sentByName` varchar(100) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `broadcast_messages_id` PRIMARY KEY(`id`)
);
