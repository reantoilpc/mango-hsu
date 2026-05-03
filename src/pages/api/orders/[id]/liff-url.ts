import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../db/client";
import { orders } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { buildLiffBindUrl } from "../../../../lib/line";
import { checkLiffBindRate } from "../../../../lib/rate-limit";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET: APIRoute = async ({ params, request, url, clientAddress }) => {
  const ip = request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  if (!(await checkLiffBindRate(env, ip))) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) {
    return json({ ok: false, error: "invalid_order_id" }, 400);
  }
  const phoneLast4 = url.searchParams.get("p");
  if (!phoneLast4 || !/^\d{4}$/.test(phoneLast4)) {
    return json({ ok: false, error: "missing_phone" }, 400);
  }

  const db = makeDb(env);
  const rows = await db
    .select({ order_id: orders.order_id, phone: orders.phone })
    .from(orders)
    .where(eq(orders.order_id, id))
    .limit(1);
  const order = rows[0];
  if (!order) return json({ ok: false, error: "not_found" }, 404);

  if (order.phone.slice(-4) !== phoneLast4) {
    return json({ ok: false, error: "phone_mismatch" }, 403);
  }

  const parts = await buildLiffBindUrl(order.order_id, env);
  return json({ ok: true, liff_bind_url: parts.url, exp: parts.exp });
};
