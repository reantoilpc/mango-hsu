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

  let body: {
    tracking_no?: string;
    expected_state?: { paid: boolean; shipped: boolean; cancelled_at: string | null };
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* empty body OK */
  }
  const trackingNo = (body.tracking_no ?? "").trim();
  if (trackingNo.length > 100) return text("tracking too long", 400);

  // Optional expected_state gate.
  if (body.expected_state) {
    const dbCheck = makeDb(env);
    const cur = await dbCheck
      .select()
      .from(orders)
      .where(eq(orders.order_id, id))
      .limit(1);
    const o = cur[0];
    if (!o) return text("not_found", 404);
    if (
      o.paid !== body.expected_state.paid ||
      o.shipped !== body.expected_state.shipped ||
      o.cancelled_at !== body.expected_state.cancelled_at
    ) {
      return json(
        {
          ok: false,
          error_code: "STALE_STATE",
          current_state: {
            paid: o.paid,
            shipped: o.shipped,
            cancelled_at: o.cancelled_at,
          },
        },
        409,
      );
    }
  }

  // V4: cancelled_at IS NULL guards against marking a cancelled order shipped
  // (whose stock has been restored).
  const now = new Date().toISOString();

  // Gate-first: run the guarded UPDATE as a STANDALONE statement and inspect
  // meta.changes BEFORE writing audit. A 0-row UPDATE inside a D1 batch is a
  // SUCCESSFUL statement (no rollback), so batching the audit INSERT alongside
  // the gate would commit a phantom mark_shipped row on a 409. Only the winner
  // (changes === 1) writes audit.
  const gate = await env.DB.prepare(
    "UPDATE orders SET shipped = 1, shipped_at = ?, shipped_by = ?, tracking_no = ? WHERE order_id = ? AND paid = 1 AND shipped = 0 AND cancelled_at IS NULL",
  )
    .bind(now, auth.session.email, trackingNo || null, id)
    .run();

  if ((gate.meta?.changes ?? 0) === 0) {
    return text("not_changed (unpaid? already shipped? cancelled?)", 409);
  }

  await env.DB.prepare(
    "INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, 'mark_shipped', ?, ?)",
  )
    .bind(
      now,
      auth.session.email,
      id,
      JSON.stringify({ tracking_no: trackingNo || null }),
    )
    .run();

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
