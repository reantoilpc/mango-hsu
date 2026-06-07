// V5.2 stock model — group fen pool + sku-derived availability.
//
// PREMISE: stock in a product_group fen pool is fungible — packaging happens at fulfillment.
// If the workflow ever shifts to "package on intake" (e.g. fresh fruit shipped pre-boxed at
// 10 斤/box and never broken down), per-SKU physical pack counts can diverge from the derived
// floor(group.stock_fen / sku.package_fen) value. Triggers to revisit this model:
//   (a) operator says "總斤數夠但 X 包不夠" (total weight is enough but X-size packs aren't)
//   (b) admin refuses to break/repack inventory to fulfill a different SKU
// Migration path when triggered: add a sku_pack_count ledger; keep group.stock_fen as the
// source of truth; use the ledger to track physical pack mix in parallel.
//
// Audit invariant: every mutation to product_groups.stock_fen MUST append a complete audit_log
// row in the same env.DB.batch() with details
//   {reason, group_id, delta_fen, before_fen, after_fen, source_id?}
// reasons: migration_init | group_intake | order_decrement | order_restore | order_edit_delta
// reconcile-stock.ts walks audit_log and asserts SUM(deltas) == current stock_fen.
// If audit row is missed, reconcile catches the drift — that IS the bug indicator.

import { sql } from "drizzle-orm";
import type { AppEnv } from "../db/client";

export type ResolveErrorCode = "unknown_product" | "season_inactive" | "SOLD_OUT";

export interface ResolveResult {
  product_id: number;
  group_id: number;
  package_fen: number;
  price: number;
  sku: string;
  name: string;
  variant: string;
  qty: number;
}

export interface ResolveOk {
  ok: true;
  resolved: ResolveResult[];
  // pre-aggregated by group_id for the CAS path
  group_decrements: Array<{ group_id: number; fen: number }>;
}

export interface ResolveFail {
  ok: false;
  error_code: ResolveErrorCode;
  sku: string;
}

