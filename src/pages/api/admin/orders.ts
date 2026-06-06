import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json } from "../../../lib/admin-api";
import { makeDb } from "../../../db/client";
import { orders, order_items, seasons } from "../../../db/schema";
import { nextOrderId } from "../../../lib/order-id";
import { expectedMemoFor, shippingFor } from "../../../lib/order-response";
import { validateAdminOrder } from "../../../lib/order-validate";
import { isUniqueOnIdempotency, isUniqueOnOrderId } from "../../../lib/order-errors";
import {
  resolveItemsForStock,
  tryDecrementGroupStock,
  restoreGroupStock,
  getGroupStockFen,
  stockAuditStmts,
} from "../../../lib/stock";
import { env } from "../../../lib/env";

interface AdminOrderRequest {
  idempotency_key: string;
  name: string;
  phone: string;
  address: string;
  notes?: string;
  items: Array<{ sku: string; qty: number }>;
}

// V5.2 admin-side order creation — for the user (or wife) to relay LINE orders the aunt
// receives offline. No customer-facing safeguards (token / honeypot / PDPA checkbox), no
// Telegram push (we built it ourselves, no need to notify ourselves), no LIFF push (no
// line_user_id at admin-create time).
//
// Idempotency precheck happens BEFORE stock decrement: a double-clicked submit must replay
// the first order, not consume more stock and then replay.
export const POST: APIRoute = async ({ request, locals: _locals }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error_code: auth.reason }, auth.status);

  let body: AdminOrderRequest;
  try {
    body = (await request.json()) as AdminOrderRequest;
  } catch {
    return json({ ok: false, error_code: "INVALID_INPUT" }, 400);
  }

  if (!body.idempotency_key || typeof body.idempotency_key !== "string") {
    return json({ ok: false, error_code: "INVALID_INPUT" }, 400);
  }

  const invalid = validateAdminOrder(body);
  if (invalid) return json({ ...invalid }, 400);

  const db = makeDb(env);

  // 1) Idempotency precheck FIRST (before stock decrement) — wife double-clicks the submit
  // button: the second request must replay the first order, not consume stock again then
  // replay.
  const prior = await db
    .select()
    .from(orders)
    .where(eq(orders.idempotency_key, body.idempotency_key))
    .limit(1);
  if (prior.length > 0) {
    return json({
      ok: true,
      order_id: prior[0]!.order_id,
      total: prior[0]!.total,
      replayed: true,
    });
  }

  // 2) Resolve items against active-season products (V5.2 model).
  const resolved = await resolveItemsForStock(env, body.items);
  if (!resolved.ok) {
    if (resolved.error_code === "unknown_product") {
      return json({ ok: false, error_code: "unknown_product", sku: resolved.sku }, 400);
    }
    return json({ ok: false, error_code: "SOLD_OUT", sku: resolved.sku }, 409);
  }

  // 3) Compute totals from resolved snapshot.
  let subtotal = 0;
  for (const r of resolved.resolved) {
    subtotal += r.price * r.qty;
  }
  const shipping = shippingFor(resolved.resolved, env);
  const total = subtotal + shipping;

  // 4) Read group stock_fen BEFORE the CAS for audit before/after.
  const groupIds = resolved.group_decrements.map((d) => d.group_id);
  const beforeFenMap = await getGroupStockFen(env, groupIds);

  // 5) Atomic group-pool reserve.
  const reserve = await tryDecrementGroupStock(env, resolved.group_decrements);
  if (!reserve.ok) {
    return json(
      { ok: false, error_code: "SOLD_OUT", sold_out_group_id: reserve.sold_out_group_id },
      409,
    );
  }

  // 6) Look up active season id.
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const seasonId = seasonRow[0]?.id ?? null;

  // 7) Insert with race-aware order_id retry (max 3).
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderId = await nextOrderId(db);
    const expectedMemo = expectedMemoFor(orderId, body.name);
    const createdAt = new Date().toISOString();

    try {
      await env.DB.batch([
        env.DB.prepare(
          // pdpa_accepted=0: admin-relayed order, customer didn't tick the PDPA checkbox.
          `INSERT INTO orders (order_id, season_id, created_at, name, phone, address, notes, subtotal, shipping, total, expected_memo, pdpa_accepted, paid, shipped, idempotency_key)
           VALUES            (?,        ?,         ?,          ?,    ?,     ?,       ?,     ?,        ?,        ?,     ?,             0,             0,    0,       ?)`,
        ).bind(
          orderId,
          seasonId,
          createdAt,
          body.name,
          body.phone,
          body.address,
          body.notes || null,
          subtotal,
          shipping,
          total,
          expectedMemo,
          body.idempotency_key,
        ),
        ...resolved.resolved.map((r) =>
          env.DB.prepare(
            `INSERT INTO order_items (order_id, product_id, sku, qty, unit_price) VALUES (?, ?, ?, ?, ?)`,
          ).bind(orderId, r.product_id, r.sku, r.qty, r.price),
        ),
        ...stockAuditStmts(
          env,
          resolved.group_decrements.map((d) => {
            const before = beforeFenMap.get(d.group_id) ?? 0;
            return {
              group_id: d.group_id,
              delta_fen: -d.fen,
              before_fen: before,
              after_fen: before - d.fen,
              reason: "order_decrement" as const,
              source_id: orderId,
              user_email: auth.session.email,
              season_id: seasonId ?? undefined,
              ts: createdAt,
            };
          }),
        ),
        env.DB.prepare(
          `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          createdAt,
          auth.session.email,
          "admin_order_created",
          orderId,
          seasonId,
          JSON.stringify({ qty: resolved.resolved.length }),
        ),
      ]);

      // No Telegram, no LIFF push — admin-built orders are silent on those channels.
      return json({ ok: true, order_id: orderId, total, expected_memo: expectedMemo });
    } catch (err) {
      if (isUniqueOnIdempotency(err)) {
        // Race-of-race: another request committed the same idempotency_key between our
        // precheck and INSERT. Restore our reservation, replay theirs.
        await restoreGroupStock(env, resolved.group_decrements);
        const existing = await db
          .select()
          .from(orders)
          .where(eq(orders.idempotency_key, body.idempotency_key))
          .limit(1);
        if (!existing[0]) return json({ ok: false, error_code: "INTERNAL" }, 500);
        return json({
          ok: true,
          order_id: existing[0].order_id,
          total: existing[0].total,
          replayed: true,
        });
      }
      if (isUniqueOnOrderId(err)) {
        // Two concurrent admin requests computed the same nextOrderId. KEEP the
        // reservation — same items[] reused on next retry.
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      // Unknown — restore + bail
      await restoreGroupStock(env, resolved.group_decrements);
      return json({ ok: false, error_code: "INTERNAL" }, 500);
    }
  }

  // Retry exhausted — restore before returning
  await restoreGroupStock(env, resolved.group_decrements);
  return json({ ok: false, error_code: "LOCKED" }, 503);
};
