import type { APIRoute } from "astro";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { env } from "../../../../lib/env";

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

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET shipped = 1, shipped_at = ?, shipped_by = ? WHERE paid = 1 AND shipped = 0 AND order_id IN (${placeholders})`,
    ).bind(now, auth.session.email, ...ids),
    env.DB.prepare(
      `INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, 'bulk_mark_shipped', ?)`,
    ).bind(now, auth.session.email, JSON.stringify({ count: ids.length, ids })),
  ]);

  return json({ ok: true, processed: ids.length });
};
