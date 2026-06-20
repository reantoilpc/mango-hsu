-- Migration 0009: 併單 / order groups (combined shipping).
-- Additive only: new table + two nullable columns on orders + indexes. No table rebuild,
-- no data movement. Hand-authored (drizzle snapshot frozen at 0002, like 0003..0008).
-- Apply via: bunx wrangler d1 migrations apply <db> --remote
CREATE TABLE `order_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`code` text NOT NULL,
	`host_name` text NOT NULL,
	`host_address` text NOT NULL,
	`deadline` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`tracking_no` text,
	`shipped_at` text,
	`shipped_by` text,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_groups_open_code_unique` ON `order_groups` (`code`) WHERE `status` = 'open';
--> statement-breakpoint
CREATE INDEX `order_groups_by_status` ON `order_groups` (`status`);
--> statement-breakpoint
ALTER TABLE `orders` ADD `order_group_id` integer REFERENCES order_groups(id);
--> statement-breakpoint
ALTER TABLE `orders` ADD `group_role` text;
