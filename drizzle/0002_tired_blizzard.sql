ALTER TABLE `employees` ADD `username` varchar(50);--> statement-breakpoint
ALTER TABLE `employees` ADD `passwordHash` varchar(255);--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_username_unique` UNIQUE(`username`);