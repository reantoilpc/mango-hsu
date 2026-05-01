-- V2 product seed. SKUs match V1 fallback-data.ts to keep order import compatible.
INSERT INTO products (sku, name, variant, price, available, display_order) VALUES
  ('DRY-JH-1',  '金煌芒果乾', '1 斤', 450, 1, 10),
  ('DRY-JH-05', '金煌芒果乾', '半斤',  230, 1, 20),
  ('DRY-AW-1',  '愛文芒果乾', '1 斤', 480, 1, 30),
  ('DRY-AW-05', '愛文芒果乾', '半斤',  250, 1, 40);
