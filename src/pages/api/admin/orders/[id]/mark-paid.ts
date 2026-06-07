import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, audit_log } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { env } from "../../../../../lib/env";

interface MarkPaidBody {
  expected_state?: {
    paid: boolean;
    shipped: boolean;
    cancelled_at: string | null;
  };
}

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  let body: MarkPaidBody = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    /* legacy clients send no body — proceed without expected_state check */
  }

  const db = makeDb(env);

  // Optional expected_state gate: early-reject with STALE_STATE if the client's
  // view of the order doesn't match DB. Existing SQL guards (cancelled_at IS
  // NULL, paid = 0) stay as defense in depth.
  if (body.expected_state) {
    const cur = await db.select().from(orders).where(eq(orders.order_id, id)).limit(1);
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

  const now = new Date().toISOString();

  // Gate-first: run the guarded UPDATE as a STANDALONE statement and inspect
  // meta.changes BEFORE writing audit. A 0-row UPDATE inside a D1 batch is a
  // SUCCESSFUL statement (no rollback), so batching the audit INSERT alongside
  // the gate would commit a phantom mark_paid row on a 409. Only the winner
  // (changes === 1) writes audit.
  const gate = await env.DB.prepare(
    "UPDATE orders SET paid = 1, paid_at = ?, paid_by = ? WHERE order_id = ? AND paid = 0 AND cancelled_at IS NULL",
  )
    .bind(now, auth.session.email, id)
    .run();

  if ((gate.meta?.changes ?? 0) === 0) {
    return text("not_changed (already paid? cancelled?)", 409);
  }

  await env.DB.prepare(
    "INSERT INTO audit_log (ts, user_email, action, order_id) VALUES (?, ?, 'mark_paid', ?)",
  )
    .bind(now, auth.session.email, id)
    .run();

  return json({ ok: true });
};
