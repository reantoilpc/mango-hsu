import type { APIRoute } from "astro";
import { eq, and, sql } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { products, order_items, orders, audit_log } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { env } from "../../../../../lib/env";

interface StockAdjustRequest {
  new_stock: number;
  reason: string;
  override_unshipped?: boolean;
}

// V4: PATCH stock for a SKU. Used for restock / correction / write-off.
// Bounds: 0-9999 integer (defensive cap; family-scale year volume well below this).
// Reason: required free text 1-200 chars; written to audit_log details.
// Sanity: if new_stock < SUM(qty) of unshipped active orders for this SKU,
// reject with 409 + unshipped_total unless override_unshipped=true. The UI's
// confirm dialog flips that flag on the second submit.
//
// Why we DO this check: admin types stock=5 by mistake when 8 are already
// promised — the physical packs aren't there to fulfil those orders. Better
// to surface the discrepancy than silently break an invariant.
// Why override is allowed: real-world cases (壞貨報廢 / 退貨入庫差異) need
// to override the math; the audit_log records the override + reason.
export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const sku = params.sku;
  if (!sku || !/^[A-Z0-9_-]+$/.test(sku)) return text("bad sku", 400);

  let body: StockAdjustRequest;
  try {
    body = (await request.json()) as StockAdjustRequest;
  } catch {
    return text("bad json", 400);
  }

  const newStock = Number(body.new_stock);
  if (!Number.isInteger(newStock) || newStock < 0 || newStock > 9999) {
    return json(
      { ok: false, error_code: "INVALID_INPUT", message: "new_stock 須為 0-9999 整數" },
      400,
    );
  }
  const reason = (body.reason ?? "").trim();
  if (reason.length === 0 || reason.length > 200) {
    return json(
      { ok: false, error_code: "INVALID_INPUT", message: "reason 須為 1-200 字" },
      400,
    );
  }
  const override = body.override_unshipped === true;

  const db = makeDb(env);

  // Read current stock
  const productRows = await db
    .select()
    .from(products)
    .where(eq(products.sku, sku))
    .limit(1);
  const product = productRows[0];
  if (!product) return text("sku not found", 404);
  const currentStock = product.stock;

  // SUM unshipped active orders qty for this SKU.
  // "unshipped" + "active" = paid OR unpaid, just not shipped and not cancelled.
  const sumRow = await db.all<{ unshipped_total: number | null }>(
    sql`SELECT COALESCE(SUM(oi.qty), 0) AS unshipped_total
        FROM order_items oi
        JOIN orders o ON o.order_id = oi.order_id
        WHERE oi.sku = ${sku}
          AND o.shipped = 0
          AND o.cancelled_at IS NULL`,
  );
  const unshippedTotal = sumRow[0]?.unshipped_total ?? 0;

  if (newStock < unshippedTotal && !override) {
    return json(
      {
        ok: false,
        error_code: "STOCK_BELOW_UNSHIPPED",
        message: "新庫存比未出貨單總量還少",
        unshipped_total: unshippedTotal,
        current_stock: currentStock,
      },
      409,
    );
  }

  // Apply change atomically with audit
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE products SET stock = ? WHERE sku = ?`).bind(newStock, sku),
    env.DB.prepare(
      `INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, 'stock_adjusted', ?)`,
    ).bind(
      now,
      auth.session.email,
      JSON.stringify({
        sku,
        from: currentStock,
        to: newStock,
        reason,
        override_unshipped: override,
        unshipped_total_at_adjust: unshippedTotal,
      }),
    ),
  ]);

  return json({ ok: true, sku, from: currentStock, to: newStock });
};
