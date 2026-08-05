CREATE TABLE `suppliers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`phone` varchar(30),
	`notes` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `suppliers_id` PRIMARY KEY(`id`),
	CONSTRAINT `suppliers_business_name_unique` UNIQUE(`businessId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `supplier_payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessId` int NOT NULL,
	`supplierId` int,
	`purchaseReceiptId` int NOT NULL,
	`financialTransactionId` int,
	`accountId` int NOT NULL,
	`amount` decimal(18,4) NOT NULL,
	`paidAt` timestamp NOT NULL,
	`evidenceUrl` varchar(500),
	`notes` text,
	`createdBy` int NOT NULL,
	`createdByName` varchar(100) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `supplier_payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD `supplierId` int;--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD `invoiceNumber` varchar(100);--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD `invoiceDate` timestamp;--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD `paidAmount` decimal(18,4) NOT NULL DEFAULT '0';--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD `headerDiscount` decimal(18,4) NOT NULL DEFAULT '0';--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD `shippingCost` decimal(18,4) NOT NULL DEFAULT '0';--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `purchase_receipt_items` ADD `grossUnitCost` decimal(18,4);--> statement-breakpoint
ALTER TABLE `purchase_receipt_items` ADD `discount` decimal(18,4) NOT NULL DEFAULT '0';--> statement-breakpoint
ALTER TABLE `purchase_receipt_items` ADD `extraCost` decimal(18,4) NOT NULL DEFAULT '0';--> statement-breakpoint
CREATE INDEX `suppliers_business_active_idx` ON `suppliers` (`businessId`,`isActive`);--> statement-breakpoint
CREATE INDEX `purchase_receipts_supplier_idx` ON `purchase_receipts` (`businessId`,`supplierId`,`status`);--> statement-breakpoint
CREATE INDEX `supplier_payments_receipt_idx` ON `supplier_payments` (`purchaseReceiptId`);--> statement-breakpoint
CREATE INDEX `supplier_payments_paid_idx` ON `supplier_payments` (`businessId`,`paidAt`);
