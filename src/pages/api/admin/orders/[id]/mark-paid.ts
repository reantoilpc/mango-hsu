import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, audit_log } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";

export const POST: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env;
  if (!env) return text("no runtime", 500);

  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  const db = makeDb(env);
  const now = new Date().toISOString();

  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE orders SET paid = 1, paid_at = ?, paid_by = ? WHERE order_id = ? AND paid = 0",
    ).bind(now, auth.session.email, id),
    env.DB.prepare(
      "INSERT INTO audit_log (ts, user_email, action, order_id) VALUES (?, ?, 'mark_paid', ?)",
    ).bind(now, auth.session.email, id),
  ]);

  const changes = result[0]?.meta?.changes ?? 0;
  if (changes === 0) return text("not_changed (already paid?)", 409);
  return json({ ok: true });
};