// Resolve customer-supplied items (sku + qty) against the active season's product map.
// Two layers of validation:
//   - sku exists in active season → otherwise unknown_product (HTTP-safe; doesn't leak season state)
//   - product.available = true → otherwise SOLD_OUT (legacy semantics for hidden SKUs)
// Aggregates fen demand by group_id so the same flavour ordered as 1斤 + 半斤 in one cart
// becomes a single CAS UPDATE.
export async function resolveItemsForStock(
  env: AppEnv,
  items: Array<{ sku: string; qty: number }>,
): Promise<ResolveOk | ResolveFail> {
  if (items.length === 0) {
    return { ok: true, resolved: [], group_decrements: [] };
  }

  // Build SKU IN (?, ?, ?) parameter list. Worst case: 10 items per cart.
  const skus = items.map((i) => i.sku);
  const placeholders = skus.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT p.id AS product_id, p.group_id, p.package_fen, p.price, p.sku, p.name, p.variant, p.available
       FROM products p
       JOIN seasons s ON s.id = p.season_id
      WHERE s.status = 'active'
        AND p.sku IN (${placeholders})`,
  )
    .bind(...skus)
    .all()) as { results: Array<{
      product_id: number;
      group_id: number;
      package_fen: number;
      price: number;
      sku: string;
      name: string;
      variant: string;
      available: number;
    }> };

  const productBySku = new Map(rows.results.map((r) => [r.sku, r]));

  const resolved: ResolveResult[] = [];
  const groupAgg = new Map<number, number>(); // group_id → fen sum

  for (const it of items) {
    const p = productBySku.get(it.sku);
    if (!p) {
      // SKU missing from active season — could mean unknown OR archived season.
      // Same error code from HTTP perspective; admin tools can disambiguate via audit_log.
      return { ok: false, error_code: "unknown_product", sku: it.sku };
    }
    if (!p.available) {
      return { ok: false, error_code: "SOLD_OUT", sku: it.sku };
    }
    resolved.push({
      product_id: p.product_id,
      group_id: p.group_id,
      package_fen: p.package_fen,
      price: p.price,
      sku: it.sku,
      name: p.name,
      variant: p.variant,
      qty: it.qty,
    });
    const need = p.package_fen * it.qty;
    groupAgg.set(p.group_id, (groupAgg.get(p.group_id) ?? 0) + need);
  }

  const group_decrements = Array.from(groupAgg.entries()).map(([group_id, fen]) => ({
    group_id,
    fen,
  }));
  return { ok: true, resolved, group_decrements };
}

// Atomic group-pool decrement. CAS pattern: UPDATE WHERE stock_fen >= need.
// If any group's CAS misses (changes=0), compensate by restoring the groups that already
// committed and report the offending group_id.
//
// Caller MUST then INSERT audit_log rows for each successful decrement (1 row per group)
// in the SAME order POST batch — see assembleDecrementAudit() helper below.
export async function tryDecrementGroupStock(
  env: AppEnv,
  group_decrements: Array<{ group_id: number; fen: number }>,
): Promise<{ ok: true } | { ok: false; sold_out_group_id: number }> {
  if (group_decrements.length === 0) return { ok: true };

  const stmts = group_decrements.map((d) =>
    env.DB.prepare(
      `UPDATE product_groups SET stock_fen = stock_fen - ? WHERE id = ? AND stock_fen >= ?`,
    ).bind(d.fen, d.group_id, d.fen),
  );
  const results = await env.DB.batch(stmts);

  // D1 batch is all-or-nothing for COMMIT, but a 0-row CAS UPDATE is still a "successful"
  // statement — no rollback. So a miss anywhere (incl. index 0) leaves every OTHER group's
  // debit committed. Restore EVERY group that actually decremented (changes>0), regardless
  // of iteration order, then report the FIRST missed group. The old slice(0, i) approach
  // leaked stock when the index-0 group was the miss (nothing before it to slice) while a
  // later group in the same batch had already committed its debit.
  const missIdx = results.findIndex((r) => (r?.meta?.changes ?? 0) === 0);
  if (missIdx !== -1) {
    const toRestore = group_decrements.filter(
      (_, j) => (results[j]?.meta?.changes ?? 0) > 0,
    );
    if (toRestore.length) {
      await env.DB.batch(
        toRestore.map((d) =>
          env.DB.prepare(
            `UPDATE product_groups SET stock_fen = stock_fen + ? WHERE id = ?`,
          ).bind(d.fen, d.group_id),
        ),
      );
    }
    return { ok: false, sold_out_group_id: group_decrements[missIdx]!.group_id };
  }
  return { ok: true };
}

// Standalone restore (used after order_id retry exhaustion / unknown error in order POST,
// or by cancel.ts / save.ts when items shrink). Always succeeds (no CAS — we're returning
// inventory we previously held).
//
// Caller MUST also INSERT audit_log rows in their own batch — restoreGroupStock here just
// returns the prepared UPDATE statements so the caller can splice them in alongside their
// own audit + status changes.
export function groupRestoreStmts(
  env: AppEnv,
  group_increments: Array<{ group_id: number; fen: number }>,
) {
  return group_increments.map((d) =>
    env.DB.prepare(
      `UPDATE product_groups SET stock_fen = stock_fen + ? WHERE id = ?`,
    ).bind(d.fen, d.group_id),
  );
}

// Convenience: run group restore as its own batch (for unwind paths that don't need to
// piggy-back on a larger batch).
export async function restoreGroupStock(
  env: AppEnv,
  group_increments: Array<{ group_id: number; fen: number }>,
): Promise<void> {
  if (group_increments.length === 0) return;
  await env.DB.batch(groupRestoreStmts(env, group_increments));
}

// Admin intake / correction. Two-sided CAS:
//   - WHERE stock_fen = ?expected_pool_fen  → optimistic lock against another admin
//   - WHERE stock_fen + ?delta >= 0          → never let pool go negative
// If first miss, return STALE_STATE with current_pool_fen so client UI can prompt.
// If second miss (would go negative), return INVALID_DELTA.
//
// Caller MUST append audit_log row in same batch — return prepared statements so caller
// composes the full mutation.
export async function adjustGroupStock(
  env: AppEnv,
  args: { group_id: number; delta_fen: number; expected_pool_fen: number },
): Promise<
  | { ok: true; new_pool_fen: number }
  | { ok: false; error_code: "STALE_STATE"; current_pool_fen: number }
  | { ok: false; error_code: "INVALID_DELTA"; current_pool_fen: number }
> {
  // CAS UPDATE
  const updateResult = await env.DB.prepare(
    `UPDATE product_groups
       SET stock_fen = stock_fen + ?
     WHERE id = ?
       AND stock_fen = ?
       AND stock_fen + ? >= 0`,
  )
    .bind(args.delta_fen, args.group_id, args.expected_pool_fen, args.delta_fen)
    .run();

  if ((updateResult.meta?.changes ?? 0) === 0) {
    // Disambiguate: read current to tell caller why
    const cur = await env.DB.prepare(
      `SELECT stock_fen FROM product_groups WHERE id = ?`,
    )
      .bind(args.group_id)
      .first<{ stock_fen: number }>();
    const current_pool_fen = cur?.stock_fen ?? 0;
    // Check staleness FIRST: a pool that MOVED since the client loaded must be reported as
    // STALE_STATE, not INVALID_DELTA — the delta was computed against the stale value, so its
    // negativity is meaningless until the client re-reads. Only when the pool is current
    // (expected matches) does a would-go-negative delta genuinely mean INVALID_DELTA.
    if (current_pool_fen !== args.expected_pool_fen) {
      return { ok: false, error_code: "STALE_STATE", current_pool_fen };
    }
    if (current_pool_fen + args.delta_fen < 0) {
      return { ok: false, error_code: "INVALID_DELTA", current_pool_fen };
    }
    return { ok: false, error_code: "STALE_STATE", current_pool_fen };
  }
  const new_pool_fen = args.expected_pool_fen + args.delta_fen;
  return { ok: true, new_pool_fen };
}

// Restore-side helper for cancel.ts / save.ts: given an order_id, compute how much fen
// to put back into which group. Aggregates by group so multi-SKU same-group orders become
// one UPDATE.
export async function resolveOrderItemsForRestore(
  env: AppEnv,
  order_id: string,
): Promise<Array<{ group_id: number; fen: number }>> {
  const rows = (await env.DB.prepare(
    `SELECT p.group_id, oi.qty * p.package_fen AS fen
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?`,
  )
    .bind(order_id)
    .all()) as { results: Array<{ group_id: number; fen: number }> };

  const agg = new Map<number, number>();
  for (const r of rows.results) {
    agg.set(r.group_id, (agg.get(r.group_id) ?? 0) + r.fen);
  }
  return Array.from(agg.entries()).map(([group_id, fen]) => ({ group_id, fen }));
}

// Helper to build the audit_log rows that MUST accompany every stock_fen mutation.
// Caller splices these into its env.DB.batch() alongside the UPDATE product_groups stmts
// (and any other writes — order INSERT, status flag UPDATE, etc.).
//
// Returns an array of prepared statements ready to drop into a batch.
export interface StockAuditRow {
  group_id: number;
  delta_fen: number;
  before_fen: number;
  after_fen: number;
  reason:
    | "migration_init"
    | "group_intake"
    | "order_decrement"
    | "order_restore"
    | "order_edit_delta";
  source_id?: string; // e.g. order_id, intake batch id
  user_email?: string; // defaults to <system> if omitted
  season_id?: number;
  ts?: string; // defaults to now
}

export function stockAuditStmts(
  env: AppEnv,
  rows: StockAuditRow[],
) {
  const now = new Date().toISOString();
  return rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      r.ts ?? now,
      r.user_email ?? "<system>",
      "group_stock_change",
      r.reason === "order_decrement" || r.reason === "order_restore" || r.reason === "order_edit_delta"
        ? r.source_id ?? null
        : null,
      r.season_id ?? null,
      JSON.stringify({
        reason: r.reason,
        group_id: r.group_id,
        delta_fen: r.delta_fen,
        before_fen: r.before_fen,
        after_fen: r.after_fen,
        ...(r.source_id ? { source_id: r.source_id } : {}),
      }),
    ),
  );
}

// Look up current stock_fen values for a set of groups — needed to compute before_fen
// for audit trail BEFORE running the CAS UPDATE. Caller does this read first, then the
// batch (UPDATE stock_fen + INSERT audit_log) atomically.
export async function getGroupStockFen(
  env: AppEnv,
  group_ids: number[],
): Promise<Map<number, number>> {
  if (group_ids.length === 0) return new Map();
  const placeholders = group_ids.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT id, stock_fen FROM product_groups WHERE id IN (${placeholders})`,
  )
    .bind(...group_ids)
    .all()) as { results: Array<{ id: number; stock_fen: number }> };
  return new Map(rows.results.map((r) => [r.id, r.stock_fen]));
}
