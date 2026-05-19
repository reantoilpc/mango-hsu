import type { APIRoute } from "astro";
import { and, eq, inArray } from "drizzle-orm";
import { makeDb } from "../../../../db/client";
import { products, seasons } from "../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { env } from "../../../../lib/env";

// V5 products batch save (V5.2-adapted).
// Sticky-save endpoint for the admin products page. Accepts N rows of `{sku, fields?}`.
// All-or-nothing D1 batch with per-stmt meta.changes verification (lessons from V4 stock.ts).
//
// V5.2 changes:
//   - Lookup is now (active_season_id, sku) → product_id. Same-SKU strings across seasons
//     stay isolated.
//   - The `stock` field is REMOVED. Stock lives on product_groups.stock_fen now; adjust via
//     the dedicated /api/admin/product-groups/:id/intake endpoint (PR2). The old stock guard
//     here (unshipped_total comparison) doesn't apply — group fen pool model already prevents
//     oversell at order time.
//   - fields editable: name, variant, price, available, display_order. (Not group_id, not
//     package_fen — those would require migration-style rewrites.)
//
// Stock adjustments via this endpoint return 400 with a clear message.

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
  // V5.2: stock field rejected — kept here for clearer error message.
  stock?: unknown;
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
    if (r.stock !== undefined) {
      return json(
        {
          ok: false,
          error_code: "DEPRECATED_FIELD",
          sku: r.sku,
          message:
            "V5.2: 不能透過 batch 改 stock。請用「進貨」功能（PR2）— POST /api/admin/product-groups/:id/intake",
        },
        400,
      );
    }
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
    if (!r.fields) return text(`empty row ${r.sku}`, 400);
  }

  const db = makeDb(env);

  // Resolve active season (lookup scope)
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  if (seasonRow.length === 0) {
    return json({ ok: false, error_code: "NO_ACTIVE_SEASON" }, 409);
  }
  const seasonId = seasonRow[0]!.id;

  // Read all touched products WITHIN the active season
  const skus = body.rows.map((r) => r.sku);
  const existingRows = await db
    .select()
    .from(products)
    .where(and(eq(products.season_id, seasonId), inArray(products.sku, skus)));
  const existingMap = new Map(existingRows.map((p) => [p.sku, p]));

  for (const r of body.rows) {
    if (!existingMap.has(r.sku)) return text(`sku ${r.sku} not found in active season`, 404);
  }

  // Build batch: per-row UPDATE + audit_log.
  type Stmt = ReturnType<typeof env.DB.prepare>;
  const batch: Stmt[] = [];
  const now = new Date().toISOString();
  let actualWrites = 0;

  for (const r of body.rows) {
    const ex = existingMap.get(r.sku)!;
    const auditDetails: Record<string, unknown> = { sku: r.sku, product_id: ex.id };
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
            `UPDATE products SET ${setParts.join(", ")} WHERE id = ?`,
          ).bind(...setBinds, ex.id),
        );
        actualWrites += 1;
      }
    }

    if (rowChanged) {
      batch.push(
        env.DB.prepare(
          `INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'product_update', ?, ?)`,
        ).bind(
          now,
          auth.session.email,
          seasonId,
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

  // Per-stmt meta.changes verification (V4 stock.ts pattern). All stmts in batch are
  // UPDATEs or INSERTs that must have changes >= 1. Any 0 = bug.
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
