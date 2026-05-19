-- V5.2 Migration File 1 of 4: seasons + product_groups
--
-- Pure additive DDL — no destructive changes, no FK breakage. Idempotent (safe to re-run
-- after partial failure). Cloudflare D1 DDL is NOT transactional with same-batch DML, so we
-- split the V5.2 migration into 4 files; failure here means re-run this file from scratch.
--
-- Sequencing: this is File 1. Run before File 2 (products PK swap).
--
-- See ~/.gstack/projects/reantoilpc-mango-hsu/rayhsu-feature-v5.2-ux-and-ops-design-*.md
-- "Migration" section for the full plan.

-- 1. seasons table
CREATE TABLE IF NOT EXISTS `seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`starts_at` text,
	`ended_at` text,
	`cloned_from_season_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`cloned_from_season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `seasons_code_unique` ON `seasons` (`code`);
--> statement-breakpoint
-- Partial unique index: at most ONE season can have status='active' at any time.
-- D1 SQLite parser support verified via local probe (2026-05-13).
CREATE UNIQUE INDEX IF NOT EXISTS `seasons_active_singleton` ON `seasons` (`status`) WHERE `status` = 'active';
--> statement-breakpoint

-- 2. product_groups table (per-season grouping; stock_fen pool lives here)
CREATE TABLE IF NOT EXISTS `product_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`stock_fen` integer DEFAULT 0 NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `product_groups_season_slug` ON `product_groups` (`season_id`, `slug`);
--> statement-breakpoint

-- 3. Seed the 2026 season + the two existing product groups (jinhwang/irwin dried).
-- INSERT OR IGNORE keeps re-runs idempotent. stock_fen=0 here; File 2 step 6 backfills
-- from old products.stock × new package_fen aggregates.
INSERT OR IGNORE INTO `seasons` (`code`, `name`, `status`, `created_at`)
VALUES ('2026', '2026 芒果季', 'active', '2026-05-12T00:00:00.000Z');
--> statement-breakpoint
INSERT OR IGNORE INTO `product_groups` (`season_id`, `slug`, `name`, `stock_fen`, `created_at`)
SELECT s.id, 'jinhwang-dried', '金煌芒果乾', 0, '2026-05-12T00:00:00.000Z' FROM `seasons` s WHERE s.code = '2026';
--> statement-breakpoint
INSERT OR IGNORE INTO `product_groups` (`season_id`, `slug`, `name`, `stock_fen`, `created_at`)
SELECT s.id, 'irwin-dried', '愛文芒果乾', 0, '2026-05-12T00:00:00.000Z' FROM `seasons` s WHERE s.code = '2026';
