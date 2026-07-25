ALTER TABLE `inventory_movements` ADD `variantId` int;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `costPrice` decimal(10,2);