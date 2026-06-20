import type { APIRoute } from "astro";
import { and, eq, isNull } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_groups } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { env } from "../../../../../lib/env";

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);
  if (auth.session.role !== "admin") return text("admin only", 403);
  const groupId = Number(params.id);
  if (!Number.isInteger(groupId)) return text("bad id", 400);
  let body: { tracking_no?: string };
  try { body = (await request.json()) as { tracking_no?: string }; } catch { return text("bad json", 400); }
  const tracking = (body.tracking_no ?? "").trim();
  if (!tracking) return json({ ok: false, error_code: "NO_TRACKING" }, 400);

  const db = makeDb(env);
  const g = (await db.select().from(order_groups).where(eq(order_groups.id, groupId)).limit(1))[0];
  if (!g) return text("not found", 404);
  if (g.status !== "closed") return json({ ok: false, error_code: "BAD_STATE", status: g.status }, 409);

  const grp = await db.select({ order_id: orders.order_id }).from(orders)
    .where(and(eq(orders.order_group_id, groupId), isNull(orders.cancelled_at)));
  const ids = grp.map((o) => o.order_id);
  const now = new Date().toISOString();
  await env.DB.batch([
    // Reuse the bulk-ship invariant: only paid & not-yet-shipped & not-cancelled rows flip.
    env.DB.prepare(
      `UPDATE orders SET shipped = 1, shipped_at = ?, shipped_by = ?, tracking_no = ? WHERE shipped = 0 AND paid = 1 AND cancelled_at IS NULL AND order_group_id = ?`,
    ).bind(now, auth.session.email, tracking, groupId),
    env.DB.prepare(`UPDATE order_groups SET status = 'shipped', tracking_no = ?, shipped_at = ?, shipped_by = ? WHERE id = ? AND status = 'closed'`)
      .bind(tracking, now, auth.session.email, groupId),
    env.DB.prepare(`INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'group_shipped', ?, ?)`)
      .bind(now, auth.session.email, g.season_id, JSON.stringify({ group_id: groupId, tracking_no: tracking, order_ids: ids })),
  ]);
  return json({ ok: true, shipped: ids.length });
};
