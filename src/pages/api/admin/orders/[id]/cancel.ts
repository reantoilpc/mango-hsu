import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_items } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { stockRestoreStmts } from "../../../../../lib/stock";
import { env } from "../../../../../lib/env";

// V4: soft-delete cancel (cancelled_at = now) + restore stock to products.
//
// Replaces V2's hard-delete. Reasons for the change:
//   1. Hard-delete killed audit_log via FK cascade — no record of who/why.
//   2. With V4 stock model, restoring stock to a product means we need to know
//      what was on the order — that's the order_items rows we're about to nuke.
//   3. Soft-delete leaves history queryable: "show me cancelled orders" tab.
//
// Cancel is only allowed for orders that are NOT yet paid AND NOT yet shipped:
//   - Already paid? Refund flow needed (out of V4 scope, V4.1+).
//   - Already shipped? The packs left the warehouse; restoring stock would be
//     false inventory.
//   - Already cancelled? Idempotent — return ok with already_cancelled flag.
//
// Race-safe two-step: a single batch with restore + UPDATE cancelled_at would
// double-restore stock if two admins click cancel concurrently. Instead:
//   Step 1: atomic UPDATE cancelled_at WHERE the gate predicates hold.
//           Only one of N concurrent attempts has changes=1.
//   Step 2: ONLY the winner runs stockRestoreStmts + audit_log INSERT.
//
// If Step 2 fails (D1 transient error / Worker isolate crash), the order will
// have cancelled_at set but stock not restored — an accepted Known Hole.
// Mitigation: admin/products dashboard surfaces stock numbers; manual stock
// adjust UI (Step 10) lets the user reconcile. No saga / compensation cron.
export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  const now = new Date().toISOString();

  // Step 1: atomic gate — only the first concurrent request gets changes=1.
  const gate = await env.DB.prepare(
    `UPDATE orders
       SET cancelled_at = ?
     WHERE order_id = ?
       AND cancelled_at IS NULL
       AND paid = 0
       AND shipped = 0`,
  )
    .bind(now, id)
    .run();

  if ((gate.meta?.changes ?? 0) === 0) {
    // Disambiguate why the gate rejected — admin needs the right error message.
    const db = makeDb(env);
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.order_id, id))
      .limit(1);
    const o = rows[0];
    if (!o) return text("not_found", 404);
    if (o.cancelled_at !== null) {
      // Idempotent return — second concurrent click finds it already cancelled.
      return json({ ok: true, already_cancelled: true });
    }
    if (o.paid) {
      return json(
        { ok: false, error_code: "CANCEL_FORBIDDEN", reason: "paid_order_needs_refund" },
        409,
      );
    }
    if (o.shipped) {
      return json(
        { ok: false, error_code: "CANCEL_FORBIDDEN", reason: "already_shipped" },
        409,
      );
    }
    return json({ ok: false, error_code: "CANCEL_FORBIDDEN" }, 409);
  }

  // Step 2: winner only — restore stock + audit. Read items AFTER the gate
  // commits so we know exactly what to restore (V4 schema kept order_items
  // intact on cancel because we soft-delete, not hard-delete).
  const db = makeDb(env);
  const items = await db
    .select()
    .from(order_items)
    .where(eq(order_items.order_id, id));

  await env.DB.batch([
    ...stockRestoreStmts(env, items),
    env.DB.prepare(
      `INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      now,
      auth.session.email,
      "order_cancelled",
      id,
      JSON.stringify({ items: items.map((i) => ({ sku: i.sku, qty: i.qty })) }),
    ),
  ]);

  return json({ ok: true });
};
