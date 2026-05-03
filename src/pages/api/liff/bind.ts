import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../db/client";
import { orders, audit_log } from "../../../db/schema";
import { env } from "../../../lib/env";
import { verifyLiffBindSig } from "../../../lib/line";
import { checkLiffBindRate } from "../../../lib/rate-limit";

interface BindRequest {
  order_id: string;
  p: string;
  exp: number;
  sig: string;
  line_user_id: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  if (!(await checkLiffBindRate(env, ip))) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }

  let body: BindRequest;
  try {
    body = (await request.json()) as BindRequest;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (typeof body.order_id !== "string" || !/^M-\d{8}-\d{3}$/.test(body.order_id)) {
    return json({ ok: false, error: "invalid_order_id" }, 400);
  }
  if (typeof body.p !== "string" || !/^\d{4}$/.test(body.p)) {
    return json({ ok: false, error: "invalid_p" }, 400);
  }
  if (typeof body.line_user_id !== "string" || body.line_user_id.length === 0 || body.line_user_id.length > 100) {
    return json({ ok: false, error: "invalid_line_user_id" }, 400);
  }
  const exp = Number(body.exp);
  if (!Number.isFinite(exp)) return json({ ok: false, error: "invalid_exp" }, 400);
  if (typeof body.sig !== "string" || body.sig.length === 0 || body.sig.length > 200) {
    return json({ ok: false, error: "invalid_sig" }, 400);
  }

  const verify = await verifyLiffBindSig(body.order_id, body.p, exp, body.sig, env);
  if (!verify.ok) return json({ ok: false, error: verify.reason }, 400);

  const db = makeDb(env);
  const found = await db
    .select()
    .from(orders)
    .where(eq(orders.order_id, body.order_id))
    .limit(1);
  const order = found[0];
  if (!order) return json({ ok: false, error: "order_not_found" }, 404);

  const now = new Date().toISOString();

  if (order.line_user_id === null) {
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET line_user_id = ? WHERE order_id = ?").bind(
        body.line_user_id,
        body.order_id,
      ),
      env.DB.prepare(
        "INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, 'line_bind_success', ?, ?)",
      ).bind(now, "<system>", body.order_id, JSON.stringify({ ip })),
    ]);
    return json({ ok: true, status: "bound" });
  }

  if (order.line_user_id === body.line_user_id) {
    return json({ ok: true, status: "already_bound" });
  }

  await db.insert(audit_log).values({
    ts: now,
    user_email: "<system>",
    action: "line_bind_replaced_attempt",
    order_id: body.order_id,
    details: JSON.stringify({
      ip,
      old: order.line_user_id,
      new: body.line_user_id,
    }),
  });
  return json(
    { ok: false, error: "already_bound_to_different_user" },
    409,
  );
};
