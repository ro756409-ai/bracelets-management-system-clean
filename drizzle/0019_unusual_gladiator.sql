CREATE TABLE `business_groups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`slug` varchar(50) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `business_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `business_groups_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`slug` varchar(50) NOT NULL,
	`groupId` int,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `businesses_id` PRIMARY KEY(`id`),
	CONSTRAINT `businesses_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `categories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_edit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderId` int NOT NULL,
	`field` varchar(100) NOT NULL,
	`oldValue` text,
	`newValue` text,
	`editedBy` int NOT NULL,
	`editedByName` varchar(100) NOT NULL,
	`editedByRole` varchar(30) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `order_edit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`productId` int NOT NULL,
	`color` varchar(50),
	`size` varchar(50),
	`sku` varchar(100),
	`price` decimal(10,2),
	`currentStock` int NOT NULL DEFAULT 0,
	`minStockLevel` int NOT NULL DEFAULT 5,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_variants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sales_channels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`domain` varchar(255),
	`platform` enum('easyorder','shopify','woocommerce','whatsapp','facebook','instagram','manual','other') NOT NULL DEFAULT 'other',
	`apiToken` text,
	`webhookSecret` text,
	`webhookUrl` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sales_channels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `warehouses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `warehouses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `activity_logs` ADD `businessId` int;--> statement-breakpoint
ALTER TABLE `broadcast_messages` ADD `businessId` int;--> statement-breakpoint
ALTER TABLE `employees` ADD `businessId` int;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `businessId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `warehouseId` int;--> statement-breakpoint
ALTER TABLE `merge_logs` ADD `businessId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `businessId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `customerPhone2` varchar(20);--> statement-breakpoint
ALTER TABLE `orders` ADD `city` varchar(100);--> statement-breakpoint
ALTER TABLE `orders` ADD `shippingFees` decimal(10,2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE `orders` ADD `paymentMethod` varchar(50) DEFAULT 'cod';--> statement-breakpoint
ALTER TABLE `orders` ADD `cancelledAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `shippedAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `deliveredAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `websiteId` int;--> statement-breakpoint
ALTER TABLE `orders` ADD `variantId` int;--> statement-breakpoint
ALTER TABLE `orders` ADD `color` varchar(100);--> statement-breakpoint
ALTER TABLE `orders` ADD `size` varchar(100);--> statement-breakpoint
ALTER TABLE `orders` ADD `employeeNotes` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `bostaShipmentId` varchar(100);--> statement-breakpoint
ALTER TABLE `orders` ADD `bostaTrackingNumber` varchar(100);--> statement-breakpoint
ALTER TABLE `orders` ADD `bostaSentAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `bostaStatus` varchar(50);--> statement-breakpoint
ALTER TABLE `orders` ADD `bostaLastError` text;--> statement-breakpoint
ALTER TABLE `print_logs` ADD `businessId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `businessId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `categoryId` int;--> statement-breakpoint
ALTER TABLE `returns` ADD `businessId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `businessId` int;--> statement-breakpoint
ALTER TABLE `webhook_logs` ADD `businessId` int DEFAULT 1 NOT NULL;