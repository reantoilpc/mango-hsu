import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../db/client";
import { orders, order_items, products, audit_log } from "../../db/schema";
import { nextOrderId } from "../../lib/order-id";
import { checkOrderRate } from "../../lib/rate-limit";
import {
  assembleOrderSuccess,
  expectedMemoFor,
  shippingFor,
  type OrderResponse,
} from "../../lib/order-response";
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

function validate(body: OrderRequest): OrderResponse | null {
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 50) {
    return { ok: false, error_code: "INVALID_INPUT", message: "姓名格式錯誤" };
  }
  if (!/^09\d{8}$/.test(body.phone || "")) {
    return { ok: false, error_code: "INVALID_INPUT", message: "手機格式錯誤" };
  }
  if (
    typeof body.address !== "string" ||
    body.address.trim().length < 5 ||
    body.address.length > 200
  ) {
    return { ok: false, error_code: "INVALID_INPUT", message: "地址格式錯誤" };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, error_code: "INVALID_INPUT", message: "請至少選購一項" };
  }
  for (const it of body.items) {
    if (
      !it ||
      typeof it.sku !== "string" ||
      !Number.isInteger(it.qty) ||
      it.qty < 1 ||
      it.qty > 99
    ) {
      return { ok: false, error_code: "INVALID_INPUT", message: "品項格式錯誤" };
    }
  }
  if (body.pdpa_accepted !== true) {
    return { ok: false, error_code: "INVALID_INPUT", message: "未同意個資告知" };
  }
  return null;
}

function isUniqueOnIdempotency(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE/i.test(msg) && /idempotency_key/i.test(msg);
}

function isUniqueOnOrderId(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE/i.test(msg) && (/order_id/i.test(msg) || /PRIMARY/i.test(msg));
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const ctx = locals.cfContext;

  const ip = request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  if (!(await checkOrderRate(env, ip))) {
    return new Response(JSON.stringify({ ok: false, error_code: "LOCKED" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

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
  if (!body.idempotency_key || typeof body.idempotency_key !== "string") {
    return json({ ok: false, error_code: "INVALID_INPUT" });
  }

  const invalid = validate(body);
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

  // 2) Season check
  if (env.ACCEPTING_DRY !== "true") {
    return json({ ok: false, error_code: "SEASON_CLOSED" });
  }

  // 3) Product + availability + price snapshot
  const prodRows = await db.select().from(products);
  const prodMap = new Map(prodRows.map((p) => [p.sku, p]));
  let subtotal = 0;
  const itemsWithPrice: Array<{ sku: string; qty: number; unit_price: number }> = [];
  for (const it of body.items) {
    const p = prodMap.get(it.sku);
    if (!p) return json({ ok: false, error_code: "INVALID_INPUT" });
    if (!p.available) {
      return json({ ok: false, error_code: "SOLD_OUT", sold_out_sku: it.sku });
    }
    subtotal += p.price * it.qty;
    itemsWithPrice.push({ sku: it.sku, qty: it.qty, unit_price: p.price });
  }
  const shipping = shippingFor(body.items, env);
  const total = subtotal + shipping;

  // 4) Insert with race-aware order_id retry (max 3 attempts).
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderId = await nextOrderId(db);
    const expectedMemo = expectedMemoFor(orderId, body.name);
    const createdAt = new Date().toISOString();

    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO orders (order_id, created_at, name, phone, address, notes, subtotal, shipping, total, expected_memo, pdpa_accepted, paid, shipped, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        ).bind(
          orderId,
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
        ...itemsWithPrice.map((i) =>
          env.DB.prepare(
            `INSERT INTO order_items (order_id, sku, qty, unit_price) VALUES (?, ?, ?, ?)`,
          ).bind(orderId, i.sku, i.qty, i.unit_price),
        ),
        env.DB.prepare(
          `INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          new Date().toISOString(),
          "<system>",
          "order_created",
          orderId,
          JSON.stringify({ ip, qty: itemsWithPrice.length }),
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

      // Telegram fire-and-forget
      const itemsForTelegram = fullItems.map((i) => ({
        ...i,
        product: prodMap.get(i.sku),
      }));
      ctx?.waitUntil(notifyOrder(env, db, fullOrder, itemsForTelegram));

      return json(await assembleOrderSuccess(fullOrder, fullItems, env));
    } catch (err) {
      if (isUniqueOnIdempotency(err)) {
        // Race-of-race: another request just inserted the same idempotency key.
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
        // Two concurrent requests computed the same nextOrderId. Retry.
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      // Unknown error
      try {
        await db.insert(audit_log).values({
          ts: new Date().toISOString(),
          user_email: "<system>",
          action: "order_internal_error",
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

  // exhausted retries
  return json({ ok: false, error_code: "LOCKED" });
};
