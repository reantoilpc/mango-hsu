import type { APIRoute } from "astro";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";

export const POST: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env;
  if (!env) return text("no runtime", 500);

  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  let body: { tracking_no?: string };
  try {
    body = (await request.json()) as { tracking_no?: string };
  } catch {
    return text("bad json", 400);
  }
  const trackingNo = (body.tracking_no ?? "").trim();
  if (trackingNo.length > 100) return text("tracking too long", 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET tracking_no = ? WHERE order_id = ?").bind(
      trackingNo || null,
      id,
    ),
    env.DB.prepare(
      "INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, 'update_tracking', ?, ?)",
    ).bind(
      now,
      auth.session.email,
      id,
      JSON.stringify({ tracking_no: trackingNo || null }),
    ),
  ]);
  return json({ ok: true });
};
