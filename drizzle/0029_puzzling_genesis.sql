CREATE TABLE `plan_features` (
	`id` int AUTO_INCREMENT NOT NULL,
	`planId` int NOT NULL,
	`featureCode` varchar(60) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`configurationJson` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `plan_features_id` PRIMARY KEY(`id`),
	CONSTRAINT `plan_features_plan_id_feature_code_unique` UNIQUE(`planId`,`featureCode`)
);
--> statement-breakpoint
CREATE TABLE `plan_limits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`planId` int NOT NULL,
	`limitCode` varchar(60) NOT NULL,
	`limitValue` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `plan_limits_id` PRIMARY KEY(`id`),
	CONSTRAINT `plan_limits_plan_id_limit_code_unique` UNIQUE(`planId`,`limitCode`)
);
--> statement-breakpoint
ALTER TABLE `business_groups` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `employees` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `tenantId` int;