-- 2026 prod catalog seed (V5.2: season + groups + products).
--
-- Idempotent & convergent: seasons + groups use INSERT OR IGNORE; products UPSERT on
--   (season_id, sku) and set the 2026 price. Keyed on UNIQUE indexes
--   seasons.code / product_groups(season_id,slug) / products(season_id,sku).
-- SAFE to run repeatedly even if `db:migrate:prod` (migration 0003) already created the
-- 2026 season + the two groups, OR if prod already carries these SKUs at old prices
-- (migrated from V2) — re-running just converges prod to this catalog + these prices.
-- Creates no duplicates.
--
-- It does NOT touch stock_fen — launch stock must be set through the admin intake
-- endpoint (writes the required audit_log row), or via a separate stock script that
-- pairs the UPDATE with a `group_stock_change` audit row. Setting stock_fen with a
-- bare UPDATE here would make reconcile-stock.ts report drift.
--
-- Run (from an authenticated shell — wrangler login done):
--   bunx wrangler d1 execute mango-hsu-prod --remote --file=scripts/seed-prod-2026.sql
-- Verify after:
--   bunx wrangler d1 execute mango-hsu-prod --remote --command \
--     "SELECT g.slug, g.name, g.stock_fen, p.sku, p.variant, p.package_fen, p.price, p.available \
--        FROM product_groups g JOIN products p ON p.group_id=g.id \
--        JOIN seasons s ON s.id=g.season_id WHERE s.code='2026' ORDER BY g.display_order, p.display_order;"

-- 1) Season (matches migration 0003 exactly; no-op if already present).
INSERT OR IGNORE INTO seasons (code, name, status, created_at)
VALUES ('2026', '2026 芒果季', 'active', '2026-05-12T00:00:00.000Z');

-- 2) Product groups (resolve season_id by code so we never hardcode autoincrement ids).
INSERT OR IGNORE INTO product_groups (season_id, slug, name, stock_fen, available, display_order, created_at)
SELECT s.id, 'jinhwang-dried', '金煌芒果乾', 0, 1, 10, '2026-05-12T00:00:00.000Z'
  FROM seasons s WHERE s.code = '2026';
INSERT OR IGNORE INTO product_groups (season_id, slug, name, stock_fen, available, display_order, created_at)
SELECT s.id, 'irwin-dried', '愛文芒果乾', 0, 1, 20, '2026-05-12T00:00:00.000Z'
  FROM seasons s WHERE s.code = '2026';

-- 3) Products / SKUs. UPSERT on (season_id, sku): INSERT if missing, else update ONLY price.
--    Lands the 2026 price change even if prod already carries these SKUs at old prices.
--    season_id + group_id are resolved by code/slug subquery — never hardcode autoincrement ids.
INSERT INTO products (season_id, group_id, sku, name, variant, package_fen, price, available, display_order)
SELECT s.id, g.id, 'DRY-JH-1', '金煌芒果乾', '1 斤', 100, 460, 1, 10
  FROM seasons s JOIN product_groups g ON g.season_id = s.id AND g.slug = 'jinhwang-dried'
 WHERE s.code = '2026'
ON CONFLICT (season_id, sku) DO UPDATE SET price = excluded.price;
INSERT INTO products (season_id, group_id, sku, name, variant, package_fen, price, available, display_order)
SELECT s.id, g.id, 'DRY-JH-05', '金煌芒果乾', '半斤', 50, 240, 1, 20
  FROM seasons s JOIN product_groups g ON g.season_id = s.id AND g.slug = 'jinhwang-dried'
 WHERE s.code = '2026'
ON CONFLICT (season_id, sku) DO UPDATE SET price = excluded.price;
INSERT INTO products (season_id, group_id, sku, name, variant, package_fen, price, available, display_order)
SELECT s.id, g.id, 'DRY-AW-1', '愛文芒果乾', '1 斤', 100, 510, 1, 30
  FROM seasons s JOIN product_groups g ON g.season_id = s.id AND g.slug = 'irwin-dried'
 WHERE s.code = '2026'
ON CONFLICT (season_id, sku) DO UPDATE SET price = excluded.price;
INSERT INTO products (season_id, group_id, sku, name, variant, package_fen, price, available, display_order)
SELECT s.id, g.id, 'DRY-AW-05', '愛文芒果乾', '半斤', 50, 260, 1, 40
  FROM seasons s JOIN product_groups g ON g.season_id = s.id AND g.slug = 'irwin-dried'
 WHERE s.code = '2026'
ON CONFLICT (season_id, sku) DO UPDATE SET price = excluded.price;
