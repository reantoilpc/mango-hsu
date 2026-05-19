-- V5.2 Migration File 4 of 4: drop products.stock (the rollback safety net column)
--
-- DO NOT RUN THIS UNTIL:
-- - PR1 worker code has been live in prod for at least 5 days with NO stock-related issues
-- - reconcile-stock.ts has shown 0 drift across multiple deploys
-- - You have a recent `wrangler d1 export mango-hsu-prod` backup in `backups/`
--
-- After this runs, hot rollback to old worker code (which reads products.stock) is no longer
-- possible — the column is gone. To recover, you must `wrangler d1 import` from a backup.
--
-- D1 SQLite supports `ALTER TABLE ... DROP COLUMN` from version 3.35+. The current D1 backend
-- as of 2026 is well past 3.35, so the simple DROP COLUMN works. If for any reason it fails
-- (older D1 instance), fall back to the rebuild pattern (CREATE products_lean → INSERT … SELECT
-- without stock → DROP → RENAME).
--
-- This file is intentionally separate from File 1-3 because it needs a deliberate manual
-- decision after observing prod stability.

ALTER TABLE `products` DROP COLUMN `stock`;
--> statement-breakpoint

-- POST-MIGRATION VALIDATION — manual:
--   .schema products  -- (in `wrangler d1 execute --command ".schema products"`); confirm no `stock` column
