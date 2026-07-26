ALTER TABLE `sales_channels` ADD `lastConnectionTestAt` timestamp;--> statement-breakpoint
ALTER TABLE `sales_channels` ADD `lastConnectionStatus` enum('never','connected','failed') DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_channels` ADD `lastConnectionError` text;--> statement-breakpoint
ALTER TABLE `sales_channels` ADD `externalStoreName` varchar(200);