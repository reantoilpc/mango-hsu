import type { APIRoute } from "astro";
import { eq, desc } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import {
  orders,
  order_items,
  products,
  audit_log,
  seasons,
} from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import {
  resolveItemsForStock,
  tryDecrementGroupStock,
  restoreGroupStock,
  groupRestoreStmts,
  stockAuditStmts,
  getGroupStockFen,
} from "../../../../../lib/stock";
import { shippingFor } from "../../../../../lib/order-response";
import { compareItemsHash } from "../../../../../lib/items-hash";
import { env } from "../../../../../lib/env";

// V5 sticky-save endpoint (V5.2-adapted): single 打點 for editable fields on the order detail
// page (items + address + notes). Status events (paid/shipped/cancel) stay on their own
// endpoints — they're events, not edits.
//
// Pattern (per /autoplan eng review): gate-first via separate SELECT (cancel.ts pattern), NOT
// mid-batch (mark-paid.ts had the 0-row-UPDATE bug). Phase A (stock CAS) is its own batch with
// internal compensation; Phase B (data + audit) is one atomic batch with caller-side restore
// on throw.
//
// V5.2 changes from V5:
//   - items diff converts to net fen deltas per group_id (not per-sku decrements)
//   - items_hash uses server-side dual-format (sku-hash OR product_id-hash) so cached old JS
//     bundles still work post-deploy
//   - new order_items rows carry product_id + sku snapshot
//   - per-group audit_log rows for stock_fen mutations (reason='order_edit_delta')

interface ItemInput {
  sku: string;
  qty: number;
}

interface SaveRequest {
  items?: ItemInput[];
  address?: string;
  notes?: string;
  expected_state: {
    paid: boolean;
    shipped: boolean;
    cancelled_at: string | null;
    items_hash?: string;
  };
  idempotency_key?: string;
}

