import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../db/client";
import { orders } from "../../../../db/schema";

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
  error_code: "NOT_FOUND" | "INVALID_INPUT" | "INTERNAL";
}

type OrderStatusResponse = OrderStatusSuccess | OrderStatusError;

const json = (b: OrderStatusResponse, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const GET: APIRoute = async ({ params, locals }) => {
  const env = locals.runtime?.env;
  if (!env) return json({ ok: false, error_code: "INTERNAL" }, 500);

  const id = params.id;
  if (!id || typeof id !== "string" || !/^M-\d{8}-\d{3}$/.test(id)) {
    return json({ ok: false, error_code: "INVALID_INPUT" });
  }

  const db = makeDb(env);
  const rows = await db
    .select({
      order_id: orders.order_id,
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
