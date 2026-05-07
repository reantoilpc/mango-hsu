import type { APIRoute } from "astro";
import { inArray } from "drizzle-orm";
import { makeDb } from "../../../../db/client";
import { products } from "../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { env } from "../../../../lib/env";

// V5 products batch save: sticky-save endpoint for the products page.
// Accepts N rows of `{sku, fields?, stock?, stock_reason?}`. All-or-nothing
// D1 batch with per-stmt meta.changes verification (lessons from V4 stock.ts).
//
// Scope:
//   - fields: name, variant, price, available, display_order — straight UPDATE
//   - stock: optional; requires stock_reason; gets the unshipped_total guard
//     from /products/[sku]/stock (no override in batch — push override case to
//     the per-sku endpoint with its dedicated confirm flow).
//
// Stock guard behavior on batch fail: any row's new_stock < unshipped_total
// rejects the WHOLE batch with the offending sku reported. User can edit
// that row's stock back, or use the per-sku /stock endpoint with override.

interface StockUpdate {
  new_stock: number;
  reason: string;
}

interface ProductRowFields {
  name?: string;
  variant?: string;
  price?: number;
  available?: boolean;
  display_order?: number;
}

interface ProductBatchRow {
  sku: string;
  fields?: ProductRowFields;
  stock?: StockUpdate;
}

interface BatchRequest {
  rows: ProductBatchRow[];
  idempotency_key?: string;
}

const MAX_ROWS = 50;

