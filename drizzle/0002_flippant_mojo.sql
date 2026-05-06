ALTER TABLE `orders` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `stock` integer DEFAULT 0 NOT NULL;