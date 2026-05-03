import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../db/client";
import { orders } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { checkPublicStatusRate } from "../../../../lib/rate-limit";

interface OrderStatusSuccess {
  ok: true;
  order_id: string;
  paid: boolean;
  shipped: boolean;
  tracking_no: string | null;
  created_at: string;
}

interface OrderStatusError {
  ok: false;
  error_code: "NOT_FOUND" | "INVALID_INPUT" | "INTERNAL" | "LOCKED";
}

type OrderStatusResponse = OrderStatusSuccess | OrderStatusError;

const json = (b: OrderStatusResponse, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Public order lookup. cso 2026-05-03 finding #3: order IDs are sequential
// M-YYYYMMDD-NNN — without phone proof, anyone can enumerate tracking_no for
// every order on a given day. Now requires ?p=<phone-last-4> AND a per-IP
// rate limit so even with the right phone last-4 you can't sweep neighbors.
// On phone mismatch we return NOT_FOUND (not 403) to keep the order ID
// existence indistinguishable from a wrong phone.
export const GET: APIRoute = async ({ params, request, url, clientAddress }) => {
  const ip =
    request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  if (!(await checkPublicStatusRate(env, ip))) {
    return json({ ok: false, error_code: "LOCKED" }, 429);
  }

  const id = params.id;
  if (!id || typeof id !== "string" || !/^M-\d{8}-\d{3}$/.test(id)) {
    return json({ ok: false, error_code: "INVALID_INPUT" });
  }
  const phoneLast4 = url.searchParams.get("p") ?? "";
  if (!/^\d{4}$/.test(phoneLast4)) {
    return json({ ok: false, error_code: "INVALID_INPUT" });
  }

  const db = makeDb(env);
  const rows = await db
    .select({
      order_id: orders.order_id,
      phone: orders.phone,
      paid: orders.paid,
      shipped: orders.shipped,
      tracking_no: orders.tracking_no,
      created_at: orders.created_at,
    })
    .from(orders)
    .where(eq(orders.order_id, id))
    .limit(1);

  if (rows.length === 0) return json({ ok: false, error_code: "NOT_FOUND" });
  const o = rows[0]!;
  if (o.phone.slice(-4) !== phoneLast4) {
    return json({ ok: false, error_code: "NOT_FOUND" });
  }

  // Strict allowlist: NEVER include name/phone/address/notes/items.
  return json({
    ok: true,
    order_id: o.order_id,
    paid: o.paid,
    shipped: o.shipped,
    tracking_no: o.tracking_no,
    created_at: o.created_at,
  });
};
