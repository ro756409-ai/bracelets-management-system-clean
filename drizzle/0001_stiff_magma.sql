CREATE TABLE `employees` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`phone` varchar(20),
	`email` varchar(320),
	`role` enum('agent','warehouse','manager') NOT NULL DEFAULT 'agent',
	`isActive` boolean NOT NULL DEFAULT true,
	`userId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employees_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`productId` int NOT NULL,
	`type` enum('in','out') NOT NULL,
	`quantity` int NOT NULL,
	`reason` varchar(200),
	`orderId` int,
	`performedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventory_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderNumber` varchar(20) NOT NULL,
	`customerName` varchar(100) NOT NULL,
	`customerPhone` varchar(20) NOT NULL,
	`customerAddress` text NOT NULL,
	`governorate` varchar(50) NOT NULL,
	`productId` int NOT NULL,
	`productName` varchar(200) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`totalAmount` decimal(10,2) NOT NULL,
	`status` enum('new','confirmed','postponed','cancelled','preparing','shipped','delivered') NOT NULL DEFAULT 'new',
	`source` enum('easyorder','shopify','whatsapp','manual') NOT NULL DEFAULT 'manual',
	`assignedEmployeeId` int,
	`assignedAt` timestamp,
	`confirmedAt` timestamp,
	`postponedTo` timestamp,
	`cancelReason` enum('price','not_serious','wrong_number','duplicate'),
	`notes` text,
	`lastUpdatedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_orderNumber_unique` UNIQUE(`orderNumber`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(200) NOT NULL,
	`sku` varchar(50) NOT NULL,
	`price` decimal(10,2) NOT NULL,
	`currentStock` int NOT NULL DEFAULT 0,
	`minStockLevel` int NOT NULL DEFAULT 15,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_sku_unique` UNIQUE(`sku`)
);
