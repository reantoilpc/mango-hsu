-- V5.2 Migration File 2 of 4: products PK swap (sku → numeric id) + order_items rebuild
--
-- SQLite does NOT support ALTER TABLE ... DROP CONSTRAINT, so swapping the products PK
-- requires rebuilding both `products` (PK change) and `order_items` (FK change). They MUST
-- happen in the same migration file because order_items.sku FK references the soon-to-be-dropped
-- products.sku.
--
-- IMPORTANT: products_new INTENTIONALLY keeps a `stock` column that the new worker code does
-- NOT read. This is the rollback safety net per design D2=A. If PR1 ships and the new worker
-- code has a bug, we can `wrangler rollback` to the old worker; the old worker will read
-- products.stock (which still has the snapshot value from migration time) and at least not
-- 500-crash. File 4 (`0006_drop_old_stock_column.sql`) drops `stock` after prod runs new code
-- for several days without incident.
--
-- This file is NOT idempotent in the same way as File 1. If it fails partway, the half-rebuilt
-- tables block re-run. Recovery: drop products_new + order_items_new, restore from backup,
-- re-run.
--
-- Sequencing: requires File 1 (seasons + product_groups) to have run successfully.
--
-- See design doc "Migration / File 2" for context.

-- 1. Build new products table. Includes `stock` as the rollback safety net column —
-- new code never reads it; File 4 drops it.
CREATE TABLE `products_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`group_id` integer NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`variant` text NOT NULL,
	`package_fen` integer NOT NULL CHECK (`package_fen` > 0),
	`price` integer NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`stock` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `product_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_season_sku` ON `products_new` (`season_id`, `sku`);
--> statement-breakpoint

-- 2. Backfill from existing `products`.
-- - season_id = 2026
-- - group_id derived from product name prefix (金煌% → jinhwang-dried, 愛文% → irwin-dried)
-- - package_fen derived from variant (1斤=100, 半斤=50)
-- - stock copied verbatim (rollback safety net)
INSERT INTO `products_new` (`season_id`, `group_id`, `sku`, `name`, `variant`, `package_fen`, `price`, `available`, `display_order`, `stock`)
SELECT
	(SELECT s.id FROM `seasons` s WHERE s.code = '2026'),
	CASE
		WHEN p.`name` LIKE '金煌%' THEN (SELECT g.id FROM `product_groups` g WHERE g.slug = 'jinhwang-dried' AND g.season_id = (SELECT id FROM `seasons` WHERE code = '2026'))
		WHEN p.`name` LIKE '愛文%' THEN (SELECT g.id FROM `product_groups` g WHERE g.slug = 'irwin-dried' AND g.season_id = (SELECT id FROM `seasons` WHERE code = '2026'))
		ELSE NULL
	END,
	p.`sku`,
	p.`name`,
	p.`variant`,
	CASE
		WHEN p.`variant` LIKE '1%斤' THEN 100
		WHEN p.`variant` = '半斤' THEN 50
		ELSE NULL
	END,
	p.`price`,
	p.`available`,
	p.`display_order`,
	p.`stock`
FROM `products` p;
--> statement-breakpoint

-- 3. Build new order_items table with product_id FK to products_new.id.
CREATE TABLE `order_items_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`product_id` integer NOT NULL,
	`sku` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`order_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products_new`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

-- 4. Backfill order_items.product_id by matching old order_items.sku to new products (season=2026).
-- All historical orders are 2026 by definition (this is the first season).
INSERT INTO `order_items_new` (`order_id`, `product_id`, `sku`, `qty`, `unit_price`)
SELECT
	oi.`order_id`,
	pn.`id`,
	oi.`sku`,
	oi.`qty`,
	oi.`unit_price`
FROM `order_items` oi
LEFT JOIN `products_new` pn
	ON pn.`sku` = oi.`sku`
	AND pn.`season_id` = (SELECT s.id FROM `seasons` s WHERE s.code = '2026');
--> statement-breakpoint

-- 5. Backfill product_groups.stock_fen from old products.stock × new products_new.package_fen.
-- Restricting JOIN to season=2026 prevents double-counting if File 2 is ever re-run after
-- a 2027 season exists.
UPDATE `product_groups`
SET `stock_fen` = COALESCE(
	(SELECT SUM(p.`stock` * pn.`package_fen`)
	 FROM `products` p
	 JOIN `products_new` pn
		ON pn.`sku` = p.`sku`
		AND pn.`season_id` = (SELECT s.id FROM `seasons` s WHERE s.code = '2026')
	 WHERE pn.`group_id` = `product_groups`.`id`),
	0
)
WHERE `season_id` = (SELECT s.id FROM `seasons` s WHERE s.code = '2026');
--> statement-breakpoint

-- 6. Migration init audit log entries — gives reconcile-stock.ts a starting point.
-- Each group_intake entry documents the migration backfill.
INSERT INTO `audit_log` (`ts`, `user_email`, `action`, `details`)
SELECT
	'2026-05-12T00:00:00.000Z',
	'<system>',
	'group_stock_change',
	'{"reason":"migration_init","group_id":' || g.`id` || ',"delta_fen":' || g.`stock_fen` || ',"before_fen":0,"after_fen":' || g.`stock_fen` || ',"source_id":"v5.2-migration-0004"}'
FROM `product_groups` g
WHERE g.`season_id` = (SELECT s.id FROM `seasons` s WHERE s.code = '2026');
--> statement-breakpoint

-- 7. Drop old order_items + products. FK ordering matters: order_items references products,
-- so order_items first.
DROP TABLE `order_items`;
--> statement-breakpoint
DROP TABLE `products`;
--> statement-breakpoint

-- 8. Rename new tables into place.
ALTER TABLE `order_items_new` RENAME TO `order_items`;
--> statement-breakpoint
ALTER TABLE `products_new` RENAME TO `products`;
--> statement-breakpoint

-- 9. Rebuild indexes that were on order_items (the rename keeps them on the table but lose
-- the original index names; re-create explicitly to match Drizzle schema).
CREATE INDEX IF NOT EXISTS `order_items_by_order` ON `order_items` (`order_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_items_by_product` ON `order_items` (`product_id`);
--> statement-breakpoint

-- 10. POST-MIGRATION VALIDATION — manual: run these and require zero rows in any.
-- If non-zero, STOP, restore from backup, debug.
-- Encoded as a comment because we can't return failure from the migration itself.
--   SELECT count(*) FROM order_items WHERE product_id IS NULL;          -- expect 0
--   SELECT count(*) FROM products WHERE group_id IS NULL;                -- expect 0
--   SELECT count(*) FROM products WHERE package_fen IS NULL;             -- expect 0
--   SELECT count(*) FROM products WHERE season_id IS NULL;               -- expect 0
