import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import {
  resolveOrderItemsForRestore,
  groupRestoreStmts,
  stockAuditStmts,
  getGroupStockFen,
} from "../../../../../lib/stock";
import { env } from "../../../../../lib/env";

// V5.2: soft-delete cancel (cancelled_at = now) + restore stock to product_groups pool.
//
// Inherits V4 architecture:
// - Cancel is only allowed when NOT yet paid AND NOT yet shipped:
//     - Already paid? Refund flow needed (out of scope, V4.1+).
//     - Already shipped? The packs left the warehouse; restoring stock would be false inventory.
//     - Already cancelled? Idempotent — return ok with already_cancelled flag.
// - Race-safe two-step:
//     Step 1: atomic UPDATE cancelled_at WHERE the gate predicates hold.
//             Only one of N concurrent attempts has changes=1.
//     Step 2: ONLY the winner runs group stock restore + audit_log INSERT.
//
// V5.2 additions:
// - Step 2 uses resolveOrderItemsForRestore to aggregate fen by group_id (not per-sku)
// - Audit row per group via stockAuditStmts with reason='order_restore' so reconcile-stock.ts
//   can SUM(deltas) per group correctly.
//
// Known Hole (V4 carried forward):
// - If Step 2 batch fails (D1 transient / Worker isolate crash), the order will have
//   cancelled_at set but stock not restored.
// - V5.2 mitigation: reconcile-stock.ts script catches the drift (audit row missing for
//   that order_id → SUM(deltas) ≠ current stock_fen). Admin runs reconcile after a deploy
//   or whenever they suspect; observed drift is fixed via adjustGroupStock with positive
//   delta + reason='correction'.
export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  let body: {
    expected_state?: { paid: boolean; shipped: boolean; cancelled_at: string | null };
  } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    /* empty body OK — legacy clients */
  }

  // Optional expected_state gate. cancel.ts's atomic UPDATE already enforces the right
  // preconditions, but expected_state lets us return a clearer STALE_STATE error before
  // doing any work, so the client knows to refresh.
  if (body.expected_state) {
    const db = makeDb(env);
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

  // Step 2: winner only — restore group fen + audit. Read items + their group package_fen
  // AFTER the gate commits so we know exactly what to restore (V4 schema kept order_items
  // intact on cancel because we soft-delete, not hard-delete).
  const db = makeDb(env);
  const orderRow = await db.select().from(orders).where(eq(orders.order_id, id)).limit(1);
  const seasonId = orderRow[0]?.season_id ?? null;

  const restoreUnits = await resolveOrderItemsForRestore(env, id);

  // Read current stock_fen BEFORE the restore so audit rows have accurate before/after.
  const groupIds = restoreUnits.map((r) => r.group_id);
  const beforeFenMap = await getGroupStockFen(env, groupIds);

  await env.DB.batch([
    ...groupRestoreStmts(env, restoreUnits),
    ...stockAuditStmts(
      env,
      restoreUnits.map((r) => {
        const before = beforeFenMap.get(r.group_id) ?? 0;
        return {
          group_id: r.group_id,
          delta_fen: r.fen,
          before_fen: before,
          after_fen: before + r.fen,
          reason: "order_restore" as const,
          source_id: id,
          user_email: auth.session.email,
          season_id: seasonId ?? undefined,
          ts: now,
        };
      }),
    ),
    env.DB.prepare(
      `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      now,
      auth.session.email,
      "order_cancelled",
      id,
      seasonId,
      JSON.stringify({ restored: restoreUnits }),
    ),
  ]);

  return json({ ok: true });
};
