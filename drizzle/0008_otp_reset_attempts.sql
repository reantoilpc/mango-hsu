-- Migration 0008: 6-digit OTP password-reset — add reset_attempts, drop reset_token unique index
--
-- Pure additive/index DDL (ADD COLUMN + DROP INDEX). No table rebuild, no FK change, no data
-- movement. Non-destructive: existing admin_users rows keep working; reset_attempts backfills to 0.
--
-- HAND-WRITTEN (not `drizzle-kit generate`). Drizzle's snapshot metadata is frozen at 0002
-- (pre-V5.2); running generate here diffs against the old schema and would emit a destructive
-- "redo the whole V5.2 migration" (and requires an interactive TTY to resolve column conflicts).
-- This file follows the same hand-authored pattern as 0003..0007. The plan's Task 1 Step 5 gives
-- the exact expected SQL.
--
-- Apply via:  wrangler d1 migrations apply <db> --remote   (tracks applied files by filename
--             in D1's d1_migrations table — independent of drizzle/meta/_journal.json).
--
-- Idempotency note: SQLite `ALTER TABLE ADD COLUMN` is NOT guarded by IF NOT EXISTS (no such
-- syntax). If this file partially applied and you must re-run, first inspect the table with
-- `PRAGMA table_info(admin_users)` and hand-skip reset_attempts if it already exists.

-- 1. admin_users.reset_attempts — wrong-code counter; cap 5 → invalidate the OTP code.
ALTER TABLE `admin_users` ADD `reset_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- 2. Drop the V6 partial unique index on reset_token. The OTP flow looks up by email + HMAC
--    compare, so a globally-unique reset_token is no longer needed and would collide when two
--    users draw the same 6-digit code.
DROP INDEX `admin_users_reset_token_unique`;