export const POST: APIRoute = async ({ request }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: BatchRequest;
  try {
    body = (await request.json()) as BatchRequest;
  } catch {
    return text("bad json", 400);
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return text("rows required", 400);
  }
  if (body.rows.length > MAX_ROWS) {
    return text(`too many rows (max ${MAX_ROWS})`, 400);
  }

  // Validate each row
  for (const r of body.rows) {
    if (!r.sku || !/^[A-Z0-9_-]+$/.test(r.sku)) return text(`bad sku ${r.sku}`, 400);
    if (r.fields) {
      const f = r.fields;
      if (f.name !== undefined && (typeof f.name !== "string" || f.name.trim().length === 0 || f.name.length > 50))
        return text(`bad name on ${r.sku}`, 400);
      if (f.variant !== undefined && (typeof f.variant !== "string" || f.variant.trim().length === 0 || f.variant.length > 30))
        return text(`bad variant on ${r.sku}`, 400);
      if (f.price !== undefined && (!Number.isInteger(f.price) || f.price < 0 || f.price > 100_000))
        return text(`bad price on ${r.sku}`, 400);
      if (f.display_order !== undefined && (!Number.isInteger(f.display_order) || f.display_order < 0))
        return text(`bad display_order on ${r.sku}`, 400);
      if (f.available !== undefined && typeof f.available !== "boolean")
        return text(`bad available on ${r.sku}`, 400);
    }
    if (r.stock) {
      if (!Number.isInteger(r.stock.new_stock) || r.stock.new_stock < 0 || r.stock.new_stock > 9999)
        return text(`bad stock on ${r.sku}`, 400);
      const reason = (r.stock.reason ?? "").trim();
      if (reason.length === 0 || reason.length > 200)
        return text(`reason required on ${r.sku} (1-200 chars)`, 400);
    }
    // At least one of fields or stock must be present.
    if (!r.fields && !r.stock) return text(`empty row ${r.sku}`, 400);
  }

  const db = makeDb(env);

  // Read all touched products for current values + diff.
  const skus = body.rows.map((r) => r.sku);
  const existingRows = await db
    .select()
    .from(products)
    .where(inArray(products.sku, skus));
  const existingMap = new Map(existingRows.map((p) => [p.sku, p]));

  for (const r of body.rows) {
    if (!existingMap.has(r.sku)) return text(`sku ${r.sku} not found`, 404);
  }

  // Stock guard: for any row with stock change, check unshipped_total.
  const rowsWithStock = body.rows.filter((r) => r.stock !== undefined);
  if (rowsWithStock.length > 0) {
    const stockSkus = rowsWithStock.map((r) => r.sku);
    const placeholders = stockSkus.map(() => "?").join(",");
    const stockSumResult = await env.DB.prepare(
      `SELECT oi.sku AS sku, COALESCE(SUM(oi.qty), 0) AS unshipped_total
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       WHERE oi.sku IN (${placeholders})
         AND o.shipped = 0
         AND o.cancelled_at IS NULL
       GROUP BY oi.sku`,
    ).bind(...stockSkus).all<{ sku: string; unshipped_total: number }>();

    const unshippedMap = new Map<string, number>();
    for (const row of stockSumResult.results ?? []) {
      unshippedMap.set(row.sku, row.unshipped_total ?? 0);
    }

    for (const r of rowsWithStock) {
      const unshipped = unshippedMap.get(r.sku) ?? 0;
      if (r.stock!.new_stock < unshipped) {
        return json(
          {
            ok: false,
            error_code: "STOCK_BELOW_UNSHIPPED",
            sku: r.sku,
            unshipped_total: unshipped,
            attempted: r.stock!.new_stock,
            current_stock: existingMap.get(r.sku)!.stock,
            message: `${r.sku}：新庫存 ${r.stock!.new_stock} 比未出貨單 ${unshipped} 少`,
          },
          409,
        );
      }
    }
  }

  // Build batch: per-row UPDATE + audit_log.
  type Stmt = ReturnType<typeof env.DB.prepare>;
  const batch: Stmt[] = [];
  const now = new Date().toISOString();
  let actualWrites = 0;

  for (const r of body.rows) {
    const ex = existingMap.get(r.sku)!;
    const auditDetails: Record<string, unknown> = { sku: r.sku };
    let rowChanged = false;

    if (r.fields) {
      const setParts: string[] = [];
      const setBinds: (string | number)[] = [];
      const f = r.fields;
      if (f.name !== undefined && f.name.trim() !== ex.name) {
        setParts.push("name = ?");
        setBinds.push(f.name.trim());
        auditDetails.name = { from: ex.name, to: f.name.trim() };
        rowChanged = true;
      }
      if (f.variant !== undefined && f.variant.trim() !== ex.variant) {
        setParts.push("variant = ?");
        setBinds.push(f.variant.trim());
        auditDetails.variant = { from: ex.variant, to: f.variant.trim() };
        rowChanged = true;
      }
      if (f.price !== undefined && f.price !== ex.price) {
        setParts.push("price = ?");
        setBinds.push(f.price);
        auditDetails.price = { from: ex.price, to: f.price };
        rowChanged = true;
      }
      if (f.available !== undefined && f.available !== ex.available) {
        setParts.push("available = ?");
        setBinds.push(f.available ? 1 : 0);
        auditDetails.available = { from: ex.available, to: f.available };
        rowChanged = true;
      }
      if (f.display_order !== undefined && f.display_order !== ex.display_order) {
        setParts.push("display_order = ?");
        setBinds.push(f.display_order);
        auditDetails.display_order = { from: ex.display_order, to: f.display_order };
        rowChanged = true;
      }
      if (setParts.length > 0) {
        batch.push(
          env.DB.prepare(
            `UPDATE products SET ${setParts.join(", ")} WHERE sku = ?`,
          ).bind(...setBinds, r.sku),
        );
        actualWrites += 1;
      }
    }

    if (r.stock && r.stock.new_stock !== ex.stock) {
      batch.push(
        env.DB.prepare(`UPDATE products SET stock = ? WHERE sku = ?`).bind(
          r.stock.new_stock,
          r.sku,
        ),
      );
      auditDetails.stock = {
        from: ex.stock,
        to: r.stock.new_stock,
        reason: r.stock.reason.trim(),
      };
      actualWrites += 1;
      rowChanged = true;
    }

    if (rowChanged) {
      batch.push(
        env.DB.prepare(
          `INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)`,
        ).bind(
          now,
          auth.session.email,
          r.stock ? "product_batch_save" : "product_update",
          JSON.stringify({
            ...auditDetails,
            ...(body.idempotency_key ? { idempotency_key: body.idempotency_key } : {}),
          }),
        ),
      );
    }
  }

  if (actualWrites === 0) {
    return json({ ok: true, applied: 0, message: "no changes" });
  }

  const results = await env.DB.batch(batch);

  // Per-stmt meta.changes verification (V4 stock.ts pattern). All stmts in
  // batch are UPDATEs or INSERTs that must have changes >= 1. Any 0 = bug.
  for (let i = 0; i < results.length; i++) {
    if ((results[i]?.meta?.changes ?? 0) === 0) {
      return json(
        {
          ok: false,
          error_code: "BATCH_PARTIAL_FAILURE",
          failed_at: i,
          message: "某 row 的 UPDATE 未生效，請重新整理頁面",
        },
        500,
      );
    }
  }

  return json({ ok: true, applied: actualWrites });
};
