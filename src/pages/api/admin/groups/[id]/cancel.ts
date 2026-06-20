import type { APIRoute } from "astro";
import { and, eq, isNull } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_items, order_groups, products } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { restoreGroupStock, getGroupStockFen, stockAuditStmts } from "../../../../../lib/stock";
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
  if (g.status === "shipped" || g.status === "cancelled")
    return json({ ok: false, error_code: "BAD_STATE", status: g.status }, 409);

  // Only orders not yet shipped/cancelled are cancellable; restore their group stock.
  const live = await db
    .select({ order_id: orders.order_id, group_id: products.group_id, package_fen: products.package_fen, qty: order_items.qty })
    .from(orders)
    .innerJoin(order_items, eq(order_items.order_id, orders.order_id))
    .innerJoin(products, eq(order_items.product_id, products.id))
    .where(and(eq(orders.order_group_id, groupId), isNull(orders.cancelled_at), eq(orders.shipped, false)));
  // Aggregate fen to restore per product-group.
  const restoreMap = new Map<number, number>();
  for (const r of live) restoreMap.set(r.group_id, (restoreMap.get(r.group_id) ?? 0) + r.package_fen * r.qty);
  const increments = [...restoreMap.entries()].map(([group_id, fen]) => ({ group_id, fen }));
  const before = await getGroupStockFen(env, increments.map((i) => i.group_id));
  const now = new Date().toISOString();

  await restoreGroupStock(env, increments);
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET cancelled_at = ? WHERE order_group_id = ? AND cancelled_at IS NULL AND shipped = 0`).bind(now, groupId),
    env.DB.prepare(`UPDATE order_groups SET status = 'cancelled' WHERE id = ?`).bind(groupId),
    ...stockAuditStmts(env, increments.map((i) => {
      const b = before.get(i.group_id) ?? 0;
      return { group_id: i.group_id, delta_fen: i.fen, before_fen: b, after_fen: b + i.fen, reason: "order_restore" as const, source_id: `group-${groupId}`, season_id: g.season_id, ts: now };
    })),
    env.DB.prepare(`INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'group_cancelled', ?, ?)`)
      .bind(now, auth.session.email, g.season_id, JSON.stringify({ group_id: groupId })),
  ]);
  return json({ ok: true });
};
