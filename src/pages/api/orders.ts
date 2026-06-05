import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../db/client";
import { orders, order_items, audit_log, seasons } from "../../db/schema";
import { nextOrderId } from "../../lib/order-id";
import { checkOrderRate } from "../../lib/rate-limit";
import {
  assembleOrderSuccess,
  expectedMemoFor,
  shippingFor,
  type OrderResponse,
} from "../../lib/order-response";
import { parseShippingConfig } from "../../lib/shipping";
import { validateCustomerOrder } from "../../lib/order-validate";
import { isUniqueOnIdempotency, isUniqueOnOrderId } from "../../lib/order-errors";
import {
  resolveItemsForStock,
  tryDecrementGroupStock,
  restoreGroupStock,
  getGroupStockFen,
  stockAuditStmts,
} from "../../lib/stock";
import { notifyOrder } from "../../lib/telegram";
import { env } from "../../lib/env";

interface OrderRequest {
  idempotency_key: string;
  token: string;
  honeypot: string;
  name: string;
  phone: string;
  address: string;
  items: Array<{ sku: string; qty: number }>;
  notes: string;
  pdpa_accepted: boolean;
}

const json = (body: OrderResponse, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const ctx = locals.cfContext;

  let body: OrderRequest;
  try {
    body = (await request.json()) as OrderRequest;
  } catch {
    return json({ ok: false, error_code: "INVALID_INPUT" });
  }

  if (body.honeypot && body.honeypot !== "") {
    return json({ ok: false, error_code: "INVALID_INPUT" });
  }
  if (!env.ORDER_TOKEN || body.token !== env.ORDER_TOKEN) {
    return json({ ok: false, error_code: "INVALID_TOKEN" });
  }

  // Stage-only rate-limit bypass for integration tests. Three gates:
  // (1) ALLOW_TEST_BYPASS=1 — only set on stage in scripts/deploy.mjs, so prod
  //     never reaches this branch
  // (2) valid ORDER_TOKEN — already checked above
  // (3) X-Test-Mode: 1 header
  // Tests share one client IP and KV cache TTL prevents instant rate-limit resets.
  const ip = request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  const isTestBypass =
    env.ALLOW_TEST_BYPASS === "1" && request.headers.get("x-test-mode") === "1";
  if (!isTestBypass) {
    if (!(await checkOrderRate(env, ip))) {
      return new Response(JSON.stringify({ ok: false, error_code: "LOCKED" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  if (!body.idempotency_key || typeof body.idempotency_key !== "string") {
    return json({ ok: false, error_code: "INVALID_INPUT" });
  }

  const invalid = validateCustomerOrder(body);
  if (invalid) return json(invalid);

  const db = makeDb(env);

  // 1) Idempotency: replay if key already exists.
  const prior = await db
    .select()
    .from(orders)
    .where(eq(orders.idempotency_key, body.idempotency_key))
    .limit(1);
  if (prior.length > 0) {
    const items = await db
      .select()
      .from(order_items)
      .where(eq(order_items.order_id, prior[0]!.order_id));
    return json(await assembleOrderSuccess(prior[0]!, items, env));
  }

  // 2) Season check (legacy ACCEPTING_DRY env var — kept as global emergency switch).
  // Per-season status='active' is the V5.2 canonical gate, but ACCEPTING_DRY can still
  // shut everything off without a DB write.
  if (env.ACCEPTING_DRY !== "true") {
    return json({ ok: false, error_code: "SEASON_CLOSED" });
  }

  // 3) Resolve items against active-season products.
  // Returns sku→product info + pre-aggregated group fen demand. unknown_product if any
  // sku isn't in the active season (or available=false → SOLD_OUT for that sku).
  const resolved = await resolveItemsForStock(env, body.items);
  if (!resolved.ok) {
    if (resolved.error_code === "unknown_product") {
      return json({ ok: false, error_code: "unknown_product", sku: resolved.sku });
    }
    // SOLD_OUT (available=false) — sku-level signal, no group_id since the product
    // is hidden, not just out-of-stock.
    return json({ ok: false, error_code: "SOLD_OUT", sku: resolved.sku });
  }

  // 4) Look up active season (id + shipping_config) ONCE — used for both the
  //    season_id stamp on the order and the V6 shipping computation.
  const seasonRow = await db
    .select({ id: seasons.id, shipping_config: seasons.shipping_config })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const seasonId = seasonRow[0]?.id ?? null;
  const shippingConfig = parseShippingConfig(seasonRow[0]?.shipping_config ?? null);

  // 5) Compute totals from resolved snapshot (price taken at this moment).
  //    Shipping uses resolved items' package_fen (Σ package_fen×qty) + the season config.
  let subtotal = 0;
  for (const r of resolved.resolved) {
    subtotal += r.price * r.qty;
  }
  const shipping = shippingFor(resolved.resolved, shippingConfig);
  const total = subtotal + shipping;

  // 5) Read group stock_fen BEFORE the CAS so we can write before/after into audit_log.
  // (Atomicity: the audit row goes into the same batch as the order INSERT below; the
  // CAS itself is a separate batch but compensates on failure.)
  const groupIds = resolved.group_decrements.map((d) => d.group_id);
  const beforeFenMap = await getGroupStockFen(env, groupIds);

  // 6) Atomic group-pool reserve. Done BEFORE the order_id retry loop — exactly once
  // regardless of order_id collisions. On idempotency_key race we restore; on order_id
  // collision we KEEP the reservation across retries (same items[] reused).
  const reserve = await tryDecrementGroupStock(env, resolved.group_decrements);
  if (!reserve.ok) {
    return json({
      ok: false,
      error_code: "SOLD_OUT",
      sold_out_group_id: reserve.sold_out_group_id,
    });
  }

  // 8) Insert with race-aware order_id retry (max 3 attempts).
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderId = await nextOrderId(db);
    const expectedMemo = expectedMemoFor(orderId, body.name);
    const createdAt = new Date().toISOString();

    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO orders (order_id, season_id, created_at, name, phone, address, notes, subtotal, shipping, total, expected_memo, pdpa_accepted, paid, shipped, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
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
          body.pdpa_accepted ? 1 : 0,
          body.idempotency_key,
        ),
        ...resolved.resolved.map((r) =>
          env.DB.prepare(
            `INSERT INTO order_items (order_id, product_id, sku, qty, unit_price) VALUES (?, ?, ?, ?, ?)`,
          ).bind(orderId, r.product_id, r.sku, r.qty, r.price),
        ),
        // Per-group audit row for the decrement (reconcile-stock.ts walks these)
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
              season_id: seasonId ?? undefined,
              ts: createdAt,
            };
          }),
        ),
        env.DB.prepare(
          `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          createdAt,
          "<system>",
          "order_created",
          orderId,
          seasonId,
          JSON.stringify({ ip, qty: resolved.resolved.length }),
        ),
      ]);

      // Build response from inserted state
      const fullOrder = (
        await db.select().from(orders).where(eq(orders.order_id, orderId)).limit(1)
      )[0]!;
      const fullItems = await db
        .select()
        .from(order_items)
        .where(eq(order_items.order_id, orderId));

      // Telegram fire-and-forget — pass resolved snapshot directly (has name/variant)
      ctx?.waitUntil(
        notifyOrder(
          env,
          db,
          fullOrder,
          resolved.resolved.map((r) => ({
            sku: r.sku,
            name: r.name,
            variant: r.variant,
            qty: r.qty,
          })),
        ),
      );

      return json(await assembleOrderSuccess(fullOrder, fullItems, env));
    } catch (err) {
      if (isUniqueOnIdempotency(err)) {
        // Race-of-race: another request just inserted with the same idempotency key.
        // Their reservation already covered the stock; ours must be returned BEFORE
        // the replay select.
        await restoreGroupStock(env, resolved.group_decrements);
        const existing = await db
          .select()
          .from(orders)
          .where(eq(orders.idempotency_key, body.idempotency_key))
          .limit(1);
        if (!existing[0]) return json({ ok: false, error_code: "INTERNAL" });
        const items = await db
          .select()
          .from(order_items)
          .where(eq(order_items.order_id, existing[0].order_id));
        return json(await assembleOrderSuccess(existing[0], items, env));
      }
      if (isUniqueOnOrderId(err)) {
        // Two concurrent requests computed the same nextOrderId. Retry —
        // do NOT restore stock; we hold the reservation across the retry
        // because the next insert reuses the same items[].
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      // Unknown error — restore reservation, then bail.
      await restoreGroupStock(env, resolved.group_decrements);
      try {
        await db.insert(audit_log).values({
          ts: new Date().toISOString(),
          user_email: "<system>",
          action: "order_internal_error",
          season_id: seasonId,
          details: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
            ip,
          }),
        });
      } catch {
        // best-effort
      }
      return json({ ok: false, error_code: "INTERNAL" });
    }
  }

  // Exhausted retries — restore reservation before returning.
  await restoreGroupStock(env, resolved.group_decrements);
  return json({ ok: false, error_code: "LOCKED" });
};
