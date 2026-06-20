import type { APIRoute } from "astro";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_items, order_groups, products, seasons } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { parseShippingConfig } from "../../../../../lib/shipping";
import { computeGroupShipping } from "../../../../../lib/order-groups";
import { env } from "../../../../../lib/env";

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);
  if (auth.session.role !== "admin") return text("admin only", 403);
  const groupId = Number(params.id);
  if (!Number.isInteger(groupId)) return text("bad id", 400);

  const db = makeDb(env);
  const g = (await db.select().from(order_groups).where(eq(order_groups.id, groupId)).limit(1))[0];
  if (!g) return text("not found", 404);
  if (g.status !== "open") return json({ ok: false, error_code: "BAD_STATE", status: g.status }, 409);

  // Combined weight of all non-cancelled group orders.
  const groupOrders = await db
    .select({ order_id: orders.order_id, group_role: orders.group_role })
    .from(orders)
    .where(and(eq(orders.order_group_id, groupId), isNull(orders.cancelled_at)));
  const orderIds = groupOrders.map((o) => o.order_id);
  const items = orderIds.length
    ? await db
        .select({ order_id: order_items.order_id, qty: order_items.qty, package_fen: products.package_fen })
        .from(order_items)
        .innerJoin(products, eq(order_items.product_id, products.id))
        .where(inArray(order_items.order_id, orderIds))
    : [];
  const weights = groupOrders.map((o) => ({
    items: items.filter((it) => it.order_id === o.order_id).map((it) => ({ package_fen: it.package_fen, qty: it.qty })),
  }));

  const seasonCfg = (await db.select({ shipping_config: seasons.shipping_config }).from(seasons).where(eq(seasons.id, g.season_id)).limit(1))[0];
  const config = parseShippingConfig(seasonCfg?.shipping_config ?? null);
  const groupShipping = computeGroupShipping(weights, config);

  const host = groupOrders.find((o) => o.group_role === "host");
  const now = new Date().toISOString();
  await env.DB.batch([
    ...(host
      ? [env.DB.prepare(`UPDATE orders SET shipping = ?, total = subtotal + ? WHERE order_id = ?`).bind(groupShipping, groupShipping, host.order_id)]
      : []),
    env.DB.prepare(`UPDATE order_groups SET status = 'closed' WHERE id = ? AND status = 'open'`).bind(groupId),
    env.DB.prepare(`INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'group_closed', ?, ?)`)
      .bind(now, auth.session.email, g.season_id, JSON.stringify({ group_id: groupId, group_shipping: groupShipping })),
  ]);
  return json({ ok: true, group_shipping: groupShipping });
};
