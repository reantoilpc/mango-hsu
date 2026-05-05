import type { APIRoute } from "astro";
import { inArray } from "drizzle-orm";
import { makeDb } from "../../../../db/client";
import { orders } from "../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { env } from "../../../../lib/env";
import { pushShippedNotification } from "../../../../lib/line";

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: { ids?: string[] };
  try {
    body = (await request.json()) as { ids?: string[] };
  } catch {
    return text("bad json", 400);
  }
  const ids = (body.ids ?? []).filter((s) => /^M-\d{8}-\d{3}$/.test(s));
  if (ids.length === 0) return text("no ids", 400);
  if (ids.length > 100) return text("too many", 400);

  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(", ");

  // V4: cancelled_at IS NULL guards against bulk-shipping a cancelled
  // order (whose stock has been restored). Single statement keeps the
  // existing paid=1 AND shipped=0 invariant for partial-success behavior.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET shipped = 1, shipped_at = ?, shipped_by = ? WHERE paid = 1 AND shipped = 0 AND cancelled_at IS NULL AND order_id IN (${placeholders})`,
    ).bind(now, auth.session.email, ...ids),
    env.DB.prepare(
      `INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, 'bulk_mark_shipped', ?)`,
    ).bind(now, auth.session.email, JSON.stringify({ count: ids.length, ids })),
  ]);

  // Fire-and-forget LINE pushes for any in this batch with a bound LINE user.
  const ctx = locals.cfContext;
  const db = makeDb(env);
  const updated = await db
    .select()
    .from(orders)
    .where(inArray(orders.order_id, ids));
  const origin = new URL(request.url).origin;
  for (const order of updated) {
    if (order.shipped && order.line_user_id && !order.line_push_sent_at) {
      ctx?.waitUntil(pushShippedNotification(env, db, order, origin));
    }
  }

  return json({ ok: true, processed: ids.length });
};
