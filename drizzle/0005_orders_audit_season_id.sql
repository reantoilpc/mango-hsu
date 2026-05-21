-- V5.2 Migration File 3 of 4: orders + audit_log season_id columns
--
-- SQLite ALTER TABLE rejects `DEFAULT (SELECT ...)` — defaults must be constants or simple
-- expressions. So we ALTER without a default and rely on:
--   (a) The post-ALTER UPDATE in step 4 to backfill historical rows.
--   (b) Application-layer enforcement (V5.2 code always sets season_id on INSERT).
--
-- Brief race window: between the ALTER and the UPDATE here, any concurrent V5.1 INSERT
-- (running on the old worker) would write NULL season_id. Step 4's UPDATE catches them.
-- For prod, this is acceptable because the window is sub-second and the backfill is defensive.
--
-- Note: SQLite ALTER TABLE cannot SET NOT NULL on an existing column. The pragmatic choice
-- is to leave DB-level nullable + Drizzle schema marks NOT NULL + application validation
-- enforces. Rebuilding `orders` to add NOT NULL would risk too much (large historical table,
-- FK cascade implications) for too little gain.
--
-- Sequencing: requires File 1 (seasons table). Can run before or after File 2 (independent).
--
-- See design doc "Migration / File 3" + Open Questions for context.

-- 1. orders.season_id — no DEFAULT (SQLite limitation), backfilled in step 4
ALTER TABLE `orders` ADD `season_id` integer REFERENCES `seasons`(`id`);
--> statement-breakpoint

-- 2. audit_log.season_id — same pattern
ALTER TABLE `audit_log` ADD `season_id` integer REFERENCES `seasons`(`id`);
--> statement-breakpoint

-- 3. Indexes for season filtering
CREATE INDEX IF NOT EXISTS `orders_by_season` ON `orders` (`season_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_by_season` ON `audit_log` (`season_id`);
--> statement-breakpoint

-- 4. Backfill: any pre-existing rows (and any rows that landed during the ALTER race window)
-- get pointed at 2026.
UPDATE `orders` SET `season_id` = (SELECT id FROM `seasons` WHERE code = '2026') WHERE `season_id` IS NULL;
--> statement-breakpoint
UPDATE `audit_log` SET `season_id` = (SELECT id FROM `seasons` WHERE code = '2026') WHERE `season_id` IS NULL;
--> statement-breakpoint

-- 5. POST-MIGRATION VALIDATION — manual:
--   SELECT count(*) FROM orders WHERE season_id IS NULL;     -- expect 0
--   SELECT count(*) FROM audit_log WHERE season_id IS NULL;  -- expect 0 (or only legacy login events)
