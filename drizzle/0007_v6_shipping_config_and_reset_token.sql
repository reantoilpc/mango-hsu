-- V6 Migration 0007: per-season shipping_config + admin password-reset token columns
--
-- Pure additive DDL (ADD COLUMN + one partial unique index). No table rebuild, no FK change,
-- no data movement. Non-destructive: existing rows keep working; shipping_config backfills to
-- the flat-$150 default so no existing order total changes.
--
-- HAND-WRITTEN (not `drizzle-kit generate`). Drizzle's snapshot metadata is frozen at 0002
-- (pre-V5.2); running generate here would diff against the old schema and emit a destructive
-- "redo the whole V5.2 migration". This file follows the same hand-authored pattern as
-- 0003..0006. See docs/superpowers/plans/v6/P3-migrations.md §0.2.
--
-- Apply via:  wrangler d1 migrations apply <db> --remote   (tracks applied files by filename
--             in D1's d1_migrations table — independent of drizzle/meta/_journal.json).
--
-- Idempotency note: SQLite `ALTER TABLE ADD COLUMN` is NOT guarded by IF NOT EXISTS (no such
-- syntax). If this file partially applied and you must re-run, first inspect the table with
-- `PRAGMA table_info(...)` and hand-skip the columns that already exist. The partial unique
-- index IS guarded with IF NOT EXISTS.

-- 1. seasons.shipping_config — per-season shipping rule, JSON string.
--    Default keeps pre-existing seasons on the old flat $150 fee (back-compat).
ALTER TABLE `seasons` ADD `shipping_config` text DEFAULT '{"type":"flat","fee_twd":150}' NOT NULL;
--> statement-breakpoint

-- 2. admin_users.reset_token — single-use forgot-password token (nullable).
ALTER TABLE `admin_users` ADD `reset_token` text;
--> statement-breakpoint

-- 3. admin_users.reset_token_expires_at — UTC ISO-8601 Z; 30-min TTL set by request-reset.
ALTER TABLE `admin_users` ADD `reset_token_expires_at` text;
--> statement-breakpoint

-- 4. Partial unique index: many NULLs allowed; a non-null reset_token must be unique.
--    Same partial-index shape as seasons_active_singleton (D1 SQLite parser support verified).
CREATE UNIQUE INDEX IF NOT EXISTS `admin_users_reset_token_unique` ON `admin_users` (`reset_token`) WHERE `reset_token` IS NOT NULL;
