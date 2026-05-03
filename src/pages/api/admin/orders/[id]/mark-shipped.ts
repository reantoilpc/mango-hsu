import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { env } from "../../../../../lib/env";
import { pushShippedNotification } from "../../../../../lib/line";

export const POST: APIRoute = async ({ request, params, locals }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  let body: { tracking_no?: string } = {};
  try {
    body = (await request.json()) as { tracking_no?: string };
  } catch {
    /* empty body OK */
  }
  const trackingNo = (body.tracking_no ?? "").trim();
  if (trackingNo.length > 100) return text("tracking too long", 400);

  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE orders SET shipped = 1, shipped_at = ?, shipped_by = ?, tracking_no = ? WHERE order_id = ? AND paid = 1 AND shipped = 0",
    ).bind(now, auth.session.email, trackingNo || null, id),
    env.DB.prepare(
      "INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, 'mark_shipped', ?, ?)",
    ).bind(
      now,
      auth.session.email,
      id,
      JSON.stringify({ tracking_no: trackingNo || null }),
    ),
  ]);

  const changes = result[0]?.meta?.changes ?? 0;
  if (changes === 0) return text("not_changed (unpaid? already shipped?)", 409);

  // Fire-and-forget LINE push if customer bound a LINE user and we haven't pushed yet.
  const ctx = locals.cfContext;
  const db = makeDb(env);
  const fresh = await db.select().from(orders).where(eq(orders.order_id, id)).limit(1);
  const order = fresh[0];
  if (order && order.line_user_id && !order.line_push_sent_at) {
    const origin = new URL(request.url).origin;
    ctx?.waitUntil(pushShippedNotification(env, db, order, origin));
  }

  return json({ ok: true });
};
