import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_items, products } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import {
  tryDecrementStock,
  restoreStock,
  stockRestoreStmts,
} from "../../../../../lib/stock";
import { shippingFor } from "../../../../../lib/order-response";
import { env } from "../../../../../lib/env";

interface ItemInput {
  sku: string;
  qty: number;
}

interface PatchItemsRequest {
  items: ItemInput[];
}

// V4: full item-edit endpoint. Replaces the V2 hand-wavy "diff > 0 / diff < 0"
// design with a real subsystem that handles the four real cases:
//   - qty change (existing SKU, new qty different)
//   - add SKU (not on order before, now is)
//   - remove SKU (was on order, now isn't — equivalent to qty=0)
//   - shipping recompute (totalQty changes → shippingFor returns different fee)
//
// Only allowed on orders that are NOT yet paid AND NOT yet shipped AND not
// cancelled — same gate as cancel. Editing a paid/shipped order is not in V4
// scope (need refund / return flows).
//
// Stock semantics:
//   1. Compute diff: for each SKU, qtyChange = (new qty) - (existing qty).
//      Vanished SKUs: qtyChange = -(existing qty).
//      Added SKUs:    qtyChange = +(new qty).
//   2. Phase A: tryDecrementStock(decrements) for SKUs with qtyChange > 0.
//      On SOLD_OUT we return without touching the order.
//   3. Phase B: single atomic batch — stockRestoreStmts(restores) +
//      DELETE/UPDATE/INSERT order_items + UPDATE orders.subtotal/shipping/total
//      + INSERT audit_log. Atomic so the order's items/totals never split
//      from the audit row.
//   4. If Phase B throws (D1 transient): catch, restoreStock(decrements) to
//      unwind Phase A, throw 500. Brief race window between Phase A and
//      Phase B catch is documented as Known Hole (V4 design).
export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  let body: PatchItemsRequest;
  try {
    body = (await request.json()) as PatchItemsRequest;
  } catch {
    return text("bad json", 400);
  }
  if (!Array.isArray(body.items)) return text("items required", 400);
  if (body.items.length === 0) return text("at least one item required", 400);
  for (const it of body.items) {
    if (
      !it ||
      typeof it.sku !== "string" ||
      !Number.isInteger(it.qty) ||
      it.qty < 1 ||
      it.qty > 99
    ) {
      return text("invalid item shape", 400);
    }
  }

  const db = makeDb(env);

  // 1. Read order + check editability
  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.order_id, id))
    .limit(1);
  const order = orderRows[0];
  if (!order) return text("not_found", 404);
  if (order.cancelled_at !== null) {
    return json({ ok: false, error_code: "EDIT_FORBIDDEN", reason: "cancelled" }, 409);
  }
  if (order.paid) {
    return json({ ok: false, error_code: "EDIT_FORBIDDEN", reason: "paid" }, 409);
  }
  if (order.shipped) {
    return json({ ok: false, error_code: "EDIT_FORBIDDEN", reason: "shipped" }, 409);
  }

  // 2. Read existing line items + product catalog
  const existing = await db
    .select()
    .from(order_items)
    .where(eq(order_items.order_id, id));
  const productRows = await db.select().from(products);
  const prodMap = new Map(productRows.map((p) => [p.sku, p]));

  // Validate every SKU in the request exists and is still available.
  // (We allow stock=0 here only as a "decrease qty" path; stock-required
  // checks happen via tryDecrementStock for the actual decrements.)
  for (const it of body.items) {
    const p = prodMap.get(it.sku);
    if (!p) {
      return json(
        { ok: false, error_code: "INVALID_INPUT", message: `unknown sku ${it.sku}` },
        400,
      );
    }
    if (!p.available) {
      return json(
        { ok: false, error_code: "SOLD_OUT", sold_out_sku: it.sku },
        409,
      );
    }
  }

  // 3. Compute diff per SKU
  const existingMap = new Map(existing.map((e) => [e.sku, e]));
  const newMap = new Map(body.items.map((i) => [i.sku, i]));

  const decrements: ItemInput[] = []; // qty went up or new SKU
  const restores: ItemInput[] = []; // qty went down or removed SKU
  const updates: ItemInput[] = []; // existing SKU, qty changed
  const inserts: ItemInput[] = []; // new SKU
  const deletes: string[] = []; // removed SKU

  for (const ni of body.items) {
    const ex = existingMap.get(ni.sku);
    if (!ex) {
      // New SKU: claim full qty from stock; INSERT into order_items.
      decrements.push({ sku: ni.sku, qty: ni.qty });
      inserts.push(ni);
    } else if (ex.qty !== ni.qty) {
      const delta = ni.qty - ex.qty;
      if (delta > 0) decrements.push({ sku: ni.sku, qty: delta });
      else restores.push({ sku: ni.sku, qty: -delta });
      updates.push(ni);
    }
    // else: qty unchanged — nothing to do for this SKU.
  }
  for (const ex of existing) {
    if (!newMap.has(ex.sku)) {
      // Removed SKU: give back full qty; DELETE from order_items.
      restores.push({ sku: ex.sku, qty: ex.qty });
      deletes.push(ex.sku);
    }
  }

  // Recompute money fields from new items[] + the price snapshot in products.
  // Note: V2 stored unit_price per order_item to avoid drift; V4 keeps that
  // — for kept-SKUs we reuse the existing unit_price; for new/changed SKUs
  // we snapshot the current product.price.
  const newSubtotal = body.items.reduce((s, it) => {
    const ex = existingMap.get(it.sku);
    const unit = ex ? ex.unit_price : prodMap.get(it.sku)!.price;
    return s + unit * it.qty;
  }, 0);
  const newShipping = shippingFor(body.items, env);
  const newTotal = newSubtotal + newShipping;

  // 4. Phase A: claim stock for decrements (atomic CAS, SOLD_OUT check)
  if (decrements.length > 0) {
    const reserve = await tryDecrementStock(env, decrements);
    if (!reserve.ok) {
      return json(
        { ok: false, error_code: "SOLD_OUT", sold_out_sku: reserve.sold_out_sku },
        409,
      );
    }
  }

  // 5. Phase B: single atomic batch — restore + items mutations + audit
  const now = new Date().toISOString();
  try {
    const batch: ReturnType<typeof env.DB.prepare>[] = [];

    if (restores.length > 0) {
      batch.push(...stockRestoreStmts(env, restores));
    }
    if (deletes.length > 0) {
      const placeholders = deletes.map(() => "?").join(",");
      batch.push(
        env.DB.prepare(
          `DELETE FROM order_items WHERE order_id = ? AND sku IN (${placeholders})`,
        ).bind(id, ...deletes),
      );
    }
    for (const u of updates) {
      batch.push(
        env.DB.prepare(
          `UPDATE order_items SET qty = ? WHERE order_id = ? AND sku = ?`,
        ).bind(u.qty, id, u.sku),
      );
    }
    for (const ins of inserts) {
      batch.push(
        env.DB.prepare(
          `INSERT INTO order_items (order_id, sku, qty, unit_price) VALUES (?, ?, ?, ?)`,
        ).bind(id, ins.sku, ins.qty, prodMap.get(ins.sku)!.price),
      );
    }
    batch.push(
      env.DB.prepare(
        `UPDATE orders SET subtotal = ?, shipping = ?, total = ? WHERE order_id = ?`,
      ).bind(newSubtotal, newShipping, newTotal, id),
    );
    batch.push(
      env.DB.prepare(
        `INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        now,
        auth.session.email,
        "order_items_edited",
        id,
        JSON.stringify({
          before: existing.map((e) => ({ sku: e.sku, qty: e.qty })),
          after: body.items,
          decrements,
          restores,
        }),
      ),
    );

    await env.DB.batch(batch);
    return json({
      ok: true,
      subtotal: newSubtotal,
      shipping: newShipping,
      total: newTotal,
    });
  } catch (err) {
    // Phase B failed AFTER Phase A succeeded — unwind decrements so stock
    // doesn't drift. Brief race window vs. concurrent customer orders is
    // documented as a Known Hole (V4 design).
    if (decrements.length > 0) {
      await restoreStock(env, decrements);
    }
    return json({ ok: false, error_code: "INTERNAL" }, 500);
  }
};
