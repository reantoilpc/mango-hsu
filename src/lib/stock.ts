import type { AppEnv } from "../db/client";

export interface StockItem {
  sku: string;
  qty: number;
}

// Low-level: returns prepared statements for atomic stock decrement (CAS pattern).
// Caller composes into their own batch when stock change must commit atomically with
// other writes (e.g. cancel: restore + UPDATE cancelled_at + audit in one batch).
export function stockDecrementStmts(env: AppEnv, items: StockItem[]) {
  return items.map((it) =>
    env.DB.prepare(
      `UPDATE products SET stock = stock - ?1 WHERE sku = ?2 AND stock >= ?1`,
    ).bind(it.qty, it.sku),
  );
}

// Low-level: returns prepared statements for unconditional stock restore.
// No CAS — restore always succeeds (we're giving back stock we previously held).
export function stockRestoreStmts(env: AppEnv, items: StockItem[]) {
  return items.map((it) =>
    env.DB.prepare(`UPDATE products SET stock = stock + ?1 WHERE sku = ?2`)
      .bind(it.qty, it.sku),
  );
}

// High-level: atomic reserve + post-batch CAS check + auto-compensate on partial failure.
// For order-creation paths where stock decrement happens BEFORE the INSERT batch.
//
// D1 batch is atomic per call (all-or-nothing transaction). But that ONLY guarantees
// "all UPDATEs commit or all rollback" — it does NOT guarantee "all WHERE clauses
// matched a row". A successful UPDATE that affects 0 rows is still a successful stmt.
// So we inspect results.meta.changes per row and compensate on any 0-changes row.
export async function tryDecrementStock(
  env: AppEnv,
  items: StockItem[],
): Promise<{ ok: true } | { ok: false; sold_out_sku: string }> {
  if (items.length === 0) return { ok: true };
  const stmts = stockDecrementStmts(env, items);
  const results = await env.DB.batch(stmts);
  for (let i = 0; i < results.length; i++) {
    if ((results[i]?.meta?.changes ?? 0) === 0) {
      // Compensate: restore the SKUs that did succeed before this index.
      if (i > 0) {
        await env.DB.batch(stockRestoreStmts(env, items.slice(0, i)));
      }
      return { ok: false, sold_out_sku: items[i]!.sku };
    }
  }
  return { ok: true };
}

// High-level: standalone restore. For unwind paths after a failed INSERT batch
// where reservation must be returned to stock.
export async function restoreStock(env: AppEnv, items: StockItem[]): Promise<void> {
  if (items.length === 0) return;
  await env.DB.batch(stockRestoreStmts(env, items));
}
