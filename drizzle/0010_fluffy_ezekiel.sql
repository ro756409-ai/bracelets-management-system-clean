ALTER TABLE `orders` ADD `isDuplicate` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `duplicateMarkedAt` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `duplicateMarkedBy` int;