ALTER TABLE `orders` ADD `line_user_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `line_push_sent_at` text;--> statement-breakpoint
CREATE INDEX `orders_by_line_user_id` ON `orders` (`line_user_id`);