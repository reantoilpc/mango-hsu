CREATE TABLE `admin_users` (
	`email` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`user_email` text NOT NULL,
	`action` text NOT NULL,
	`order_id` text,
	`details` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`order_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_log_by_order` ON `audit_log` (`order_id`);--> statement-breakpoint
CREATE INDEX `audit_log_by_ts` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`sku` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`order_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sku`) REFERENCES `products`(`sku`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_items_by_order` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`order_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`address` text NOT NULL,
	`notes` text,
	`subtotal` integer NOT NULL,
	`shipping` integer NOT NULL,
	`total` integer NOT NULL,
	`expected_memo` text NOT NULL,
	`pdpa_accepted` integer NOT NULL,
	`paid` integer DEFAULT false NOT NULL,
	`shipped` integer DEFAULT false NOT NULL,
	`tracking_no` text,
	`paid_at` text,
	`shipped_at` text,
	`paid_by` text,
	`shipped_by` text,
	`idempotency_key` text NOT NULL,
	FOREIGN KEY (`paid_by`) REFERENCES `admin_users`(`email`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shipped_by`) REFERENCES `admin_users`(`email`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_idempotency_key_unique` ON `orders` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `orders_by_created` ON `orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `orders_by_paid_shipped` ON `orders` (`paid`,`shipped`);--> statement-breakpoint
CREATE TABLE `products` (
	`sku` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`variant` text NOT NULL,
	`price` integer NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_email`) REFERENCES `admin_users`(`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_by_expires` ON `sessions` (`expires_at`);