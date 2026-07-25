ALTER TABLE `products` MODIFY COLUMN `sku` varchar(50);--> statement-breakpoint
ALTER TABLE `products` MODIFY COLUMN `price` decimal(10,2);--> statement-breakpoint
ALTER TABLE `product_variants` ADD `name` varchar(200);--> statement-breakpoint
ALTER TABLE `products` ADD `description` text;