const IDEMPOTENCY_WINDOW_MS = 60_000;

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  let body: SaveRequest;
  try {
    body = (await request.json()) as SaveRequest;
  } catch {
    return text("bad json", 400);
  }

  if (
    !body.expected_state ||
    typeof body.expected_state.paid !== "boolean" ||
    typeof body.expected_state.shipped !== "boolean" ||
    (body.expected_state.cancelled_at !== null &&
      typeof body.expected_state.cancelled_at !== "string")
  ) {
    return text("expected_state required", 400);
  }

  const idempotencyKey =
    body.idempotency_key ?? request.headers.get("Idempotency-Key") ?? null;

  const db = makeDb(env);

  // Step 1: Idempotency replay check — scan the last N audit rows.
  if (idempotencyKey) {
    const recent = await db
      .select()
      .from(audit_log)
      .where(eq(audit_log.order_id, id))
      .orderBy(desc(audit_log.ts))
      .limit(10);
    for (const row of recent) {
      if (!row.details) continue;
      try {
        const parsed = JSON.parse(row.details) as { idempotency_key?: string };
        if (parsed.idempotency_key !== idempotencyKey) continue;
        const rowTs = Date.parse(row.ts);
        if (Number.isFinite(rowTs) && Date.now() - rowTs < IDEMPOTENCY_WINDOW_MS) {
          return json(await loadOrderJson(db, id));
        }
      } catch {
        /* malformed details JSON — keep scanning */
      }
    }
  }

  // Step 2: Read current order + items + validate expected_state.
  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.order_id, id))
    .limit(1);
  const order = orderRows[0];
  if (!order) return text("not_found", 404);

  const currentItems = await db
    .select()
    .from(order_items)
    .where(eq(order_items.order_id, id));

  // V5.2 dual-format hash compare. compareItemsHash tries both legacy sku-based and new
  // product_id-based formulas — caller's hash wins as long as one matches.
  const stateStale =
    order.paid !== body.expected_state.paid ||
    order.shipped !== body.expected_state.shipped ||
    order.cancelled_at !== body.expected_state.cancelled_at;
  const itemsStale =
    typeof body.expected_state.items_hash === "string" &&
    !compareItemsHash(currentItems, body.expected_state.items_hash);

  if (stateStale || itemsStale) {
    return json(
      {
        ok: false,
        error_code: "STALE_STATE",
        stale_reason: itemsStale && !stateStale ? "items" : stateStale && itemsStale ? "both" : "status",
        current_state: {
          paid: order.paid,
          shipped: order.shipped,
          cancelled_at: order.cancelled_at,
          // Note: client-supplied items_hash format is whatever the client sent;
          // we don't echo back a "current_hash" because there are two possible
          // formats and the client picks one. They re-compute on reload.
        },
        current_order: await loadOrderJson(db, id),
      },
      409,
    );
  }

  const isReadOnly =
    order.paid || order.shipped || order.cancelled_at !== null;
  const wantsItemsEdit = Array.isArray(body.items);

  if (isReadOnly && wantsItemsEdit) {
    return json(
      {
        ok: false,
        error_code: "EDIT_FORBIDDEN",
        reason: "items locked when paid/shipped/cancelled",
      },
      409,
    );
  }
  if (
    order.cancelled_at !== null &&
    (body.address !== undefined || body.notes !== undefined)
  ) {
    return json(
      {
        ok: false,
        error_code: "EDIT_FORBIDDEN",
        reason: "cancelled order is immutable",
      },
      409,
    );
  }

  // Step 3: Validate inputs (when present).
  if (wantsItemsEdit) {
    if (body.items!.length === 0) return text("at least one item required", 400);
    for (const it of body.items!) {
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
  }

  let newAddress: string | null = null;
  if (body.address !== undefined) {
    const a = body.address.trim();
    if (a.length < 5 || a.length > 200) return text("bad address", 400);
    newAddress = a;
  }
  let newNotes: string | null = null;
  let notesProvided = false;
  if (body.notes !== undefined) {
    const n = body.notes.trim();
    if (n.length > 500) return text("notes too long", 400);
    newNotes = n.length === 0 ? null : n;
    notesProvided = true;
  }

  // Step 4: Server-side field diff.
  const auditedChanges: Record<string, unknown> = {};

  if (newAddress !== null && newAddress !== order.address) {
    auditedChanges.address = { before_len: order.address.length, after_len: newAddress.length };
  }
  if (notesProvided && newNotes !== order.notes) {
    auditedChanges.notes = {
      before_len: (order.notes ?? "").length,
      after_len: (newNotes ?? "").length,
    };
  }

  // Step 5: If items edit, resolve new items + compute fen-level diff per group.
  let resolvedNew: Awaited<ReturnType<typeof resolveItemsForStock>> | null = null;
  let netDecrements: Array<{ group_id: number; fen: number }> = [];
  let netRestores: Array<{ group_id: number; fen: number }> = [];
  const updates: Array<{ id: number; qty: number }> = [];
  const inserts: Array<{ product_id: number; sku: string; qty: number; unit_price: number }> = [];
  const deletes: number[] = []; // order_items.id rows to delete
  let newSubtotal = order.subtotal;
  let newShipping = order.shipping;
  let newTotal = order.total;

  if (wantsItemsEdit) {
    resolvedNew = await resolveItemsForStock(env, body.items!);
    if (!resolvedNew.ok) {
      if (resolvedNew.error_code === "unknown_product") {
        return json(
          { ok: false, error_code: "unknown_product", sku: resolvedNew.sku },
          400,
        );
      }
      return json(
        { ok: false, error_code: "SOLD_OUT", sku: resolvedNew.sku },
        409,
      );
    }

    // Match new items to existing by sku (sku is stable within a season + within
    // an active order). Compute qty deltas per existing row + identify new SKUs.
    const existingBySku = new Map(currentItems.map((e) => [e.sku, e]));
    const newBySku = new Map(resolvedNew.resolved.map((r) => [r.sku, r]));

    // Group fen flux accumulator: positive = need more, negative = freeing
    const groupFlux = new Map<number, number>();

    for (const r of resolvedNew.resolved) {
      const ex = existingBySku.get(r.sku);
      if (!ex) {
        // New SKU on this order
        const need = r.package_fen * r.qty;
        groupFlux.set(r.group_id, (groupFlux.get(r.group_id) ?? 0) + need);
        inserts.push({
          product_id: r.product_id,
          sku: r.sku,
          qty: r.qty,
          unit_price: r.price,
        });
      } else if (ex.qty !== r.qty) {
        const deltaQty = r.qty - ex.qty;
        const deltaFen = r.package_fen * deltaQty;
        groupFlux.set(r.group_id, (groupFlux.get(r.group_id) ?? 0) + deltaFen);
        updates.push({ id: ex.id, qty: r.qty });
      }
      // else: qty unchanged — nothing to do
    }
    for (const ex of currentItems) {
      if (!newBySku.has(ex.sku)) {
        // Removed SKU — restore full qty's worth of fen.
        // Need to look up product to get group_id + package_fen for the existing row.
        // Fast path: use ex.product_id to look up.
        // We do a single mini-query inline for any deleted SKU; in practice small.
        const prodRow = await db
          .select({ group_id: products.group_id, package_fen: products.package_fen })
          .from(products)
          .where(eq(products.id, ex.product_id))
          .limit(1);
        const p = prodRow[0];
        if (p) {
          const back = p.package_fen * ex.qty;
          groupFlux.set(p.group_id, (groupFlux.get(p.group_id) ?? 0) - back);
        }
        deletes.push(ex.id);
      }
    }

    // Split net flux into decrement vs restore lists
    for (const [group_id, delta] of groupFlux.entries()) {
      if (delta > 0) netDecrements.push({ group_id, fen: delta });
      else if (delta < 0) netRestores.push({ group_id, fen: -delta });
    }

    const itemsChanged =
      netDecrements.length > 0 ||
      netRestores.length > 0 ||
      deletes.length > 0 ||
      inserts.length > 0 ||
      updates.length > 0;
    if (itemsChanged) {
      // Recompute money: kept SKUs reuse existing unit_price; new/changed reuse new price.
      newSubtotal = resolvedNew.resolved.reduce((s, r) => {
        const ex = existingBySku.get(r.sku);
        const unit = ex ? ex.unit_price : r.price;
        return s + unit * r.qty;
      }, 0);
      newShipping = shippingFor(resolvedNew.resolved, env);
      newTotal = newSubtotal + newShipping;
      auditedChanges.items = {
        before: currentItems.map((e) => ({ sku: e.sku, qty: e.qty, product_id: e.product_id })),
        after: resolvedNew.resolved.map((r) => ({ sku: r.sku, qty: r.qty, product_id: r.product_id })),
        net_decrements: netDecrements,
        net_restores: netRestores,
      };
    }
  }

  // Nothing actually changed — short-circuit, return current state.
  if (Object.keys(auditedChanges).length === 0) {
    return json(await loadOrderJson(db, id));
  }

  // Step 6: Phase A — claim stock for net decrements (atomic CAS with internal compensation).
  if (netDecrements.length > 0) {
    const reserve = await tryDecrementGroupStock(env, netDecrements);
    if (!reserve.ok) {
      return json(
        { ok: false, error_code: "SOLD_OUT", sold_out_group_id: reserve.sold_out_group_id },
        409,
      );
    }
  }

  // Step 7: Phase B — single atomic batch (restore + items + address/notes + audit).
  const now = new Date().toISOString();

  // Read group stock_fen AFTER phase A (which decremented) so audit before/after for
  // restores reflect post-decrement values. For decrements, we computed before during
  // Phase A but didn't capture — read both at once now.
  const allTouchedGroupIds = Array.from(
    new Set([
      ...netDecrements.map((d) => d.group_id),
      ...netRestores.map((r) => r.group_id),
    ]),
  );
  const fenAfterPhaseA = await getGroupStockFen(env, allTouchedGroupIds);

  try {
    type Stmt = ReturnType<typeof env.DB.prepare>;
    const batch: Stmt[] = [];

    if (netRestores.length > 0) {
      batch.push(...groupRestoreStmts(env, netRestores));
    }
    if (deletes.length > 0) {
      const placeholders = deletes.map(() => "?").join(",");
      batch.push(
        env.DB.prepare(
          `DELETE FROM order_items WHERE order_id = ? AND id IN (${placeholders})`,
        ).bind(id, ...deletes),
      );
    }
    for (const u of updates) {
      batch.push(
        env.DB.prepare(`UPDATE order_items SET qty = ? WHERE id = ?`).bind(u.qty, u.id),
      );
    }
    for (const ins of inserts) {
      batch.push(
        env.DB.prepare(
          `INSERT INTO order_items (order_id, product_id, sku, qty, unit_price) VALUES (?, ?, ?, ?, ?)`,
        ).bind(id, ins.product_id, ins.sku, ins.qty, ins.unit_price),
      );
    }
    if (auditedChanges.items) {
      batch.push(
        env.DB.prepare(
          `UPDATE orders SET subtotal = ?, shipping = ?, total = ? WHERE order_id = ?`,
        ).bind(newSubtotal, newShipping, newTotal, id),
      );
    }
    if (newAddress !== null && newAddress !== order.address) {
      batch.push(
        env.DB.prepare(`UPDATE orders SET address = ? WHERE order_id = ?`).bind(
          newAddress,
          id,
        ),
      );
    }
    if (notesProvided && newNotes !== order.notes) {
      batch.push(
        env.DB.prepare(`UPDATE orders SET notes = ? WHERE order_id = ?`).bind(
          newNotes,
          id,
        ),
      );
    }

    // Per-group stock audit rows (one per touched group; positive delta = restore, negative = decrement)
    const stockAuditRows = [
      ...netDecrements.map((d) => {
        // After Phase A, stock_fen is already decremented. before = after + d.fen
        const after = fenAfterPhaseA.get(d.group_id) ?? 0;
        return {
          group_id: d.group_id,
          delta_fen: -d.fen,
          before_fen: after + d.fen,
          after_fen: after,
          reason: "order_edit_delta" as const,
          source_id: id,
          user_email: auth.session.email,
          season_id: order.season_id ?? undefined,
          ts: now,
        };
      }),
      ...netRestores.map((r) => {
        // Phase B will increment; before = current (Phase A wasn't a restore), after = before + r.fen
        const before = fenAfterPhaseA.get(r.group_id) ?? 0;
        return {
          group_id: r.group_id,
          delta_fen: r.fen,
          before_fen: before,
          after_fen: before + r.fen,
          reason: "order_edit_delta" as const,
          source_id: id,
          user_email: auth.session.email,
          season_id: order.season_id ?? undefined,
          ts: now,
        };
      }),
    ];
    if (stockAuditRows.length > 0) {
      batch.push(...stockAuditStmts(env, stockAuditRows));
    }

    // Order-save audit row (with idempotency_key for replay scan)
    batch.push(
      env.DB.prepare(
        `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        now,
        auth.session.email,
        "order_save",
        id,
        order.season_id ?? null,
        JSON.stringify({
          ...auditedChanges,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        }),
      ),
    );

    await env.DB.batch(batch);
    return json(await loadOrderJson(db, id));
  } catch {
    if (netDecrements.length > 0) {
      await restoreGroupStock(env, netDecrements);
    }
    return json({ ok: false, error_code: "INTERNAL" }, 500);
  }
};

interface OrderJson {
  ok: true;
  order: typeof orders.$inferSelect;
  items: Array<typeof order_items.$inferSelect>;
  audit_log: Array<typeof audit_log.$inferSelect>;
  [k: string]: unknown;
}

async function loadOrderJson(
  db: ReturnType<typeof makeDb>,
  id: string,
): Promise<OrderJson> {
  const o = await db
    .select()
    .from(orders)
    .where(eq(orders.order_id, id))
    .limit(1);
  const its = await db
    .select()
    .from(order_items)
    .where(eq(order_items.order_id, id));
  const al = await db
    .select()
    .from(audit_log)
    .where(eq(audit_log.order_id, id))
    .orderBy(desc(audit_log.ts))
    .limit(50);
  return { ok: true, order: o[0]!, items: its, audit_log: al };
}
